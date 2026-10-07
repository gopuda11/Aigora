module.exports = require("./extensions").select("private-agent-scope", function () {
var module = { exports: {} };
"use strict";
var fs = require("fs");
var os = require("os");
var path = require("path");
var crypto = require("crypto");
var childProcess = require("child_process");
var net = require("net");
var netFlags = require("./sandbox-network-flags");
var egressLib = require("./sandbox-egress");
var sandboxLimits = require("./sandbox-limits");
var dgram = require("dgram");
var PROFILES = {
  claude: { credentials: [], binaryDirs: true },
  codex: { credentials: [], binaryDirs: true },

  // Write-capable endpoint workers: a sandboxed helper that never holds a provider credential (no login file, no key).
  endpoint: { credentials: [], binaryDirs: true, noCredential: true },
};
var SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/;
var EGRESS_SOCKET = "/aigora/egress.sock", FORWARDER_PORT = 3128, SANDBOX_HOSTNAME = "aigora";
// /run holds the docker, system-bus and other daemon sockets of the host; none of them may be reachable.
// /var (journal, lib, cache, mail), /opt, /media, /boot and /sys leak host activity, installed apps and hardware info.
var MASKED_DIRS = ["/home", "/mnt", "/srv", "/var", "/run", "/root", "/tmp", "/opt", "/media", "/boot", "/sys"];
var PROBED_EMPTY = ["/var", "/opt", "/media", "/boot", "/sys", "/usr/local", "/etc/ssl/private"];
// The sandbox root starts empty: only the runtime, shared libraries and the few /etc files needed for TLS and name
// resolution are bound read-only. Anything else on the host (e.g. /etc/shadow, /usr/local, /srv) does not exist inside.
var RUNTIME_DIRS = ["/usr"];
var RUNTIME_LINKS = ["/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"];
// Host-specific or secret subtrees inside the allowlisted trees are hidden behind empty tmpfs.
var ALLOWLIST_MASKS = ["/usr/local", "/etc/ssl/private", "/etc/pki/tls/private", "/etc/pki/CA/private"];
var ETC_ALLOWLIST = ["ssl", "ca-certificates", "pki", "resolv.conf", "hosts", "nsswitch.conf", "ld.so.cache", "ld.so.conf", "ld.so.conf.d", "localtime", "fonts", "libreoffice", "alternatives"];
// fonts: fontconfig; libreoffice: /usr/lib/libreoffice/program/{bootstraprc,sofficerc} are symlinks into /etc/libreoffice (dangling => soffice hangs);
// alternatives: /usr/bin symlink targets on Debian-style hosts. All contain no secrets.
// Representative host files that must be unreadable inside the sandbox (checked by the probe when present).
var PROBED_HIDDEN = ["/etc/shadow", "/etc/hostname", "/etc/fstab", "/etc/machine-id", "/etc/passwd", "/etc/sudoers"];
// Cheap resource guards: concurrent scopes (fail closed), state tree size, stale run dirs.
// Fixed in-sandbox path of the per-run skills plugin (read-only bind). Not under /opt, /var, /tmp or HOME: those are masked or probed empty.
var SKILLS_MOUNT = "/aigora/skills";
var live = new Set(), roomLive = new Set(), liveWorkspaces = new Set(), sweepAt = new Map();
var MAX_STATE_BYTES = 512 * 1024 * 1024, STALE_RUN_MS = 24 * 3600000;
// Network "landlock" (explicit opt-in): the host network namespace is shared; Landlock limits TCP connects and scopes abstract
// sockets/signals only. Network "proxy" (default) has no residual: own namespace, egress only through the host proxy policy.
var RESIDUAL_LANDLOCK = ["udp_not_restricted", "host_network_namespace_shared", "loopback_and_lan_tcp_443_53_reachable"];
// Fixed failure reasons: provider_not_supported, private_execution_disabled, invalid_scope_id,
// workspace_unavailable, credential_unavailable, bubblewrap_unavailable, probe_failed,
// network_isolation_unavailable, invalid_network_policy, resource_limit_reached, resource_limits_unavailable.
var LAUNCHER_SRC = `import ctypes, os, sys, resource as R
try:
 libc=ctypes.CDLL(None,use_errno=True)
 libc.syscall.restype=ctypes.c_long
 NR_CREATE,NR_ADD,NR_RESTRICT=444,445,446
 if sys.argv[1:]==["--abi"]:
  abi=libc.syscall(NR_CREATE,None,0,1)
  if abi<0:
   if ctypes.get_errno() in (1,38,95): print(0); sys.exit(0)
   os._exit(125)
  print(abi); sys.exit(0)
 NET_BIND,NET_CONNECT=1,2
 SCOPE_ABSTRACT,SCOPE_SIGNAL=1,2
 class Attr(ctypes.Structure):
  _fields_=[("handled_access_fs",ctypes.c_uint64),("handled_access_net",ctypes.c_uint64),("scoped",ctypes.c_uint64)]
 class Attr4(ctypes.Structure):
  _fields_=[("handled_access_fs",ctypes.c_uint64),("handled_access_net",ctypes.c_uint64)]
 class Rule(ctypes.Structure):
  _fields_=[("allowed_access",ctypes.c_uint64),("port",ctypes.c_uint64)]
 def restrict(ports,level):
  if level<4: return
  a=Attr(0,NET_BIND|NET_CONNECT,SCOPE_ABSTRACT|SCOPE_SIGNAL) if level>=6 else Attr4(0,NET_BIND|NET_CONNECT)
  fd=libc.syscall(NR_CREATE,ctypes.byref(a),ctypes.sizeof(a),0)
  if fd<0: os._exit(125)
  for p in ports:
   r=Rule(NET_CONNECT,p)
   if libc.syscall(NR_ADD,fd,2,ctypes.byref(r),0)!=0: os._exit(125)
  if libc.prctl(38,1,0,0,0)!=0: os._exit(125)
  if libc.syscall(NR_RESTRICT,fd,0)!=0: os._exit(125)
  os.close(fd)
 EGRESS="/aigora/egress.sock"
 def serve(ls,child):
  import socket,threading,select
  live=[0]; lock=threading.Lock()
  def pipe(a):
   b=None
   try:
    b=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); b.connect(EGRESS)
    open_=[a,b]
    while open_:
     r,_,_=select.select(open_,[],[],600)
     if not r: break
     for x in r:
      d=x.recv(65536)
      y=b if x is a else a
      if not d:
       open_.remove(x)
       try: y.shutdown(socket.SHUT_WR)
       except OSError: pass
      else: y.sendall(d)
   except Exception: pass
   finally:
    a.close()
    if b: b.close()
    with lock: live[0]-=1
  try:
   while True:
    c,_=ls.accept()
    #HOOK_ACCEPT
    with lock:
     full=live[0]>=128
     if not full: live[0]+=1
    if full: c.close(); continue
    try:
     #HOOK_THREAD
     threading.Thread(target=pipe,args=(c,),daemon=True).start()
    except Exception:
     c.close()
     with lock: live[0]-=1
  except BaseException:
   try: os.kill(child,9)
   except Exception: pass
   os._exit(125)
 spec=sys.argv[1]
 lv=None
 if "@" in spec: spec,lv=spec.split("@",1); lv=int(lv)
 fwd=spec.startswith("F")
 ports=[int(p) for p in (spec[1:] if fwd else spec).split(',') if p]
 if any(p<1 or p>65535 for p in ports) or len(sys.argv)<3 or (fwd and len(ports)!=1) or (lv is not None and (not fwd or lv not in (0,4,6))): os._exit(125)
 level=6 if lv is None else lv
 R.setrlimit(R.RLIMIT_FSIZE,(536870912,536870912))
 R.setrlimit(R.RLIMIT_CORE,(0,0))
 n=min(R.getrlimit(R.RLIMIT_NOFILE)[1],8192)
 R.setrlimit(R.RLIMIT_NOFILE,(n,n))
 if fwd:
  import socket,signal,threading
  ls=socket.socket(); ls.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
  ls.bind(("127.0.0.1",ports[0])); ls.listen(64)
  # The command is released by a startup pipe: it blocks until this process (PID 1 of the namespace) is fully hardened and the
  # forwarder runs. EOF without the byte (parent died or failed) means the command never runs.
  rfd,wfd=os.pipe()
  pid=os.fork()
  if pid==0:
   try:
    ls.close(); os.close(wfd)
    restrict(ports,level)
    if os.read(rfd,1)!=b"1": os._exit(125)
    os.close(rfd)
    os.execvp(sys.argv[2],sys.argv[2:])
   finally: os._exit(125)
  os.close(rfd)
  signal.signal(signal.SIGINT,signal.SIG_IGN)
  #HOOK_HARDEN
  if libc.prctl(4,0,0,0,0)!=0: os._exit(125)
  restrict([],level)
  threading.Thread(target=serve,args=(ls,pid),daemon=True).start()
  #HOOK_RELEASE
  if os.write(wfd,b"1")!=1: os._exit(125)
  os.close(wfd)
  while True:
   try: p,st=os.waitpid(-1,0)
   except ChildProcessError: os._exit(125)
   if p==pid: os._exit(os.WEXITSTATUS(st) if os.WIFEXITED(st) else 128+os.WTERMSIG(st))
 restrict(ports,level)
 os.execvp(sys.argv[2],sys.argv[2:])
except Exception:
 os._exit(125)
`;
// Test seam: `hooks` (HARDEN, RELEASE, ACCEPT, THREAD, EGRESS) splice Python statements at the marked points. LAUNCHER has none.
function buildLauncher(hooks) {
  hooks = hooks || {};
  return LAUNCHER_SRC.replace(/^( *)#HOOK_([A-Z]+)\n/gm, function (_, ind, name) {
    return hooks[name] ? String(hooks[name]).split("\n").map(function (l) { return ind + l + "\n"; }).join("") : "";
  }).replace('EGRESS="/aigora/egress.sock"', hooks.EGRESS ? "EGRESS=" + JSON.stringify(hooks.EGRESS) : 'EGRESS="/aigora/egress.sock"');
}
var LAUNCHER = buildLauncher();
// Host side shim for sensitive --setenv pairs (credential-broker spec F1). The pairs arrive in the shim's own environment (readable
// only by the same uid, and only for the milliseconds before exec), go into an anonymous memfd (never a pipe: a full pipe would block the write before bwrap runs) as NUL-separated bwrap arguments, and bwrap reads
// them with --args FD. They are never on any command line, and the bwrap process is exec'd with a clean environment.
var SECRET_SHIM = `import os,sys,json
try:
 d=json.loads(os.environ.pop("AIGORA_SECRET_ARGS"))
 buf=b"".join(b"--setenv\\0"+k.encode()+b"\\0"+v.encode()+b"\\0" for k,v in d)
 if not d or len(buf)>32768: os._exit(125)
 r=os.memfd_create("aigora-args",0); os.write(r,buf); os.lseek(r,0,0); os.set_inheritable(r,True)
 argv=[str(r) if x=="@SECRET_FD@" else x for x in sys.argv[1:]]
 os.execvpe(argv[0],argv,{"PATH":os.environ.get("PATH","/usr/bin:/bin")})
except Exception:
 os._exit(125)
`;
// Landlock mode (explicit opt-in) probe: shared host network namespace, TCP connect policy only.
var NETWORK_PROBE = `import socket,sys,errno
abstract,blocked,allowed=sys.argv[1:]
def denied(f):
 try: f()
 except OSError as e:
  if e.errno not in (errno.EACCES,errno.EPERM): raise
 else: raise RuntimeError()
with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as s:
 denied(lambda: s.connect("\\0"+abstract))
with socket.socket() as s:
 denied(lambda: s.connect(("127.0.0.1",int(blocked))))
with socket.create_connection(("127.0.0.1",int(allowed)),timeout=2) as s:
 if s.recv(1)!=b"!": raise RuntimeError()
with socket.socket() as s:
 denied(lambda: s.bind(("127.0.0.1",0)))
print("private-scope-network:denied,denied,connected,denied")
`;
// Proxy mode probe, run inside the real wrapper: own network namespace, only the forwarder port, policy answered by the host proxy.
var NETWORK_PROBE_PROXY = `import socket,sys,errno
abstract,tcp_port,udp_port,fwd,level=sys.argv[1:]
level=int(level)
GONE=(errno.EACCES,errno.EPERM,errno.ECONNREFUSED,errno.ENETUNREACH,errno.EHOSTUNREACH,errno.ENOENT,errno.ETIMEDOUT)
def gone(f):
 try: f()
 except OSError as e:
  if e.errno not in GONE: raise
 else: raise RuntimeError("reachable")
names=[l.split(":")[0].strip() for l in open("/proc/net/dev").read().splitlines()[2:]]
if names!=["lo"]: raise RuntimeError("interfaces")
listen=set()
for f in ("/proc/net/tcp","/proc/net/tcp6"):
 try:
  for l in open(f).read().splitlines()[1:]:
   c=l.split()
   if c[3]=="0A": listen.add(int(c[1].split(":")[1],16))
 except FileNotFoundError: pass
if listen!={int(fwd)}: raise RuntimeError("listeners")
with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as s:
 gone(lambda: s.connect("\\0"+abstract))
with socket.socket() as s:
 s.settimeout(2); gone(lambda: s.connect(("127.0.0.1",int(tcp_port))))
with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as s:
 try: s.sendto(b"x",("127.0.0.1",int(udp_port)))
 except OSError as e:
  if e.errno not in GONE: raise
if level>=4:
 for p in (0,int(fwd),int(tcp_port)):
  with socket.socket() as s:
   gone(lambda: s.bind(("127.0.0.1",p)))
import os,signal,ctypes
if os.getpid()==1: raise RuntimeError("init")
for sig in (signal.SIGUSR1,signal.SIGINT,signal.SIGTERM,signal.SIGSTOP,signal.SIGKILL):
 try: os.kill(1,sig)
 except OSError as e:
  if e.errno!=errno.EPERM: raise
libc=ctypes.CDLL(None,use_errno=True)
libc.ptrace.restype=ctypes.c_long
if libc.ptrace(16,1,None,None)==0: raise RuntimeError("ptrace")
for m in ("/proc/1/mem","/proc/1/environ"):
 try: open(m,"rb").read(1)
 except OSError: pass
 else: raise RuntimeError("peek")
if open("/proc/1/status").read().split("State:")[1].split()[0] not in ("S","R","D"): raise RuntimeError("stopped")
def ask(target):
 with socket.create_connection(("127.0.0.1",int(fwd)),timeout=5) as s:
  s.sendall(("CONNECT %s HTTP/1.1\\r\\nHost: %s\\r\\n\\r\\n"%(target,target)).encode())
  buf=b""
  while b"\\r\\n\\r\\n" not in buf:
   d=s.recv(4096)
   if not d: break
   buf+=d
  head=buf.split(b"\\r\\n")[0].decode()
  if head.startswith("HTTP/1.1 200"):
   rest=buf.split(b"\\r\\n\\r\\n",1)[1]
   while not rest:
    rest=s.recv(1)
   return head[9:12]+rest[:1].decode()
  return head[9:12]
if ask("probe.aigora.invalid:443")!="200!": raise RuntimeError("proxy")
if ask("127.0.0.1:443")!="403" or ask("192.168.0.1:443")!="403": raise RuntimeError("policy")
print("private-scope-network:proxy-ok")
`;
function ports(extra) {
  if (extra === undefined) extra = [];
  if (!Array.isArray(extra) || extra.length > 10 ||
    Array.from(extra).some(function (p) { return !Number.isInteger(p) || p < 1 || p > 65535; })) throw new Error("invalid_network_policy");
  return Array.from(new Set([443, 53].concat(extra)));
}
var passes = new Map();
var prepared = new WeakSet();
function findOnPath(name, pathVar) {
  return String(typeof pathVar === "string" ? pathVar : "/usr/bin:/bin").split(":").some(function (d) {
    try { return !!d && path.isAbsolute(d) && fs.statSync(path.join(d, name)).isFile(); } catch (_) { return false; }
  });
}
// `diagnostic` is a short, secret-free hint for the admin (never shown to room members).
function failure(reason, diagnostic) {
  var f = { ready: false, workspace: null, wrap: null, reason: reason, cleanup: function () {} };
  if (diagnostic) f.diagnostic = diagnostic;
  return f;
}
var diagnosedAt = 0, abiLogged = new Set();
// One throttled admin-facing line in the daemon log for a host precondition that refuses contained runs (the refusal itself
// carries only a fixed reason). The text is secret-free.
// `opts.diagnosticLog` (tests) receives every line, unthrottled.
function hostDiagnostic(opts, reason, text) {
  if (typeof opts.diagnosticLog === "function") opts.diagnosticLog("[private-scope] " + reason + ": " + text);
  else if (Date.now() - diagnosedAt > 300000) { diagnosedAt = Date.now(); console.error("[private-scope] " + reason + ": " + text); }
  return text;
}
function netnsDiagnostic(stderr) {
  var first = String(stderr || "").split("\n")[0].replace(/[^\x20-\x7e]/g, "?").slice(0, 160);
  var text = "bwrap --unshare-net failed (" + (first || "no output") + "). Unprivileged user namespaces are probably blocked " +
    "(Ubuntu 24.04: kernel.apparmor_restrict_unprivileged_userns=1; others: user.max_user_namespaces=0). Contained agent runs are refused. " +
    "Fix the host, or set roomExecution.network / privateExecution.network to \"landlock\" to accept the shared-network residual explicitly.";
  if (Date.now() - diagnosedAt > 300000) { diagnosedAt = Date.now(); console.error("[private-scope] network_isolation_unavailable: " + text); }
  return text;
}
// Where the per-run egress socket directory lives. A short path (unix socket limit 108 bytes): XDG_RUNTIME_DIR (tmpfs, mode 0700 by
// the system) when usable, else the OS temp dir. Never inside the workspace.
var liveEgressDirs = new Set();
process.once("exit", function () { liveEgressDirs.forEach(function (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }); }); // leaked scopes leave no socket dir behind
function egressBase(env) {
  var run = env && typeof env.XDG_RUNTIME_DIR === "string" ? env.XDG_RUNTIME_DIR : "";
  try {
    if (run && path.isAbsolute(run)) {
      var st = fs.lstatSync(run);
      if (st.isDirectory() && !st.isSymbolicLink() && st.uid === process.getuid() && (st.mode & 0o077) === 0) return fs.realpathSync(run);
    }
  } catch (_) {}
  return fs.realpathSync(os.tmpdir());
}
function sweepEgress(base) {
  try {
    fs.readdirSync(base).forEach(function (n) {
      if (n.indexOf("aigora-egress-") !== 0) return;
      var p = path.join(base, n);
      try {
        var st = fs.lstatSync(p);
        if (st.isDirectory() && st.uid === process.getuid() && !liveEgressDirs.has(p) && Date.now() - st.mtimeMs > STALE_RUN_MS) removeTree(p);
      } catch (_) {}
    });
  } catch (_) {}
}
function token(s) { return typeof s === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(s) && s !== "." && s !== ".."; }
function beneath(p, root) { return p === root || p.indexOf(root + "/") === 0; }
function removeQuietly(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
// u+rwx on real directories only (lstat, never through a symlink): an agent may have chmod 000'd a tree.
function repairTree(p) {
  try {
    var st = fs.lstatSync(p);
    if (!st.isDirectory()) return;
    if ((st.mode & 0o700) !== 0o700) fs.chmodSync(p, st.mode | 0o700);
    fs.readdirSync(p).forEach(function (n) { repairTree(path.join(p, n)); });
  } catch (_) {}
}
// Remove a tree and VERIFY it is gone; never throws.
function removeTree(p) {
  repairTree(p); removeQuietly(p);
  try { fs.lstatSync(p); return false; } catch (e) { return e.code === "ENOENT"; }
}
function stateBytes(dir, cap) {
  var total = 0, stack = [dir];
  while (stack.length) {
    var d = stack.pop(), names;
    try { repairTree(d); names = fs.readdirSync(d); } catch (e) { if (e.code === "ENOENT") continue; return Infinity; }
    for (var i = 0; i < names.length; i++) {
      var st; try { st = fs.lstatSync(path.join(d, names[i])); } catch (_) { return Infinity; }
      total += st.size;
      if (total > cap) return total;
      if (st.isDirectory()) stack.push(path.join(d, names[i]));
    }
  }
  return total;
}
function sweepStale(base, maxAge) {
  var now = Date.now();
  function dirs(p) { try { return fs.readdirSync(p).filter(function (n) { return fs.lstatSync(path.join(p, n)).isDirectory(); }); } catch (_) { return []; } }
  dirs(base).forEach(function (a) { dirs(path.join(base, a)).forEach(function (c) {
    var channel = path.join(base, a, c);
    try { fs.readdirSync(channel).forEach(function (n) {
      var p = path.join(channel, n), ws = path.join(channel, n.replace(/\.(codex-config\.toml|skills)$/, ""));
      if (n.indexOf("run-") !== 0 || liveWorkspaces.has(ws) || now - fs.lstatSync(p).mtimeMs < maxAge) return;
      removeTree(p);
    }); } catch (_) {}
  }); });
}
function execute(command, args, env) {
  return new Promise(function (resolve) {
    try {
      childProcess.execFile(command, args, { shell: false, timeout: 10000, killSignal: "SIGKILL", maxBuffer: 16384, env: env || {} }, function (err, stdout, stderr) {
        resolve({ ok: !err, stdout: String(stdout || ""), stderr: String(stderr || "") });
      });
    } catch (_) { resolve({ ok: false, stdout: "", stderr: "" }); }
  });
}
function directory(p) {
  if (typeof p !== "string" || !path.isAbsolute(p) || p.indexOf("\0") !== -1) throw new Error("workspace_unavailable");
  var real = fs.realpathSync(p);
  if (!fs.statSync(real).isDirectory() || real === "/") throw new Error("workspace_unavailable");
  return real;
}
function privateDir(p) {
  try { fs.mkdirSync(p, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") throw e; }
  if (!fs.lstatSync(p).isDirectory() || fs.lstatSync(p).isSymbolicLink()) throw new Error("workspace_unavailable");
  fs.chmodSync(p, 0o700);
  return fs.realpathSync(p);
}
// The allowlisted sandbox root shared by every contained agent: runtime, libraries and a few /etc files only.
function runtimeRootArgs(o) {
  var a = [];
  RUNTIME_DIRS.forEach(function (d) { if (fs.existsSync(d)) a.push("--ro-bind", d, d); });
  RUNTIME_LINKS.forEach(function (l) {
    var st; try { st = fs.lstatSync(l); } catch (_) { return; }
    if (st.isSymbolicLink()) a.push("--symlink", fs.readlinkSync(l), l); else if (st.isDirectory()) a.push("--ro-bind", l, l);
  });
  ETC_ALLOWLIST.forEach(function (n) {
    var f = "/etc/" + n, real;
    try { real = fs.realpathSync(f); } catch (_) { return; }
    // A symlink out of /etc keeps working only when its target is inside an already bound runtime tree.
    var bound = (o.fileBinds || []).some(function (b) { return b[1] === real; }); // e.g. resolv.conf -> /run/... bound below
    if (real === f) a.push("--ro-bind", f, f);
    else if (bound || RUNTIME_DIRS.some(function (d) { return beneath(real, d); })) a.push("--symlink", fs.readlinkSync(f), f);
  });
  ALLOWLIST_MASKS.forEach(function (d) { try { if (fs.statSync(d).isDirectory()) a.push("--tmpfs", d); } catch (_) {} });
  // Masks only matter where an allowlisted host tree could still expose them (e.g. data dirs under /usr).
  o.masks.forEach(function (d) { if (RUNTIME_DIRS.some(function (r) { return beneath(d, r); })) a.push("--tmpfs", d); });
  return a;
}
// A resolv.conf symlink into /run would dangle behind the /run mask: bind only its target.
function resolvBinds(file) {
  try {
    var resolved = fs.realpathSync(file || "/etc/resolv.conf");
    if (beneath(resolved, "/run") && fs.statSync(resolved).isFile()) return [[resolved, resolved]];
  } catch (_) {}
  return [];
}
// Command prefix (append the command and its args) applying the Landlock network policy: TCP connect only to 443, 53 and
// `portList`, abstract sockets/signals scoped.
function landlockPrefix(python, portList) {
  return [python, "-I", "-S", "-c", LAUNCHER, ports(portList).join(",")];
}
// Spawn environment for systemd-run: the sandbox env stays sanitized, but systemd-run itself needs the daemon's real user-bus
// location. It consumes them; the python shim then execs bwrap with its own clean env, so neither reaches the sandbox.
function limitSpawnEnv(inner) {
  var e = Object.assign({}, inner);
  ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"].forEach(function (k) { if (typeof process.env[k] === "string" && process.env[k]) e[k] = process.env[k]; });
  return e;
}
function limitsOpts(o, id) {
  var l = o.limits || {};
  return { config: l.config, id: id, logger: l.logger, probe: l.probe, spawnSync: l.spawnSync };
}
// Public wrap: bwrap (or the secret shim -> bwrap) inside `systemd-run --user --scope` resource limits. Fails closed (throws).
function makeWrap(o) {
  var build = makeBuild(o), counter = 0, units = new Set();
  var scopeTag = crypto.randomBytes(4).toString("hex");
  function wrap(command, args, wrapOpts) {
    var w = build(command, args, wrapOpts);
    var lim = sandboxLimits.wrapCommand({ command: w.command, args: w.args }, limitsOpts(o, "r" + scopeTag + "-" + (++counter)));
    if (!lim.ready) throw new Error(lim.reason);
    var done = false;
    function cleanup() {
      if (done) return true; done = true;
      if (lim.unit) units.delete(lim.unit);
      try { return lim.cleanup() !== false; } catch (_) { return false; }
    }
    if (lim.unit) units.add(lim.unit);
    return { command: lim.command, args: lim.args, env: lim.unlimited ? w.env : limitSpawnEnv(w.env), unit: lim.unit, cleanup: cleanup };
  }
  wrap.raw = build; // unlimited, for the scope's own startup probes (ABI query, containment probe)
  wrap.stopAll = function () {
    var ok = true;
    Array.from(units).forEach(function (u) { units.delete(u); try { if (sandboxLimits.stopUnit(u, o.limits) === false) ok = false; } catch (_) { ok = false; } });
    return ok;
  };
  return wrap;
}
function makeBuild(o) {
  return function (command, args, wrapOpts) {
    wrapOpts = wrapOpts || {};
    if (typeof command !== "string" || !Array.isArray(args)) throw new Error("probe_failed");
    var binaryDirs = wrapOpts.binaryDirs || [];
    if (!Array.isArray(binaryDirs)) throw new Error("probe_failed");
    binaryDirs = binaryDirs.map(function (p) {
      var real = directory(p);
      // Never let a binary bind undo a privacy mask.
      o.masks.forEach(function (d) { if (beneath(d, real)) throw new Error("probe_failed"); });
      o.protectedDirs.forEach(function (d) {
        if (beneath(d, real) || (d !== o.home && beneath(real, d))) throw new Error("probe_failed");
      });
      return real;
    });
    var a = runtimeRootArgs(o);
    a.push("--proc", "/proc", "--dev", "/dev");
    a.push("--tmpfs", "/tmp", "--tmpfs", o.home, "--dir", path.join(o.home, ".config"), "--dir", path.join(o.home, ".cache")); // writable, empty /tmp and HOME for the CLI's own scratch, config and cache
    binaryDirs.forEach(function (d) { a.push("--ro-bind", d, d); });
    o.credentials.forEach(function (p) { a.push("--ro-bind", p, p); });
    (o.fileBinds || []).forEach(function (b) { a.push("--ro-bind", b[0], b[1]); });
    if (o.state) a.push("--bind", o.state, o.stateTarget);
    if (o.toolchain) a.push("--ro-bind", o.toolchain, o.toolchain); // read-only document tools; nothing else of the host
    a.push("--bind", o.workspace, o.workspace);
    if (o.network === "proxy") a.push("--ro-bind", o.egressSocket, EGRESS_SOCKET); // the per-run egress socket: the only way out
    a.push("--remount-ro", "/");
    a.push("--unshare-pid", "--as-pid-1", "--unshare-ipc", "--unshare-uts", "--hostname", SANDBOX_HOSTNAME, "--unshare-cgroup-try");
    var proxy = o.network === "proxy";
    if (proxy) a.push("--unshare-net"); // own network namespace: only a loopback device
    a.push("--new-session", "--die-with-parent", "--chdir", o.workspace, "--clearenv");
    var env = wrapOpts.env || o.env;
    var names = ["PATH", "LANG", "TERM"];
    var passEnv = wrapOpts.passEnv || [];
    if (!Array.isArray(passEnv)) throw new Error("probe_failed");
    passEnv.forEach(function (k) {
      if (typeof k !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(k)) throw new Error("probe_failed");
      if (k !== "HOME" && names.indexOf(k) === -1) names.push(k);
    });
    // Credential-looking values (the injected provider key, tokens passed through passEnv) never go on the command line:
    // they travel through bwrap --args FD (see SECRET_SHIM).
    var secrets = [];
    function setenv(k, v) { if (SECRET_NAME.test(k) || (o.injectEnv && Object.prototype.hasOwnProperty.call(o.injectEnv, k))) secrets.push([k, v]); else a.push("--setenv", k, v); }
    names.forEach(function (k) {
      if (typeof env[k] !== "string" || env[k].indexOf("\0") !== -1) return;
      setenv(k, k === "PATH" && o.toolchain ? path.join(o.toolchain, "bin") + ":" + env[k] : env[k]);
    });
    // HOME is the sandbox's own tmpfs: per run, never shared, outside the workspace so never posted. The XDG dirs are set
    // explicitly (pre-created above): without them LibreOffice cannot place its profile (no passwd entry in the sandbox).
    a.push("--setenv", "XDG_CONFIG_HOME", path.join(o.home, ".config"), "--setenv", "XDG_CACHE_HOME", path.join(o.home, ".cache"));
    if (o.toolchain) a.push("--setenv", "PYTHONNOUSERSITE", "1");
    if (proxy) {
      // Set last so nothing the caller passes can redirect or disable the proxy. NO_PROXY is empty on purpose.
      var url = "http://127.0.0.1:" + FORWARDER_PORT;
      ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"].forEach(function (k) { a.push("--setenv", k, url); });
      a.push("--setenv", "NO_PROXY", "", "--setenv", "no_proxy", "");
      if (o.agent === "claude") a.push("--setenv", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1");
    }
    // api_key credential mode: the provider key is set for the contained CLI only (never via the host env).
    Object.keys(o.injectEnv || {}).forEach(function (k) { setenv(k, o.injectEnv[k]); });
    // Landlock connect policy: proxy mode reaches only the forwarder (extra ports are validated but meaningless without a host network).
    var allowed = proxy ? ["F" + FORWARDER_PORT + (o.landlockLevel === undefined ? "" : "@" + o.landlockLevel)] : Array.from(new Set(o.ports.concat(ports(wrapOpts.allowTcpPorts))));
    if (proxy) ports(wrapOpts.allowTcpPorts);
    a.push("--setenv", "HOME", o.home);
    if (secrets.length) a.push("--args", "@SECRET_FD@");
    a.push("--", o.python, "-I", "-S", "-c", LAUNCHER);
    // bubblewrap itself is found through the caller's PATH only; the sandboxed process gets the --setenv allowlist.
    var hostPath = typeof o.env.PATH === "string" ? o.env.PATH : "/usr/bin:/bin";
    var tail = a.concat([allowed.join(","), command], args);
    if (!secrets.length) return { command: o.bwrapBinary, args: tail, env: { PATH: hostPath } };
    return { command: o.python, args: ["-I", "-S", "-c", SECRET_SHIM, o.bwrapBinary].concat(tail), env: { PATH: hostPath, AIGORA_SECRET_ARGS: JSON.stringify(secrets) } };
  };
}
// No output containing the canary leaves this probe.
async function probePrivateScope(o) {
  var artifacts = [], listeners = [], sockets = new Set();
  try {
    var nonce = crypto.randomBytes(24).toString("hex");
    var outside = path.join(o.home, ".private-scope-probe-" + nonce);
    var sibling = fs.mkdtempSync(path.join(path.dirname(path.dirname(o.workspace)), "private-scope-probe-")); artifacts.push(sibling);
    var hidden = path.join(sibling, "canary");
    var inside = path.join(o.workspace, "private-scope-probe-" + nonce);
    var dataCanary = o.dataRoot ? path.join(o.dataRoot, ".private-scope-probe-" + nonce) : outside + "-none";
    var emptied = PROBED_EMPTY.filter(function (d) { return !beneath(o.workspace, d) && !beneath(o.home, d) && fs.existsSync(d); });
    var outsideWrite = outside + "-write";
    var insideWrite = inside + "-write";
    [outside, inside, outsideWrite, insideWrite, dataCanary].forEach(function (p) { artifacts.push(p); });
    [outside, hidden, inside].concat(o.dataRoot ? [dataCanary] : []).forEach(function (p) { fs.writeFileSync(p, nonce, { flag: "wx", mode: 0o600 }); });
    var hiddenHost = PROBED_HIDDEN.filter(function (f) { return fs.existsSync(f); });
    var script = 'for f in $9; do [ -e "$f" ] && exit 19; done; cat "$1" >/dev/null 2>&1 && exit 11; cat "$2" >/dev/null 2>&1 && exit 12; cat "$7" >/dev/null 2>&1 && exit 17; ' +
      'for d in $8; do [ -z "$(ls -A "$d" 2>/dev/null)" ] || exit 18; done; ' +
      '[ "$(cat "$3")" = "$6" ] || exit 13; ' +
      '{ printf "%s" "$6" > "$4"; } 2>/dev/null; printf "%s" "$6" > "$5" || exit 14; ' +
      (o.network === "landlock" ? '[ "$$" = 1 ]' : '[ "$$" != 1 ]') + ' || exit 15; set -- /proc/[0-9]*; [ "$#" = ' + (o.network === "landlock" ? 1 : 2) + ' ] && [ "$1" = /proc/1 ] || exit 16; ' +
      'printf "private-scope-probe:denied,denied,read,write,pid1\\n"';
    var w = o.wrap("/bin/sh", ["-c", script, "sh", outside, hidden, inside, outsideWrite, insideWrite, nonce, dataCanary, emptied.join(" "), hiddenHost.join(" ")]);
    var r = await execute(w.command, w.args, w.env);
    if (!(r.ok && r.stderr === "" && r.stdout === "private-scope-probe:denied,denied,read,write,pid1\n" &&
      !fs.existsSync(outsideWrite) && fs.readFileSync(insideWrite, "utf8") === nonce)) return { ok: false };
    var abstract = "private-scope-" + nonce, seen = false, unexpected = false;
    async function listen(address, accept) {
      var server = net.createServer(function (socket) {
        sockets.add(socket); socket.on("close", function () { sockets.delete(socket); });
        if (accept) seen = true; else unexpected = true;
        socket.end("!");
      });
      listeners.push(server);
      await new Promise(function (resolve, reject) { server.once("error", reject); server.listen(address, resolve); });
      return server;
    }
    async function tcp(accept) {
      var server;
      do {
        server = await listen({ host: "127.0.0.1", port: 0 }, accept);
        if (!(o.allowTcpPorts || [443, 53]).includes(server.address().port)) return server;
        await new Promise(function (resolve) { server.close(resolve); });
      } while (true);
    }
    await listen("\0" + abstract);
    var blocked = await tcp();
    if (o.network === "landlock") {
      var allowed = await tcp(true);
      w = o.wrap("/usr/bin/python3", ["-I", "-S", "-c", NETWORK_PROBE, abstract,
        String(blocked.address().port), String(allowed.address().port)], { allowTcpPorts: [allowed.address().port] });
      r = await execute(w.command, w.args, w.env);
      return { ok: r.ok && r.stderr === "" && seen && !unexpected &&
        r.stdout === "private-scope-network:denied,denied,connected,denied\n" };
    }
    // Proxy mode: a host UDP listener on loopback must never hear the sandbox, and the host TCP/abstract listeners must see nothing.
    var udp = dgram.createSocket("udp4"), heard = false;
    udp.on("message", function () { heard = true; });
    await new Promise(function (resolve, reject) { udp.once("error", reject); udp.bind(0, "127.0.0.1", resolve); });
    listeners.push({ close: function (cb) { try { udp.close(cb); } catch (_) { cb(); } } });
    w = o.wrap("/usr/bin/python3", ["-I", "-S", "-c", NETWORK_PROBE_PROXY, abstract,
      String(blocked.address().port), String(udp.address().port), String(FORWARDER_PORT), String(o.landlockLevel === undefined ? 6 : o.landlockLevel)]);
    r = await execute(w.command, w.args, w.env);
    await new Promise(function (resolve) { setTimeout(resolve, 150); });
    return { ok: r.ok && r.stderr === "" && !unexpected && !heard && r.stdout === "private-scope-network:proxy-ok\n" };
  } catch (_) { return { ok: false }; }
  finally {
    sockets.forEach(function (socket) { socket.destroy(); });
    await Promise.all(listeners.map(function (server) { return new Promise(function (resolve) { server.close(resolve); }); }));
    artifacts.forEach(removeQuietly);
  }
}
async function prepareScope(opts, hold) {
  var workspace = null, cleanup = function () {}, reason = "workspace_unavailable";
  try {
    opts = opts || {};
    if (typeof opts.agent !== "string" || !Object.prototype.hasOwnProperty.call(PROFILES, opts.agent)) return failure("provider_not_supported");
    reason = "private_execution_disabled";
    var enabled = opts.isEnabled || function () { return false; };
    if (enabled(opts.agent) !== true) return failure(reason);
    reason = "invalid_scope_id";
    if (![opts.actorId, opts.roomId, opts.channelId, opts.rootSessionId].every(token)) return failure(reason);
    reason = "invalid_network_policy";
    var allowedPorts = ports(opts.allowTcpPorts);
    var netKind = opts.capGroup === "room" ? "room" : "private";
    var network = opts.network === undefined ? netFlags.networkMode(netKind) : opts.network;
    var egressMode = opts.egressMode === undefined ? netFlags.egressMode(netKind) : opts.egressMode;
    if ((network !== "proxy" && network !== "landlock") || (egressMode !== "public" && egressMode !== "providers")) return failure(reason);
    reason = "network_isolation_unavailable";
    if (process.platform !== "linux" || process.arch !== "x64" || (opts.platform === undefined ? process.platform : opts.platform) !== "linux" || (opts.arch === undefined ? process.arch : opts.arch) !== "x64") return failure(reason);
    // Trusted dependency hooks support failure testing; default execution always resolves system Python.
    var python = null;
    try { python = (opts.resolvePython || function () { return fs.realpathSync("/usr/bin/python3"); })(); } catch (e) { python = null; }
    if (typeof python !== "string" || !beneath(python, "/usr") || fs.realpathSync(python) !== python || !fs.statSync(python).isFile()) {
      hostDiagnostic(opts, reason, "/usr/bin/python3 is missing or does not resolve to a real file under /usr. Install python3 with the system package manager (apt install python3 / dnf install python3). Contained agent runs are refused until then.");
      return failure(reason);
    }
    reason = "workspace_unavailable";
    var configDir = require("./config").CONFIG_DIR;
    var home = directory(opts.home || os.homedir());
    var basePath = opts.baseDir || path.join(configDir, "private-agent-scope");
    if (typeof basePath !== "string" || !path.isAbsolute(basePath) || basePath === "/") return failure(reason);
    reason = "credential_unavailable";
    var injectEnv = opts.injectEnv === undefined ? {} : opts.injectEnv;
    var credentialMode = opts.credentialMode === undefined ? "api_key" : opts.credentialMode;
    var noCredential = PROFILES[opts.agent].noCredential === true;
    if (noCredential) credentialMode = "none"; // the profile never holds a provider credential, whatever the caller asked for
    else if (credentialMode !== "api_key") return failure(reason);
    if (!injectEnv || typeof injectEnv !== "object" || Array.isArray(injectEnv) || Object.keys(injectEnv).length > 8 ||
      Object.keys(injectEnv).some(function (k) { return !/^[A-Z][A-Z0-9_]*$/.test(k) || typeof injectEnv[k] !== "string" || !injectEnv[k] || injectEnv[k].indexOf("\0") !== -1; })) return failure(reason);
    if (credentialMode === "api_key" && Object.keys(injectEnv).length === 0) return failure(reason);
    if (noCredential && Object.keys(injectEnv).length) return failure(reason);
    // api_key mode binds no credential file at all; the key arrives through injectEnv.
    var credentials = [];
    reason = "resource_limit_reached";
    if (!hold()) return failure(reason);
    reason = "bubblewrap_unavailable";
    var binary = opts.bwrapBinary || "bwrap";
    var env = opts.env || process.env;
    var childEnv = { PATH: typeof env.PATH === "string" ? env.PATH : "/usr/bin:/bin" };
    if (!(await execute(binary, ["--version"], childEnv)).ok) return failure(reason);
    var plainTry = await execute(binary, ["--ro-bind", "/", "/", "--", "/bin/true"], childEnv);
    if (!plainTry.ok) {
      hostDiagnostic(opts, reason, "bwrap cannot start a sandbox (" + (String(plainTry.stderr || "").split("\n")[0].replace(/[^\x20-\x7e]/g, "?").slice(0, 160) || "no output") + "). Unprivileged user namespaces are probably blocked (Ubuntu 24.04: AppArmor kernel.apparmor_restrict_unprivileged_userns=1; container: default seccomp; others: user.max_user_namespaces=0). Contained agent runs are refused.");
      return failure(reason);
    }
    // Memory/process/CPU limits (G7/D8): without a working `systemd-run --user` no run starts, unless privateExecution.allowUnlimited.
    reason = "resource_limits_unavailable";
    var limits = { config: opts.limitsConfig !== undefined ? opts.limitsConfig : (function () { try { return require("./config").loadConfig(); } catch (_) { return {}; } })(),
      logger: opts.limitsLogger, probe: opts.limitsProbe, spawnSync: opts.limitsSpawnSync };
    if (!sandboxLimits.wrapCommand({ command: "/bin/true", args: [] }, limitsOpts({ limits: limits }, undefined)).ready) return failure(reason);
    reason = "bubblewrap_unavailable";
    if (network === "proxy") {
      // Fail closed, never fall back to the shared host network: no unprivileged network namespace means no contained run.
      var nsTry = await execute(binary, ["--unshare-net", "--unshare-uts", "--ro-bind", "/", "/", "--", "/bin/true"], childEnv);
      if (!nsTry.ok) return failure("network_isolation_unavailable", netnsDiagnostic(nsTry.stderr));
    }
    reason = "workspace_unavailable";
    fs.mkdirSync(path.dirname(basePath), { recursive: true, mode: 0o700 });
    var base = privateDir(basePath);
    var actor = privateDir(path.join(base, opts.actorId));
    var channel = privateDir(path.join(actor, opts.channelId));
    reason = "resource_limit_reached";
    if (stateBytes(path.join(channel, "state"), opts.maxStateBytes || MAX_STATE_BYTES) > (opts.maxStateBytes || MAX_STATE_BYTES)) return failure(reason);
    reason = "workspace_unavailable";
    var swept = sweepAt.get(base) || 0;
    if (opts.sweepMaxAgeMs !== undefined || Date.now() - swept > 600000) { sweepAt.set(base, Date.now()); sweepStale(base, opts.sweepMaxAgeMs === undefined ? STALE_RUN_MS : opts.sweepMaxAgeMs); }
    var persistent = opts.persistentWorkspace === true;
    if (persistent) {
      // One live scope per persistent directory; re-validated (privateDir lstat/realpath) on every open.
      workspace = privateDir(path.join(channel, "workspace"));
      if (liveWorkspaces.has(workspace)) { workspace = null; reason = "resource_limit_reached"; throw new Error(reason); }
    } else workspace = fs.realpathSync(fs.mkdtempSync(path.join(channel, "run-")));
    liveWorkspaces.add(workspace);
    fs.chmodSync(workspace, 0o700);
    var inode = fs.lstatSync(workspace).ino;
    cleanup = function () {
      liveWorkspaces.delete(workspace);
      if (persistent) return true; // the room workspace outlives its scope
      try {
        if (fs.realpathSync(channel) !== channel) return false;
        var st; try { st = fs.lstatSync(workspace); } catch (e) { return e.code === "ENOENT"; }
        return (st.isSymbolicLink() || st.ino === inode) ? removeTree(workspace) : false;
      } catch (_) { return false; }
    };
    var egress = null, egressSocket = null;
    if (network === "proxy") {
      reason = "network_isolation_unavailable";
      var egressRoot = opts.egressBaseDir || egressBase(env);
      sweepEgress(egressRoot);
      var egressDir = fs.mkdtempSync(path.join(egressRoot, "aigora-egress-"));
      liveEgressDirs.add(egressDir);
      var egressBaseCleanup = cleanup;
      cleanup = function () {
        try { if (egress) egress.close(); } catch (_) {}
        var gone = removeTree(egressDir);
        if (gone) liveEgressDirs.delete(egressDir);
        return egressBaseCleanup() && gone;
      };
      fs.chmodSync(egressDir, 0o700);
      egressSocket = path.join(egressDir, "s");
      if (Buffer.byteLength(egressSocket) > 100) throw new Error(reason);
      egress = await egressLib.createEgress({ path: egressSocket, mode: egressMode, broker: opts.egressBroker, label: opts.channelId,
        log: opts.egressLog || function (line) { console.error(line); }, lookup: opts.egressLookup, connect: opts.egressConnect,
        maxConnections: opts.egressMaxConnections, maxBytes: opts.egressMaxBytes, idleMs: opts.egressIdleMs });
      reason = "workspace_unavailable";
    }
    var toolchain = null;
    if (opts.toolchainDir !== undefined && opts.toolchainDir !== null) {
      // Fail closed: a configured toolchain that is unusable here stops the turn instead of silently running without it.
      toolchain = require("./room-execution-flags").validateToolchainDir(opts.toolchainDir,
        [workspace, configDir, basePath, home, require("./config").AIGORA_HOME].concat((opts.dataDirs || []).filter(function (d) { return typeof d === "string"; })));
    }
    var fileBinds = [];
    if (opts.agent === "codex" && typeof opts.codexConfigText === "string") {
      // Per-run minimal config, outside the workspace the agent can write; bound read-only.
      var cfgFile = path.join(channel, path.basename(workspace) + ".codex-config.toml");
      fs.writeFileSync(cfgFile, opts.codexConfigText, { flag: "wx", mode: 0o600 });
      fs.chmodSync(cfgFile, 0o600);
      fileBinds.push([cfgFile, path.join(home, ".codex/config.toml")]);
      var baseCleanup = cleanup;
      cleanup = function () { var ok = removeTree(cfgFile); return baseCleanup() && ok; };
    }
    var skillPlugin = null;
    if (opts.agent === "claude" && Array.isArray(opts.skills) && opts.skills.length) {
      // Per-run plugin dir outside the writable workspace, assembled from the immutable catalog (hash re-checked), bound read-only.
      reason = "skills_unavailable";
      var skillsDir = path.join(channel, path.basename(workspace) + ".skills");
      var skillsBaseCleanup = cleanup;
      cleanup = function () { var ok = removeTree(skillsDir); return skillsBaseCleanup() && ok; };
      removeTree(skillsDir);
      var skillNames = require("./skills-catalog").assemble(skillsDir, opts.skills);
      fileBinds.push([skillsDir, SKILLS_MOUNT]);
      skillPlugin = { path: SKILLS_MOUNT, names: skillNames };
      reason = "workspace_unavailable";
    }
    var state = null, stateTarget = null;
    if (opts.agent === "claude" && opts.persistClaudeState === true) {
      state = privateDir(path.join(privateDir(path.join(channel, "state")), "claude"));
      stateTarget = path.join(home, ".claude/projects");
    }
    if (opts.agent === "codex" && opts.persistCodexState === true) {
      state = privateDir(path.join(privateDir(path.join(channel, "state")), "codex"));
      stateTarget = path.join(home, ".codex/sessions");
    }
    fileBinds.push.apply(fileBinds, resolvBinds(opts.resolvConf));
    var dataDirs = opts.dataDirs || [];
    if (!Array.isArray(dataDirs)) throw new Error("workspace_unavailable");
    var protectedDirs = [home, base, configDir, path.join(home, ".claude"), path.join(home, ".codex")].concat(dataDirs.map(directory));
    var dataRoot = require("./config").AIGORA_HOME || path.dirname(configDir);
    var masks = MASKED_DIRS.concat(protectedDirs, [path.dirname(base), dataRoot, path.join(dataRoot, "console"), process.cwd()]).filter(function (d) {
      try { return d !== "/" && fs.statSync(d).isDirectory(); } catch (_) { return false; }
    }).map(directory).filter(function (d, i, list) { return list.indexOf(d) === i; });
    masks.sort(function (a, b) { return a.length - b.length; });
    if (masks.some(function (d) { return beneath(d, workspace); })) throw new Error("workspace_unavailable");
    var scopeOpts = { limits: limits, workspace: workspace, home: home, masks: masks, credentials: credentials, fileBinds: fileBinds,
      state: state, stateTarget: stateTarget, toolchain: toolchain, protectedDirs: protectedDirs, bwrapBinary: binary, env: env, python: python, ports: allowedPorts, injectEnv: injectEnv,
      network: network, egressSocket: egressSocket, agent: opts.agent };
    var wrap = makeWrap(scopeOpts);
    var stopRuns = cleanup;
    cleanup = function () { var ok = true; try { ok = wrap.stopAll() !== false; } catch (_) { ok = false; } return stopRuns() && ok; };
    reason = "network_isolation_unavailable";
    var abiWrap = wrap.raw("/bin/true", []);
    abiWrap.args = abiWrap.args.slice(0, abiWrap.args.indexOf("--") + 6).concat(["--abi"]);
    var abi = await (opts.landlockAbi || async function (w) {
      var r = await execute(w.command, w.args, w.env);
      return r.ok && r.stderr === "" && /^[0-9]+\n$/.test(r.stdout) ? Number(r.stdout.trim()) : NaN;
    })(abiWrap);
    // "landlock" network mode: Landlock is the only network barrier, so it needs ABI 6 (TCP rules plus the abstract-socket and signal scopes).
    // "proxy" mode: the namespaces are the boundary; Landlock is applied as far as the kernel allows (ABI 4: TCP rules, ABI 6: scopes).
    // A failed or malformed query (as opposed to "no Landlock": ABI 0) is never guessed at: it fails closed in both modes.
    var strict = network === "landlock";
    if (!Number.isInteger(abi) || abi < 0 || (strict && abi < 6)) {
      hostDiagnostic(opts, reason, "the kernel's Landlock ABI is " + (Number.isInteger(abi) && abi >= 0 ? abi : "unavailable") + (strict ?
        ", but ABI 6 or later is required (Linux 6.12+) by the \"landlock\" network mode; Landlock must also be enabled in the LSM list. Contained agent runs are refused. Use a newer kernel or the default \"proxy\" network mode." :
        " and could not be queried. Contained agent runs are refused."));
      cleanup(); return failure(reason);
    }
    var landlock = { abi: abi, net: abi >= 4, scopes: abi >= 6 };
    if (!strict) {
      scopeOpts.landlockLevel = abi >= 6 ? 6 : abi >= 4 ? 4 : 0;
      if (abi < 6 && (opts.diagnosticLog || !abiLogged.has(abi))) {
        abiLogged.add(abi);
        var gaps = (landlock.net ? "" : "TCP connect/bind rules, ") + "abstract-socket and signal scopes";
        var line = "[private-scope] Landlock ABI is " + abi + " (full defence in depth needs ABI 6, Linux 6.12+); not active: " + gaps +
          ". Contained runs continue on the user, network, pid, ipc and uts namespaces alone.";
        if (typeof opts.diagnosticLog === "function") opts.diagnosticLog(line); else console.error(line);
      }
    }
    reason = "probe_failed";
    var key = JSON.stringify([home, base, binary, python, allowedPorts, network, egressMode, scopeOpts.landlockLevel]);
    var maxAge = opts.probeMaxAgeMs === undefined ? 30000 : opts.probeMaxAgeMs;
    if (typeof maxAge !== "number" || !Number.isFinite(maxAge) || maxAge < 0) { cleanup(); return failure(reason); }
    var pass = passes.get(key);
    if (!(maxAge > 0 && pass && Date.now() - pass < maxAge)) {
      var probe = await probePrivateScope({ home: home, baseDir: base, workspace: workspace, wrap: wrap.raw, dataRoot: fs.existsSync(dataRoot) ? directory(dataRoot) : null, allowTcpPorts: allowedPorts, network: network, landlockLevel: scopeOpts.landlockLevel });
      if (!probe.ok) { passes.delete(key); cleanup(); return failure(reason); }
      passes.set(key, Date.now());
      if (egress) egress.resetStats(); // the probe's own requests are not run traffic
    }
    // Network policy actually in force: "proxy" (own namespace, host egress proxy; no residual) or "landlock" (explicit opt-in).
    var result = { ready: true, workspace: workspace, wrap: wrap, reason: null, cleanup: cleanup, residual: network === "proxy" ? (landlock.net ? [] : ["landlock_net_unavailable"]).concat(landlock.scopes ? [] : ["landlock_scopes_unavailable"]) : RESIDUAL_LANDLOCK.slice(), landlock: landlock,
      networkPolicy: network, egressMode: network === "proxy" ? egressMode : null, egress: egress, pastaAvailable: findOnPath("pasta", env.PATH), credentialMode: credentialMode, skillPlugin: skillPlugin };
    prepared.add(result);
    return result;
  } catch (_) { cleanup(); return failure(reason); }
}
async function preparePrivateAgentScope(opts) {
  var slot = null, r;
  // Room scopes count against their own cap so they cannot starve private channels (and vice versa).
  var pool = opts && opts.capGroup === "room" ? roomLive : live;
  function hold() {
    var max = opts && Number.isInteger(opts.maxConcurrent) && opts.maxConcurrent >= 1 ? opts.maxConcurrent : require("./private-execution-flags").maxPrivateConcurrent();
    if (pool.size >= max) return false;
    slot = {}; pool.add(slot); return true;
  }
  try { r = await prepareScope(opts, hold); } catch (_) { r = failure("workspace_unavailable"); }
  if (!r.ready) { if (slot) pool.delete(slot); return r; }
  var inner = r.cleanup;
  r.cleanup = function () { var ok = inner(); pool.delete(slot); return ok; };
  return r;
}
function removePrivateState(opts, agent) {
  try {
    if (!opts || !token(opts.actorId) || !token(opts.channelId)) return;
    var base = directory(opts.baseDir || path.join(require("./config").CONFIG_DIR, "private-agent-scope"));
    var target = path.join(base, opts.actorId, opts.channelId, "state", agent);
    var current = base;
    [opts.actorId, opts.channelId, "state", agent].forEach(function (part) {
      current = path.join(current, part);
      if (fs.realpathSync(current) !== current || !fs.lstatSync(current).isDirectory()) throw new Error();
    });
    if (!removeTree(target)) console.error("[private-scope] state removal incomplete");
  } catch (_) {}
}
// Where the persistent CLI session store of (actorId, channelId) lives; null for invalid ids. Not created here.
function privateStatePath(opts, agent) {
  if (!opts || !token(opts.actorId) || !token(opts.channelId) || !PROFILES[agent]) return null;
  return path.join(opts.baseDir || path.join(require("./config").CONFIG_DIR, "private-agent-scope"), opts.actorId, opts.channelId, "state", agent);
}
// Delete everything a deleted room left behind (workspace, runs, CLI stores). Never throws; false if anything remains.
function removeRoomScope(opts) {
  try {
    if (!opts || !token(opts.roomId)) return false;
    var base = directory(opts.baseDir || path.join(require("./config").CONFIG_DIR, "private-agent-scope"));
    var target = path.join(base, "room", opts.roomId);
    try { fs.lstatSync(target); } catch (e) { return e.code === "ENOENT"; }
    if (fs.realpathSync(target) !== target) return false;
    return removeTree(target);
  } catch (_) { return false; }
}
function removePrivateClaudeState(opts) { removePrivateState(opts, "claude"); }
function removePrivateCodexState(opts) { removePrivateState(opts, "codex"); }
// Kill the whole sandbox process group (children are spawned detached), then the child itself.
function killTree(child) {
  try { process.kill(-child.pid, "SIGKILL"); } catch (_) {}
  try { child.kill("SIGKILL"); } catch (_) {}
}
// True while a scope holds this workspace (a turn is running in it). Attachment copies into a room workspace wait for it.
function isWorkspaceLive(p) { try { return liveWorkspaces.has(fs.realpathSync(p)); } catch (_) { return liveWorkspaces.has(p); } }
module.exports = { buildLauncher: buildLauncher, isWorkspaceLive: isWorkspaceLive, killTree: killTree, runtimeRootArgs: runtimeRootArgs, resolvBinds: resolvBinds, landlockPrefix: landlockPrefix, landlockAbiArgs: function (python) { return [python, "-I", "-S", "-c", LAUNCHER, "--abi"]; }, privateStatePath: privateStatePath, removeRoomScope: removeRoomScope, preparePrivateAgentScope: preparePrivateAgentScope, probePrivateScope: probePrivateScope,
  isPreparedPrivateScope: function (scope) { return prepared.has(scope); }, removePrivateClaudeState: removePrivateClaudeState, removePrivateCodexState: removePrivateCodexState };

return module.exports;
});

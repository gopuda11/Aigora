"use strict";
// Room skills v1.1: install a skill from a GitHub link (docs/superpowers/specs/2026-10-03-room-skills-plugins.md, git sources).
// An admin pastes a link; the server pins it to an exact commit SHA and reads that commit's tree as DATA ONLY:
//   1. GitHub API (unauthenticated, rate-limit aware) resolves the ref to a commit, then the codeload tarball of that commit is
//      streamed through gunzip + an in-memory tar reader with size caps. Nothing touches the disk.
//   2. If the API is rate limited / unreachable / the archive is too big, `git ls-remote` + a sparse partial fetch of that same
//      commit into a temp dir (hooks off, no prompts, no submodules/LFS, protocol allow-list), read back through the v1 validator.
// Nothing from the repo is ever executed. Only github.com and raw.githubusercontent.com links are accepted; no credentials are
// used or stored. Every candidate goes through validator.validate() unchanged (same rejection rules as ZIP / host installs).
var http = require("http");
var https = require("https");
var zlib = require("zlib");
var os = require("os");
var fs = require("fs");
var path = require("path");
var cp = require("child_process");
var validator = require("./skills-validator");

var ALLOWED_HOSTS = ["github.com", "www.github.com", "raw.githubusercontent.com"];
var MAX = 1024 * 1024;
var DEFAULTS = {
  apiBase: "https://api.github.com",
  codeloadBase: "https://codeload.github.com",
  cloneUrl: function (owner, repo) { return "https://github.com/" + owner + "/" + repo + ".git"; },
  gitBin: "git", gitProtocols: "https", tmpDir: null,
  apiTimeoutMs: 15000, tarballTimeoutMs: 60000, gitTimeoutMs: 60000,
  maxApiBytes: 2 * MAX, maxTarballBytes: 100 * MAX, maxTarBytes: 400 * MAX, maxEntries: 20000, maxRetainedBytes: 96 * MAX,
  maxCloneBytes: 128 * MAX, maxCandidates: 50,
};

function gerr(code, extra) { var e = new Error(code); e.code = code; if (extra) e.detail = extra; return e; }
function cfg(opts) { return Object.assign({}, DEFAULTS, opts || {}); }

// ---- URL parsing ---------------------------------------------------------------------------------------------------

var OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
var REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

// -> { host, owner, repo, kind: "repo"|"tree"|"blob"|"raw", refSegs: [] | null, isFile, repoUrl }.
// For tree/blob/raw the ref and the path share the segments after the repo ("feature/x/skills/foo"); resolution decides the split.
function parseGithubUrl(input) {
  var s = typeof input === "string" ? input.trim() : "";
  if (!s || s.length > 500 || /[\s\x00-\x1f]/.test(s)) throw gerr("git_bad_url");
  var m = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/.exec(s), host, segs, isRaw = false;
  if (m) {
    host = m[1].toLowerCase();
    if (ALLOWED_HOSTS.indexOf(host) === -1) throw gerr("git_host_not_allowed");
    segs = m[2].replace(/[?#].*$/, "").split("/").filter(Boolean);
  } else {
    var u;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = "https://" + s;
    try { u = new URL(s); } catch (_) { throw gerr("git_bad_url"); }
    if (u.protocol !== "https:") throw gerr(u.protocol === "http:" || /^(git|ssh|ftp|file)/.test(u.protocol) ? "git_host_not_allowed" : "git_bad_url");
    host = u.hostname.toLowerCase();
    if (ALLOWED_HOSTS.indexOf(host) === -1) throw gerr("git_host_not_allowed");
    if (u.username || u.password || u.port) throw gerr("git_bad_url");
    try { segs = u.pathname.split("/").filter(Boolean).map(decodeURIComponent); } catch (_) { throw gerr("git_bad_url"); }
  }
  isRaw = host === "raw.githubusercontent.com";
  if (segs.length < 2) throw gerr("git_bad_url");
  var owner = segs[0], repo = segs[1].replace(/\.git$/i, "");
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo === "." || repo === "..") throw gerr("git_bad_url");
  segs.slice(2).forEach(function (p) { if (p === "." || p === ".." || p.indexOf("\\") !== -1 || p.indexOf("\0") !== -1) throw gerr("git_bad_url"); });
  var out = { host: "github.com", owner: owner, repo: repo, kind: "repo", refSegs: null, isFile: false, repoUrl: "https://github.com/" + owner + "/" + repo };
  var rest = segs.slice(2);
  if (isRaw) {
    if (rest[0] === "refs" && (rest[1] === "heads" || rest[1] === "tags")) rest = rest.slice(2);
    if (rest.length < 2 || !/^SKILL\.md$/i.test(rest[rest.length - 1])) throw gerr("git_bad_url");
    out.kind = "raw"; out.refSegs = rest; out.isFile = true;
    return out;
  }
  if (!rest.length) return out;
  if (rest[0] === "tree" || rest[0] === "blob") {
    if (rest.length < 2) throw gerr("git_bad_url");
    out.kind = rest[0]; out.refSegs = rest.slice(1);
    if (rest[0] === "blob") {
      if (out.refSegs.length < 2 || !/^SKILL\.md$/i.test(out.refSegs[out.refSegs.length - 1])) throw gerr("git_bad_url");
      out.isFile = true;
    }
    return out;
  }
  throw gerr("git_bad_url");
}

// Candidate (ref, path) splits of the shared segments, shortest ref first. A file link ends in SKILL.md, which is never part of the path.
function splits(parsed) {
  var segs = parsed.refSegs || [], out = [], max = Math.min(segs.length, 5);
  for (var k = 1; k <= max; k++) {
    var pathSegs = segs.slice(k);
    if (parsed.isFile) { if (!pathSegs.length) break; pathSegs = pathSegs.slice(0, -1); }
    out.push({ ref: segs.slice(0, k).join("/"), path: pathSegs.join("/") });
  }
  return out;
}

// ---- HTTP (async, capped, never follows redirects) -----------------------------------------------------------------------

function httpGet(urlStr, o) {
  return new Promise(function (resolve, reject) {
    var u = new URL(urlStr), mod = u.protocol === "https:" ? https : http, done = false, req = null, timer;
    function finish(err, val) {
      if (done) return;
      done = true; clearTimeout(timer);
      if (err) { try { if (req) req.destroy(); } catch (_) {} reject(err); } else resolve(val);
    }
    timer = setTimeout(function () { finish(gerr("git_timeout")); }, o.timeoutMs);
    req = mod.get(u, { headers: Object.assign({ "User-Agent": "aigora-skills", Accept: "*/*" }, o.headers || {}), agent: false }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400) { res.resume(); return finish(gerr("git_network", "redirect")); }
      if (o.stream && res.statusCode === 200) return o.stream(res, finish);
      var chunks = [], n = 0;
      res.on("data", function (c) { n += c.length; if (n > o.maxBytes) return finish(gerr("git_too_large")); chunks.push(c); });
      res.on("end", function () { finish(null, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }); });
      res.on("error", function () { finish(gerr("git_network")); });
    });
    req.on("error", function () { finish(gerr("git_network")); });
  });
}

function apiJson(c, pathname) {
  return httpGet(c.apiBase + pathname, { timeoutMs: c.apiTimeoutMs, maxBytes: c.maxApiBytes, headers: { Accept: "application/vnd.github+json" } }).then(function (r) {
    if (r.status === 403 || r.status === 429) {
      var limited = r.headers["x-ratelimit-remaining"] === "0" || r.status === 429 || /rate limit/i.test(r.body.toString("utf8", 0, 400));
      throw gerr(limited ? "git_rate_limited" : "git_repo_not_found");
    }
    if (r.status >= 500) throw gerr("git_network", "http " + r.status);
    var body = null;
    try { body = JSON.parse(r.body.toString("utf8")); } catch (_) { body = null; }
    return { status: r.status, body: body };
  });
}
function encRef(ref) { return ref.split("/").map(encodeURIComponent).join("/"); }

// ---- ref -> commit ---------------------------------------------------------------------------------------------------------

// Via the GitHub API. -> { commit, ref, path }.
async function resolveApi(parsed, c) {
  var base = "/repos/" + parsed.owner + "/" + parsed.repo;
  var tries = parsed.refSegs ? splits(parsed) : null;
  if (!tries) {
    var repo = await apiJson(c, base);
    if (repo.status === 404 || !repo.body) throw gerr("git_repo_not_found");
    var def = repo.body.default_branch;
    if (typeof def !== "string" || !def) throw gerr("git_ref_not_found");
    tries = [{ ref: def, path: "" }];
  }
  for (var i = 0; i < tries.length; i++) {
    var r = await apiJson(c, base + "/commits/" + encRef(tries[i].ref));
    if (r.status === 200 && r.body && /^[0-9a-f]{40}$/.test(String(r.body.sha))) return { commit: r.body.sha, ref: tries[i].ref, path: tries[i].path };
    if (r.status !== 404 && r.status !== 422) throw gerr("git_network", "http " + r.status);
  }
  var probe = await apiJson(c, base);
  throw gerr(probe.status === 404 ? "git_repo_not_found" : "git_ref_not_found");
}

// ---- git child processes ---------------------------------------------------------------------------------------------------

function gitEnv(c, home) {
  return { PATH: process.env.PATH || "/usr/bin:/bin", HOME: home, LANG: "C", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false", GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_ALLOW_PROTOCOL: c.gitProtocols, GIT_LFS_SKIP_SMUDGE: "1", GIT_OPTIONAL_LOCKS: "0" };
}
function gitFlags(c) {
  return ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.symlinks=true", "-c", "core.autocrlf=false", "-c", "gc.auto=0",
    "-c", "protocol.file.allow=" + (/(^|:)file(:|$)/.test(c.gitProtocols) ? "always" : "never"), "-c", "submodule.recurse=false", "-c", "fetch.recurseSubmodules=false",
    "-c", "filter.lfs.smudge=", "-c", "filter.lfs.process=", "-c", "filter.lfs.required=false", "-c", "credential.helper=", "-c", "advice.detachedHead=false"];
}
async function dirSize(dir) {
  var total = 0, stack = [dir];
  while (stack.length) {
    var d = stack.pop(), ents;
    try { ents = await fs.promises.readdir(d, { withFileTypes: true }); } catch (_) { continue; }
    for (var i = 0; i < ents.length; i++) {
      var p = path.join(d, ents[i].name);
      if (ents[i].isDirectory()) stack.push(p);
      else { try { total += (await fs.promises.lstat(p)).size; } catch (_) {} }
    }
  }
  return total;
}
// Runs git without a shell. Resolves { code, stdout, stderr }; rejects git_timeout / git_too_large (and kills the whole process group).
function runGit(c, args, o) {
  o = o || {};
  return new Promise(function (resolve, reject) {
    var child, out = [], err = [], outN = 0, done = false, timer, watch;
    function end(e, v) {
      if (done) return;
      done = true; clearTimeout(timer); clearInterval(watch);
      if (e) { try { process.kill(-child.pid, "SIGKILL"); } catch (_) { try { child.kill("SIGKILL"); } catch (_) {} } reject(e); } else resolve(v);
    }
    try {
      child = cp.spawn(c.gitBin, gitFlags(c).concat(o.args || [], args), { cwd: o.cwd, env: gitEnv(c, o.home), stdio: [o.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"], detached: true, shell: false });
    } catch (_) { return reject(gerr("git_failed", "spawn")); }
    timer = setTimeout(function () { end(gerr("git_timeout")); }, o.timeoutMs || c.gitTimeoutMs);
    if (o.watchDir) {
      var busy = false;
      watch = setInterval(function () {
        if (busy) return; busy = true;
        dirSize(o.watchDir).then(function (n) { busy = false; if (n > c.maxCloneBytes) end(gerr("git_too_large")); }, function () { busy = false; });
      }, 200);
    }
    child.stdout.on("data", function (d) { outN += d.length; if (outN > 16 * MAX) return end(gerr("git_too_large")); out.push(d); });
    child.stderr.on("data", function (d) { if (err.length < 64) err.push(d); });
    child.on("error", function () { end(gerr("git_failed", "spawn")); });
    child.on("close", function (code) {
      var res = { code: code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") };
      if (!o.watchDir) return end(null, res);
      dirSize(o.watchDir).then(function (n) { end(n > c.maxCloneBytes ? gerr("git_too_large") : null, res); }, function () { end(null, res); });
    });
    if (o.input !== undefined) { child.stdin.on("error", function () {}); child.stdin.end(o.input); }
  });
}
function gitFailure(r, fallback) {
  if (/not found|could not read username|repository .* does not exist|authentication failed|terminal prompts disabled/i.test(r.stderr)) return gerr("git_repo_not_found");
  if (/couldn't find remote ref|not our ref|unadvertised object|no such remote ref|bad object|invalid object/i.test(r.stderr)) return gerr("git_ref_not_found");
  return gerr(fallback || "git_network", r.stderr.slice(0, 200));
}

// ls-remote: heads and tags (and HEAD's symref) -> { commit, ref, path }.
async function resolveGit(parsed, c) {
  var url = c.cloneUrl(parsed.owner, parsed.repo), tmp = await fs.promises.mkdtemp(path.join(c.tmpDir || os.tmpdir(), "aigora-skillgit-"));
  try {
    var r = await runGit(c, ["ls-remote", "--symref", "--", url], { cwd: tmp, home: tmp, timeoutMs: c.gitTimeoutMs });
    if (r.code !== 0) throw gitFailure(r);
    var heads = {}, tags = {}, peeled = {}, headSha = null, headRef = null;
    r.stdout.toString("utf8").split("\n").forEach(function (line) {
      var m = /^ref: (\S+)\tHEAD$/.exec(line);
      if (m) { headRef = m[1].replace(/^refs\/heads\//, ""); return; }
      m = /^([0-9a-f]{40})\t(\S+)$/.exec(line);
      if (!m) return;
      if (m[2] === "HEAD") headSha = m[1];
      else if (m[2].indexOf("refs/heads/") === 0) heads[m[2].slice(11)] = m[1];
      else if (/\^\{\}$/.test(m[2])) peeled[m[2].slice(10, -3)] = m[1];
      else if (m[2].indexOf("refs/tags/") === 0) tags[m[2].slice(10)] = m[1];
    });
    if (!parsed.refSegs) {
      if (!headSha) throw gerr("git_ref_not_found");
      return { commit: headSha, ref: headRef || "HEAD", path: "", method: "git-sparse" };
    }
    var tries = splits(parsed);
    for (var i = 0; i < tries.length; i++) {
      var ref = tries[i].ref, sha = Object.prototype.hasOwnProperty.call(heads, ref) ? heads[ref] : Object.prototype.hasOwnProperty.call(peeled, ref) ? peeled[ref] : Object.prototype.hasOwnProperty.call(tags, ref) ? tags[ref] : null;
      if (!sha && /^[0-9a-f]{40}$/.test(ref)) sha = ref;
      if (sha) return { commit: sha, ref: ref, path: tries[i].path, method: "git-sparse" };
    }
    throw gerr("git_ref_not_found");
  } finally { await fs.promises.rm(tmp, { recursive: true, force: true }).catch(function () {}); }
}

// ---- tar reader (in memory) -----------------------------------------------------------------------------------------------

function octal(b) {
  if (b[0] & 0x80) return -1;   // base-256 sizes (> 8 GB) are never legitimate here
  var s = b.toString("latin1").replace(/\0.*$/, "").trim();
  return s ? parseInt(s, 8) : 0;
}
function cstr(b) { var i = b.indexOf(0); return b.toString("utf8", 0, i === -1 ? b.length : i); }
function paxPath(buf) {
  var s = buf.toString("utf8"), m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(s);
  return m ? m[1] : null;
}

// feed(chunk) parses ustar/pax/GNU tar. begin(meta) decides whether the body is kept; end(meta, data|null) is called per entry.
function tarReader(c, begin, end) {
  var buf = Buffer.alloc(0), st = "hdr", cur = null, need = 0, keep = false, parts = [], pad = 0, nextName = null, count = 0;
  function emit() {
    var data = keep ? Buffer.concat(parts) : null;
    parts = [];
    var meta = cur; cur = null; nextName = null;
    end(meta, data);
  }
  return function feed(chunk) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (st === "hdr") {
        if (buf.length < 512) return;
        var h = buf.subarray(0, 512); buf = buf.subarray(512);
        if (!h.some(function (x) { return x !== 0; })) continue;
        var size = octal(h.subarray(124, 136));
        if (size < 0 || size > c.maxTarBytes) throw gerr("git_too_large");
        var type = String.fromCharCode(h[156] || 48), name = cstr(h.subarray(0, 100));
        if (h.toString("latin1", 257, 262) === "ustar") { var pre = cstr(h.subarray(345, 500)); if (pre) name = pre + "/" + name; }
        pad = (512 - (size % 512)) % 512;
        if (type === "x" || type === "g" || type === "L" || type === "K") { cur = { meta: type }; need = size; keep = true; parts = []; st = need ? "body" : "pad"; continue; }
        if (++count > c.maxEntries) throw gerr("git_too_large");
        var full = nextName || name;
        var kind = type === "0" || type === "7" || type === "\0" ? "file" : type === "5" ? "dir" : type === "2" ? "symlink" : type === "1" ? "hardlink" : "special";
        cur = { path: cleanPath(full), type: kind, mode: octal(h.subarray(100, 108)) & 0o7777, size: size };
        keep = kind === "file" && begin(cur) === true; need = size; parts = [];
        st = need ? "body" : "pad";
        if (!need) { emit(); st = "hdr"; }
      } else if (st === "body") {
        if (!buf.length) return;
        var n = Math.min(need, buf.length);
        if (keep) parts.push(Buffer.from(buf.subarray(0, n)));
        buf = buf.subarray(n); need -= n;
        if (need) return;
        if (cur && cur.meta) {
          var payload = Buffer.concat(parts); parts = [];
          if (cur.meta === "x") nextName = paxPath(payload) || nextName;
          else if (cur.meta === "L") nextName = cstr(payload);
          cur = null;
        } else emit();
        st = pad ? "pad" : "hdr";
      } else {   // pad
        if (buf.length < pad) return;
        buf = buf.subarray(pad); pad = 0; st = "hdr";
      }
    }
  };
}

function cleanPath(p) {
  var parts = String(p).split("/").filter(function (x) { return x !== "" && x !== "."; });
  if (parts.some(function (x) { return x === ".."; }) || p.charAt(0) === "/") throw gerr("git_bad_archive");
  return parts.slice(1).join("/");   // codeload wraps everything in <repo>-<sha>/
}

// Streams the commit's tarball into [{ path, type, mode, size, data? }]. Files up to the per-file cap under `scope` keep their bytes.
function fetchTarball(c, parsed, commit, scope) {
  var url = c.codeloadBase + "/" + parsed.owner + "/" + parsed.repo + "/tar.gz/" + commit;
  var files = [], retained = 0, inflated = 0, raw = 0;
  var prefix = scope ? scope + "/" : "";
  function inScope(p) { return !scope || p === scope || p.indexOf(prefix) === 0; }
  return httpGet(url, { timeoutMs: c.tarballTimeoutMs, maxBytes: c.maxTarballBytes, headers: { Accept: "application/x-gzip" }, stream: function (res, finish) {
    var gunzip = zlib.createGunzip(), feed = tarReader(c, function (m) {
      if (!m.path || m.size > validator.LIMITS.fileBytes || !inScope(m.path) || retained + m.size > c.maxRetainedBytes) return false;
      retained += m.size;
      return true;
    }, function (m, data) {
      var p = m.path; if (!p) return;
      var e = { path: p, type: m.type, mode: m.mode, size: m.size };
      if (data) e.data = data;
      files.push(e);
    });
    var failed = false;
    function bail(e) { if (failed) return; failed = true; try { res.destroy(); gunzip.destroy(); } catch (_) {} finish(e instanceof Error && e.code ? e : gerr("git_network")); }
    res.on("data", function (d) { raw += d.length; if (raw > c.maxTarballBytes) bail(gerr("git_too_large")); });
    res.on("error", function () { bail(gerr("git_network")); });
    gunzip.on("data", function (d) {
      if (failed) return;
      inflated += d.length;
      if (inflated > c.maxTarBytes) return bail(gerr("git_too_large"));
      try { feed(d); } catch (e) { bail(e); }
    });
    gunzip.on("end", function () { if (!failed) finish(null, { status: 200, files: files }); });
    gunzip.on("error", function () { bail(gerr("git_bad_archive")); });
    res.pipe(gunzip);
  } }).then(function (r) {
    if (r.status === 404) throw gerr("git_repo_not_found");
    if (r.status !== 200) throw gerr("git_network", "http " + r.status);
    return r.files;
  });
}

// ---- scanning --------------------------------------------------------------------------------------------------------------

var SKIP_DIRS = ["node_modules", ".git", "hooks", "commands", "agents"];
var ROOT_NOISE = /^(\.github|\.gitignore|\.gitattributes)$/;

// Directories holding SKILL.md, limited to `scope` (a skill dir, or a folder to search). -> sorted dir list ("" is the repo root).
function findSkillDirs(files, scope) {
  var dirs = [];
  files.forEach(function (f) {
    if (f.type !== "file" && f.type !== "symlink") return;
    var i = f.path.lastIndexOf("/"), base = f.path.slice(i + 1), dir = i === -1 ? "" : f.path.slice(0, i);
    if (base !== "SKILL.md") return;
    if (dir.split("/").some(function (s) { return SKIP_DIRS.indexOf(s) !== -1; })) return;
    dirs.push(dir);
  });
  dirs.sort();
  if (!scope) return dirs;
  if (dirs.indexOf(scope) !== -1) return [scope];
  return dirs.filter(function (d) { return d.indexOf(scope + "/") === 0; });
}
function pathExists(files, scope) {
  return !scope || files.some(function (f) { return f.path === scope || f.path.indexOf(scope + "/") === 0; });
}

// Claude plugins in the tree and the parts of each that are not skills (they are ignored, never read).
function findPlugins(files, scope) {
  var dirs = {};
  files.forEach(function (f) {
    var m = /^(?:(.*)\/)?\.claude-plugin\/(?:plugin|marketplace)\.json$/.exec(f.path);
    if (m) dirs[m[1] || ""] = true;
  });
  return Object.keys(dirs).sort().filter(function (d) {
    return !scope || !d || scope === d || scope.indexOf(d + "/") === 0 || d.indexOf(scope + "/") === 0;
  }).map(function (d) {
    var pre = d ? d + "/" : "", ignored = [];
    function has(test) { return files.some(function (f) { return f.path.indexOf(pre) === 0 && test(f.path.slice(pre.length)); }); }
    if (has(function (p) { return /^hooks(\/|$)/.test(p); })) ignored.push("hooks");
    if (has(function (p) { return /^commands\//.test(p); })) ignored.push("commands");
    if (has(function (p) { return /^agents\//.test(p); })) ignored.push("agents");
    if (has(function (p) { return /^\.?mcp\.json$/.test(p); })) ignored.push("mcp");
    return { dir: d, ignored: ignored };
  });
}

function titleOf(dir, repo) { return dir ? dir.split("/").pop() : repo; }

// Validates one candidate's entries (relative to the skill dir). `extra` are errors found while reading.
function checkEntries(entries, extra) {
  var r = validator.validate(entries);
  if (!extra.length) return r;
  return { ok: false, errors: extra.concat(r.ok ? [] : r.errors).slice(0, 30) };
}
function memoryReader(files) {
  return function (dir) {
    var pre = dir ? dir + "/" : "", entries = [], extra = [];
    files.forEach(function (f) {
      if (pre && f.path.indexOf(pre) !== 0) return;
      var rel = f.path.slice(pre.length);
      if (!dir && ROOT_NOISE.test(rel.split("/")[0])) return;
      if (f.type === "file") {
        if (f.size > validator.LIMITS.fileBytes) { extra.push({ code: "file_too_large", path: rel }); return; }
        if (!f.data) { extra.push({ code: "total_too_large", path: rel }); return; }
        entries.push({ path: rel, type: "file", mode: f.mode, data: f.data || Buffer.alloc(0) });
      } else entries.push({ path: rel, type: f.type, mode: f.mode });
    });
    return checkEntries(entries, extra);
  };
}
function diskReader(root, files) {
  return function (dir) {
    var abs = path.join(root, dir), r = validator.readDir(abs);
    if (r.errors && r.errors.length) return { ok: false, errors: r.errors };
    var extra = [], entries = r.entries.filter(function (e) { return dir || !ROOT_NOISE.test(e.path.split("/")[0]); });
    var pre = dir ? dir + "/" : "";
    files.forEach(function (f) { if (f.type === "special" && (!pre || f.path.indexOf(pre) === 0)) extra.push({ code: "special_file", path: f.path.slice(pre.length) }); });
    return checkEntries(entries, extra);
  };
}

function summarize(dirs, read, repo) {
  var out = [], skills = {};
  dirs.slice(0, 50).forEach(function (dir) {
    var r = read(dir);
    var c = { path: dir, ok: !!r.ok, errors: r.ok ? [] : r.errors, name: r.ok ? r.skill.name : titleOf(dir, repo), description: r.ok ? r.skill.description : "",
      files: r.ok ? r.skill.files.length : 0, size: r.ok ? r.skill.size : 0, lint: r.ok ? r.skill.lint : [] };
    if (r.ok) skills[dir] = r.skill;
    out.push(c);
  });
  return { candidates: out, skills: skills };
}

// ---- clone fallback -----------------------------------------------------------------------------------------------------------

// Fetches exactly `commit` (depth 1, blobs on demand), lists its tree, checks out only the skill dirs and validates them from disk.
async function scanViaGit(parsed, commit, scope, c, tick) {
  var tmp = await fs.promises.mkdtemp(path.join(c.tmpDir || os.tmpdir(), "aigora-skillgit-"));
  try {
    var gd = path.join(tmp, "g"), wt = path.join(tmp, "w");
    await fs.promises.mkdir(wt);
    var o = { cwd: tmp, home: tmp, args: ["--git-dir=" + gd, "--work-tree=" + wt] };
    var url = c.cloneUrl(parsed.owner, parsed.repo);
    async function git(args, extra) {
      var r = await runGit(c, args, Object.assign({}, o, extra || {}));
      if (r.code !== 0) throw gitFailure(r, "git_failed");
      return r;
    }
    await git(["init", "-q"]);
    await git(["remote", "add", "origin", url]);
    await git(["fetch", "-q", "--depth=1", "--filter=blob:none", "--no-tags", "--no-recurse-submodules", "origin", commit], { watchDir: tmp });
    var ls = await git(["ls-tree", "-r", "-z", "FETCH_HEAD"]);
    var files = [];
    ls.stdout.toString("utf8").split("\0").forEach(function (rec) {
      var m = /^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]+)$/.exec(rec);
      if (!m) return;
      files.push({ path: m[4], mode: parseInt(m[1], 8) & 0o777, type: m[1] === "120000" ? "symlink" : m[2] === "commit" ? "special" : "file", size: 0 });
    });
    if (files.length > c.maxEntries) throw gerr("git_too_large");
    if (!pathExists(files, scope)) throw gerr("git_path_not_found");
    var dirs = findSkillDirs(files, scope);
    if (tick) tick("scan");
    if (dirs.length) {
      var patterns = dirs.slice(0, c.maxCandidates).map(function (d) {
        if (/[*?\[\]\\!#]/.test(d)) return null;
        return d ? "/" + d + "/" : "/*";
      }).filter(Boolean);
      await git(["sparse-checkout", "set", "--no-cone", "--stdin"], { input: patterns.join("\n") + "\n" });
      await git(["checkout", "-q", "--detach", "FETCH_HEAD"], { watchDir: tmp });
    }
    var out = summarize(dirs, diskReader(wt, files), parsed.repo);
    return { files: files, dirs: dirs, scan: out };
  } finally { await fs.promises.rm(tmp, { recursive: true, force: true }).catch(function () {}); }
}

// ---- public: fetch a link --------------------------------------------------------------------------------------------------------

var FALLBACK = { git_rate_limited: 1, git_network: 1, git_timeout: 1, git_too_large: 1, git_bad_archive: 1 };

function sourceOf(parsed, resolved, method) {
  return { kind: "git", host: "github.com", repo: parsed.owner + "/" + parsed.repo, url: parsed.repoUrl + (resolved.path ? "/tree/" + resolved.commit + "/" + resolved.path : "/tree/" + resolved.commit),
    ref: resolved.ref, commit: resolved.commit, path: resolved.path, fetched_at: Date.now(), method: method };
}

// parsed (from parseGithubUrl) + an already known { commit, ref, path } (or null to resolve) -> { source, candidates, skills, plugins }.
async function fetchResolved(parsed, resolved, opts, progress) {
  var c = cfg(opts), tick = typeof progress === "function" ? progress : function () {};
  if (!resolved) {
    tick("resolve");
    try { resolved = await resolveApi(parsed, c); }
    catch (e) { if (!FALLBACK[e.code]) throw e; resolved = await resolveGit(parsed, c); }
  }
  var method = resolved.method || "api-tarball";
  tick("fetch");
  var files, dirs, scan;
  if (method === "api-tarball") {
    try {
      files = await fetchTarball(c, parsed, resolved.commit, resolved.path);
      if (!pathExists(files, resolved.path)) throw gerr("git_path_not_found");
      tick("scan");
      dirs = findSkillDirs(files, resolved.path);
      scan = summarize(dirs, memoryReader(files), parsed.repo);
    } catch (e) { if (!FALLBACK[e.code]) throw e; method = "git-sparse"; }
  }
  if (method === "git-sparse") {
    var g = await scanViaGit(parsed, resolved.commit, resolved.path, c, tick);
    files = g.files; dirs = g.dirs; scan = g.scan;
  }
  if (!dirs.length) throw gerr("git_no_skill");
  return { source: sourceOf(parsed, resolved, method), candidates: scan.candidates, skills: scan.skills, plugins: findPlugins(files, resolved.path), truncated: dirs.length > 50 };
}
async function fetchLink(url, opts, progress) { return fetchResolved(parseGithubUrl(url), null, opts, progress); }

// Latest commit of the source's own ref, then (if it moved) that commit's version of the same skill dir.
// -> { upToDate } | { upToDate:false, commit, source, candidate, skill }
async function checkUpdate(source, opts, progress) {
  if (!source || source.kind !== "git" || typeof source.repo !== "string") throw gerr("not_git_source");
  var c = cfg(opts), m = /^([^/]+)\/([^/]+)$/.exec(source.repo);
  if (!m) throw gerr("not_git_source");
  var parsed = { owner: m[1], repo: m[2], repoUrl: "https://github.com/" + source.repo, refSegs: [source.ref], isFile: false, kind: "tree" };
  var tick = typeof progress === "function" ? progress : function () {};
  tick("resolve");
  var latest;
  try { latest = await resolveApi(parsed, c); } catch (e) { if (!FALLBACK[e.code]) throw e; latest = await resolveGit(parsed, c); }
  if (latest.commit === source.commit) return { upToDate: true, commit: latest.commit };
  var r = await fetchResolved(parsed, { commit: latest.commit, ref: source.ref, path: source.path || "", method: latest.method }, c, progress);
  var cand = r.candidates.filter(function (x) { return x.path === (source.path || ""); })[0];
  if (!cand) throw gerr("git_path_not_found");
  return { upToDate: false, commit: latest.commit, source: r.source, candidate: cand, skill: r.skills[cand.path] || null };
}

// Pinned re-fetch (the exact commit a check showed): never resolves a ref again.
function fetchPinned(source, opts, progress) {
  var m = /^([^/]+)\/([^/]+)$/.exec(String(source.repo));
  if (!m || !/^[0-9a-f]{40}$/.test(String(source.commit))) return Promise.reject(gerr("not_git_source"));
  var parsed = { owner: m[1], repo: m[2], repoUrl: "https://github.com/" + source.repo, refSegs: [source.ref], isFile: false, kind: "tree" };
  return fetchResolved(parsed, { commit: source.commit, ref: source.ref, path: source.path || "", method: source.method === "git-sparse" ? "git-sparse" : undefined }, opts, progress);
}

// File-level summary between the approved texts [{path,text}] and the new files [{path,data}].
// Binary assets have no text: they count as added/removed by path (oldFiles = approved [{path}]); a changed binary shows in the sha only.
function diffSummary(oldTexts, newFiles, oldFiles) {
  var before = {}, after = {}, out = { added: [], removed: [], changed: [] }, oldPaths = {}, newBin = {};
  (oldTexts || []).forEach(function (t) { before[t.path] = t.text; });
  (oldFiles || []).forEach(function (f) { oldPaths[f.path] = true; });
  (newFiles || []).forEach(function (f) {
    if (validator.kindOfPath(f.path) === "binary") { newBin[f.path] = true; if (!oldPaths[f.path]) out.added.push(f.path); return; }
    after[f.path] = f.data.toString("utf8");
  });
  Object.keys(oldPaths).sort().forEach(function (p) { if (validator.kindOfPath(p) === "binary" && !newBin[p]) out.removed.push(p); });
  Object.keys(after).sort().forEach(function (p) {
    if (!Object.prototype.hasOwnProperty.call(before, p)) { out.added.push(p); return; }
    if (before[p] === after[p]) return;
    var a = before[p].split("\n"), b = after[p].split("\n"), seen = Object.create(null), plus = 0, minus = 0;
    a.forEach(function (l) { seen[l] = (seen[l] || 0) + 1; });
    b.forEach(function (l) { if (seen[l] > 0) seen[l]--; else plus++; });
    minus = Object.keys(seen).reduce(function (n, k) { return n + seen[k]; }, 0);
    out.changed.push({ path: p, plus: plus, minus: minus });
  });
  Object.keys(before).sort().forEach(function (p) { if (!Object.prototype.hasOwnProperty.call(after, p)) out.removed.push(p); });
  return out;
}

module.exports = { DEFAULTS: DEFAULTS, parseGithubUrl: parseGithubUrl, splits: splits, fetchLink: fetchLink, fetchPinned: fetchPinned,
  checkUpdate: checkUpdate, diffSummary: diffSummary };

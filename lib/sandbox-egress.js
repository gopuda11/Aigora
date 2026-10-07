"use strict";
// Host-side egress proxy for a sandbox with its own network namespace (docs/superpowers/specs/2026-10-04-private-execution-completion-design.md
// section 3). One instance per scope, listening on a unix socket that is bound into the sandbox; the in-sandbox
// forwarder (127.0.0.1:3128) pipes every connection to it. Policy lives here and nowhere else:
//   - CONNECT host:port with port in `ports` (443) and a DNS NAME only (no IP literals);
//   - every resolved address must be public. IPv6 policy: IPv4-only by default (AAAA answers are ignored; a name with
//     no IPv4 answer is refused). With `egressIPv6: true` only global unicast 2000::/3 is allowed; 64:ff9b::/96,
//     64:ff9b:1::/48, mapped/compatible, 6to4-to-private, Teredo and documentation ranges stay refused, and any
//     `nat64Prefixes` ("P::/96" strings) of the host are decoded and their embedded IPv4 gets the IPv4 rules. A globally
//     routed NAT64 prefix cannot be recognised unless configured, so keep IPv6 off on NAT64 networks; the connection goes to the pinned (already checked) address;
//   - mode "public" (any public host) or "providers" (model providers only);
//   - caps: concurrent tunnels, total bytes, idle time, and open sockets from the moment of accept (header deadline too);
//   - absolute-form http://broker.aigora.internal/... requests go to an optional broker callback.
// The log holds counts and host names only: never paths, headers, bodies or credentials. Nothing is sent to clients but status lines.
var fs = require("fs");
var net = require("net");
var http = require("http");
var dns = require("dns");

var BROKER_HOST = "broker.aigora.internal";
var PROBE_HOST = "probe.aigora.invalid";
// Exact list confirmed by the spike (claude 2.1.173/2.1.289, codex 0.160): api.anthropic.com, platform.claude.com,
// api.openai.com, auth.openai.com, chatgpt.com, ab.chatgpt.com.
var PROVIDER_DOMAINS = ["anthropic.com", "claude.ai", "claude.com", "openai.com", "chatgpt.com"];
// Names that never leave the sandbox policy: the probe host and internal/local namespaces.
var REFUSED_SUFFIXES = [".invalid", ".internal", ".local", ".localhost", ".lan", ".home.arpa", ".test", ".example"];
var DEFAULTS = { maxConnections: 64, maxBytes: 2 * 1024 * 1024 * 1024, idleMs: 10 * 60 * 1000, connectMs: 15000, lookupMs: 10000, headerMs: 10000, ports: [443] };

// ---- address policy -------------------------------------------------------------------------------------------

function v4Parts(ip) { return ip.split(".").map(Number); }
function v4Blocked(ip) {
  var p = v4Parts(ip), a = p[0], b = p[1], c = p[2];
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) || (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
}
// Eight 16-bit groups of an IPv6 text address (embedded dotted IPv4 supported); null when malformed.
function v6Groups(ip) {
  ip = ip.split("%")[0];
  var m = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (m) {
    if (net.isIPv4(m[2]) === false) return null;
    var q = v4Parts(m[2]);
    ip = m[1] + ((q[0] << 8) | q[1]).toString(16) + ":" + ((q[2] << 8) | q[3]).toString(16);
  }
  var halves = ip.split("::");
  if (halves.length > 2) return null;
  var head = halves[0] ? halves[0].split(":") : [], rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  var fill = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 1) return null;
  var all = head.concat(new Array(halves.length === 2 ? fill : 0).fill("0"), rest);
  var g = all.map(function (x) { return /^[0-9a-fA-F]{1,4}$/.test(x) ? parseInt(x, 16) : NaN; });
  return g.length === 8 && g.every(function (x) { return x >= 0; }) ? g : null;
}
function embeddedV4(hi, lo) { return (hi >> 8) + "." + (hi & 255) + "." + (lo >> 8) + "." + (lo & 255); }
// "P::/96" -> six 16-bit groups, or null when it is not a /96 prefix.
function parsePrefix96(x) {
  var m = /^(.+)\/96$/.exec(String(x));
  var g = m && v6Groups(m[1]);
  return g && g[6] === 0 && g[7] === 0 ? g.slice(0, 6) : null;
}
// True when the address must never be reached from a sandbox. Anything unparsable is blocked.
// o: { ipv6: allow global unicast IPv6 (default false), nat64Prefixes: ["P::/96", ...] }
function isBlockedAddress(ip, o) {
  o = o || {};
  if (typeof ip !== "string") return true;
  var kind = net.isIP(ip.split("%")[0]);
  if (kind === 4) return v4Blocked(ip);
  if (kind !== 6 || o.ipv6 !== true) return true;
  var g = v6Groups(ip);
  if (!g) return true;
  var prefixes = Array.isArray(o.nat64Prefixes) ? o.nat64Prefixes.map(parsePrefix96) : [];
  if (prefixes.some(function (p) { return p === null; })) return true; // a bad configured prefix fails closed
  for (var k = 0; k < prefixes.length; k++) {
    if (prefixes[k].every(function (x, n) { return x === g[n]; })) return v4Blocked(embeddedV4(g[6], g[7]));
  }
  var first = g[0];
  if ((first & 0xe000) !== 0x2000) return true; // outside 2000::/3: mapped, compatible, 64:ff9b::/96, 64:ff9b:1::/48, ULA, link-local, multicast...
  if (first === 0x2002) return v4Blocked(embeddedV4(g[1], g[2])); // 6to4
  if (first === 0x2001 && g[1] < 0x200) return true; // 2001::/23 IETF protocol assignments (Teredo, ...)
  if (first === 0x2001 && g[1] === 0xdb8) return true; // documentation
  if (first === 0x3fff && g[1] < 0x1000) return true; // documentation 3fff::/20
  return false;
}

// ---- host names -----------------------------------------------------------------------------------------------

// A normalised DNS name or null. IP literals (including inet_aton shorthand such as 2130706433 or 0x7f.1) are refused.
function dnsName(host) {
  if (typeof host !== "string") return null;
  var h = host.toLowerCase();
  if (h.charAt(h.length - 1) === ".") h = h.slice(0, -1);
  if (!h || h.length > 253 || net.isIP(h) !== 0) return null;
  var labels = h.split(".");
  if (labels.length < 2) return null;
  if (!labels.every(function (l) { return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l); })) return null;
  if (/^(0x[0-9a-f]*|[0-9]+)$/.test(labels[labels.length - 1])) return null;
  return h;
}
function suffixRefused(h) { return REFUSED_SUFFIXES.some(function (s) { return h.length > s.length && h.slice(-s.length) === s; }); }
function isProvider(h) { return PROVIDER_DOMAINS.some(function (d) { return h === d || h.slice(-(d.length + 1)) === "." + d; }); }

// ---- the proxy ------------------------------------------------------------------------------------------------

// opts: { path, mode: "public"|"providers", broker?: {handleBrokerRequest(req,res)}, label, log(line),
//   maxConnections, maxBytes, idleMs, ports, lookup(host, cb) [tests], connect(addr, port) [tests] }
// Resolves to { path, close() -> void, stats() }.
function createEgress(opts) {
  opts = opts || {};
  if (typeof opts.path !== "string" || opts.path.indexOf("\0") !== -1) throw new Error("invalid_egress_path");
  var mode = opts.mode === "providers" ? "providers" : "public";
  var maxConnections = Number.isInteger(opts.maxConnections) && opts.maxConnections > 0 ? opts.maxConnections : DEFAULTS.maxConnections;
  var maxBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : DEFAULTS.maxBytes;
  var idleMs = Number.isFinite(opts.idleMs) && opts.idleMs > 0 ? opts.idleMs : DEFAULTS.idleMs;
  var ports = Array.isArray(opts.ports) && opts.ports.length ? opts.ports : DEFAULTS.ports;
  var lookup = opts.lookup || function (host, cb) { dns.lookup(host, { all: true, verbatim: true }, cb); };
  var log = typeof opts.log === "function" ? opts.log : function () {};
  var label = String(opts.label || "scope").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64);
  var broker = opts.broker && typeof opts.broker.handleBrokerRequest === "function" ? opts.broker : null;
  var maxSockets = Number.isInteger(opts.maxSockets) && opts.maxSockets > 0 ? opts.maxSockets : maxConnections * 2 + 16;
  var headerMs = Number.isFinite(opts.headerMs) && opts.headerMs > 0 ? opts.headerMs : DEFAULTS.headerMs;
  var connectMs = Number.isFinite(opts.connectMs) && opts.connectMs > 0 ? opts.connectMs : DEFAULTS.connectMs;
  var addrPolicy = { ipv6: opts.egressIPv6 === true, nat64Prefixes: Array.isArray(opts.nat64Prefixes) ? opts.nat64Prefixes : [] };
  var tunnels = new Set(), requests = new Set(), sockets = new Set();
  var st = { opened: 0, denied: 0, bytes: 0, hosts: new Map(), closed: false, overBytes: false };
  var server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 30000, headersTimeout: 15000, keepAliveTimeout: 1000 });
  server.maxHeadersCount = 64;

  function noteHost(h) { if (st.hosts.size < 200 || st.hosts.has(h)) st.hosts.set(h, (st.hosts.get(h) || 0) + 1); }
  function deny(socket, code, text) {
    st.denied++;
    try { socket.end("HTTP/1.1 " + code + " " + text + "\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); } catch (_) { try { socket.destroy(); } catch (e) {} }
  }
  function addBytes(n) {
    st.bytes += n;
    if (st.bytes > maxBytes && !st.overBytes) {
      st.overBytes = true;
      tunnels.forEach(function (t) { t.destroy(); });
    }
  }
  function track(a, b) {
    var pair = { destroy: function () { try { a.destroy(); } catch (_) {} try { b.destroy(); } catch (_) {} } };
    tunnels.add(pair);
    var done = false;
    function end() { if (done) return; done = true; tunnels.delete(pair); pair.destroy(); }
    [a, b].forEach(function (s) {
      s.setTimeout(idleMs, end); s.on("close", end); s.on("error", end);
      s.on("data", function (c) { addBytes(c.length); });
    });
    return end;
  }
  // One cancellable operation per CONNECT: holds the lookup, the upstream socket and the timers. It stays in `tunnels`
  // (and so counts against the cap) until the lookup has returned and the upstream socket is closed.
  function newOp(client) {
    var op = { cancelled: false, lookupPending: true, upstream: null, timer: null, released: false };
    function maybeRelease() {
      if (op.released || op.lookupPending || (op.upstream && !op.upstream.closed)) return; // wait for lookup and socket close
      op.released = true; tunnels.delete(op);
    }
    op.release = function () { op.upstream = null; op.released = true; tunnels.delete(op); }; // handed over to track() or denied
    op.lookupDone = function () { op.lookupPending = false; if (op.cancelled) maybeRelease(); };
    op.cancel = function () {
      if (op.cancelled) return; op.cancelled = true;
      clearTimeout(op.timer);
      var u = op.upstream;
      if (u) { try { u.destroy(); } catch (_) {} if (!u.closed) u.once("close", maybeRelease); }
      maybeRelease();
    };
    op.destroy = function () { op.cancel(); try { client.destroy(); } catch (_) {} };
    return op;
  }
  function pinned(op, addrs, port, cb) {
    var i = 0;
    (function next() {
      if (op.cancelled) return cb(new Error("cancelled"));
      if (i >= addrs.length || i >= 4) return cb(new Error("connect_failed"));
      var addr = addrs[i++].address, over = false;
      var s = opts.connect ? opts.connect(addr, port) : net.connect({ host: addr, port: port, family: net.isIPv6(addr) ? 6 : 4 });
      op.upstream = s;
      function fail() { if (over) return; over = true; clearTimeout(op.timer); s.destroy(); next(); }
      op.timer = setTimeout(fail, connectMs);
      s.once("error", fail);
      s.once("connect", function () {
        if (over) return; over = true; clearTimeout(op.timer); s.removeAllListeners("error");
        if (op.cancelled) { s.destroy(); return cb(new Error("cancelled")); }
        cb(null, s);
      });
    })();
  }

  server.on("connect", function (req, client, head) {
    client.on("error", function () {});
    if (client._egressHeaderDone) client._egressHeaderDone();
    if (st.closed) return deny(client, 503, "Service Unavailable");
    var m = /^([^\s:\[\]\/@?#]+):(\d{1,5})$/.exec(String(req.url || ""));
    var host = m && dnsName(m[1]), port = m && Number(m[2]);
    if (!host || !ports.includes(port) || (suffixRefused(host) && host !== PROBE_HOST)) return deny(client, 403, "Forbidden");
    if (host === PROBE_HOST) {
      // Answered here, never resolved or connected: lets the sandbox prove the whole path to this policy engine.
      noteHost(host); st.opened++;
      try { client.end("HTTP/1.1 200 Connection Established\r\n\r\n!"); } catch (_) {}
      return;
    }
    if (mode === "providers" && !isProvider(host)) return deny(client, 403, "Forbidden");
    if (st.overBytes || tunnels.size >= maxConnections) return deny(client, 429, "Too Many Requests");
    var op = newOp(client);
    tunnels.add(op); // reserved while resolving/connecting so a burst cannot exceed the cap
    client.once("close", op.cancel);
    // A CONNECT socket is not read by anything until it is piped, so an EOF would go unnoticed. Read (and buffer, bounded)
    // while resolving/connecting so a disconnect cancels the operation promptly.
    var early = [], earlyLen = 0;
    function onEarly(c) { earlyLen += c.length; if (earlyLen > 65536) return client.destroy(); early.push(c); }
    client.on("data", onEarly);
    function onEarlyEnd() { client.destroy(); } // half-open (allowHalfOpen) before the tunnel exists: nothing to keep
    client.once("end", onEarlyEnd);
    var answered = false;
    var timer = setTimeout(function () {
      if (answered) return; answered = true; op.lookupDone();
      if (!op.cancelled) { op.cancel(); deny(client, 504, "Gateway Timeout"); }
    }, DEFAULTS.lookupMs);
    lookup(host, function (err, addrs) {
      if (answered) return; answered = true; clearTimeout(timer); op.lookupDone();
      if (op.cancelled || client.destroyed) { op.cancel(); return; }
      if (err || !Array.isArray(addrs) || !addrs.length) { op.cancel(); return deny(client, 502, "Bad Gateway"); }
      // IPv4-only unless egressIPv6: AAAA answers are never connected to, so they are ignored rather than refusing the name.
      if (!addrPolicy.ipv6) addrs = addrs.filter(function (a) { return !(a && typeof a.address === "string" && net.isIPv6(a.address.split("%")[0])); });
      // Every remaining answer is checked, not just the one used: a mixed answer (public + private) is refused outright.
      if (!addrs.length || addrs.some(function (a) { return isBlockedAddress(a && a.address, addrPolicy); })) { op.cancel(); return deny(client, 403, "Forbidden"); }
      pinned(op, addrs, port, function (e, upstream) {
        if (e || op.cancelled || client.destroyed) {
          try { upstream && upstream.destroy(); } catch (_) {}
          var was = op.cancelled; op.cancel();
          return e && !was ? deny(client, 502, "Bad Gateway") : undefined;
        }
        op.release();
        noteHost(host); st.opened++;
        client.setTimeout(0);
        client.removeListener("data", onEarly); client.removeListener("end", onEarlyEnd);
        track(client, upstream);
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head && head.length) upstream.write(head);
        if (early.length) upstream.write(Buffer.concat(early));
        client.pipe(upstream); upstream.pipe(client);
      });
    });
  });

  server.on("request", function (req, res) {
    req.on("error", function () {});
    if (req.socket && req.socket._egressHeaderDone) req.socket._egressHeaderDone();
    var u = null;
    try { if (/^http:\/\//i.test(req.url || "")) u = new URL(req.url); } catch (_) {}
    function refuse(code, text) { st.denied++; try { res.writeHead(code, { "Content-Length": 0, Connection: "close" }); res.end(); } catch (_) {} }
    if (!u || u.hostname.toLowerCase() !== BROKER_HOST || st.closed) return refuse(403, "Forbidden");
    if (!broker) return refuse(404, "Not Found");
    if (requests.size >= maxConnections) return refuse(429, "Too Many Requests");
    requests.add(res); res.on("close", function () { requests.delete(res); });
    noteHost(BROKER_HOST);
    try { Promise.resolve(broker.handleBrokerRequest(req, res)).catch(function () { if (!res.headersSent) refuse(502, "Bad Gateway"); else res.destroy(); }); }
    catch (_) { if (!res.headersSent) refuse(502, "Bad Gateway"); else res.destroy(); }
  });
  server.on("clientError", function (_e, socket) { try { socket.destroy(); } catch (e) {} });
  server.on("error", function () {});
  // Every accepted socket counts from the moment of accept: over the cap it is destroyed at once; it must deliver a
  // complete request head within headerMs (no matter how slowly it trickles) and is idle-limited afterwards.
  server.on("connection", function (s) {
    s.on("error", function () {});
    if (st.closed || sockets.size >= maxSockets) { st.denied++; try { s.destroy(); } catch (_) {} return; }
    sockets.add(s);
    var headerTimer = setTimeout(function () { try { s.destroy(); } catch (_) {} }, headerMs);
    s.setTimeout(idleMs, function () { try { s.destroy(); } catch (_) {} });
    s.once("close", function () { clearTimeout(headerTimer); sockets.delete(s); });
    s._egressHeaderDone = function () { clearTimeout(headerTimer); };
  });

  return new Promise(function (resolve, reject) {
    function onListenError(e) { reject(e); }
    server.once("error", onListenError);
    server.listen(opts.path, function () {
      server.removeListener("error", onListenError);
      try { fs.chmodSync(opts.path, 0o600); } catch (e) { server.close(); return reject(e); }
      // A forgotten scope must never keep the daemon (or a test process) alive: the listener alone is not a reason to stay up.
      server.unref();
      var closed = false;
      resolve({
        path: opts.path,
        mode: mode,
        resetStats: function () { st.opened = 0; st.denied = 0; st.bytes = 0; st.hosts.clear(); st.overBytes = false; },
        stats: function () { return { opened: st.opened, denied: st.denied, bytes: st.bytes, active: tunnels.size, sockets: sockets.size, hosts: Array.from(st.hosts.entries()) }; },
        close: function () {
          if (closed) return; closed = true; st.closed = true;
          tunnels.forEach(function (t) { t.destroy(); });
          sockets.forEach(function (x) { try { x.destroy(); } catch (_) {} });
          requests.forEach(function (r) { try { r.destroy(); } catch (_) {} });
          try { server.close(); } catch (_) {}
          try { if (server.closeAllConnections) server.closeAllConnections(); } catch (_) {}
          try { fs.unlinkSync(opts.path); } catch (_) {}
          var hosts = Array.from(st.hosts.entries()).map(function (e) { return e[0] + ":" + e[1]; }).join(",");
          if (st.opened || st.denied) try { log("[sandbox-egress] " + label + " mode=" + mode + " tunnels=" + st.opened + " denied=" + st.denied + " bytes=" + st.bytes + (hosts ? " hosts=" + hosts : "")); } catch (_) {}
        },
      });
    });
  });
}

module.exports = { createEgress: createEgress, isBlockedAddress: isBlockedAddress, dnsName: dnsName, isProvider: isProvider,
  BROKER_HOST: BROKER_HOST, PROBE_HOST: PROBE_HOST, PROVIDER_DOMAINS: PROVIDER_DOMAINS.slice(), DEFAULTS: Object.assign({}, DEFAULTS) };

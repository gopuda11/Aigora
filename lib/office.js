// office.js - real-time Office co-editing through an ONLYOFFICE Document Server (DS).
//
// Topology (docker port publishing does not work on this host, see scripts/aigora-office.sh):
//   browser -> Aigora (/p/<slug>/office/web/**, authenticated proxy incl. WebSocket) -> DS (office.dsUrl)
//   DS -> Aigora second listener (office.callbackHost:office.callbackPort) (download + save callback only), never the public port.
//
// Authority never lives in a URL for longer than needed: the editor config is signed per user and
// short-lived, the download URL carries a 2-minute docToken, every proxied request is re-judged
// against the live membership, and an access change kills the user's proxied sockets at once
// (DS `drop` is sent too, but the spike showed it does not close the socket).

var http = require("http");
var fs = require("fs");
var path = require("path");
var jwt = require("./office-jwt");
var { OFFICE_LIMITS, DOWNLOAD_ONLY, CO_EDIT } = require("./room-attachments");

// Generic defaults matching scripts/aigora-office.sh (docker network 10.77.77.0/24: gateway .1, DS .10).
// A host with another subnet sets office.dsUrl / office.callbackHost in daemon.json (docs/office-coediting.md).
var BRIDGE_HOST = "10.77.77.1";
var DEFAULT_DS_URL = "http://10.77.77.10";
var DEFAULT_PORT = 25891;
var DOC_TYPE = { docx: "word", xlsx: "cell", pptx: "slide" };
var DOWNLOAD_TTL = 120;            // seconds: DS fetches the file right after the editor opens
var CALLBACK_TTL = 24 * 3600;      // seconds: the save callback arrives when the last editor leaves
var CONFIG_TTL = 3600;             // seconds: the signed editor config (DS re-sends it on reconnect)
var HEALTH_TTL = 10000;
var SAVE_WAIT = 180000;            // how long a closed editor may keep "saving" before the restore guard lets go
var PRESENCE_GRACE = 60000;        // a freshly issued config counts as present while the editor loads
var ATT_IN_PATH = /([a-f0-9]{32})-v\d+/g;
var DOC_PATH = /(^|\/)(cache|doc|downloadas)(\/|$)/;  // DS paths that always belong to one document
var CALLBACK_GRACE = 30 * 24 * 3600; // seconds an expired callback capability may still save into a still-current generation
var UNAVAILABLE = "문서 편집기를 사용할 수 없어요. 관리자에게 문의하세요";

// One canonical form of a DS path, used for BOTH authorization and forwarding: each segment is decoded once and
// re-encoded, so an encoded spelling ("%2D", "%61", ...) cannot hide an attachment key from the authorization regex
// while nginx / DS decode it to the same document. Anything ambiguous (encoded slash or backslash, NUL, control
// characters, a still-encoded "%" after decoding, dot segments, empty segments) is refused.
// Returns { path, decoded, query } (path: encoded, no query; decoded: for matching) or null.
function canonicalDsPath(dsPath) {
  if (typeof dsPath !== "string") return null;
  var q = dsPath.indexOf("?");
  var raw = q < 0 ? dsPath : dsPath.slice(0, q), query = q < 0 ? "" : dsPath.slice(q);
  if (raw.charAt(0) !== "/" || /[\u0000-\u001f\u007f\\]/.test(raw) || /%2f|%5c|%00/i.test(raw)) return null;
  var trailing = raw.length > 1 && raw.charAt(raw.length - 1) === "/";
  var segs = raw.slice(1).split("/");
  if (trailing) segs.pop();
  var dec = [];
  for (var i = 0; i < segs.length; i++) {
    var d;
    try { d = decodeURIComponent(segs[i]); } catch (_) { return null; }  // iron-laws: ignore[IL-301] malformed percent-encoding is rejected as an invalid path (null), not an error
    if (!d || d === "." || d === ".." || /[\u0000-\u001f\u007f\\\/%]/.test(d)) return null;
    dec.push(d);
  }
  return {
    path: "/" + dec.map(encodeURIComponent).join("/") + (trailing && dec.length ? "/" : ""),
    decoded: "/" + dec.join("/") + (trailing && dec.length ? "/" : ""),
    query: query,
  };
}

function fail(code, status) { var e = new Error(code); e.code = code; e.status = status || 400; return e; }

function isLoopbackIp(h) { return /^127\.\d+\.\d+\.\d+$/.test(h) || h === "::1"; }
function ipv4(h) {
  var m = typeof h === "string" ? /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h) : null;
  return m && m.slice(1).every(function (o) { return Number(o) <= 255; }) ? m.slice(1).map(Number) : null;
}
// The second listener may bind loopback, or the bridge address: a concrete IPv4 in the same /24 as the DS (the
// docker network the DS lives on), never the DS's own address. Never a wildcard or a name: this listener serves
// the DS-facing routes only.
function assertBindHost(host, dsHost) {
  var h = ipv4(host), d = ipv4(dsHost);
  var bridge = !!h && !!d && host !== dsHost && h[0] === d[0] && h[1] === d[1] && h[2] === d[2] && h[3] !== 0 && h[3] !== 255;
  if (!(typeof host === "string" && isLoopbackIp(host)) && !bridge) {
    var e = new Error("office listener host must be loopback or an address in the DS network (same /24 as office.dsUrl), got " + host);
    e.code = "bad_bind_host";
    throw e;
  }
  return host;
}

// Phone, desktop layout (editing): DS 9.3 customization names, checked against web-apps api.js and the editor
// bundle. zoom 100 keeps text readable (-2 fit-to-width would shrink an A4 page to about 49% on 390px; slides, which
// are one picture, fit the width); compactHeader/compactToolbar/toolbarHideFileName/hideRulers save space; the right
// panel starts hidden; uiTheme follows the Aigora theme. DS has no option for caret or selection colour.
function phoneCustomization(ext, dark) {
  return {
    zoom: ext === "pptx" ? -2 : 100, compactToolbar: true, compactHeader: true, toolbarHideFileName: true, hideRightMenu: true, hideRulers: true,
    uiTheme: dark === true ? "default-dark" : "default-light",
  };
}

// raw: the daemon config's `office` block. Disabled unless explicitly enabled.
function resolveOfficeConfig(raw, configDir) {
  raw = raw && typeof raw === "object" ? raw : {};
  var dsUrl = typeof raw.dsUrl === "string" && raw.dsUrl ? raw.dsUrl : DEFAULT_DS_URL;
  var u = null;
  try { u = new URL(dsUrl); } catch (_) { u = null; }
  var valid = !!u && u.protocol === "http:" && !u.username && !u.password && (u.pathname === "/" || u.pathname === "");
  var port = Number(raw.callbackPort);
  return {
    enabled: raw.enabled === true && valid,
    dsUrl: valid ? u.origin : DEFAULT_DS_URL,
    dsHost: valid ? u.hostname : new URL(DEFAULT_DS_URL).hostname,
    callbackHost: typeof raw.callbackHost === "string" && raw.callbackHost ? raw.callbackHost : BRIDGE_HOST,
    callbackPort: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT,
    jwtSecretFile: typeof raw.jwtSecretFile === "string" && raw.jwtSecretFile ? raw.jwtSecretFile : path.join(configDir || "", "office-jwt.secret"),
  };
}

// The secret file must be a regular 0600-style file of the service user; it is never logged.
function readSecretFile(file) {
  try {
    var lst = fs.lstatSync(file);
    if (!lst.isFile() || (lst.mode & 0o077) !== 0) return null;
    var s = fs.readFileSync(file, "utf8").trim();
    return s.length >= 32 ? s : null;
  } catch (_) { return null; }
}

function createOffice(opts) {
  var store = opts.store;
  var users = opts.usersModule;
  var cfg = opts.config;
  var now = opts.now || Date.now;
  var log = opts.log || function () {};
  var dbg = process.env.AIGORA_OFFICE_DEBUG ? function (m) { log(m + " @" + (Date.now() % 1000000)); } : function () {};
  var hasAnyAccess = opts.hasAnyAccess || function (uid) { try { return users.getRoomsForUser(uid).length > 0; } catch (_) { return false; } };
  var sessions = new Map();     // attachmentId -> Map(userId -> entry)
  var lastSave = new Map();     // attachmentId -> { ok, at, reason }
  var locks = new Map();        // attachmentId -> Promise (per-attachment serialisation)
  var editOpen = new Set();     // attachmentIds an edit-mode user has connected to since DS last closed them
  var pendingSave = new Map();  // attachmentId -> { key, since }: an editor left, DS has not called back yet
  var health = { at: 0, ok: false };
  var server = null;
  var secretCache = { value: null, at: 0 };
  var allowedRemotes = (opts.allowedRemotes || [cfg.dsHost]).slice();
  var unsubscribe = null;

  function enabled() { return !!cfg.enabled; }
  function secret() {
    if (opts.secret) return typeof opts.secret === "function" ? opts.secret() : opts.secret;
    if (secretCache.value && now() - secretCache.at < 30000) return secretCache.value;
    secretCache = { value: readSecretFile(cfg.jwtSecretFile), at: now() };
    return secretCache.value;
  }
  function docToken(payload) { return jwt.sign(payload, jwt.docKey(secret())); }
  function readDocToken(token, kind) {
    var s = secret();
    if (!s) return null;
    var p = jwt.verify(token, jwt.docKey(s), now(), { requireExp: true });
    if (!p && kind === "cb") {
      // DS keeps the first callback URL of a document key for as long as the document stays open, which can be
      // longer than CALLBACK_TTL. A signed, expired capability is honoured for a bounded grace period; serveCallback
      // then only lets it save into a still-current generation (see there).
      p = jwt.verify(token, jwt.docKey(s), 0, { requireExp: true });
      if (!p || typeof p.exp !== "number" || p.exp + CALLBACK_GRACE <= now() / 1000) return null;  // iron-laws: ignore[IL-307] fail-closed capability check; expired or invalid token yields null (denied)
      p = Object.assign({}, p, { expired: true });
    }
    return p && p.kind === kind && typeof p.att === "string" && typeof p.scope === "string" && (kind === "cb" || typeof p.uid === "string") ? p : null;
  }
  function nameOf(userId) {
    try {
      var u = users.findUserById(userId);
      var p = (u && u.profile) || {};
      return p.name || (u && (u.displayName || u.username)) || "조원";
    } catch (_) { return "조원"; }
  }
  function refOf(scopeName) {
    var m = /^(room|chan)-(.+)$/.exec(String(scopeName));
    if (!m) return null;
    return m[1] === "room" ? { roomId: m[2] } : { channelId: m[2] };
  }
  function scopeNameOf(ref) { var sc = store.scopeOf(ref); return sc ? sc.name : null; }
  function canEditExt(ext) { return CO_EDIT.indexOf(ext) >= 0 && DOWNLOAD_ONLY.indexOf(ext) < 0; }

  // --- Health ----------------------------------------------------------------------------

  function dsRequest(method, urlPath, body, headers, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var data = body === undefined ? null : Buffer.from(JSON.stringify(body));
      var h = Object.assign({}, headers || {});
      if (data) { h["Content-Type"] = "application/json"; h["Content-Length"] = String(data.length); }
      var req = (opts.httpRequest || http.request)(cfg.dsUrl + urlPath, { method: method, headers: h, agent: false, timeout: timeoutMs || 5000 }, function (res) {
        var chunks = [], size = 0;
        res.on("data", function (c) { size += c.length; if (size < 65536) chunks.push(c); });
        res.on("end", function () { resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }); });
        res.on("error", reject);
      });
      req.on("timeout", function () { req.destroy(new Error("timeout")); });
      req.on("error", reject);
      if (data) req.write(data);
      req.end();
    });
  }
  // Cached 10 s so a dead container costs the editor button one probe, not one per click.
  function healthy() {
    if (!enabled()) return Promise.resolve(false);
    if (now() - health.at < HEALTH_TTL) return Promise.resolve(health.ok);
    return dsRequest("GET", "/healthcheck", undefined, null, 2000).then(function (r) {
      health = { at: now(), ok: r.status === 200 && r.body.trim() === "true" };
      return health.ok;
    }, function () { health = { at: now(), ok: false }; return false; });
  }
  function status() {
    var ready = !!secret();
    return healthy().then(function (ok) { return { enabled: enabled(), available: enabled() && ready && ok, secret: ready }; });
  }

  // --- Sessions / presence -----------------------------------------------------------------

  function entryOf(attId, userId) { var m = sessions.get(attId); return m && m.get(userId) || null; }
  function register(attId, userId, data) {
    var m = sessions.get(attId);
    if (!m) { m = new Map(); sessions.set(attId, m); }
    var e = m.get(userId);
    if (!e) { e = { userId: userId, attId: attId, sockets: new Set() }; m.set(userId, e); }
    // a person with an editor socket open keeps their edit standing when a second (view) session registers
    var keepEdit = e.mode === "edit" && e.sockets.size > 0 && data.mode === "view";
    Object.assign(e, data, { issuedAt: now() });
    if (keepEdit) e.mode = "edit";
    if (!e.sockets.size) e.connected = false; // loading again: the grace period applies afresh
    return e;
  }
  function stillAllowed(e) {
    try {
      store.authorizeAttachment({ id: e.userId }, e.ref, e.attId, e.mode === "edit" ? "edit" : "view", true);
      return true;
    } catch (_) { return false; }
  }
  // Present while a socket is open, or (never yet connected) during the load grace period. A user who
  // connected and left is gone at once; their pending save is tracked separately.
  function present(e) { return e.sockets.size > 0 || (!e.connected && now() - e.issuedAt < PRESENCE_GRACE); }
  function saving(attId) {
    var p = pendingSave.get(attId);
    if (p && now() - p.since > SAVE_WAIT) { pendingSave.delete(attId); p = null; }
    return !!p;
  }
  function editorsOf(attId) {
    var m = sessions.get(attId), out = [];
    if (!m) return out;
    m.forEach(function (e) { if (present(e)) out.push({ id: e.userId, name: e.name, mode: e.mode }); });
    return out;
  }
  // Open, or closed with DS still to call back with the result: a restore in that gap would be overwritten.
  function isOpen(attId) { return editorsOf(attId).length > 0 || saving(attId); }

  // Who is in which document of one scope, for members of that scope only (authorized as a list).
  function presence(actor, ref) {
    var list = store.list(actor, ref);
    var editing = {};
    list.forEach(function (d) {
      if (CO_EDIT.indexOf(d.ext) < 0) return;
      var who = editorsOf(d.id);
      var fail = lastSave.get(d.id);
      editing[d.id] = { v: d.version || 1, editors: who, saving: saving(d.id), lastSaveFailed: !!(fail && !fail.ok) };
    });
    return editing;
  }

  // --- Editor config -----------------------------------------------------------------------

  function internalBase() { return "http://" + cfg.callbackHost + ":" + cfg.callbackPort; }

  // Per-user, short-lived signed config. Membership is judged now, on every call.
  // opts.view forces view mode (the phone's mobile viewer: the Community build's mobile editor cannot edit).
  // opts.phone: the desktop layout on a phone; opts.dark: the person's Aigora theme (see phoneCustomization).
  function issueConfig(actor, ref, attachmentId, opts) {
    try { return issueConfigNow(actor, ref, attachmentId, opts || {}); } catch (e) { return Promise.reject(e); }
  }
  function issueConfigNow(actor, ref, attachmentId, o) {
    if (!enabled()) return Promise.reject(fail("office_disabled", 404));
    var auth = store.authorizeAttachment(actor, ref, attachmentId, "view");
    var rec = auth.record;
    if (!canEditExt(rec.ext)) {
      store.auditEvent(actor, auth.scope.name, attachmentId, "office_open", "unsupported");
      return Promise.reject(fail("unsupported", 415));
    }
    var s = secret();
    if (!s) return Promise.reject(fail("office_unavailable", 503));
    return healthy().then(function (ok) {
      if (!ok) { store.auditEvent(actor, auth.scope.name, attachmentId, "office_open", "unavailable"); throw fail("office_unavailable", 503); }
      var mode = "view";
      if (!o.view) { try { store.authorizeAttachment(actor, ref, attachmentId, "edit", true); mode = "edit"; } catch (_) { /* viewer, or admin read-only */ } }
      var ver = rec.currentVersion || 1;
      var key = attachmentId + "-v" + ver;
      var t = Math.floor(now() / 1000);
      var name = nameOf(actor.id);
      var download = docToken({ kind: "dl", att: attachmentId, ver: ver, scope: auth.scope.name, uid: actor.id, exp: t + DOWNLOAD_TTL });
      // DS keeps one callback URL per document key, whoever opens it first: so the token is bound to the document
      // (attachment, key, scope), never to the opener. Who may save is judged from the editors DS reports.
      var callback = docToken({ kind: "cb", att: attachmentId, key: key, scope: auth.scope.name, exp: t + CALLBACK_TTL });
      // Who may learn the internal callback address: DS keeps the callback URL of whoever opens a document key
      // first, so a configuration without it is only issued to a viewer while a connected editor of this very
      // key already carried it. Everyone else (including the first opener) gets it.
      var carried = false;
      var mm = sessions.get(attachmentId);
      if (mm) mm.forEach(function (x) { if (x.userId !== actor.id && x.key === key && x.carriedCb && x.sockets.size > 0) carried = true; });
      var prevE = entryOf(attachmentId, actor.id);
      var withCallback = mode === "edit" || !carried;
      var config = {
        document: {
          fileType: rec.ext, key: key, title: rec.name, url: internalBase() + "/office-internal/download/" + download,
          permissions: { edit: mode === "edit", download: true, print: true, copy: true, comment: mode === "edit" },
        },
        documentType: DOC_TYPE[rec.ext],
        editorConfig: {
          mode: mode, lang: "ko", user: { id: actor.id, name: name },
          customization: Object.assign({ forcesave: false, autosave: true, features: { featuresTips: false } }, o.phone ? phoneCustomization(rec.ext, o.dark) : {}),
        },
      };
      if (withCallback) config.editorConfig.callbackUrl = internalBase() + "/office-internal/callback/" + callback;
      config.token = jwt.sign(Object.assign({}, config, { exp: t + CONFIG_TTL }), s);
      register(attachmentId, actor.id, { name: name, mode: mode, ref: ref, key: key, carriedCb: withCallback || !!(prevE && prevE.key === key && prevE.carriedCb) });
      store.auditEvent(actor, auth.scope.name, attachmentId, "office_open", "ok", { mode: mode });
      return { config: config, mode: mode, version: ver, name: rec.name, ext: rec.ext };
    });
  }

  // --- Proxy authorization and sockets -----------------------------------------------------

  function attachmentIdsIn(p) {
    var ids = [], m;
    var c = canonicalDsPath(String(p));
    if (!c) return ids;
    ATT_IN_PATH.lastIndex = 0;
    while ((m = ATT_IN_PATH.exec(c.decoded)) !== null) if (ids.indexOf(m[1]) < 0) ids.push(m[1]);
    return ids;
  }
  // Every proxied request: a document path (key in it) needs this user's live, still-authorized
  // session for that very attachment; shared assets need an active membership somewhere.
  function authorizeProxy(user, dsPath) {
    if (!user || typeof user.id !== "string" || !enabled()) return false;
    var c = canonicalDsPath(String(dsPath).split("?")[0]);
    if (!c) return false;
    var ids = attachmentIdsIn(c.path);
    if (!ids.length) return !DOC_PATH.test(c.decoded) && hasAnyAccess(user.id); // a document/cache path without a valid key is never a shared asset
    return ids.every(function (id) {
      var e = entryOf(id, user.id);
      if (!e || !stillAllowed(e)) return false;
      e.issuedAt = now(); // long-polling fallback transports keep the session alive by requests
      return true;
    });
  }
  // The proxy hands over the browser-side socket of a WebSocket; closing it ends the editing session.
  function trackSocket(user, dsPath, sock) {
    var ids = attachmentIdsIn(dsPath), tracked = [];
    ids.forEach(function (id) {
      var e = entryOf(id, user.id);
      if (!e) return;
      e.sockets.add(sock);
      e.connected = true;
      pendingSave.delete(id); // someone is in the document again: DS keeps it open, no save is pending
      if (e.mode === "edit") editOpen.add(id);
      tracked.push(e);
      dbg("[office] ws open " + id.slice(0, 6) + " " + user.id.slice(0, 6) + " sockets=" + e.sockets.size);
    });
    sock.once("close", function () {
      tracked.forEach(function (e) {
        e.sockets.delete(sock);
        dbg("[office] ws close " + e.attId.slice(0, 6) + " " + e.userId.slice(0, 6) + " sockets=" + e.sockets.size);
        // the last connection to the document just closed: if anyone could edit it, DS saves and calls back shortly
        var m = sessions.get(e.attId), anyOpen = false;
        if (m) m.forEach(function (x) { if (x.sockets.size) anyOpen = true; });
        if (m && !anyOpen && editOpen.delete(e.attId)) pendingSave.set(e.attId, { key: e.key, since: now() });
      });
    });
    return tracked.length > 0;
  }

  function dropUser(entry) {
    var s = secret();
    if (!s || !entry.key) return Promise.resolve(false);
    var body = { c: "drop", key: entry.key, users: [entry.userId] };
    return dsRequest("POST", "/command", Object.assign({}, body, { token: jwt.sign(body, s) }), { Authorization: "Bearer " + jwt.sign({ payload: body }, s) }, 3000)
      .then(function () { return true; }, function () { return false; });
  }
  // Closes the user's proxied sockets now (the real mechanism) and sends DS `drop` best effort.
  function revoke(userId, attId, why) {
    var e = entryOf(attId, userId);
    if (!e) return false;
    dbg("[office] revoke " + attId.slice(0, 6) + " " + userId.slice(0, 6) + " " + (why || "access"));
    var socks = Array.from(e.sockets);
    sessions.get(attId).delete(userId);
    if (!sessions.get(attId).size) sessions.delete(attId);
    socks.forEach(function (s) { try { s.destroy(); } catch (_) { /* already closed */ } });
    dropUser(e);
    try { store.auditEvent({ id: userId }, store.scopeOf(e.ref).name, attId, "office_revoke", why || "access"); } catch (_) { /* audit is best effort */ }
    return true;
  }
  // Re-judges every open session; wired to the membership-change event (remove, role change, archive, delete, logout).
  function sweep(change) {
    var killed = 0;
    Array.from(sessions.keys()).forEach(function (attId) {
      var m = sessions.get(attId);
      if (!m) return;
      Array.from(m.keys()).forEach(function (uid) {
        var e = m.get(uid);
        var stale = e.sockets.size === 0 && now() - e.issuedAt > 5 * 60000;
        if (stale) { m.delete(uid); return; }
        if ((change && change.tokensRevoked && change.userId === uid) || !stillAllowed(e)) { if (revoke(uid, attId, "access")) killed++; }
      });
      if (m.size === 0) sessions.delete(attId);
    });
    return killed;
  }

  // --- DS-facing listener ------------------------------------------------------------------

  // The only URL form accepted: the proxy-visible /p/<slug>/office/web/cache/files/... (DS builds it from
  // X-Forwarded-Host) or the DS base itself. The fetch ALWAYS goes to the configured DS base: the host in
  // the URL is never contacted.
  function rewriteDsUrl(raw) {
    if (typeof raw !== "string" || raw.length > 4096 || /[\u0000- \\]/.test(raw) || /%2e|%2f|%5c/i.test(raw)) throw fail("bad_url");
    var u;
    try { u = new URL(raw); } catch (_) { throw fail("bad_url"); }
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) throw fail("bad_url");
    var m = /^\/p\/[a-z0-9_-]+\/office\/web(\/cache\/files\/[^?#]+)$/.exec(u.pathname);
    var rest = m ? m[1] : (u.origin === cfg.dsUrl && /^\/cache\/files\/[^?#]+$/.test(u.pathname) ? u.pathname : null);
    if (!rest || rest.indexOf("/../") >= 0) throw fail("bad_url");
    return cfg.dsUrl + rest + u.search;
  }

  function withLock(attId, fn) {
    var prev = locks.get(attId) || Promise.resolve();
    var next = prev.then(fn, fn);
    var tail = next.catch(function () {});
    locks.set(attId, tail);
    tail.then(function () { if (locks.get(attId) === tail) locks.delete(attId); });
    return next;
  }

  // Runs under the same per-attachment lock as a DS save, so a restore never interleaves with a commit.
  function restoreVersion(actor, ref, attachmentId, n) {
    return withLock(attachmentId, function () {
      if (isOpen(attachmentId)) throw fail("in_use", 409);
      return store.restoreVersion(actor, ref, attachmentId, n);
    });
  }

  function remoteOk(req) {
    var ra = String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
    return allowedRemotes.indexOf(ra) >= 0;
  }
  function readBody(req, max) {
    return new Promise(function (resolve, reject) {
      var chunks = [], size = 0;
      req.on("data", function (c) { size += c.length; if (size > max) { if (size - c.length <= max) reject(fail("too_large", 413)); } else chunks.push(c); });
      req.on("end", function () { resolve(Buffer.concat(chunks)); });
      req.on("error", reject);
    });
  }
  function bearer(h) { var m = /^Bearer (.+)$/.exec(String(h || "")); return m ? m[1] : null; }
  function claimsOf(p) { return p && p.payload && typeof p.payload === "object" ? p.payload : p; }

  // Streams the DS result into the store's save writer: no redirects, hard size cap, 60 s.
  function fetchResult(url, saver, cap) {
    return new Promise(function (resolve, reject) {
      var done = false;
      function end(err) { if (done) return; done = true; if (err) { saver.abort(); reject(err); } else resolve(); }
      var req = (opts.httpRequest || http.request)(url, { method: "GET", agent: false, timeout: 60000 }, function (res) {
        if (res.statusCode !== 200) { res.resume(); return end(fail("fetch_status_" + res.statusCode)); }
        var len = Number(res.headers["content-length"]);
        if (len > cap) { res.destroy(); return end(fail("too_large")); }
        res.on("data", function (c) { try { saver.write(c); } catch (e) { res.destroy(); end(e); } });
        res.on("end", function () { end(null); });
        res.on("error", end);
      });
      req.on("timeout", function () { req.destroy(new Error("timeout")); });
      req.on("error", end);
      req.end();
    });
  }

  function sendJson(res, status, obj) {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(obj));
  }

  function serveDownload(req, res, tok) {
    var ref = refOf(tok.scope);
    var e = entryOf(tok.att, tok.uid);
    var f = null;
    try {
      if (!ref || !e) throw fail("not_found");
      store.authorizeAttachment({ id: tok.uid }, ref, tok.att, "view", true);
      f = store.openInternal(ref, tok.att, tok.ver);
    } catch (_) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(f.size), "Cache-Control": "no-store" });
    if (f.size === 0) { fs.closeSync(f.fd); return res.end(); }
    var stream = fs.createReadStream(null, { fd: f.fd, autoClose: true });
    stream.on("error", function () { res.destroy(); });
    res.on("close", function () { stream.destroy(); });
    stream.pipe(res);
  }

  // The result of one DS callback is { error: 0 | 1 } with HTTP 200 (what DS expects); the reason goes to the log.
  function serveCallback(req, res, tok) {
    var reply = function (code, why) { if (why) log("[office] callback " + tok.att + ": " + why); sendJson(res, 200, { error: code }); };
    readBody(req, 1024 * 1024).then(function (raw) {
      var body;
      try { body = JSON.parse(raw.toString("utf8")); } catch (_) { return reply(1, "bad json"); }
      var s = secret();
      var hv = s && jwt.verify(bearer(req.headers.authorization), s, now());
      var bv = s && body && jwt.verify(body.token, s, now());
      if (!hv || !bv) return reply(1, "missing or invalid DS jwt (header " + !!hv + ", body " + !!bv + ")");
      var claims = claimsOf(bv), hclaims = claimsOf(hv);
      // The decoded, signed payload is the truth; the raw body only carries it.
      if (!claims || typeof claims.key !== "string" || claims.key !== tok.key) return reply(1, "key does not match the docToken");
      if (!hclaims || hclaims.key !== claims.key) return reply(1, "header and body disagree");
      if ((hclaims.status !== undefined && hclaims.status !== claims.status) || (hclaims.url !== undefined && hclaims.url !== claims.url)) return reply(1, "header and body disagree");
      var refG = refOf(tok.scope);
      var kv = tok.key.match(/^[a-f0-9]{32}-v(\d+)$/);
      if (!refG || !kv) return reply(1, "malformed key");
      var keyVer = Number(kv[1]);
      // An editing generation that predates a restore is void: its late save must not overwrite the restore.
      if (keyVer < store.restoreFloorOf(refG, tok.att)) return reply(1, "stale editing generation (restored since)");
      // An expired capability may only save into the generation that is still current (nothing saved since).
      if (tok.expired && store.currentVersionOf(refG, tok.att) !== keyVer) return reply(1, "expired callback for a superseded generation");
      var st = Number(claims.status);
      if (st !== 1 && pendingSave.has(tok.att) && pendingSave.get(tok.att).key === claims.key) pendingSave.delete(tok.att);
      if (st === 1 || st === 4) return reply(0);
      if (st === 3 || st === 7) { lastSave.set(tok.att, { ok: false, at: now(), reason: "ds_status_" + st }); return reply(0, "DS reported save failure status " + st); }
      if (st !== 2 && st !== 6) return reply(1, "unknown status " + claims.status);
      return withLock(tok.att, function () { return commit(tok, claims, st); }).then(function () { reply(0); }, function (err) {
        lastSave.set(tok.att, { ok: false, at: now(), reason: err && err.code || "failed" });
        reply(1, "save refused: " + (err && (err.code || err.message)));
      });
    }, function () { reply(1, "unreadable body"); });
  }

  function commit(tok, claims, st) {
    var ref = refOf(tok.scope);
    if (!ref) return Promise.reject(fail("not_found"));
    // Only a save by someone who can still edit counts: the first DS-reported editor who passes is credited.
    var by = null;
    (Array.isArray(claims.users) ? claims.users : []).forEach(function (uid) {
      if (by || typeof uid !== "string") return;
      try { store.authorizeAttachment({ id: uid }, ref, tok.att, "edit", true); by = uid; } catch (_) { /* not an editor now */ }
    });
    if (!by) return Promise.reject(fail("forbidden", 403));
    var idem = st === 6 ? tok.key + "#fs" + String(claims.lastsave || "") : tok.key;
    if (store.hasVersionKey(ref, tok.att, idem)) return Promise.resolve();   // a repeated callback is a no-op
    if (claims.notmodified === true) return Promise.resolve();
    var url = rewriteDsUrl(claims.url);
    var kv = tok.key.match(/^[a-f0-9]{32}-v(\d+)$/);
    var saver = store.beginSave(ref, tok.att, { savedBy: by, key: idem, keyVer: kv ? Number(kv[1]) : undefined });
    var cap = Math.min(25 * 1024 * 1024, OFFICE_LIMITS.maxDownload);
    return fetchResult(url, saver, cap).then(function () {
      var r = saver.finish();
      lastSave.set(tok.att, { ok: true, at: now(), reason: null });
      return r;
    }, function (err) { saver.abort(); throw err; });
  }

  function createInternalServer() {
    return http.createServer(function (req, res) {
      var m = /^\/office-internal\/(download|callback)\/([A-Za-z0-9_.-]{20,2048})$/.exec(String(req.url || "").split("?")[0]);
      if (!remoteOk(req) || !m) { res.writeHead(404); return res.end(); }
      var kind = m[1] === "download" ? "dl" : "cb";
      var tok = readDocToken(m[2], kind);
      if (!tok) { res.writeHead(403); return res.end(); }
      if (kind === "dl" && req.method === "GET") return serveDownload(req, res, tok);
      if (kind === "cb" && req.method === "POST") return serveCallback(req, res, tok);
      res.writeHead(405); res.end();
    });
  }
  function startInternal() {
    if (server) return Promise.resolve(server);
    try { assertBindHost(cfg.callbackHost, cfg.dsHost); } catch (e) { return Promise.reject(e); }
    server = createInternalServer();
    return new Promise(function (resolve, reject) {
      server.once("error", function (e) { server = null; reject(e); });
      server.listen(cfg.callbackPort, cfg.callbackHost, function () { resolve(server); });
    });
  }
  function stop() {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    sessions.forEach(function (m) { m.forEach(function (e) { e.sockets.forEach(function (s) { try { s.destroy(); } catch (_) { /* closed */ } }); }); });
    sessions.clear();
    return new Promise(function (resolve) { if (!server) return resolve(); var s = server; server = null; s.close(function () { resolve(); }); });
  }
  if (opts.subscribe !== false) unsubscribe = require("./private-session-revocation").onAccessChanged(sweep);

  return {
    enabled: enabled, status: status, healthy: healthy, issueConfig: issueConfig, presence: presence, isOpen: isOpen,
    restoreVersion: restoreVersion, authorizeProxy: authorizeProxy, trackSocket: trackSocket, sweep: sweep, revoke: revoke,
    canonicalPath: canonicalDsPath, createInternalServer: createInternalServer, startInternal: startInternal, stop: stop, rewriteDsUrl: rewriteDsUrl,
    config: cfg, listener: function () { return server; }, UNAVAILABLE: UNAVAILABLE,
    _sessions: sessions, _lastSave: lastSave,
  };
}

module.exports = {
  createOffice: createOffice, resolveOfficeConfig: resolveOfficeConfig, assertBindHost: assertBindHost, readSecretFile: readSecretFile,
  canonicalDsPath: canonicalDsPath, BRIDGE_HOST: BRIDGE_HOST, UNAVAILABLE: UNAVAILABLE, phoneCustomization: phoneCustomization,
};

// project-office.js - HTTP glue for Office co-editing, mounted under /p/<slug>/office/.
//
//   GET  /office/editor/<scope>/<id>/<att>             host page (embeds DS api.js, fetches its config)
//   POST /office/api/<scope>/<id>/<att>/config         per-user signed editor config
//   GET  /office/api/status/<scope>/<id>               availability, who is editing, version numbers
//   GET  /office/api/<scope>/<id>/<att>/versions       version history
//   POST /office/api/<scope>/<id>/<att>/versions/<n>/restore
//   GET  /office/api/<scope>/<id>/<att>/versions/<n>/download
//   *    /office/web/**                                reverse proxy to the Document Server
//
// <scope> is "room" or "channel". The actor is only req._aigoraUser; every route goes through the
// store's single authorizeAttachment (directly or via office.issueConfig / presence).

var fs = require("fs");
var { readCappedBody } = require("./utils");
var { createOffice, resolveOfficeConfig, UNAVAILABLE } = require("./office");
var { createProxy, sameOriginOnly } = require("./office-proxy");

var ROUTE_RE = /^\/office\/(editor|api)\/(?:(status)\/(room|channel)\/([A-Za-z0-9_-]{1,128})|(room|channel)\/([A-Za-z0-9_-]{1,128})\/([a-f0-9]{32})(?:\/(config|versions)(?:\/([0-9]{1,6})\/(restore|download))?)?)$/;
var CSP = "default-src 'none'; script-src 'self'; connect-src 'self'; frame-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; frame-ancestors 'self'";

var shared = {};
// One office service per daemon: it owns the DS-facing listener and the in-memory sessions.
function sharedOffice(ctx) {
  if (shared.office === undefined) {
    var cfgModule = require("./config");
    var raw = null;
    try { raw = (cfgModule.loadConfig() || {}).office; } catch (_) { raw = null; }
    var cfg = resolveOfficeConfig(ctx.officeConfig || raw, cfgModule.CONFIG_DIR);
    shared.office = createOffice({ store: ctx.store, usersModule: ctx.usersModule, config: cfg, log: function (m) { console.log(m); } });
    if (cfg.enabled) {
      // The bridge address only exists once scripts/aigora-office.sh has created the network: retry until it does
      // (a bad configuration, e.g. a wildcard host, is not retried).
      var attempt = function () {
        shared.office.startInternal().then(function () {
          console.log("[office] DS-facing listener on " + cfg.callbackHost + ":" + cfg.callbackPort);
        }, function (e) {
          console.error("[office] listener failed: " + (e && e.message));
          if (e && e.code === "bad_bind_host") return;
          var t = setTimeout(attempt, 15000);
          if (t.unref) t.unref();
        });
      };
      attempt();
    }
  }
  return shared.office;
}

function attachOffice(ctx) {
  var users = ctx.usersModule;
  var attachments = ctx.attachments;
  var store = ctx.store || attachments.store;
  var office = ctx.office || sharedOffice({ store: store, usersModule: users, officeConfig: ctx.officeConfig });
  var proxy = createProxy(office);
  var slug = ctx.slug;

  function json(res, status, obj) {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(JSON.stringify(obj));
  }
  function fail(res, e) {
    var status = e && e.status ? e.status : 500;
    var body = { error: e && e.code && e.status ? e.code : "failed" };
    if (body.error === "office_unavailable") body.message = UNAVAILABLE;
    json(res, status, body);
  }
  function userName(id) {
    var u = users.findUserById(id);
    if (!u) return "알 수 없음";
    var p = u.profile || {};
    return p.name || u.displayName || u.username || "알 수 없음";
  }
  function pageHtml(ref, scope, scopeId, attId) {
    var base = "/p/" + slug;
    var cfgUrl = base + "/office/api/" + scope + "/" + scopeId + "/" + attId + "/config";
    return '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
      '<meta name="referrer" content="no-referrer"><title>문서 편집</title><style>html,body,#ed{height:100%;margin:0}body{font-family:system-ui,sans-serif;background:#f5f5f7;color:#1d1d1f}' +
      '#msg{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;font-size:16px;line-height:1.5}#msg[hidden]{display:none}</style></head>' +
      '<body data-config="' + cfgUrl + '"><div id="ed"></div><p id="msg" role="status">문서를 여는 중…</p>' +
      '<script src="' + base + '/office/web/web-apps/apps/api/documents/api.js"></script><script src="' + base + '/aigora/office-host.js"></script></body></html>';
  }

  function handleHttp(req, res, urlPath) {
    var parts = String(urlPath || "").split("?");
    var p = parts[0];
    if (p.indexOf("/office/") !== 0) return false;
    var actor = req._aigoraUser ? { id: req._aigoraUser.id } : null;
    if (!actor) { json(res, 401, { error: "unauthorized" }); return true; }
    if (p.indexOf("/office/web/") === 0) {
      proxy.handleHttp(req, res, urlPath, { user: req._aigoraUser, slug: slug, proto: req._aigoraProto });
      return true;
    }
    var m = ROUTE_RE.exec(p);
    if (!m || !sameOriginOnly(req)) { json(res, 404, { error: "not_found" }); return true; }
    var kind = m[1];
    var isStatus = m[2] === "status";
    var scope = isStatus ? m[3] : m[5], scopeId = isStatus ? m[4] : m[6], attId = m[7], action = m[8], ver = m[9] === undefined ? null : Number(m[9]), vact = m[10];
    var ref = scope === "room" ? { roomId: scopeId } : { channelId: scopeId };
    var mutating = req.method === "POST";
    if (mutating && !req.headers["x-requested-with"]) { json(res, 403, { error: "forbidden" }); return true; }
    try {
      if (kind === "editor" && req.method === "GET" && attId && !action) {
        store.authorizeAttachment(actor, ref, attId, "view");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
        res.end(pageHtml(ref, scope, scopeId, attId));
      } else if (kind === "api" && isStatus && req.method === "GET") {
        office.status().then(function (st) {
          var editing = {};
          if (st.enabled) editing = office.presence(actor, ref);
          Object.keys(editing).forEach(function (id) { editing[id].editors.forEach(function (e) { e.name = e.name || userName(e.id); }); });
          json(res, 200, { enabled: st.enabled, available: st.available, message: st.enabled && !st.available ? UNAVAILABLE : undefined, editing: editing });
        }).catch(function (e) { fail(res, e); });
      } else if (kind === "api" && action === "config" && mutating) {
        readCappedBody(req, 1024).then(function (raw) {
          var parsed = {};
          try { parsed = JSON.parse(raw || "{}") || {}; } catch (_) { parsed = {}; }
          return office.issueConfig(actor, ref, attId, { view: parsed.view === true, phone: parsed.phone === true, dark: parsed.dark === true });
        }).then(function (r) {
          json(res, 200, { config: r.config, mode: r.mode, version: r.version, name: r.name, ext: r.ext });
        }).catch(function (e) { fail(res, e); });
      } else if (kind === "api" && action === "versions" && ver === null && req.method === "GET") {
        json(res, 200, { versions: store.listVersions(actor, ref, attId).map(function (v) { return Object.assign({}, v, { savedByName: v.savedBy ? userName(v.savedBy) : "" }); }) });
      } else if (kind === "api" && action === "versions" && vact === "restore" && mutating) {
        store.authorizeAttachment(actor, ref, attId, "edit");
        if (office.isOpen(attId)) { json(res, 409, { error: "in_use", message: "지금 편집 중인 사람이 있어서 되돌릴 수 없어요. 모두 닫은 뒤에 다시 시도해 주세요." }); return true; }
        office.restoreVersion(actor, ref, attId, ver).then(function (dto) {
          json(res, 200, { ok: true, version: dto.version });
        }, function (e) {
          if (e && e.code === "in_use") json(res, 409, { error: "in_use", message: "지금 편집 중인 사람이 있어서 되돌릴 수 없어요. 모두 닫은 뒤에 다시 시도해 주세요." });
          else fail(res, e);
        });
      } else if (kind === "api" && action === "versions" && vact === "download" && req.method === "GET") {
        var f = store.openVersion(actor, ref, attId, ver);
        res.writeHead(200, f.headers({}));
        if (f.size === 0) { fs.closeSync(f.fd); res.end(); return true; }
        var stream = fs.createReadStream(null, { fd: f.fd, autoClose: true });
        stream.on("error", function () { res.destroy(); });
        res.on("close", function () { stream.destroy(); });
        stream.pipe(res);
      } else json(res, 404, { error: "not_found" });
    } catch (e) { fail(res, e); }
    return true;
  }

  function handleUpgrade(req, socket, head, user, proto) {
    var rest = String(req.url || "").replace(/^\/p\/[a-z0-9_-]+/, "");
    return proxy.handleUpgrade(req, socket, head, rest, { user: user, slug: slug, proto: proto });
  }
  // A deleted attachment, a removed member, an archived room: judged again at once.
  function sweep(change) { return office.sweep(change); }

  return { handleHttp: handleHttp, handleUpgrade: handleUpgrade, sweep: sweep, office: office };
}

module.exports = { attachOffice: attachOffice, ROUTE_RE: ROUTE_RE };

// office-proxy.js - the authenticated reverse proxy /p/<slug>/office/web/** -> Document Server,
// HTTP and WebSocket. The recipe is the one the spike verified: strip the prefix, set
// X-Forwarded-Host to "<host><prefix>" and X-Forwarded-Proto (DS builds every asset, WebSocket and
// cache URL from those two), drop Cookie and Authorization toward DS, pass the rest through.
//
// Authentication happens before this module is called (the Aigora session cookie); here every
// request is additionally judged by office.authorizeProxy against the live membership, and the
// browser-side socket of every WebSocket is registered so an access change can kill it.

var http = require("http");
var net = require("net");

var PREFIX_REST = "/office/web";
var METHODS = { GET: 1, HEAD: 1, POST: 1, OPTIONS: 1 };
var UNAVAILABLE_BODY = JSON.stringify({ error: "office_unavailable", message: "문서 편집기를 사용할 수 없어요. 관리자에게 문의하세요" });

// Stricter than SameSite=Lax for the editor: a cross-site or same-site-but-cross-origin request never
// reaches DS, even though the browser would attach the cookie to it.
function sameOriginOnly(req) {
  var s = req.headers["sec-fetch-site"];
  return !s || s === "same-origin" || s === "none";
}

function createProxy(office) {
  var ds = new URL(office.config.dsUrl);
  var dsPort = Number(ds.port) || 80;

  function prefixOf(slug) { return "/p/" + slug + PREFIX_REST; }
  function dsPathOf(rest) { return rest.slice(PREFIX_REST.length) || "/"; }
  // DS builds every URL it emits (WebSocket, cache files) from this scheme; an https page must get https URLs
  // or the browser blocks them as mixed content. Behind a TLS-terminating proxy that the daemon was not told to
  // trust, the daemon itself sees plain http, so the page's own Origin/Referer (same host only) corrects it.
  function schemeOf(req, proto) {
    if (proto === "https") return "https";
    var from = req.headers.origin || req.headers.referer;
    try {
      var u = new URL(from);
      if (u.host === req.headers.host && u.protocol === "https:") return "https";
    } catch (_) { /* no usable hint */ }
    return "http";
  }
  function forwardHeaders(req, slug, proto) {
    var h = Object.assign({}, req.headers);
    delete h.cookie; delete h.authorization; delete h["proxy-authorization"];
    h.host = ds.host;
    h["x-forwarded-host"] = (req.headers.host || "") + prefixOf(slug);
    h["x-forwarded-proto"] = schemeOf(req, proto);
    return h;
  }
  function refuse(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(body || JSON.stringify({ error: "not_found" }));
  }

  // rest: the project-relative URL with query ("/office/web/..."). ctx: { user, slug, proto }.
  function handleHttp(req, res, rest, ctx) {
    var c = office.canonicalPath(dsPathOf(rest));
    if (!c || !office.enabled() || !METHODS[req.method] || !sameOriginOnly(req) || !office.authorizeProxy(ctx.user, c.path)) return refuse(res, 404);
    var dsPath = c.path + c.query; // the very form that was authorized is the form forwarded
    var up = http.request({ host: ds.hostname, port: dsPort, method: req.method, path: dsPath, headers: forwardHeaders(req, ctx.slug, ctx.proto), agent: false }, function (r) {
      var h = Object.assign({}, r.headers);
      delete h["set-cookie"]; // DS never sets a cookie on the Aigora origin
      if (!h["content-security-policy"]) h["content-security-policy"] = "frame-ancestors 'self'";
      res.writeHead(r.statusCode, h);
      r.pipe(res);
    });
    up.on("error", function () { if (!res.headersSent) refuse(res, 502, UNAVAILABLE_BODY); else res.destroy(); });
    res.on("close", function () { up.destroy(); });
    req.pipe(up);
    return true;
  }

  function handleUpgrade(req, socket, head, rest, ctx) {
    var c = office.canonicalPath(dsPathOf(rest));
    var dsPath = c ? c.path + c.query : "/";
    var pathOnly = c ? c.path : "/";
    var deny = function () { try { socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); } catch (_) { /* closed */ } socket.destroy(); };
    if (!c || !office.enabled() || !sameOriginOnly(req) || !office.authorizeProxy(ctx.user, pathOnly)) return deny();
    if (!office.trackSocket(ctx.user, pathOnly, socket)) return deny(); // a WebSocket always belongs to one document
    var upstream = net.connect(dsPort, ds.hostname, function () {
      var h = forwardHeaders(req, ctx.slug, ctx.proto);
      var lines = req.method + " " + dsPath + " HTTP/1.1\r\n";
      Object.keys(h).forEach(function (k) { lines += k + ": " + h[k] + "\r\n"; });
      upstream.write(lines + "\r\n");
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    socket.setNoDelay(true);
    socket.setTimeout(0);
    upstream.on("error", function () { socket.destroy(); });
    socket.on("error", function () { upstream.destroy(); });
    upstream.on("close", function () { socket.destroy(); });
    socket.on("close", function () { upstream.destroy(); });
    return true;
  }

  return { handleHttp: handleHttp, handleUpgrade: handleUpgrade, sameOriginOnly: sameOriginOnly };
}

module.exports = { createProxy: createProxy, sameOriginOnly: sameOriginOnly };

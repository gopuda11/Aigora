"use strict";
// credential-broker.js - host-side broker that holds the real provider key for contained agent runs
// (docs/superpowers/specs/2026-10-04-credential-broker-design.md).
//
// The sandbox gets only a per-run token valid on one loopback listener (127.0.0.1:0, one per run). The broker checks the token,
// allowlists method+path, checks the model, applies budgets, injects the real key (read at request time through the injected
// getKey) and streams the answer back unchanged. Fail closed: no key -> open() throws credential_unavailable, nothing falls back
// to key injection. No body, header value (except the provider request id), token or key is ever logged.
//
//   broker.open({ vendor, runId, roomId, channelId, actorId, limits, transport? }) ->
//     Promise<{ port, token, baseUrl, env, codexConfigText?, handle(req, res), close() }>
//   transport "tcp" (default): a loopback listener per run (port, baseUrl http://127.0.0.1:<port>).
//   transport "egress": NO listener (port 0). For a sandbox with its own network namespace whose only way out is the egress
//   proxy (lib/sandbox-egress.js): baseUrl is http://broker.aigora.internal, and the egress proxy hands each absolute-form
//   request to handle(req, res), which runs the same token/allowlist/model/budget/audit pipeline as the listener (one code path).
//   Errors: Error("credential_unavailable" | "budget_exhausted").
//   vendor: "claude" | "codex" (aliases "anthropic" | "openai").

var http = require("http");
var https = require("https");
var net = require("net");
var crypto = require("crypto");
var usageMod = require("./broker-usage");

var DEFAULT_UPSTREAMS = Object.freeze({
  claude: Object.freeze({ host: "api.anthropic.com", port: 443 }),
  codex: Object.freeze({ host: "api.openai.com", port: 443 }),
});
var EGRESS_HOST = "broker.aigora.internal"; // = sandbox-egress BROKER_HOST
var ALIASES = { claude: "claude", anthropic: "claude", codex: "codex", openai: "codex" };

var DEFAULTS = {
  ttlMs: 2 * 3600 * 1000,
  maxBodyBytes: 32 * 1024 * 1024,
  headerTimeoutMs: 10000,
  idleMs: 6 * 60 * 1000,
  maxConcurrent: 4,
  defaultOutputReserve: 16384, // tokens debited up front when the request names no max_tokens / max_output_tokens
};

// method + exact path (no decoding, no normalisation) -> route. `query` lists the only allowed query params (value must be "true").
var ROUTES = {
  claude: {
    "POST /v1/messages": { upstream: true, query: ["beta"] },
    "POST /v1/messages/count_tokens": { upstream: true, query: ["beta"] },
    "GET /v1/models": { local: "models" },
  },
  codex: {
    "POST /v1/responses": { upstream: true, query: [] },
    "POST /v1/responses/compact": { upstream: true, query: [] },
    "GET /v1/models": { local: "models" },
  },
};

var HOP = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer",
  "transfer-encoding", "upgrade"];
// Inbound headers never forwarded: all credentials, cookies, and routing hints that could re-target billing.
var STRIP_REQ = ["authorization", "x-api-key", "api-key", "cookie", "host", "content-length", "expect", "accept-encoding",
  "openai-organization", "openai-project", "chatgpt-account-id"];
var STRIP_RES = ["set-cookie", "set-cookie2"];

function err(code) { return new Error(code); }
function sha256(s) { return crypto.createHash("sha256").update(s).digest(); }
function safeId(v) { return typeof v === "string" ? v.replace(/[^A-Za-z0-9._:\-]/g, "?").slice(0, 128) : null; }

function shapedError(vendor, status, type, message) {
  var body = vendor === "codex"
    ? { error: { message: message, type: type, code: type } }
    : { type: "error", error: { type: type, message: message } };
  return { status: status, body: JSON.stringify(body) };
}

function filterHeaders(src, strip) {
  var drop = {};
  HOP.concat(strip).forEach(function (h) { drop[h] = true; });
  String(src.connection || "").split(",").forEach(function (t) { t = t.trim().toLowerCase(); if (t) drop[t] = true; });
  var out = {};
  Object.keys(src).forEach(function (k) {
    var lk = k.toLowerCase();
    if (drop[lk] || lk.indexOf("proxy-") === 0) return;
    out[lk] = src[k];
  });
  return out;
}

function tokenCandidates(vendor, headers) {
  var c = [];
  var a = headers.authorization;
  if (typeof a === "string") { var m = /^Bearer\s+(\S+)$/i.exec(a.trim()); if (m) c.push(m[1]); }
  if (vendor === "claude" && typeof headers["x-api-key"] === "string") c.push(headers["x-api-key"].trim());
  return c;
}

function createCredentialBroker(opts) {
  opts = opts || {};
  if (typeof opts.getKey !== "function" || typeof opts.checkModel !== "function") throw new Error("broker_misconfigured");
  var cfg = Object.assign({}, DEFAULTS, opts);
  // An omitted, undefined, non-finite or non-positive numeric option means the default (never NaN / 0 / negative).
  Object.keys(DEFAULTS).forEach(function (k) { if (typeof cfg[k] !== "number" || !isFinite(cfg[k]) || cfg[k] <= 0) cfg[k] = DEFAULTS[k]; });
  var now = opts.now || Date.now;
  var usage = opts.usage || usageMod.createBrokerUsage({ dir: opts.dir });
  var audit = opts.audit || require("./broker-audit").createBrokerAudit({ dir: opts.dir });
  var upstreams = {
    claude: Object.assign({}, DEFAULT_UPSTREAMS.claude, opts.upstream && opts.upstream.claude),
    codex: Object.assign({}, DEFAULT_UPSTREAMS.codex, opts.upstream && opts.upstream.codex),
  };
  var sessions = new Map(); // runId -> session

  function readKey(vendor) {
    var k;
    try { k = opts.getKey(vendor); } catch (_) { return ""; }
    return typeof k === "string" && /^[\x21-\x7e]+$/.test(k) ? k : "";
  }

  function open(run) {
    return new Promise(function (resolve, reject) {
      run = run || {};
      var vendor = ALIASES[run.vendor];
      if (!vendor || typeof run.runId !== "string" || !run.runId || typeof run.actorId !== "string" || !run.actorId) return reject(err("credential_unavailable"));
      if (sessions.has(run.runId)) return reject(err("credential_unavailable"));
      if (!readKey(vendor)) return reject(err("credential_unavailable"));
      if (run.transport !== undefined && run.transport !== "tcp" && run.transport !== "egress") return reject(err("credential_unavailable"));
      var viaEgress = run.transport === "egress";
      var scope = { runId: run.runId, roomId: run.roomId || null, channelId: run.channelId || null, actorId: run.actorId };
      if (usage.peek(scope, run.limits)) return reject(err("budget_exhausted"));

      var token = "agr_run_" + crypto.randomBytes(32).toString("base64url");
      var s = {
        vendor: vendor, scope: scope, limits: run.limits, tokenHash: sha256(token), expiresAt: now() + cfg.ttlMs,
        active: 0, closed: false, sockets: new Set(), upstreamReqs: new Set(), server: null, ttlTimer: null, port: 0, responses: new Set(),
      };
      function finishOpen() {
        sessions.set(run.runId, s);
        s.ttlTimer = setTimeout(function () { closeSession(s); }, cfg.ttlMs);
        if (s.ttlTimer.unref) s.ttlTimer.unref();
        var base = viaEgress ? "http://" + EGRESS_HOST : "http://127.0.0.1:" + s.port;
        var out = { port: s.port, token: token, close: function () { return closeSession(s); }, handle: function (rq, rs) { return handleEgress(s, rq, rs); } };
        if (vendor === "claude") {
          out.baseUrl = base;
          out.env = { ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: token, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
        } else {
          out.baseUrl = base + "/v1";
          out.env = { OPENAI_API_KEY: token, CODEX_API_KEY: token };
          out.codexConfigText = 'openai_base_url = "' + out.baseUrl + '"\n';
          // Spike T0c (codex 0.160): the built-in provider tries a WebSocket first. Through the egress proxy that is a CONNECT to
          // the broker host, which the proxy refuses, and codex only falls back to HTTPS after ~7 s of failed reconnects. A custom
          // provider with supports_websockets=false goes straight to POST /v1/responses.
          if (viaEgress) out.codexConfigText += 'model_provider = "aigora"\n\n[model_providers.aigora]\nname = "Aigora broker"\nbase_url = "' + out.baseUrl +
            '"\nenv_key = "OPENAI_API_KEY"\nwire_api = "responses"\nsupports_websockets = false\nrequires_openai_auth = false\n';
        }
        resolve(out);
      }
      if (viaEgress) return finishOpen();
      // headersTimeout is only enforced when the periodic connection check runs (default every 30 s): tighten it.
      var server = http.createServer({ connectionsCheckingInterval: Math.min(1000, Math.max(50, Math.floor(cfg.headerTimeoutMs / 2))) },
        function (req, res) { handle(s, req, res); });
      s.server = server;
      server.headersTimeout = cfg.headerTimeoutMs;
      server.requestTimeout = cfg.idleMs;
      server.keepAliveTimeout = 5000;
      server.maxHeadersCount = 100;
      server.on("connection", function (sock) { s.sockets.add(sock); sock.on("close", function () { s.sockets.delete(sock); }); });
      server.on("clientError", function (e, sock) {
        var line = e && e.code === "ERR_HTTP_REQUEST_TIMEOUT" ? "408 Request Timeout" : "400 Bad Request";
        try { sock.end("HTTP/1.1 " + line + "\r\nconnection: close\r\ncontent-length: 0\r\n\r\n"); } catch (_) {}
      });
      // T0c spike decision: WebSocket is forced off (supports_websockets=false in the egress codexConfigText); an upgrade
      // cannot be model-checked, so every upgrade stays refused.
      server.on("upgrade", function (req, sock) {
        audit.log({ event: "upgrade_refused", runId: s.scope.runId, vendor: s.vendor, roomId: s.scope.roomId, channelId: s.scope.channelId,
          actorId: s.scope.actorId, method: req.method, path: cleanPath(req.url), status: 426, denyReason: "upgrade" });
        try { sock.end("HTTP/1.1 426 Upgrade Required\r\nconnection: close\r\ncontent-length: 0\r\n\r\n"); } catch (_) {}
      });
      server.once("error", function () { reject(err("credential_unavailable")); });
      server.listen(0, "127.0.0.1", function () {
        s.port = server.address().port;
        finishOpen();
      });
    });
  }

  function closeSession(s) {
    if (s.closed) return s.closing;
    s.closed = true;
    s.tokenHash = null; // revoke
    if (s.ttlTimer) { clearTimeout(s.ttlTimer); s.ttlTimer = null; }
    if (sessions.get(s.scope.runId) === s) sessions.delete(s.scope.runId);
    s.upstreamReqs.forEach(function (r) { try { r.destroy(); } catch (_) {} });
    s.responses.forEach(function (r) { try { r.destroy(); } catch (_) {} });
    s.closing = new Promise(function (resolve) {
      if (!s.server) return resolve();
      try { s.server.close(function () { resolve(); }); } catch (_) { resolve(); }
      s.sockets.forEach(function (sock) { try { sock.destroy(); } catch (_) {} });
    });
    return s.closing.then(function () { usage.flush(); usage.endRun(s.scope.runId); });
  }

  // Entry point for the egress proxy: the request is absolute-form (http://broker.aigora.internal/v1/messages?beta=true). Only that
  // host is accepted; the URL is reduced to origin-form and handed to the same pipeline as the listener.
  function handleEgress(s, req, res) {
    var u = null;
    try { u = new URL(req.url); } catch (_) {}
    if (!u || u.protocol !== "http:" || u.hostname.toLowerCase() !== EGRESS_HOST || u.port || u.username || u.password) {
      req.resume();
      try { res.writeHead(403, { "content-length": "0", connection: "close" }); res.end(); } catch (_) {}
      return;
    }
    // Keep the raw path (no decoding or normalisation): URL would normalise "..", so cut it from the original string.
    var raw = req.url, i = raw.indexOf("/", "http://".length);
    var rest = i < 0 ? "/" : raw.slice(i);
    var h = rest.indexOf("#");
    req.url = h < 0 ? rest : rest.slice(0, h);
    if (s.closed) { req.resume(); try { res.writeHead(401, { "content-length": "0", connection: "close" }); res.end(); } catch (_) {} return; }
    s.responses.add(res);
    res.on("close", function () { s.responses.delete(res); });
    handle(s, req, res);
  }

  function cleanPath(u) {
    if (typeof u !== "string") return "(invalid)";
    var i = u.indexOf("?");
    var p = i < 0 ? u : u.slice(0, i), q = i < 0 ? "" : u.slice(i + 1);
    return p + (q === "beta=true" ? "?beta=true" : "");
  }

  function handle(s, req, res) {
    var ctx = {
      t0: Date.now(), method: req.method, path: cleanPath(req.url), model: null, denyReason: null, upstreamRequestId: null,
      bytesIn: 0, bytesOut: 0, usage: null, counted: false, admitted: false, parser: null, upReq: null,
    };
    var finished = false;
    res.on("close", function () {
      if (finished) return;
      finished = true;
      if (ctx.upReq) { s.upstreamReqs.delete(ctx.upReq); if (!ctx.upDone) try { ctx.upReq.destroy(); } catch (_) {} }
      var u = ctx.parser ? ctx.parser.result() : null;
      if (ctx.reservation) {
        // Nothing billed when the request never reached upstream or upstream answered with an error; otherwise (including a
        // client abort mid-stream) keep at least the reservation, or reconcile to the provider's final usage.
        var okRes = ctx.upStatus >= 200 && ctx.upStatus < 300, noBill = !ctx.forwarded || ctx.upFailed || (ctx.upStatus !== undefined && !okRes);
        var done = !!(ctx.parser && ctx.parser.complete());
        var charge = u;
        if (!noBill && !done && ctx.uncapped && ctx.parser) { // no final usage and no enforced cap: never less than the streamed-bytes estimate
          charge = Object.assign({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, u);
          charge.outputTokens = Math.max(charge.outputTokens, ctx.parser.estimatedOutputTokens());
        }
        usage.settle(s.scope, ctx.reservation, charge, done, noBill);
        ctx.reservation = null;
      } else if (u) usage.record(s.scope, u);
      if (ctx.admitted) s.active--;
      var e = { runId: s.scope.runId, vendor: s.vendor, roomId: s.scope.roomId, channelId: s.scope.channelId, actorId: s.scope.actorId,
        method: ctx.method, path: ctx.path, model: ctx.modelOk ? ctx.model : (ctx.model ? "(rejected)" : null), // client text is logged only once policy accepted it
        status: res.statusCode, denyReason: ctx.denyReason, upstreamRequestId: ctx.upstreamRequestId, bytesIn: ctx.bytesIn,
        bytesOut: ctx.bytesOut, latencyMs: Date.now() - ctx.t0 };
      if (u) { e.inputTokens = u.inputTokens; e.outputTokens = u.outputTokens; e.cacheReadTokens = u.cacheReadTokens; e.cacheWriteTokens = u.cacheWriteTokens; }
      audit.log(e);
    });

    function reply(status, bodyStr, extra, reason) {
      if (reason) ctx.denyReason = reason;
      if (res.headersSent) { res.destroy(); return; }
      var h = Object.assign({ "content-type": "application/json", "content-length": Buffer.byteLength(bodyStr || "") }, extra || {});
      res.writeHead(status, h);
      if (h.connection === "close") res.once("finish", function () { setImmediate(function () { req.destroy(); }); });
      res.end(bodyStr);
      ctx.bytesOut += Buffer.byteLength(bodyStr || "");
    }
    function deny(status, type, message, reason, extra) {
      var e = shapedError(s.vendor, status, type, message);
      reply(status, e.body, extra, reason);
    }
    function dropBody() { req.resume(); }

    var raw = req.url;
    if (typeof raw !== "string" || raw.charAt(0) !== "/") { dropBody(); return deny(400, "invalid_request_error", "bad_request", "url"); }
    var qi = raw.indexOf("?");
    var pathOnly = qi < 0 ? raw : raw.slice(0, qi), query = qi < 0 ? "" : raw.slice(qi + 1);

    // Answered locally; reveals nothing.
    if (s.vendor === "claude" && req.method === "HEAD" && pathOnly === "/api/hello" && !query) {
      dropBody();
      res.writeHead(200, { "content-length": "0" });
      return res.end();
    }

    // 1. token
    var okTok = false;
    if (s.tokenHash && now() < s.expiresAt) {
      tokenCandidates(s.vendor, req.headers).forEach(function (c) {
        var h = sha256(c);
        if (crypto.timingSafeEqual(h, s.tokenHash)) okTok = true;
      });
    }
    if (!okTok) {
      dropBody();
      if (s.expiresAt <= now()) res.once("close", function () { closeSession(s); });
      return deny(401, s.vendor === "codex" ? "invalid_api_key" : "authentication_error", "invalid token", "token", { "connection": "close" });
    }

    // 2. allowlist
    var route = ROUTES[s.vendor][req.method + " " + pathOnly];
    if (!route) { dropBody(); return deny(403, "permission_error", "path not allowed", "path"); }
    var upQuery = "";
    if (query) {
      var params = new URLSearchParams(query), bad = false, keep = [];
      params.forEach(function (v, k) { if ((route.query || []).indexOf(k) >= 0 && v === "true") keep.push(k + "=true"); else bad = true; });
      if (bad || keep.length > 1) { dropBody(); return deny(403, "permission_error", "query not allowed", "query"); }
      upQuery = keep.length ? "?" + keep[0] : "";
    }
    if (route.local === "models") {
      dropBody();
      var ids = typeof opts.listModels === "function" ? safeList(opts.listModels(s.vendor)) : null;
      if (!ids) return deny(403, "permission_error", "models listing not available", "models");
      var data = ids.map(function (id) { return s.vendor === "codex" ? { id: id, object: "model" } : { id: id, type: "model", display_name: id }; });
      return reply(200, JSON.stringify(s.vendor === "codex" ? { object: "list", data: data } : { data: data, has_more: false }));
    }

    // 3. concurrency
    if (s.active >= cfg.maxConcurrent) { dropBody(); return deny(429, "rate_limit_error", "too many concurrent requests for this run", "concurrency", { "retry-after": "1" }); }
    s.active++; ctx.admitted = true;

    // 4. body
    var declared = req.headers["content-length"] !== undefined ? Number(req.headers["content-length"]) : 0;
    if (!(declared >= 0) || declared > cfg.maxBodyBytes) {
      dropBody();
      return deny(413, "request_too_large", "request body too large", "body_size", { connection: "close" });
    }
    var enc = req.headers["content-encoding"];
    if (enc && String(enc).trim().toLowerCase() !== "identity") { dropBody(); return deny(403, "permission_error", "content-encoding not allowed", "encoding"); }
    var chunks = [], total = 0, tooBig = false;
    req.on("data", function (c) {
      if (tooBig) return;
      total += c.length;
      if (total > cfg.maxBodyBytes) {
        tooBig = true; chunks = [];
        deny(413, "request_too_large", "request body too large", "body_size", { connection: "close" });
        return;
      }
      chunks.push(c);
    });
    req.on("error", function () {});
    req.on("end", function () {
      if (tooBig || finished) return;
      var body = Buffer.concat(chunks);
      ctx.bytesIn = body.length;
      // 5. model check on a read-only parse; the original bytes are forwarded.
      var parsed;
      try { parsed = JSON.parse(body.toString("utf8")); } catch (_) { return deny(400, "invalid_request_error", "body must be JSON", "body_json"); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return deny(400, "invalid_request_error", "body must be a JSON object", "body_json");
      ctx.model = typeof parsed.model === "string" ? parsed.model : null;
      var verdict;
      try { verdict = ctx.model ? opts.checkModel(s.vendor, ctx.model) : null; } catch (_) { verdict = null; }
      ctx.modelOk = !!(verdict && verdict.ok === true);
      if (!ctx.modelOk) {
        var why = verdict && typeof verdict.error === "string" ? verdict.error.slice(0, 300) : "model not allowed";
        return deny(403, "permission_error", why, "model");
      }
      if (cfg.maxOutputTokens > 0) {
        var mt = parsed.max_tokens !== undefined ? parsed.max_tokens : parsed.max_output_tokens;
        if (typeof mt === "number" && mt > cfg.maxOutputTokens) return deny(403, "permission_error", "max tokens above policy limit", "max_tokens");
      }
      // 6. budgets
      var adm = usage.admit(s.scope, s.limits, reservationFor(parsed, body.length, pathOnly));
      if (!adm.ok) {
        var b = usageMod.budgetResponse(s.vendor);
        return reply(b.status, b.body, b.headers, "budget:" + adm.scope);
      }
      ctx.reservation = adm.reservation;
      var cap = parsed.max_tokens !== undefined ? parsed.max_tokens : parsed.max_output_tokens;
      ctx.uncapped = !(typeof cap === "number" && isFinite(cap) && cap > 0) && !/\/count_tokens$/.test(pathOnly);
      // 7. real key, read now and not kept
      var key = readKey(s.vendor);
      if (!key) return deny(503, "api_error", "credential_unavailable", "credential");
      forward(s, ctx, req, res, body, key, upQuery, pathOnly, reply, deny);
    });
  }

  // Conservative up-front debit: output = the request's own cap (or the configured default), input = body bytes / 3 (over-counts text).
  function reservationFor(parsed, bodyLen, pathOnly) {
    var mt = parsed.max_tokens !== undefined ? parsed.max_tokens : parsed.max_output_tokens;
    var out = typeof mt === "number" && isFinite(mt) && mt > 0 ? Math.ceil(mt) : cfg.defaultOutputReserve;
    if (/\/count_tokens$/.test(pathOnly)) out = 0; // counts input only
    return { inputTokens: Math.ceil(bodyLen / 3), outputTokens: out };
  }

  function safeList(v) {
    return Array.isArray(v) && v.every(function (x) { return typeof x === "string"; }) ? v.slice(0, 200) : null;
  }

  function forward(s, ctx, req, res, body, key, upQuery, pathOnly, reply, deny) {
    var up = upstreams[s.vendor];
    var h = filterHeaders(req.headers, STRIP_REQ);
    h.host = up.host;
    h["content-length"] = String(body.length);
    h["accept-encoding"] = "identity"; // lets the broker read usage; response bytes are otherwise relayed untouched
    if (s.vendor === "claude") h["x-api-key"] = key; else h.authorization = "Bearer " + key;
    key = null;
    var ro = {
      host: up.host, port: up.port, ca: up.ca, method: req.method, path: pathOnly + upQuery,
      headers: h, agent: false, rejectUnauthorized: up.rejectUnauthorized !== false,
    };
    if (up.servername || !net.isIP(up.host)) ro.servername = up.servername || up.host;
    var upReq = https.request(ro);
    ctx.forwarded = true;
    ctx.upReq = upReq;
    s.upstreamReqs.add(upReq);
    var idle = function () { upReq.destroy(); };
    upReq.setTimeout(cfg.idleMs, idle);
    upReq.on("error", function (e) {
      s.upstreamReqs.delete(upReq);
      if (ctx.upStatus === undefined) ctx.upFailed = true; // no upstream answer at all: nothing was billed
      if (res.headersSent) return res.destroy();
      deny(502, "api_error", "upstream_unavailable", "upstream:" + (e && /^[A-Z_]{3,30}$/.test(e.code || "") ? e.code : "error"));
    });
    upReq.on("response", function (ur) {
      ctx.upStatus = ur.statusCode;
      ctx.upstreamRequestId = safeId(ur.headers["request-id"] || ur.headers["x-request-id"]);
      if (ur.statusCode >= 300 && ur.statusCode < 400) { // never follow, never relay a Location
        ur.resume(); ctx.upDone = true;
        return deny(502, "api_error", "upstream_redirect_refused", "upstream_redirect");
      }
      var headers = filterHeaders(ur.headers, STRIP_RES);
      var ct = String(ur.headers["content-type"] || ""), ce = String(ur.headers["content-encoding"] || "").trim().toLowerCase();
      if (ur.statusCode >= 200 && ur.statusCode < 300 && (!ce || ce === "identity")) {
        if (/text\/event-stream/i.test(ct)) ctx.parser = usageMod.createUsageParser(s.vendor, "sse");
        else if (/json/i.test(ct)) ctx.parser = usageMod.createUsageParser(s.vendor, "json");
      }
      res.writeHead(ur.statusCode, ur.statusMessage, headers);
      res.flushHeaders();
      if (res.socket) res.socket.setNoDelay(true);
      ur.on("data", function (c) {
        ctx.bytesOut += c.length;
        if (ctx.parser) ctx.parser.push(c);
        // Uncapped request: nothing upstream bounds the output, so cut the stream once the byte estimate would break a budget.
        // Cut = abort upstream and close the client connection without writing anything (no provider-specific error event is
        // forged into a half-relayed stream); the close handler then charges max(reservation, partial usage, estimate).
        if (ctx.uncapped && ctx.reservation && ctx.parser && !ctx.parser.complete() &&
            usage.wouldExceed(s.scope, s.limits, ctx.reservation, ctx.parser.estimatedOutputTokens())) {
          ctx.denyReason = "budget_cut";
          try { upReq.destroy(); } catch (_) {}
          res.destroy();
          return;
        }
        if (!res.write(c)) { ur.pause(); res.once("drain", function () { ur.resume(); }); }
      });
      ur.on("end", function () { ctx.upDone = true; s.upstreamReqs.delete(upReq); res.end(); });
      ur.on("error", function () { ctx.upDone = true; res.destroy(); });
      ur.on("close", function () { if (!ur.complete) res.destroy(); });
    });
    upReq.end(body);
  }

  return {
    open: open,
    activeRuns: function () { return sessions.size; },
    closeAll: function () { return Promise.all(Array.from(sessions.values()).map(closeSession)); },
  };
}

module.exports = { createCredentialBroker: createCredentialBroker, ROUTES: ROUTES, DEFAULT_UPSTREAMS: DEFAULT_UPSTREAMS };

"use strict";
// Minimal OpenAI-compatible client over native fetch: GET /models and a streaming POST /chat/completions.
// Only these two endpoints are ever called. Errors carry a stable .code so callers can show a fixed message and never
// echo server text into the UI.
var sse = require("./sse");

function LocalError(code, message, status) {
  var e = new Error(message);
  e.name = "LocalModelError";
  e.code = code;
  if (status) e.status = status;
  return e;
}

function headers(apiKey, extra) {
  var h = Object.assign({ Accept: "application/json" }, extra || {});
  if (apiKey) h.Authorization = "Bearer " + apiKey;
  return h;
}

function join(baseUrl, path) { return String(baseUrl).replace(/\/+$/, "") + path; }

function networkError(e) {
  if (e && (e.name === "AbortError" || e.code === "ABORT_ERR")) return LocalError("aborted", "aborted");
  return LocalError("unreachable", "model server unreachable: " + (e && (e.cause && e.cause.code || e.code) || "network error"));
}

async function httpError(res) {
  var detail = "";
  try { detail = (await res.text()).slice(0, 400); } catch (_) {}
  var code = res.status === 404 && /model/i.test(detail) ? "model_missing" : res.status === 401 || res.status === 403 ? "auth" : "http";
  var msg = detail;
  try { var j = JSON.parse(detail); msg = (j.error && (j.error.message || j.error)) || msg; } catch (_) {}
  return LocalError(code, "HTTP " + res.status + (msg ? ": " + String(msg).slice(0, 200) : ""), res.status);
}

// Generic "not a chat model" rule: the id looks like an embedding/speech/rerank model, or the /models entry says so
// (type/object string, Ollama capabilities list, Ollama details.family bert-like).
var NON_CHAT_RE = /(embed|embedding|whisper|tts|rerank|reranker|clip|bge|e5-|gte-|nomic-embed|moderation|audio|transcri|speech)/i;
var NON_CHAT_KIND_RE = /embed|rerank|whisper|tts|stt|speech|audio|transcri|moderation|clip/i;
function isNonChat(m) {
  if (NON_CHAT_RE.test(m.id)) return true;
  if (typeof m.type === "string" && NON_CHAT_KIND_RE.test(m.type)) return true;
  if (typeof m.object === "string" && NON_CHAT_KIND_RE.test(m.object)) return true;
  if (Array.isArray(m.capabilities) && m.capabilities.length && !m.capabilities.some(function (c) { return c === "completion" || c === "chat"; })) return true;
  var fam = m.details && typeof m.details.family === "string" ? m.details.family : "";
  return /bert/i.test(fam);
}

// -> [{ id, nonChat }]. Throws LocalError (unreachable | http | auth | bad_response).
async function listModels(o) {
  var f = o.fetch || fetch;
  var ctl = new AbortController();
  var timer = setTimeout(function () { ctl.abort(); }, o.timeoutMs || 3000);
  if (timer.unref) timer.unref();
  try {
    var res = await f(join(o.baseUrl, "/models"), { method: "GET", headers: headers(o.apiKey), signal: ctl.signal });
    if (!res.ok) throw await httpError(res);
    var body = await res.json();
    var list = body && Array.isArray(body.data) ? body.data : null;
    if (!list) throw LocalError("bad_response", "unexpected /models response");
    return list.filter(function (m) { return m && typeof m.id === "string"; }).map(function (m) { return isNonChat(m) ? { id: m.id, nonChat: true } : { id: m.id }; });
  } catch (e) {
    if (e && e.name === "LocalModelError") throw e;
    if (e && e.name === "AbortError") throw LocalError("unreachable", "model server timed out");
    if (e instanceof SyntaxError) throw LocalError("bad_response", "unexpected /models response");
    throw networkError(e);
  } finally { clearTimeout(timer); }
}

// fetch-shaped request on node:http(s) with NO header/body timeouts, for answers that take many minutes (the built-in
// fetch gives up after 5 minutes without response headers). Only the parts completeOnce uses: ok, status, text(), json().
// The caller's own timer and signal are the only limits; the body is capped.
var MAX_LONG_BODY = 4 * 1024 * 1024;
function nodeFetch(url, init) {
  return new Promise(function (resolve, reject) {
    var u = new URL(url), mod = u.protocol === "https:" ? require("https") : require("http");
    var body = typeof init.body === "string" ? Buffer.from(init.body) : null;
    var hdrs = Object.assign({}, init.headers);
    if (body) hdrs["Content-Length"] = body.length;
    var req = mod.request(u, { method: init.method, headers: hdrs, signal: init.signal }, function (res) {
      var chunks = [], size = 0;
      res.on("data", function (c) { size += c.length; if (size > MAX_LONG_BODY) { req.destroy(LocalError("bad_response", "response too large")); return; } chunks.push(c); });
      res.on("error", reject);
      res.on("end", function () {
        var text = Buffer.concat(chunks).toString("utf8");
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode,
          text: function () { return Promise.resolve(text); }, json: function () { try { return Promise.resolve(JSON.parse(text)); } catch (e) { return Promise.reject(e); } } });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

// One non-streaming completion (used by the tool-capability probe and, with o.longWait, verification). -> parsed JSON body.
async function completeOnce(o) {
  var f = o.fetch || (o.longWait ? nodeFetch : fetch);
  var ctl = new AbortController();
  var timer = setTimeout(function () { ctl.abort(); }, o.timeoutMs || 60000);
  if (timer.unref) timer.unref();
  // o.signal (optional) cancels the request: the caller sees code "aborted".
  function onAbort() { ctl.abort(); }
  if (o.signal) { if (o.signal.aborted) { clearTimeout(timer); throw LocalError("aborted", "aborted"); } o.signal.addEventListener("abort", onAbort, { once: true }); }
  try {
    var res = await f(join(o.baseUrl, "/chat/completions"), {
      method: "POST", headers: headers(o.apiKey, { "Content-Type": "application/json" }),
      body: JSON.stringify(Object.assign({}, o.body, { stream: false })), signal: ctl.signal,
    });
    if (!res.ok) throw await httpError(res);
    return await res.json();
  } catch (e) {
    if (e && e.name === "LocalModelError") throw e;
    if (e instanceof SyntaxError) throw LocalError("bad_response", "unexpected completion response");
    throw networkError(e);
  } finally { clearTimeout(timer); if (o.signal) o.signal.removeEventListener("abort", onAbort); }
}

// Async generator of parsed chunk objects. Ends at [DONE] or when the body ends. A line that is not JSON is skipped
// (some servers interleave keep-alive text); an {error} chunk throws. o.signal aborts; o.idleTimeoutMs bounds silence; o.timeoutMs (optional) bounds the whole turn.
async function* streamChat(o) {
  var f = o.fetch || fetch;
  var ctl = new AbortController();
  var idle = null;
  function arm() {
    if (!o.idleTimeoutMs) return;
    clearTimeout(idle);
    idle = setTimeout(function () { ctl.abort(new Error("idle")); ctl._idle = true; }, o.idleTimeoutMs);
    if (idle.unref) idle.unref();
  }
  var total = null;
  function lost() { return ctl._idle ? LocalError("idle", "model server stopped responding") : ctl._timeout ? LocalError("timeout", "model server did not finish in time") : null; }
  if (o.timeoutMs > 0) { total = setTimeout(function () { ctl._timeout = true; ctl.abort(new Error("timeout")); }, o.timeoutMs); if (total.unref) total.unref(); }
  function onAbort() { ctl.abort(); }
  if (o.signal) { if (o.signal.aborted) { clearTimeout(total); throw LocalError("aborted", "aborted"); } o.signal.addEventListener("abort", onAbort, { once: true }); }
  var queue = [], done = false;
  try {
    arm();
    var res;
    try {
      res = await f(join(o.baseUrl, "/chat/completions"), {
        method: "POST", headers: headers(o.apiKey, { "Content-Type": "application/json", Accept: "text/event-stream" }),
        body: JSON.stringify(Object.assign({}, o.body, { stream: true })), signal: ctl.signal,
      });
    } catch (e) { throw lost() || networkError(e); }
    if (!res.ok) throw await httpError(res);
    if (!res.body) throw LocalError("bad_response", "empty response body");
    var parser = sse.createSseParser(function (data) {
      if (data.trim() === "[DONE]") { done = true; return; }
      var obj;
      try { obj = JSON.parse(data); } catch (_) { return; }
      queue.push(obj);
    });
    var decoder = new TextDecoder();
    var reader = res.body.getReader();
    try {
      for (;;) {
        var r;
        try { r = await reader.read(); } catch (e) { throw lost() || networkError(e); }
        if (r.done) break;
        arm();
        parser.push(decoder.decode(r.value, { stream: true }));
        while (queue.length) {
          var chunk = queue.shift();
          if (chunk && chunk.error) throw LocalError("stream_error", "server error: " + String(chunk.error.message || chunk.error).slice(0, 200));
          yield chunk;
        }
        if (done) break;
      }
      if (!done) {
        parser.push(decoder.decode());
        parser.end();
        while (queue.length) yield queue.shift();
      }
    } finally { try { await reader.cancel(); } catch (_) {} }
  } finally {
    clearTimeout(idle); clearTimeout(total);
    if (o.signal) o.signal.removeEventListener("abort", onAbort);
  }
}

module.exports = { listModels: listModels, completeOnce: completeOnce, streamChat: streamChat, LocalError: LocalError, isNonChat: isNonChat };

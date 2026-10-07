module.exports = require("../../extensions").select("providers/local/config", function () {
var module = { exports: {} };
"use strict";
// providers.local in daemon.json: { enabled, baseUrl, models: { chat, code, manual[] }, ... }. Disabled by default.
// Anything malformed falls back to the default for that key; only an explicit enabled:true turns the provider on.
var DEFAULTS = {
  enabled: false,
  baseUrl: "http://127.0.0.1:11434/v1",
  apiKey: "",
  server: "",                       // "" = guess from the port (ollama | lmstudio | llamacpp | vllm)
  models: { chat: "", code: "", manual: [] },   // "" = not configured: the owner picks the installed models (admin settings or daemon.json)
  contextTokens: 4096,              // history budget; Ollama's own default context is 4096
  maxTokens: 1024,
  thinking: false,                  // ask servers that support it to skip the reasoning phase (faster on CPU)
  probeTools: true,                 // one-shot function-call probe at registration; recorded, not used yet
  idleTimeoutMs: 120000,            // no bytes from the server for this long = failed turn (cold loads can take a while)
  endpoints: [],                    // extra OpenAI-compatible servers: [{ id, label, baseUrl, apiKey?, server? }]; their models are "<id>/<model>"
  titleModel: "",                   // "" = session titles come from the session's own adapter; else a local model id (incl. "<id>/<model>")
  verifiers: [],                    // extra-endpoint models ("<id>/<model>") that may verify a turn's result; [] = verification is unchanged
  verifyMode: "single",             // "single" | "cross" (cross = every available verifier checks the same result)
};
var ENDPOINT_ID_RE = /^[a-z0-9][a-z0-9-]{0,19}$/;
var MAX_ENDPOINTS = 8;
var ALIAS_RE = /^[a-z0-9ㄱ-힣-]{2,20}$/;
var MAX_ALIASES = 6;
// Names the router already owns (MENTION_ALIASES + AT_ONLY_ALIASES + agent ids): an endpoint may not claim them.
var BUILTIN_NAMES = ["claude", "claude-code", "claudecode", "클로드", "codex", "gpt", "gpt-codex", "코덱스", "local", "로컬", "ollama", "올라마", "auto", "자동"];
var MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,99}$/;

function isObj(v) { return !!v && typeof v === "object" && !Array.isArray(v); }
function modelName(v, d) { return typeof v === "string" && MODEL_RE.test(v) ? v : d; }
function posInt(v, d) { return Number.isInteger(v) && v >= 1 ? v : d; }

// -> normalised URL string, or null when it is not a plain http(s) URL without credentials/query/hash.
function parseBaseUrl(v) {
  if (typeof v !== "string") return null;
  var s = v.trim().replace(/\/+$/, "");
  try {
    var u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password || u.search || u.hash) return null;
    return s;
  } catch (_) { return null; }
}
function msInt(v) { return Number.isInteger(v) && v >= 1000 && v <= 3600000 ? v : null; }  // null = inherit the global/engine default
function workRoundsOf(v) { return Number.isInteger(v) && v >= 1 && v <= 12 ? v : 6; }

// Valid, de-duplicated aliases (at most MAX_ALIASES). Anything else is dropped.
function cleanAliases(v) {
  var out = [];
  if (!Array.isArray(v)) return out;
  v.forEach(function (a) { if (out.length < MAX_ALIASES && typeof a === "string" && ALIAS_RE.test(a) && out.indexOf(a) === -1) out.push(a); });
  return out;
}
// Strict check for the admin save: -> null, or a Korean message naming the first problem (shape or collision).
function aliasProblem(list) {
  var ids = {}, owner = {};
  list.forEach(function (e) { ids[e.id] = true; });
  for (var i = 0; i < list.length; i++) {
    var e = list[i], as = e.aliases;
    if (as === undefined) continue;
    if (!Array.isArray(as) || as.length > MAX_ALIASES) return "별칭은 최대 " + MAX_ALIASES + "개까지 쓸 수 있어요.";
    for (var j = 0; j < as.length; j++) {
      var a = as[j];
      if (typeof a !== "string" || !ALIAS_RE.test(a)) return "별칭은 영문 소문자, 숫자, 한글, -만 쓸 수 있고 2~20자여야 해요: " + String(a).slice(0, 20);
      if (BUILTIN_NAMES.indexOf(a) !== -1) return "'" + a + "'은(는) 기본 AI 이름이라 별칭으로 쓸 수 없어요.";
      if (ids[a] && a !== e.id) return "'" + a + "'은(는) 다른 서버의 ID와 같아서 별칭으로 쓸 수 없어요.";
      if (owner[a] !== undefined && owner[a] !== e.id) return "'" + a + "' 별칭을 다른 서버가 이미 쓰고 있어요.";
      owner[a] = e.id;
    }
  }
  return null;
}

function resolveBaseUrl(v) { return parseBaseUrl(v) || DEFAULTS.baseUrl; }

// Invalid entries are dropped (never defaulted to the primary server: a bad URL must not silently route elsewhere).
// Duplicate ids keep the first one.
function resolveEndpoints(v) {
  var out = [];
  if (!Array.isArray(v)) return out;
  v.forEach(function (e) {
    if (out.length >= MAX_ENDPOINTS || !isObj(e) || typeof e.id !== "string" || !ENDPOINT_ID_RE.test(e.id)) return;
    var url = parseBaseUrl(e.baseUrl);
    if (!url || out.some(function (x) { return x.id === e.id; })) return;
    var label = typeof e.label === "string" ? e.label.trim().slice(0, 40) : "";
    out.push({
      id: e.id, label: label || e.id, baseUrl: url, apiKey: typeof e.apiKey === "string" ? e.apiKey : "", server: typeof e.server === "string" ? e.server : "", routable: e.routable === true,
      pickable: e.pickable !== false, pickModel: typeof e.pickModel === "string" && MODEL_RE.test(e.pickModel) ? e.pickModel : "",
      aliases: cleanAliases(e.aliases), canWork: e.canWork === true, privateAllowed: e.privateAllowed === true, workRounds: workRoundsOf(e.workRounds),
      idleTimeoutMs: msInt(e.idleTimeoutMs), timeoutMs: msInt(e.timeoutMs),
    });
  });
  // Defence for hand-edited daemon.json: an alias that is built in, another endpoint's id, or already taken is dropped.
  var ids = {}, taken = {};
  out.forEach(function (e) { ids[e.id] = true; });
  out.forEach(function (e) {
    e.aliases = e.aliases.filter(function (a) {
      if (BUILTIN_NAMES.indexOf(a) !== -1 || (ids[a] && a !== e.id) || (taken[a] && taken[a] !== e.id)) return false;
      taken[a] = e.id; return true;
    });
  });
  return out;
}

var MAX_VERIFIERS = 8;
// Only "<endpoint id>/<model>" values count (a verifier never runs on the primary server); invalid entries are dropped, duplicates keep the first.
function resolveVerifiers(v) {
  var out = [];
  if (!Array.isArray(v)) return out;
  v.forEach(function (x) {
    if (out.length >= MAX_VERIFIERS || typeof x !== "string" || !MODEL_RE.test(x)) return;
    var i = x.indexOf("/");
    if (i < 1 || !ENDPOINT_ID_RE.test(x.slice(0, i)) || !MODEL_RE.test(x.slice(i + 1)) || out.indexOf(x) !== -1) return;
    out.push(x);
  });
  return out;
}
// The optional research model: one "<endpoint id>/<model>" or "" (none). Anything else is dropped.
function resolveResearchModel(v) { return resolveVerifiers([v])[0] || ""; }
function resolveVerifyMode(v) { return v === "cross" ? "cross" : "single"; }

function resolveLocalConfig(raw) {
  var c = isObj(raw) ? raw : {};
  var m = isObj(c.models) ? c.models : {};
  var manual = Array.isArray(m.manual)
    ? m.manual.filter(function (x) { return typeof x === "string" && MODEL_RE.test(x); })
    : DEFAULTS.models.manual.slice();
  return {
    enabled: c.enabled === true,
    baseUrl: resolveBaseUrl(c.baseUrl),
    apiKey: typeof c.apiKey === "string" ? c.apiKey : "",
    server: typeof c.server === "string" ? c.server : "",
    models: { chat: modelName(m.chat, DEFAULTS.models.chat), code: modelName(m.code, DEFAULTS.models.code), manual: manual },
    contextTokens: posInt(c.contextTokens, DEFAULTS.contextTokens),
    maxTokens: posInt(c.maxTokens, DEFAULTS.maxTokens),
    thinking: c.thinking === true,
    probeTools: c.probeTools !== false,
    idleTimeoutMs: posInt(c.idleTimeoutMs, DEFAULTS.idleTimeoutMs),
    endpoints: resolveEndpoints(c.endpoints),
    titleModel: modelName(c.titleModel, DEFAULTS.titleModel),
    verifiers: resolveVerifiers(c.verifiers),
    verifyMode: resolveVerifyMode(c.verifyMode),
    researchModel: resolveResearchModel(c.researchModel),
  };
}

// Read on every call so a daemon.json edit applies without code changes; cheap (one small file).
function loadLocalConfig() {
  var raw = null;
  try {
    var all = require("../../config").loadConfig();
    raw = all && all.providers && all.providers.local;
  } catch (_) { raw = null; }
  // Admin-settings overlay (endpoints, titleModel) from the overrides store; daemon.json stays authoritative for the rest.
  try { raw = require("./overrides").overlay(raw); } catch (_) { /* store unreadable: daemon.json only */ }
  return resolveLocalConfig(raw);
}

// Every model name the provider may run: chat, code, then the manual-only ones.
function allowedModels(cfg) {
  var out = [];
  if (cfg.models.chat) out.push(cfg.models.chat);
  if (cfg.models.code && out.indexOf(cfg.models.code) === -1) out.push(cfg.models.code);
  cfg.models.manual.forEach(function (x) { if (out.indexOf(x) === -1) out.push(x); });
  return out;
}

// Where a model runs. Primary-list names win; otherwise "<endpointId>/<model>" selects an extra endpoint.
// -> { endpoint: null | {id,label,baseUrl,apiKey,server}, baseUrl, apiKey, server, model } (model = the name the server knows).
function targetFor(cfg, value) {
  if (typeof value === "string" && allowedModels(cfg).indexOf(value) === -1) {
    var i = value.indexOf("/");
    var ep = i > 0 ? cfg.endpoints.filter(function (e) { return e.id === value.slice(0, i); })[0] : null;
    var name = i > 0 ? value.slice(i + 1) : "";
    if (ep && MODEL_RE.test(name)) return { endpoint: ep, baseUrl: ep.baseUrl, apiKey: ep.apiKey, server: ep.server, model: name };
  }
  return { endpoint: null, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, server: cfg.server, model: value };
}

var CODE_RE = /```|\b(?:code|coding|implement|refactor|bug|function|script|compile|regex|sql|snippet|unit\s+tests?)\b|코드|구현|리팩터|버그|함수|스크립트|컴파일|정규식|테스트\s?코드/i;
// Code drafts use the code model, everything else the chat model. 14B models are never picked automatically.
function modelForRequest(text, cfg) {
  return CODE_RE.test(typeof text === "string" ? text : "") ? (cfg.models.code || cfg.models.chat) : (cfg.models.chat || cfg.models.code);
}

module.exports = { aliasProblem: aliasProblem, ALIAS_RE: ALIAS_RE, MAX_ALIASES: MAX_ALIASES, BUILTIN_NAMES: BUILTIN_NAMES, MAX_VERIFIERS: MAX_VERIFIERS, resolveVerifiers: resolveVerifiers, resolveVerifyMode: resolveVerifyMode, resolveResearchModel: resolveResearchModel, MODEL_RE: MODEL_RE, ENDPOINT_ID_RE: ENDPOINT_ID_RE, MAX_ENDPOINTS: MAX_ENDPOINTS, resolveEndpoints: resolveEndpoints, modelName: modelName, DEFAULTS: DEFAULTS, resolveLocalConfig: resolveLocalConfig, loadLocalConfig: loadLocalConfig, allowedModels: allowedModels, targetFor: targetFor, modelForRequest: modelForRequest };

return module.exports;
});

"use strict";
// Probe + cached state for the local provider. refresh() asks /models (cheap) at most once per ttl and works out
// which of the configured models are installed; the picker, the status endpoint, the usage row and the router all
// read snapshot()/isReady() from here. The tool-capability probe (one function-call request) runs once per
// server+model in the background; its result is recorded as tools: "function" | "none" | "unknown" and is NOT used
// by anything in this release (chat-only).
var cfgMod = require("./config");
var client = require("./client");
var quirksMod = require("./quirks");

var MAX_EXTRA_MODELS = 50;
var ROLE_LABEL = { chat: "대화", code: "코드 초안", manual: "수동 선택" };
var ROLE_LABEL_KEY = { chat: "aiPicker.modelChat", code: "aiPicker.modelCode", manual: "aiPicker.modelManual" };

function createLocalState(opts) {
  opts = opts || {};
  var getConfig = opts.getConfig || cfgMod.loadLocalConfig;
  var f = opts.fetch;
  var ttl = opts.ttlMs == null ? 15000 : opts.ttlMs;
  var snap = null, at = 0, inFlight = null, toolProbeKey = null, toolProbeResult = "unknown";

  function picker(cfg, installed) {
    var out = [];
    function add(id, role) {
      if (installed.indexOf(id) === -1 || out.some(function (m) { return m.value === id; })) return;
      out.push({ value: id, displayName: id + " · " + ROLE_LABEL[role], description: role === "manual" ? "매우 느려요. 직접 고를 때만 사용해요." : "내 컴퓨터에서 실행해요. 느릴 수 있어요.",
        displayNameKey: ROLE_LABEL_KEY[role], displayNameParams: { model: id },
        descriptionKey: role === "manual" ? "aiPicker.modelVerySlow" : "aiPicker.modelSlow",
        role: role, slow: role === "manual", supportsEffort: false, supportsThinking: false });
    }
    add(cfg.models.chat, "chat");
    add(cfg.models.code, "code");
    cfg.models.manual.forEach(function (id) { add(id, "manual"); });
    return out;
  }

  async function probeOnce() {
    var cfg = getConfig();
    var started = Date.now();
    var base = { enabled: cfg.enabled, ready: false, reason: null, models: [], tools: toolProbeResult, latencyMs: null, checkedAt: started, server: quirksMod.detectServer(cfg.baseUrl, cfg.server) };
    if (!cfg.enabled) return Object.assign(base, { reason: "disabled" });
    // Fresh install: no model is preselected. Enabled but nothing chosen (and no extra endpoint) = needs configuring.
    if (!cfgMod.allowedModels(cfg).length && !cfg.endpoints.length) return Object.assign(base, { reason: "not_configured" });
    var list = null, primaryErr = null, primaryCount = 0;
    try {
      list = await client.listModels({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, fetch: f, timeoutMs: opts.timeoutMs || 3000 });
    } catch (e) { primaryErr = e; }
    var models = [];
    if (list) {
      var installed = list.map(function (m) { return m.id; });
      models = picker(cfg, installed);
      primaryCount = models.length;
      base.installed = installed.length;
    }
    // Extra endpoints: each is probed on its own; one being down never hides the others' models.
    var extra = await Promise.all(cfg.endpoints.map(function (ep) {
      return client.listModels({ baseUrl: ep.baseUrl, apiKey: ep.apiKey, fetch: f, timeoutMs: opts.timeoutMs || 3000 })
        .then(function (l) { return { ep: ep, list: l }; }, function () { return { ep: ep, list: [] }; });
    }));
    // Non-chat models (embeddings, speech, rerankers) never reach the picker; a model named in the config stays.
    var explicit = cfgMod.allowedModels(cfg).concat(cfg.titleModel ? [cfg.titleModel] : []);
    extra.forEach(function (r) {
      r.list.filter(function (m) { return !m.nonChat || explicit.indexOf(r.ep.id + "/" + m.id) !== -1; })
        .map(function (m) { return m.id; }).filter(function (id) { return cfgMod.MODEL_RE.test(id); }).slice(0, MAX_EXTRA_MODELS).forEach(function (id) {
        var value = r.ep.id + "/" + id;
        if (models.some(function (m) { return m.value === value; })) return;
        models.push({ value: value, displayName: id + " · " + r.ep.label, description: "내 컴퓨터에서 실행해요.", descriptionKey: "aiPicker.modelLocal", role: "chat", slow: false, supportsEffort: false, supportsThinking: false });
      });
    });
    base.latencyMs = Date.now() - started;
    if (primaryErr && !models.length) return Object.assign(base, { reason: primaryErr.code === "unreachable" ? "unreachable" : "http_error" });
    if (!models.length) return Object.assign(base, { reason: base.installed ? "missing_models" : "no_models" });
    base.models = models;
    base.ready = true;
    if (primaryCount) scheduleToolProbe(cfg, models[0].value);
    base.tools = toolProbeResult;
    return base;
  }

  // Fire-and-forget; never throws, never blocks readiness.
  function scheduleToolProbe(cfg, model) {
    if (!cfg.probeTools) return;
    var key = cfg.baseUrl + "|" + model;
    if (toolProbeKey === key) return;
    toolProbeKey = key;
    toolProbeResult = "unknown";
    client.completeOnce({
      baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, fetch: f, timeoutMs: opts.toolProbeTimeoutMs || 90000,
      body: {
        model: model, max_tokens: 64, temperature: 0, messages: [{ role: "user", content: "What time is it? Use the tool." }],
        tools: [{ type: "function", function: { name: "get_time", description: "Get the current time", parameters: { type: "object", properties: {}, required: [] } } }],
        tool_choice: "auto",
      },
    }).then(function (body) {
      var calls = body && body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.tool_calls;
      var ok = Array.isArray(calls) && calls.length > 0 && calls[0] && calls[0].function && calls[0].function.name === "get_time";
      if (ok) { try { JSON.parse(calls[0].function.arguments || "{}"); } catch (_) { ok = false; } }
      toolProbeResult = ok ? "function" : "none";
      if (snap) snap.tools = toolProbeResult;
    }).catch(function () { toolProbeResult = "unknown"; toolProbeKey = null; });
  }

  async function refresh(force) {
    if (!force && snap && Date.now() - at < ttl) return snap;
    if (inFlight) return inFlight;
    inFlight = probeOnce().then(function (s) { snap = s; at = Date.now(); return s; }).finally(function () { inFlight = null; });
    return inFlight;
  }

  return {
    refresh: refresh,
    snapshot: function () { return snap || { enabled: getConfig().enabled, ready: false, reason: "unchecked", models: [], tools: "unknown" }; },
    // Sync check for code that cannot await: true only when the last probe succeeded. Kicks a background refresh when stale.
    isReady: function () {
      if (!snap || Date.now() - at >= ttl) refresh(false).catch(function () {});
      return !!(snap && snap.ready && getConfig().enabled);
    },
    reset: function () { snap = null; at = 0; toolProbeKey = null; toolProbeResult = "unknown"; },
  };
}

// Usage-panel row: local inference has no quota, so it is a status-only card ("quota": "not_reported").
// null when the provider is off: the panel then shows nothing about it.
function usageRow(snap) {
  if (!snap || !snap.enabled) return null;
  return {
    id: "local", label: "로컬 (Ollama)", color: "#7a8b99", status: snap.ready ? "ready" : "unavailable",
    quota: "not_reported", session: null, weekly: null,
    messageKey: snap.ready ? "aiUsage.localReady" : "aiUsage.localUnavailable",
    message: snap.ready ? "로컬 · 제한 없음 (내 컴퓨터에서 실행하므로 답이 느릴 수 있어요)" : "로컬 모델 서버에 연결할 수 없어요. Ollama가 실행 중인지 확인해 주세요.",
  };
}

// Usage-panel row for the extra endpoints (a ChatGPT bridge, ...), built from the config: status-only, no URL, no key.
// null when the provider is off or no extra endpoint is configured.
function endpointsUsageRow(snap, cfg) {
  var st = publicStatus(snap, cfg);
  if (!st.enabled || !st.endpoints.length) return null;
  var up = st.endpoints.filter(function (e) { return e.ready; });
  return {
    id: "endpoints", label: "외부 모델", color: "#8e8ea0", status: up.length ? "ready" : "unavailable",
    quota: "not_reported", session: null, weekly: null,
    messageParts: st.endpoints.map(function (e) { return { key: e.ready ? "aiUsage.endpointReady" : "aiUsage.endpointUnavailable", params: { label: e.label } }; }),
    message: st.endpoints.map(function (e) { return e.label + (e.ready ? " 사용 가능" : " 연결 안 됨"); }).join(" · "),
  };
}

// What the browser may know: no URL, no key.
// endpoints: the configured extra servers (no URL, no key). ready = the last probe lists a chat model for it;
// pickModel = the owner's choice when the probe lists it, else the first listed chat model.
function publicStatus(snap, cfg) {
  snap = snap || {};
  var eps = [];
  try { eps = (cfg || require("./config").loadLocalConfig()).endpoints || []; } catch (_) { eps = []; }
  var models = snap.models || [];
  return {
    endpoints: eps.map(function (e) {
      var listed = models.map(function (m) { return m.value; }).filter(function (v) { return v.indexOf(e.id + "/") === 0; }).map(function (v) { return v.slice(e.id.length + 1); });
      return { id: e.id, label: e.label, pickable: e.pickable, canWork: e.canWork, privateAllowed: e.privateAllowed === true, aliases: e.aliases.slice(), ready: !!snap.ready && listed.length > 0,
        pickModel: e.pickModel && listed.indexOf(e.pickModel) !== -1 ? e.pickModel : (listed[0] || "") };
    }),
    enabled: !!snap.enabled, ready: !!snap.ready, reason: snap.reason || null, server: snap.server || null, tools: snap.tools || "unknown",
    models: (snap.models || []).map(function (m) { return { value: m.value, label: m.displayName, displayNameKey: m.displayNameKey, displayNameParams: m.displayNameParams, role: m.role, slow: !!m.slow }; }),
  };
}

var shared = null;
function getLocalState() { return shared || (shared = createLocalState()); }
function setLocalStateForTest(s) { shared = s; }

module.exports = { usageRow: usageRow, endpointsUsageRow: endpointsUsageRow, publicStatus: publicStatus, createLocalState: createLocalState, getLocalState: getLocalState, setLocalStateForTest: setLocalStateForTest, ROLE_LABEL: ROLE_LABEL };

module.exports = require("./extensions").select("model-policy", function () {
var module = { exports: {} };
// model-policy.js - owner-approved Aigora model budget policy.
//
//   codex  -> exactly gpt-6.1-sol, effort low (UI "Light") or medium, default medium
//   claude -> exactly claude-sonnet-5-5, effort low or medium, default medium
//
// Anything else is refused with a reason. Values that are merely stale (a
// persisted session model, a saved default effort) are normalised down to the
// pinned model / default effort at query start; values somebody asked for on
// purpose (a change request, loop settings, a declared agent) are refused, so
// nothing is silently raised or switched to another model. Vendors without a

var POLICY = {
  codex: { model: "gpt-6.1-sol", efforts: ["low", "medium"], defaultEffort: "medium" },
  claude: { model: "claude-sonnet-5-5", efforts: ["low", "medium"], defaultEffort: "medium" },
};

function entry(vendor) {
  return Object.prototype.hasOwnProperty.call(POLICY, vendor) ? POLICY[vendor] : null;
}

function vendors() { return Object.keys(POLICY); }

function unknownVendor(vendor) {
  return { ok: false, error: "Model policy: no approved model for vendor \"" + vendor + "\"; refusing to run it." };
}

// Local models (providers.local, chat-only) are governed by the daemon.json list, not a single pinned model:
// chat, code and the manual-only entries. Efforts do not apply. Disabled = refused.
function localPolicy() {
  var c = require("./providers/local/config");
  var cfg = c.loadLocalConfig();
  var models = c.allowedModels(cfg);
  // Extra-endpoint models ("<id>/<model>") are allowed only while the last probe listed them on a configured endpoint.
  if (cfg.endpoints.length) {
    require("./providers/local/state").getLocalState().snapshot().models.forEach(function (m) {
      if (models.indexOf(m.value) === -1 && c.targetFor(cfg, m.value).endpoint) models.push(m.value);
    });
  }
  return { cfg: cfg, models: models };
}
function localDisabled() { return { ok: false, error: "Model policy: local models are not enabled." }; }

// Explicit model request for a vendor.
function checkModel(vendor, model) {
  if (vendor === "local") {
    var lp = localPolicy();
    if (!lp.cfg.enabled) return localDisabled();
    return lp.models.indexOf(model) >= 0 ? { ok: true } : { ok: false, error: "Model policy: local sessions must use one of " + lp.models.join(", ") + " (requested \"" + model + "\")." };
  }
  var p = entry(vendor);
  if (!p) return unknownVendor(vendor);
  if (model === p.model) return { ok: true };
  return { ok: false, error: "Model policy: " + vendor + " sessions must use " + p.model + " (requested \"" + model + "\")." };
}

// Explicit effort request for a vendor.
function checkEffort(vendor, effort) {
  if (vendor === "local") return { ok: true };
  var p = entry(vendor);
  if (!p) return unknownVendor(vendor);
  if (p.efforts.indexOf(effort) >= 0) return { ok: true };
  return { ok: false, error: "Model policy: " + vendor + " effort must be " + p.efforts.join(" or ") + " (requested \"" + effort + "\")." };
}

// Vendor-less settings (server/project defaults): accept only what every
// governed vendor accepts.
function checkModelAny(model) {
  var ok = vendors().some(function (v) { return POLICY[v].model === model; });
  if (ok) return { ok: true };
  return { ok: false, error: "Model policy: only " + vendors().map(function (v) { return POLICY[v].model; }).join(" or ") + " may be set as a default (requested \"" + model + "\")." };
}

function checkEffortAny(effort) {
  var bad = vendors().map(function (v) { return checkEffort(v, effort); }).filter(function (r) { return !r.ok; })[0];
  return bad || { ok: true };
}

// Lower a stored/default effort to something every vendor allows.
function normalizeEffortAny(effort) {
  return checkEffortAny(effort).ok ? effort : POLICY.claude.defaultEffort;
}

// Resolve the model/effort a query may actually run with.
//   explicitModel/explicitEffort: chosen on purpose (loop settings, declared agent) -> refused if not allowed
//   model/effort: inherited (session, project default) -> normalised to the pinned model / default effort
// Returns { ok, model, effort, notes } or { ok:false, error }.
function resolveQuery(vendor, req) {
  if (vendor === "local") {
    var lp = localPolicy();
    if (!lp.cfg.enabled) return localDisabled();
    req = req || {};
    if (!lp.models.length) return { ok: false, error: "Model policy: no local model is configured (set providers.local.models in daemon.json or the admin settings)." };
    if (req.explicitModel && lp.models.indexOf(req.explicitModel) < 0) return checkModel("local", req.explicitModel);
    var model = req.explicitModel || (lp.models.indexOf(req.model) >= 0 ? req.model : lp.models[0]);
    return { ok: true, model: model, effort: "medium", notes: req.model && req.model !== model ? ["model " + req.model + " -> " + model] : [] };
  }
  var p = entry(vendor);
  if (!p) return unknownVendor(vendor);
  req = req || {};
  var notes = [];
  if (req.explicitModel) {
    var m = checkModel(vendor, req.explicitModel);
    if (!m.ok) return m;
  }
  if (req.explicitEffort) {
    var e = checkEffort(vendor, req.explicitEffort);
    if (!e.ok) return e;
  }
  if (req.model && req.model !== p.model) notes.push("model " + req.model + " -> " + p.model);
  var effort = req.explicitEffort || req.effort;
  if (p.efforts.indexOf(effort) < 0) {
    if (effort) notes.push("effort " + effort + " -> " + p.defaultEffort);
    effort = p.defaultEffort;
  }
  return { ok: true, model: p.model, effort: effort, notes: notes };
}

// suffix, so there is no separate effort flag and no Pro/other-model fallback.


// -> { ok, model } or { ok:false, error }. No model = the default (Flash Low;
// Medium/High only when chosen explicitly, never inferred). An effort,
// if given, must match the model's suffix (never a contradictory pair).


// Pickers: only the approved model, with only the approved efforts. The entry
// keeps the vendor's own metadata when the vendor lists the model; otherwise
// the approved model is offered as a minimal entry so the picker is never empty.
function filterModels(vendor, models) {
  var p = entry(vendor);
  if (!p) return models;
  var found = (Array.isArray(models) ? models : []).filter(function (m) {
    return m && (typeof m === "string" ? m : m.value) === p.model;
  })[0];
  var base = found && typeof found === "object" ? found : { value: p.model, displayName: p.model, supportsEffort: true };
  return [Object.assign({}, base, { supportedEffortLevels: p.efforts.slice() })];
}

// Child agents/threads run under the provider's own model and effort settings,
// which cannot be pinned per child, so they are switched off instead.
var CLAUDE_CHILD_GUARD = { disallowedTools: ["Agent", "Task", "Skill"], subagentModelEnv: "CLAUDE_CODE_SUBAGENT_MODEL" };
// Pins for the CLI's internal small/fast model calls; values come from the policy, never the host env.
function claudeChildEnv() {
  var m = POLICY.claude.model;
  return { CLAUDE_CODE_SUBAGENT_MODEL: m, ANTHROPIC_DEFAULT_HAIKU_MODEL: m, ANTHROPIC_SMALL_FAST_MODEL: m };
}
// Subagents are off through the features; Codex >= 0.124 rejects agents.max_depth below 1 and then refuses to start.
var CODEX_CHILD_GUARD_CONFIG = { features: { multi_agent: false, multi_agent_v2: false }, agents: { max_depth: 1 } };

module.exports = {
  POLICY: POLICY,
  filterModels: filterModels,
  CLAUDE_CHILD_GUARD: CLAUDE_CHILD_GUARD,
  claudeChildEnv: claudeChildEnv,
  CODEX_CHILD_GUARD_CONFIG: CODEX_CHILD_GUARD_CONFIG,


  checkModel: checkModel,
  checkEffort: checkEffort,
  checkModelAny: checkModelAny,
  checkEffortAny: checkEffortAny,
  normalizeEffortAny: normalizeEffortAny,
  resolveQuery: resolveQuery,
};

return module.exports;
});

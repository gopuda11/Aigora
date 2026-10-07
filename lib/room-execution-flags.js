module.exports = require("./extensions").select("room-execution-flags", function () {
var module = { exports: {} };
"use strict";
// roomExecution config: contain room-context agent turns (see docs/superpowers/specs/2026-10-03-room-turn-containment.md).
//     broker: { enabled: false (literal false only = explicit opt-out), ttlMs: int, limits: { run|actorDaily|roomDaily|globalDaily: { requests|inputTokens|outputTokens: int > 0 } } } }
// Default (no section, nothing set, malformed or unreadable config): room turns of claude and codex run CONTAINED with
// credentialSource api_key. Per agent: true = contained; false = that agent is NOT available for room turns (refused, not
// unconfined); absent = contained. The only way to run room turns unconfined is the explicit boolean roomExecution.unconfined
// === true (UNSAFE); an explicit per-agent true/false still wins over it, so a stricter setting is never loosened.
// Anything malformed is treated as the safe default (contained, api_key).
var DEFAULT_ENV = { claude: "ANTHROPIC_API_KEY", codex: "OPENAI_API_KEY" };
// Names the contained CLI reads its key from (Codex accepts either).
var CLI_ENV = { claude: ["ANTHROPIC_API_KEY"], codex: ["OPENAI_API_KEY", "CODEX_API_KEY"] };
function section() {
  try {
    var s = require("./config").loadConfig();
    s = s && s.roomExecution;
    return s && typeof s === "object" && !Array.isArray(s) ? s : null;
  } catch (_) { return null; }
}
function own(o, k) { return !!o && typeof o === "object" && !Array.isArray(o) && Object.prototype.hasOwnProperty.call(o, k); }
// "contained" | "unavailable" | "unconfined" for claude/codex room turns; null for any other agent (not governed here).
function roomExecutionMode(agent) {
  if (agent !== "claude" && agent !== "codex") return null;
  var s = section();
  if (own(s, agent)) {
    if (s[agent] === true) return "contained";
    if (s[agent] === false) return "unavailable";
  }
  return own(s, "unconfined") && s.unconfined === true ? "unconfined" : "contained";
}
// True when the room-turn sandbox may be prepared for this agent (consumed by private-agent-scope as isEnabled).
// only the literal boolean true enables them (default off, anything else is off).
var WORKER_KEYS = { endpoint: "endpoints" };
function isRoomExecutionEnabled(agent) {
  if (Object.prototype.hasOwnProperty.call(WORKER_KEYS, agent)) { var s = section(), k = WORKER_KEYS[agent]; return own(s, k) && s[k] === true; }
  return roomExecutionMode(agent) === "contained";
}
// Loud startup lines for risky or restrictive settings (daemon start). Returns the lines it logged.
function startupWarnings(log) {
  var out = [], s = section();
  if (own(s, "unconfined") && s.unconfined === true) {
    out.push("[room-execution] WARNING: roomExecution.unconfined is true. UNSAFE: room turns run UNCONFINED as the host user (any room member can read and change the host's files and credentials) except for an agent set explicitly to true/false. Remove roomExecution.unconfined unless this host is single-user and trusted.");
  }
  ["claude", "codex"].forEach(function (a) {
    if (own(s, a) && s[a] === false) out.push("[room-execution] roomExecution." + a + " is false: " + a + " is NOT available for room turns (refused; it does not run unconfined).");
  });
  if (!brokerEnabled()) {
    out.push("[room-execution] WARNING: roomExecution.broker.enabled is false. API-key runs get the real provider key inside the sandbox (readable by the agent, and by the model through its tools). Remove roomExecution.broker.enabled unless you accept that.");
  }
  if (brokerLimitsIgnored()) out.push("[room-execution] roomExecution.broker has invalid limits or ttlMs; those entries are ignored and the defaults apply.");

  out.forEach(function (l) { (log || console.warn)(l); });
  return out;
}

// Credential broker (spec 2026-10-04-credential-broker-design.md 3.7). On by default in api_key mode; only the literal boolean false
// turns it off (key injection, logged at every run and at start).
function brokerSection() { var s = section(); return own(s, "broker") && s.broker && typeof s.broker === "object" && !Array.isArray(s.broker) ? s.broker : null; }
function brokerEnabled() { var b = brokerSection(); return !(own(b, "enabled") && b.enabled === false); }
var LIMIT_SCOPES = ["run", "actorDaily", "roomDaily", "globalDaily"], LIMIT_METRICS = ["requests", "inputTokens", "outputTokens"];
// Strict: only known scopes and metrics with positive safe integers survive. Everything else is dropped, so the broker default
// applies (never "unlimited"). Returns undefined when nothing valid is configured.
function parseBrokerLimits(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { limits: undefined, ignored: raw !== undefined };
  var out = {}, ignored = false, any = false;
  Object.keys(raw).forEach(function (sc) {
    if (LIMIT_SCOPES.indexOf(sc) === -1 || !raw[sc] || typeof raw[sc] !== "object" || Array.isArray(raw[sc])) { ignored = true; return; }
    Object.keys(raw[sc]).forEach(function (m) {
      var v = raw[sc][m];
      if (LIMIT_METRICS.indexOf(m) === -1 || !Number.isSafeInteger(v) || v <= 0) { ignored = true; return; }
      (out[sc] = out[sc] || {})[m] = v; any = true;
    });
  });
  return { limits: any ? out : undefined, ignored: ignored };
}
function brokerLimits() { var b = brokerSection(); return own(b, "limits") ? parseBrokerLimits(b.limits).limits : undefined; }
// Token lifetime in ms (1 minute to 24 h); undefined = broker default.
function brokerTtlMs() { var b = brokerSection(); return own(b, "ttlMs") && Number.isInteger(b.ttlMs) && b.ttlMs >= 60000 && b.ttlMs <= 86400000 ? b.ttlMs : undefined; }
function brokerLimitsIgnored() {
  var b = brokerSection();
  return (own(b, "limits") && parseBrokerLimits(b.limits).ignored) || (own(b, "ttlMs") && brokerTtlMs() === undefined);
}
// The env var name the api_key mode reads for this agent (for admin hints).
function apiKeyEnvName(agent) {
  var s = section();
  return own(s, "apiKeyEnv") && own(s.apiKeyEnv, agent) && /^[A-Z][A-Z0-9_]*$/.test(String(s.apiKeyEnv[agent])) ? s.apiKeyEnv[agent] : DEFAULT_ENV[agent];
}
// Hard safety limit only (default = the maximum): the run scheduler (scheduler.* config) is the effective limiter and queues.
function maxRoomConcurrent() {
  var s = section(), v = s && s.maxConcurrent;
  return Number.isInteger(v) && v >= 1 && v <= 32 ? v : 32;
}
function credentialSource() { return "api_key"; }
// The provider key for api_key mode: roomExecution.apiKeys.<agent>, else the env var named by roomExecution.apiKeyEnv.<agent>
// (default ANTHROPIC_API_KEY / OPENAI_API_KEY). Returns "" when none; never logged.
function apiKey(agent, env) {
  var s = section();
  if (own(s, "apiKeys") && own(s.apiKeys, agent) && typeof s.apiKeys[agent] === "string" && s.apiKeys[agent].trim()) return s.apiKeys[agent].trim();
  var name = own(s, "apiKeyEnv") && own(s.apiKeyEnv, agent) && /^[A-Z][A-Z0-9_]*$/.test(String(s.apiKeyEnv[agent])) ? s.apiKeyEnv[agent] : DEFAULT_ENV[agent];
  var v = name && (env || process.env)[name];
  return typeof v === "string" && v.trim() && v.indexOf("\0") === -1 ? v.trim() : "";
}
// roomExecution.toolchainDir: an absolute host directory (document tools: python venv, pandoc...) bound READ-ONLY into the
// room sandbox at the same path. Returns the real path, or throws Error("invalid_toolchain_dir"). `forbidden` are
// directories it may neither lie inside nor contain (workspace, config/data dirs, home): binding them would expose them.
function validateToolchainDir(dir, forbidden) {
  var fs = require("fs"), path = require("path");
  if (typeof dir !== "string" || !path.isAbsolute(dir) || dir.indexOf("\0") !== -1) throw new Error("invalid_toolchain_dir");
  var real;
  try { real = fs.realpathSync(dir); if (!fs.statSync(real).isDirectory()) throw new Error("x"); } catch (_) { throw new Error("invalid_toolchain_dir"); }
  if (real === "/") throw new Error("invalid_toolchain_dir");
  (forbidden || []).forEach(function (f) {
    if (typeof f !== "string" || !f) return;
    var r; try { r = fs.realpathSync(f); } catch (_) { r = f; }
    if (r === "/") return;
    if (real === r || real.indexOf(r + "/") === 0 || r.indexOf(real + "/") === 0) throw new Error("invalid_toolchain_dir");
  });
  return real;
}
// The configured toolchain dir, or null when unset or invalid (invalid is logged once per value and ignored: old behaviour).
var warned = null;
function toolchainDir() {
  var s = section();
  if (!own(s, "toolchainDir") || s.toolchainDir === undefined || s.toolchainDir === null || s.toolchainDir === "") return null;
  try {
    var c = null; try { c = require("./config"); } catch (_) {}
    return validateToolchainDir(s.toolchainDir, [c && c.CONFIG_DIR, c && c.AIGORA_HOME]);
  } catch (_) {
    if (warned !== String(s.toolchainDir)) { warned = String(s.toolchainDir); console.error("[room-execution] roomExecution.toolchainDir is invalid and ignored"); }
    return null;
  }
}
// Private channels use the same host toolchain (roomExecution.toolchainDir, same validation) unless
// privateExecution.toolchain is literally false. Null when unset, invalid or opted out.
function privateToolchainDir() {
  try {
    var pe = require("./config").loadConfig().privateExecution;
    if (pe && typeof pe === "object" && own(pe, "toolchain") && pe.toolchain === false) return null;
  } catch (_) {}
  return toolchainDir();
}
function cliKeyNames(agent) { return (CLI_ENV[agent] || []).slice(); }
module.exports = { isRoomExecutionEnabled: isRoomExecutionEnabled, roomExecutionMode: roomExecutionMode, startupWarnings: startupWarnings,  apiKeyEnvName: apiKeyEnvName, maxRoomConcurrent: maxRoomConcurrent,
  credentialSource: credentialSource, toolchainDir: toolchainDir, privateToolchainDir: privateToolchainDir, validateToolchainDir: validateToolchainDir, apiKey: apiKey, cliKeyNames: cliKeyNames,
  brokerEnabled: brokerEnabled, brokerLimits: brokerLimits, brokerTtlMs: brokerTtlMs };

return module.exports;
});

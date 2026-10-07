module.exports = require("./extensions").select("ai-usage", function () {
var module = { exports: {} };
var credentials = require("./credential-leases");

function apiReadiness(vendor, label, color) {
  return { id: vendor, label: label, color: color, status: credentials.credentialAvailable(vendor) ? "ready" : "unavailable",
    quota: "not_reported", session: null, weekly: null, message: credentials.credentialAvailable(vendor) ? null : "API credential required" };
}

var CACHE_MS = 60000;

function errorUsage(id, label, color, error) {
  // CLI/provider errors can contain local paths or account details. Keep the
  // raw error server-side and expose only a non-sensitive recovery hint.
  // Log only the message (never the object), so failures are diagnosable.
  console.error("[ai-usage] " + id + " unavailable: " + (error && error.message ? String(error.message).slice(0, 160) : "unknown"));
  return { id: id, label: label, color: color, status: "unavailable", session: null, weekly: null, messageKey: "aiUsage.checkConnection", message: "Ask the administrator to add an API key or check the local connection." };
}

function fetchClaude() { return Promise.resolve(apiReadiness("claude", "Claude", "#d97757")); }



function fetchCodex() { return Promise.resolve(apiReadiness("codex", "Codex", "#10a37f")); }

function createUsageMonitor(options) {
  options = options || {};
  var cache = null;
  var cachedAt = 0;
  var inFlight = null;
  return async function readUsage(force) {
    if (!force && cache && Date.now() - cachedAt < (options.cacheMs || CACHE_MS)) return cache;
    if (inFlight) return inFlight;
    inFlight = Promise.all([
      (options.fetchCodex || fetchCodex)().catch(function (e) { return errorUsage("codex", "Codex", "#10a37f", e); }),
      (options.fetchClaude || fetchClaude)().catch(function (e) { return errorUsage("claude", "Claude", "#d97757", e); }),
    ]).then(function (providers) {
      cache = { providers: providers, updatedAt: Date.now(), refreshAfterMs: options.cacheMs || CACHE_MS };
      cachedAt = Date.now();
      return cache;
    }).finally(function () { inFlight = null; });
    return inFlight;
  };
}

var sharedUsageMonitor = createUsageMonitor();
var lastShared = null;
function readSharedUsageTracked(force) { return sharedUsageMonitor(force).then(function (v) { lastShared = v; return v; }); }
// Last value read by anyone, or null. Lets synchronous code ask "is Codex out of quota" without waiting.
function peekSharedUsage() { return lastShared; }
module.exports = { createUsageMonitor: createUsageMonitor, readSharedUsage: readSharedUsageTracked, peekSharedUsage: peekSharedUsage };

return module.exports;
});

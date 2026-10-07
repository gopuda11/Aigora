module.exports = require("../extensions").select("orchestration/availability", function () {
var module = { exports: {} };
// availability.js - Which agents can take a step right now, as the router wants it.

// Codex is usable unless its provider is not ready or a quota window is spent.
// Unknown usage is not treated as down.
function codexUsable(usage) {
  var codex = true;
  if (usage) {
    (usage.providers || []).forEach(function (p) {
      if (p.id !== "codex") return;
      if (p.status !== "ready") { codex = false; return; }
      if ((p.session && p.session.leftPercent <= 0) || (p.weekly && p.weekly.leftPercent <= 0)) codex = false;
    });
  }
  return codex;
}

// input: { usage, agyReady, localReady }
function buildAvailability(input) {
  var codex = codexUsable(input.usage);
  var out = { codex: codex };
  if (input.localReady !== undefined) out.local = !!input.localReady; // only callers that know about the local provider report it
  return out;
}

module.exports = { buildAvailability: buildAvailability, codexUsable: codexUsable };

return module.exports;
});

module.exports = require("../extensions").select("providers/registry", function () {
var module = { exports: {} };
"use strict";
// Provider registry (spec slices 0-1). A provider is a descriptor around an existing YOKE adapter factory; the
// registry never replaces the adapters, it wraps them, so claude and codex behave exactly as before.
//   id               adapter vendor / session.vendor value
//   label            display name
//   createAdapter    (opts) -> YOKE adapter (opts is what yoke.createAdapter received)
//   projectInstructions  false = do not merge CLAUDE.md/AGENTS.md etc. into the system prompt (default true)
//   enabled          () -> bool; absent = always enabled (claude, codex)
//   capabilities     static hints for UIs; nothing here is assumed Claude-like
var providers = Object.create(null);
var order = [];

function register(p) {
  if (!p || typeof p.id !== "string" || !p.id) throw new Error("[providers] provider needs an id");
  if (typeof p.createAdapter !== "function") throw new Error("[providers] provider '" + p.id + "' needs createAdapter");
  if (!providers[p.id]) order.push(p.id);
  providers[p.id] = p;
  return p;
}

function get(id) { return typeof id === "string" && providers[id] ? providers[id] : null; }
function list() { return order.map(function (id) { return providers[id]; }); }
function isEnabled(p) { return !!p && (typeof p.enabled !== "function" || !!p.enabled()); }
function listEnabled() { return list().filter(isEnabled); }

// Same eager loading as the old yoke/index.js; the local provider's modules load only when it is used.
var createClaudeAdapter = require("../yoke/adapters/claude").createClaudeAdapter;
var createCodexAdapter = require("../yoke/adapters/codex").createCodexAdapter;

register({
  id: "claude", label: "Claude", kind: "session",
  capabilities: { streaming: true, tools: "cli", resume: true },
  createAdapter: function (opts) { return createClaudeAdapter(opts); },
});
register({
  id: "codex", label: "Codex", kind: "session",
  capabilities: { streaming: true, tools: "cli", resume: true },
  createAdapter: function (opts) { return createCodexAdapter(opts); },
});
register({
  id: "local", label: "로컬 (Ollama)", kind: "session", projectInstructions: false,
  capabilities: { streaming: true, tools: "none", resume: false, quota: "none" },
  enabled: function () { return require("./local/config").loadLocalConfig().enabled; },
  createAdapter: function (opts) {
    if (!require("./local/config").loadLocalConfig().enabled) throw new Error("[YOKE] local provider is disabled");
    return require("./local/adapter").createLocalAdapter(opts && opts.adapterOpts);
  },
});

require("../extensions").registerProviders({ register: register });
module.exports = { register: register, get: get, list: list, listEnabled: listEnabled, isEnabled: isEnabled };

return module.exports;
});

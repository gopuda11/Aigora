// Cross-session memory isolation for CLIs Aigora spawns.
// Each session's data/memory must never reach another session or user. Vendor CLIs keep
// host-global persistent memory (Codex ~/.codex/memories, Claude auto memory under
// ~/.claude/projects/<cwd>/memory). Aigora sessions all run as the host user in one cwd,
// so that memory would be shared across members. These per-invocation overrides turn it off
// without touching the host's own config files.
//
// Codex (verified on 0.159.2: `codex -c features.memories=false features list` flips
// `memories stable true` to false; memories.generate_memories / use_memories exist in 0.124 too).
// Claude 2.1.x / SDK 0.3.173: Settings.autoMemoryEnabled / autoDreamEnabled (sdk.d.ts) and
// the env var CLAUDE_CODE_DISABLE_AUTO_MEMORY (present in the bundled binary).
"use strict";

// Codex `--config key=value` argv pairs, ready to append to a spawn.
var CODEX_MEMORY_OFF_ARGS = [
  "features.memories=false",
  "memories.generate_memories=false",
  "memories.use_memories=false",
].reduce(function (a, kv) { return a.concat(["--config", kv]); }, []);

var CLAUDE_MEMORY_OFF_SETTINGS = { autoMemoryEnabled: false, autoDreamEnabled: false };
var CLAUDE_MEMORY_OFF_ENV = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" };

// Merge into a Claude `settings` option (object). Ours always wins.
function claudeSettingsWithoutMemory(settings) {
  var base = settings && typeof settings === "object" ? settings : {};
  return Object.assign({}, base, CLAUDE_MEMORY_OFF_SETTINGS);
}

module.exports = {
  CODEX_MEMORY_OFF_ARGS: CODEX_MEMORY_OFF_ARGS,
  CLAUDE_MEMORY_OFF_SETTINGS: CLAUDE_MEMORY_OFF_SETTINGS,
  CLAUDE_MEMORY_OFF_ENV: CLAUDE_MEMORY_OFF_ENV,
  claudeSettingsWithoutMemory: claudeSettingsWithoutMemory,
};

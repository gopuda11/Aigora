// Aigora env-var helpers. Only AIGORA_* variables are read.
//
// Legacy CLAGENTIC_* / CLAY_* names are NOT honoured. Silently ignoring them would make a
// daemon started from an old systemd unit fall back to the default data dir, which looks
// like total data loss. So `legacyEnvGuard` refuses to start (exit 2) when a legacy name is
// set while its AIGORA_* counterpart is not, and prints the exact rename.
var path = require("path");

// The complete list of legacy variables the guard knows about: [old, new].
var LEGACY_ENV = [
  ["CLAGENTIC_HOME", "AIGORA_HOME"],
  ["CLAY_HOME", "AIGORA_HOME"],
  ["CLAGENTIC_CONFIG", "AIGORA_CONFIG"],
  ["CLAY_CONFIG", "AIGORA_CONFIG"],
  ["CLAGENTIC_DEV", "AIGORA_DEV"],
  ["CLAY_DEV", "AIGORA_DEV"],
  ["CLAGENTIC_DEBUG", "AIGORA_DEBUG"],
  ["CLAGENTIC_LITE_HOME", "AIGORA_LITE_HOME"],
  ["CLAGENTIC_MAX_CONCURRENT_SESSIONS", "AIGORA_MAX_CONCURRENT_SESSIONS"],
  ["CLAGENTIC_SELF_UPDATE", "AIGORA_SELF_UPDATE"],
  ["CLAY_CODEX_IDLE_MS", "AIGORA_CODEX_IDLE_MS"],
  ["CLAY_CODEX_REAPER_MS", "AIGORA_CODEX_REAPER_MS"],
  ["CLAY_CONFIG_PATH", "AIGORA_CONFIG_PATH"],
  ["CLAY_PORT", "AIGORA_PORT"],
  ["CLAY_AUTH_TOKEN", "AIGORA_AUTH_TOKEN"],
];

function isSet(env, name) {
  var v = env[name];
  return v !== undefined && v !== "";
}

// AIGORA_<suffix> value (non-empty), else undefined.
function aigoraEnv(suffix, env) {
  env = env || process.env;
  var v = env["AIGORA_" + suffix];
  return v !== undefined && v !== "" ? v : undefined;
}

// Classify legacy variables in `env`.
//   conflicts: legacy set, new one unset -> must refuse to start
//   shadowed:  legacy set and new one set -> new wins, warn once
function checkLegacyEnv(env) {
  env = env || process.env;
  var conflicts = [];
  var shadowed = [];
  for (var i = 0; i < LEGACY_ENV.length; i++) {
    var oldName = LEGACY_ENV[i][0];
    var newName = LEGACY_ENV[i][1];
    if (!isSet(env, oldName)) continue;
    (isSet(env, newName) ? shadowed : conflicts).push({ old: oldName, new: newName });
  }
  return { conflicts: conflicts, shadowed: shadowed };
}

var _warned = false;

// Startup guard for the daemon and the CLI. opts (all optional, for tests): env, stderr, exit.
// Returns true when startup may continue.
function legacyEnvGuard(opts) {
  opts = opts || {};
  var env = opts.env || process.env;
  var err = opts.stderr || function (s) { process.stderr.write(s + "\n"); };
  var exit = opts.exit || process.exit;
  var r = checkLegacyEnv(env);
  if (r.conflicts.length) {
    for (var i = 0; i < r.conflicts.length; i++) {
      err("Aigora no longer reads " + r.conflicts[i].old + ". Rename it to " + r.conflicts[i].new + " (e.g. in your systemd unit) and restart.");
    }
    exit(2);
    return false;
  }
  if (r.shadowed.length && (!_warned || opts.force)) {
    _warned = true;
    for (var j = 0; j < r.shadowed.length; j++) {
      err("[aigora] Warning: " + r.shadowed[j].old + " is ignored; using " + r.shadowed[j].new + ". Remove " + r.shadowed[j].old + ".");
    }
  }
  return true;
}

// Data-dir home resolution.
//   1. Explicit env: AIGORA_HOME, else the home implied by AIGORA_CONFIG -> used as-is, never
//      migrated. The canonical layout is <home>/console/daemon.json, so when
//      dirname(AIGORA_CONFIG) is named "console" the home is its parent.
//   2. ~/.aigora (default; also the target of the legacy ~/.clagentic / ~/.clay migration).
// Returns { home, explicit }.
function resolveHome(opts) {
  var env = opts.env || process.env;
  var explicit = aigoraEnv("HOME", env);
  if (!explicit && aigoraEnv("CONFIG", env)) {
    var cfgDir = path.dirname(aigoraEnv("CONFIG", env));
    explicit = path.basename(cfgDir) === "console" ? path.dirname(cfgDir) : cfgDir;
  }
  if (explicit) return { home: explicit, explicit: true };
  return { home: path.join(opts.realHome, ".aigora"), explicit: false };
}

module.exports = {
  LEGACY_ENV: LEGACY_ENV,
  aigoraEnv: aigoraEnv,
  checkLegacyEnv: checkLegacyEnv,
  legacyEnvGuard: legacyEnvGuard,
  resolveHome: resolveHome,
};

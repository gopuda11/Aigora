// build-user-env.js — Build a minimal, safe environment for user subprocesses.
// Prevents leaking the root daemon's full process.env to user sessions.

var os = require("os");

// Only these vars are forwarded from the daemon's environment.
var ALLOWED_KEYS = ["PATH", "LANG", "NODE_ENV"];

/**
 * Build a clean env object for spawning a user process.
 * osUserInfo: { uid, gid, home, user, shell } or null for same-user fallback.
 */
function buildUserEnv(osUserInfo) {
  var env = {};

  // Copy only allowlisted keys from daemon env
  for (var i = 0; i < ALLOWED_KEYS.length; i++) {
    var key = ALLOWED_KEYS[i];
    if (process.env[key]) env[key] = process.env[key];
  }

  // Copy all LC_* locale vars
  var keys = Object.keys(process.env);
  for (var j = 0; j < keys.length; j++) {
    if (keys[j].indexOf("LC_") === 0) {
      env[keys[j]] = process.env[keys[j]];
    }
  }

  // Terminal settings
  env.TERM = "xterm-256color";
  env.COLORFGBG = "15;0"; // Suppress OSC 11 background-color queries

  // User identity
  if (osUserInfo) {
    env.HOME = osUserInfo.home;
    env.USER = osUserInfo.user;
    env.LOGNAME = osUserInfo.user;
    if (osUserInfo.shell) env.SHELL = osUserInfo.shell;
  } else {
    env.HOME = process.env.HOME || os.homedir();
    env.USER = process.env.USER || "";
    env.LOGNAME = process.env.LOGNAME || process.env.USER || "";
    env.SHELL = process.env.SHELL || "/bin/bash";
  }

  // XDG runtime dir (needed for dbus, systemd user services, etc.)
  if (osUserInfo) {
    env.XDG_RUNTIME_DIR = "/run/user/" + osUserInfo.uid;
  } else if (process.env.XDG_RUNTIME_DIR) {
    env.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR;
  }

  // Force Node.js to prefer IPv4. Without this, the SDK CLI subprocess
  // tries IPv6 first (happy eyeballs), times out on servers without IPv6
  // outbound, then falls back to IPv4. This causes multi-second delays
  // on cold start (compounded by exponential backoff retries).
  env.NODE_OPTIONS = (env.NODE_OPTIONS ? env.NODE_OPTIONS + " " : "") + "--dns-result-order=ipv4first";

  return env;
}

module.exports = { buildUserEnv: buildUserEnv };

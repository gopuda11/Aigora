var fs = require("fs");
var os = require("os");
var path = require("path");

// Where the Codex CLI usually lives when a service PATH does not include it.
var FALLBACK_DIRS = [
  "/usr/local/bin",
  "/usr/bin",
  "/usr/lib/chatgpt/resources",
  "/opt/chatgpt/resources",
  "/opt/homebrew/bin",
];

function isExecutableFile(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch (_) {
    return false;
  }
}

// CODEX_EXECUTABLE is returned as-is (even if missing) so a bad override fails
// visibly at spawn time. Otherwise: PATH first, then the fallback locations.
// Returns null when no executable is found.
function resolveCodexExecutable(env, options) {
  env = env || process.env;
  options = options || {};
  if (env.CODEX_EXECUTABLE) return env.CODEX_EXECUTABLE;
  var home = options.homedir || os.homedir();
  var name = process.platform === "win32" ? "codex.exe" : "codex";
  var dirs = String(env.PATH || "").split(path.delimiter)
    .concat([path.join(home, ".local", "bin")], options.extraDirs || FALLBACK_DIRS)
    .filter(Boolean);
  for (var i = 0; i < dirs.length; i++) {
    var candidate = path.join(dirs[i], name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

module.exports = { resolveCodexExecutable: resolveCodexExecutable };

// lite-detect.js — Passive detection of Aigora Lite installation.
//
// All functions are synchronous and safe to call at any time.
// If Lite is not installed, every function returns a falsy / "not enrolled" result
// with no error thrown and no log output.

var fs = require("fs");
var path = require("path");
var { AIGORA_HOME, REAL_HOME } = require("./config");

// Lite home: ~/.aigora/lite/ — Lite is a sibling tool that owns its own product
// folder under the shared ~/.aigora/ root (lr-dc6c, lr-6204).
// Console owns ~/.aigora/console/; Lite owns ~/.aigora/lite/.
// Override: AIGORA_LITE_HOME env var.
function getLiteHome() {
  return require("./env-compat").aigoraEnv("LITE_HOME") || path.join(AIGORA_HOME, "lite");
}

// Return true when the Lite home directory exists.
function liteHomeDirExists() {
  try {
    return fs.existsSync(getLiteHome());
  } catch (e) {
    return false;
  }
}

// Candidate paths for the clagentic-lite binary (checked in order).
// PATH resolution is attempted first by scanning PATH, then common user-local paths.
var LITE_BINARY_NAME = "clagentic-lite";
var LITE_CANDIDATE_PATHS = [
  path.join(REAL_HOME, ".local", "bin", LITE_BINARY_NAME),
  path.join(REAL_HOME, "bin", LITE_BINARY_NAME),
];

function binaryExists() {
  // 1. Try PATH resolution (scanned here: minimal images such as Fedora's have no `which`)
  var dirs = String(process.env.PATH || "").split(path.delimiter);
  for (var d = 0; d < dirs.length; d++) {
    try {
      if (dirs[d] && fs.statSync(path.join(dirs[d], LITE_BINARY_NAME)).isFile()) { fs.accessSync(path.join(dirs[d], LITE_BINARY_NAME), fs.constants.X_OK); return true; }
    } catch (e) { /* not in this directory */ }
  }

  // 2. Check common user-local locations
  for (var i = 0; i < LITE_CANDIDATE_PATHS.length; i++) {
    try {
      if (fs.existsSync(LITE_CANDIDATE_PATHS[i])) return true;
    } catch (e) { /* keep checking */ }
  }
  return false;
}

/**
 * Detect whether Aigora Lite is installed.
 *
 * Returns:
 *   { installed: true,  liteHome: "~/.aigora/lite" }
 *   { installed: false, liteHome: null }
 *
 * Detection is passive — no subprocess is spawned for the main check.
 * `which` is used only as a PATH lookup fallback and its failure is silently swallowed.
 */
function detectLite() {
  var homeExists = liteHomeDirExists();
  var binExists = binaryExists();
  if (homeExists && binExists) {
    return { installed: true, liteHome: getLiteHome() };
  }
  return { installed: false, liteHome: null };
}

/**
 * Check per-project enrollment status.
 *
 * The external `clagentic-lite` binary (owned by another project) keeps its per-project
 * layout at <projectDir>/.clagentic/lite/audit.db, so that is where Aigora reads it. Aigora
 * never moves or writes it. Each path component below the project is lstat'ed and a
 * symlink (or non-directory) anywhere in the chain means "not enrolled", so a hostile
 * project cannot point the check outside itself.
 */
var LITE_PROJECT_DIRS = [".clagentic", "lite"]; // external name: allow-listed in docs/rebrand-inventory.md
function isProjectEnrolled(projectDir) {
  if (!projectDir) return false;
  try {
    var cur = projectDir;
    for (var i = 0; i < LITE_PROJECT_DIRS.length; i++) {
      cur = path.join(cur, LITE_PROJECT_DIRS[i]);
      var st = fs.lstatSync(cur);
      if (st.isSymbolicLink() || !st.isDirectory()) return false;
    }
    var db = fs.lstatSync(path.join(cur, "audit.db"));
    return db.isFile();
  } catch (e) {
    return false;
  }
}

module.exports = {
  detectLite: detectLite,
  isProjectEnrolled: isProjectEnrolled,
  getLiteHome: getLiteHome,
  // Exported for testing
  liteHomeDirExists: liteHomeDirExists,
  binaryExists: binaryExists,
};

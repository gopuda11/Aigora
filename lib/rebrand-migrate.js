// Rebrand phase 2 (R4): migrations of persisted names from the old brands
// (clagentic / clay) to aigora. Only the daemon start path may call migrateHome /
// migrateRcFiles (never a plain import, never a read-only CLI command). Every function is
//   - idempotent (a second run changes nothing),
//   - logged (one line per decision),
//   - non-destructive: data is moved (rename) or copied, never deleted without a moved copy;
//     when old and new both exist the new one is used and the old one is left untouched.
// Risky legacy layouts are NOT migrated: existing project dirs (~/clagentic-projects,
// ~/clay-projects, /var/clagentic/projects) stay in use where they are, and the external
// Lite tool's <project>/.clagentic/lite layout is read in place (see lib/lite-detect.js).
//
// KEEP-LIST (old brand strings that deliberately stay, because changing them would break
// existing accounts or external tools):
//   - lib/users-auth.js   "clay-user:" legacy password-hash salt: stored hashes depend on it.
//   - lib/os-users.js     "clay-" OS account prefix: the Linux users already exist under that name.
//   - "clagentic-lite" binary name / third-party URLs: owned by other projects.
var fs = require("fs");
var path = require("path");

function lexists(p) {
  try { fs.lstatSync(p); return true; } catch (e) { return false; }
}

function defaultLog(msg) { console.warn(msg); } // stderr: never pollute machine-readable stdout

// Move oldP to newP when newP is absent.
//   "none"  old absent
//   "both"  both present: new wins, old untouched
//   "moved" renamed
//   "copied" cross-device: copied (old kept; next run reports "both")
//   "error" nothing changed
function moveIfNewAbsent(oldP, newP, opts) {
  opts = opts || {};
  var log = opts.log || defaultLog;
  if (!lexists(oldP)) return "none";
  if (lexists(newP)) {
    if (!opts.quietBoth) log("[migrate] " + oldP + " and " + newP + " both exist: using " + newP + ", leaving " + oldP + " untouched");
    return "both";
  }
  try {
    fs.mkdirSync(path.dirname(newP), { recursive: true });
    fs.renameSync(oldP, newP);
    log("[migrate] moved " + oldP + " -> " + newP);
    return "moved";
  } catch (e) {
    if (e.code !== "EXDEV") {
      log("[migrate] could not move " + oldP + " -> " + newP + ": " + e.message);
      return "error";
    }
  }
  // Cross-device: copy to a temp name, then rename into place so a crash never leaves
  // a half-copied newP that a later run would mistake for a finished migration.
  var tmp = newP + ".migrating";
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.cpSync(oldP, tmp, { recursive: true, preserveTimestamps: true });
    fs.renameSync(tmp, newP);
    log("[migrate] copied " + oldP + " -> " + newP + " (different device; old copy kept, remove it when verified)");
    return "copied";
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    log("[migrate] could not copy " + oldP + " -> " + newP + ": " + e.message);
    return "error";
  }
}

// True when a daemon recorded in a legacy home (<home>/console/daemon*.json or
// <home>/daemon*.json) has a live pid. Fail closed: an unreadable pid file with a socket
// present counts as live.
function legacyDaemonLive(legacyHome) {
  var dirs = [path.join(legacyHome, "console"), legacyHome];
  var names = ["daemon.json", "daemon-dev.json"];
  for (var i = 0; i < dirs.length; i++) {
    for (var j = 0; j < names.length; j++) {
      var f = path.join(dirs[i], names[j]);
      if (!lexists(f)) continue;
      var pid = null;
      try { pid = JSON.parse(fs.readFileSync(f, "utf8")).pid; } catch (_) { pid = -1; }
      if (pid === -1) {
        if (lexists(path.join(dirs[i], names[j].replace(".json", ".sock")))) return true;
        continue;
      }
      if (!pid || typeof pid !== "number" || pid < 1) continue;
      try { process.kill(pid, 0); return true; } catch (e) { if (e.code === "EPERM") return true; }
    }
  }
  return false;
}

// ~/.clagentic (then ~/.clay) -> ~/.aigora. Only for the default home (explicit
// AIGORA_HOME is never touched). Returns { status, from } where status is the
// moveIfNewAbsent result of the migration that applied.
function migrateHome(realHome, opts) {
  var target = path.join(realHome, ".aigora");
  var olds = [path.join(realHome, ".clagentic"), path.join(realHome, ".clay")];
  for (var i = 0; i < olds.length; i++) {
    if (!lexists(olds[i])) continue;
    // Never move a home out from under a running legacy daemon.
    if (!lexists(target) && legacyDaemonLive(olds[i])) return { status: "live", from: olds[i] };
    var st = moveIfNewAbsent(olds[i], target, opts);
    if (st !== "none") return { status: st, from: olds[i] };
  }
  return { status: "none", from: null };
}

// ~/.clagentic-rc / ~/.clayrc -> ~/.aigora-rc (first existing old file wins).
function migrateRcFiles(realHome, opts) {
  var target = path.join(realHome, ".aigora-rc");
  var olds = [path.join(realHome, ".clagentic-rc"), path.join(realHome, ".clayrc")];
  for (var i = 0; i < olds.length; i++) {
    if (!lexists(olds[i])) continue;
    var st = moveIfNewAbsent(olds[i], target, opts);
    if (st !== "none") return { status: st, from: olds[i] };
  }
  return { status: "none", from: null };
}

var _loggedLegacy = {};
function logLegacyOnce(p, opts) {
  if (_loggedLegacy[p]) return;
  _loggedLegacy[p] = true;
  ((opts && opts.log) || defaultLog)("[migrate] legacy projects dir " + p + " stays in use (not moved)");
}

// Directory for newly created projects when config.projectsDir is unset.
// An existing ~/aigora-projects wins, then an existing ~/clagentic-projects / ~/clay-projects
// is kept in use as-is (never moved); only a fresh install uses ~/aigora-projects.
function homeProjectsDir(realHome, opts) {
  var newDir = path.join(realHome, "aigora-projects");
  if (lexists(newDir)) return newDir;
  var olds = [path.join(realHome, "clagentic-projects"), path.join(realHome, "clay-projects")];
  for (var i = 0; i < olds.length; i++) {
    if (lexists(olds[i])) { logLegacyOnce(olds[i], opts); return olds[i]; }
  }
  return newDir;
}

// /var/aigora/projects (osUsers mode); an existing /var/clagentic/projects stays in use.
function systemProjectsDir(opts) {
  opts = opts || {};
  var root = opts.varRoot || "/var";
  var newDir = path.join(root, "aigora", "projects");
  var oldDir = path.join(root, "clagentic", "projects");
  if (!lexists(newDir) && lexists(oldDir)) { logLegacyOnce(oldDir, opts); return oldDir; }
  return newDir;
}

// Stored values.
function normalizeThemeBrand(v) {
  if (v === "classic" || v === "aigora") return v;
  if (v === "clagentic") return "aigora";
  return null;
}

function normalizePromptAuthor(v) {
  if (!v || v === "clay" || v === "clagentic") return "aigora";
  return v;
}

module.exports = {
  moveIfNewAbsent: moveIfNewAbsent,
  migrateHome: migrateHome,
  migrateRcFiles: migrateRcFiles,
  homeProjectsDir: homeProjectsDir,
  systemProjectsDir: systemProjectsDir,
  legacyDaemonLive: legacyDaemonLive,
  normalizeThemeBrand: normalizeThemeBrand,
  normalizePromptAuthor: normalizePromptAuthor,
};

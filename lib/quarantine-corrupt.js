// A state file that fails to PARSE used to be treated as "empty" and then
// overwritten by the next save, silently destroying whatever it held. Callers
// keep the same empty-state fallback, but call this first so the unreadable
// bytes are moved aside (<file>.corrupt-<ms>) and stay recoverable. Only a
// JSON SyntaxError quarantines; ENOENT and transient read errors (EACCES,
// EIO) never move anything. The log line carries the base name only, never
// file contents. Returns the quarantine path or null.
var fs = require("fs");
var path = require("path");

function quarantineCorrupt(file, err) {
  if (!err || err.name !== "SyntaxError" || typeof file !== "string" || !file) return null;
  var dest = file + ".corrupt-" + Date.now();
  try {
    fs.renameSync(file, dest);
    process.stderr.write("[state] unreadable " + path.basename(file) + " moved aside to " + path.basename(dest) + "\n");
    return dest;
  } catch (_) { return null; }
}

module.exports = { quarantineCorrupt: quarantineCorrupt };

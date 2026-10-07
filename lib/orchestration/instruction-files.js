"use strict";
var fs=require("fs"),path=require("path");
var INSTRUCTION_FILES=["GEMINI.md",".gemini",".agents","AGENTS.md","CLAUDE.md"];
function lstatOrNull(p) { try { return fs.lstatSync(p); } catch (_) { return null; } }
function sameTree(a, b) {
  var sa = lstatOrNull(a), sb = lstatOrNull(b);
  if (!sa || !sb) return !sa && !sb;
  if (sa.isSymbolicLink() || sb.isSymbolicLink()) return false;
  if (sa.isDirectory() !== sb.isDirectory() || sa.isFile() !== sb.isFile()) return false;
  if (sa.isFile()) {
    if (sa.size !== sb.size || (sa.mode & 0o777) !== (sb.mode & 0o777)) return false;
    try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch (_) { return false; }
  }
  if (!sa.isDirectory()) return false;
  var na, nb;
  try { na = fs.readdirSync(a).sort(); nb = fs.readdirSync(b).sort(); } catch (_) { return false; }
  if (na.join("\0") !== nb.join("\0")) return false;
  return na.every(function (n) { return sameTree(path.join(a, n), path.join(b, n)); });
}
function copyPlain(src, dst) {
  var st = lstatOrNull(src);
  if (!st) return;
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { mode: st.mode & 0o777 });
    fs.readdirSync(src).forEach(function (n) { copyPlain(path.join(src, n), path.join(dst, n)); });
  } else if (st.isFile()) {
    fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(dst, st.mode & 0o777);
  }
}
function revertInstructionFiles(workspace, snapshotInfo) {
  var out = { changed: [], restored: [], removed: [], failed: [] };
  var ws = null;
  try {
    ws = fs.realpathSync(String(workspace || ""));
    if (!fs.statSync(ws).isDirectory()) ws = null;
  } catch (_) { ws = null; }
  if (!ws) { out.failed = INSTRUCTION_FILES.slice(); return out; }
  var filesDir = snapshotInfo && typeof snapshotInfo.filesDir === "string" && snapshotInfo.filesDir ? snapshotInfo.filesDir : null;
  INSTRUCTION_FILES.forEach(function (name) {
    var cur = path.join(ws, name);
    var orig = filesDir ? path.join(filesDir, name) : null;
    try {
      var now = lstatOrNull(cur);
      var before = orig ? lstatOrNull(orig) : null;
      if (before && before.isSymbolicLink()) before = null;
      if (!now && !before) return;
      if (now && before && sameTree(cur, orig)) return;
      out.changed.push(name);
      if (now) { fs.rmSync(cur, { recursive: true, force: true }); out.removed.push(name); }
      if (before) { copyPlain(orig, cur); out.restored.push(name); }
      if (lstatOrNull(cur) ? !before : !!before) out.failed.push(name);
    } catch (_) { out.failed.push(name); }
  });
  return out;
}
module.exports={INSTRUCTION_FILES,revertInstructionFiles};

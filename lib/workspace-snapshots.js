"use strict";
// workspace-snapshots.js - per-turn backups of a room's persistent AI workspace, and the admin restore.
//
// <base>/room/<roomId>/workspace            the live workspace
// <base>/room/<roomId>/snapshots/<id>/      one backup: meta.json + files/ (id = <ISO-ts with - for :>-<shortid>)
//
// A backup is taken at the start of each contained room turn. Regular files and directories only (symlinks, FIFOs,
// devices are skipped, never followed); file data is copied copy-on-write when the filesystem can, else byte for byte.
// Never hardlinks, so an in-place edit cannot reach a backup. Over the caps nothing is copied. Callers never let a
// snapshot error fail a turn. Restore swaps a temp copy in beside the workspace after taking a pre-restore backup.

var fs = require("fs");
var path = require("path");
var crypto = require("crypto");

var KEEP = 20;
var MAX_BYTES = 500 * 1024 * 1024;
var MAX_FILES = 20000;
var ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/;
var ID_RE = /^[0-9TZ-]{1,40}-[a-f0-9]{6}$/;
var TMP = ".tmp-";
var lastStamp = 0;             // snapshots made in the same millisecond still sort in creation order

function fail(code, status) { var e = new Error(code); e.code = code; e.status = status; return e; }
function stampOf(ms) { return new Date(ms).toISOString().replace(/[:.]/g, "-"); }
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* best effort */ } }
// An agent may have chmod'd a tree unreadable: make real directories traversable again before reading or removing.
function openUp(p) { try { var st = fs.lstatSync(p); if (st.isDirectory() && (st.mode & 0o700) !== 0o700) fs.chmodSync(p, st.mode | 0o700); } catch (_) {} }

// Count what would be copied; stops as soon as a cap is passed.
function scan(root) {
  var files = 0, bytes = 0, stack = [root];
  while (stack.length) {
    var dir = stack.pop();
    openUp(dir);
    fs.readdirSync(dir).forEach(function (name) {
      var p = path.join(dir, name), st = fs.lstatSync(p);
      if (st.isDirectory()) { stack.push(p); return; }
      if (!st.isFile()) return;
      files++; bytes += st.size;
    });
    if (files > MAX_FILES || bytes > MAX_BYTES) return { files: files, bytes: bytes, over: true };
  }
  return { files: files, bytes: bytes, over: false };
}

function copyFile(src, dst) {
  try { fs.copyFileSync(src, dst, fs.constants.COPYFILE_FICLONE); }
  catch (_) { fs.copyFileSync(src, dst); }
}
function copyTree(src, dst) {
  var st = fs.lstatSync(src);
  fs.mkdirSync(dst, { mode: 0o700 });
  openUp(src);
  fs.readdirSync(src).forEach(function (name) {
    var s = path.join(src, name), d = path.join(dst, name), e = fs.lstatSync(s);
    if (e.isDirectory()) copyTree(s, d);
    else if (e.isFile()) { copyFile(s, d); fs.chmodSync(d, e.mode & 0o777); }
  });
  fs.chmodSync(dst, st.mode & 0o777);
}

function createWorkspaceSnapshots(opts) {
  opts = opts || {};
  function baseDir() { return opts.baseDir || path.join(require("./config").CONFIG_DIR, "private-agent-scope"); }
  function isLive(p) { return (opts.isLive || require("./private-agent-scope").isWorkspaceLive)(p); }
  function roomDir(roomId) { return ROOM_RE.test(String(roomId)) ? path.join(baseDir(), "room", roomId) : null; }
  function snapDir(roomId) { var r = roomDir(roomId); return r && path.join(r, "snapshots"); }
  function workspaceOf(roomId) { var r = roomDir(roomId); return r && path.join(r, "workspace"); }

  function readMeta(dir) {
    try { return JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")); } catch (_) { return null; }
  }
  // Newest first.
  function list(roomId) {
    var root = snapDir(roomId), names = [];
    try { names = fs.readdirSync(root); } catch (_) { return []; }
    return names.filter(function (n) { return ID_RE.test(n); }).sort().reverse().map(function (n) {
      var m = readMeta(path.join(root, n));
      return m ? { id: n, time: m.time, actorId: m.actorId, actorName: m.actorName, preview: m.preview, files: m.files, bytes: m.bytes, kind: m.kind } : null;
    }).filter(Boolean);
  }
  function prune(roomId) {
    var root = snapDir(roomId);
    list(roomId).slice(KEEP).forEach(function (s) { rm(path.join(root, s.id)); });
  }

  // Back up `workspace` (the room's live workspace). Returns { id } or { skipped: "too_big" } or { skipped: "error" }; never throws.
  function take(roomId, meta) {
    var tmp = null;
    try {
      var ws = workspaceOf(roomId), root = snapDir(roomId);
      var st = null;
      try { st = fs.lstatSync(ws); } catch (_) { return { skipped: "empty" }; }
      if (st.isSymbolicLink() || !st.isDirectory()) return { skipped: "error" };
      var counted = scan(ws);
      if (counted.over) return { skipped: "too_big" };
      var now = Math.max(Date.now(), lastStamp + 1), id = stampOf(now) + "-" + crypto.randomBytes(3).toString("hex");
      lastStamp = now;
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      root = fs.realpathSync(root);
      // A stale temp from a crashed attempt is never listed (no id shape) but should not pile up.
      fs.readdirSync(root).forEach(function (n) { if (n.indexOf(TMP) === 0) rm(path.join(root, n)); });
      tmp = path.join(root, TMP + id);
      fs.mkdirSync(tmp, { mode: 0o700 });
      copyTree(ws, path.join(tmp, "files"));
      var m = meta || {};
      fs.writeFileSync(path.join(tmp, "meta.json"), JSON.stringify({
        time: now, actorId: m.actorId || null, actorName: String(m.actorName || "").slice(0, 80),
        preview: String(m.preview || "").replace(/\s+/g, " ").trim().slice(0, 80), files: counted.files, bytes: counted.bytes, kind: m.kind || "turn",
      }), { mode: 0o600 });
      fs.renameSync(tmp, path.join(root, id));
      tmp = null;
      prune(roomId);
      return { id: id };
    } catch (e) {
      if (tmp) rm(tmp);
      console.error("[workspace-snapshots] snapshot failed:", e && e.message);
      return { skipped: "error" };
    }
  }

  // Put a snapshot's files back as the workspace. Refused while a turn runs in it. Takes a "되돌리기 전 자동 백업" first.
  function restore(roomId, id, actor) {
    var ws = workspaceOf(roomId), root = snapDir(roomId);
    if (!ws || !ID_RE.test(String(id))) throw fail("not_found", 404);
    var src = path.join(root, id, "files"), meta = readMeta(path.join(root, id));
    try { if (!meta || !fs.lstatSync(src).isDirectory()) throw 0; } catch (_) { throw fail("not_found", 404); }
    var existing = null;
    try { existing = fs.lstatSync(ws); } catch (_) { existing = null; }
    if (existing && isLive(ws)) throw fail("busy", 409);
    if (existing) {
      var b = take(roomId, { actorId: actor && actor.id, actorName: actor && actor.name, preview: "되돌리기 전 자동 백업", kind: "pre-restore" });
      if (b.skipped && b.skipped !== "empty") throw fail("backup_failed", 409);
    }
    var parent = roomDir(roomId), tag = crypto.randomBytes(4).toString("hex");
    var next = path.join(parent, ".workspace-restore-" + tag), old = path.join(parent, ".workspace-old-" + tag);
    try {
      copyTree(src, next);
      if (existing) fs.renameSync(ws, old);
      try { fs.renameSync(next, ws); }
      catch (e) { if (existing) fs.renameSync(old, ws); throw e; }
    } catch (e) {
      rm(next);
      throw fail("restore_failed", 500);
    }
    if (existing) { openUp(old); rm(old); }
    return { time: meta.time };
  }

  return { take: take, list: list, restore: restore, workspaceOf: workspaceOf, LIMITS: { KEEP: KEEP, MAX_BYTES: MAX_BYTES, MAX_FILES: MAX_FILES } };
}

var shared = null;
function sharedSnapshots() { return shared || (shared = createWorkspaceSnapshots()); }

module.exports = { createWorkspaceSnapshots: createWorkspaceSnapshots, sharedSnapshots: sharedSnapshots };

"use strict";
// Private-channel schema compatibility guard (Task 6a).
// check() is read-only and idempotent; stamp() is the only writer (temp+rename).
// Layout read: <dir>/personal-channels.json, <dir>/sessions/*/*.jsonl (meta on
// line 1), <dir>/loops/*.jsonl. Nothing here returns ids, titles or prompts.
var fs = require("node:fs");
var path = require("node:path");
var crypto = require("node:crypto");

var SCHEMA_VERSION = 1;
var STAMP_FILE = "private-channels-schema.json";
var MESSAGES = {
  OLD_BUILD_PRIVATE_DATA: "Refused: data contains private-channel fields this build does not support. Do not write; restore a compatible build.",
  NEWER_SCHEMA: "Refused: data schema is newer than this build supports.",
  STAMP_INVALID: "Refused: schema stamp is unreadable.",
  MALFORMED_PRIVATE_DATA: "Refused: private-channel data is inconsistent. Access is not widened; repair before writing.",
};

function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
function isPrivateVal(v) { return v !== undefined && v !== null; }
function readJson(p) { return JSON.parse(fs.readFileSync(p, "utf8")); }
function listDir(p) { try { return fs.readdirSync(p); } catch (e) { return []; } }

// Returns { map } of channelId -> record, or { invalid: true }.
function loadChannels(dir) {
  var raw;
  try { raw = fs.readFileSync(path.join(dir, "personal-channels.json"), "utf8"); } catch (e) {
    return e && e.code === "ENOENT" ? { map: {} } : { invalid: true };
  }
  try {
    var p = JSON.parse(raw);
    if (!p || p.version !== 1 || !Array.isArray(p.channels)) return { invalid: true };
    var map = Object.create(null);
    p.channels.forEach(function (c) { if (c && typeof c.channelId === "string") map[c.channelId] = c; });
    return { map: map };
  } catch (e) { return { invalid: true }; }
}

function firstLine(file) {
  var fd, buf = Buffer.alloc(65536);
  try {
    fd = fs.openSync(file, "r");
    var n = fs.readSync(fd, buf, 0, buf.length, 0);
    var s = buf.slice(0, n).toString("utf8");
    var i = s.indexOf("\n");
    return i < 0 ? s : s.slice(0, i);
  } catch (e) { return ""; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (e) {} }
}

function scan(dir) {
  var out = { usesPrivate: false, stampedVersion: null, counts: { sessions: 0, privateSessions: 0, registryRecords: 0, privateRegistryRecords: 0 }, violations: {} };
  function bad(code) { out.violations[code] = (out.violations[code] || 0) + 1; }
  try {
    var st = readJson(path.join(dir, STAMP_FILE));
    out.stampedVersion = Number.isInteger(st && st.schemaVersion) && st.schemaVersion >= 1 ? st.schemaVersion : "invalid";
  } catch (e) { if (!e || e.code !== "ENOENT") out.stampedVersion = "invalid"; }
  var chans = loadChannels(dir);
  function bind(item, prefix) {
    if (chans.invalid) return bad("channel_store_invalid");
    var rec = typeof item.channelId === "string" ? chans.map[item.channelId] : null;
    if (!rec) return bad(prefix + "_missing_channel");
    if (has(item, "ownerId") && item.ownerId !== rec.ownerUserId) bad(prefix + "_owner_mismatch");
    if (has(item, "roomId") && item.roomId !== rec.roomId) bad(prefix + "_room_mismatch");
  }
  var sroot = path.join(dir, "sessions");
  listDir(sroot).forEach(function (enc) {
    listDir(path.join(sroot, enc)).forEach(function (f) {
      if (!/\.jsonl$/.test(f)) return;
      var meta;
      try { meta = JSON.parse(firstLine(path.join(sroot, enc, f))); } catch (e) { return; }
      if (!meta || meta.type !== "meta") return;
      out.counts.sessions++;
      if (!has(meta, "channelId") || !isPrivateVal(meta.channelId)) return;
      out.counts.privateSessions++;
      bind(meta, "session");
    });
  });
  listDir(path.join(dir, "loops")).forEach(function (f) {
    if (!/\.jsonl$/.test(f)) return;
    var raw; try { raw = fs.readFileSync(path.join(dir, "loops", f), "utf8"); } catch (e) { return; }
    raw.split("\n").forEach(function (line) {
      var rec; if (!line.trim()) return;
      try { rec = JSON.parse(line); } catch (e) { return; }
      if (!rec || typeof rec !== "object") return;
      out.counts.registryRecords++;
      if (!["channelId", "ownerId", "roomId"].some(function (k) { return has(rec, k); })) return;
      out.counts.privateRegistryRecords++;
      if (typeof rec.channelId !== "string" || !rec.channelId) return bad("registry_provenance_without_channel");
      bind(rec, "registry");
    });
  });
  out.usesPrivate = out.counts.privateSessions + out.counts.privateRegistryRecords > 0;
  return out;
}

// opts.supportedVersion: highest schema the running build knows (0 = pre-private build).
function check(dir, opts) {
  var supported = opts && typeof opts.supportedVersion === "number" ? opts.supportedVersion : SCHEMA_VERSION;
  var s = scan(dir);
  var reason = null;
  if (s.stampedVersion === "invalid") reason = "STAMP_INVALID";
  else if (s.stampedVersion !== null && s.stampedVersion > supported) reason = "NEWER_SCHEMA";
  else if (s.usesPrivate && supported < 1) reason = "OLD_BUILD_PRIVATE_DATA";
  else if (Object.keys(s.violations).length) reason = "MALFORMED_PRIVATE_DATA";
  return { ok: !reason, reason: reason, message: reason ? MESSAGES[reason] : "OK", supportedVersion: supported, scan: s };
}

function assertWritable(dir, opts) {
  var r = check(dir, opts);
  if (r.ok) return r;
  var err = new Error(r.message); err.code = r.reason; throw err;
}

// Explicit, idempotent, atomic. Refuses when check() refuses.
function stamp(dir) {
  var r = assertWritable(dir);
  if (r.scan.stampedVersion === SCHEMA_VERSION) return { changed: false, schemaVersion: SCHEMA_VERSION };
  var file = path.join(dir, STAMP_FILE);
  var tmp = file + ".tmp." + process.pid + "." + crypto.randomBytes(4).toString("hex");
  try {
    fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: SCHEMA_VERSION, stampedAt: Date.now() }) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, file);
  } catch (e) { try { fs.unlinkSync(tmp); } catch (e2) {} throw e; }
  return { changed: true, schemaVersion: SCHEMA_VERSION };
}

module.exports = { SCHEMA_VERSION: SCHEMA_VERSION, STAMP_FILE: STAMP_FILE, MESSAGES: MESSAGES, scan: scan, check: check, assertWritable: assertWritable, stamp: stamp };

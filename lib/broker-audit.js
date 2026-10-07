"use strict";
// broker-audit.js - JSON-lines request log of the credential broker (docs/superpowers/specs/2026-10-04-credential-broker-design.md 3.6).
// CONFIG_DIR/broker-audit.log, mode 0600, rotated at 50 MiB or 30 days. Separate from audit.js (privileged actions) because of volume.
//
// Only a fixed set of scalar fields is ever written (whitelist). Request/response bodies, header values (except the provider
// request id), the run token and the provider key have no field to land in, and string values are charset-restricted and
// length-capped so a hostile client cannot smuggle text through path/model. Never throws into callers.

var fs = require("fs");
var path = require("path");

var MAX_BYTES = 50 * 1024 * 1024;
var MAX_AGE_MS = 30 * 24 * 3600 * 1000;
var GENERATIONS = 3;

var STR_FIELDS = {
  runId: 128, vendor: 32, roomId: 128, channelId: 128, actorId: 128, method: 16, path: 160,
  model: 80, denyReason: 80, upstreamRequestId: 128, event: 40,
};
var NUM_FIELDS = ["status", "bytesIn", "bytesOut", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "latencyMs"];
// Values come from the caller or the client; keep a conservative charset so no free text passes.
var SAFE = /[^A-Za-z0-9._:\/@=,+\-]/g;

function cleanString(v, max) {
  if (typeof v !== "string") return undefined;
  var s = v.replace(SAFE, "?");
  return s.length > max ? s.slice(0, max) : s;
}

function clean(entry, now) {
  var out = { ts: new Date(now).toISOString() };
  Object.keys(STR_FIELDS).forEach(function (k) {
    var v = entry && entry[k];
    if (v === null) out[k] = null;
    else { var s = cleanString(v, STR_FIELDS[k]); if (s !== undefined) out[k] = s; }
  });
  NUM_FIELDS.forEach(function (k) {
    var v = entry && entry[k];
    if (typeof v === "number" && isFinite(v)) out[k] = Math.round(v);
  });
  return out;
}

function createBrokerAudit(opts) {
  opts = opts || {};
  var dir = opts.dir || require("./config").CONFIG_DIR;
  var file = path.join(dir, "broker-audit.log");
  var maxBytes = opts.maxBytes > 0 ? opts.maxBytes : MAX_BYTES;
  var maxAgeMs = opts.maxAgeMs > 0 ? opts.maxAgeMs : MAX_AGE_MS;
  var now = opts.now || Date.now;
  var fd = null, size = 0, startedAt = 0, warned = false;

  function warn(e) {
    if (warned) return;
    warned = true;
    console.error("[broker-audit] write failed: " + (e && e.code ? e.code : "error"));
  }

  function openFile() {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // O_NOFOLLOW: a planted symlink at the log path must not redirect the log elsewhere.
    fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    var st = fs.fstatSync(fd);
    if (!st.isFile()) { fs.closeSync(fd); fd = null; throw new Error("not_regular"); }
    try { fs.fchmodSync(fd, 0o600); } catch (_) {}
    size = st.size;
    startedAt = now();
    if (size > 0) {
      // Age of an existing file = timestamp of its first line, else its mtime.
      try {
        var buf = Buffer.alloc(256);
        var rfd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW), n;
        try { n = fs.readSync(rfd, buf, 0, 256, 0); } finally { fs.closeSync(rfd); }
        var m = /"ts":"([^"]+)"/.exec(buf.slice(0, n).toString("utf8").split("\n")[0]);
        var t = m ? Date.parse(m[1]) : NaN;
        startedAt = isFinite(t) ? t : st.mtimeMs;
      } catch (_) { startedAt = st.mtimeMs; }
    }
  }

  function rotate() {
    try { if (fd !== null) fs.closeSync(fd); } catch (_) {}
    fd = null;
    for (var i = GENERATIONS; i >= 1; i--) {
      var from = i === 1 ? file : file + "." + (i - 1);
      try {
        if (i === GENERATIONS) { try { fs.unlinkSync(file + "." + i); } catch (_) {} }
        fs.renameSync(from, file + "." + i);
      } catch (_) {}
    }
    // Retention: drop rotated generations older than maxAgeMs.
    for (var j = 1; j <= GENERATIONS; j++) {
      try { if (now() - fs.statSync(file + "." + j).mtimeMs > maxAgeMs) fs.unlinkSync(file + "." + j); } catch (_) {}
    }
  }

  function log(entry) {
    try {
      var t = now();
      var line = JSON.stringify(clean(entry, t)) + "\n";
      if (fd === null) openFile();
      if (size > 0 && (size + line.length > maxBytes || t - startedAt > maxAgeMs)) { rotate(); openFile(); }
      var buf = Buffer.from(line, "utf8");
      fs.writeSync(fd, buf);
      size += buf.length;
    } catch (e) { warn(e); try { if (fd !== null) fs.closeSync(fd); } catch (_) {} fd = null; }
  }

  function close() { try { if (fd !== null) fs.closeSync(fd); } catch (_) {} fd = null; }

  return { log: log, close: close, path: file };
}

module.exports = { createBrokerAudit: createBrokerAudit, MAX_BYTES: MAX_BYTES, MAX_AGE_MS: MAX_AGE_MS };

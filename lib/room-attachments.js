// room-attachments.js - bytes, metadata and authorization for files attached to
// a room or to a private channel. Governing rule: a room's or channel's data
// never reaches anyone outside it, and authorization is evaluated server-side
// on every request (no signed URL, no token that outlives the request).
//
// Layout under the root (mode 0700):
//   blobs/<scope>/<sha256[0:2]>/<sha256>   content-addressed, 0600, no extension
//   meta/<scope>/<attachmentId>.json       record, atomic write (tmp + rename)
//   tmp/                                   upload staging on the same filesystem
//   audit/<yyyy-mm>.jsonl                  append-only action log (no content)
// <scope> is "room-<roomId>" or "chan-<channelId>"; a blob is never shared
// across scopes, so dedup cannot become a cross-room existence oracle.
//
// Every negative authorization result is the same "not_found" error.

var fs = require("fs");
var path = require("path");
var crypto = require("crypto");

var ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/;
var CHAN_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
var ID_RE = /^[a-f0-9]{32}$/;
var SHA_RE = /^[a-f0-9]{64}$/;
var MB = 1024 * 1024;

var LIMITS = {
  perFile: 25 * MB, image: 15 * MB, audio: 500 * MB, perRequest: 5, roomFiles: 500,
  channelFiles: 500, roomBytes: 2048 * MB, userRoomBytes: 500 * MB, userChannelBytes: 500 * MB,
  ratePerMinute: 30, globalBytes: 100 * 1024 * MB, deniedPerMinute: 20,
  zipEntries: 5000, zipUncompressed: 500 * MB, versionsKept: 50, versionSlack: 0.1,
  aiInboxFiles: 10, aiInboxBytes: 100 * MB,
};
// ONLYOFFICE Document Server's own limits (FileConverter.converter.inputLimits and maxDownloadBytes, measured in
// the spike): uncompressed size per OOXML type, and the largest file DS will download. The office caps are
// min(Aigora's own cap, DS' limit), so a file that passes upload is a file DS can open.
var OFFICE_LIMITS = { docx: 50 * MB, pptx: 50 * MB, xlsx: 300 * MB, maxDownload: 100 * MB };
// Never sent to the Document Server (an HWP hung its single converter for 5 minutes in the spike): download only.
var DOWNLOAD_ONLY = ["hwp", "hwpx", "hml"];
var CO_EDIT = ["docx", "xlsx", "pptx"];

function fail(code, status) { var e = new Error(code); e.code = code; e.status = status || STATUS[code] || 400; return e; }
var STATUS = { unauthorized: 401, not_found: 404, invalid: 400, too_large: 413, unsupported: 415, quota: 413, rate_limited: 429, busy: 429, storage_full: 507, failed: 500 };

// --- Types ----------------------------------------------------------------------------

var T = "text/plain; charset=utf-8";
var OOXML = "application/vnd.openxmlformats-officedocument.";
var ODF = "application/vnd.oasis.opendocument.";
// ext -> { kind, mime, sniff, part? }. Everything else is rejected (415).
var TYPES = {
  png: { kind: "image", mime: "image/png", sniff: "png" }, jpg: { kind: "image", mime: "image/jpeg", sniff: "jpeg" },
  jpeg: { kind: "image", mime: "image/jpeg", sniff: "jpeg" }, gif: { kind: "image", mime: "image/gif", sniff: "gif" },
  webp: { kind: "image", mime: "image/webp", sniff: "webp" },
  txt: { kind: "text", mime: T, sniff: "text" }, csv: { kind: "text", mime: "text/csv; charset=utf-8", sniff: "csv" },
  md: { kind: "text", mime: "text/markdown; charset=utf-8", sniff: "text" }, json: { kind: "text", mime: "application/json; charset=utf-8", sniff: "text" },
  log: { kind: "text", mime: T, sniff: "text" },
  pdf: { kind: "pdf", mime: "application/pdf", sniff: "pdf" },
  docx: { kind: "office", mime: OOXML + "wordprocessingml.document", sniff: "ooxml", part: "word/" },
  xlsx: { kind: "office", mime: OOXML + "spreadsheetml.sheet", sniff: "ooxml", part: "xl/" },
  pptx: { kind: "office", mime: OOXML + "presentationml.presentation", sniff: "ooxml", part: "ppt/" },
  doc: { kind: "legacy", mime: "application/msword", sniff: "ole" }, xls: { kind: "legacy", mime: "application/vnd.ms-excel", sniff: "ole" },
  ppt: { kind: "legacy", mime: "application/vnd.ms-powerpoint", sniff: "ole" },
  odt: { kind: "legacy", mime: ODF + "text", sniff: "odf" }, ods: { kind: "legacy", mime: ODF + "spreadsheet", sniff: "odf" },
  odp: { kind: "legacy", mime: ODF + "presentation", sniff: "odf" }, rtf: { kind: "legacy", mime: "application/rtf", sniff: "rtf" },
  hwp: { kind: "hwp", mime: "application/x-hwp", sniff: "ole" }, hwpx: { kind: "hwp", mime: "application/vnd.hancom.hwpx", sniff: "zip" },
  m4a: { kind: "audio", mime: "audio/mp4", sniff: "audio" }, mp3: { kind: "audio", mime: "audio/mpeg", sniff: "audio" },
  wav: { kind: "audio", mime: "audio/wav", sniff: "audio" }, ogg: { kind: "audio", mime: "audio/ogg", sniff: "audio" },
  oga: { kind: "audio", mime: "audio/ogg", sniff: "audio" }, opus: { kind: "audio", mime: "audio/ogg", sniff: "audio" },
  webm: { kind: "audio", mime: "audio/webm", sniff: "audio" }, flac: { kind: "audio", mime: "audio/flac", sniff: "audio" },
  aac: { kind: "audio", mime: "audio/aac", sniff: "audio" }, mp4: { kind: "audio", mime: "audio/mp4", sniff: "audio" },
  mov: { kind: "video", mime: "video/quicktime", sniff: "mov" }, mkv: { kind: "video", mime: "video/x-matroska", sniff: "mkv" },
  avi: { kind: "video", mime: "video/x-msvideo", sniff: "avi" },
  zip: { kind: "archive", mime: "application/zip", sniff: "zip" }, tar: { kind: "archive", mime: "application/x-tar", sniff: "tar" },
  gz: { kind: "archive", mime: "application/gzip", sniff: "gzip" }, "7z": { kind: "archive", mime: "application/x-7z-compressed", sniff: "7z" },
};
// Named so the refusal is explicit even though the allowlist already excludes them.
var REJECTED = ("html htm xhtml svg svgz xml xsl js mjs css swf jar exe dll bat cmd sh ps1 msi apk lnk url scr com vbs php py " +
  "docm xlsm pptm").split(" ");
// Kinds that are transcribed (audio files and videos): they carry a transcript record and, for video, derived frames.
function isMediaKind(kind) { return kind === "audio" || kind === "video"; }
var INLINE_KINDS = { image: 1, text: 1 };

function startsWith(buf, bytes, at) {
  at = at || 0;
  if (buf.length < at + bytes.length) return false;
  for (var i = 0; i < bytes.length; i++) if (buf[at + i] !== bytes[i]) return false;
  return true;
}
function isUtf8Text(buf) {
  if (buf.indexOf(0) >= 0) return false;
  try { new TextDecoder("utf-8", { fatal: true }).decode(buf, { stream: true }); return true; } catch (_) { return false; }
}

// Magic-byte sniff of the first 4 KB. "zip" kinds are completed by readZipDirectory.
function sniffMatches(kind, head) {
  switch (kind) {
    case "png": return startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "jpeg": return startsWith(head, [0xff, 0xd8, 0xff]);
    case "gif": return startsWith(head, [0x47, 0x49, 0x46, 0x38]) && (head[4] === 0x37 || head[4] === 0x39) && head[5] === 0x61;
    case "webp": return startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8);
    case "pdf": return head.slice(0, 1024).indexOf("%PDF-") >= 0;
    case "ooxml": case "odf": case "zip": return startsWith(head, [0x50, 0x4b, 0x03, 0x04]);
    case "ole": return startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    case "rtf": return startsWith(head, [0x7b, 0x5c, 0x72, 0x74, 0x66]);
    case "audio":
      return startsWith(head, [0x49, 0x44, 0x33]) || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) // ID3 / MPEG or ADTS frame
        || (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x41, 0x56, 0x45], 8)) // RIFF WAVE
        || startsWith(head, [0x4f, 0x67, 0x67, 0x53]) || startsWith(head, [0x66, 0x4c, 0x61, 0x43]) // Ogg, FLAC
        || startsWith(head, [0x1a, 0x45, 0xdf, 0xa3]) || startsWith(head, [0x66, 0x74, 0x79, 0x70], 4); // Matroska/WebM, ISO base media
    case "mov": return head.length >= 12 && ["ftyp", "moov", "mdat", "wide", "free", "skip"].indexOf(head.toString("latin1", 4, 8)) >= 0;
    case "mkv": return startsWith(head, [0x1a, 0x45, 0xdf, 0xa3]);
    case "avi": return startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x41, 0x56, 0x49, 0x20], 8);
    case "text": return isUtf8Text(head);
    case "csv": return head.indexOf(0) < 0; // UTF-8 or Korean Excel CP949; normalizeCsv judges the whole file
    case "tar": return startsWith(head, [0x75, 0x73, 0x74, 0x61, 0x72], 257);
    case "gzip": return startsWith(head, [0x1f, 0x8b, 0x08]);
    case "7z": return startsWith(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
    default: return false;
  }
}

// Judges a zip from its central directory only (nothing is extracted):
// entry count, declared uncompressed total, and the names present.
function readZipDirectory(fd, size, limits) {
  var tailLen = Math.min(size, 65557);
  var tail = Buffer.alloc(tailLen);
  fs.readSync(fd, tail, 0, tailLen, size - tailLen);
  var eocd = -1;
  for (var i = tailLen - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw fail("unsupported");
  var entries = tail.readUInt16LE(eocd + 10), cdSize = tail.readUInt32LE(eocd + 12), cdOffset = tail.readUInt32LE(eocd + 16);
  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw fail("unsupported"); // zip64 is not accepted
  if (entries > limits.zipEntries || cdSize > 16 * MB || cdOffset + cdSize > size) throw fail("unsupported");
  var cd = Buffer.alloc(cdSize);
  var got = cdSize ? fs.readSync(fd, cd, 0, cdSize, cdOffset) : 0;
  if (got !== cdSize) throw fail("unsupported");
  var names = [], total = 0, pos = 0;
  for (var n = 0; n < entries; n++) {
    if (pos + 46 > cd.length || cd.readUInt32LE(pos) !== 0x02014b50) throw fail("unsupported");
    var usize = cd.readUInt32LE(pos + 24), nlen = cd.readUInt16LE(pos + 28), xlen = cd.readUInt16LE(pos + 30), clen = cd.readUInt16LE(pos + 32);
    if (usize === 0xffffffff) throw fail("unsupported");
    total += usize;
    if (total > limits.zipUncompressed) throw fail("unsupported");
    if (pos + 46 + nlen > cd.length) throw fail("unsupported");
    names.push(cd.slice(pos + 46, pos + 46 + nlen).toString("utf8"));
    pos += 46 + nlen + xlen + clen;
  }
  return { names: names, total: total };
}

function validateContent(fd, size, ext, limits) {
  var def = TYPES[ext];
  var head = Buffer.alloc(Math.min(size, 4096));
  if (head.length) fs.readSync(fd, head, 0, head.length, 0);
  if (!size || !sniffMatches(def.sniff, head)) throw fail("unsupported");
  if (def.sniff === "ooxml" || def.sniff === "odf" || def.sniff === "zip") {
    var ceiling = OFFICE_LIMITS[ext] ? Math.min(limits.zipUncompressed, OFFICE_LIMITS[ext]) : limits.zipUncompressed;
    var dir = readZipDirectory(fd, size, Object.assign({}, limits, { zipUncompressed: ceiling }));
    if (def.sniff === "ooxml") {
      var hasPart = dir.names.some(function (n) { return n.indexOf(def.part) === 0; });
      if (dir.names.indexOf("[Content_Types].xml") < 0 || !hasPart) throw fail("unsupported");
    } else if (def.sniff === "odf" && dir.names.indexOf("mimetype") < 0) throw fail("unsupported");
  }
}

// Korean Excel writes CSV as CP949 (EUC-KR). The whole file is judged: valid UTF-8 stays as it is; otherwise a
// file that decodes as CP949 is rewritten as UTF-8 with a BOM (Excel opens a BOM-less UTF-8 CSV as mojibake).
// Returns { size, sha256 } when the staged file was rewritten, null when it was already UTF-8; throws on garbage.
function normalizeCsv(tmpPath, size) {
  var buf = fs.readFileSync(tmpPath);
  if (buf.length !== size || buf.indexOf(0) >= 0) throw fail("unsupported");
  try { new TextDecoder("utf-8", { fatal: true }).decode(buf); return null; } catch (_) { /* not UTF-8 */ }
  var text;
  try { text = new TextDecoder("euc-kr", { fatal: true }).decode(buf); } catch (_) { throw fail("unsupported"); }
  var out = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]);
  fs.writeFileSync(tmpPath, out);
  return { size: out.length, sha256: crypto.createHash("sha256").update(out).digest("hex") };
}

// --- Names ----------------------------------------------------------------------------

// The client name is metadata only: it never forms a path.
function sanitizeName(raw) {
  var s = typeof raw === "string" ? raw : "";
  try { s = s.normalize("NFC"); } catch (_) { /* keep */ }
  s = s.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩؜﻿]/g, "").replace(/[\/\\:]/g, "");
  s = s.replace(/^[.\s]+/, "").replace(/[\s.]+$/, "");
  if (Array.from(s).length > 200) {
    var ext = /(\.[A-Za-z0-9]{1,8})$/.exec(s);
    s = Array.from(s).slice(0, 200 - (ext ? ext[1].length : 0)).join("") + (ext ? ext[1] : "");
  }
  return s;
}
function extOf(name) {
  var m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return m ? m[1].toLowerCase() : "";
}

// The file name an AI sees under inbox/: derived from the display name, never a path. Anything outside letters,
// digits and ". _ - ( ) space" becomes "_"; no leading dot; collisions (case-insensitive) get " (2)", " (3)"...
function safeInboxName(display, used) {
  var s = sanitizeName(display).replace(/[^\p{L}\p{N}._ ()-]/gu, "_").replace(/^[.\s_]+/, "").replace(/[\s.]+$/, "");
  var ext = /(\.[A-Za-z0-9]{1,8})$/.exec(s);
  var stem = ext ? s.slice(0, -ext[0].length) : s;
  stem = Array.from(stem).slice(0, 100).join("").replace(/[\s.]+$/, "") || "file";
  var suffix = ext ? ext[0] : "";
  var taken = {};
  (used || []).forEach(function (n) { taken[String(n).toLowerCase()] = 1; });
  var out = stem + suffix, n = 2;
  while (taken[out.toLowerCase()]) out = stem + " (" + (n++) + ")" + suffix;
  return out;
}

// --- Root -----------------------------------------------------------------------------

// env AIGORA_ATTACHMENTS_DIR > daemon config `attachmentsDir` > <AIGORA_HOME>/attachments.
// Pure lookup: nothing is created here.
function resolveAttachmentsRoot(env) {
  env = env || process.env;
  if (env.AIGORA_ATTACHMENTS_DIR) return path.resolve(env.AIGORA_ATTACHMENTS_DIR);
  var cfg = require("./config");
  var daemon = null;
  try { daemon = cfg.loadConfig(); } catch (_) { daemon = null; }
  if (daemon && typeof daemon.attachmentsDir === "string" && daemon.attachmentsDir) return path.resolve(daemon.attachmentsDir);
  return path.join(cfg.AIGORA_HOME, "attachments");
}

// --- Response headers -----------------------------------------------------------------

function contentDisposition(name, inline) {
  var enc = encodeURIComponent(name).replace(/['()*]/g, function (c) { return "%" + c.charCodeAt(0).toString(16).toUpperCase(); });
  return (inline ? "inline" : "attachment") + "; filename*=UTF-8''" + enc;
}
// The one header helper for every attachment response. Content-Type is a server
// constant per extension; inline is honoured only for raster images and text.
function responseHeaders(record, opts) {
  opts = opts || {};
  var def = TYPES[record.ext] || {};
  var inline = opts.disposition === "inline" && !!INLINE_KINDS[def.kind];
  var h = {
    "Content-Type": def.mime || "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": contentDisposition(record.name, inline),
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "private, no-store",
  };
  if (typeof opts.length === "number") h["Content-Length"] = String(opts.length);
  if (def.kind === "image" || def.kind === "pdf") h["Accept-Ranges"] = "bytes";
  return h;
}

// --- Store ----------------------------------------------------------------------------

var O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

function createRoomAttachments(opts) {
  var users = opts.usersModule;
  var getChannel = opts.getChannel || function () { return null; };
  var now = opts.now || Date.now;
  var auditLog = opts.auditLog === undefined ? null : opts.auditLog;
  var limits = Object.assign({}, LIMITS, opts.limits || {});
  // Audio is accepted only while transcription is enabled (default off): { enabled, maxBytes }.
  var audioCfg = opts.audio || function () { return require("./transcription").loadTranscriptionConfig(); };
  var rootDir = null;
  var rootReady = false;
  var lastPurge = 0;
  var activeUploads = new Map();   // userId -> count
  var uploadTimes = new Map();     // userId -> [ts]
  var denials = new Map();         // userId -> [ts]
  var globalCache = { at: 0, bytes: 0 };

  // Resolved once, lazily; looking the root up never creates it.
  function root() {
    if (!rootDir && opts.root) rootDir = path.resolve(typeof opts.root === "function" ? opts.root() : opts.root);
    return rootDir;
  }
  function inRoot(p) {
    var r = root(), full = path.resolve(p);
    if (full !== r && full.indexOf(r + path.sep) !== 0) throw fail("not_found");
    return full;
  }
  function ensureRoot() {
    if (rootReady) return;
    var r = root();
    if (!r) throw fail("failed");
    var lst = null;
    try { lst = fs.lstatSync(r); } catch (_) { /* created below */ }
    if (lst && lst.isSymbolicLink()) throw fail("failed");
    fs.mkdirSync(r, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(r, 0o700); } catch (_) { /* best effort */ }
    var real = fs.realpathSync(r);
    var pub = path.join(__dirname, "public") + path.sep;
    var extensionAssets = require("./extensions").assetRoots();
    if (extensionAssets.some(function (dir) { return real === dir || real.startsWith(dir + path.sep); })) throw fail("failed");
    if (real.indexOf(pub) === 0) throw fail("failed");
    ["blobs", "meta", "tmp", "audit"].forEach(function (d) { fs.mkdirSync(path.join(r, d), { recursive: true, mode: 0o700 }); });
    sweepTmp();
    rootReady = true;
  }
  function sweepTmp() {
    var dir = path.join(root(), "tmp");
    try {
      fs.readdirSync(dir).forEach(function (f) {
        var p = path.join(dir, f);
        try { if (now() - fs.lstatSync(p).mtimeMs > 3600 * 1000) fs.unlinkSync(p); } catch (_) { /* gone */ }
      });
    } catch (_) { /* none */ }
  }

  function scopeOf(ref) {
    if (ref && typeof ref.roomId === "string" && ROOM_RE.test(ref.roomId) && ref.channelId === undefined) return { kind: "room", id: ref.roomId, name: "room-" + ref.roomId };
    if (ref && typeof ref.channelId === "string" && CHAN_RE.test(ref.channelId) && ref.roomId === undefined) return { kind: "channel", id: ref.channelId, name: "chan-" + ref.channelId };
    return null;
  }
  function metaDir(scope) { return inRoot(path.join(root(), "meta", scope)); }
  function metaPath(scope, id) { return inRoot(path.join(root(), "meta", scope, id + ".json")); }
  function blobDir(scope, sha) { return inRoot(path.join(root(), "blobs", scope, sha.slice(0, 2))); }
  function blobPath(scope, sha) { return inRoot(path.join(root(), "blobs", scope, sha.slice(0, 2), sha)); }

  function readRegular(p, maxBytes) {
    var fd = fs.openSync(p, fs.constants.O_RDONLY | O_NOFOLLOW);
    try {
      var st = fs.fstatSync(fd);
      if (!st.isFile() || st.size > maxBytes) throw fail("not_found");
      var buf = Buffer.alloc(st.size);
      fs.readSync(fd, buf, 0, st.size, 0);
      return buf;
    } finally { fs.closeSync(fd); }
  }
  function readMeta(scope, id) {
    if (typeof id !== "string" || !ID_RE.test(id)) return null;
    try {
      var rec = JSON.parse(readRegular(metaPath(scope, id), 64 * 1024).toString("utf8"));
      if (!rec || rec.attachmentId !== id || rec.scope !== scope || !SHA_RE.test(rec.sha256 || "")) return null;
      return rec;
    } catch (_) { return null; }
  }
  function listMeta(scope) {
    var out = [];
    var names = [];
    try { names = fs.readdirSync(metaDir(scope)); } catch (_) { return out; }
    names.forEach(function (f) {
      var m = /^([a-f0-9]{32})\.json$/.exec(f);
      var rec = m && readMeta(scope, m[1]);
      if (rec) out.push(rec);
    });
    return out;
  }
  function writeMeta(rec) {
    var dir = metaDir(rec.scope);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    var tmp = path.join(dir, rec.attachmentId + ".json.tmp-" + crypto.randomBytes(4).toString("hex"));
    fs.writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
    fs.renameSync(tmp, metaPath(rec.scope, rec.attachmentId));
  }

  // --- Audit ---------------------------------------------------------------------------
  // One append-only line per action; never file content.
  function audit(actor, scope, id, action, result, extra) {
    try {
      if (!rootReady && !fs.existsSync(root())) return; // a denial must not create the store
      var line = Object.assign({ ts: new Date(now()).toISOString(), actor: actor && actor.id || null, scope: scope || null, attachmentId: id || null, action: action, result: result }, extra || {});
      var dir = path.join(root(), "audit");
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      var fd = fs.openSync(path.join(dir, line.ts.slice(0, 7) + ".jsonl"), fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | O_NOFOLLOW, 0o600);
      try { fs.writeSync(fd, JSON.stringify(line) + "\n"); } finally { fs.closeSync(fd); }
    } catch (_) { /* auditing never breaks a request */ }
  }
  function auditGlobal(action, ctx) {
    var fn = auditLog;
    if (fn === null) { try { fn = require("./audit").log; } catch (_) { fn = null; } }
    try { if (fn) fn(action, ctx); } catch (_) { /* never throws into callers */ }
  }

  // --- Authorization -------------------------------------------------------------------

  function recent(map, key, windowMs) {
    var t = now(), list = (map.get(key) || []).filter(function (x) { return t - x < windowMs; });
    map.set(key, list);
    return list;
  }
  function denied(actor, scope, id, action) {
    var list = recent(denials, actor.id, 60000);
    list.push(now());
    if (list.length > limits.deniedPerMinute) {
      audit(actor, scope, id, action, "rate_limited");
      throw fail("rate_limited");
    }
    audit(actor, scope, id, action, "denied");
  }
  function roleIn(userId, roomId) {
    try { return users.getRoomRole(userId, roomId) || null; } catch (_) { return null; }
  }
  function userOk(userId) {
    try { var u = users.findUserById(userId); return !!u && u.disabled !== true; } catch (_) { return false; }
  }
  var READ = { view: 1, download: 1, list: 1 };
  var WRITE = { upload: 1, comment: 1, delete: 1, share: 1, edit: 1, attach: 1, outbox: 1 };

  // The single authorization path. HTTP, WebSocket and the comment check all call it.
  // actor -> { id }. ref -> { roomId } | { channelId }. attachmentId is optional (upload/list).
  function authorizeAttachment(actor, ref, attachmentId, action, probe) {
    if (!actor || typeof actor.id !== "string" || !actor.id) throw fail("unauthorized");
    var sc = scopeOf(ref);
    var ctx = null, rec = null;
    try {
      if (sc && (READ[action] || WRITE[action]) && userOk(actor.id)) {
        if (sc.kind === "room") {
          var role = roleIn(actor.id, sc.id);
          if (role) ctx = { role: role, owner: role === "owner" };
        } else {
          var ch = getChannel(sc.id);
          var roomRole = ch && typeof ch.roomId === "string" ? roleIn(actor.id, ch.roomId) : null;
          if (ch && roomRole) {
            if (ch.ownerUserId === actor.id) ctx = { role: "member", owner: true, channel: ch };
            else if (roomRole === "owner") ctx = { role: "admin", adminRead: true, channel: ch };
          }
        }
      }
      if (ctx && attachmentId !== undefined && attachmentId !== null) {
        rec = readMeta(sc.name, attachmentId);
        var bound = rec && (sc.kind === "room" ? rec.roomId === sc.id : rec.channelId === sc.id);
        if (!bound || rec.deletedAt) ctx = null;
      }
      if (ctx) {
        var ok;
        if (READ[action]) ok = true;
        else if (sc.kind === "room") {
          if (ctx.role === "viewer") ok = false;
          else if (action === "upload") ok = true;
          else if (action === "comment") ok = !!rec;
          else if (action === "delete") ok = !!rec && (rec.uploaderId === actor.id || ctx.role === "owner");
          else if (action === "edit") ok = !!rec && CO_EDIT.indexOf(rec.ext) >= 0;
          else if (action === "attach") ok = !!rec; // member or above (viewers were refused above)
          else if (action === "outbox") ok = true;
          else ok = false; // share is private -> room: no
        } else {
          // Private channel: only its owner writes, and only while it is active.
          ok = !!ctx.owner && ctx.channel.state === "active" && (action !== "comment" || !!rec) && (action !== "share" || !!rec);
          if ((action === "delete" || action === "edit" || action === "attach") && !rec) ok = false;
          if (action === "outbox") ok = false; // a channel workspace exists only per turn: nothing to collect from
          if (action === "edit" && rec && CO_EDIT.indexOf(rec.ext) < 0) ok = false;
        }
        if (!ok) ctx = null;
      }
    } catch (e) {
      if (e && e.code === "rate_limited") throw e;
      ctx = null;
    }
    if (!ctx) {
      if (!probe) denied(actor, sc && sc.name, attachmentId, action);
      throw fail("not_found");
    }
    if (ctx.adminRead && !probe) {
      audit(actor, sc.name, attachmentId, action, "ok", { admin: true });
      auditGlobal("attachment.admin_read", { actorId: actor.id, target: attachmentId || sc.id, metadata: { channelId: sc.id, ownerId: ctx.channel.ownerUserId, action: action } });
    }
    return { actor: actor, scope: sc, role: ctx.role, owner: !!ctx.owner, adminRead: !!ctx.adminRead, channel: ctx.channel || null, record: rec };
  }

  // --- Quotas --------------------------------------------------------------------------

  function distinctBytes(records) {
    var seen = {}, total = 0;
    records.forEach(function (r) { if (!seen[r.sha256]) { seen[r.sha256] = 1; total += r.size; } });
    return total;
  }
  function globalBytes() {
    if (now() - globalCache.at < 30000) return globalCache.bytes;
    var total = 0;
    try {
      var base = path.join(root(), "blobs");
      fs.readdirSync(base).forEach(function (sc) {
        fs.readdirSync(path.join(base, sc)).forEach(function (pre) {
          fs.readdirSync(path.join(base, sc, pre)).forEach(function (f) {
            try { total += fs.lstatSync(path.join(base, sc, pre, f)).size; } catch (_) { /* gone */ }
          });
        });
      });
    } catch (_) { /* empty */ }
    try {
      var vbase = path.join(root(), "video");
      fs.readdirSync(vbase).forEach(function (sc) {
        fs.readdirSync(path.join(vbase, sc)).forEach(function (id) { total += dirBytes(path.join(vbase, sc, id)); });
      });
    } catch (_) { /* none */ }
    try {
      var tbase = path.join(root(), "transcripts");
      fs.readdirSync(tbase).forEach(function (sc) { total += dirBytes(path.join(tbase, sc)); });
    } catch (_) { /* none */ }  // iron-laws: ignore[IL-301] best-effort usage scan; a missing transcripts dir counts as zero bytes
    globalCache = { at: now(), bytes: total };
    return total;
  }
  // Derived data of a video (frames + analysis.json) is charged like the blobs: to the room, to the uploader and to the global total.
  function dirBytes(dir) {
    var n = 0;
    try { fs.readdirSync(dir).forEach(function (f) { try { var st = fs.lstatSync(path.join(dir, f)); if (st.isFile()) n += st.size; } catch (_) { /* gone */ } }); } catch (_) { /* none */ }
    return n;
  }
  function derivedBytes(records, exceptId) {
    var n = 0;
    records.forEach(function (r) {
      if (r.attachmentId === exceptId) return;
      // Whatever derived data a record carries is charged, whatever its kind (MP4/WebM are stored as audio): frames and transcript.
      n += derivedInboxBytes(r.scope, r.attachmentId);
    });
    return n;
  }
  function typeAllowed(ext) {
    var def = TYPES[ext];
    if (!def || REJECTED.indexOf(ext) >= 0) return false;
    if (!isMediaKind(def.kind)) return true;
    try {
      var c = audioCfg();
      return c.enabled === true && (def.kind !== "video" || !!(c.video && c.video.enabled));
    } catch (_) { return false; }
  }
  function fileCap(ext) {
    var kind = TYPES[ext].kind;
    if (isMediaKind(kind)) { var m = 0; try { m = audioCfg().maxBytes; } catch (_) { m = 0; } return Math.max(0, Math.min(m || 0, limits.audio)); }
    return kind === "image" ? Math.min(limits.image, limits.perFile) : limits.perFile;
  }

  // Adds a record for `sha` into the scope, enforcing count and quota. Synchronous end to end
  // (no await between the check and the commit), so concurrent uploads cannot overshoot.
  function commitRecord(actor, sc, data, moveBlob) {
    var records = listMeta(sc.name);
    var live = records.filter(function (r) { return !r.deletedAt; });
    if (live.length >= (sc.kind === "room" ? limits.roomFiles : limits.channelFiles)) throw fail("quota");
    var withVersions = records.concat(scopeVersions(sc.name));
    var exists = withVersions.some(function (r) { return r.sha256 === data.sha256; });
    if (!exists) {
      if (sc.kind === "room" && distinctBytes(withVersions) + derivedBytes(records) + data.size > limits.roomBytes) throw fail("quota");
      var mine = records.filter(function (r) { return r.uploaderId === actor.id; });
      var cap = sc.kind === "room" ? limits.userRoomBytes : limits.userChannelBytes;
      if (distinctBytes(mine) + derivedBytes(mine) + data.size > cap) throw fail("quota");
      if (globalBytes() + data.size > limits.globalBytes) throw fail("storage_full");
      moveBlob(blobDir(sc.name, data.sha256), blobPath(sc.name, data.sha256));
      globalCache.bytes += data.size;
    }
    var rec = {
      attachmentId: crypto.randomBytes(16).toString("hex"), scope: sc.name, uploaderId: actor.id,
      name: data.name, ext: data.ext, mediaType: TYPES[data.ext].mime, size: data.size, sha256: data.sha256,
      createdAt: now(), kind: "file", currentVersion: 1,
    };
    if (sc.kind === "room") rec.roomId = sc.id; else rec.channelId = sc.id;
    if (data.sourceAttachmentId) rec.sourceAttachmentId = data.sourceAttachmentId;
    if (data.source) rec.source = data.source;
    writeMeta(rec);
    return rec;
  }

  function dto(rec) {
    var out = {
      id: rec.attachmentId, kind: rec.roomId !== undefined ? "room" : "channel", name: rec.name, ext: rec.ext,
      mediaType: rec.mediaType, size: rec.size, uploaderId: rec.uploaderId, createdAt: rec.createdAt,
      type: (TYPES[rec.ext] || {}).kind || "other", version: rec.currentVersion || 1,
    };
    if (rec.roomId !== undefined) out.roomId = rec.roomId; else out.channelId = rec.channelId;
    return out;
  }

  // --- Upload --------------------------------------------------------------------------

  // beginUpload checks authorization and the name first, so a refused upload never touches disk.
  // write() is synchronous and enforces the byte cap itself (Content-Length is never trusted).
  function beginUpload(actor, ref, rawName, extra) {
    var auth = authorizeAttachment(actor, ref, undefined, "upload");
    var name = sanitizeName(rawName), ext = extOf(name);
    if (!name || !ext || !typeAllowed(ext)) { audit(actor, auth.scope.name, null, "upload", "unsupported"); throw fail("unsupported"); }
    var tw = recent(uploadTimes, actor.id, 60000);
    if (tw.length >= limits.ratePerMinute) { audit(actor, auth.scope.name, null, "upload", "rate_limited"); throw fail("rate_limited"); }
    if ((activeUploads.get(actor.id) || 0) >= 1) { audit(actor, auth.scope.name, null, "upload", "busy"); throw fail("busy"); }
    ensureRoot();
    if (globalBytes() >= limits.globalBytes) throw fail("storage_full");
    var tmp = path.join(root(), "tmp", crypto.randomBytes(16).toString("hex"));
    var fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o600);
    tw.push(now());
    activeUploads.set(actor.id, 1);
    var hash = crypto.createHash("sha256"), size = 0, cap = fileCap(ext), open = true, done = false;
    function release() {
      if (open) { try { fs.closeSync(fd); } catch (_) { /* closed */ } open = false; }
      if (!done) { done = true; activeUploads.delete(actor.id); }
    }
    function abort() { release(); try { fs.unlinkSync(tmp); } catch (_) { /* gone */ } }
    return {
      name: name,
      write: function (chunk) {
        size += chunk.length;
        if (size > cap) { abort(); audit(actor, auth.scope.name, null, "upload", "too_large"); throw fail("too_large"); }
        hash.update(chunk);
        fs.writeSync(fd, chunk, 0, chunk.length);
      },
      abort: abort,
      finish: function () {
        try {
          fs.closeSync(fd); open = false;
          var sha = hash.digest("hex");
          if (ext === "csv") {
            var norm = normalizeCsv(tmp, size);
            if (norm) { size = norm.size; sha = norm.sha256; if (size > cap) throw fail("too_large"); }
          }
          var rfd = fs.openSync(tmp, fs.constants.O_RDONLY | O_NOFOLLOW);
          try { validateContent(rfd, size, ext, limits); } finally { fs.closeSync(rfd); }
          // Authority is judged again right before the commit: a removal or demotion while the bytes streamed in counts.
          authorizeAttachment(actor, ref, undefined, "upload", true);
          var rec = commitRecord(actor, auth.scope, { name: name, ext: ext, size: size, sha256: sha, source: extra && extra.source }, function (dir, dest) {
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            fs.renameSync(tmp, dest);
          });
          audit(actor, auth.scope.name, rec.attachmentId, "upload", "ok", { size: size });
          maybePurge();
          return dto(rec);
        } catch (e) {
          if (e && e.code && e.code !== "failed") audit(actor, auth.scope.name, null, "upload", e.code);
          throw e && e.code ? e : fail("failed");
        } finally { abort(); }
      },
    };
  }

  // Convenience for callers that already hold the bytes or a stream (tests, copies).
  function uploadBuffer(actor, ref, name, buf) {
    var up = beginUpload(actor, ref, name);
    try { up.write(buf); } catch (e) { throw e; }
    return up.finish();
  }

  // The upload pipeline's checks (type, size cap, content sniff) for a file that is not being uploaded yet.
  // Throws the same codes an upload would. Returns the sanitized name and extension.
  function precheck(rawName, fd, size) {
    var name = sanitizeName(rawName), ext = extOf(name);
    if (!name || !ext || !typeAllowed(ext)) throw fail("unsupported");
    if (size > fileCap(ext)) throw fail("too_large");
    validateContent(fd, size, ext, limits);
    return { name: name, ext: ext };
  }

  // --- Read / list / delete / share ----------------------------------------------------

  function list(actor, ref) {
    var auth = authorizeAttachment(actor, ref, undefined, "list");
    return listMeta(auth.scope.name).filter(function (r) { return !r.deletedAt; }).sort(function (a, b) { return a.createdAt - b.createdAt; }).map(dto);
  }

  // Opens the blob with O_NOFOLLOW after the authorization; the caller streams and closes `fd`.
  function open(actor, ref, attachmentId, action) {
    var auth = authorizeAttachment(actor, ref, attachmentId, action || "download");
    var rec = auth.record, fd;
    try {
      var p = blobPath(auth.scope.name, rec.sha256);
      var real = fs.realpathSync(path.dirname(p));
      var realRoot = fs.realpathSync(root());
      if (real !== realRoot && real.indexOf(realRoot + path.sep) !== 0) throw fail("not_found");
      fd = fs.openSync(p, fs.constants.O_RDONLY | O_NOFOLLOW);
      var st = fs.fstatSync(fd);
      if (!st.isFile() || st.size !== rec.size) throw fail("not_found");
    } catch (e) {
      if (fd !== undefined) try { fs.closeSync(fd); } catch (_) { /* closed */ }
      audit(actor, auth.scope.name, attachmentId, "download", "missing");
      throw fail("not_found");
    }
    audit(actor, auth.scope.name, attachmentId, "download", "ok", auth.adminRead ? { admin: true } : undefined);
    return { fd: fd, record: rec, size: rec.size, headers: function (o) { return responseHeaders(rec, Object.assign({ length: rec.size }, o)); } };
  }

  function remove(actor, ref, attachmentId) {
    var auth = authorizeAttachment(actor, ref, attachmentId, "delete");
    cancelJobs(auth.scope.name, attachmentId);
    var rec = Object.assign({}, auth.record, { deletedAt: now() });
    writeMeta(rec);
    dropTranscript(auth.scope.name, attachmentId);
    dropVideo(auth.scope.name, attachmentId);
    audit(actor, auth.scope.name, attachmentId, "delete", "ok");
    return dto(rec);
  }

  // Background jobs on an attachment (the video analysis). A token is cancelled when its attachment or scope is removed; the
  // job checks it before every write, so nothing it finishes later can land in a removed attachment, room or channel.
  var jobs = new Set();
  function beginJob(ref, id) {
    var sc = scopeOf(ref);
    if (!sc || typeof id !== "string" || !ID_RE.test(id)) return null;
    var tok = { scope: sc.name, id: id, cancelled: false };
    jobs.add(tok);
    return tok;
  }
  function endJob(tok) { jobs.delete(tok); }
  function cancelJobs(scopeName, id) { jobs.forEach(function (t) { if (t.scope === scopeName && (id === undefined || t.id === id)) t.cancelled = true; }); }

  // Private -> room is a copy, never a link. Source: the channel owner. Target: member or above.
  function share(actor, ref, attachmentId, targetRoomId) {
    var auth = authorizeAttachment(actor, ref, attachmentId, "share");
    var target = typeof targetRoomId === "string" && ROOM_RE.test(targetRoomId) ? scopeOf({ roomId: targetRoomId }) : null;
    var role = target ? roleIn(actor.id, target.id) : null;
    if (!target || auth.scope.kind !== "channel" || (role !== "member" && role !== "owner")) {
      denied(actor, auth.scope.name, attachmentId, "share");
      throw fail("not_found");
    }
    ensureRoot();
    var src = auth.record;
    var rec;
    try {
      rec = commitRecord(actor, target, { name: src.name, ext: src.ext, size: src.size, sha256: src.sha256, sourceAttachmentId: src.attachmentId }, function (dir, dest) {
        var rfd = fs.openSync(blobPath(auth.scope.name, src.sha256), fs.constants.O_RDONLY | O_NOFOLLOW);
        try {
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
          var tmp = path.join(root(), "tmp", crypto.randomBytes(16).toString("hex"));
          var wfd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o600);
          try {
            var chunk = Buffer.alloc(64 * 1024), n;
            while ((n = fs.readSync(rfd, chunk, 0, chunk.length, null)) > 0) fs.writeSync(wfd, chunk, 0, n);
          } finally { fs.closeSync(wfd); }
          fs.renameSync(tmp, dest);
        } finally { fs.closeSync(rfd); }
      });
    } catch (e) {
      audit(actor, auth.scope.name, attachmentId, "share", (e && e.code) || "failed", { target: target.name });
      throw e && e.code ? e : fail("failed");
    }
    audit(actor, auth.scope.name, attachmentId, "share", "ok", { target: target.name, copy: rec.attachmentId });
    return dto(rec);
  }

  // --- Versions (office saves) ---------------------------------------------------------
  // versions/<scope>/<attachmentId>/<n>.json = { n, sha256, size, savedBy, savedAt, key?, restoredFrom? }.
  // Version 1 is implicit (the upload itself) until a first save writes it down. History is append-only:
  // a restore creates a new version, nothing is rewritten.

  function versionsDir(scope, id) { return inRoot(path.join(root(), "versions", scope, id)); }
  function versionPath(scope, id, n) { return inRoot(path.join(root(), "versions", scope, id, n + ".json")); }
  function readVersion(scope, id, n) {
    try {
      var v = JSON.parse(readRegular(versionPath(scope, id, n), 16 * 1024).toString("utf8"));
      return v && v.n === n && SHA_RE.test(v.sha256 || "") ? v : null;
    } catch (_) { return null; }
  }
  function readVersions(scope, id) {
    var out = [];
    var names = [];
    try { names = fs.readdirSync(versionsDir(scope, id)); } catch (_) { return out; }
    names.forEach(function (f) {
      var m = /^([0-9]{1,6})\.json$/.exec(f);
      var v = m && readVersion(scope, id, Number(m[1]));
      if (v) out.push(v);
    });
    return out.sort(function (a, b) { return a.n - b.n; });
  }
  function writeVersion(scope, id, v) {
    var dir = versionsDir(scope, id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    var tmp = path.join(dir, v.n + ".json.tmp-" + crypto.randomBytes(4).toString("hex"));
    fs.writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 });
    fs.renameSync(tmp, versionPath(scope, id, v.n));
  }
  // Every version of every attachment in a scope (quota and purge count their blobs).
  function scopeVersions(scope) {
    var out = [];
    var ids = [];
    try { ids = fs.readdirSync(inRoot(path.join(root(), "versions", scope))); } catch (_) { return out; }
    ids.forEach(function (id) { if (ID_RE.test(id)) readVersions(scope, id).forEach(function (v) { out.push(v); }); });
    return out;
  }
  function ensureCurrentVersion(rec) {
    if (readVersion(rec.scope, rec.attachmentId, rec.currentVersion)) return;
    writeVersion(rec.scope, rec.attachmentId, { n: rec.currentVersion, sha256: rec.sha256, size: rec.size, savedBy: rec.uploaderId, savedAt: rec.updatedAt || rec.createdAt });
  }
  function versionSha(rec, n) {
    if (n === rec.currentVersion) return { sha256: rec.sha256, size: rec.size };
    var v = readVersion(rec.scope, rec.attachmentId, n);
    return v ? { sha256: v.sha256, size: v.size } : null;
  }
  function shaReferenced(scope, sha) {
    return listMeta(scope).some(function (r) { return r.sha256 === sha; }) || scopeVersions(scope).some(function (v) { return v.sha256 === sha; });
  }
  function pruneVersions(rec) {
    var all = readVersions(rec.scope, rec.attachmentId);
    var drop = all.filter(function (v) { return v.n !== rec.currentVersion; });
    drop = drop.slice(0, Math.max(0, all.length - limits.versionsKept));
    drop.forEach(function (v) { try { fs.unlinkSync(versionPath(rec.scope, rec.attachmentId, v.n)); } catch (_) { /* gone */ } });
    drop.forEach(function (v) {
      if (!shaReferenced(rec.scope, v.sha256)) { try { fs.unlinkSync(blobPath(rec.scope, v.sha256)); globalCache.at = 0; } catch (_) { /* gone */ } }
    });
  }
  function openBlobFd(scopeName, sha, size) {
    var p = blobPath(scopeName, sha), fd;
    try {
      var real = fs.realpathSync(path.dirname(p)), realRoot = fs.realpathSync(root());
      if (real !== realRoot && real.indexOf(realRoot + path.sep) !== 0) throw fail("not_found");
      fd = fs.openSync(p, fs.constants.O_RDONLY | O_NOFOLLOW);
      var st = fs.fstatSync(fd);
      if (!st.isFile() || st.size !== size) throw fail("not_found");
      return fd;
    } catch (e) {
      if (fd !== undefined) try { fs.closeSync(fd); } catch (_) { /* closed */ }
      throw fail("not_found");
    }
  }
  // Room quota with one-version slack: a save is not lost because the room is just full.
  function assertSaveQuota(sc, size, sha) {
    var records = listMeta(sc.name);
    var refs = records.concat(scopeVersions(sc.name));
    if (refs.some(function (r) { return r.sha256 === sha; })) return false; // blob already in the scope
    var cap = sc.kind === "room" ? limits.roomBytes : limits.userChannelBytes;
    if (distinctBytes(refs) + size > cap * (1 + limits.versionSlack)) throw fail("quota");
    if (globalBytes() + size > limits.globalBytes) throw fail("storage_full");
    return true;
  }
  function moveBlobIn(scopeName, sha, tmp) {
    fs.mkdirSync(blobDir(scopeName, sha), { recursive: true, mode: 0o700 });
    fs.renameSync(tmp, blobPath(scopeName, sha));
  }

  // The save path: a document the Document Server hands back. There is no actor here (the callback is
  // authorized by its docToken and DS' JWT, not a session); the bytes pass the same type checks as an upload.
  // info: { savedBy, key }. Returns { write, abort, finish }; finish() -> { unchanged, version, dto }.
  function beginSave(ref, attachmentId, info) {
    info = info || {};
    var sc = scopeOf(ref);
    if (!sc) throw fail("not_found");
    ensureRoot();
    var rec0 = readMeta(sc.name, attachmentId);
    if (!rec0 || rec0.deletedAt || CO_EDIT.indexOf(rec0.ext) < 0) throw fail("not_found");
    var ext = rec0.ext, startVersion = rec0.currentVersion;
    var tmp = path.join(root(), "tmp", crypto.randomBytes(16).toString("hex"));
    var fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o600);
    var hash = crypto.createHash("sha256"), size = 0, open = true, cap = Math.min(fileCap(ext), OFFICE_LIMITS.maxDownload);
    function abort() { if (open) { try { fs.closeSync(fd); } catch (_) { /* closed */ } open = false; } try { fs.unlinkSync(tmp); } catch (_) { /* gone */ } }
    return {
      write: function (chunk) {
        size += chunk.length;
        if (size > cap) { abort(); throw fail("too_large"); }
        hash.update(chunk);
        fs.writeSync(fd, chunk, 0, chunk.length);
      },
      abort: abort,
      finish: function () {
        try {
          fs.closeSync(fd); open = false;
          var sha = hash.digest("hex");
          var rfd = fs.openSync(tmp, fs.constants.O_RDONLY | O_NOFOLLOW);
          try { validateContent(rfd, size, ext, limits); } finally { fs.closeSync(rfd); }
          var rec = readMeta(sc.name, attachmentId);
          if (!rec || rec.deletedAt) throw fail("not_found");
          // The download took time: authority and generation are checked again right before committing (everything
          // from here to writeMeta is synchronous, so a restore cannot interleave).
          if (info.savedBy) {
            try { authorizeAttachment({ id: info.savedBy }, ref, attachmentId, "edit", true); } catch (_) { throw fail("forbidden", 403); }
          }
          if (Number.isInteger(info.keyVer) && info.keyVer < (Number.isInteger(rec.restoreFloor) ? rec.restoreFloor : 0)) throw fail("conflict", 409);
          if (rec.currentVersion !== startVersion) throw fail("conflict", 409);
          if (sha === rec.sha256) {
            // Same bytes: nothing to version. A callback replayed after a crash between the record and the
            // version file still records its key here, so the next replay is recognised.
            ensureCurrentVersion(rec);
            var cur = readVersion(sc.name, attachmentId, rec.currentVersion);
            if (info.key && cur && !cur.key) writeVersion(sc.name, attachmentId, Object.assign({}, cur, { key: info.key }));
            return { unchanged: true, version: rec.currentVersion, dto: dto(rec) };
          }
          var fresh = assertSaveQuota(sc, size, sha);
          ensureCurrentVersion(rec);
          if (fresh) { moveBlobIn(sc.name, sha, tmp); globalCache.bytes += size; }
          var next = Object.assign({}, rec, { sha256: sha, size: size, currentVersion: rec.currentVersion + 1, updatedAt: now() });
          writeMeta(next);
          writeVersion(sc.name, attachmentId, { n: next.currentVersion, sha256: sha, size: size, savedBy: info.savedBy || null, savedAt: next.updatedAt, key: info.key || null });
          pruneVersions(next);
          audit(info.savedBy ? { id: info.savedBy } : null, sc.name, attachmentId, "office_save", "ok", { version: next.currentVersion, size: size });
          return { unchanged: false, version: next.currentVersion, dto: dto(next) };
        } finally { abort(); }
      },
    };
  }

  function hasVersionKey(ref, attachmentId, key) {
    var sc = scopeOf(ref);
    if (!sc || !key || !readMeta(sc.name, attachmentId)) return false;
    return readVersions(sc.name, attachmentId).some(function (v) { return v.key === key; });
  }

  function listVersions(actor, ref, attachmentId) {
    var auth = authorizeAttachment(actor, ref, attachmentId, "view");
    var rec = auth.record;
    if (CO_EDIT.indexOf(rec.ext) < 0) return [];
    ensureCurrentVersion(rec);
    return readVersions(auth.scope.name, attachmentId).map(function (v) {
      return { n: v.n, size: v.size, savedBy: v.savedBy, savedAt: v.savedAt, restoredFrom: v.restoredFrom || null, current: v.n === rec.currentVersion };
    }).sort(function (a, b) { return b.n - a.n; });
  }

  // Download of one stored version; same authorization as the current file.
  function openVersion(actor, ref, attachmentId, n) {
    var auth = authorizeAttachment(actor, ref, attachmentId, "download");
    var rec = auth.record, v = Number.isInteger(n) ? versionSha(rec, n) : null;
    if (!v) { audit(actor, auth.scope.name, attachmentId, "download", "missing"); throw fail("not_found"); }
    var fd = openBlobFd(auth.scope.name, v.sha256, v.size);
    audit(actor, auth.scope.name, attachmentId, "download", "ok", { version: n });
    var vrec = Object.assign({}, rec, { size: v.size });
    return { fd: fd, record: rec, size: v.size, headers: function (o) { return responseHeaders(vrec, Object.assign({ length: v.size }, o)); } };
  }

  // Server-to-server read for the Document Server: callers (office.js) have already authorized.
  function openInternal(ref, attachmentId, n) {
    var sc = scopeOf(ref);
    if (!sc) throw fail("not_found");
    var rec = readMeta(sc.name, attachmentId);
    if (!rec || rec.deletedAt) throw fail("not_found");
    var v = versionSha(rec, n === undefined || n === null ? rec.currentVersion : n);
    if (!v) throw fail("not_found");
    return { fd: openBlobFd(sc.name, v.sha256, v.size), size: v.size, record: rec };
  }
  // Lowest editing-generation version a Document Server callback may still save under (0 = no restore yet).
  function restoreFloorOf(ref, attachmentId) {
    var sc = scopeOf(ref), rec = sc && readMeta(sc.name, attachmentId);
    return rec && Number.isInteger(rec.restoreFloor) ? rec.restoreFloor : 0;
  }
  function currentVersionOf(ref, attachmentId) {
    var sc = scopeOf(ref), rec = sc && readMeta(sc.name, attachmentId);
    return rec && !rec.deletedAt ? rec.currentVersion : null;
  }

  // Restore creates a new version from an old blob (history is never rewritten). The caller must have
  // established that nobody has the document open: the editor would otherwise overwrite the restore.
  function restoreVersion(actor, ref, attachmentId, n) {
    var auth = authorizeAttachment(actor, ref, attachmentId, "edit");
    var rec = auth.record, sc = auth.scope;
    var old = Number.isInteger(n) ? versionSha(rec, n) : null;
    if (!old || n === rec.currentVersion) throw fail("invalid");
    ensureCurrentVersion(rec);
    fs.closeSync(openBlobFd(sc.name, old.sha256, old.size)); // proves the blob is still there
    var next = Object.assign({}, rec, { sha256: old.sha256, size: old.size, currentVersion: rec.currentVersion + 1, updatedAt: now() });
    next.restoreFloor = next.currentVersion; // editing generations (keys) older than this restore are void
    writeMeta(next);
    writeVersion(sc.name, attachmentId, { n: next.currentVersion, sha256: old.sha256, size: old.size, savedBy: actor.id, savedAt: next.updatedAt, key: null, restoredFrom: n });
    pruneVersions(next);
    audit(actor, sc.name, attachmentId, "office_restore", "ok", { from: n, version: next.currentVersion });
    return dto(next);
  }

  // --- Per-instruction AI files ---------------------------------------------------------
  // Nothing about "given to the AI" is stored: the sender picks files for ONE instruction. This checks the pick
  // against the sender's access (same rules as every attachment action) and the inbox limits; the copy into a
  // workspace is done by lib/attachment-ai.js at that turn's start.
  function aiSelect(actor, ref, ids) {
    if (!Array.isArray(ids) || !ids.length) return [];
    var seen = {}, out = [], bytes = 0;
    ids.forEach(function (id) {
      if (typeof id !== "string" || seen[id]) return;
      seen[id] = true;
      var auth = authorizeAttachment(actor, ref, id, "attach");
      out.push({ id: id, name: auth.record.name, size: auth.record.size });
      // A media pick copies in only its transcript, analysis document and frames: count what is really stored for it.
      bytes += isMediaKind((TYPES[auth.record.ext] || {}).kind) ? derivedInboxBytes(auth.scope.name, id) : auth.record.size;
    });
    if (out.length > limits.aiInboxFiles || bytes > limits.aiInboxBytes) throw fail("quota");
    return out;
  }
  function derivedInboxBytes(scope, id) {
    var n = dirBytes(path.join(root(), "video", scope, id));
    try { n += fs.lstatSync(transcriptPath(scope, id)).size; } catch (_) { /* none */ }
    return n;
  }
  // Turn path, no actor: the live record behind a validated pick, or null (deleted meanwhile).
  function aiRecord(ref, attachmentId) {
    var sc = scopeOf(ref), rec = sc && readMeta(sc.name, attachmentId);
    var bound = rec && (sc.kind === "room" ? rec.roomId === sc.id : rec.channelId === sc.id);
    return bound && !rec.deletedAt ? rec : null;
  }

  // --- Transcripts (audio -> text) ------------------------------------------------------
  // transcripts/<scope>/<attachmentId>.json = { status: running|done|failed, text?, language?, duration?, error?, at }.
  // Per scope like the blobs, so a transcript never leaves the room / channel its audio belongs to; removed with
  // the attachment (delete) and with the scope. A "running" mark with no live job (the daemon restarted) reads as failed.
  var transcribing = new Set();
  function transcriptPath(scope, id) { return inRoot(path.join(root(), "transcripts", scope, id + ".json")); }
  function dropTranscript(scope, id) { try { fs.unlinkSync(transcriptPath(scope, id)); } catch (_) { /* none */ } transcribing.delete(scope + "/" + id); }
  function readTranscript(scope, id) {
    if (typeof id !== "string" || !ID_RE.test(id)) return null;
    var rec = null;
    try { rec = JSON.parse(readRegular(transcriptPath(scope, id), 8 * MB).toString("utf8")); } catch (_) { return null; }
    if (!rec || typeof rec !== "object" || ["running", "done", "failed"].indexOf(rec.status) < 0) return null;
    if (rec.status === "running" && !transcribing.has(scope + "/" + id)) return { status: "failed", error: "interrupted", at: rec.at };
    return rec;
  }
  // Server-side only (the upload handler / its job). Writes nothing when the attachment is gone or is not audio.
  function putTranscript(ref, id, data) {
    var sc = scopeOf(ref), rec = sc && readMeta(sc.name, id);
    var bound = rec && (sc.kind === "room" ? rec.roomId === sc.id : rec.channelId === sc.id);
    if (!bound || rec.deletedAt || !isMediaKind((TYPES[rec.ext] || {}).kind)) return false;
    ensureRoot();
    var key = sc.name + "/" + id;
    var out = { status: data.status, at: now() };
    if (data.status === "done") { out.text = String(data.text || ""); out.language = data.language || ""; out.duration = data.duration == null ? null : data.duration; }
    if (data.status === "failed") out.error = typeof data.error === "string" ? data.error.slice(0, 40) : "failed";
    if (data.status === "running") transcribing.add(key); else transcribing.delete(key);
    var dir = inRoot(path.join(root(), "transcripts", sc.name));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    var tmp = path.join(dir, id + ".json.tmp-" + crypto.randomBytes(4).toString("hex"));
    fs.writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
    fs.renameSync(tmp, transcriptPath(sc.name, id));
    return true;
  }
  // The transcript of one attachment for an actor who may view it (null: none yet, or not audio).
  function getTranscript(actor, ref, id) {
    var auth = authorizeAttachment(actor, ref, id, "view");
    if (!isMediaKind((TYPES[auth.record.ext] || {}).kind)) return null;
    return readTranscript(auth.scope.name, id);
  }
  // Turn path, no actor: for a pick validated when the instruction arrived.
  function transcriptInternal(ref, id) {
    var rec = aiRecord(ref, id);
    return rec && isMediaKind((TYPES[rec.ext] || {}).kind) ? readTranscript(scopeOf(ref).name, id) : null;
  }

  // --- Video analysis (derived data of a video attachment) -------------------------------
  // video/<scope>/<attachmentId>/{analysis.json, frame-NN.jpg}, 0700/0600. Lives and dies with the attachment: removed by
  // remove(), purge() and removeScope(). No HTTP route reads it; the only readers are the AI turn path (videoInternal /
  // videoFrameInternal, scope-bound like transcriptInternal). The frames of a private channel stay under chan-<id>.
  var FRAME_RE = /^frame-\d{2}\.jpg$/;
  var MAX_FRAMES = 15;
  function videoDir(scope, id) { return inRoot(path.join(root(), "video", scope, id)); }
  function dropVideo(scope, id) {
    if (typeof id !== "string" || !ID_RE.test(id)) return;
    try { fs.rmSync(videoDir(scope, id), { recursive: true, force: true }); } catch (_) { /* none */ }
    globalCache.at = 0; // the released bytes leave the global total
  }
  // data: { durationSec, moments: [{ t, snippet, score }], frames: [{ n, t, kind: "emphasis"|"coverage", jpeg: Buffer }] }. Replaces any earlier analysis
  // atomically (staged dir, then rename). Writes nothing when the attachment is gone or is not media.
  function putVideo(ref, id, data) {
    var sc = scopeOf(ref), rec = sc && readMeta(sc.name, id);
    var bound = rec && (sc.kind === "room" ? rec.roomId === sc.id : rec.channelId === sc.id);
    if (!bound || rec.deletedAt || !isMediaKind((TYPES[rec.ext] || {}).kind)) return false;
    var frames = Array.isArray(data.frames) ? data.frames.slice(0, MAX_FRAMES) : [];
    ensureRoot();
    // Reserve before committing: what this analysis may take is what is left of the room, the uploader's and the global quota,
    // counting the analysis it replaces as free. Frames that do not fit are left out (the text analysis is tiny).
    var recs = listMeta(sc.name), mineRecs = recs.filter(function (r) { return r.uploaderId === rec.uploaderId; });
    var ucap = sc.kind === "room" ? limits.userRoomBytes : limits.userChannelBytes;
    var budget = Math.min(
      sc.kind === "room" ? limits.roomBytes - distinctBytes(recs.concat(scopeVersions(sc.name))) - derivedBytes(recs, id) : Infinity,
      ucap - distinctBytes(mineRecs) - derivedBytes(mineRecs, id),
      limits.globalBytes - globalBytes() + dirBytes(videoDir(sc.name, id)));
    var META_RESERVE = 64 * 1024; // analysis.json
    if (budget < META_RESERVE) throw fail("quota");
    var spent = META_RESERVE;
    frames = frames.filter(function (f) {
      var n = Buffer.isBuffer(f.jpeg) ? f.jpeg.length : 0;
      if (!n || spent + n > budget) return false;
      spent += n; return true;
    });
    var parent = inRoot(path.join(root(), "video", sc.name));
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    var stage = path.join(parent, id + ".tmp-" + crypto.randomBytes(4).toString("hex"));
    fs.mkdirSync(stage, { mode: 0o700 });
    try {
      var meta = { durationSec: Number(data.durationSec) || 0, at: now(), frames: [], moments: [] };
      frames.forEach(function (f, i) {
        var file = "frame-" + (i < 9 ? "0" : "") + (i + 1) + ".jpg";
        if (!Buffer.isBuffer(f.jpeg) || !f.jpeg.length || f.jpeg.length > 4 * MB) return;
        fs.writeFileSync(path.join(stage, file), f.jpeg, { mode: 0o600 });
        meta.frames.push({ n: meta.frames.length + 1, t: Number(f.t) || 0, file: file, kind: f.kind === "emphasis" ? "emphasis" : "coverage" });
      });
      (Array.isArray(data.moments) ? data.moments : []).slice(0, 20).forEach(function (m) {
        meta.moments.push({ t: Number(m.t) || 0, snippet: String(m.snippet || "").slice(0, 200), score: Math.round((Number(m.score) || 0) * 100) / 100 });
      });
      fs.writeFileSync(path.join(stage, "analysis.json"), JSON.stringify(meta), { mode: 0o600 });
      var dest = videoDir(sc.name, id);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.renameSync(stage, dest);
      globalCache.at = 0;
    } catch (e) {
      try { fs.rmSync(stage, { recursive: true, force: true }); } catch (_) { /* swept with the scope */ }
      throw e;
    }
    return true;
  }
  // Turn path, no actor: the analysis of a validated pick of this scope, or null.
  function videoInternal(ref, id) {
    var rec = aiRecord(ref, id);
    if (!rec || !isMediaKind((TYPES[rec.ext] || {}).kind)) return null;
    try {
      var meta = JSON.parse(readRegular(path.join(videoDir(scopeOf(ref).name, id), "analysis.json"), MB).toString("utf8"));
      if (!meta || !Array.isArray(meta.frames)) return null;
      meta.frames = meta.frames.filter(function (f) { return f && FRAME_RE.test(f.file); }).slice(0, MAX_FRAMES);
      return meta;
    } catch (_) { return null; }
  }
  function videoFrameInternal(ref, id, file) {
    if (!FRAME_RE.test(String(file)) || !aiRecord(ref, id)) return null;
    try { return readRegular(path.join(videoDir(scopeOf(ref).name, id), file), 4 * MB); } catch (_) { return null; }
  }

  // --- Maintenance ---------------------------------------------------------------------

  // Blobs with no live record 14 days after the last deletion are removed.
  function purge() {
    var removed = 0;
    try {
      ensureRoot();
      var cutoff = now() - 14 * 86400 * 1000;
      fs.readdirSync(path.join(root(), "meta")).forEach(function (scope) {
        var recs = listMeta(scope), gone = [];
        recs.forEach(function (r) {
          if (!r.deletedAt || r.deletedAt > cutoff) return;
          try { fs.unlinkSync(metaPath(scope, r.attachmentId)); } catch (_) { return; }
          dropTranscript(scope, r.attachmentId);
          dropVideo(scope, r.attachmentId);
          gone.push(r);
        });
        // A purged record takes its version history with it; a blob goes only when nothing else in the scope uses it.
        var goneVersions = [];
        gone.forEach(function (r) {
          readVersions(scope, r.attachmentId).forEach(function (v) { goneVersions.push(v); });
          try { fs.rmSync(versionsDir(scope, r.attachmentId), { recursive: true, force: true }); } catch (_) { /* counted at deletion */ }
        });
        var kept = {};
        recs.forEach(function (r) { if (gone.indexOf(r) < 0) kept[r.sha256] = 1; });
        scopeVersions(scope).forEach(function (v) { kept[v.sha256] = 1; });
        gone.concat(goneVersions).forEach(function (r) {
          if (kept[r.sha256]) return;
          kept[r.sha256] = 1;
          try { fs.unlinkSync(blobPath(scope, r.sha256)); removed++; } catch (_) { /* gone */ }
        });
      });
    } catch (_) { /* best effort */ }
    globalCache.at = 0;
    return removed;
  }
  function maybePurge() {
    if (now() - lastPurge < 24 * 3600 * 1000) return;
    lastPurge = now();
    purge();
  }

  function scopeNames(kind, id) {
    return kind === "room" ? "room-" + id : "chan-" + id;
  }
  // Removes every blob, record and version of one scope. Returns { remaining } (0 = clean).
  function removeScope(kind, id) {
    var name = (kind === "room" ? ROOM_RE : CHAN_RE).test(String(id)) ? scopeNames(kind, id) : null;
    if (name) cancelJobs(name);
    if (!name || !root()) return { remaining: 0 };
    var left = 0;
    ["blobs", "meta", "versions", "pending", "transcripts", "video"].forEach(function (d) {
      var p = path.join(root(), d, name);
      try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* counted below */ }
      left += count(p);
    });
    globalCache.at = 0;
    return { remaining: left };
  }
  function count(p) {
    var n = 0;
    try {
      var st = fs.lstatSync(p);
      if (!st.isDirectory()) return 1;
      fs.readdirSync(p).forEach(function (f) { n += count(path.join(p, f)); });
    } catch (_) { return 0; }
    return n;
  }
  function removeRoomAttachments(roomId) { return removeScope("room", roomId); }
  function removeChannelAttachments(channelId) { return removeScope("channel", channelId); }
  // Files still on disk for a room (read-only; used by findRemnants).
  function countRoomAttachments(roomId) {
    if (!ROOM_RE.test(String(roomId)) || !root()) return 0;
    return ["blobs", "meta", "versions", "transcripts", "video"].reduce(function (n, d) { return n + count(path.join(root(), d, "room-" + roomId)); }, 0);
  }

  return {
    authorizeAttachment: authorizeAttachment, beginUpload: beginUpload, uploadBuffer: uploadBuffer, list: list, open: open,
    remove: remove, share: share, purge: purge, removeRoomAttachments: removeRoomAttachments,
    removeChannelAttachments: removeChannelAttachments, countRoomAttachments: countRoomAttachments, root: root, dto: dto,
    beginSave: beginSave, hasVersionKey: hasVersionKey, listVersions: listVersions, openVersion: openVersion,
    openInternal: openInternal, currentVersionOf: currentVersionOf, restoreFloorOf: restoreFloorOf, restoreVersion: restoreVersion,
    auditEvent: audit, scopeOf: scopeOf, precheck: precheck, ensureRoot: ensureRoot, now: now,
    aiSelect: aiSelect, aiRecord: aiRecord,
    putTranscript: putTranscript, getTranscript: getTranscript, transcriptInternal: transcriptInternal,
    beginJob: beginJob, endJob: endJob, limits: limits,
    putVideo: putVideo, videoInternal: videoInternal, videoFrameInternal: videoFrameInternal,
  };
}

module.exports = {
  createRoomAttachments: createRoomAttachments, resolveAttachmentsRoot: resolveAttachmentsRoot, responseHeaders: responseHeaders,
  sanitizeName: sanitizeName, safeInboxName: safeInboxName, LIMITS: LIMITS, OFFICE_LIMITS: OFFICE_LIMITS, DOWNLOAD_ONLY: DOWNLOAD_ONLY, CO_EDIT: CO_EDIT, TYPES: TYPES, REJECTED: REJECTED,
};

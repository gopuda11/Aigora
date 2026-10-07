"use strict";
// transcription.js - audio attachments -> text through an OpenAI-compatible speech-to-text endpoint.
//
// daemon.json: transcription: { enabled, baseUrl, apiKey?, model, language?, maxBytes? }. Off by default; anything
// malformed falls back to "off" (a bad baseUrl or model never enables the feature). The endpoint is
// POST {baseUrl}/audio/transcriptions (multipart: file, model, response_format=verbose_json, language?) answering
// { text, language?, duration?, segments?: [{ start, end, text }] } (a plain { text } is accepted too).
//
// The audio bytes are streamed from the stored blob (never buffered whole). The client file name is never sent: the
// part is always "audio.<ext>" with an extension from our own allowlist. Errors carry only a short code, never the
// server's body or the API key. One transcription runs at a time (a lecture at 30x realtime is about a minute);
// the rest wait in a short queue.

var fs = require("fs");
var { quarantineCorrupt } = require("./quarantine-corrupt");
var path = require("path");
var http = require("http");
var https = require("https");
var crypto = require("crypto");

var MB = 1024 * 1024;
var MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,99}$/;
var LANG_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;
var DEFAULT_MAX_BYTES = 100 * MB;
var HARD_MAX_BYTES = 500 * MB;
var RESPONSE_CAP = 16 * MB;
var TEXT_CAP = 2 * MB;            // transcript characters kept
var QUEUE_MAX = 20;
var AUDIO_EXTS = ["m4a", "mp3", "wav", "ogg", "oga", "opus", "webm", "flac", "aac", "mp4"];
var VIDEO_EXTS = ["mov", "mkv", "avi"];   // video-only containers; mp4/webm are in AUDIO_EXTS and analysed as video when they have a picture
var VIDEO_DEFAULTS = { topK: 12, maxMinutes: 180, llmModel: "qwen3-8b-npu" };
var UPLOAD_MIME = { m4a: "audio/mp4", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", webm: "audio/webm", flac: "audio/flac", aac: "audio/aac", mp4: "audio/mp4" };

function isObj(v) { return !!v && typeof v === "object" && !Array.isArray(v); }

function resolveBaseUrl(v) {
  if (typeof v !== "string") return "";
  var s = v.trim().replace(/\/+$/, "");
  try {
    var u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    if (u.username || u.password || u.search || u.hash) return "";
    return s;
  } catch (_) { return ""; }
}

function resolveTranscriptionConfig(raw) {
  var c = isObj(raw) ? raw : {};
  var baseUrl = resolveBaseUrl(c.baseUrl);
  var model = typeof c.model === "string" && MODEL_RE.test(c.model) ? c.model : "";
  var maxBytes = Number.isInteger(c.maxBytes) && c.maxBytes >= 1 ? Math.min(c.maxBytes, HARD_MAX_BYTES) : DEFAULT_MAX_BYTES;
  var enabled = c.enabled === true && !!baseUrl && !!model;
  var topK = Number.isInteger(c.videoTopK) && c.videoTopK >= 0 && c.videoTopK <= 20 ? c.videoTopK : VIDEO_DEFAULTS.topK;
  var maxMin = Number.isInteger(c.videoMaxMinutes) && c.videoMaxMinutes >= 1 && c.videoMaxMinutes <= 600 ? c.videoMaxMinutes : VIDEO_DEFAULTS.maxMinutes;
  var llmModel = typeof c.videoLlmModel === "string" && MODEL_RE.test(c.videoLlmModel) ? c.videoLlmModel : VIDEO_DEFAULTS.llmModel;
  return {
    // Video analysis follows transcription unless switched off on its own.
    video: { enabled: enabled && c.videoEnabled !== false, llm: c.videoLlm !== false, visual: c.videoVisual === true, topK: topK, maxDurationSec: maxMin * 60, llmModel: llmModel },
    enabled: enabled,
    baseUrl: baseUrl,
    apiKey: typeof c.apiKey === "string" ? c.apiKey.trim() : "",
    model: model,
    language: typeof c.language === "string" && LANG_RE.test(c.language.trim()) ? c.language.trim() : "",
    maxBytes: maxBytes,
  };
}

// Admin settings (the settings pane) live in <config dir>/transcription.json (0600, atomic write) and are overlaid on
// daemon.json "transcription": a field present in the file wins. The daemon never rewrites daemon.json for this.
function settingsFile() { return path.join(require("./config").CONFIG_DIR, "transcription.json"); }
function readOverlay(file) {
  try { var o = JSON.parse(fs.readFileSync(file || settingsFile(), "utf8")); return isObj(o) ? o : {}; } catch (e) { quarantineCorrupt(file || settingsFile(), e); return {}; }
}
function rawConfig(file) {
  var base = null;
  try { var all = require("./config").loadConfig(); base = all && all.transcription; } catch (_) { base = null; }
  return Object.assign({}, isObj(base) ? base : {}, readOverlay(file));
}

// Read on every call so a daemon.json or settings edit applies without a restart.
function loadTranscriptionConfig() { return resolveTranscriptionConfig(rawConfig()); }

// Admin write. patch: { enabled, baseUrl, model, language, apiKey?, clearApiKey? }; apiKey is write-only (absent keeps it).
// Returns false (nothing written) when enabling with an invalid URL/model/language.
function saveSettings(patch, file) {
  var prev = readOverlay(file);
  var next = {
    enabled: patch.enabled === true,
    baseUrl: typeof patch.baseUrl === "string" ? patch.baseUrl.trim() : "",
    model: typeof patch.model === "string" ? patch.model.trim() : "",
    language: typeof patch.language === "string" ? patch.language.trim() : "",
  };
  if (typeof prev.maxBytes === "number") next.maxBytes = prev.maxBytes;
  if (typeof prev.videoLlmModel === "string") next.videoLlmModel = prev.videoLlmModel;
  // Video settings: absent keeps the stored value; a present but invalid one refuses the whole save.
  var vOk = true;
  function keep(key, ok) {
    if (patch[key] === undefined) { if (prev[key] !== undefined) next[key] = prev[key]; return; }
    if (ok(patch[key])) next[key] = patch[key]; else vOk = false;
  }
  keep("videoEnabled", function (v) { return typeof v === "boolean"; });
  keep("videoLlm", function (v) { return typeof v === "boolean"; });
  keep("videoVisual", function (v) { return typeof v === "boolean"; });
  keep("videoTopK", function (v) { return Number.isInteger(v) && v >= 0 && v <= 20; });
  keep("videoMaxMinutes", function (v) { return Number.isInteger(v) && v >= 1 && v <= 600; });
  if (!vOk) return false;
  if (patch.clearApiKey === true) { /* dropped */ } else if (typeof patch.apiKey === "string" && patch.apiKey.trim()) next.apiKey = patch.apiKey.trim().slice(0, 300);
  else if (typeof prev.apiKey === "string" && prev.apiKey) next.apiKey = prev.apiKey;
  var r = resolveTranscriptionConfig(next);
  if (next.enabled && !r.enabled) return false;
  if (next.language && !r.language) return false;
  var f = file || settingsFile();
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  var tmp = f + "." + process.pid + "." + crypto.randomBytes(4).toString("hex") + ".tmp", fd = null;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(next));
    fs.closeSync(fd); fd = null;
    fs.renameSync(tmp, f);
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* closed */ } }
    try { fs.unlinkSync(tmp); } catch (_) { /* gone */ }
    throw e;
  }
  return true;
}

// What the admin API returns: flags and non-secret fields only, never the key.
function status(file) {
  var raw = rawConfig(file), str = function (v) { return typeof v === "string" ? v : ""; };
  return { enabled: raw.enabled === true, baseUrl: str(raw.baseUrl), model: str(raw.model), language: str(raw.language), hasApiKey: !!str(raw.apiKey), active: resolveTranscriptionConfig(raw).enabled,
    // video.enabled is the EFFECTIVE state (false while transcription is off); configuredEnabled is the stored preference the admin form shows and saves.
    video: Object.assign({}, resolveTranscriptionConfig(raw).video, { configuredEnabled: raw.videoEnabled !== false }) };
}

// The public view (never the key): what the settings pane shows.
function publicConfig(cfg) {
  return { enabled: cfg.enabled, baseUrl: cfg.baseUrl, model: cfg.model, language: cfg.language, hasApiKey: !!cfg.apiKey, maxBytes: cfg.maxBytes, video: cfg.video };
}

function isAudioExt(ext) { return AUDIO_EXTS.indexOf(String(ext || "").toLowerCase()) >= 0; }
function isVideoExt(ext) { return VIDEO_EXTS.indexOf(String(ext || "").toLowerCase()) >= 0; }
// Anything that is transcribed: audio files and the video containers.
function isMediaExt(ext) { return isAudioExt(ext) || isVideoExt(ext); }

function fail(code) { var e = new Error(code); e.code = code; return e; }

// Headroom for a long file: the base covers a cold model load; one second of wall time per second of audio at a
// pessimistic 128 kbit/s is far slower than any real endpoint.
function timeoutFor(size) {
  return Math.min(3 * 3600 * 1000, 120000 + Math.ceil(size / 16000) * 1000);
}

function stamp(sec) {
  var s = Math.max(0, Math.floor(Number(sec) || 0));
  var m = Math.floor(s / 60), r = s % 60;
  return "[" + (m < 10 ? "0" : "") + m + ":" + (r < 10 ? "0" : "") + r + "]";
}

// { text, segments? } -> the document the model reads: one "[mm:ss] text" line per segment when there are any.
function formatTranscript(body) {
  var segs = Array.isArray(body.segments) ? body.segments.filter(function (s) { return s && typeof s.text === "string" && s.text.trim(); }) : [];
  var text = segs.length
    ? segs.map(function (s) { return stamp(s.start) + " " + s.text.trim(); }).join("\n")
    : String(body.text || "").trim();
  if (text.length > TEXT_CAP) text = text.slice(0, TEXT_CAP) + "\n[...]";
  return text;
}

function createTranscriber(opts) {
  opts = opts || {};
  var load = opts.loadConfig || loadTranscriptionConfig;
  var running = false, waiting = [];

  function post(cfg, file) {
    return new Promise(function (resolve, reject) {
      var u;
      try { u = new URL(cfg.baseUrl + "/audio/transcriptions"); } catch (_) { return reject(fail("bad_config")); }
      var boundary = "----aigora" + crypto.randomBytes(12).toString("hex");
      function field(name, value) { return "--" + boundary + '\r\nContent-Disposition: form-data; name="' + name + '"\r\n\r\n' + value + "\r\n"; }
      var head = Buffer.from(
        field("model", cfg.model) + field("response_format", "verbose_json") + (cfg.language ? field("language", cfg.language) : "") +
        "--" + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="audio.' + file.ext + '"\r\nContent-Type: ' + (UPLOAD_MIME[file.ext] || "application/octet-stream") + "\r\n\r\n");
      var tail = Buffer.from("\r\n--" + boundary + "--\r\n");
      var headers = {
        "Content-Type": "multipart/form-data; boundary=" + boundary,
        "Content-Length": String(head.length + file.size + tail.length),
        Accept: "application/json",
      };
      if (cfg.apiKey) headers.Authorization = "Bearer " + cfg.apiKey;
      var lib = u.protocol === "https:" ? https : http;
      var settled = false, timer = null, reading = false, afterRead = null;
      function done(err, val) {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (err) { try { req.destroy(); } catch (_) { /* gone */ } }
        // The caller closes the descriptor once we settle, so a read still in flight must finish first.
        function release() { if (err) reject(err); else resolve(val); }
        if (reading) afterRead = release; else release();
      }
      var req = lib.request({ protocol: u.protocol, hostname: u.hostname, port: u.port || undefined, path: u.pathname, method: "POST", headers: headers, agent: false }, function (res) {
        var chunks = [], got = 0;
        res.on("data", function (c) {
          got += c.length;
          if (got > RESPONSE_CAP) return done(fail("bad_response"));
          chunks.push(c);
        });
        res.on("error", function () { done(fail("unreachable")); });
        res.on("end", function () {
          if (res.statusCode < 200 || res.statusCode >= 300) return done(fail(res.statusCode === 401 || res.statusCode === 403 ? "auth" : res.statusCode === 413 ? "too_large" : "http_error"));
          var body;
          try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (_) { return done(fail("bad_response")); }
          if (!isObj(body) || typeof body.text !== "string") return done(fail("bad_response"));
          done(null, body);
        });
      });
      timer = setTimeout(function () { done(fail("timeout")); }, timeoutFor(file.size));
      req.on("error", function () { done(fail("unreachable")); });
      // The file is read here with positional reads on the caller's descriptor (never wrapped in a stream, which would
      // close it); the caller closes it after we settle. Backpressure: wait for "drain" when the socket is full.
      req.write(head);
      var pos = 0, buf = Buffer.allocUnsafe(64 * 1024);
      function pump() {
        if (settled) return;
        if (pos >= file.size) return void req.end(tail);
        reading = true;
        fs.read(file.fd, buf, 0, Math.min(buf.length, file.size - pos), pos, function (e, n) {
          reading = false;
          if (afterRead) return afterRead();
          if (settled) return;
          if (e || n === 0) return done(fail("failed"));
          pos += n;
          if (req.write(Buffer.from(buf.subarray(0, n)))) pump(); else req.once("drain", pump);
        });
      }
      pump();
    });
  }

  // file: { fd, size, ext }. Resolves { text, language, duration } where text is the formatted transcript.
  function runNow(file) {
    var cfg = load();
    if (!cfg.enabled) return Promise.reject(fail("disabled"));
    if (!isAudioExt(file.ext)) return Promise.reject(fail("unsupported"));
    if (file.size > cfg.maxBytes) return Promise.reject(fail("too_large"));
    return post(cfg, file).then(function (body) {
      var text = formatTranscript(body);
      if (!text) throw fail("empty");
      var segments = Array.isArray(body.segments) ? body.segments.filter(function (s) { return s && typeof s.text === "string" && s.text.trim() && Number.isFinite(s.start); })
        .map(function (s) { return { start: s.start, end: Number.isFinite(s.end) ? s.end : s.start, text: s.text.trim() }; }) : [];
      return { text: text, segments: segments, language: typeof body.language === "string" ? body.language.slice(0, 40) : "", duration: Number.isFinite(body.duration) ? body.duration : null };
    });
  }

  function pump() {
    if (running || !waiting.length) return;
    var job = waiting.shift();
    running = true;
    var p;
    try { p = job.open(); } catch (e) { running = false; job.reject(e && e.code ? e : fail("failed")); return pump(); }
    var closed = false;
    function close() { if (!closed) { closed = true; try { job.close && job.close(p); } catch (_) { /* closed */ } } }
    runNow(p).then(function (r) { close(); running = false; job.resolve(r); pump(); },
      function (e) { close(); running = false; job.reject(e && e.code ? e : fail("failed")); pump(); });
  }

  // job: { open() -> { fd, size, ext }, close(file) }. At most one runs; at most QUEUE_MAX wait (else "busy").
  // The file is opened only when the job's turn comes, so a queued job holds no descriptor.
  function enqueue(job) {
    return new Promise(function (resolve, reject) {
      if (waiting.length >= QUEUE_MAX) return reject(fail("busy"));
      waiting.push({ open: job.open, close: job.close, resolve: resolve, reject: reject });
      pump();
    });
  }

  return { enqueue: enqueue, config: load, enabled: function () { return load().enabled; }, _runNow: runNow };
}

var shared = null;
function sharedTranscriber() { if (!shared) shared = createTranscriber(); return shared; }

module.exports = {
  resolveTranscriptionConfig: resolveTranscriptionConfig, loadTranscriptionConfig: loadTranscriptionConfig, publicConfig: publicConfig,
  saveSettings: saveSettings, status: status, createTranscriber: createTranscriber, sharedTranscriber: sharedTranscriber, formatTranscript: formatTranscript,
  isAudioExt: isAudioExt, isVideoExt: isVideoExt, isMediaExt: isMediaExt, VIDEO_EXTS: VIDEO_EXTS, stamp: stamp, TEXT_CAP: TEXT_CAP, timeoutFor: timeoutFor, AUDIO_EXTS: AUDIO_EXTS, DEFAULT_MAX_BYTES: DEFAULT_MAX_BYTES, HARD_MAX_BYTES: HARD_MAX_BYTES,
};

// jev-shadow.js - shared foreground JEV client and background data collection ("shadow mode"). With AIGORA_JEV_API_KEY set, each eligible routing
// decision is also sent to TypeSafe System One (JEV) in the background. The answer NEVER affects routing; it is only
// appended to a local JSONL (0600) beside the Clef answer for later comparison. Env only: no UI, no product feature.
//
//   AIGORA_JEV_API_KEY    key; unset = completely inert
//   AIGORA_JEV_DAILY_CAP  max calls per UTC day, owner-wide (default 200)
//   AIGORA_JEV_LOG_TEXT=1 also store the raw task text (default: length + sha256 only)
//
// record() is fire-and-forget: it only enqueues (bounded) and returns; all file I/O is async and serialized per
// directory. The daily counter is a small state file (jev-counter.json), shared by every instance in the process,
// reserved and persisted atomically BEFORE the call is dispatched and counted by the reservation day, so a crash
// or restart cannot hand out the same allowance twice. The log itself is never scanned.
"use strict";

var fs = require("fs");
var fsp = fs.promises;
var path = require("path");
var crypto = require("crypto");
var clef = require("./clef");

var URL_DEFAULT = "https://api.typesafe.ai/v1/systemone";
var MODEL_DEFAULT = "jev-latest";
var MAX_QUEUE = 50;
// Origin: the author's decision policy v1 back-off values. Billing exhaustion (402) backs off until the next UTC day;
// rate limiting (429) backs off for ten minutes.
var RATE_LIMIT_BACKOFF_MS = 600000;

// dir -> { chain: Promise, pending: number, counter: {day, n} | null }. Module-level: one counter per owner/config dir.
var shared = new Map();
function stateFor(dir) {
  var s = shared.get(dir);
  if (!s) { s = { chain: Promise.resolve(), pending: 0, counter: null }; shared.set(dir, s); }
  return s;
}

async function ensureDir(dir) { await fsp.mkdir(dir, { recursive: true, mode: 0o700 }); }

async function atomicWrite(file, text) {
  var tmp = file + "." + process.pid + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  var fh = null;
  try {
    fh = await fsp.open(tmp, "wx", 0o600);
    await fh.writeFile(text); // writes every byte
    await fh.sync();
    await fh.close(); fh = null;
    await fsp.rename(tmp, file);
  } catch (e) {
    if (fh) await fh.close().catch(function () {});
    await fsp.unlink(tmp).catch(function () {});
    throw e;
  }
}

// Append one line; the file must be a regular 0600 file owned by us before anything is written (fix it, else fail closed).
async function appendPrivate(file, line) {
  var fh = await fsp.open(file, "a", 0o600);
  try {
    var st = await fh.stat();
    if (!st.isFile() || (typeof process.getuid === "function" && st.uid !== process.getuid())) throw new Error("log_not_private");
    if ((st.mode & 0o777) !== 0o600) {
      await fh.chmod(0o600);
      if (((await fh.stat()).mode & 0o777) !== 0o600) throw new Error("log_not_private");
    }
    await fh.appendFile(line);
  } finally { await fh.close(); }
}

function createJevShadow(options) {
  options = options || {};
  var env = options.env || process.env;
  var url = options.url || URL_DEFAULT;
  var dirFn = options.dir ? function () { return options.dir; } : function () { return path.join(require("../config").CONFIG_DIR, "routing"); };
  var now = options.now || Date.now;
  var timeoutMs = options.timeoutMs || 8000;
  function key() { return options.key ? options.key() : env.AIGORA_JEV_API_KEY; }
  function cap() { var n = parseInt(env.AIGORA_JEV_DAILY_CAP, 10); return n >= 0 ? n : 200; }
  function day() { return new Date(now()).toISOString().slice(0, 10); }

  // Reserve one call for today; persists before returning true.
  async function reserve(dir, st) {
    var d = day(), file = path.join(dir, "jev-counter.json");
    if (!st.counter) {
      try {
        var c = JSON.parse(await fsp.readFile(file, "utf8"));
        st.counter = c && typeof c.day === "string" && Number.isInteger(c.n) && c.n >= 0 ? { day: c.day, n: c.n, backoffUntil: Number.isFinite(c.backoffUntil) ? c.backoffUntil : 0 } : { day: d, n: cap() }; // unreadable state: fail closed
      } catch (e) { st.counter = e && e.code === "ENOENT" ? { day: d, n: 0 } : { day: d, n: cap() }; }
    }
    if (st.counter.day !== d) st.counter = { day: d, n: 0, backoffUntil: st.counter.backoffUntil || 0 }; // a 429/402 backoff outlives the UTC day roll
    if (st.counter.backoffUntil > now()) return "backoff";
    if (st.counter.n >= cap()) return "daily_cap";
    var next = { day: d, n: st.counter.n + 1, backoffUntil: st.counter.backoffUntil || 0 };
    await ensureDir(dir);
    await atomicWrite(file, JSON.stringify(next));
    st.counter = next;
    return true;
  }

  // Serialize only accounting, not the HTTP request: concurrent foreground
  // decisions still share an atomically reserved owner-wide allowance.
  function accounting(fn) {
    var st = stateFor(dirFn());
    var job = st.chain.then(fn);
    st.chain = job.catch(function () {});  // iron-laws: ignore[IL-301] accounting chain is fire-and-forget; the caller already gets the job's own rejection
    return job;
  }
  async function foreground(req) {
    try {
      var token = key();
      if (!token) return { ok: false, reason: "off", latencyMs: 0 };
      if (req.signal && req.signal.aborted) return { ok: false, reason: "cancelled", latencyMs: 0 };
      var admitted = await accounting(function () { return reserve(dirFn(), stateFor(dirFn())); });
      if (admitted !== true) return { ok: false, reason: admitted, latencyMs: 0 };
      var r = await clef.ask(Object.assign({}, req, { url: url, token: token, model: env.AIGORA_JEV_MODEL || MODEL_DEFAULT, timeoutMs: req.timeoutMs || timeoutMs }));
      if (r.reason === "http_402" || r.reason === "http_429") {
        await accounting(async function () {
          var st = stateFor(dirFn());
          st.counter.backoffUntil = r.reason === "http_402" ? Date.parse(day() + "T00:00:00Z") + 86400000 : now() + RATE_LIMIT_BACKOFF_MS;
          await atomicWrite(path.join(dirFn(), "jev-counter.json"), JSON.stringify(st.counter));
        });
      }
      r.model = env.AIGORA_JEV_MODEL || MODEL_DEFAULT;
      return r;
    } catch (e) { console.warn("[jev-shadow] accounting failed: " + (e && e.code || "error")); return { ok: false, reason: "accounting", latencyMs: 0 }; }
  }
  async function run(info) {
    var dir = dirFn();
    var text = String(info.text || "");
    var r = await foreground({ state: text });
    if (["off", "daily_cap", "backoff", "accounting"].indexOf(r.reason) !== -1) return false;
    var rec = {
      ts: new Date(now()).toISOString(), day: day(), requestHash: clef.sha256(text), textLength: text.length,
      questions: Object.keys(clef.QUESTIONS), clef: info.clef || null,
      jev: r.ok ? r.answers : { error: r.reason }, latencyMs: r.latencyMs,
      models: { clef: info.clefModel || null, jev: r.ok && r.answers ? r.answers.model : env.AIGORA_JEV_MODEL || MODEL_DEFAULT },
    };
    if (env.AIGORA_JEV_LOG_TEXT === "1") rec.text = text;
    await appendPrivate(path.join(dir, "jev-shadow.jsonl"), JSON.stringify(rec) + "\n");
    return true;
  }

  return {
    active: function () { return !!key(); },
    ask: foreground,
    // Never awaited by routing. Resolves true when a call was made; never rejects.
    record: function (info) {
      if (!key()) return Promise.resolve(false);
      var st = stateFor(dirFn());
      if (st.pending >= MAX_QUEUE) return Promise.resolve(false);
      st.pending++;
      var job = (st.shadowChain || Promise.resolve()).then(function () { return run(info); }).catch(function () { return false; }).then(function (v) { st.pending--; return v; });  // iron-laws: ignore[IL-301] shadow run is best-effort and must never fail the user turn; false means not recorded
      st.shadowChain = job;
      return job;
    },
  };
}

module.exports = { createJevShadow: createJevShadow, MODEL_DEFAULT: MODEL_DEFAULT, _shared: shared };

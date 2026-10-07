"use strict";
// broker-usage.js - budgets and usage accounting of the credential broker
// (docs/superpowers/specs/2026-10-04-credential-broker-design.md 3.5).
//
// - Counters: per run (memory only), per actor/day, per room/day, global/day (persisted to CONFIG_DIR/broker-usage.json,
//   0600, atomic tmp+rename, coalesced). Day = UTC date; a new day resets the daily counters.
// - Units are tokens and requests, not money (no price table). inputTokens counts uncached + cache read + cache write.
// - Parsers read `usage` from Anthropic SSE (message_start / message_delta) and OpenAI (response.completed) streams, or from a
//   plain JSON response, without altering or retaining the stream.
// - Over a limit the broker answers 429 + retry-after 3600 + a body naming aigora_budget_exceeded (budgetResponse()).

var fs = require("fs");
var path = require("path");

var METRICS = ["requests", "inputTokens", "outputTokens"];
var DEFAULT_LIMITS = {
  run: { requests: 400, outputTokens: 400000, inputTokens: 20000000 },
  actorDaily: { requests: 2000, outputTokens: 2000000, inputTokens: 100000000 },
  roomDaily: { requests: 4000, outputTokens: 4000000, inputTokens: 200000000 },
  globalDaily: { requests: 20000, outputTokens: 20000000, inputTokens: 1000000000 },
};
var FIELDS = ["requests", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"];
var RETRY_AFTER_SECONDS = 3600;
var MAX_KEYS = 20000; // bound on persisted actor/room entries
var MAX_LINE = 1024 * 1024;
var MAX_JSON = 8 * 1024 * 1024;

function zero() { var o = {}; FIELDS.forEach(function (f) { o[f] = 0; }); return o; }
var ZERO = Object.freeze(zero());
function dict() { return Object.create(null); }
function num(v) { return typeof v === "number" && isFinite(v) && v >= 0 ? Math.floor(v) : 0; }

// Merge partial limits over defaults; non-positive/invalid values fall back to the default (never "unlimited").
function mergeLimits(partial) {
  var out = {};
  Object.keys(DEFAULT_LIMITS).forEach(function (scope) {
    out[scope] = {};
    METRICS.forEach(function (m) {
      var v = partial && partial[scope] && typeof partial[scope] === "object" ? partial[scope][m] : undefined;
      out[scope][m] = typeof v === "number" && isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_LIMITS[scope][m];
    });
  });
  return out;
}

function dayKey(t) { return new Date(t).toISOString().slice(0, 10); }

function budgetResponse(vendor) {
  var msg = "aigora_budget_exceeded: usage budget for this run, user or room is exhausted";
  var body = vendor === "codex" || vendor === "openai"
    ? { error: { message: msg, type: "insufficient_quota", code: "aigora_budget_exceeded" } }
    : { type: "error", error: { type: "rate_limit_error", message: msg } };
  return { status: 429, headers: { "retry-after": String(RETRY_AFTER_SECONDS), "content-type": "application/json" }, body: JSON.stringify(body) };
}

function createBrokerUsage(opts) {
  opts = opts || {};
  var dir = opts.dir || require("./config").CONFIG_DIR;
  var file = path.join(dir, "broker-usage.json");
  var now = opts.now || Date.now;
  var flushMs = opts.flushMs >= 0 ? opts.flushMs : 10000;
  var day = dayKey(now());
  var actors = dict(), rooms = dict(), global = zero(), runs = dict();
  var timer = null, dirty = false, writes = 0, closed = false;

  function loadDict(src) {
    var out = dict();
    if (!src || typeof src !== "object") return out;
    Object.keys(src).slice(0, MAX_KEYS).forEach(function (k) {
      var c = zero(), s = src[k];
      if (s && typeof s === "object") FIELDS.forEach(function (f) { c[f] = num(s[f]); });
      out[k] = c;
    });
    return out;
  }

  (function load() {
    try {
      var j = JSON.parse(fs.readFileSync(file, "utf8"));
      if (j && j.day === day) {
        actors = loadDict(j.actors); rooms = loadDict(j.rooms);
        FIELDS.forEach(function (f) { global[f] = num(j.global && j.global[f]); });
      }
    } catch (e) {
      if (e && e.code !== "ENOENT") console.error("[broker-usage] ignoring unreadable counter file");
    }
  })();

  function rollover() {
    var d = dayKey(now());
    if (d === day) return;
    day = d; actors = dict(); rooms = dict(); global = zero(); markDirty();
  }

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!dirty) return;
    dirty = false;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      var tmp = file + "." + process.pid + ".tmp";
      var body = JSON.stringify({ version: 1, day: day, actors: actors, rooms: rooms, global: global });
      var fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.writeSync(fd, body); fs.fchmodSync(fd, 0o600); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, file);
      writes++;
    } catch (e) {
      dirty = true;
      console.error("[broker-usage] persist failed: " + (e && e.code ? e.code : "error"));
    }
  }

  function markDirty() {
    dirty = true;
    if (!timer && !closed) { timer = setTimeout(function () { timer = null; flush(); }, flushMs); if (timer.unref) timer.unref(); }
  }

  function roomKey(scope) { return scope.roomId ? String(scope.roomId) : scope.channelId ? "channel:" + scope.channelId : null; }
  function bucket(map, key) {
    if (key === null || key === undefined) return null;
    if (!map[key]) {
      if (Object.keys(map).length >= MAX_KEYS) return null; // bounded; overflow only loses per-key detail, global still applies
      map[key] = zero();
    }
    return map[key];
  }

  // First exhausted counter, or null. A counter is exhausted once used >= limit (a request is counted when admitted).
  // `reserve` (optional, per metric) is a conservative debit the request is about to take: it must still fit in the remaining budget.
  function exhausted(scope, limits, reserve) {
    var l = mergeLimits(limits);
    var a = actors[String(scope.actorId)], r = rooms[roomKey(scope)], run = runs[scope.runId];
    var checks = [["run", run, l.run], ["actor", a, l.actorDaily], ["room", r, l.roomDaily], ["global", global, l.globalDaily]];
    for (var i = 0; i < checks.length; i++) {
      var used = checks[i][1] || ZERO; // a bucket that does not exist yet is checked as if its usage were 0
      for (var j = 0; j < METRICS.length; j++) {
        var add = reserve ? num(reserve[METRICS[j]]) : 0, lim = checks[i][2][METRICS[j]];
        if (add ? used[METRICS[j]] + add > lim : used[METRICS[j]] >= lim) return { scope: checks[i][0], metric: METRICS[j] };
      }
    }
    return null;
  }

  function each(scope, fn) {
    var run = runs[scope.runId] || (runs[scope.runId] = zero());
    [[run, "run"], [bucket(actors, String(scope.actorId)), "actorDaily"], [bucket(rooms, roomKey(scope)), "roomDaily"], [global, "globalDaily"]].forEach(function (p) { if (p[0]) fn(p[0], p[1]); });
  }

  return {
    // Read-only check (used at open()).
    peek: function (scope, limits) { rollover(); return exhausted(scope, limits); },
    // Check and, when admitted, count one request. `reserve` ({ inputTokens, outputTokens }) is checked against the remaining budget
    // and debited at once (concurrent requests see it); the returned `reservation` goes to settle() when the request ends.
    admit: function (scope, limits, reserve) {
      rollover();
      var rin = reserve ? num(reserve.inputTokens) : 0, rout = reserve ? num(reserve.outputTokens) : 0;
      var ex = exhausted(scope, limits, { inputTokens: rin, outputTokens: rout });
      if (ex) return { ok: false, scope: ex.scope, metric: ex.metric };
      var held = [];
      each(scope, function (c, lk) { c.requests++; c.inputTokens += rin; c.outputTokens += rout; held.push([c, lk]); });
      markDirty();
      // `buckets` = the exact counters debited (run + the day buckets of the admission day); settle reconciles against these, even after a UTC rollover.
      return { ok: true, reservation: { day: day, inputTokens: rin, outputTokens: rout, buckets: held } };
    },
    // End of a request that holds a reservation. u = usage seen (or null); complete = the provider's final usage event arrived.
    //   release: nothing was billed (never forwarded / upstream error): the reservation is returned.
    //   complete: reconcile to the real usage. Otherwise (abort, no usage): never less than the reservation or the partial usage.
    // Idempotent per reservation object.
    settle: function (scope, reservation, u, complete, release) {
      rollover();
      if (reservation && reservation.settled) return; // never settle twice
      var r = reservation || null;
      if (reservation) reservation.settled = true;
      var rin = r ? r.inputTokens : 0, rout = r ? r.outputTokens : 0;
      u = u || {};
      var uin = num(u.inputTokens), uout = num(u.outputTokens), cr = num(u.cacheReadTokens), cw = num(u.cacheWriteTokens);
      var cin, cout;
      if (release) { cin = 0; cout = 0; cr = 0; cw = 0; }
      else if (complete) { cin = uin; cout = uout; }
      else { cin = Math.max(rin, uin); cout = Math.max(rout, uout); }
      if (!r && !cin && !cout && !cr && !cw) return;
      // With a reservation: the exact buckets it debited (an old day's buckets are adjusted in place; the new day is not charged for it).
      // Without one: the current buckets.
      var targets = r && r.buckets ? r.buckets.map(function (p) { return p[0]; }) : [runs[scope.runId], bucket(actors, String(scope.actorId)), bucket(rooms, roomKey(scope)), global];
      targets.forEach(function (c) {
        if (!c) return;
        c.inputTokens = Math.max(0, c.inputTokens - rin + cin);
        c.outputTokens = Math.max(0, c.outputTokens - rout + cout);
        c.cacheReadTokens += cr; c.cacheWriteTokens += cw;
      });
      markDirty();
    },
    record: function (scope, u) {
      rollover();
      u = u || {};
      var inT = num(u.inputTokens), outT = num(u.outputTokens), cr = num(u.cacheReadTokens), cw = num(u.cacheWriteTokens);
      if (!inT && !outT && !cr && !cw) return;
      each(scope, function (c) { c.inputTokens += inT; c.outputTokens += outT; c.cacheReadTokens += cr; c.cacheWriteTokens += cw; });
      markDirty();
    },
    // True when settling this reservation with `outputTokens` of output would push one of its exact buckets past a limit.
    wouldExceed: function (scope, limits, reservation, outputTokens) {
      if (!reservation || !reservation.buckets || reservation.settled) return false;
      var l = mergeLimits(limits);
      var extra = Math.max(0, num(outputTokens) - reservation.outputTokens);
      if (!extra) return false;
      return reservation.buckets.some(function (p) { return p[0].outputTokens + extra > l[p[1]].outputTokens; });
    },
    endRun: function (runId) { delete runs[runId]; },
    snapshot: function () {
      rollover();
      return JSON.parse(JSON.stringify({ day: day, actors: actors, rooms: rooms, global: global, runs: runs }));
    },
    flush: flush,
    close: function () { flush(); closed = true; if (timer) { clearTimeout(timer); timer = null; } },
    stats: function () { return { writes: writes, pending: dirty, path: file }; },
  };
}

// Normalise a provider `usage` object. inputTokens = all input processed (uncached + cache read + cache write).
function normalizeUsage(vendor, u) {
  if (!u || typeof u !== "object") return null;
  if (vendor === "codex" || vendor === "openai") {
    var cached = num(u.input_tokens_details && u.input_tokens_details.cached_tokens);
    return { inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens), cacheReadTokens: cached, cacheWriteTokens: 0 };
  }
  var cr = num(u.cache_read_input_tokens), cw = num(u.cache_creation_input_tokens);
  return { inputTokens: num(u.input_tokens) + cr + cw, outputTokens: num(u.output_tokens), cacheReadTokens: cr, cacheWriteTokens: cw };
}

// Streaming parser. push(chunk) while relaying; result() at the end or on abort (usage up to that point).
// mode: "sse" or "json". Memory is bounded (line cap, JSON cap); anything unparseable is ignored, never thrown.
function createUsageParser(vendor, mode) {
  var best = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  var seen = false, done = false, outBytes = 0; // outBytes: content of SSE data lines (all of them, parseable or not), for the abort estimate
  var buf = "", skipping = false, jsonChunks = [], jsonLen = 0, jsonOver = false;
  var decoder = new (require("string_decoder").StringDecoder)("utf8");

  function take(u) {
    var n = normalizeUsage(vendor, u);
    if (!n) return;
    seen = true;
    // Usage is cumulative within a response: keep the largest value seen per field.
    Object.keys(best).forEach(function (k) { if (n[k] > best[k]) best[k] = n[k]; });
  }
  function fromEvent(ev) {
    if (!ev || typeof ev !== "object") return;
    if (vendor === "codex" || vendor === "openai") {
      if ((ev.type === "response.completed" || ev.type === "response.incomplete" || ev.type === "response.failed") && ev.response) { take(ev.response.usage); if (seen) done = true; }
    } else if (ev.type === "message_start") take(ev.message && ev.message.usage);
    else if (ev.type === "message_delta") { take(ev.usage); if (ev.usage) done = true; } // message_delta carries the final cumulative usage
  }
  function line(l) {
    if (l.charCodeAt(l.length - 1) === 13) l = l.slice(0, -1);
    if (l.slice(0, 5) !== "data:") return;
    var d = l.slice(5).trim();
    if (!d || d === "[DONE]") return;
    outBytes += Buffer.byteLength(d);
    try { fromEvent(JSON.parse(d)); } catch (_) {}
  }

  return {
    push: function (chunk) {
      if (mode === "json") {
        if (jsonOver) return;
        jsonLen += chunk.length;
        if (jsonLen > MAX_JSON) { jsonOver = true; jsonChunks = []; return; }
        jsonChunks.push(Buffer.from(chunk));
        return;
      }
      buf += decoder.write(Buffer.from(chunk));
      var i;
      while ((i = buf.indexOf("\n")) >= 0) {
        var l = buf.slice(0, i); buf = buf.slice(i + 1);
        if (skipping) { skipping = false; continue; }
        if (l) line(l);
      }
      if (buf.length > MAX_LINE) { outBytes += Buffer.byteLength(buf); buf = ""; skipping = true; }
    },
    result: function () {
      if (mode === "json" && jsonChunks.length && !jsonOver) {
        try {
          var j = JSON.parse(Buffer.concat(jsonChunks).toString("utf8"));
          take(j && (j.usage || (vendor !== "codex" && vendor !== "openai" && typeof j.input_tokens === "number" ? { input_tokens: j.input_tokens } : null)));
        } catch (_) {}
        jsonChunks = [];
      } else if (mode === "sse" && buf) {
        line(buf); buf = "";
      }
      if (mode === "json" && seen) done = true;
      return seen ? Object.assign({}, best) : null;
    },
    // True once the provider's final usage was seen (call after result()).
    complete: function () { return done; },
    // Conservative output-token estimate from the streamed bytes: ceil(bytes of the SSE data-line content / 3). Includes a pending partial line.
    estimatedOutputTokens: function () {
      var extra = mode === "sse" && buf.slice(0, 5) === "data:" ? Buffer.byteLength(buf.slice(5).trim()) : 0;
      return Math.ceil((mode === "json" ? jsonLen : outBytes + extra) / 3);
    },
  };
}

module.exports = {
  createBrokerUsage: createBrokerUsage,
  createUsageParser: createUsageParser,
  normalizeUsage: normalizeUsage,
  mergeLimits: mergeLimits,
  budgetResponse: budgetResponse,
  DEFAULT_LIMITS: DEFAULT_LIMITS,
  RETRY_AFTER_SECONDS: RETRY_AFTER_SECONDS,
};

module.exports = require("./extensions").select("run-scheduler", function () {
var module = { exports: {} };
"use strict";
// Lightweight run scheduler: counters, one FIFO queue, per-user round-robin. No priorities, weights or preemption.
// Limits exist only for bursts; with the defaults a normal day never queues. A run that does not fit waits; nothing is
// ever killed. Only a full queue rejects (QUEUE_FULL_MESSAGE), and a rejection changes no state.
//
// A ticket is one run. submit() either starts it at once (start(ticket) is called synchronously), queues it, or rejects.
// The holder MUST call ticket.release() when the run is over (idempotent); cancel() removes a queued ticket.
var fs = require("fs");

var QUEUE_FULL_MESSAGE = "지금 대기 중인 요청이 너무 많아요. 잠시 후 다시 시도해 주세요.";
var DEFAULTS = {
  total: 12,
  perProvider: { claude: 8, codex: 4, local: 1 }, // local: the CPU runs one 7-14B generation at a time
  perUser: 2,
  queueTotal: 30,
  queuePerUser: 5,
  minMemAvailableMB: 2048,
  // A run of this provider only starts while at least this much memory is available (model weights + KV cache).
  needMemMB: { local: 6000 },
};
var MEM_POLL_MS = 3000;

function posInt(v, d) { return Number.isInteger(v) && v >= 1 ? v : d; }
// Anything malformed falls back to the default for that key.
function resolveConfig(raw) {
  var c = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  var pp = c.perProvider && typeof c.perProvider === "object" && !Array.isArray(c.perProvider) ? c.perProvider : {};
  var perProvider = {};
  Object.keys(DEFAULTS.perProvider).forEach(function (k) { perProvider[k] = posInt(pp[k], DEFAULTS.perProvider[k]); });
  var nm = c.needMemMB && typeof c.needMemMB === "object" && !Array.isArray(c.needMemMB) ? c.needMemMB : {};
  var needMemMB = {};
  Object.keys(DEFAULTS.needMemMB).forEach(function (k) { needMemMB[k] = Number.isFinite(nm[k]) && nm[k] >= 0 ? nm[k] : DEFAULTS.needMemMB[k]; });
  return {
    total: posInt(c.total, DEFAULTS.total), perProvider: perProvider, perUser: posInt(c.perUser, DEFAULTS.perUser),
    queueTotal: posInt(c.queueTotal, DEFAULTS.queueTotal), queuePerUser: posInt(c.queuePerUser, DEFAULTS.queuePerUser),
    minMemAvailableMB: Number.isFinite(c.minMemAvailableMB) && c.minMemAvailableMB >= 0 ? c.minMemAvailableMB : DEFAULTS.minMemAvailableMB,
    needMemMB: needMemMB,
  };
}

function readMemAvailableMB() {
  if (process.platform !== "linux") return null;
  try {
    var m = fs.readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+)\s+kB/m);
    return m ? Math.floor(parseInt(m[1], 10) / 1024) : null;
  } catch (_) { return null; }
}

// opts: { config, readMemAvailableMB, onPosition(ticket, position), memPollMs }
// A ticket's own onPosition(position) (and the observer above) is called when a queued ticket's 1-based position changes, and with 0 when it leaves the queue.
function createRunScheduler(opts) {
  opts = opts || {};
  var cfg = resolveConfig(opts.config);
  var readMem = opts.readMemAvailableMB || readMemAvailableMB;
  var observer = opts.onPosition || function () {};
  function onPosition(t, pos) { if (typeof t.onPosition === "function") t.onPosition(pos); observer(t, pos); }
  var queue = [];            // queued tickets, oldest first
  var running = new Set();
  var keys = new Map();      // key -> ticket (queued or running), for duplicate-send protection
  var served = new Map();    // userId -> sequence number of that user's last start (round-robin memory)
  var seq = 0, pumping = false, timer = null;

  // t given: also the provider's own memory need (a local model must fit); unreadable memory never blocks.
  function memOk(t) {
    var mb = readMem();
    if (mb === null || mb === undefined) return true;
    var need = t && cfg.needMemMB[t.provider] ? Math.max(cfg.minMemAvailableMB, cfg.needMemMB[t.provider]) : cfg.minMemAvailableMB;
    return mb >= need;
  }
  function count(pred) { var n = 0; running.forEach(function (t) { if (pred(t)) n++; }); return n; }
  function fits(t) {
    if (running.size >= cfg.total) return false;
    // exclusive: at most one running run per key (e.g. the one writer of a room workspace); the others wait in line.
    if (t.exclusive && count(function (r) { return r.exclusive === t.exclusive; }) >= 1) return false;
    var cap = cfg.perProvider[t.provider];
    if (cap !== undefined && count(function (r) { return r.provider === t.provider; }) >= cap) return false;
    return count(function (r) { return r.userId === t.userId; }) < cfg.perUser;
  }
  function lastServed(u) { return served.has(u) ? served.get(u) : -1; }
  // Users with queued runs, least recently served first (ties: whoever has waited longest).
  function userOrder() {
    var first = new Map();
    queue.forEach(function (t) { if (!first.has(t.userId)) first.set(t.userId, t.seq); });
    return Array.from(first.keys()).sort(function (a, b) { return lastServed(a) - lastServed(b) || first.get(a) - first.get(b); });
  }
  // Expected start order, ignoring caps: one run per user per round.
  function order() {
    var per = new Map(), out = [];
    queue.forEach(function (t) { if (!per.has(t.userId)) per.set(t.userId, []); per.get(t.userId).push(t); });
    var lists = userOrder().map(function (u) { return per.get(u); });
    while (lists.some(function (l) { return l.length; })) lists.forEach(function (l) { if (l.length) out.push(l.shift()); });
    return out;
  }
  function notify() {
    order().forEach(function (t, i) { if (t.position !== i + 1) { t.position = i + 1; onPosition(t, t.position); } });
  }
  function drop(t) {
    var i = queue.indexOf(t);
    if (i !== -1) queue.splice(i, 1);
    if (t.position) { t.position = 0; onPosition(t, 0); }
  }
  function begin(t) {
    t.state = "running"; running.add(t); served.set(t.userId, ++seq);
    if (t.position) { t.position = 0; onPosition(t, 0); }
    try { t.start(t); } catch (e) { t.release(); throw e; }
  }
  function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length && memOk()) {
        var next = null;
        var users = userOrder();
        for (var i = 0; i < users.length && !next; i++) next = queue.find(function (t) { return t.userId === users[i] && fits(t) && memOk(t); }) || null;
        if (!next) break;
        queue.splice(queue.indexOf(next), 1);
        begin(next);
      }
    } finally { pumping = false; }
    notify();
    // Nothing else frees a slot while memory is low and idle, so poll until it recovers.
    if (queue.length && !timer) {
      timer = setInterval(function () { pump(); if (!queue.length) { clearInterval(timer); timer = null; } }, opts.memPollMs || MEM_POLL_MS);
      if (timer.unref) timer.unref();
    } else if (!queue.length && timer) { clearInterval(timer); timer = null; }
  }

  // job: { userId, provider, key?, exclusive?, start(ticket), onPosition?(n) }. Returns { status: "started"|"queued"|"duplicate"|"rejected", ticket?, message? }.
  function submit(job) {
    if (job.key && keys.has(job.key)) return { status: "duplicate", ticket: keys.get(job.key) };
    var t = { name: job.name, userId: String(job.userId || ""), provider: job.provider, key: job.key || null, exclusive: job.exclusive || null, start: job.start, onPosition: job.onPosition, state: "queued", position: 0, seq: 0,
      cancel: function () { if (t.state !== "queued") return false; t.state = "cancelled"; drop(t); if (t.key) keys.delete(t.key); pump(); return true; },
      release: function () {
        if (t.state === "queued") return t.cancel();
        if (t.state !== "running") return false;
        t.state = "done"; running.delete(t); if (t.key) keys.delete(t.key); pump(); return true;
      } };
    if (queue.length) pump();
    if (memOk(t) && fits(t)) {
      if (t.key) keys.set(t.key, t);
      begin(t);
      return { status: "started", ticket: t };
    }
    if (queue.length >= cfg.queueTotal || queue.filter(function (q) { return q.userId === t.userId; }).length >= cfg.queuePerUser) {
      return { status: "rejected", message: QUEUE_FULL_MESSAGE };
    }
    t.seq = ++seq; queue.push(t); if (t.key) keys.set(t.key, t);
    pump();
    return { status: "queued", ticket: t };
  }

  return {
    submit: submit, pump: pump, config: cfg,
    snapshot: function () { return { running: running.size, queued: queue.length }; },
  };
}

// One scheduler per daemon process, config read once on first use (i.e. at start).
var shared = null;
function getRunScheduler() {
  if (!shared) {
    var raw = null;
    try { raw = require("./config").loadConfig().scheduler; } catch (_) { raw = null; }
    shared = createRunScheduler({ config: raw });
  }
  return shared;
}
function setRunSchedulerForTest(s) { shared = s; }

module.exports = { createRunScheduler: createRunScheduler, getRunScheduler: getRunScheduler, resolveConfig: resolveConfig,
  DEFAULTS: DEFAULTS, setRunSchedulerForTest: setRunSchedulerForTest };

return module.exports;
});

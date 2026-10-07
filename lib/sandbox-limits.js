"use strict";
// G7/D8: memory, process and CPU limits for contained runs via `systemd-run --user --scope`.
// The scope wraps the whole command (systemd-run execs into it), so every descendant lands in one cgroup.
// Fail closed: without a working `systemd-run --user`, the run is refused unless allowUnlimited === true.
var crypto = require("crypto");
var childProcess = require("child_process");

var DEFAULTS = Object.freeze({ memoryMax: "4G", tasksMax: 512, cpuQuota: "200%" });
var PROBE_TTL_MS = 60000;
var UNIT_RE = /^[A-Za-z0-9_-]{1,64}$/;
var probeCache = null;
var warned = false;

function parseMemory(v) { return typeof v === "string" && /^[1-9][0-9]{0,5}[KMG]$/.test(v.trim()) ? v.trim() : null; }
function parseTasks(v) {
  if (typeof v === "string" && /^[1-9][0-9]{0,6}$/.test(v.trim())) v = Number(v.trim());
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= 4194304 ? v : null;
}
function parseCpu(v) { return typeof v === "string" && /^[1-9][0-9]{0,4}%$/.test(v.trim()) ? v.trim() : null; }

// cfg: the whole config object. privateExecution.limits wins over roomExecution.limits; each key falls back independently.
function resolveLimits(cfg) {
  var out = { memoryMax: DEFAULTS.memoryMax, tasksMax: DEFAULTS.tasksMax, cpuQuota: DEFAULTS.cpuQuota };
  cfg = cfg && typeof cfg === "object" ? cfg : {};
  [cfg.roomExecution, cfg.privateExecution].forEach(function (sec) {
    var l = sec && typeof sec === "object" && sec.limits && typeof sec.limits === "object" ? sec.limits : null;
    if (!l) return;
    var m = parseMemory(l.memoryMax); if (m) out.memoryMax = m;
    var t = parseTasks(l.tasksMax); if (t) out.tasksMax = t;
    var c = parseCpu(l.cpuQuota); if (c) out.cpuQuota = c;
  });
  return out;
}
function allowUnlimited(cfg) {
  var p = cfg && cfg.privateExecution;
  return !!p && typeof p === "object" && p.allowUnlimited === true;
}

function probe(opts) {
  opts = opts || {};
  var now = (opts.now || Date.now)();
  if (!opts.fresh && probeCache && now - probeCache.at < PROBE_TTL_MS) return probeCache.ok;
  var ok = false;
  try {
    var r = (opts.spawnSync || childProcess.spawnSync)("systemd-run", ["--user", "--scope", "--quiet", "--collect", "true"], { stdio: "ignore", timeout: 5000 });
    ok = !!r && !r.error && r.status === 0;
  } catch (_) { ok = false; }
  probeCache = { ok: ok, at: now };
  return ok;
}
function resetProbe() { probeCache = null; warned = false; }

function newUnitName(id) {
  var base = typeof id === "string" && UNIT_RE.test(id) ? id : crypto.randomBytes(8).toString("hex");
  return "aigora-run-" + base;
}

function limitArgs(limits, unit) {
  // --description keeps the journal line ("Started <description>") short: otherwise it logs the whole command line.
  return ["--user", "--scope", "--quiet", "--collect", "--unit=" + unit, "--description=aigora run " + unit.slice("aigora-run-".length),
    "-p", "MemoryMax=" + limits.memoryMax, "-p", "MemorySwapMax=0",
    "-p", "TimeoutStopSec=5s", "-p", "TasksMax=" + limits.tasksMax, "-p", "CPUQuota=" + limits.cpuQuota, "--"];
}

// systemd-run expands "${NAME}" from its own environment in the command line and turns "$$" into "$" (verified on systemd 262).
// An argument such as a user prompt would otherwise read the launcher's environment (including a one-shot secret variable).
// Doubling every "$" delivers each argument verbatim.
function escapeArg(a) { return String(a).replace(/\$/g, "$$$$"); }

function stopUnit(unit, opts) {
  if (typeof unit !== "string" || !/^aigora-run-[A-Za-z0-9_-]{1,64}$/.test(unit)) return false;
  try {
    var sp = (opts && opts.spawnSync) || childProcess.spawnSync;
    // SIGKILL the whole cgroup first: a fork bomb can ignore or never finish handling SIGTERM.
    sp("systemctl", ["--user", "kill", "--signal=SIGKILL", unit + ".scope"], { stdio: "ignore", timeout: 5000 });
    var r = sp("systemctl", ["--user", "stop", unit + ".scope"], { stdio: "ignore", timeout: 5000 });
    if (!!r && r.status === 0) return true;
    // The SIGKILL above usually makes the scope vanish (--collect) before `stop` runs: gone is stopped.
    var a = sp("systemctl", ["--user", "is-active", unit + ".scope"], { encoding: "utf8", timeout: 5000 });
    return !!a && !a.error && typeof a.stdout === "string" && a.stdout.trim() !== "active" && a.stdout.trim() !== "activating" && a.stdout.trim() !== "deactivating";
  } catch (_) { return false; }
}

// wrapCommand({ command, args }, { config, id, logger, probe?, spawnSync? })
//   -> { ready: true, command, args, unit, limits, unlimited, cleanup }
//   |  { ready: false, reason: "resource_limits_unavailable" }
function wrapCommand(spec, opts) {
  opts = opts || {};
  var args = Array.isArray(spec && spec.args) ? spec.args : [];
  if (!spec || typeof spec.command !== "string" || !spec.command) return { ready: false, reason: "resource_limits_unavailable" };
  var available = typeof opts.probe === "function" ? opts.probe() === true : probe(opts);
  if (!available) {
    if (!allowUnlimited(opts.config)) return { ready: false, reason: "resource_limits_unavailable" };
    if (!warned) {
      warned = true;
      var log = opts.logger && typeof opts.logger.warn === "function" ? opts.logger : console;
      log.warn("[sandbox-limits] systemd-run --user unavailable; running WITHOUT resource limits (privateExecution.allowUnlimited=true)");
    }
    return { ready: true, command: spec.command, args: args.slice(), unit: null, limits: null, unlimited: true, cleanup: function () {} };
  }
  var limits = resolveLimits(opts.config);
  var unit = newUnitName(opts.id);
  return {
    ready: true, unlimited: false, unit: unit, limits: limits,
    command: "systemd-run",
    args: limitArgs(limits, unit).concat([spec.command].concat(args).map(escapeArg)),
    cleanup: function () { return stopUnit(unit, opts); },
  };
}

module.exports = { DEFAULTS: DEFAULTS, resolveLimits: resolveLimits, allowUnlimited: allowUnlimited, probe: probe, resetProbe: resetProbe, wrapCommand: wrapCommand, stopUnit: stopUnit };

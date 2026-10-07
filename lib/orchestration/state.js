module.exports = require("../extensions").select("orchestration/state", function () {
var module = { exports: {} };
// state.js - durable, project-scoped orchestration state.
//
// One JSON file per project holds every run: its router plan, its steps and
// its observable event log. Writes are atomic (tmp + rename, 0600). The raw
// user prompt is never stored here: a run keeps only a reference to the
// root session's user_message (its timestamp) plus a SHA-256 and length, so
// the prompt lives in exactly one place - the root conversation.
//
// Run lifecycle
//   queued -> running -> completed | failed | cancelled
//   running <-> awaiting_external (a step needs work outside this daemon)
// Step lifecycle
//   pending -> running -> completed | failed | cancelled   (running -> pending only for the one-time executor fallback)
//   pending | running -> awaiting_external -> running | completed | failed | cancelled
//   pending -> skipped (the run ended before the step started)
//
// Per root session: at most one active run (running or awaiting_external)
// and a FIFO queue of at most QUEUE_LIMIT queued runs.

"use strict";

var fs = require("fs");
var { quarantineCorrupt } = require("../quarantine-corrupt");
var path = require("path");
var crypto = require("crypto");

var SCHEMA = "aigora-orchestration-event/v1";
var STATE_VERSION = 1;
var QUEUE_LIMIT = 5;
var MAX_EVENTS_PER_RUN = 200;
var KEEP_FINISHED_RUNS = 200;
var KEEP_ROUTES = 500;

var RUN_TRANSITIONS = {
  queued: ["running", "cancelled", "failed"],
  running: ["awaiting_external", "completed", "failed", "cancelled"],
  awaiting_external: ["running", "completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

var STEP_TRANSITIONS = {
  pending: ["running", "awaiting_external", "skipped", "cancelled", "failed"],
  // running -> pending: a one-time fallback hands the same step to another agent (engine: executor fallback, verify fallback)
  running: ["pending", "awaiting_external", "completed", "failed", "cancelled", "skipped"], // skipped: a best-effort research step that failed
  awaiting_external: ["running", "completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
  skipped: [],
};

var ACTIVE = { running: true, awaiting_external: true };
var TERMINAL = { completed: true, failed: true, cancelled: true };

var EVENT_TYPES = [
  "run_queued", "run_started", "run_resumed", "run_completed", "run_failed", "run_cancelled", "run_rejected",
  "step_started", "step_awaiting_external", "step_completed", "step_failed", "step_cancelled", "step_skipped",
  "artifact_linked",
];

function stateError(code, message, status) {
  var err = new Error(message);
  err.code = code;
  err.status = status || 409;
  return err;
}

function sha256(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

// The automatic-selection record kept on a run's plan (shown as the feed chip): ids, labels and probabilities only, never text.
var DECISION_REASONS = ["decided", "abstain_default", "recheck_next", "recheck_default", "explicit", "files_require_capable_executor", "short_message"];
function cleanDecision(d) {
  if (!d || typeof d !== "object") return null;
  var top = (Array.isArray(d.top) ? d.top : []).slice(0, 3).filter(function (t) {
    return t && typeof t.option === "string" && /^[A-Za-z0-9._:@\/-]{1,90}$/.test(t.option) && typeof t.p === "number" && isFinite(t.p) && t.p >= 0 && t.p <= 1;
  }).map(function (t) { return { option: t.option, p: Math.round(t.p * 1000) / 1000 }; });
  return {
    id: typeof d.id === "string" && /^d_[0-9a-f]{16}$/.test(d.id) ? d.id : null,
    by: typeof d.by === "string" && /^[a-z]{2,12}$/.test(d.by) ? d.by : "clef",
    abstain: d.abstain === true,
    reason: DECISION_REASONS.indexOf(d.reason) >= 0 ? d.reason : null,
    agent: typeof d.agent === "string" && /^[a-z]{1,20}$/.test(d.agent) ? d.agent : null,
    option: typeof d.option === "string" && /^[A-Za-z0-9._:@\/-]{1,90}$/.test(d.option) ? d.option : null,
    top: top,
  };
}

function newId(prefix) {
  return prefix + crypto.randomBytes(9).toString("base64url");
}

function createStateStore(options) {
  options = options || {};
  var file = options.file;
  var now = options.now || Date.now;
  var state = null;

  function load() {
    if (state) return state;
    try { state = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { state = null; quarantineCorrupt(file, e); }
    if (!state || typeof state !== "object" || state.version !== STATE_VERSION) state = { version: STATE_VERSION, runs: [], routes: [], queueSeq: 0 };
    if (!Array.isArray(state.runs)) state.runs = [];
    if (!Array.isArray(state.routes)) state.routes = [];
    if (typeof state.queueSeq !== "number") state.queueSeq = 0;
    return state;
  }

  function persist() {
    var s = load();
    // Bound the file: drop the oldest finished runs beyond the keep limit.
    var finished = s.runs.filter(function (r) { return TERMINAL[r.status]; });
    if (finished.length > KEEP_FINISHED_RUNS) {
      var cut = {};
      finished.sort(function (a, b) { return a.updatedAt - b.updatedAt; })
        .slice(0, finished.length - KEEP_FINISHED_RUNS)
        .forEach(function (r) { cut[r.runId] = true; });
      s.runs = s.runs.filter(function (r) { return !cut[r.runId]; });
    }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    var tmp = file + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  function getRun(runId) {
    return load().runs.find(function (r) { return r.runId === runId; }) || null;
  }

  function getStep(run, stepId) {
    return run && run.steps.find(function (st) { return st.stepId === stepId; }) || null;
  }

  function activeRun(rootSessionId) {
    return load().runs.find(function (r) { return r.rootSessionId === rootSessionId && ACTIVE[r.status] && r.baseline !== true; }) || null;
  }

  function queuedRuns(rootSessionId) {
    return load().runs.filter(function (r) { return r.rootSessionId === rootSessionId && r.status === "queued"; })
      .sort(function (a, b) { return a.queueSeq - b.queueSeq; });
  }

  function appendEvent(run, type, stepId, data) {
    if (EVENT_TYPES.indexOf(type) === -1) throw stateError("bad_event", "Unknown orchestration event " + type, 500);
    run.eventSeq = (run.eventSeq || 0) + 1;
    var ev = {
      schema: SCHEMA,
      eventId: run.runId + ":" + run.eventSeq,
      runId: run.runId,
      stepId: stepId || null,
      seq: run.eventSeq,
      type: type,
      at: now(),
      projectSlug: run.projectSlug,
      rootSessionId: run.rootSessionId,
      roomId: run.roomId,
      data: data || {},
    };
    run.events.push(ev);
    if (run.events.length > MAX_EVENTS_PER_RUN) run.events.splice(0, run.events.length - MAX_EVENTS_PER_RUN);
    return ev;
  }

  function moveRun(run, to) {
    if ((RUN_TRANSITIONS[run.status] || []).indexOf(to) === -1) {
      throw stateError("bad_transition", "Run cannot go from " + run.status + " to " + to);
    }
    run.status = to;
    run.updatedAt = now();
  }

  function moveStep(step, to) {
    if ((STEP_TRANSITIONS[step.status] || []).indexOf(to) === -1) {
      throw stateError("bad_transition", "Step cannot go from " + step.status + " to " + to);
    }
    step.status = to;
    step.updatedAt = now();
  }

  /**
   * createRun({ projectSlug, rootSessionId, rootCreatedAt, rootCliSessionId, roomId, actorId, plan, prompt: { ts, text } })
   * Returns { run, event, started } - `started` is true when the run became
   * the session's active run, false when it was queued. Throws 429 when the
   * queue is full.
   */
  function createRun(input) {
    var s = load();
    // A baseline record (the root agent's own turn, nothing else is run) never waits and never holds the queue.
    var baseline = input.baseline === true;
    var busy = !baseline && !!activeRun(input.rootSessionId);
    if (busy && queuedRuns(input.rootSessionId).length >= QUEUE_LIMIT) {
      throw stateError("queue_full", "This conversation already has " + QUEUE_LIMIT + " orchestration runs waiting", 429);
    }
    var t = now();
    var text = input.prompt && typeof input.prompt.text === "string" ? input.prompt.text : "";
    var run = {
      runId: newId("run-"),
      projectSlug: input.projectSlug,
      rootSessionId: input.rootSessionId,
      // Session local ids are reassigned on restart; these identify the root
      // conversation durably (createdAt is persisted in the session meta).
      rootCreatedAt: input.rootCreatedAt || null,
      rootCliSessionId: input.rootCliSessionId || null,
      roomId: input.roomId,
      actorId: input.actorId,
      status: "queued",
      baseline: baseline,
      queueSeq: ++s.queueSeq,
      createdAt: t,
      updatedAt: t,
      prompt: { ts: input.prompt ? input.prompt.ts : null, sha256: sha256(text), chars: text.length },
      plan: {
        version: input.plan.version,
        rootAgent: input.plan.rootAgent,
        signals: input.plan.signals,
        mentions: input.plan.mentions,
        rules: input.plan.rules,
        dropped: (input.plan.dropped || []).map(function (d) { return { agent: d.agent, role: d.role }; }),
        decision: cleanDecision(input.plan.decision),
        afterTurn: input.plan.afterTurn === true, // step 1 (work) was the room's real turn; only the verify step is run here
      },
      routeId: typeof input.plan.routeId === "string" && /^rt-[A-Za-z0-9_-]{6,24}$/.test(input.plan.routeId) ? input.plan.routeId : null,
      steps: input.plan.steps.map(function (st) {
        return {
          stepId: newId("stp-"), index: st.index, agent: st.agent, role: st.role, reason: st.reason,
          model: typeof st.model === "string" && /^[A-Za-z0-9._:@\/-]{1,90}$/.test(st.model) ? st.model : null,
          // A verify step rewritten to an endpoint model remembers the session agent it replaced (last-resort verifier).
          fallbackAgent: st.fallbackAgent === "claude" || st.fallbackAgent === "codex" ? st.fallbackAgent : null,
          status: "pending", createdAt: t, updatedAt: t,
          hiddenSessionId: null, artifactId: null, partial: false,
          output: null, error: null, external: null,
        };
      }),
      resumeKeys: [],
      eventSeq: 0,
      events: [],
      error: null,
    };
    s.runs.push(run);
    var planData = {
      router: run.plan,
      steps: run.steps.map(function (st) { return { stepId: st.stepId, index: st.index, agent: st.agent, role: st.role }; }),
      position: busy ? queuedRuns(input.rootSessionId).length : 0,
    };
    var ev = appendEvent(run, "run_queued", null, planData);
    persist();
    return { run: run, event: ev, started: false, busy: busy };
  }

  // Promote a queued run to running. Only allowed when the session has no
  // other active run and this run is the head of the FIFO queue.
  function startRun(runId) {
    var run = getRun(runId);
    if (!run) throw stateError("not_found", "Run not found", 404);
    var active = activeRun(run.rootSessionId);
    if (active && active.runId !== runId) throw stateError("busy", "Another run is active in this conversation");
    var head = queuedRuns(run.rootSessionId)[0];
    if (run.status === "queued" && head && head.runId !== runId) throw stateError("not_head", "Run is not at the head of the queue");
    moveRun(run, "running");
    var ev = appendEvent(run, "run_started", null, {});
    persist();
    return ev;
  }

  function nextQueued(rootSessionId) {
    if (activeRun(rootSessionId)) return null;
    return queuedRuns(rootSessionId)[0] || null;
  }

  function updateStep(runId, stepId, to, patch, eventType, eventData) {
    var run = getRun(runId);
    var st = getStep(run, stepId);
    if (!st) throw stateError("not_found", "Step not found", 404);
    if (to && to !== st.status) moveStep(st, to);
    if (patch) Object.keys(patch).forEach(function (k) { st[k] = patch[k]; });
    run.updatedAt = now();
    var ev = eventType ? appendEvent(run, eventType, stepId, eventData) : null;
    persist();
    return ev;
  }

  function updateRun(runId, to, patch, eventType, eventData) {
    var run = getRun(runId);
    if (!run) throw stateError("not_found", "Run not found", 404);
    if (to && to !== run.status) moveRun(run, to);
    if (patch) Object.keys(patch).forEach(function (k) { run[k] = patch[k]; });
    var ev = eventType ? appendEvent(run, eventType, null, eventData) : null;
    // A finished run cannot leave steps behind in a non-final state.
    if (TERMINAL[run.status]) {
      run.steps.forEach(function (st) {
        if (st.status === "pending") { st.status = "skipped"; st.updatedAt = now(); }
        else if (st.status === "running" || st.status === "awaiting_external") { st.status = "cancelled"; st.updatedAt = now(); }
      });
    }
    persist();
    return ev;
  }

  // Record that a (step, artifact) pair already resumed its run. Returns
  // false when it had been recorded before, which makes resume idempotent
  // across duplicate imports and restarts.
  function claimResume(runId, key) {
    if (!runId || !key) return false;
    var run = getRun(runId);
    if (!run) return false;
    if (run.resumeKeys.indexOf(key) !== -1) return false;
    run.resumeKeys.push(key);
    persist();
    return true;
  }

  // After a daemon restart nothing that was executing in-process survived.
  // Steps that were running are failed (never silently re-executed); runs
  // waiting on external work keep waiting. Returns the events to project.
  function recover() {
    var out = [];
    load().runs.forEach(function (run) {
      if (run.status !== "running") return;
      var st = run.steps.find(function (x) { return x.status === "running"; });
      if (st) {
        moveStep(st, "failed");
        st.error = { code: "interrupted", message: "The daemon restarted while this step was running." };
        out.push(appendEvent(run, "step_failed", st.stepId, { agent: st.agent, error: st.error }));
      }
      moveRun(run, "failed");
      run.error = { code: "interrupted", message: "The daemon restarted while this run was active." };
      run.steps.forEach(function (x) { if (x.status === "pending") { x.status = "skipped"; x.updatedAt = now(); } });
      out.push(appendEvent(run, "run_failed", null, { error: run.error }));
    });
    if (out.length) persist();
    return out;
  }

  // Point a run at its root conversation's current local id (after a
  // restart re-numbered sessions).
  function remapRoot(runId, localId, cliSessionId) {
    var run = getRun(runId);
    if (!run) return;
    run.rootSessionId = localId;
    if (cliSessionId && !run.rootCliSessionId) run.rootCliSessionId = cliSessionId;
    persist();
  }

  function allRuns() {
    return load().runs.slice();
  }

  // Decided-route ledger: who asked, which conversation, the (text-free) decision, and the one feedback value they gave.
  // Bounded; the oldest entries go first. A purge of the room drops its entries too.
  function addRoute(input) {
    var s = load();
    var rec = {
      routeId: newId("rt-"), rootSessionId: input.rootSessionId, rootCreatedAt: input.rootCreatedAt || null,
      rootCliSessionId: input.rootCliSessionId || null, rootUid: typeof input.rootUid === "string" && input.rootUid ? input.rootUid : null, roomId: input.roomId, actorId: input.actorId,
      decision: cleanDecision(input.decision), createdAt: now(), feedback: null,
    };
    s.routes.push(rec);
    if (s.routes.length > KEEP_ROUTES) s.routes = s.routes.slice(s.routes.length - KEEP_ROUTES);
    persist();
    return rec;
  }
  function getRoute(routeId) {
    if (typeof routeId !== "string") return null;
    return load().routes.find(function (r) { return r.routeId === routeId; }) || null;
  }
  // First value wins: returns true only when this call stored it (the caller then sends the outcome, once).
  function setRouteFeedback(routeId, value) {
    var rec = getRoute(routeId);
    if (!rec || (value !== 1 && value !== -1) || rec.feedback !== null) return false;
    rec.feedback = value;
    persist();
    return true;
  }

  return {
    load: load,
    getRun: getRun,
    getStep: getStep,
    activeRun: activeRun,
    queuedRuns: queuedRuns,
    nextQueued: nextQueued,
    createRun: createRun,
    startRun: startRun,
    updateStep: updateStep,
    updateRun: updateRun,
    claimResume: claimResume,
    recover: recover,
    remapRoot: remapRoot,
    allRuns: allRuns,
    addRoute: addRoute,
    getRoute: getRoute,
    setRouteFeedback: setRouteFeedback,
    // Drops every run of a room (room purge); returns how many were removed.
    purgeRoom: function (roomId) {
      var s = load(), before = s.runs.length;
      s.runs = s.runs.filter(function (r) { return r.roomId !== roomId; });
      var routesBefore = s.routes.length;
      s.routes = s.routes.filter(function (r) { return r.roomId !== roomId; });
      if (s.runs.length !== before || s.routes.length !== routesBefore) persist();
      return before - s.runs.length;
    },
    appendEvent: function (runId, type, stepId, data) {
      var run = getRun(runId);
      var ev = appendEvent(run, type, stepId, data);
      persist();
      return ev;
    },
  };
}

module.exports = {
  SCHEMA: SCHEMA,
  QUEUE_LIMIT: QUEUE_LIMIT,
  EVENT_TYPES: EVENT_TYPES,
  RUN_TRANSITIONS: RUN_TRANSITIONS,
  STEP_TRANSITIONS: STEP_TRANSITIONS,
  createStateStore: createStateStore,
  sha256: sha256,
};

return module.exports;
});

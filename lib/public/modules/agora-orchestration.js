// agora-orchestration.js - pure model + HTML renderer for Aigora
// orchestration runs shown inline in the room conversation.
//
// The server records one `orchestration_event` history entry per event:
//   { type: "orchestration_event", event: { eventId, runId, stepId, seq, type,
//     at, data }, run: { runId, status, roomId, steps: [...], router, error } }
// A run is one card. Events are folded into per-run state; the run snapshot
// only moves forward by `seq`, so an older page of history prepended later
// can never roll the card back. Agent answers arrive only in step_completed
// events and are kept per step.
//
// Everything here is fail-closed (unknown agent/status -> dropped) and every
// string goes through escapeHtml. No DOM, store or network access.

import { escapeHtml } from "./escape-html.js";
import { t } from "../aigora/i18n.js";

var e = escapeHtml;

// Display tables: each value is a thunk so the text follows the current language; `table[key]` is also the
// "is this key known" check (fail-closed), so keep unknown keys out.
export var AGENT_LABEL = {
  claude: function () { return "Claude"; }, codex: function () { return "Codex"; },

   // retired worker path: only so older run records still render
  local: function () { return t("agoraOrchestration.agentLocal"); },
};
export var ROLE_LABEL = {
  research: function () { return t("agoraOrchestration.roleResearch"); },
  browser: function () { return t("agoraOrchestration.roleBrowser"); },
  work: function () { return t("agoraOrchestration.roleWork"); },
  verify: function () { return t("agoraOrchestration.roleVerify"); },
  mention: function () { return t("agoraOrchestration.roleMention"); },
  consume: function () { return t("agoraOrchestration.roleConsume"); },
};
export var RUN_STATUS = {
  queued: function () { return t("agoraOrchestration.runQueued"); },
  running: function () { return t("agoraOrchestration.runRunning"); },
  awaiting_external: function () { return t("agoraOrchestration.runAwaitingExternal"); },
  completed: function () { return t("agoraOrchestration.completed"); },
  failed: function () { return t("agoraOrchestration.failed"); },
  cancelled: function () { return t("agoraOrchestration.cancelled"); },
};
export var STEP_STATUS = {
  pending: function () { return t("agoraOrchestration.stepPending"); },
  running: function () { return t("agoraOrchestration.stepRunning"); },
  awaiting_external: function () { return t("agoraOrchestration.stepAwaitingExternal"); },
  completed: function () { return t("agoraOrchestration.completed"); },
  failed: function () { return t("agoraOrchestration.failed"); },
  cancelled: function () { return t("agoraOrchestration.cancelled"); },
  skipped: function () { return t("agoraOrchestration.stepSkipped"); },
};

var ERROR_TEXT = {
  access_revoked: function () { return t("agoraOrchestration.errAccessRevoked"); },
  prompt_unavailable: function () { return t("agoraOrchestration.errPromptUnavailable"); },
  timeout: function () { return t("agoraOrchestration.errTimeout"); },
  interrupted: function () { return t("agoraOrchestration.errInterrupted"); },
  root_unavailable: function () { return t("agoraOrchestration.errRootUnavailable"); },
  cancelled: function () { return t("agoraOrchestration.errCancelled"); },


  empty_response: function () { return t("agoraOrchestration.errEmptyResponse"); },





  start_failed: function () { return t("agoraOrchestration.errStartFailed"); },
};

function label(table, key) {
  var fn = table[key];
  return typeof fn === "function" ? fn() : key;
}

var ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
var MAX_TEXT = 16000;

function asId(v) {
  return typeof v === "string" && ID_RE.test(v) ? v : null;
}

function asText(v, max) {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function normalizeError(err) {
  if (!err || typeof err !== "object") return null;
  var code = typeof err.code === "string" ? err.code.slice(0, 64) : "error";
  return { code: code, message: asText(err.message, 500) };
}

function normalizeExternal(x) {
  if (!x || typeof x !== "object") return null;

  return null;
}

/** Normalize a server run snapshot. Returns null when it cannot be grounded. */
export function normalizeRun(raw) {
  if (!raw || typeof raw !== "object" || !asId(raw.runId) || !RUN_STATUS[raw.status]) return null;
  var steps = (Array.isArray(raw.steps) ? raw.steps : []).filter(function (st) {
    return st && asId(st.stepId) && AGENT_LABEL[st.agent] && STEP_STATUS[st.status];
  }).slice(0, 3).map(function (st, i) {
    return {
      stepId: st.stepId,
      index: typeof st.index === "number" ? st.index : i,
      agent: st.agent,
      role: ROLE_LABEL[st.role] ? st.role : "mention",
      status: st.status,
      partial: st.partial === true,

      error: normalizeError(st.error),
      external: normalizeExternal(st.external),
      skipNote: asText(st.skipNote, 200),
    };
  });
  var router = raw.router && typeof raw.router === "object" ? raw.router : {};
  return {
    runId: raw.runId,
    status: raw.status,
    roomId: raw.roomId == null ? null : String(raw.roomId),
    rootSessionId: raw.rootSessionId == null ? null : String(raw.rootSessionId),
    steps: steps,
    error: normalizeError(raw.error),
    baseline: raw.baseline === true,
    router: {
      version: typeof router.version === "string" ? router.version.slice(0, 40) : "",
      rules: Array.isArray(router.rules) ? router.rules.filter(function (r) { return typeof r === "string"; }).slice(0, 12) : [],
    },
  };
}

/**
 * Fold one orchestration_event message into the per-run state map
 * (`runs` = { runId: { run, seq, outputs: { stepId: text } } }). Returns the
 * new state for that run, or null when the message is not usable.
 */
export function applyEvent(runs, msg) {
  if (!msg || typeof msg !== "object") return null;
  var run = normalizeRun(msg.run);
  var ev = msg.event && typeof msg.event === "object" ? msg.event : null;
  if (!run || !ev || ev.runId !== run.runId) return null;
  var prev = runs[run.runId] || { run: null, seq: -1, outputs: {}, position: 0, times: {} };
  var seq = typeof ev.seq === "number" ? ev.seq : 0;
  var next = { run: prev.run, seq: prev.seq, outputs: Object.assign({}, prev.outputs), position: prev.position, times: Object.assign({}, prev.times) };
  if (seq >= prev.seq) {
    next.run = run;
    next.seq = seq;
  }
  var data = ev.data && typeof ev.data === "object" ? ev.data : {};
  if (ev.type === "step_completed" && asId(ev.stepId) && typeof data.output === "string") {
    next.outputs[ev.stepId] = data.output.slice(0, MAX_TEXT);
  }
  if (asId(ev.stepId) && typeof ev.at === "number") {
    var tm = Object.assign({}, next.times[ev.stepId]);
    if (ev.type === "step_started") tm.start = ev.at;
    else if (ev.type === "step_completed" || ev.type === "step_failed" || ev.type === "step_cancelled") tm.end = ev.at;
    next.times[ev.stepId] = tm;
  }
  if (ev.type === "run_queued" && typeof data.position === "number") next.position = data.position;
  runs[run.runId] = next;
  return next;
}

function badge(status, table) {
  var cls = status === "completed" ? "is-pass" : (status === "failed" ? "is-fail" : "is-not_run");
  return '<span class="ag-status ' + cls + '">' + e(label(table, status)) + "</span>";
}

function errorText(err) {
  return ERROR_TEXT[err.code] ? label(ERROR_TEXT, err.code) : (err.message || t("agoraOrchestration.errGeneric"));
}



export var CLAMP_LINES = 12;

function firstLine(text) {
  var lines = String(text || "").split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i].replace(/^[#>*\-\s`]+/, "").trim();
    if (l) return l.slice(0, 200);
  }
  return "";
}

function needsClamp(text) {
  return text.split(/\r?\n/).length > CLAMP_LINES || text.length > CLAMP_LINES * 60;
}

function elapsed(tm) {
  if (!tm || typeof tm.start !== "number" || typeof tm.end !== "number" || tm.end < tm.start) return "";
  var sec = Math.round((tm.end - tm.start) / 1000);
  return sec >= 60 ? t("agoraOrchestration.elapsedMin", { m: Math.floor(sec / 60), s: sec % 60 }) : t("agoraOrchestration.elapsedSec", { s: sec });
}

// Role colour class: work -> accent, verify -> its own tint, a failed step -> danger; the rest stay neutral.
function stepTone(st) {
  return st.status === "failed" ? "is-tone-failed" : (st.role === "work" ? "is-tone-work" : (st.role === "verify" ? "is-tone-verify" : "is-tone-other"));
}

/** Is this step open? An explicit choice wins; otherwise only a step that needs the member (external action) starts open. */
export function stepIsOpen(st, view) {
  var v = view && view.steps ? view.steps[st.stepId] : undefined;
  return typeof v === "boolean" ? v : st.status === "awaiting_external";
}

/** Is this run open? An explicit choice wins; otherwise only the most recent run starts open. */
export function runIsOpen(runId, view) {
  var v = view && view.runs ? view.runs[runId] : undefined;
  return typeof v === "boolean" ? v : !(view && view.latestRunId) || view.latestRunId === runId;
}

function renderStep(run, st, output, opts, state) {
  var view = opts.view || {};
  var open = stepIsOpen(st, view);
  var text = typeof output === "string" ? output : "";
  var tm = elapsed(state.times && state.times[st.stepId]);
  var summary = text ? firstLine(text) : (st.error && st.status === "failed" ? errorText(st.error) : (st.status === "skipped" ? st.skipNote : ""));
  var body = "";
  if (open) {
    if (st.status === "awaiting_external" && st.external) {

    }
    if (text) {
      var clamp = needsClamp(text);
      var all = !!(view.more && view.more[st.stepId]);
      body += '<div class="ag-orch-output' + (clamp && !all ? " is-clamped" : "") + '">' + e(text) + "</div>" +
        (clamp ? '<button type="button" class="ag-btn ag-orch-more" data-orch-more="' + e(st.stepId) + '" aria-expanded="' + (all ? "true" : "false") + '">' + e(all ? t("agoraOrchestration.showLess") : t("agoraOrchestration.showMore")) + "</button>" : "");
    }
    if (st.skipNote && st.status === "skipped") body += '<p class="ag-note">' + e(st.skipNote) + "</p>";
    if (st.error && st.status === "failed") body += '<p class="ag-alert" role="alert">' + e(errorText(st.error)) + "</p>";
  }
  var bodyId = "ag-orch-body-" + e(st.stepId);
  return '<li class="ag-orch-step ' + stepTone(st) + " is-" + e(st.status) + (open ? " is-open" : "") + '" data-orch-step="' + e(st.stepId) + '">' +
    '<button type="button" class="ag-orch-step-toggle" data-orch-toggle-step="' + e(st.stepId) + '" aria-expanded="' + (open ? "true" : "false") + '" aria-controls="' + bodyId + '">' +
    '<span class="ag-orch-step-head"><span class="ag-orch-agent">' + e(label(AGENT_LABEL, st.agent)) + "</span>" +
    '<span class="ag-orch-role">' + e(label(ROLE_LABEL, st.role)) + "</span>" + badge(st.status, STEP_STATUS) +
    (tm ? '<span class="ag-orch-elapsed">' + e(tm) + "</span>" : "") + "</span>" +
    (summary && !open ? '<span class="ag-orch-summary">' + e(summary) + "</span>" : "") + "</button>" +
    (open ? '<div class="ag-orch-step-body" id="' + bodyId + '">' + body + "</div>" : "") + "</li>";
}

/**
 * One run card. `opts` = { canLaunch,
 * notice, view: { latestRunId, runs: { runId: bool }, steps: { stepId: bool }, more: { stepId: bool } } }.
 */
export function renderRunCard(state, opts) {
  opts = opts || {};
  if (!state || !state.run) return "";
  var run = state.run;
  var active = run.status === "queued" || run.status === "running" || run.status === "awaiting_external";
  var explicit = opts.view && opts.view.runs ? opts.view.runs[run.runId] : undefined;
  var open = typeof explicit === "boolean" ? explicit : runIsOpen(run.runId, opts.view) || run.status === "awaiting_external";
  var steps = open ? run.steps.map(function (st) { return renderStep(run, st, state.outputs[st.stepId], opts, state); }).join("") : "";
  var queued = run.status === "queued" && state.position > 0
    ? '<p class="ag-note">' + e(t("agoraOrchestration.queuePosition", { count: state.position })) + "</p>" : "";
  var failure = run.error && run.status !== "completed" && !run.steps.some(function (st) { return st.status === "failed"; })
    ? '<p class="ag-alert" role="alert">' + e(errorText(run.error)) + "</p>" : "";
  var rules = run.router.rules.length ? " · " + run.router.rules.map(e).join(", ") : "";
  return '<section class="ag-orch-card is-' + e(run.status) + (open ? " is-open" : " is-collapsed") + '" data-orch-run="' + e(run.runId) + '" aria-label="' + e(t("agoraOrchestration.runAria")) + '">' +
    '<button type="button" class="ag-orch-head" data-orch-toggle-run="' + e(run.runId) + '" aria-expanded="' + (open ? "true" : "false") + '">' +
    '<span class="ag-orch-title">' + e(t("agoraOrchestration.runTitle", { count: run.steps.length })) + "</span>" + badge(run.status, RUN_STATUS) + "</button>" +
    (open ? '<p class="ag-orch-router">' + e(run.router.version || "router") + rules + "</p>" +
    queued + '<ol class="ag-orch-steps">' + steps + "</ol>" + failure : "") +
    (opts.notice ? '<p class="ag-alert" role="alert">' + e(opts.notice) + "</p>" : "") +
    (active && opts.canLaunch && !run.baseline ? '<div class="ag-form-actions"><button type="button" class="ag-btn" data-orch-cancel="' + e(run.runId) + '">' + e(t("agoraOrchestration.cancelRun")) + '</button></div>' : "") +
    "</section>";
}

// narration.js - deterministic Korean learning-timeline entries for a run.
//
// Pure functions: an orchestration event (plus its run) in, `session_narration`
// entries out (client contract: lib/public/modules/agora-model.js). Nothing
// here reads a model's reasoning. Every entry is grounded in one of:
//   - a canonical orchestration event (plan, step start/finish, artifact link,
//     error, external action)  -> task_state / agent_message
//   - a step's router rationale (a rule id the router intentionally emits)
//   - provider trace text, and only text the upstream history entry explicitly
//     marks `disclosure: "provider_visible"` -> provider_trace. Today the only
//     producer is Claude's SDK progress summary (task_progress.summary).
// trace channel (its JSON output is {conversation_id, status, response, error,
// num_turns}), so it is unsupported and yields no provider_trace.
//
// Commands, paths, URLs, hashes, error codes and numbers are copied verbatim
// (wrapped in backticks so the client renders them as code spans). Entry ids
// derive from the event id, so replaying recorded history merges in place and
// never duplicates an entry.

"use strict";

var router = require("./router");

var ROLE_LABEL = {
  research: "외부 근거 조사", browser: "브라우저 작업", work: "작업", verify: "독립 검증",
  mention: "호출된 에이전트", consume: "리서치 반영",
};

// Router rule ids -> why the router added the step. Unknown ids fall back to
// the id itself, verbatim.
var REASON_LABEL = {
  "signal.evidence": "외부 근거가 필요한 요청이라 조사 단계를 넣었습니다",
  "signal.browser": "브라우저 작업이 필요한 요청이라 브라우저 단계를 넣었습니다",
  "signal.code": "코드 작업 요청이라 작업 단계를 넣었습니다",
  "signal.verification": "검증 요청이라 다른 에이전트의 독립 검증 단계를 넣었습니다",
  "research.consumer": "조사 결과를 받아 반영하는 단계입니다",
};

var MAX_ANSWER_CHARS = 1200;
var MAX_TRACE_CHARS = 1600;

// History entries a trace may be built from, each with the field holding its
// text. thinking_* entries are deliberately absent: neither Claude's SDK nor
// Codex marks thinking text as user-visible, so a `disclosure` field on one is
// not trusted either.
//   task_progress  Claude SDK progress summary (adapters/claude.js marks it)
//   provider_trace reserved for an adapter that emits visible trace text
var TRACE_FIELDS = { task_progress: "summary", provider_trace: "text" };

// `labelOf(agent, model)` (optional, from the engine) names an extra endpoint by its configured label instead of the fixed
// "로컬 (Ollama)"; without it, or when it throws, the fixed label is used.
function agentLabel(agent, model, labelOf) {
  if (typeof labelOf === "function") {
    try { var l = labelOf(agent, model); if (typeof l === "string" && l) return l; } catch (_) { /* fixed label below */ }
  }
  return router.AGENTS[agent] ? router.AGENTS[agent].label : String(agent);
}

function roleLabel(role) {
  return ROLE_LABEL[role] || String(role);
}

// Verbatim values render as code spans; a value that itself contains a
// backtick cannot be wrapped without altering it, so it stays plain.
function code(value) {
  if (value == null || value === "") return "";
  var s = String(value);
  return s.indexOf("`") === -1 ? "`" + s + "`" : s;
}

function clip(text, max) {
  text = String(text || "").trim();
  return text.length > max ? text.slice(0, max) + "… (" + (text.length - max) + "자 더 있음)" : text;
}

function findStep(run, ev) {
  if (!run || !ev || !ev.stepId || !Array.isArray(run.steps)) return null;
  return run.steps.find(function (st) { return st && st.stepId === ev.stepId; }) || null;
}

function errorText(error) {
  if (!error) return "";
  if (typeof error === "string") return error;
  var parts = [];
  if (error.code) parts.push(code(error.code));
  if (error.message) parts.push(String(error.message));
  return parts.join(" ");
}

function entry(ev, suffix, stage, source, text, extra) {
  var prefix = ev && ev.eventId ? ev.eventId : "ev";
  var out = { id: prefix + ":" + suffix, stage: stage, source: source, text: String(text || ""), ts: ev && typeof ev.at === "number" ? ev.at : Date.now() };
  if (extra && typeof extra === "object") {
    Object.keys(extra).forEach(function (k) {
      if (extra[k] != null) out[k] = extra[k];
    });
  }
  return out;
}

function stepPosition(run, st, ev) {
  var total = run && Array.isArray(run.steps) ? run.steps.length : 0;
  var index = st && typeof st.index === "number" ? st.index : (ev && ev.data && typeof ev.data.index === "number" ? ev.data.index : null);
  if (index == null) return "";
  return total > 0 ? " (" + (index + 1) + "/" + total + ")" : " (" + (index + 1) + ")";
}

function planText(run, ev, labelOf) {
  var dataSteps = ev && ev.data && Array.isArray(ev.data.steps) ? ev.data.steps : null;
  var runSteps = run && Array.isArray(run.steps) ? run.steps : [];
  var steps = dataSteps || runSteps;
  var list = steps.map(function (s, i) {
    var idx = typeof s.index === "number" ? s.index : i;
    var full = runSteps.filter(function (x) { return x && x.index === idx; })[0];
    return (idx + 1) + ") " + agentLabel(s.agent, s.model || (full && full.model), labelOf) + " · " + roleLabel(s.role);
  }).join(", ");
  var rules = run && run.plan && Array.isArray(run.plan.rules) && run.plan.rules.length
    ? " 적용된 라우팅 규칙: " + run.plan.rules.map(code).filter(Boolean).join(", ") + "." : "";
  return "요청을 " + steps.length + "단계 실행 계획으로 접수했습니다" + (list ? ": " + list + "." : ".") + rules;
}

function hasCompletedVerify(run) {
  return run && Array.isArray(run.steps) && run.steps.some(function (st) {
    return st && st.role === "verify" && st.status === "completed";
  });
}

/**
 * Narration entries for one orchestration event. Returns [] for events with
 * nothing observable to add.
 */
function narrateEvent(run, ev, opts) {
  if (!run || !ev) return [];
  var labelOf = opts && opts.labelOf;
  var data = ev.data || {};
  var st = findStep(run, ev);
  var agent = data.agent || (st && st.agent);
  var role = data.role || (st && st.role);
  var who = agent ? agentLabel(agent, st && st.model, labelOf) : "";
  var pos = stepPosition(run, st, ev);
  var out = [];

  switch (ev.type) {
    case "run_queued":
      out.push(entry(ev, "plan", "understand", "task_state", planText(run, ev, labelOf)));
      break;

    case "run_started":
      out.push(entry(ev, "start", "next_action", "task_state", "실행을 시작합니다."));
      break;

    case "run_resumed":
      out.push(entry(ev, "resume", "next_action", "task_state",
        "외부 결과가 확인되어 실행을 이어갑니다." + (data.artifactId ? " 산출물 " + code(data.artifactId) + "." : "")));
      break;

    case "step_started":
      out.push(entry(ev, "step", "next_action", "task_state",
        who + "가 " + roleLabel(role) + " 단계" + pos + "를 실행합니다." + (data.workspace ? " 작업 공간: " + code(data.workspace) + "." : "")));
      if (st && st.reason) {
        out.push(entry(ev, "why", "next_action", "rationale", "이유: " + (REASON_LABEL[st.reason] || (/^pick\./.test(st.reason) ? code("선택." + st.reason.slice(5)) : code(st.reason))) + ". (규칙 " + code(st.reason) + ")"));
      }
      break;

    case "step_awaiting_external": {
      var ext = data.external || {};
      var text = who + " 단계를 실행하지 못하고 기다립니다." + (ext.reason ? " 사유: " + code(ext.reason) + "." : "");
      out.push(entry(ev, "wait", "next_action", "task_state", text));
      break;
    }

    case "artifact_linked": {
      var artId = data.artifactId || (st && st.artifactId);
      var artStatus = data.workerStatus || (st && st.workerStatus);
      var artText = "검증된 산출물" + (artId ? " " + code(artId) + "을" : "을") + " 연결했습니다.";
      if (artStatus) artText += " 작업자 상태 " + code(artStatus) + (data.partial ? ", 부분 결과입니다." : ".");
      else if (data.partial) artText += " 부분 결과입니다.";
      out.push(entry(ev, "artifact", "result", "task_state", artText,
        data.sha256 ? { evidence: "sha256 " + data.sha256 } : null));
      break;
    }

    case "step_completed": {
      var prefix = who ? who + "의 " + roleLabel(role) + " 단계" + pos : roleLabel(role) + " 단계" + pos;
      if (data.output) {
        out.push(entry(ev, "done", "result", "agent_message", prefix + " 답변:\n" + clip(data.output, MAX_ANSWER_CHARS)));
      } else {
        out.push(entry(ev, "done", "result", "task_state", prefix + "가 끝났습니다."));
      }
      if (role === "verify") {
        // The answer is free text: it is shown, not scored. Pass/fail is only
        // claimed when a test or tool result says so.
        out.push(entry(ev, "verify", "verify", "agent_message",
          "독립 검증 답변을 받았지만 통과·실패를 자동으로 판정하지 않았습니다. 위 답변의 근거를 직접 확인하세요.",
          { status: "not_run", evidence: (who || "독립") + " 검증 단계 답변" }));
      }
      break;
    }

    case "step_failed":
      out.push(entry(ev, "fail", "result", "task_state", who + "의 " + roleLabel(role) + " 단계" + pos + "가 실패했습니다. " + errorText(data.error)));
      if (role === "verify") {
        out.push(entry(ev, "verify", "verify", "task_state",
          "검증 단계가 끝까지 실행되지 않아 검증 결과가 없습니다.",
          { status: "not_run", evidence: data.error && data.error.code ? "오류 " + data.error.code : "검증 단계 실패" }));
      }
      break;

    case "run_completed": {
      var steps = Array.isArray(run.steps) ? run.steps : [];
      var done = steps.filter(function (s) { return s && s.status === "completed"; }).length;
      var total = steps.length;
      out.push(entry(ev, "end", "result", "task_state", "실행이 끝났습니다. " + done + "/" + total + " 단계가 완료되었습니다."));
      if (!hasCompletedVerify(run)) {
        out.push(entry(ev, "verify", "verify", "task_state", "이 실행에는 독립 검증 단계가 없어 검증하지 않았습니다.",
          { status: "not_run", evidence: "검증 단계 없음" }));
      }
      break;
    }

    case "run_failed":
      out.push(entry(ev, "end", "result", "task_state", "실행이 실패했습니다. " + errorText(data.error)));
      break;

    case "run_cancelled":
      out.push(entry(ev, "end", "result", "task_state", "실행이 취소되었습니다. " + errorText(data.error)));
      break;

    default:
      break;
  }
  return out;
}

/**
 * Provider trace entry for one worker step. `history` is the worker's history
 * slice for that step. Only task_progress / provider_trace entries whose
 * `disclosure` is exactly "provider_visible" are used; thinking entries are
 * ignored, so a trace is never inferred or reconstructed. Returns [] when
 * nothing qualifies.
 */
function providerTraceEntries(run, step, history, at) {
  if (!run || !run.runId || !step || !step.stepId || !Array.isArray(history)) return [];
  if (Array.isArray(run.steps) && !run.steps.some(function (s) { return s && s.stepId === step.stepId; })) return [];
  var text = "";
  history.forEach(function (h) {
    if (!h || h.disclosure !== "provider_visible") return;
    var field = TRACE_FIELDS[h.type];
    if (!field || typeof h[field] !== "string") return;
    // Progress summaries are discrete lines; trace text streams in pieces.
    if (h.type === "task_progress") {
      var line = h[field].trim();
      if (line) text += (text ? "\n" : "") + line;
    } else {
      text += h[field];
    }
  });
  text = text.trim();
  if (!text) return [];
  return [{
    id: run.runId + ":" + step.stepId + ":trace",
    stage: "next_action",
    source: "provider_trace",
    disclosure: "provider_visible",
    text: clip(text, MAX_TRACE_CHARS),
    ts: typeof at === "number" && isFinite(at) ? at : Date.now(),
  }];
}

module.exports = {
  ROLE_LABEL: ROLE_LABEL,
  narrateEvent: narrateEvent,
  providerTraceEntries: providerTraceEntries,
};

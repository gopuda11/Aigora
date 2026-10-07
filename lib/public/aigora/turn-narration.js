// turn-narration.js - Pure: turns the observable events of a room turn (the same WS frames the thread folds)
// into `session_narration` entries for the 작업 설명 panel and the 5-step bar. Server narration
// (lib/orchestration/narration.js) only covers orchestration runs; a plain room-main or contained turn emitted
// nothing, so the panel stayed empty. Observable events only: no thinking_* frames, no inferred reasoning,
// and the verification stage never claims a pass (no test output is observed here, so it says "not run").
//
// Entry ids come from stable frame ids (message _mid, tool id, request id), so a replay or reconnect merges in
// place and never duplicates an entry.

import { t } from "./i18n.js";

var MAX_TEXT = 160;

function clip(v) {
  var s = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + "…" : s;
}
function code(v) { var s = clip(v); return s && s.indexOf("`") === -1 ? "`" + s + "`" : s; }

// One short line for a tool's input: the path or command, never the whole payload.
export function summarizeToolInput(name, input) {
  if (!input || typeof input !== "object") return "";
  var v = input.file_path || input.notebook_path || input.path || input.command || input.url || input.query || input.pattern;
  return typeof v === "string" ? clip(v) : "";
}

export function createTurnNarrator() {
  var tools = {};      // tool id -> name
  var perms = {};      // permission request id -> tool name
  var lastUser = "";   // key of the latest user message: ties a turn's closing entry to it

  function reset() { tools = {}; perms = {}; lastUser = ""; }

  // Every entry carries `turn` (the request it belongs to) and `kind`, so the panel can group a turn into one
  // card and count calls without parsing text. Both come from observed frames only.
  function entry(id, stage, source, text, ts, extra) {
    return Object.assign({ id: id, stage: stage, source: source, text: text, ts: typeof ts === "number" && ts > 0 ? ts : Date.now(), turn: lastUser }, extra || {});
  }

  function feed(msg) {
    if (!msg || typeof msg.type !== "string") return [];
    var ts = msg._ts;
    switch (msg.type) {
      case "user_message": {
        var key = msg._mid || (msg._ts ? "ts" + msg._ts : "");
        if (!key || typeof msg.text !== "string" || !msg.text) return [];
        lastUser = key;
        return [entry("t:um:" + key, "understand", "task_state", t("turnNarration.requestReceived", { text: code(msg.text) }), ts, { kind: "request", request: clip(msg.text) })];
      }
      case "tool_start":
        if (!msg.id) return [];
        tools[msg.id] = msg.name || "";
        return [entry("t:tool:" + msg.id, "next_action", "tool_call", t("turnNarration.toolStart", { tool: code(msg.name || t("turnNarration.toolFallback")) }), ts, { kind: "call", tool: msg.name || "" })];
      case "tool_executing": {
        if (!msg.id) return [];
        tools[msg.id] = msg.name || tools[msg.id] || "";
        var sum = summarizeToolInput(msg.name, msg.input);
        return [entry("t:tool:" + msg.id, "next_action", "tool_call", (sum ? t("turnNarration.toolRunningTarget", { tool: code(tools[msg.id] || t("turnNarration.toolFallback")), target: code(sum) }) : t("turnNarration.toolRunning", { tool: code(tools[msg.id] || t("turnNarration.toolFallback")) })), ts, { kind: "call", tool: tools[msg.id] || "", target: sum })];
      }
      case "permission_request":
      case "permission_request_pending": {
        if (!msg.requestId) return [];
        var psum = summarizeToolInput(msg.toolName, msg.toolInput);
        perms[msg.requestId] = msg.toolName || "";
        return [entry("t:perm:" + msg.requestId, "next_action", "approval_request", t("turnNarration.approvalWait", { tool: code(msg.toolName || t("turnNarration.toolFallback")) + (psum ? " (" + code(psum) + ")" : "") }), ts, { kind: "approval", decision: "wait", tool: perms[msg.requestId] })];
      }
      case "permission_resolved": {
        if (!msg.requestId) return [];
        var allowed = typeof msg.decision === "string" && msg.decision.indexOf("allow") === 0;
        return [entry("t:perm:" + msg.requestId, "next_action", "approval_request", (allowed ? t("turnNarration.approvalAllowed") : t("turnNarration.approvalDenied")), ts, { kind: "approval", decision: allowed ? "allow" : "deny", tool: perms[msg.requestId] || "" })];
      }
      case "permission_cancel":
        return msg.requestId ? [entry("t:perm:" + msg.requestId, "next_action", "approval_request", t("turnNarration.approvalCancelled"), ts, { kind: "approval", decision: "cancel", tool: perms[msg.requestId] || "" })] : [];
      case "tool_result": {
        if (!msg.id) return [];
        var name = tools[msg.id] || "";
        return [entry("t:res:" + msg.id, "result", "tool_call", (msg.is_error ? t("turnNarration.resultError", { tool: name ? code(name) : t("turnNarration.toolFallback") }) : t("turnNarration.resultOk", { tool: name ? code(name) : t("turnNarration.toolFallback") })), ts, { kind: "result", tool: name, failed: !!msg.is_error })];
      }
      case "error": {
        var text = clip(msg.text || msg.error || "");
        return [entry("t:err:" + (msg._mid || lastUser || "x") + ":" + text.length, "result", "task_state", (text ? t("turnNarration.errorWithText", { text: text }) : t("turnNarration.error")), ts, { kind: "error" })];
      }
      case "done":
        // Honest by construction: nothing here observes a test or tool verification.
        return [entry("t:done:" + (lastUser || "x"), "verify", "task_state", t("turnNarration.done"), ts,
          { kind: "done", status: "not_run", evidence: t("turnNarration.noTestOutput") })];
      default:
        return [];
    }
  }

  return { feed: feed, reset: reset };
}

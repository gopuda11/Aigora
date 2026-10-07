// chat-model.js - Pure conversation model for the standalone Aigora client.
// A thread folds server WS messages (live or replayed history) into a list of
// plain items. No DOM, no store, no WS.

import { mentionTextHtml } from "./member-mentions-model.js";
import { escapeHtml } from "../modules/escape-html.js";
import { t } from "./i18n.js";
import { summarizeToolInput } from "./turn-narration.js";
import { normalizeCoaching, renderShareCard as renderCoachCard } from "./coaching-model.js";
import { foldAttachment, foldAiResult } from "./attachments-model.js";
import { foldAskUser, renderAsk } from "./ask-user-model.js";

export function createThread() {
  return { items: [], processing: false, activity: "", earlierHidden: false, historyFrom: 0, loadingEarlier: false, open: null, stepRoles: {} };
}

function closeOpen(t) {
  t.open = null;
}

function push(t, item) {
  closeOpen(t);
  t.items.push(item);
}

var RUN_TERMINAL = { completed: 1, failed: 1, cancelled: 1 };
var AGENT_LABEL = { claude: "Claude", codex: "Codex",  get local() { return t("chat.agentLocal"); } };
var VERIFY_LABEL = {
  get unverified() { return t("chat.verifyUnverified"); },
  get author_checked() { return t("chat.verifyAuthor"); },
  get tests_passed() { return t("chat.verifyTests"); },
};

function findPermission(t, requestId) {
  for (var i = 0; i < t.items.length; i++) if (t.items[i].role === "permission" && t.items[i].requestId === requestId) return t.items[i];
  return null;
}

// A decision (or cancel) that arrives for a request: update its card, or remember it so a request replayed
// afterwards (history, then the pending re-send) does not come back as pending.
function settlePermission(t, requestId, state) {
  if (typeof requestId !== "string" || !requestId) return false;
  var item = findPermission(t, requestId);
  if (item) { if (item.state === state) return false; item.state = state; return true; }
  t.permSettled = t.permSettled || {};
  t.permSettled[requestId] = state;
  return false;
}

function findRoute(th, routeId) {
  for (var i = 0; i < th.items.length; i++) if (th.items[i].role === "route" && th.items[i].routeId === routeId) return th.items[i];
  return null;
}

/** Show or hide the top-3 list under a route chip. Returns true when the thread changed. */
export function toggleRoute(th, routeId) {
  var it = findRoute(th, routeId);
  if (!it) return false;
  it.open = !it.open;
  return true;
}

/** The member tapped 👍/👎. Returns the value to send, or null when it is not allowed (unknown route, already given). */
export function startRouteFeedback(th, routeId, value) {
  var it = findRoute(th, routeId);
  if (!it || (value !== 1 && value !== -1) || it.feedback !== null) return null;
  it.feedback = value;
  return value;
}
export function undoRouteFeedback(th, routeId) {
  var it = findRoute(th, routeId);
  if (it) it.feedback = null;
}

function hasMid(t, mid) {
  for (var i = 0; i < t.items.length; i++) if (t.items[i].mid === mid) return true;
  return false;
}

/**
 * Fold one server message into `t`. Returns true when the thread changed.
 * `ctx.sessionId` (the active session) scopes orchestration run state: only a
 * run rooted in this session may start or clear the busy indicator.
 */
export function applyMessage(th, msg, ctx) {
  if (!msg || typeof msg.type !== "string") return false;
  // Claude's AskUserQuestion card: the tool frame and its answered frame (ask-user-model.js).
  if (msg.type === "tool_executing" || msg.type === "ask_user_answered") return foldAskUser(th, msg, push) === true;
  switch (msg.type) {
    case "orchestration_answer": {
      // Persisted final answer of a run; the stable _mid makes live delivery and
      // history replay (or a reconnect) show it exactly once.
      if (typeof msg.text !== "string" || !msg.text || typeof msg._mid !== "string" || !msg._mid) return false;
      // Entries carrying rootSessionId fold only into that session's thread; older
      // history entries without it replay as before (the server already scopes them).
      // Replay (history_meta..history_done) is exempt: local ids are reassigned per daemon
      // start, so a persisted rootSessionId may be stale while the replay is this session's own.
      if (!th.replaying && msg.rootSessionId != null && (!ctx || ctx.sessionId == null || String(msg.rootSessionId) !== String(ctx.sessionId))) return false;
      if (hasMid(th, msg._mid)) return false;
      push(th, { role: "assistant", answer: true, agent: typeof msg.agent === "string" ? msg.agent : "", label: typeof msg.label === "string" ? msg.label.slice(0, 120) : "", runId: msg.runId, text: msg.text, ts: msg._ts || 0, mid: msg._mid,
        stepId: typeof msg.stepId === "string" ? msg.stepId : "", stepRole: typeof msg.stepRole === "string" ? msg.stepRole : "", verdict: typeof msg.verdict === "string" ? msg.verdict : "" });
      return true;
    }
    case "orchestration_event": {
      var run = msg.run;
      // Which step is a verification: old answers carry no role, so the run's own steps tell (kept per thread).
      if (run && Array.isArray(run.steps)) {
        th.stepRoles = th.stepRoles || {};
        run.steps.forEach(function (st) { if (st && typeof st.stepId === "string" && typeof st.role === "string") th.stepRoles[st.stepId] = st.role; });
      }
      if (!ctx || !run || ctx.sessionId == null || String(run.rootSessionId) !== String(ctx.sessionId)) return false;
      var busy = !RUN_TERMINAL[run.status];
      // A failed explicit endpoint pick (one "mention" step on agent "local" whose model is "<endpointId>/<model>"):
      // one failure line with [다시 보내기] / [다른 AI로 보내기]. Never replayed, never resent by itself.
      var pushed = false;
      if (run.status === "failed" && !th.replaying && Array.isArray(run.steps) && run.steps.length === 1) {
        var fs = run.steps[0], fm = fs && fs.status === "failed" && fs.agent === "local" && fs.role === "mention" && typeof fs.model === "string" && /^([a-z0-9][a-z0-9-]{0,19})\//.exec(fs.model);
        if (fm && !th.items.some(function (x) { return x.role === "pickfail" && x.runId === run.runId; })) {
          var lastUser = null;
          for (var ui = th.items.length - 1; ui >= 0; ui--) if (th.items[ui].role === "user") { lastUser = th.items[ui]; break; }
          var fe = fs.error && typeof fs.error.message === "string" ? fs.error.message : "";
          push(th, { role: "pickfail", runId: run.runId, endpoint: fm[1], retryText: lastUser ? lastUser.text : "", text: fe || t("chat.errorDefault"), used: false });
          pushed = true;
        }
      }
      // A one-agent mention run says who is answering, so the thread is not silent while it runs.
      var who = busy && Array.isArray(run.steps) && run.steps.length === 1 && AGENT_LABEL[run.steps[0].agent];
      var activity = who ? t("chat.agentResponding", { name: who }) : "";
      if (th.processing === busy && (!busy || !who || th.activity === activity)) return pushed;
      th.processing = busy;
      if (!busy) { th.activity = ""; th.queued = 0; } else if (who) th.activity = activity;
      return true;
    }
    case "route_decision": {
      // The result of automatic model selection for one request (text-free). An explicit choice never produces one.
      var rd = msg.decision;
      if (!rd || typeof msg.routeId !== "string" || !msg.routeId || rd.reason === "explicit") return false;
      for (var ri = 0; ri < th.items.length; ri++) if (th.items[ri].role === "route" && th.items[ri].routeId === msg.routeId) return false;
      var top = (Array.isArray(rd.top) ? rd.top : []).slice(0, 3).filter(function (x) { return x && typeof x.option === "string" && typeof x.p === "number" && isFinite(x.p); })
        .map(function (x) { return { option: x.option, p: Math.max(0, Math.min(1, x.p)) }; });
      push(th, { role: "route", routeId: msg.routeId, from: msg.from == null ? null : String(msg.from), abstain: rd.abstain === true || !rd.agent, reason: typeof rd.reason === "string" ? rd.reason : "",
        by: ["clef", "jev", "ensemble", "endpoint"].indexOf(rd.by) !== -1 ? rd.by : "", option: typeof rd.option === "string" ? rd.option : (typeof rd.agent === "string" ? rd.agent : ""), ran: typeof rd.ran === "string" ? rd.ran : "", top: top, open: false, feedback: null, ts: msg._ts || 0 });
      return true;
    }
    case "run_feedback_ack": {
      // Only the requesting member is ever sent this; it settles the buttons of that route's chip.
      var fbItem = findRoute(th, msg.routeId);
      if (!fbItem || (msg.value !== 1 && msg.value !== -1) || fbItem.feedback === msg.value) return false;
      fbItem.feedback = msg.value;
      return true;
    }
    case "turn_refused":
      // The server declined the turn: a visible system line with the reason (never an agent message).
      push(th, { role: "notice", kind: "refusal", text: String(msg.text || t("chat.refusedDefault")), noticeId: "refused:" + th.items.length + ":" + Date.now() });
      return true;
    case "history_done":
      th.replaying = false;
      return false;
    case "permission_request":
    case "permission_request_pending": {
      // The wire format of the legacy console: { requestId, toolName, toolInput }. The same request can arrive
      // twice (recorded history and the pending re-send), so it folds by requestId.
      if (typeof msg.requestId !== "string" || !msg.requestId || findPermission(th, msg.requestId)) return false;
      var settled = th.permSettled && th.permSettled[msg.requestId];
      push(th, { role: "permission", requestId: msg.requestId, toolName: String(msg.toolName || t("chat.toolDefault")), summary: summarizeToolInput(msg.toolName, msg.toolInput), state: settled || "pending", ts: msg._ts || 0, riskText: typeof msg.riskText === "string" ? msg.riskText : "", requesterId: msg.requesterCanApprove ? msg.requesterId : null });
      return true;
    }
    case "permission_resolved":
      return settlePermission(th, msg.requestId, typeof msg.decision === "string" && msg.decision.indexOf("allow") === 0 ? "allow" : "deny");
    case "permission_cancel":
      return settlePermission(th, msg.requestId, "cancelled");
    case "history_meta":
      th.replaying = true;
      th.permSettled = {};
      th.askSettled = {};
      th.items = [];
      th.open = null;
      th.activity = "";
      th.earlierHidden = typeof msg.from === "number" && msg.from > 0;
      th.historyFrom = typeof msg.from === "number" ? msg.from : 0;
      th.loadingEarlier = false;
      return true;
    case "history_prepend": {
      // Older complete turns, loaded on request. Only the page that ends where this thread's history starts
      // is taken, so a late or repeated page (reconnect, double click) can never show a turn twice.
      var meta = msg.meta || {};
      if (!Array.isArray(msg.items) || typeof meta.from !== "number" || meta.to !== th.historyFrom) return false;
      var older = createThread();
      older.replaying = true;
      older.permSettled = {};
      msg.items.forEach(function (m) { applyMessage(older, m, ctx); });
      th.items = older.items.filter(function (it) { return !it.mid || !hasMid(th, it.mid); }).concat(th.items);
      th.historyFrom = meta.from;
      th.earlierHidden = meta.from > 0;
      th.loadingEarlier = false;
      return true;
    }
    case "user_message":
      push(th, { role: "user", mentions: msg.mentions || [], text: String(msg.text == null ? "" : msg.text), name: msg.fromName || "", fromId: msg.from == null ? "" : String(msg.from), images: Number(msg.imageCount) || 0, files: Array.isArray(msg.attachedFiles) ? msg.attachedFiles.filter(function (f) { return f && typeof f.name === "string"; }).map(function (f) { return { id: String(f.id), name: f.name }; }) : [], attachments: Array.isArray(msg.images) ? msg.images.map(function (img) { var a = { mediaType: img.mediaType, url: img.url }; if (typeof img.src === "string") a.src = img.src; if (typeof img.thumb === "string") a.thumb = img.thumb; return a; }) : [], ts: msg._ts || 0, mid: msg._mid || undefined, local: msg._local ? true : undefined });
      return true;
    case "member_message":
      // A note between room members: never an agent turn, so it neither starts nor closes one.
      var mText = typeof msg.text === "string" ? msg.text : "";
      var mImages = Array.isArray(msg.images) ? msg.images.map(function (img) { var a = { mediaType: img.mediaType, url: img.url }; if (typeof img.src === "string") a.src = img.src; if (typeof img.thumb === "string") a.thumb = img.thumb; return a; }) : [];
      var mFiles = Array.isArray(msg.files) ? msg.files.filter(function (f) { return f && typeof f.name === "string"; }).map(function (f) { return { id: String(f.id || ""), name: f.name }; }) : [];
      if (!mText && !mImages.length && !mFiles.length) return false;
      if (msg._mid && hasMid(th, msg._mid)) return false;
      th.items.push({ role: "member", fromId: msg.from == null ? "" : String(msg.from), mentions: msg.mentions || [], text: mText, name: msg.fromName || "", avatar: msg.fromAvatar || null, attachments: mImages, files: mFiles, ts: msg._ts || 0, mid: msg._mid || undefined, local: msg._local ? true : undefined });
      return true;
    case "shared_post_card": {
      // A result a member shared from a private channel, as a compact entry in the
      // room feed. Replays and live delivery fold by post id, so it shows once.
      if (typeof msg.postId !== "string" || !msg.postId) return false;
      for (var ci = 0; ci < th.items.length; ci++) if (th.items[ci].role === "card" && th.items[ci].postId === msg.postId) return false;
      th.items.push({ role: "card", postId: msg.postId, title: typeof msg.title === "string" ? msg.title : "", author: typeof msg.authorName === "string" ? msg.authorName : "", verification: typeof msg.verification === "string" ? msg.verification : "", attachments: Array.isArray(msg.attachments) ? msg.attachments.filter(function (a) { return a && typeof a.url === "string"; }).map(function (a) { return { mediaType: a.mediaType, url: a.url }; }) : [], ts: msg._ts || 0 });
      return true;
    }
    case "skill_notice": {
      // A skill switch told to the feed (never agent input); folds by its own id so replay and live show it once.
      if (typeof msg.noticeId !== "string" || !msg.noticeId || typeof msg.text !== "string") return false;
      for (var ni = 0; ni < th.items.length; ni++) if (th.items[ni].role === "notice" && th.items[ni].noticeId === msg.noticeId) return false;
      th.items.push({ role: "notice", noticeId: msg.noticeId, text: msg.text, ts: msg._ts || 0 });
      return true;
    }
    case "attachment_card":
    case "attachment_card_removed":
    case "attachment_transcript":
      // A file attached to the room or a private channel: its own history type, never agent input.
      return foldAttachment(th, msg);
    case "ai_result_files":
    case "ai_result_published":
      // The files an AI turn left in outbox/ and what became of them: its own history types, never agent input.
      return foldAiResult(th, msg);
    case "coaching_share_card": {
      // A prompt improvement its author chose to share: its own history type, never agent input.
      if (typeof msg.shareId !== "string" || !msg.shareId || typeof msg.text !== "string") return false;
      for (var si = 0; si < th.items.length; si++) if (th.items[si].role === "coachcard" && th.items[si].shareId === msg.shareId) return false;
      th.items.push({ role: "coachcard", shareId: msg.shareId, author: typeof msg.authorName === "string" ? msg.authorName : "", text: msg.text, before: typeof msg.before === "string" ? msg.before : "",
        criteria: (normalizeCoaching({ mid: msg.shareId, criteria: msg.criteria }) || {}).criteria || [], ts: msg._ts || 0 });
      return true;
    }
    case "delta":
      if (typeof msg.text !== "string") return false;
      if (th.open) {
        th.open.text += msg.text;
        if (msg._mid && !th.open.mid) th.open.mid = msg._mid;
      } else {
        // A turn of a picked agent that is not the room's own AI says who answered (the server stamps `agent`).
        th.open = { role: "assistant", text: msg.text, mid: msg._mid || undefined, agentLabel: AGENT_LABEL[msg.agent] || undefined };
        th.items.push(th.open);
      }
      th.activity = "";
      return true;
    case "message_ack": {
      // Bind to the oldest local echo still waiting, so acks land in send order.
      if (!msg.mid) return false;
      for (var i = 0; i < th.items.length; i++) {
        if (th.items[i].local && !th.items[i].mid) {
          th.items[i].mid = msg.mid;
          if (typeof msg.text === "string") th.items[i].text = msg.text;
          if (Array.isArray(msg.mentions)) th.items[i].mentions = msg.mentions;
          return true;
        }
      }
      return false;
    }
    case "tool_start":
      th.activity = msg.name ? t("chat.toolUsingNamed", { name: msg.name }) : t("chat.toolUsing");
      return true;
    case "thinking_start":
      th.activity = t("chat.thinking");
      return true;
    case "run_queue": {
      // Live scheduler state for this session only: 1-based place in line while waiting for a slot, 0 once started,
      // cancelled or finished. Never stored in history, so a replay cannot revive it.
      if (msg.localId != null && ctx && ctx.sessionId != null && String(msg.localId) !== String(ctx.sessionId)) return false;
      var pos = Number.isInteger(msg.position) && msg.position > 0 ? msg.position : 0;
      if ((th.queued || 0) === pos) return false;
      th.queued = pos;
      return true;
    }
    case "status":
      if (msg.status === "processing") { th.processing = true; return true; }
      return false;
    case "done":
      foldAskUser(th, msg, push);
      closeOpen(th);
      th.processing = false;
      th.queued = 0;
      th.activity = "";
      return true;
    case "error": {
      foldAskUser(th, msg, push);
      var text = msg.text || msg.error || t("chat.errorDefault");
      push(th, { role: "error", text: String(text), mid: msg._mid || undefined });
      return true;
    }
    default:
      return false;
  }
}

function formatInline(text) {
  return escapeHtml(text).replace(/`([^`\n]+)`/g, "<code>$1</code>");
}

// An AI answer: fenced code blocks (```lang ... ```) become their own block with a 복사 button; everything else is
// shown as before. The block's text is the source as written, so a copy is exact. An unclosed fence stays plain.
function formatAnswer(text) {
  var src = String(text == null ? "" : text);
  var out = "";
  var at = 0;
  var fence = /(^|\n)```([^\n`]*)\n([\s\S]*?)\n?```[ \t]*(?=\n|$)/g;
  var m;
  while ((m = fence.exec(src))) {
    var lead = src.slice(at, m.index);
    out += formatInline(lead);
    var lang = m[2].trim();
    out += '<div class="ai-code"><div class="ai-code-head"><span class="ai-code-lang">' + escapeHtml(lang || t("chat.codeDefault")) + "</span>" +
      '<button type="button" class="ai-act ai-code-copy" data-copy-code aria-label="' + escapeHtml(t("chat.copyCode")) + '">' + CODE_COPY_ICON + "<span>" + escapeHtml(t("chat.copy")) + "</span></button></div>" +
      "<pre><code>" + escapeHtml(m[3]) + "</code></pre></div>";
    at = fence.lastIndex;
    if (src.charAt(at) === "\n") at++;
  }
  return out + formatInline(src.slice(at));
}
// The AI's own mark in a label: a small round chip, so an AI answer is not mistaken for a member's.
var AI_AVATAR = '<span class="member-avatar ai-sender" aria-hidden="true">AI</span>';
var CODE_COPY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A2.5 2.5 0 017.5 4H15"/></svg>';

var PERM_STATE = {
  get allow() { return t("chat.permAllowed"); },
  get deny() { return t("chat.permDenied"); },
  get cancelled() { return t("chat.permCancelled"); },
};

function renderPermission(it, canApprove) {
  var id = escapeHtml(it.requestId);
  var head = '<p class="message-label">' + escapeHtml(t("chat.permRequest")) + '</p><div class="bubble"><strong>' + escapeHtml(it.toolName) + "</strong>" +
    (it.summary ? ' <code class="perm-summary">' + escapeHtml(it.summary) + "</code>" : "") +
    (it.riskText ? '<p class="perm-risk">' + escapeHtml(it.riskText) + "</p>" : "");
  var tail;
  if (it.state !== "pending") tail = '<p class="perm-state perm-' + escapeHtml(it.state) + '">' + PERM_STATE[it.state] + "</p>";
  else if (canApprove) {
    tail = '<div class="perm-actions"><button type="button" class="perm-allow" data-perm-decision="allow" data-perm-id="' + id + '">' + escapeHtml(t("chat.allow")) + '</button>' +
      '<button type="button" class="perm-deny" data-perm-decision="deny" data-perm-id="' + id + '">' + escapeHtml(t("chat.deny")) + '</button></div>';
  } else tail = '<p class="perm-state perm-waiting">' + escapeHtml(t("chat.permWaiting")) + '</p>';
  return '<article class="message perm-card is-' + escapeHtml(it.state) + '" role="group" aria-label="' + escapeHtml(t("chat.permAria", { name: it.toolName })) + '" data-perm-card="' + id + '">' + head + tail + "</div></article>";
}

var THUMB_SRC = /^(?:\/p\/[A-Za-z0-9_-]+\/images\/\d+-[a-f0-9]+\.(?:png|jpe?g|gif|webp)|\/(?:p\/[A-Za-z0-9_-]+\/)?api\/shared-posts\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+|data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+\/=]+)$/;

var imageBase = "";
/** "/p/<slug>": the project prefix for /api/ image routes (shared-post images are served under the project). */
export function setImageBase(base) { imageBase = typeof base === "string" ? base : ""; }

/** Thumbnails of the images a message carries. Only the image routes and data: URLs of our own are ever emitted. */
// The files attached to a sent instruction: read-only chips (the composer's chip look, no remove button).
function sentFilesHtml(it) {
  if (!it.files || !it.files.length) return "";
  return '<div class="ai-sent-files">' + it.files.map(function (f) { return '<span class="ai-chip ai-chip-file" data-sent-file="' + escapeHtml(f.id) + '"><span class="ai-chip-name">' + escapeHtml(f.name) + "</span></span>"; }).join("") + "</div>";
}
export function thumbsHtml(list, altBase) {
  if (!Array.isArray(list) || !list.length) return "";
  var out = "";
  list.forEach(function (a, i) {
    var src = a && (a.src || a.url);
    if (typeof src !== "string" || !THUMB_SRC.test(src)) return;
    if (src.indexOf("/api/") === 0) src = imageBase + src;
    var shown = typeof a.thumb === "string" && THUMB_SRC.test(a.thumb) ? a.thumb : src;
    var alt = altBase + " " + (i + 1) + (list.length > 1 ? "/" + list.length : "");
    out += '<button type="button" class="msg-thumb" data-lightbox="' + escapeHtml(src) + '" data-alt="' + escapeHtml(alt) + '" aria-label="' + escapeHtml(t("chat.enlargeAlt", { alt: alt })) +
      '"><img src="' + escapeHtml(shown) + '" alt="' + escapeHtml(alt) + '" loading="lazy" decoding="async"></button>';
  });
  return out ? '<div class="msg-thumbs">' + out + "</div>" : "";
}

var VERIFY_LABEL_RE = /^(?:검증|verification)\s*·\s*/i;

/** A verifier's answer (cross/single endpoint verifiers, after-turn verify follow-ups): by step role, or by its "검증 · name" label for older entries. */
export function isVerifyAnswer(th, it) {
  return it.stepRole === "verify" || !!(th.stepRoles && it.stepId && th.stepRoles[it.stepId] === "verify") || VERIFY_LABEL_RE.test(it.label || "");
}

/** "problems" | "none" | "unverified" | "" from the last lines of a verifier's text (same rule as the server's verdictOf). */
export function verdictOf(text) {
  var lines = String(text || "").trim().split(/\r?\n/).filter(function (l) { return l.trim(); }).slice(-3);
  for (var i = lines.length - 1; i >= 0; i--) {
    var m = /^(?:결론|verdict)\s*[:：]\s*(.+)$/.exec(lines[i].replace(/[*_`#>\s]+/g, " ").trim().toLowerCase());
    if (!m) continue;
    var v = m[1].replace(/[.。\s]+$/, "");
    if (/^(?:문제 없음|no problems?)$/.test(v)) return "none";
    if (/^(?:문제 있음|problems? found)$/.test(v)) return "problems";
    if (/^(?:확인 불가|could not verify)$/.test(v)) return "unverified";
  }
  return "";
}

// One compact line per verifier; the full text lives in the run log (tap opens it on the 에이전트 실행 tab).
function renderVerifyLine(it) {
  var name = (it.label || "").replace(VERIFY_LABEL_RE, "") || AGENT_LABEL[it.agent] || it.agent || "";
  var v = it.verdict || verdictOf(it.text);
  var icon = "\u2713", cls = "is-done", text;
  if (v === "none") { cls = "is-pass"; text = t("chat.verifyPass", { name: name }); }
  else if (v === "problems") { icon = "\u26A0"; cls = "is-problems"; text = t("chat.verifyProblems", { name: name }); }
  else if (v === "unverified") { icon = "?"; cls = "is-unsure"; text = t("chat.verifyUnsure", { name: name }); }
  else if (v === "failed") { icon = "\u26A0"; cls = "is-problems"; text = t("chat.verifyFailed", { name: name }); }
  else text = t("chat.verifyDone", { name: name });
  return '<article class="message verify-line" data-run-id="' + escapeHtml(String(it.runId || "")) + '"><button type="button" class="ai-verify-line ' + cls + '" data-verify-open="' + escapeHtml(String(it.runId || "")) +
    '" data-verify-step="' + escapeHtml(it.stepId || "") + '" aria-label="' + escapeHtml(t("chat.verifyOpenAria", { text: text })) + '"><span class="ai-verify-ico" aria-hidden="true">' + icon + '</span><span class="ai-verify-text">' + escapeHtml(text) + "</span></button></article>";
}

export function renderThread(th, opts) {
  var out = "";
  var extra = opts && typeof opts.extra === "function" ? opts.extra : function () { return ""; };
  var coachChip = opts && typeof opts.coachChip === "function" ? opts.coachChip : function () { return ""; };
  // The action row is laid out against the message's own box (bubble + what hangs off it), never the whole feed column.
  var box = function (html) { return '<div class="msg-box">' + html + "</div>"; };
  var lastAi = -1;
  th.items.forEach(function (it, i) { if (it.answer || it.role === "assistant") lastAi = i; });
  if (th.earlierHidden) {
    out += '<p class="ai-day">' + escapeHtml(t("chat.earlierHidden")) + "</p>" +
      '<button type="button" class="ai-load-earlier" data-load-earlier' + (th.loadingEarlier ? ' disabled aria-busy="true"' : "") + ">" +
      escapeHtml(th.loadingEarlier ? t("chat.loadingEarlier") : t("chat.loadEarlier")) + "</button>";
  }
  if (!th.items.length && !th.processing) {
    out += '<p class="ai-empty">' + escapeHtml((opts && opts.emptyText) || t("chat.emptyThread")) + "</p>";
  }
  th.items.forEach(function (it, i) {
    var latest = i === lastAi ? " is-latest-ai" : "";
    if (it.role === "user" && it.fromId && opts && opts.myUserId != null && String(opts.myUserId) !== it.fromId) {
      // Another member's instruction to the AI: grey, on the left, with their avatar and name - never mine.
      var other = it.name || t("chat.memberDefault");
      var otherLabel = t("chat.instructionFrom", { name: other }) + (it.images ? " · " + t("chat.imageCount", { count: it.images }) : "");
      out += '<article class="message theirs-instruction"><p class="message-label"><span class="member-avatar" aria-hidden="true">' + escapeHtml(Array.from(other)[0] || "?") + "</span>" + escapeHtml(otherLabel) + "</p>" +
        box((it.text ? '<div class="bubble">' + mentionTextHtml(it.text, it.mentions, opts && opts.myUserId, formatInline) + "</div>" : "") + thumbsHtml(it.attachments, t("chat.sentImages", { name: other })) + sentFilesHtml(it) + extra(it) + coachChip(it)) + "</article>";
    } else if (it.role === "user") {
      // My own: the label is always "나" (the room already knows who I am); the bubble is blue and on the right.
      var label = t("chat.me") + (it.images ? " · " + t("chat.imageCount", { count: it.images }) : "");
      out += '<article class="message me"><p class="message-label">' + escapeHtml(label) + "</p>" + box((it.text ? '<div class="bubble">' + mentionTextHtml(it.text, it.mentions, opts && opts.myUserId, formatInline) + "</div>" : "") + thumbsHtml(it.attachments, t("chat.sentImages", { name: it.name ? it.name : t("chat.me") })) + sentFilesHtml(it) + extra(it) + coachChip(it)) + "</article>";
    } else if (it.role === "member") {
      var who = it.name || t("chat.memberDefault");
      var color = it.avatar && /^#[0-9a-fA-F]{3,8}$/.test(it.avatar.color || "") ? it.avatar.color : "#7c3aed";
      var ownMember = it.local || (it.fromId && opts && opts.myUserId != null && String(opts.myUserId) === it.fromId);
      out += '<article class="message member-message' + (ownMember ? ' me' : '') + '"><p class="message-label"><span class="member-avatar" aria-hidden="true" style="background:' + color + '">' +
        escapeHtml(Array.from(who)[0] || "?") + "</span>" + escapeHtml(t("chat.memberMessage", { name: who })) + "</p>" + box((it.text ? '<div class="bubble">' + mentionTextHtml(it.text, it.mentions, opts && opts.myUserId, formatInline) + "</div>" : "") + thumbsHtml(it.attachments, t("chat.sentImages", { name: who })) +
        (it.files && it.files.length ? '<div class="member-files">' + it.files.map(function (f) { return '<span class="ai-chip ai-chip-file member-file">' + escapeHtml(f.name) + "</span>"; }).join("") + "</div>" : "") + extra(it)) + "</article>";
    } else if (it.role === "permission") {
      out += renderPermission(it, !!(opts && (opts.canApprove || (it.requesterId != null && opts.myUserId != null && it.requesterId === opts.myUserId))));
    } else if (it.role === "ask") {
      out += renderAsk(it, th, !!(opts && opts.canAnswerAsk));
    } else if (it.role === "notice") {
      out += it.kind === "refusal"
        ? '<p class="ai-skill-notice ai-refusal" role="alert">' + escapeHtml(it.text) + "</p>"
        : '<p class="ai-skill-notice" role="note">' + escapeHtml(it.text) + "</p>";
    } else if (it.role === "route") {
      out += renderRoute(it, !!(opts && opts.myUserId != null && it.from != null && String(opts.myUserId) === it.from));
    } else if (it.role === "coachcard") {
      out += renderCoachCard(it);
    } else if (it.role === "attachment" || it.role === "airesult") {
      out += opts && typeof opts.attachCard === "function" ? opts.attachCard(it, extra(it)) : "";
    } else if (it.role === "card") {
      out += '<article class="message post-card" data-post-card="' + escapeHtml(it.postId) + '"><p class="message-label">' + escapeHtml(t("chat.sharedResultLabel", { name: it.author || t("chat.memberDefault") })) + '</p><div class="bubble"><strong>' +
        escapeHtml(it.title || t("chat.noTitle")) + "</strong>" +
        (VERIFY_LABEL[it.verification] ? ' <span class="post-card-verify post-card-verify-' + escapeHtml(it.verification) + '">' + VERIFY_LABEL[it.verification] + "</span>" : "") +
        ' <button type="button" class="post-card-open" data-open-post="' + escapeHtml(it.postId) + '">' + escapeHtml(t("chat.viewInResults")) + '</button>' + thumbsHtml(it.attachments, t("chat.sharedImages")) + '</div></article>';
    } else if (it.answer && isVerifyAnswer(th, it)) {
      out += renderVerifyLine(it);
    } else if (it.answer) {
      out += '<article class="message' + latest + '" data-run-id="' + escapeHtml(String(it.runId || "")) + '"><p class="message-label">' + AI_AVATAR + (it.label ? escapeHtml(it.label) : escapeHtml(t("chat.finalAnswer")) +
        (AGENT_LABEL[it.agent] ? " · " + AGENT_LABEL[it.agent] : "")) + "</p>" + box('<div class="bubble">' + formatAnswer(it.text) + "</div>" + extra(it)) + "</article>";
    } else if (it.role === "assistant") {
      out += '<article class="message' + latest + '"><p class="message-label">' + AI_AVATAR + escapeHtml(it.agentLabel || t("chat.aiName")) + "</p>" + box('<div class="bubble">' + formatAnswer(it.text) + "</div>" + extra(it)) + "</article>";
    } else if (it.role === "pickfail") {
      var pfLabel = opts && typeof opts.endpointLabel === "function" ? opts.endpointLabel(it.endpoint) : it.endpoint;
      var pfAgent = escapeHtml("local:" + it.endpoint);
      out += '<article class="message"><div class="bubble is-error" role="alert">' + formatInline(it.text) + "</div>" +
        (it.used || !it.retryText ? "" : '<div class="ai-pickfail" role="group" aria-label="' + escapeHtml(pfLabel) + '">' +
          '<button type="button" class="ai-pickfail-btn" data-pickfail="retry" data-pickfail-agent="' + pfAgent + '" data-pickfail-item="' + i + '">' + escapeHtml(t("chat.pickFailRetry")) + "</button>" +
          '<button type="button" class="ai-pickfail-btn" data-pickfail="other" data-pickfail-agent="' + pfAgent + '" data-pickfail-item="' + i + '">' + escapeHtml(t("chat.pickFailOther")) + "</button></div>") + "</article>";
    } else {
      out += '<article class="message">' + box('<div class="bubble is-error" role="alert">' + formatInline(it.text) + "</div>" + extra(it)) + "</article>";
    }
  });
  if (th.processing) {
    out += '<p class="ai-working" role="status">' + escapeHtml(th.queued > 0 ? t("chat.queuedPos", { n: th.queued }) : (th.activity || t("chat.working"))) + "</p>";
  }
  return out;
}

function optionLabel(option) {
  var s = String(option || "");
  if (s.indexOf("local:") === 0) return AGENT_LABEL.local + " · " + s.slice(6);
  return AGENT_LABEL[s] || s;
}
function pct(p) { return Math.round(p * 100); }

// The chip under a request that was routed automatically ("Auto · Codex 72%") or deliberately left on the default path.
// Tapping it lists the top three candidates. 👍/👎 go to the member who made the request, for a route that was really
// decided or left on the default path (both are calibration data), and settle after the first tap.
function renderRoute(it, mine) {
  var chosen = it.top.filter(function (x) { return x.option === it.option; })[0] || it.top[0];
  // An abstained or skipped decision means the default executor ran: say which one (older records without it keep the plain wording).
  var label = it.abstain ? (it.ran ? t("decision.chipDefaultRan", { agent: optionLabel(it.ran) }) : t("decision.chipDefault")) : t("decision.chipAuto", { agent: optionLabel(it.option), pct: chosen ? pct(chosen.p) : 0 });
  if (it.by) label += " · " + it.by;
  var id = escapeHtml(it.routeId);
  var html = '<div class="ai-route" data-route="' + id + '"><button type="button" class="ai-route-chip' + (it.abstain ? " is-default" : "") + '" data-route-chip="' + id +
    '" aria-expanded="' + (it.open ? "true" : "false") + '" aria-controls="route-top-' + id + '">' + escapeHtml(label) + "</button>";
  if (mine) {
    var done = it.feedback !== null;
    html += '<span class="ai-route-fb" role="group" aria-label="' + escapeHtml(t("decision.feedbackLabel")) + '">' +
      '<button type="button" class="ai-route-fb-btn' + (it.feedback === 1 ? " is-picked" : "") + '" data-route-fb="' + id + '" data-value="1" aria-pressed="' + (it.feedback === 1 ? "true" : "false") + '"' + (done ? " disabled" : "") +
      ' aria-label="' + escapeHtml(t("decision.helpful")) + '" title="' + escapeHtml(t("decision.helpful")) + '">\uD83D\uDC4D</button>' +
      '<button type="button" class="ai-route-fb-btn' + (it.feedback === -1 ? " is-picked" : "") + '" data-route-fb="' + id + '" data-value="-1" aria-pressed="' + (it.feedback === -1 ? "true" : "false") + '"' + (done ? " disabled" : "") +
      ' aria-label="' + escapeHtml(t("decision.notHelpful")) + '" title="' + escapeHtml(t("decision.notHelpful")) + '">\uD83D\uDC4E</button></span>';
  }
  if (it.open) {
    html += '<ul class="ai-route-top" id="route-top-' + id + '" aria-label="' + escapeHtml(t("decision.topLabel")) + '">' +
      it.top.map(function (x) { return "<li>" + escapeHtml(optionLabel(x.option)) + " · " + pct(x.p) + "%</li>"; }).join("") + "</ul>";
  }
  return html + "</div>";
}

/** Image attachments the composer can send: type + size gate. */
export var MAX_IMAGES = 4;
export var MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export function imageProblem(file, count) {
  if (!file || !/^image\/(png|jpeg|gif|webp)$/.test(file.type || "")) return t("chat.imageTypeOnly");
  if (file.size > MAX_IMAGE_BYTES) return t("chat.imageTooBig");
  if (count >= MAX_IMAGES) return t("chat.imageMax", { max: MAX_IMAGES });
  return "";
}

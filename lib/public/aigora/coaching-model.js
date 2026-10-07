// coaching-model.js - Pure client rules of prompt coaching ("더 나은 지시"): the chip under the author's own
// message, the 지시 코칭 tab, the body they share (rubric chips + reasons, suggestion, buttons), the 내 지시 기록
// view and the shared card. Coaching is not part of the 작업 설명 timeline.
// No DOM, store or network. The rubric itself is computed on the server (lib/prompt-coaching.js); the
// client only displays what the server sent to this author. Every string goes through escapeHtml.

import { escapeHtml } from "../modules/escape-html.js";

import { t, formatDate } from "./i18n.js";
var e = escapeHtml;

var RUBRIC_IDS = { outcome: 1, context: 1, scope: 1, acceptance: 1, priority: 1, approval: 1 };
var STATUSES = { get present() { return t("coaching.statusPresent"); }, get weak() { return t("coaching.statusWeak"); }, get missing() { return t("coaching.statusMissing"); } };
var GLYPH = { present: "✓", weak: "△", missing: "＋" };
function lockedText() { return t("coaching.locked"); }
function strongText() { return t("coaching.strong"); }

function clip(v, max) { return typeof v === "string" ? (v.length > max ? v.slice(0, max) : v) : ""; }

// A rubric the page may show: known criteria and statuses only; anything else is dropped, never guessed.
export function normalizeCoaching(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.mid !== "string" || !raw.mid) return null;
  var criteria = (Array.isArray(raw.criteria) ? raw.criteria : []).filter(function (c) {
    return c && RUBRIC_IDS[c.id] && STATUSES[c.status];
  }).map(function (c) { return { id: c.id, label: clip(c.label, 40), status: c.status, reason: clip(c.reason, 200) }; });
  return {
    mid: raw.mid, mine: raw.mine === true, shared: raw.shared === true,
    level: raw.level === "strong" ? "strong" : "",
    hint: clip(raw.hint, 300), suggestion: clip(raw.suggestion, 6000), criteria: criteria,
  };
}

function entryFor(mid, ts, coaching, shared) {
  var out = {
    id: "t:coach:" + mid, stage: "better_prompt", source: "coaching",
    text: coaching.suggestion || coaching.hint || t("coaching.checkResult"), ts: ts, coaching: coaching,
  };
  if (!shared) out.visibility = "private";
  return out;
}

// prompt_coaching frame -> narration entry. `myId` decides whether this is the author's own view.
export function entryFromMessage(msg, myId) {
  var r = msg.result || {};
  var mine = msg.authorId != null && myId != null ? String(msg.authorId) === String(myId) : !msg.shared;
  return entryFor(msg.mid, msg.ts, {
    mid: msg.mid, mine: mine, shared: !!msg.shared, level: r.level, hint: r.hint, suggestion: r.suggestion, criteria: r.criteria, ai: mine ? msg.ai || null : null,
  }, !!msg.shared);
}

// A history entry of my own store -> the same narration entry.
export function entryFromHistory(h) {
  var r = h.result || {};
  return entryFor(h.id, h.ts, { mid: h.id, mine: true, shared: !!h.shared, level: r.level, hint: r.hint, suggestion: r.suggestion, criteria: r.criteria, ai: aiOf(h) }, !!h.shared);
}

export function metCount(criteria) {
  return (criteria || []).filter(function (c) { return c.status === "present"; }).length;
}

function chips(criteria, withReasons) {
  if (!criteria || !criteria.length) return "";
  var items = criteria.map(function (c) {
    return '<li class="coach-row"><span class="coach-chip is-' + e(c.status) + '"><span aria-hidden="true">' + GLYPH[c.status] + "</span>" + e(c.label) +
      '<span class="ag-visually-hidden"> ' + e(STATUSES[c.status]) + "</span></span>" +
      (withReasons && c.reason ? '<span class="coach-reason">' + e(c.reason) + "</span>" : "") + "</li>";
  }).join("");
  return '<ul class="coach-rubric' + (withReasons ? "" : " is-compact") + '" aria-label="' + t("coaching.rubricLabel") + '">' + items + "</ul>";
}

// --- AI로 완성하기 ---

// The AI state of a history entry: what happened in this page, else what the server kept for the author.
export function aiOf(h) {
  if (h && h.ai && typeof h.ai.state === "string") return h.ai;
  return h && typeof h.aiText === "string" && h.aiText ? { state: "done", text: h.aiText } : null;
}
var AI_ERRORS = ["failed", "timeout", "busy", "rate_limited", "unavailable", "forbidden", "not_found", "resend"];
function aiErrorText(code) { return t("coaching.aiErr." + (AI_ERRORS.indexOf(code) >= 0 ? code : "failed")); }
function hasGaps(criteria) { return (criteria || []).some(function (c) { return c.status === "missing" || c.status === "weak"; }); }

// The button, its loading and error states, and the result with its two actions. Only for the author's own item
// and only when something is missing or weak (a complete prompt has nothing to fill in).
export function renderAiBlock(mid, ai, criteria) {
  if (!mid || !hasGaps(criteria)) return "";
  var st = ai && ai.state, id = e(mid);
  var out = '<div class="coach-ai" data-coach-ai-block="' + id + '">';
  if (st === "done" && ai.text) {
    out += '<p class="coach-card-label">' + t("coaching.aiResultLabel") + '</p><blockquote class="coach-suggestion coach-ai-result">' + e(ai.text) + "</blockquote>" +
      '<div class="coach-actions"><button type="button" class="ag-btn" data-coach-ai-use="' + id + '">' + t("coaching.aiUse") + "</button>" +
      '<button type="button" class="ag-btn" data-coach-ai-copy="' + id + '">' + t("coaching.aiCopy") + "</button></div>";
  } else if (st === "loading") {
    out += '<div class="coach-actions"><button type="button" class="ag-btn" disabled aria-busy="true">' + t("coaching.aiComplete") + "</button></div>" +
      '<p class="ag-note coach-ai-loading" role="status">' + t("coaching.aiLoading") + "</p>";
  } else {
    var failed = st === "error";
    if (failed) out += '<p class="coach-ai-error" role="alert">' + e(aiErrorText(ai.code)) + "</p>";
    out += '<div class="coach-actions"><button type="button" class="ag-btn" data-coach-ai="' + id + '">' + t(failed ? "coaching.aiRetry" : "coaching.aiComplete") + "</button></div>";
    if (!failed) out += '<p class="ag-note">' + t("coaching.aiNote") + "</p>";
  }
  return out + "</div>";
}

// Body of a coaching entry: shared by the in-thread chip and the 지시 코칭 tab.
export function renderStepBody(entry) {
  if (entry.locked) return '<p class="coach-locked">' + e(lockedText()) + "</p>";
  var c = entry.coaching;
  if (!c) return "";
  var mine = c.mine;
  var out = chips(c.criteria, true);
  if (c.hint) out += '<p class="coach-hint">' + e(c.hint) + "</p>";
  if (c.suggestion) out += '<blockquote class="coach-suggestion">' + e(c.suggestion) + "</blockquote>";
  if (mine) {
    out += '<div class="coach-actions">' +
      (c.suggestion ? '<button type="button" class="ag-btn" data-coach-use="' + e(c.mid) + '">' + t("coaching.useSuggestion") + '</button>' : "") +
      '<button type="button" class="ag-btn" data-coach-history="' + e(c.mid) + '">' + t("coaching.viewHistory") + '</button></div>' +
      renderAiBlock(c.mid, c.ai, c.criteria) +
      '<p class="ag-note">' + t("coaching.noteMine") + " " + (c.shared ? t("coaching.noteShared") : t("coaching.notePrivate")) + "</p>";
  } else {
    out += '<p class="ag-note">' + t("coaching.sharedByAuthor") + '</p>';
  }
  return out;
}

// --- 내 지시 기록 ---

function avg(list) { return list.reduce(function (n, x) { return n + metCount(x.result && x.result.criteria); }, 0) / list.length; }
function one(n) { return (Math.round(n * 10) / 10).toFixed(1); }

// Latest five entries against the five before them (ids in time order); `previous` is null with no earlier ones.
export function summarizeHistory(entries) {
  var list = (entries || []).slice().sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
  var latest = list.slice(-5), before = list.slice(-10, -5);
  return { count: list.length, recent: latest.length ? avg(latest) : null, previous: before.length ? avg(before) : null };
}

function defaultTime(ts) {
  try { return formatDate(ts, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }); } catch (_) { return ""; }
}

export function renderHistoryHtml(entries, opts) {
  opts = opts || {};
  var fmt = opts.formatTime || defaultTime;
  var list = (entries || []).slice().sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
  if (!list.length) {
    return '<p class="coach-empty">' + t("coaching.histEmpty") + '</p>';
  }
  var s = summarizeHistory(list);
  var summary = '<p class="coach-hist-summary">' + t("coaching.histSummary", { total: s.count, recent: Math.min(5, s.count), avg: one(s.recent) }) +
    (s.previous != null ? " " + t("coaching.histPrevious", { avg: one(s.previous) }) : "") + "</p>";
  var items = list.map(function (h) {
    var r = h.result || {};
    var target = opts.target === h.id;
    return '<li class="coach-hist-item' + (target ? " coach-hist-target" : "") + '" data-coach-item="' + e(h.id) + '">' +
      '<div class="coach-hist-head"><time>' + e(fmt(h.ts)) + "</time><span>" + t("coaching.criteriaMet", { n: metCount(r.criteria) }) + "</span>" +
      (h.revisionOf ? '<span class="coach-tag">' + t("coaching.revised") + '</span>' : "") + "</div>" +
      '<blockquote class="coach-hist-text">' + e(clip(h.text, 600)) + "</blockquote>" +
      chips(r.criteria, false) +
      (r.hint ? '<p class="coach-hint">' + e(r.hint) + "</p>" : "") +
      '<div class="coach-actions">' +
      (r.suggestion ? '<button type="button" class="ag-btn" data-coach-use="' + e(h.id) + '">' + t("coaching.useSuggestion") + '</button>' : "") +
      (h.shared ? '<span class="coach-shared">' + t("coaching.sharedBadge") + '</span>'
        : h.roomId ? '<button type="button" class="ag-btn" data-coach-share="' + e(h.id) + '">' + t("coaching.shareImprovement") + '</button>' : "") +
      "</div>" + renderAiBlock(h.id, aiOf(h), r.criteria) + "</li>";
  }).join("");
  return summary + '<ol class="coach-hist-list">' + items + "</ol>";
}

// The card a shared revision leaves in the room feed (rendered by chat-model.js).
export function renderShareCard(it) {
  return '<article class="message post-card coach-card" data-coach-card="' + e(it.shareId) + '"><p class="message-label">' + e(it.author || t("coaching.memberFallback")) +
    " · " + t("coaching.shareImprovement") + '</p><div class="bubble">' +
    (it.before ? '<p class="coach-card-label">' + t("coaching.cardBefore") + '</p><blockquote class="coach-hist-text">' + e(clip(it.before, 600)) + "</blockquote>" +
      '<p class="coach-card-label">' + t("coaching.cardAfter") + '</p>' : "") +
    '<blockquote class="coach-hist-text">' + e(clip(it.text, 600)) + "</blockquote>" + chips(it.criteria, false) + "</div></article>";
}

// --- Per-message coaching (icon button in the message's action row; detail under the message) ---

// Worth a look: not already a strong prompt and at most 3 of the 6 rubric points met.
export function isLow(c) {
  return !!c && !!c.criteria && c.criteria.length > 0 && c.level !== "strong" && metCount(c.criteria) <= 3;
}

// What the action row needs for one message's coaching button, or null when there is nothing to point at.
export function coachInfo(c, open) {
  if (!c || !c.criteria || !c.criteria.length) return null;
  return { mid: c.mid, open: !!open, low: isLow(c), label: c.level === "strong" ? strongText() : t("coaching.suggestionLabel", { n: metCount(c.criteria) }) };
}

// The detail the chip used to open, shown under the author's message while open. `c` is a normalized coaching result.
export function renderChipBody(c, open) {
  if (!open || !c || !c.criteria || !c.criteria.length) return "";
  return '<div class="coach-inline is-open' + (c.level === "strong" ? " is-strong" : "") + '" data-coach-inline="' + e(c.mid) + '">' +
    '<div class="coach-inline-body" id="coach-chip-' + e(c.mid) + '">' + renderStepBody({ coaching: c }) + "</div></div>";
}

// --- 지시 코칭 tab ---

// `state` = { enabled, history } from coaching.js; `sessionId` the open session. Latest suggestion of this
// session, a compact trend and the way into 내 지시 기록. Only my own entries ever reach `history`.
export function renderCoachingTab(state, sessionId) {
  if (!state || !state.enabled) {
    return '<div class="ag-empty"><p class="ag-empty-title">' + t("coaching.offTitle") + '</p><p class="ag-empty-body">' + t("coaching.offBody") + '</p></div>';
  }
  var all = state.history || [];
  var mine = all.filter(function (h) { return sessionId != null && String(h.sessionId) === String(sessionId); })
    .sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
  var latest = mine[0];
  var out = "";
  if (latest) {
    var c = entryFromHistory(latest).coaching;
    out += '<section class="coach-tab-block"><h3 class="coach-tab-title">' + t("coaching.tabLatest") + '</h3>' +
      '<blockquote class="coach-hist-text">' + e(clip(latest.text, 160)) + "</blockquote>" +
      (c.level === "strong" ? '<p class="coach-hint">' + e(strongText()) + "</p>" : "") + renderStepBody({ coaching: c }) + "</section>";
  } else {
    out += '<div class="ag-empty"><p class="ag-empty-title">' + t("coaching.tabEmptyTitle") + '</p>' +
      '<p class="ag-empty-body">' + t("coaching.tabEmptyBody") + '</p></div>';
  }
  if (all.length) {
    var s = summarizeHistory(all);
    out += '<section class="coach-tab-block"><h3 class="coach-tab-title">' + t("coaching.trendTitle") + '</h3><p class="coach-trend">' + t("coaching.trend", { recent: Math.min(5, s.count), avg: "<b>" + one(s.recent) + "/6</b>" }) +
      (s.previous != null ? " · " + t("coaching.trendPrevious", { avg: one(s.previous) }) : "") + "</p></section>";
  }
  return out + '<div class="coach-actions"><button type="button" class="ag-btn" data-coach-history="">' + t("coaching.myHistory") + '</button></div>';
}

// agora-render.js - Pure HTML-string renderers for the Club Agora room UI.
//
// Each function takes already-normalized data (see agora-model.js) and returns
// markup, or "" when there is nothing grounded to show. All text goes through
// escapeHtml; the only element that can carry agent-authored text is built
// from segmentVerbatim() so code spans stay exact. No DOM, store or WS access,
// so these run under plain Node for tests.

import { escapeHtml } from "./escape-html.js";
import { iconHtml } from "./icons.js";
import {
  STAGES, SOURCES, VERIFY_STATUS, ROLES, RUBRIC, HARNESSES,
  sealIndex, sealGlyph, segmentVerbatim, summarizeStages, summarizeVerification, memberOnline,
  groupTurns, latestTurnEntries, summarizeTurn,
} from "./agora-model.js";
import { renderCoachingTab } from "../aigora/coaching-model.js";
import { t, getLang } from "../aigora/i18n.js";

var e = escapeHtml;

// `label` is a getter: it follows the interface language.
export var CONTEXT_TABS = [
  { id: "timeline", get label() { return t("agoraRender.tabTimeline"); } },
  { id: "coaching", get label() { return t("agoraRender.tabCoaching"); } },
  { id: "execution", get label() { return t("agoraRender.tabExecution"); } },
  { id: "members", get label() { return t("agoraRender.tabMembers"); } },
  { id: "verify", get label() { return t("agoraRender.tabVerify"); } },
];

// What the timeline is allowed to claim. Shown verbatim under every timeline (renderTimeline reads it per render,
// so it follows the language; this export is the text at load time).
export var OBSERVABLE_NOTICE = t("agoraRender.observableNotice");

var STATUS_GLYPH = { filled: "✓", pass: "✓", fail: "✕", not_run: "–" };

function badge(n, label) {
  if (!n) return "";
  return '<span class="ag-badge" aria-label="' + e(label + " " + n) + '">' + (n > 99 ? "99+" : n) + "</span>";
}

function seal(room) {
  return '<span class="ag-seal ag-seal-' + sealIndex(room.id) + '" aria-hidden="true">' + e(sealGlyph(room.name)) + "</span>";
}

// --- Left rail ---------------------------------------------------------------

// Disclosure chevron of a room row (inline, so a lucide icon pass never swaps the node).
var CHEVRON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';

// A section title that is also its own disclosure button: down chevron while
// expanded, right chevron while collapsed. `opts.idPrefix` keeps ids unique
// when the same rail is rendered twice (sidebar and mobile sheet).
function sectionOpts(opts, key) {
  var prefix = (opts && opts.idPrefix) || "ag-rail";
  return {
    expanded: !opts || opts.expanded !== false,
    bodyId: prefix + "-" + key + "-body",
    buttonId: prefix + "-" + key + "-toggle",
  };
}

function disclosureTitle(key, o, label, count) {
  return '<h2 class="ag-rail-title">' +
    '<button type="button" class="ag-disclosure' + (o.expanded ? "" : " is-collapsed") + '" id="' + o.buttonId + '"' +
    ' data-ag-section="' + key + '" aria-expanded="' + (o.expanded ? "true" : "false") + '" aria-controls="' + o.bodyId + '">' +
    iconHtml(o.expanded ? "chevron-down" : "chevron-right") +
    '<span class="ag-disclosure-label">' + e(label) + "</span>" +
    (count == null ? "" : '<span class="ag-rail-count">' + count + "</span>") + "</button></h2>";
}

/**
 * Invite-only room list. `rooms` are normalized rooms; `activeRoomId` marks
 * the current one. `opts` = { expanded, idPrefix, rowMenu } where the optional
 * rowMenu(kind, id) returns extra markup (a "⋯" trigger) placed after the row
 * button. Returns "" with no rooms
 * so the sidebar keeps its current shape.
 */
export function renderRoomRail(rooms, activeRoomId, opts) {
  if (!rooms || rooms.length === 0) return "";
  var o = sectionOpts(opts, "rooms");
  var tree = !!(opts && typeof opts.roomChildren === "function");
  var items = rooms.map(function (r) {
    var current = r.id === activeRoomId;
    var more = opts && opts.rowMenu ? opts.rowMenu("room", r.id) : "";
    // Aigora: only the selected room is expanded, and its children (방 대화, 나만의 채널, ...) are
    // drawn under it in a 0fr/1fr disclosure; every other room keeps a closed one (the caller may
    // hand back what that room showed last, so it can animate shut).
    var children = tree ? opts.roomChildren(r, current) || "" : "";
    // The room row opens the room's feed and is the highlighted one while the feed is open; the chevron beside it is
    // its own button and only folds or unfolds the children.
    var open = tree && current && !(opts.collapsed && opts.collapsed[r.id]);
    var feedHere = current && (!tree || opts.feedOpen !== false);
    var chev = tree ? '<button type="button" class="ag-chev-btn" data-ag-chev="' + e(r.id) + '" aria-expanded="' + (open ? "true" : "false") + '" aria-label="' + e(open ? t("agoraRender.collapseChildren", { name: r.name }) : t("agoraRender.expandChildren", { name: r.name })) + '">' +
      '<span class="ag-chev' + (open ? " is-open" : "") + '" aria-hidden="true">' + CHEVRON + "</span></button>" : "";
    var row = chev + '<button type="button" class="ag-room' + (r.archived ? " is-archived" : "") + '" data-room-id="' + e(r.id) + '"' +
      (feedHere ? ' aria-current="true"' : "") + ">" +
      seal(r) +
      '<span class="ag-room-text">' +
        '<span class="ag-room-name" title="' + e(r.name) + '">' + e(r.name) + "</span>" +
        '<span class="ag-room-meta"><span>' + e(t("agoraRender.memberCount", { count: r.memberCount })) + "</span>" +
        (r.archived ? '<span class="ag-tag">' + e(t("agoraRender.archived")) + "</span>" : '<span class="ag-tag">' + e(ROLES[r.role]) + "</span>") +
        "</span>" +
      "</span>" +
      badge(r.unread, t("agoraRender.unreadItems")) +
      "</button>" + more;
    if (!tree) return '<li class="ag-room-item' + (more ? " ag-has-menu" : "") + '">' + row + "</li>";
    open = open && !!children;
    return '<li class="ag-room-item ag-room-branch' + (more ? " ag-has-menu" : "") + '">' + row +
      '<div class="ag-disc" data-disc="room:' + e(r.id) + '" data-open="' + (open ? "true" : "false") + '"' + (open ? "" : ' aria-hidden="true" inert') + "><div>" + children + "</div></div></li>";
  }).join("");
  return '<section class="ag-rooms" lang="' + getLang() + '" aria-label="' + e(t("agoraRender.invitedRooms")) + '">' +
    disclosureTitle("rooms", o, t("agoraRender.roomsTitle"), rooms.length) +
    '<div class="ag-section-body" id="' + o.bodyId + '"' + (o.expanded ? "" : " hidden") + '>' +
    '<ul class="ag-room-list">' + items + "</ul></div></section>";
}

/**
 * Sessions inside the active room. `roomSessions` come from sessionsForRoom().
 * With a room selected but no sessions this is an accurate empty state, not a
 * hidden block. `opts` = { expanded, idPrefix, rowMenu } (see renderRoomRail).
 */
export function renderRoomSessions(room, roomSessions, opts) {
  if (!room) return "";
  var o = sectionOpts(opts, "sessions");
  var body;
  if (!roomSessions || roomSessions.length === 0) {
    body = '<p class="ag-empty-line">' + e(t("agoraRender.noSessions")) + '</p>';
  } else {
    body = '<ul class="ag-session-list">' + roomSessions.map(function (s) {
      var state = s.running ? t("agoraRender.running") : t("agoraRender.idle");
      var more = opts && opts.rowMenu ? opts.rowMenu("session", s.id) : "";
      return '<li' + (more ? ' class="ag-has-menu"' : "") + '><button type="button" class="ag-session" data-session-id="' + e(s.id) + '"' +
        (s.active ? ' aria-current="true"' : "") + ">" +
        '<span class="ag-dot' + (s.running ? " is-running" : "") + '" aria-hidden="true"></span>' +
        '<span class="ag-session-text"><span class="ag-session-title">' + e(s.title) + "</span>" +
        '<span class="ag-session-meta">' + e(s.agent) + " " + state + "</span></span>" +
        badge(s.unread, t("agoraRender.unreadMessages")) + "</button>" + more + "</li>";
    }).join("") + "</ul>";
  }
  return '<section class="ag-room-sessions" lang="' + getLang() + '" aria-label="' + e(t("agoraRender.sessionsOf", { name: room.name })) + '">' +
    disclosureTitle("sessions", o, t("agoraRender.sessionsOf", { name: room.name }), roomSessions ? roomSessions.length : 0) +
    '<div class="ag-section-body" id="' + o.bodyId + '"' + (o.expanded ? "" : " hidden") + ">" + body + "</div></section>";
}

/**
 * Aigora rooms are one shared feed, so there is no session list. Sessions that
 * predate that stay reachable here, collapsed, and only when there are some.
 * `roomSessions` are the room's sessions other than its main thread.
 */
export function renderPreviousConversations(room, roomSessions, opts) {
  if (!room || !roomSessions || roomSessions.length === 0) return "";
  var o = sectionOpts(opts, "previous");
  var body = '<ul class="ag-session-list">' + roomSessions.map(function (s) {
    var more = opts && opts.rowMenu ? opts.rowMenu("session", s.id) : "";
    return '<li' + (more ? ' class="ag-has-menu"' : "") + '><button type="button" class="ag-session" data-session-id="' + e(s.id) + '"' +
      (s.active ? ' aria-current="true"' : "") + ">" +
      '<span class="ag-session-text"><span class="ag-session-title">' + e(s.title) + "</span>" +
      '<span class="ag-session-meta">' + e(s.agent) + "</span></span>" +
      badge(s.unread, t("agoraRender.unreadMessages")) + "</button>" + more + "</li>";
  }).join("") + "</ul>";
  return '<section class="ag-room-sessions ag-previous" lang="' + getLang() + '" aria-label="' + e(t("agoraRender.previous")) + '">' +
    disclosureTitle("previous", o, t("agoraRender.previousTitle", { count: roomSessions.length }), null) +
    '<div class="ag-section-body" id="' + o.bodyId + '"' + (o.expanded ? "" : " hidden") + ">" + body + "</div></section>";
}

// --- Room header ---------------------------------------------------------------

function renderWorkRail(stageSummary) {
  var nodes = stageSummary.map(function (s) {
    var stateText = s.state === "empty" ? t("agoraRender.noRecords")
      : s.state === "filled" ? t("agoraRender.countItems", { count: s.count })
      : VERIFY_STATUS[s.state];
    return '<li class="ag-stage is-' + s.state + '" title="' + e(s.hint) + '">' +
      '<span class="ag-stage-node" aria-hidden="true">' + (STATUS_GLYPH[s.state] || "") + "</span>" +
      '<span class="ag-stage-label">' + e(s.label) + (s.state === "not_run" || s.state === "fail" ? ' <small class="ag-stage-state">' + e(stateText) + "</small>" : "") + "</span>" +
      '<span class="ag-visually-hidden">: ' + e(stateText) + ". " + e(s.hint) + "</span></li>";
  }).join("");
  return '<ol class="ag-work-rail" aria-label="' + e(t("agoraRender.workFlow")) + '">' + nodes + "</ol>";
}

// The title: the room's name, or in a private session "나만의 채널 · <세션>" (a menu trigger
// under layout A). `session` = { label, name, menu, open } from the private-channels module.
function headerTitle(room, session) {
  if (!session) return '<h1 class="ag-room-title" title="' + e(room.name) + '">' + e(room.name) + "</h1>";
  var text = '<span class="ag-title-prefix">' + e(session.label) + " ·</span> " + '<span class="ag-title-name">' + e(session.name) + "</span>";
  if (!session.menu) return '<h1 class="ag-room-title" title="' + e(session.label + " · " + session.name) + '">' + text + "</h1>";
  return '<h1 class="ag-room-title"><button type="button" class="ag-title-menu" data-ag-action="session-menu" aria-haspopup="menu" aria-expanded="' + (session.open ? "true" : "false") + '" aria-controls="ai-session-pop">' +
    text + '<svg class="ag-title-caret" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button></h1>';
}

/**
 * Header above the conversation. `view` = { room, entries, onlineIds,
 * panelOpen, sheetOpen }. The work rail summarizes the active session's narration; with
 * none it still lists the five stages as empty so novices see the flow.
 */
export function renderRoomHeader(view) {
  var room = view && view.room;
  if (!room) return "";
  return '<div class="ag-room-header-main" lang="' + getLang() + '">' +
    (view.sideButton ? '<button type="button" class="ag-btn ag-icon-only ag-side-btn" data-ag-action="side" aria-label="' + e(t("agoraRender.expandSidebar")) + '" title="' + e(t("agoraRender.expandSidebar")) + '">' + iconHtml("panel-left-open") + "</button>" : "") +
    seal(room) +
    '<div class="ag-room-header-text">' + headerTitle(room, view.session) + "</div>" +
    (room.archived ? '<span class="ag-tag ag-tag-archived">' + e(t("agoraRender.archived")) + "</span>" : "") +
    '<button type="button" class="ag-btn ag-rooms-toggle" data-ag-action="rooms" aria-haspopup="dialog" aria-controls="agora-room-sheet" aria-expanded="' + (view.sheetOpen ? "true" : "false") + '">' + e(t("agoraRender.switchRoom")) + "</button>" +
    '<button type="button" class="ag-btn ag-icon-only ag-panel-toggle' + (view.panelOpen ? "" : " is-collapsed") + '" data-ag-action="panel" aria-controls="agora-context" aria-pressed="' + (view.panelOpen ? "true" : "false") + '" aria-label="' + e(t("agoraRender.workPanel")) + '" title="' + e(t("agoraRender.workPanel")) + '">' + iconHtml(view.panelOpen ? "panel-right-close" : "panel-right-open") + "</button>" +
    "</div>" + renderWorkRail(railStages(summarizeStages(latestTurnEntries(view.entries))));
}

// --- Right panel -----------------------------------------------------------------

function segments(text) {
  return segmentVerbatim(text).map(function (s) {
    return s.type === "code" ? "<code>" + e(s.value) + "</code>" : e(s.value);
  }).join("");
}

function statusBadge(status) {
  if (!status) return "";
  return '<span class="ag-status is-' + status + '"><span aria-hidden="true">' + STATUS_GLYPH[status] + "</span>" + e(VERIFY_STATUS[status]) + "</span>";
}

function formatClock(ts, fmt) {
  if (ts == null) return "";
  var iso = "";
  try { iso = new Date(ts).toISOString(); } catch (err) { return ""; }
  var label = fmt ? fmt(ts) : "";
  return label ? '<time class="ag-entry-time" datetime="' + e(iso) + '">' + e(label) + "</time>" : "";
}

function stageLabel(id) {
  for (var i = 0; i < STAGES.length; i++) if (STAGES[i].id === id) return STAGES[i].label;
  return id;
}

function renderRubric(rubric) {
  if (!rubric) return "";
  var chips = RUBRIC.filter(function (r) { return typeof rubric[r.id] === "boolean"; }).map(function (r) {
    return '<li class="ag-rubric-item ' + (rubric[r.id] ? "is-met" : "is-missing") + '">' +
      '<span aria-hidden="true">' + (rubric[r.id] ? "✓" : "＋") + "</span>" + e(r.label) +
      '<span class="ag-visually-hidden">' + (rubric[r.id] ? t("agoraRender.rubricMet") : t("agoraRender.rubricMissing")) + "</span></li>";
  }).join("");
  return chips ? '<ul class="ag-rubric" aria-label="' + e(t("agoraRender.rubricLabel")) + '">' + chips + "</ul>" : "";
}

function renderEntry(entry, fmt) {
  var head = '<div class="ag-entry-head"><span class="ag-entry-stage">' + e(stageLabel(entry.stage)) + "</span>" +
    '<span class="ag-entry-source">' + e(SOURCES[entry.source]) + "</span>" + formatClock(entry.ts, fmt) + "</div>";
  var body;
  var disclosure = entry.source === "provider_trace"
    ? '<p class="ag-thinking-disclosure">' + e(t("agoraRender.thinkingDisclosure")) + "</p>" : "";
  if (entry.stage === "better_prompt") {
    body = disclosure + '<blockquote class="ag-suggestion" id="ag-suggestion-' + e(entry.id) + '">' + segments(entry.text) + "</blockquote>" +
      renderRubric(entry.rubric) +
      '<div class="ag-suggestion-actions">' +
      '<button type="button" class="ag-btn" data-ag-copy="' + e(entry.id) + '">' + e(t("agoraRender.copyPrompt")) + "</button>" +
      '<span class="ag-note">' + e(t("agoraRender.copyNote")) +
      (entry.private ? " " + e(t("agoraRender.privateOnly")) : "") + "</span></div>";
  } else {
    body = disclosure + '<p class="ag-entry-text">' + segments(entry.text) + "</p>" +
      (entry.status ? '<div class="ag-entry-status">' + statusBadge(entry.status) +
        (entry.evidence ? '<span class="ag-evidence">' + e(t("agoraRender.evidence")) + " <code>" + e(entry.evidence) + "</code></span>" : "") + "</div>" : "");
  }
  return '<li class="ag-entry" data-stage="' + e(entry.stage) + '">' +
    '<span class="ag-entry-node" aria-hidden="true"></span>' + head + body + "</li>";
}

// --- Turn cards ---------------------------------------------------------------

var OUTCOME = {
  running: { glyph: "", get text() { return t("agoraRender.outcomeRunning"); } },
  ok: { glyph: "✓", get text() { return t("agoraRender.outcomeOk"); } },
  warn: { glyph: "!", get text() { return t("agoraRender.outcomeWarn"); } },
  fail: { glyph: "✕", get text() { return t("agoraRender.outcomeFail"); } },
  idle: { glyph: "·", get text() { return t("agoraRender.outcomeIdle"); } },
};

var CHECK_STAGES = ["understand", "next_action", "result", "verify"];
// The stepper under the title shows the four narrated stages; 더 나은 지시 lives in the coaching chip and tab.
export function railStages(stages) { return stages.filter(function (s) { return s.id !== "better_prompt"; }); }

function oneLine(text, max) {
  var chars = Array.from(String(text || ""));
  return chars.length > max ? chars.slice(0, max).join("") + "…" : chars.join("");
}

function liveText(group, sum) {
  var last = group.entries[group.entries.length - 1];
  if (last && last.kind === "approval" && last.decision === "wait") return t("agoraRender.approvalWait") + (last.tool ? " · " + last.tool : "");
  if (last && last.kind === "call") return t("agoraRender.toolRunning", { tool: last.tool || t("agoraRender.toolFallback") });
  return stageLabel(sum.live || "understand");
}

function renderCheck(stage, sum) {
  var line = sum.lines[stage];
  var mark = line.state === "active" ? '<span class="ag-turn-spinner" aria-hidden="true"></span>' : line.state === "done" ? "✓" : "○";
  var text = line.text || (line.state === "done" ? "" : sum.running ? t("agoraRender.idle") : t("agoraRender.noRecords"));
  return '<li class="ag-check is-' + line.state + '" data-stage="' + stage + '"><span class="ag-check-mark" aria-hidden="true">' + mark + "</span>" +
    '<span class="ag-check-label">' + e(stageLabel(stage)) + "</span>" +
    (text ? '<span class="ag-check-sep" aria-hidden="true"> · </span><span class="ag-check-text">' + e(text) + "</span>" : "") +
    '<span class="ag-visually-hidden">' + (line.state === "done" ? t("agoraRender.checkDone") : line.state === "active" ? t("agoraRender.checkActive") : t("agoraRender.checkNone")) + "</span></li>";
}

// "Read 1" is a tool name and a count, not something a person says: "파일 읽기 1회" / "Read 1 file".
function toolCountText(name, count) {
  switch (name) {
    case "Read": return t("agoraRender.toolCountRead", { count: count });
    case "Write": return t("agoraRender.toolCountWrite", { count: count });
    case "Edit": case "MultiEdit": case "NotebookEdit": return t("agoraRender.toolCountEdit", { count: count });
    case "Bash": return t("agoraRender.toolCountBash", { count: count });
    case "Grep": case "Glob": return t("agoraRender.toolCountSearch", { count: count });
    case "WebFetch": case "WebSearch": return t("agoraRender.toolCountWeb", { count: count });
    default: return t("agoraRender.toolCountOther", { name: name, count: count });
  }
}

function renderTurn(group, i, isLatest, ui, fmt) {
  var sum = summarizeTurn(group, { running: isLatest && ui.running !== false });
  var open = ui.open[group.key] !== undefined ? ui.open[group.key] === true : isLatest;
  var detail = ui.detail[group.key] === true;
  var out = OUTCOME[sum.outcome];
  var bodyId = "ag-turn-body-" + i;
  var detailId = "ag-turn-detail-" + i;
  var title = sum.request ? oneLine(sum.request, 40) : t("agoraRender.turnTitleFallback");
  var counts = sum.toolCounts.map(function (c) { return e(toolCountText(c.name, c.count)); });
  if (sum.approvals) counts.push(e(t("agoraRender.approvalsN", { count: sum.approvals })));
  var iso = "";
  var clock = sum.ts != null && fmt ? fmt(sum.ts) : "";
  try { if (sum.ts != null) iso = new Date(sum.ts).toISOString(); } catch (err) { iso = ""; }
  var head = '<button type="button" class="ag-turn-head" data-ag-turn="' + e(group.key) + '" aria-expanded="' + (open ? "true" : "false") + '" aria-controls="' + bodyId + '">' +
    '<span class="ag-turn-icon is-' + sum.outcome + '" aria-hidden="true">' + (sum.running ? '<span class="ag-turn-spinner"></span>' : out.glyph) + "</span>" +
    '<span class="ag-turn-title">' + e(title) + "</span>" +
    (clock ? '<time class="ag-turn-time" datetime="' + e(iso) + '">' + e(clock) + "</time>" : "") +
    '<span class="ag-turn-caret" aria-hidden="true">' + CHEVRON + "</span>" +
    '<span class="ag-visually-hidden">' + e(out.text) + "</span></button>";
  var body = (sum.running ? '<div class="ag-turn-live" role="status"><span class="ag-turn-bar" aria-hidden="true"></span><span>' + t("agoraRender.nowLive", { text: e(liveText(group, sum)) }) + "</span></div>" : "") +
    (counts.length ? '<p class="ag-turn-counts">' + counts.join(" · ") + "</p>" : "") +
    '<ul class="ag-checklist" aria-label="' + e(t("agoraRender.stepsLabel")) + '">' + CHECK_STAGES.map(function (st) { return renderCheck(st, sum); }).join("") +
    '<li class="ag-check ag-check-link"><span class="ag-check-mark" aria-hidden="true">→</span><button type="button" class="ag-link" data-ag-tab="coaching">' + e(t("agoraRender.betterPromptLink")) + '</button></li></ul>' +
    '<button type="button" class="ag-turn-more" data-ag-detail="' + e(group.key) + '" aria-expanded="' + (detail ? "true" : "false") + '" aria-controls="' + detailId + '">' + e(t("agoraRender.detailCount", { count: group.entries.length })) + "</button>" +
    '<ol class="ag-timeline ag-turn-detail" id="' + detailId + '"' + (detail ? "" : " hidden") + ">" + group.entries.map(function (x) { return renderEntry(x, fmt); }).join("") + "</ol>";
  return '<li class="ag-turn' + (isLatest ? " is-latest" : "") + (open ? " is-open" : "") + (sum.running ? " is-running" : "") + '" data-turn="' + e(group.key) + '">' +
    head + '<div class="ag-turn-body" id="' + bodyId + '"' + (open ? "" : " hidden") + ">" + body + "</div></li>";
}

/**
 * One compact card per turn. `ui` = { open, detail, running }: per-turn disclosure the user chose (the newest turn
 * is open and older ones collapsed until then) and whether the session is known to be running (null = unknown).
 */
export function renderTimeline(entries, fmt, ui) {
  ui = { open: (ui && ui.open) || {}, detail: (ui && ui.detail) || {}, running: ui ? ui.running : null };
  var notice = '<p class="ag-notice">' + e(t("agoraRender.observableNotice")) + "</p>";
  var groups = groupTurns(entries);
  if (groups.length === 0) {
    return '<div class="ag-empty"><p class="ag-empty-title">' + e(t("agoraRender.timelineEmptyTitle")) + "</p>" +
      '<p class="ag-empty-body">' + e(t("agoraRender.timelineEmptyBody")) + "</p>" +
      '<ul class="ag-stage-legend">' + STAGES.map(function (s) {
        return "<li><strong>" + e(s.label) + "</strong><span>" + e(s.hint) + "</span></li>";
      }).join("") + "</ul></div>" + notice;
  }
  // Newest turn first: what is happening now is on top, the history folds below it.
  var cards = groups.map(function (g, i) { return renderTurn(g, i, i === groups.length - 1, ui, fmt); }).reverse();
  return '<ol class="ag-turns">' + cards.join("") + "</ol>" + notice;
}

export function renderExecution() {
  return '<section class="ag-orchestration-panel" aria-label="' + e(t("agoraRender.executionTitle")) + '">' +
    '<div class="ag-orchestration-panel-head"><h3>' + e(t("agoraRender.executionTitle")) + "</h3><span>" + e(t("agoraRender.executionSub")) + "</span></div>" +
    '<div id="ag-orchestration-runs"></div></section>';
}

export function renderMembers(room, onlineIds) {
  var members = (room && room.members) || [];
  if (members.length === 0) {
    return '<div class="ag-empty"><p class="ag-empty-title">' + e(t("agoraRender.membersEmptyTitle")) + "</p>" +
      '<p class="ag-empty-body">' + (room ? e(t("agoraRender.membersCount", { count: room.memberCount })) : "") + "</p></div>";
  }
  return '<ul class="ag-member-list">' + members.map(function (m) {
    var on = memberOnline(m, onlineIds);
    var presence = on === true ? e(t("agoraRender.online")) : on === false ? e(t("agoraRender.offline")) : "";
    return '<li class="ag-member"><span class="ag-avatar" aria-hidden="true">' + e(sealGlyph(m.name)) + "</span>" +
      '<span class="ag-member-name">' + e(m.name) + "</span>" +
      '<span class="ag-tag">' + e(ROLES[m.role]) + "</span>" +
      (presence ? '<span class="ag-presence' + (on ? " is-online" : "") + '"><span class="ag-presence-mark" aria-hidden="true"></span>' + presence + "</span>" : "") +
      "</li>";
  }).join("") + "</ul>";
}

export function renderVerification(entries) {
  var list = (entries || []).filter(function (x) { return x.stage === "verify"; });
  if (list.length === 0) {
    return '<div class="ag-empty"><p class="ag-empty-title">' + e(t("agoraRender.verifyEmptyTitle")) + "</p>" +
      '<p class="ag-empty-body">' + e(t("agoraRender.verifyEmptyBody")) + "</p></div>";
  }
  var sum = summarizeVerification(list);
  var rows = list.map(function (x) {
    return '<li class="ag-verify-row">' + statusBadge(x.status) +
      '<span class="ag-verify-text">' + segments(x.text) + "</span>" +
      '<span class="ag-evidence">' + e(t("agoraRender.evidenceColon")) + " " + (x.evidence ? "<code>" + e(x.evidence) + "</code>" : e(SOURCES[x.source])) + "</span></li>";
  }).join("");
  return '<div class="ag-verify-summary" role="group" aria-label="' + e(t("agoraRender.verifySummary")) + '">' +
    '<span class="ag-count is-pass"><b>' + sum.pass + "</b>" + e(t("agoraRender.verifyPass")) + "</span>" +
    '<span class="ag-count is-fail"><b>' + sum.fail + "</b>" + e(t("agoraRender.verifyFail")) + "</span>" +
    '<span class="ag-count is-not_run"><b>' + sum.notRun + "</b>" + e(t("agoraRender.verifyNotRun")) + "</span></div>" +
    (sum.fail > 0 ? '<p class="ag-alert" role="status">' + e(t("agoraRender.verifyAlert")) + "</p>" : "") +
    '<ul class="ag-verify-list">' + rows + "</ul>";
}

// Every agent the room can use, as read-only status. Agents are never started
// from here: a message that needs one is routed by the orchestrator and shows
// up as a run card in the conversation.
function renderHarnesses() {
  var chips = HARNESSES.map(function (h) {
    return '<li><span class="ag-harness">' + e(h.label) + '<span class="ag-harness-kind">' + e(t("agoraRender.harnessSession")) + '</span></span></li>';
  }).join("");
  return '<ul class="ag-harness-list" aria-label="' + e(t("agoraRender.harnessLabel")) + '">' + chips + "</ul>";
}

function renderAgentCard(agents) {
  var body;
  if (agents.total === 0) {
    body = '<p class="ag-agent-line">' + e(t("agoraRender.agentsNone")) + "</p>";
  } else {
    body = '<p class="ag-agent-line">' + t("agoraRender.agentsLine", { running: "<b>" + agents.running + "</b>", total: agents.total }) +
      (agents.unread ? t("agoraRender.agentsUnread", { count: agents.unread }) : "") + "</p>";
  }
  return '<section class="ag-agent-card" aria-label="' + e(t("agoraRender.agentStatus")) + '">' +
    '<h2 class="ag-panel-heading">' + e(t("agoraRender.agentStatus")) + "</h2>" + body + renderHarnesses() + "</section>";
}

/**
 * Whole right-hand panel. `view` = { room, agents, entries, onlineIds, tab,
 * formatTime }.
 */
export function renderContextPanel(view) {
  if (!view || !view.room) return "";
  var tab = CONTEXT_TABS.some(function (t) { return t.id === view.tab; }) ? view.tab : "timeline";
  var tabs = CONTEXT_TABS.map(function (t) {
    return '<button type="button" role="tab" class="ag-tab" id="ag-tab-' + t.id + '" data-ag-tab="' + t.id + '"' +
      ' aria-selected="' + (t.id === tab ? "true" : "false") + '" aria-controls="ag-tabpanel-' + t.id + '"' +
      (t.id === tab ? "" : ' tabindex="-1"') + ">" + e(t.label) + "</button>";
  }).join("");
  var panels = {
    timeline: renderTimeline(view.entries, view.formatTime, view.turnUi),
    coaching: renderCoachingTab(view.coaching, view.sessionId),
    execution: renderExecution(),
    members: renderMembers(view.room, view.onlineIds),
    verify: renderVerification(view.entries),
  };
  var panelHtml = CONTEXT_TABS.map(function (t) {
    return '<div role="tabpanel" class="ag-tabpanel" id="ag-tabpanel-' + t.id + '" aria-labelledby="ag-tab-' + t.id + '"' +
      (t.id === tab ? "" : " hidden") + ">" + panels[t.id] + "</div>";
  }).join("");
  return '<div class="ag-context-inner" lang="' + getLang() + '">' +
    '<div class="ag-context-head"><h2 class="ag-context-title">' + e(view.room.name) + "</h2>" +
    '<button type="button" class="ag-btn ag-icon-only ag-panel-collapse" data-ag-action="close-panel" aria-label="' + e(t("agoraRender.close")) + '" title="' + e(t("agoraRender.close")) + '">' + iconHtml("panel-right-close") + "</button></div>" +
    renderAgentCard(view.agents) +
    '<div class="ag-tabs" role="tablist" aria-label="' + e(t("agoraRender.roomInfo")) + '">' + tabs + "</div>" + panelHtml + "</div>";
}

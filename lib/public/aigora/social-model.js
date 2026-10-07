// social-model.js - Pure state and markup for Aigora room comments, pins and
// comment notifications. No DOM, no WebSocket: the controller (social.js)
// feeds it server messages and inserts the HTML strings it returns. Every
// dynamic value goes through escapeHtml.

import { escapeHtml } from "../modules/escape-html.js";
import { t, getLang, formatDate } from "./i18n.js";

var AVATAR_COLORS = ["#5e5ce6", "#30b0c7", "#ff9f0a", "#ff2d55", "#34c759", "#af52de", "#ff6482", "#0a84ff"];
var ICON_PIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6z"/></svg>';
var ICON_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A2.5 2.5 0 017.5 4H15"/></svg>';
var ICON_COMMENT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 01-11.6 7.1L3 21l1.9-6.2A8 8 0 1121 12z"/></svg>';
var ICON_COACH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18h6M10 21h4M12 3a6 6 0 00-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0012 3z"/></svg>';
var SHEET_ICONS = { copy: ICON_COPY, pin: ICON_PIN, comment: ICON_COMMENT, coach: ICON_COACH };
var ICON_KIND = {
  text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 6h14M5 12h14M5 18h9"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-8 9"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5"/></svg>',
};

export function anchorKey(mid, attachment) {
  return attachment == null ? mid : mid + "#a" + attachment;
}

function att(v) { return v == null ? null : v; }

export function createSocialState() {
  return {
    roomId: null, sessionId: null, comments: [], pins: [], notifs: [], unread: 0, approvals: [],
    prefs: { inApp: true, push: false, mentionsOnly: false },
    open: {}, drafts: {}, editing: null, editDraft: null,
  };
}

// Switching session clears the per-session parts until social_state arrives.
export function resetForSession(st, sessionId) {
  st.sessionId = sessionId == null ? null : sessionId;
  st.comments = [];
  st.open = {};
  st.editing = null;
}

function sameScope(st, msg) {
  return st.roomId != null && msg.roomId === st.roomId;
}

export function applySocialMessage(st, msg) {
  if (!msg || typeof msg.type !== "string") return false;
  switch (msg.type) {
    case "social_state":
      st.roomId = msg.roomId;
      st.sessionId = msg.sessionId;
      st.comments = Array.isArray(msg.comments) ? msg.comments.slice() : [];
      st.pins = Array.isArray(msg.pins) ? msg.pins.slice() : [];
      st.notifs = Array.isArray(msg.notifs) ? msg.notifs.slice().reverse() : [];
      st.unread = Number(msg.unread) || 0;
      if (msg.prefs) st.prefs = Object.assign({}, st.prefs, msg.prefs);
      return true;
    case "comment_event": {
      if (!sameScope(st, msg) || msg.sessionId !== st.sessionId || !msg.comment) return false;
      var c = msg.comment;
      var i = st.comments.findIndex(function (x) { return x.id === c.id; });
      if (msg.action === "add") {
        if (i >= 0) return false;
        st.comments.push(c);
        return true;
      }
      if (msg.action === "edit") {
        if (i >= 0) st.comments[i] = c; else st.comments.push(c);
        return true;
      }
      if (msg.action === "delete") {
        if (i < 0) return false;
        st.comments[i] = Object.assign({}, st.comments[i], { deleted: true, text: "" });
        return true;
      }
      return false;
    }
    case "pin_event": {
      if (!sameScope(st, msg) || !msg.pin) return false;
      var j = st.pins.findIndex(function (x) { return x.id === msg.pin.id; });
      if (msg.action === "add") {
        if (j >= 0) return false;
        st.pins.push(msg.pin);
        return true;
      }
      if (msg.action === "remove" && j >= 0) { st.pins.splice(j, 1); return true; }
      return false;
    }
    case "social_notif":
      if (!msg.notif) return false;
      if (!st.notifs.some(function (n) { return n.id === msg.notif.id; })) st.notifs.unshift(msg.notif);
      st.unread = Number(msg.unread) || 0;
      return true;
    case "notif_state": {
      var changed = false;
      if (msg.prefs) { st.prefs = Object.assign({}, st.prefs, msg.prefs); changed = true; }
      if (typeof msg.unread === "number") {
        st.unread = msg.unread;
        if (msg.unread === 0) st.notifs.forEach(function (n) { n.read = true; });
        changed = true;
      }
      return changed;
    }
    // Admin-only approval requests ride on the console's notification frames; everything else there is ignored.
    case "notifications_state":
      st.approvals = [];
      (Array.isArray(msg.notifications) ? msg.notifications : []).forEach(function (n) { addApproval(st, n); });
      return true;
    case "notification_created":
      return addApproval(st, msg.notification);
    case "notification_updated": {
      var u = msg.notification;
      if (!u || u.type !== "approval_request") return false;
      var k = st.approvals.findIndex(function (a) { return a.id === u.id; });
      if (k >= 0) st.approvals[k] = u; else addApproval(st, u);
      return true;
    }
    case "notification_dismissed": {
      var ids = Array.isArray(msg.ids) ? msg.ids : [];
      var before = st.approvals.length;
      st.approvals = st.approvals.filter(function (a) { return ids.indexOf(a.id) === -1; });
      return st.approvals.length !== before;
    }
    default:
      return false;
  }
}

// One item per request id, newest first; replay of the same frames never duplicates.
function addApproval(st, n) {
  if (!n || n.type !== "approval_request" || !n.meta) return false;
  var dup = st.approvals.some(function (a) { return a.id === n.id || (a.meta && a.meta.requestId === n.meta.requestId); });
  if (dup) return false;
  st.approvals.unshift(n);
  return true;
}

export function pendingApprovals(st) {
  return st.approvals.filter(function (a) { return !a.meta.status; });
}

// Comment unread count and pending approvals share one badge.
export function badgeCount(st) {
  return st.unread + pendingApprovals(st).length;
}

var APPROVAL_STATE = {
  get allow() { return t("social.approvalAllowed"); },
  get deny() { return t("social.approvalDenied"); },
  get cancelled() { return t("social.approvalCancelled"); },
};

export function approvalsHtml(st, view) {
  if (!st.approvals.length) return "";
  var items = st.approvals.map(function (a) {
    var m = a.meta, id = escapeHtml(m.requestId || "");
    var what = escapeHtml(m.requesterName || "") + " · " + escapeHtml(m.roomName || "") + ": <b>" + escapeHtml(m.toolName || "") + "</b>" + (m.summary ? " <code>" + escapeHtml(m.summary) + "</code>" : "") + (m.riskText ? ' <span class="ai-appr-risk">' + escapeHtml(m.riskText) + "</span>" : "");
    var tail;
    if (m.status) tail = '<span class="ai-appr-state ai-appr-' + escapeHtml(m.status) + '">' + APPROVAL_STATE[m.status] + "</span>";
    else if (view.isAdmin) {
      tail = '<span class="ai-appr-actions"><button type="button" class="perm-allow" data-approval-decision="allow" data-approval-id="' + id + '">' + t("social.allow") + "</button>" +
        '<button type="button" class="perm-deny" data-approval-decision="deny" data-approval-id="' + id + '">' + t("social.deny") + "</button></span>";
    } else tail = '<span class="ai-appr-state">' + t("social.approvalWaiting") + "</span>";
    return '<div class="ai-approval' + (m.status ? "" : " is-pending") + '" role="group" aria-label="' + escapeHtml(t("social.approvalRequestLabel", { tool: m.toolName || "" })) + '" data-approval="' + id + '">' +
      '<p><button type="button" class="ai-link" data-approval-open="' + id + '" data-session="' + escapeHtml(m.sessionId == null ? "" : m.sessionId) + '">' + what + "</button></p>" + tail + "</div>";
  }).join("");
  return '<h2>' + t("social.approvalHeading") + ' <span class="ai-count">' + t("social.pendingCount", { count: pendingApprovals(st).length }) + "</span></h2>" + items;
}

// Optimistic local update; the server's notif_state then confirms the count.
export function markNotifRead(st, ids) {
  var all = ids === "all";
  var wanted = Array.isArray(ids) ? ids : [];
  st.notifs.forEach(function (n) { if (all || wanted.indexOf(n.id) >= 0) n.read = true; });
  st.unread = st.notifs.filter(function (n) { return !n.read; }).length;
}

export function commentsFor(st, mid, attachment) {
  return st.comments.filter(function (c) { return c.mid === mid && att(c.attachment) === att(attachment) && !c.deleted; });
}

export function commentCount(st, mid, attachment) {
  return commentsFor(st, mid, attachment).length;
}

export function pinFor(st, mid, attachment, kind) {
  for (var i = 0; i < st.pins.length; i++) {
    var p = st.pins[i];
    if (p.mid === mid && att(p.attachment) === att(attachment) && p.kind === kind) return p;
  }
  return null;
}

export function timeAgo(ts, now) {
  var d = Math.max(0, (now == null ? Date.now() : now) - ts);
  if (d < 60000) return t("format.justNow");
  var rtf = new Intl.RelativeTimeFormat(getLang(), { numeric: "always", style: "long" });
  if (d < 3600000) return rtf.format(-Math.floor(d / 60000), "minute");
  if (d < 86400000) return rtf.format(-Math.floor(d / 3600000), "hour");
  return formatDate(ts, { month: "short", day: "numeric" });
}

function colorFor(id) {
  var h = 0;
  String(id || "").split("").forEach(function (ch) { h = (h * 31 + ch.charCodeAt(0)) >>> 0; });
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function initial(name) {
  return escapeHtml(String(name || "?").trim().charAt(0) || "?");
}

function commentBody(text) {
  return escapeHtml(text).replace(/@[^\s&<]+/g, function (m) { return '<span class="ai-at">' + m + "</span>"; });
}

function dataAtt(a) { return a == null ? "" : ' data-att="' + escapeHtml(a) + '"'; }

function commentButton(st, mid, a) {
  var n = commentCount(st, mid, a);
  var key = anchorKey(mid, a);
  return '<button type="button" class="ai-act ai-act-comment' + (n ? " has" : "") + '" data-social-comment="' + escapeHtml(mid) + '"' + dataAtt(a) +
    ' aria-expanded="' + (st.open[key] ? "true" : "false") + '" aria-label="' + t("social.comment") + '" title="' + t("social.comment") + '">' + ICON_COMMENT + "</button>";
}

function copyButton(item) {
  if (typeof item.text !== "string" || !item.text) return "";
  return '<button type="button" class="ai-act ai-act-copy" data-social-copy="' + escapeHtml(item.mid) + '" aria-label="' + t("social.copy") + '" title="' + t("social.copy") + '">' + ICON_COPY + "</button>";
}

// The 지시 코칭 icon of a user message; `coach` is { mid, open, low } from coaching.js. A dot marks "worth a look".
function coachButton(coach) {
  if (!coach) return "";
  var label = coach.low ? t("social.coachLow") : t("social.coach");
  return '<button type="button" class="ai-act ai-act-coach' + (coach.low ? " is-low" : "") + '" data-coach-chip="' + escapeHtml(coach.mid) + '" aria-expanded="' + (coach.open ? "true" : "false") +
    '" aria-controls="coach-chip-' + escapeHtml(coach.mid) + '" aria-label="' + label + '" title="' + label + '">' + ICON_COACH + (coach.low ? '<i class="ai-dot-low" aria-hidden="true"></i>' : "") + "</button>";
}

function pinButton(st, mid, a, kind, title, view) {
  var pin = pinFor(st, mid, a, kind);
  if (!pin && !view.canWrite) return "";
  return '<button type="button" class="ai-act ai-act-pin' + (pin ? " on" : "") + '" data-social-pin="' + escapeHtml(mid) + '"' + dataAtt(a) +
    ' data-kind="' + kind + '" data-title="' + escapeHtml(title) + '" aria-pressed="' + (pin ? "true" : "false") + '"' +
    (pin ? ' data-pin-id="' + escapeHtml(pin.id) + '"' : "") + ' aria-label="' + (pin ? t("social.unpin") : t("social.pin")) + '"' +
    ' title="' + (pin ? t("social.unpin") : t("social.pin")) + '"' + (!view.canWrite ? " disabled" : "") + ">" + ICON_PIN + "</button>";
}

function oneComment(st, c, view) {
  if (st.editing === c.id) {
    return '<div class="ai-c"><span class="ai-av" style="background:' + colorFor(c.authorId) + '">' + initial(c.authorName) + '</span><div class="ai-c-main">' +
      '<form class="ai-reply" data-social-edit-form="' + escapeHtml(c.id) + '"><input type="text" maxlength="2000" value="' + escapeHtml(st.editDraft != null ? st.editDraft : c.text) + '" aria-label="' + t("social.editComment") + '">' +
      '<button type="submit" class="ai-reply-send" aria-label="' + t("social.save") + '">✓</button><button type="button" class="ai-reply-cancel" data-social-edit-cancel="1" aria-label="' + t("social.cancel") + '">×</button></form></div></div>';
  }
  var mine = c.authorId === view.myId;
  var acts = "";
  if (view.canWrite && mine) acts += '<button type="button" class="ai-c-act" data-social-edit="' + escapeHtml(c.id) + '">' + t("social.edit") + "</button>";
  if (view.canWrite && (mine || view.isOwner)) acts += '<button type="button" class="ai-c-act" data-social-delete="' + escapeHtml(c.id) + '">' + t("social.delete") + "</button>";
  return '<div class="ai-c"><span class="ai-av" style="background:' + colorFor(c.authorId) + '">' + initial(c.authorName) + '</span><div class="ai-c-main">' +
    '<div class="ai-c-top"><b>' + escapeHtml(c.authorName || t("social.unknownAuthor")) + (mine ? " " + t("social.meSuffix") : "") + "</b><span>" + timeAgo(c.ts, view.now) +
    (c.editedTs ? " · " + t("social.edited") : "") + "</span>" + acts + "</div><p>" + commentBody(c.text) + "</p></div></div>";
}

export function panelHtml(st, item, view, attachment) {
  var a = att(attachment);
  var key = anchorKey(item.mid, a);
  var list = commentsFor(st, item.mid, a).map(function (c) { return oneComment(st, c, view); }).join("");
  var form = view.canWrite
    ? '<form class="ai-reply" data-social-form="' + escapeHtml(item.mid) + '"' + dataAtt(a) + '><input type="text" maxlength="2000" autocomplete="off" placeholder="' + t("social.commentPlaceholder") + '" aria-label="' + t("social.commentInput") + '" value="' +
      escapeHtml(st.drafts[key] || "") + '"><button type="submit" class="ai-reply-send" aria-label="' + t("social.commentSend") + '"' + (st.drafts[key] ? "" : " disabled") + ">↑</button></form>"
    : "";
  return '<div class="ai-thread" data-thread-key="' + escapeHtml(key) + '"><p class="ai-thread-note">' + t("social.threadNote") + '</p>' + list + form + "</div>";
}

function pinTitle(item, index) {
  var txt = String(item.text || "").replace(/\s+/g, " ").trim();
  if (index != null) return t("social.imageN", { n: index + 1 }) + (item.name ? " · " + item.name : "");
  return txt.length > 60 ? txt.slice(0, 60) + "…" : txt || t("social.message");
}

export function metaHtml(st, item, view) {
  if (!item || !item.mid) return "";
  // Icon row inside the message's box: [복사][고정][지시 코칭] on the message's own side, 댓글 at the opposite end (mirrored under
  // the author's right-aligned bubbles by CSS). The row hides until hover/focus (CSS); the indicators stay: pin mark, 댓글 N, coaching dot.
  var coach = view.coach ? view.coach(item) : null;
  var n = commentCount(st, item.mid, null);
  var pinned = !!pinFor(st, item.mid, null, "text");
  var ind = (pinned ? '<span class="ai-ind-pin" role="img" aria-label="' + t("social.pinned") + '" title="' + t("social.pinned") + '">' + ICON_PIN + "</span>" : "") +
    (n ? '<button type="button" class="ai-ind-comment" data-social-comment="' + escapeHtml(item.mid) + '" aria-expanded="' + (st.open[anchorKey(item.mid, null)] ? "true" : "false") + '">' + t("social.comment") + ' <span class="n">' + n + "</span></button>" : "") +
    (coach && coach.low ? '<span class="ai-coach-legend"><span class="ai-ind-low" aria-hidden="true"></span>' + escapeHtml(t("social.coachLegend")) + '</span>' : "");
  var out = '<div class="ai-meta" data-meta="' + escapeHtml(item.mid) + '"><div class="ai-meta-ind">' + ind + '</div><div class="ai-meta-acts" role="group" aria-label="' + t("social.messageActions") + '"><div class="ai-meta-main">' +
    copyButton(item) + pinButton(st, item.mid, null, "text", pinTitle(item), view) + coachButton(coach) + "</div>" + commentButton(st, item.mid, null) + "</div></div>";
  if (st.open[anchorKey(item.mid, null)]) out += panelHtml(st, item, view, null);
  if (item.role === "user" && item.images > 0) {
    for (var i = 0; i < item.images; i++) {
      out += '<div class="ai-meta ai-meta-img"><span class="ai-meta-label">' + ICON_KIND.image + t("social.imageN", { n: i + 1 }) + "</span>" +
        pinButton(st, item.mid, i, "image", pinTitle(item, i), view) + commentButton(st, item.mid, i) + "</div>";
      if (st.open[anchorKey(item.mid, i)]) out += panelHtml(st, item, view, i);
    }
  }
  return out;
}

// The phone's long-press sheet. actions: [{ key: "copy" | "pin" | "comment" | "coach", label }]
export function actionSheetHtml(actions) {
  return '<div class="att-sheet-scrim" data-msg-sheet-close></div><div class="att-sheet msg-sheet" role="dialog" aria-modal="true" aria-label="' + t("social.messageActions") + '">' +
    actions.map(function (a) {
      return '<button type="button" class="att-btn msg-sheet-item" data-msg-sheet-do="' + a.key + '">' + (SHEET_ICONS[a.key] || "") + "<span>" + escapeHtml(a.label) + "</span></button>";
    }).join("") + "</div>";
}

export function pinPopHtml(st, view) {
  var body = st.pins.length
    ? st.pins.map(function (p) {
      var canUnpin = p.pinnedBy === view.myId || view.isOwner;
      return '<div class="ai-pin-i" data-social-goto="' + escapeHtml(p.mid) + '" data-session="' + escapeHtml(p.sessionLocalId == null ? "" : p.sessionLocalId) + '"' + dataAtt(p.attachment) + ' tabindex="0" role="button">' +
        '<span class="ai-pin-k">' + (ICON_KIND[p.kind] || ICON_KIND.text) + '</span><span class="ai-pin-t"><b>' + escapeHtml(p.title) + "</b><small>" +
        t("social.pinnedBy", { name: escapeHtml(p.pinnedByName || "") }) + "</small></span>" +
        (canUnpin ? '<button type="button" class="ai-pin-x" data-social-unpin="' + escapeHtml(p.id) + '">' + t("social.unpinShort") + "</button>" : "") + "</div>";
    }).join("")
    : '<p class="ai-empty-pop">' + t("social.pinsEmpty") + "</p>";
  return '<h2>' + t("social.pinsHeading") + (st.pins.length ? ' <span class="ai-count">' + t("social.itemCount", { count: st.pins.length }) + "</span>" : "") + "</h2>" + body;
}

function actorB(n) { return "<b>" + escapeHtml(n.actorName || t("social.someone")) + "</b>"; }

var NOTIF_TEXT = {
  mention: function (n) { return t("social.notifMention", { name: actorB(n) }); },
  reply: function (n) { return t("social.notifReply", { name: actorB(n) }); },
  comment: function (n) { return t("social.notifComment", { name: actorB(n) }); },
};

function prefSwitch(st, key, label) {
  return '<div class="ai-pref-row"><span>' + label + '</span><button type="button" class="ai-sw" role="switch" data-pref="' + key +
    '" aria-checked="' + (st.prefs[key] ? "true" : "false") + '" aria-label="' + label + '"></button></div>';
}

export function notifPopHtml(st, view) {
  var list = st.notifs.length
    ? st.notifs.map(function (n) {
      return '<button type="button" data-social-notif="' + escapeHtml(n.id) + '" data-mid="' + escapeHtml(n.mid || "") + '" data-session="' + escapeHtml(n.sessionLocalId == null ? "" : n.sessionLocalId) + '"' + dataAtt(n.attachment) +
        ' class="ai-notif' + (n.read ? "" : " is-unread") + '"><i></i><span><p>' + (NOTIF_TEXT[n.kind] || NOTIF_TEXT.comment)(n) +
        "</p><small>" + (n.roomName ? escapeHtml(n.roomName) + " · " : "") + escapeHtml(n.preview || "") + " · " + timeAgo(n.ts, view.now) + "</small></span></button>";
    }).join("")
    : '<p class="ai-empty-pop">' + t("social.notifsEmpty") + "</p>";
  return approvalsHtml(st, view) + '<h2>' + t("social.notifHeading") + '<button type="button" class="ai-link" data-social-readall="1"' + (st.unread ? "" : " disabled") + ">" + t("social.readAll") + "</button></h2>" + list +
    '<div class="ai-prefs" aria-label="' + t("social.prefsLabel") + '">' + prefSwitch(st, "inApp", t("social.prefInApp")) + prefSwitch(st, "push", t("social.prefPush")) + prefSwitch(st, "mentionsOnly", t("social.prefMentionsOnly")) + "</div>";
}

// private-channels.js - thin DOM/controller layer for personal channels.
import { t, onLangChange, formatRelativeTime } from "./i18n.js";
import {
  privacyNotice, adminReadOnlyNotice, isPrivateExecutionNotice,
  channelRefusedNotice, nameInvalidNotice, CHANNEL_NAME_MAX, noSessionsLabel, createPrivateState, applyPrivateMessage,
  derivePrivateView, privateSessionAccess, friendlyPrivateError, ownChannelState,
} from "./private-channels-model.js";
import { dateLabel, limitSessions } from "./session-layouts-model.js";
import { groupSessions, groupOpenState, setGroupOpenState } from "./session-groups.js";

// The stand-in row of a session that is being created (never sent to the server, never clickable).
var PENDING_ID = "pending-new";
function newSessionTitle() { return t("privateChannels.newSession"); }
var CREATE_TIMEOUT_MS = 10000;
function createFailed() { return t("privateChannels.createFailed"); }

function e(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function stateLabel(v) { return v === "active" ? t("privateChannels.stateActive") : t("privateChannels.stateClosed"); }

function ownSection(view, rowMenu) {
  var status = "";
  if (view.offline) status = t("privateChannels.statusOffline");
  else if (view.pendingCreate && !view.optimistic) status = t("privateChannels.statusPreparing");
  else if (view.refused) status = view.refused;
  else if (view.closed) status = t("privateChannels.statusClosed");
  else if (view.loading) status = t("privateChannels.statusLoading");
  var actions = "";
  if (view.canCreate && !view.pendingCreate) actions += '<button type="button" class="ai-private-new" data-private-new aria-label="' + e(t("privateChannels.startSession")) + '">+</button>';
  // 채널 닫기 is irreversible: it lives in the channel's "⋯" menu (with a confirmation), not as a button that reads like a back link.
  if (view.channelId && rowMenu) actions += rowMenu("channel", view.channelId);
  var list = view.ownSessions.length ? '<ul class="ai-private-list">' + view.ownSessions.map(function (s) {
    var more = rowMenu ? rowMenu("session", s.id) : "";
    return '<li' + (more ? ' class="ag-has-menu"' : "") + '><button type="button" class="ai-private-session" data-private-session="' + e(s.id) + '"' +
      (s.active ? ' aria-current="true"' : "") + ' aria-label="' + e(t("privateChannels.openSession", { title: s.title })) + '">' +
      '<span class="ai-private-title">' + e(s.title) + '</span><span class="ai-private-meta">' +
      e(t("privateChannels.recentActivity", { when: s.lastActivityLabel })) + '</span></button>' + more + '</li>';
  }).join("") + "</ul>" : '<p class="ai-private-empty">' + e(view.emptyText) + "</p>";
  return '<section class="ai-private-own" aria-label="' + e(t("privateChannels.ownChannel")) + '"><div class="ai-private-head"><h2>' + e(t("privateChannels.ownChannel")) + '</h2>' +
    '<div class="ai-private-actions">' + actions + '</div></div><p class="ai-private-privacy">' + e(privacyNotice()) +
    "</p>" + (status ? '<p class="ai-private-status" role="status">' + e(status) + "</p>" : "") + list + "</section>";
}

function adminSection(view) {
  if (!view.adminVisible) return "";
  var content = view.adminChannels.length ? view.adminChannels.map(function (c) {
    var list = c.sessions.length ? '<ul class="ai-private-list">' + c.sessions.map(function (s) {
      return '<li><button type="button" class="ai-private-session is-admin" data-private-admin-session="' + e(s.id) +
        '" aria-label="' + e(t("privateChannels.readSession", { owner: c.ownerName, title: s.title })) + '"><span class="ai-private-title">' +
        e(s.title) + '</span><span class="ai-private-meta">' + e(t("privateChannels.readOnly")) + '</span></button></li>';
    }).join("") + "</ul>" : '<p class="ai-private-empty">' + e(t("privateChannels.noReadable")) + "</p>";
    return '<div class="ai-private-person"><div class="ai-private-person-head"><strong>' + e(c.label) +
      '</strong><span>' + e(stateLabel(c.state)) + "</span></div>" + list + "</div>";
  }).join("") : '<p class="ai-private-empty">' + e(t("privateChannels.noMemberChannels")) + "</p>";
  return '<section class="ai-private-admin" aria-label="' + e(t("privateChannels.adminAria")) + '"><h2>' + e(t("privateChannels.adminHeading")) + "</h2>" +
    content + "</section>";
}

// `rowMenu(kind, id)` is optional extra markup (a "⋯" trigger) after each of the
// viewer's own sessions; the read-only administrator list never gets one.
export function privateRailHtml(view, rowMenu) {
  if (!view || !view.roomId) return "";
  return ownSection(view, rowMenu) + adminSection(view);
}

// --- Session surfaces of the three 세션 표시 방식 ----------------------------------------
// One viewer, three renderings of the same sessions: the sidebar tree under the selected
// room (every layout; layout B also nests the session rows there), the C list column and
// the A title menu. `ctx` = { layout, privateActive, adminOpen, showAll, now }.
// Buttons carry data-private-* attributes; initPrivateChannels() owns the clicks.

var SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
var ICON = {
  lock: SVG + '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  people: SVG + '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/></svg>',
  plus: SVG + '<path d="M12 5v14M5 12h14"/></svg>',
  check: SVG + '<path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  caret: SVG + '<path d="M9 6l6 6-6 6"/></svg>',
};

function disc(key, open, inner) {
  return '<div class="ag-disc" data-disc="' + e(key) + '" data-open="' + (open ? "true" : "false") + '"' + (open ? "" : ' aria-hidden="true" inert') + '><div>' + inner + "</div></div>";
}

function sessionDate(s, ctx) { return dateLabel(s.lastActivity, ctx && ctx.now); }

// --- Similar sessions of the channel, grouped (presentation only; see session-groups.js) ---------------------------
// One collapsible head per group ("보고서 · 3") with the sessions' own rows inside; singletons stay plain rows.
// kind: "tree" (sidebar, layout B) | "col" (list column) | "phone". rowOf(s) draws one session's row.
function groupOpenNow(view, ctx, g) {
  var hasActive = g.sessions.some(function (s) { return s.active; });
  return ctx && ctx.groupOpen ? ctx.groupOpen(view.channelId, g.key, hasActive) : hasActive;
}
function unitsHtml(kind, view, ctx, sessions, rowOf) {
  return groupSessions(sessions).map(function (u) {
    if (u.type === "session") return rowOf(u.session);
    var open = groupOpenNow(view, ctx, u);
    var rows = u.sessions.map(rowOf).join("");
    var head = '<button type="button" class="' + (kind === "tree" ? "ai-tree-row" : kind === "phone" ? "ai-pl-row" : "ai-col-row") + ' ai-sgroup-head" data-private-group="' + e(u.key) +
      '" aria-expanded="' + (open ? "true" : "false") + '" aria-label="' + e(t("privateChannels.groupAria", { label: u.label, count: u.count })) + '">' +
      '<span class="ai-sgroup-caret" aria-hidden="true">' + ICON.caret + '</span><span class="ai-sgroup-label">' + e(u.label) + '</span><span class="ai-sgroup-count">' + u.count + "</span></button>";
    var key = "g:" + view.channelId + ":" + u.key;
    if (kind === "tree") return '<div class="ai-sgroup">' + head + disc(key, open, '<div class="ai-tree-sub ai-sgroup-body">' + rows + "</div>") + "</div>";
    return '<li class="ai-sgroup">' + head + disc(key, open, '<ul class="ai-sgroup-list">' + rows + "</ul>") + "</li>";
  }).join("");
}

function statusText(view) {
  var status = "";
  if (view.offline) status = t("privateChannels.statusOffline");
  else if (view.pendingCreate && !view.optimistic) status = t("privateChannels.statusPreparing");
  else if (view.refused) status = view.refused;
  else if (view.closed) status = t("privateChannels.statusClosed");
  else if (view.loading) status = t("privateChannels.statusLoading");
  return status ? '<p class="ai-private-status" role="status">' + e(status) + "</p>" : "";
}
function closeButton() { return ""; }   // moved into the channel's "⋯" menu (row-menus.js, action "close")
function statusLine(view) { return statusText(view) + closeButton(view); }

// --- 조원 채널 for administrators: one disclosure folder per member ------------------------------
// Each folder row = avatar + nickname + channel name ("<닉네임>의 채널" unless renamed) + a session count
// ("세션 없음" when empty); expanding it lists that member's sessions, read only. Members come most
// recently active first (the model sorts). Shared by the tree (every layout), the C column and the A menu.
function initial(name) { var c = Array.from(String(name == null ? "" : name).trim())[0]; return c || "?"; }
function avatar(name) { return '<span class="ai-avatar" aria-hidden="true">' + e(initial(name)) + "</span>"; }

function folderOpen(c, ctx) {
  if (ctx.openFolders && ctx.openFolders[c.ownerName]) return true;
  return ctx.activeAdminId != null && c.sessions.some(function (s) { return String(s.id) === String(ctx.activeAdminId); });
}

// kind: "tree" | "col" | "pop" picks the row classes of the surface.
function adminFolders(view, ctx, kind) {
  if (!view.adminChannels.length) return '<p class="ai-private-empty">' + e(t("privateChannels.noMemberChannels")) + "</p>";
  var activeId = ctx.activeAdminId == null ? null : String(ctx.activeAdminId);
  return view.adminChannels.map(function (c) {
    var open = folderOpen(c, ctx);
    var count = c.sessions.length ? String(c.sessions.length) : noSessionsLabel();
    var head = '<button type="button" class="ai-folder ai-folder-' + kind + '" data-private-folder="' + e(c.ownerName) + '" aria-expanded="' + (open ? "true" : "false") + '"' +
      (kind === "pop" ? ' role="menuitem"' : "") + ' title="' + e(c.label) + '" aria-label="' + e(c.label + ", " + c.countLabel) + '">' +
      '<span class="ai-folder-caret" aria-hidden="true">' + ICON.caret + "</span>" + avatar(c.ownerName) +
      '<span class="ai-folder-name"><strong>' + e(c.ownerName) + "</strong>" + (c.channelTitle ? "<small>" + e(c.channelTitle) + "</small>" : "") + "</span>" +
      '<span class="ai-folder-count' + (c.sessions.length ? "" : " is-empty") + '">' + e(count) + "</span></button>";
    var rows = c.sessions.length ? c.sessions.map(function (s) {
      var aria = ' aria-label="' + e(t("privateChannels.readSession", { owner: c.ownerName, title: s.title })) + '"';
      var cur = activeId === String(s.id) ? ' aria-current="true"' : "";
      if (kind === "col") {
        return '<button type="button" class="ai-col-row" data-private-admin-session="' + e(s.id) + '"' + cur + aria + '><span class="ai-col-title">' + e(s.title) +
          '</span><span class="ai-col-date">' + (s.lastActivity ? e(dateLabel(s.lastActivity, ctx.now)) + " · " : "") + e(t("privateChannels.readOnly")) + "</span></button>";
      }
      if (kind === "pop") {
        return '<button type="button" role="menuitem" class="ai-pop-row" data-private-admin-session="' + e(s.id) + '"' + cur + aria + '><span class="ai-pop-title">' + e(s.title) +
          '</span><span class="ai-col-date">' + e(t("privateChannels.readOnly")) + '</span></button>';
      }
      return '<button type="button" class="ai-tree-row ai-tree-leaf" data-private-admin-session="' + e(s.id) + '"' + cur + aria + '><span class="ai-tree-text">' + e(s.title) + "</span></button>";
    }).join("") : '<p class="ai-private-empty">' + noSessionsLabel() + "</p>";
    return '<div class="ai-folder-group">' + head + disc("folder:" + view.roomId + ":" + c.ownerName, open, '<div class="ai-folder-sub">' + rows + "</div>") + "</div>";
  }).join("");
}

// The children of the selected room in the sidebar: 나만의 채널, and for administrators 조원 채널 (read only).
// The room's own feed opens from the room row itself.
export function treeChildrenHtml(view, ctx) {
  if (!view || !view.roomId) return "";
  ctx = ctx || {};
  var layoutB = ctx.layout === "B";
  var count = view.ownSessions.length;
  var out = "";
  var ownRow = '<button type="button" class="ai-tree-row" data-private-open' +
    (ctx.privateActive && !layoutB && !ctx.adminActive ? ' aria-current="true"' : "") +
    (layoutB ? ' aria-expanded="' + (ctx.privateActive && !ctx.adminActive ? "true" : "false") + '"' : "") + ' title="' + e(view.channelLabel) + '">' +
    ICON.lock + '<span class="ai-tree-text">' + e(view.channelLabel) + "</span>" + (count ? '<span class="ai-tree-count">' + count + "</span>" : "") + "</button>";
  var ownMore = ctx.rowMenu && view.channelId ? ctx.rowMenu("channel", view.channelId) : "";
  out += ownMore ? '<div class="ag-has-menu ai-tree-own">' + ownRow + ownMore + "</div>" : ownRow;
  if (layoutB) {
    var lim = limitSessions(view.ownSessions, ctx.showAll);
    var rows = unitsHtml("tree", view, ctx, lim.shown, function (s) {
      var more = ctx.rowMenu ? ctx.rowMenu("session", s.id) : "";
      var leaf = '<button type="button" class="ai-tree-row ai-tree-leaf" data-private-session="' + e(s.id) + '"' + (s.active ? ' aria-current="true"' : "") +
        ' aria-label="' + e(t("privateChannels.openSession", { title: s.title })) + '"><span class="ai-tree-dot" aria-hidden="true"></span><span class="ai-tree-text">' + e(s.title) + "</span></button>";
      return more ? '<div class="ag-has-menu ai-tree-own">' + leaf + more + "</div>" : leaf;
    });
    if (lim.hidden) rows += '<button type="button" class="ai-tree-row ai-tree-leaf ai-tree-more" data-private-more>' + e(t("privateChannels.seeMore", { count: lim.hidden })) + "</button>";
    if (view.canCreate && !view.pendingCreate) rows += '<button type="button" class="ai-tree-row ai-tree-leaf ai-tree-new" data-private-new aria-label="' + e(t("privateChannels.startSession")) + '">' + ICON.plus + '<span class="ai-tree-text">' + e(t("privateChannels.newSession")) + '</span></button>';
    rows += statusLine(view);
    out += disc("b:" + view.roomId, !!ctx.privateActive && !ctx.adminActive, '<div class="ai-tree-sub">' + rows + "</div>");
  }
  if (view.adminVisible) {
    out += '<button type="button" class="ai-tree-row ai-tree-admin" data-private-admin-toggle aria-expanded="' + (ctx.adminOpen ? "true" : "false") + '">' +
      ICON.people + '<span class="ai-tree-text">' + e(t("privateChannels.memberChannels")) + '</span><span class="ai-tree-count">' + e(t("privateChannels.readOnly")) + '</span></button>';
    out += disc("admin:" + view.roomId, !!ctx.adminOpen, '<div class="ai-tree-sub">' + adminFolders(view, ctx, "tree") + "</div>");
  }
  return '<div class="ai-tree">' + out + "</div>";
}

// Layout C: the 232px column between the sidebar and the thread.
export function columnHtml(view, ctx, rowMenu) {
  if (!view || !view.roomId) return "";
  var list = view.ownSessions.length ? '<ul class="ai-col-list">' + unitsHtml("col", view, ctx, view.ownSessions, function (s) {
    var more = rowMenu ? rowMenu("session", s.id) : "";
    return '<li' + (more ? ' class="ag-has-menu"' : "") + '><button type="button" class="ai-col-row" data-private-session="' + e(s.id) + '"' +
      (s.active ? ' aria-current="true"' : "") + ' aria-label="' + e(t("privateChannels.openSession", { title: s.title })) + '">' +
      '<span class="ai-col-title">' + e(s.title) + '</span><span class="ai-col-date">' + e(sessionDate(s, ctx)) + "</span></button>" + more + "</li>";
  }) + "</ul>" : '<p class="ai-private-empty">' + e(view.emptyText) + "</p>";
  var plus = view.canCreate && !view.pendingCreate
    ? '<button type="button" class="ai-col-new" data-private-new aria-label="' + e(t("privateChannels.newSession")) + '">' + ICON.plus + "</button>" : "";
  var chMore = view.channelId && rowMenu ? rowMenu("channel", view.channelId) : "";
  var admin = view.adminVisible
    ? '<div class="ai-col-admin"><div class="ai-col-sub">' + e(t("privateChannels.memberChannelsReadOnly")) + '</div>' + adminFolders(view, ctx || {}, "col") + "</div>" : "";
  return '<div class="ai-col-inner"><div class="ai-col-head"><strong title="' + e(view.channelLabel) + '">' + e(view.channelLabel) + '</strong><span class="ai-col-tools">' + chMore + plus + "</span></div>" + list + statusLine(view) + admin + "</div>";
}

// Layout A: the popover under the title "나만의 채널 · <세션> ⌄".
export function menuHtml(view, ctx, rowMenu) {
  if (!view || !view.roomId) return "";
  var rows = view.ownSessions.map(function (s) {
    var more = rowMenu ? rowMenu("session", s.id) : "";
    var row = '<button type="button" role="menuitem" class="ai-pop-row" data-private-session="' + e(s.id) + '"' + (s.active ? ' aria-current="true"' : "") + ">" +
      '<span class="ai-pop-check">' + (s.active ? ICON.check : "") + '</span><span class="ai-pop-title">' + e(s.title) +
      '</span><span class="ai-col-date">' + e(sessionDate(s, ctx)) + "</span></button>";
    return more ? '<div class="ag-has-menu ai-pop-line" role="none">' + row + more + "</div>" : row;
  }).join("");
  var plus = view.canCreate && !view.pendingCreate
    ? '<button type="button" role="menuitem" class="ai-pop-row ai-pop-new" data-private-new>' + ICON.plus + '<span>' + e(t("privateChannels.newSession")) + '</span></button>' +
      '<div class="ai-pop-sep" role="separator"></div>' : "";
  var admin = view.adminVisible
    ? '<div class="ai-pop-sep" role="separator"></div><div class="ai-col-sub">' + e(t("privateChannels.memberChannelsReadOnly")) + '</div>' + adminFolders(view, ctx || {}, "pop") : "";
  return plus + (rows || '<p class="ai-private-empty">' + e(view.emptyText) + "</p>") + statusLine(view) + admin;
}

// --- Phone (<=768px): the 채널 tab's context list in the sidebar (aigora/phone-nav.js owns the sidebar) ----------
// The viewer's own sessions (name + date, "⋯" menu), and for administrators the 조원 채널 folders (read only).
// Rows carry the same data-private-* attributes as the desktop surfaces; initPrivateChannels() owns the clicks.
export function phoneListHtml(view, ctx, rowMenu) {
  if (!view || !view.roomId) return "";
  ctx = ctx || {};
  var rows = unitsHtml("phone", view, ctx, view.ownSessions, function (s) {
    var more = rowMenu ? rowMenu("session", s.id) : "";
    return "<li" + (more ? ' class="ag-has-menu"' : "") + '><button type="button" class="ai-pl-row" data-private-session="' + e(s.id) + '"' + (s.active ? ' aria-current="true"' : "") +
      ' aria-label="' + e(t("privateChannels.openSession", { title: s.title })) + '"><span class="ai-pl-main"><span class="ai-pl-title">' + e(s.title) + '</span><span class="ai-pl-date">' + e(sessionDate(s, ctx)) + "</span></span></button>" + more + "</li>";
  });
  var chMore = view.channelId && rowMenu ? rowMenu("channel", view.channelId) : "";
  var out = '<div class="ai-ps-subhead"><h3 class="ai-ps-sub" title="' + e(view.channelLabel) + '">' + e(view.channelLabel) + "</h3>" + chMore + "</div>" + statusText(view);
  out += rows ? '<ul class="ai-pl-list">' + rows + "</ul>" : '<p class="ai-private-empty">' + e(view.emptyText) + "</p>";
  out += closeButton(view);
  if (view.adminVisible) out += '<h3 class="ai-ps-sub">' + e(t("privateChannels.memberChannelsReadOnly")) + '</h3><div class="ai-ps-folders">' + adminFolders(view, ctx, "tree") + "</div>";
  return out;
}

export function initPrivateChannels(deps) {
  var state = createPrivateState();
  var connected = false, pendingCreate = false, pendingClose = false;
  var pendingOwnRoom = null;
  var privateSessionRequested = false;
  var executionNotice = "", closeOpener = null;
  // 세션 표시 방식 state: which of A/B/C draws the sessions, the A title menu, the B "더 보기",
  // the 조원 채널 disclosure.
  var layout = "C", menuOpen = false, showAll = false, adminOpen = false;
  var openFolders = {};   // 조원 채널 folders the administrator opened, by nickname
  var lastHtml = { tree: "", col: "", pop: "", phone: "" };
  // 새 세션 is shown at once: a "새 세션" row (active) and an empty feed appear while the server creates the session;
  // the real session replaces them when it arrives, a failure takes them away again (failCreate).
  var optimistic = false, createTimer = null;
  function menuFor(kind, id) { return id === PENDING_ID || !deps.rowMenu ? "" : deps.rowMenu(kind, id); }

  function room() { return deps.getRoom ? deps.getRoom() : null; }
  function roomId() { var r = room(); return r && r.id != null ? String(r.id) : null; }
  function sessions() { return deps.getSessions ? deps.getSessions() || [] : []; }
  function activeSession() {
    var id = deps.getActiveSessionId ? deps.getActiveSessionId() : null, found = null;
    sessions().forEach(function (s) { if (s && s.id === id) found = s; });
    return found;
  }
  function access() {
    var s = activeSession();
    var channelState = s && s.roomId != null ? ownChannelState(state, String(s.roomId), s.channelId) : null;
    return privateSessionAccess(s, deps.getMyId ? deps.getMyId() : null, channelState);
  }
  function view() {
    var v = derivePrivateView(state, {
      roomId: roomId(), sessions: sessions(), myUserId: deps.getMyId ? deps.getMyId() : null,
      activeSessionId: deps.getActiveSessionId ? deps.getActiveSessionId() : null, connected: connected,
    });
    v.pendingCreate = pendingCreate;
    v.pendingClose = pendingClose;
    v.optimistic = optimistic && !!v.roomId;
    if (v.optimistic) {
      v.ownSessions = [{ id: PENDING_ID, title: newSessionTitle(), preview: "", lastActivity: Date.now(), lastActivityLabel: formatRelativeTime(Date.now()), active: true, pending: true }]
        .concat(v.ownSessions.map(function (s) { return Object.assign({}, s, { active: false }); }));
    }
    if (pendingCreate) v.canCreate = false;
    if (pendingClose) v.canClose = false;
    return v;
  }
  // Remembered open/closed state of the session groups, per channel; a group never chosen is open only while it holds the open session.
  function groupStorage() { try { return typeof localStorage !== "undefined" ? localStorage : null; } catch (_) { return null; } }
  function groupOpen(channelId, key, hasActive) {
    var chosen = groupOpenState(groupStorage(), channelId, key);
    return chosen === null ? hasActive : chosen;
  }
  function surfaceCtx() {
    var a = access(), s = activeSession();
    var adminActive = a.isPrivate && !a.owner;
    return {
      layout: layout, privateActive: a.isPrivate, adminActive: adminActive, activeAdminId: adminActive && s ? s.id : null,
      adminOpen: adminOpen || adminActive,
      showAll: showAll, now: Date.now(), rowMenu: menuFor, openFolders: openFolders, groupOpen: groupOpen,
    };
  }
  // The children of the selected room in the sidebar tree (agora-shell asks for them on every refresh).
  function treeHtml() { return treeChildrenHtml(view(), surfaceCtx()); }
  // Swap a surface's markup only when it changed, keeping keyboard focus on the same control.
  function setSurface(el, key, html) {
    if (!el || lastHtml[key] === html) return;
    lastHtml[key] = html;
    var active = typeof document !== "undefined" ? document.activeElement : null;
    var focusAttr = null, focusVal = null;
    if (active && el.contains && el.contains(active)) {
      ["data-private-session", "data-private-new", "data-private-admin-session", "data-private-folder", "data-private-group"].some(function (attr) {
        if (active.hasAttribute && active.hasAttribute(attr)) { focusAttr = attr; focusVal = active.getAttribute(attr); return true; }
        return false;
      });
    }
    el.innerHTML = html;
    if (focusAttr) {
      var again = el.querySelector("[" + focusAttr + (focusVal ? '="' + String(focusVal).replace(/"/g, '\\"') + '"' : "") + "]");
      if (again && again.focus) again.focus();
    }
  }
  function renderSurfaces(v, a) {
    var ctx = surfaceCtx();
    var colOpen = layout === "C" && (a.isPrivate || optimistic);
    if (!(layout === "A" && a.isPrivate && a.owner)) menuOpen = false;
    if (deps.els.col) {
      setSurface(deps.els.col, "col", columnHtml(v, ctx, menuFor));
      deps.els.col.classList.toggle("is-shut", !colOpen);
      deps.els.col.setAttribute("aria-hidden", colOpen ? "false" : "true");
      if (colOpen) deps.els.col.removeAttribute("inert"); else deps.els.col.setAttribute("inert", "");   // a shut column is not a Tab stop
    }
    if (deps.els.pop) {
      setSurface(deps.els.pop, "pop", menuHtml(v, ctx, menuFor));
      deps.els.pop.classList.toggle("is-shut", !menuOpen);
      deps.els.pop.setAttribute("aria-hidden", menuOpen ? "false" : "true");
      if (menuOpen) deps.els.pop.removeAttribute("inert"); else deps.els.pop.setAttribute("inert", "");
    }
    // The sidebar tree and the center title live in agora-shell: tell it when either changed.
    var chrome = treeChildrenHtml(v, ctx) + "\n" + JSON.stringify(headerInfo());
    if (chrome !== lastHtml.tree) {
      lastHtml.tree = chrome;
      if (deps.onTreeChanged) deps.onTreeChanged();
    }
  }
  function renderPhone(v) {
    var el = deps.els.phoneList;
    if (!el) return;
    var phone = deps.getPhone ? deps.getPhone() : null;
    setSurface(el, "phone", phone && phone.active && phone.tab === "private" ? phoneListHtml(v, surfaceCtx(), menuFor) : "");
  }
  // Opening a session (search, a link, a new one) shows its group: a group the user had closed opens again, once.
  var lastGroupActive = null;
  function revealActiveGroup(v) {
    var active = deps.getActiveSessionId ? deps.getActiveSessionId() : null;
    if (active === lastGroupActive) return;
    lastGroupActive = active;
    groupSessions(v.ownSessions).forEach(function (u) {
      if (u.type === "group" && u.sessions.some(function (s) { return s.id === active; }) && groupOpenState(groupStorage(), v.channelId, u.key) === false) {
        setGroupOpenState(groupStorage(), v.channelId, u.key, true);
      }
    });
  }
  function render() {
    revealActiveGroup(view());
    if (deps.els.rail) {
      var html = privateRailHtml(view(), menuFor);
      deps.els.rail.innerHTML = html;
      deps.els.rail.classList.toggle("hidden", !html);
    }
    var a = access();
    renderSurfaces(view(), a);
    renderPhone(view());
    if (deps.els.composer) deps.els.composer.classList.toggle("hidden", a.isPrivate && a.readOnly);
    if (deps.onAccessChanged) deps.onAccessChanged(a);
  }
  // The note of a private feed, for the empty feed shown while a new session is being created.
  function creatingPreamble() {
    return '<div class="ai-private-chat-note" role="note"><strong>' + e(privacyNotice()) + "</strong></div>";
  }
  function chatPreamble() {
    var a = access();
    if (!a.isPrivate) return "";
    var bits = ['<div class="ai-private-chat-note" role="note"><strong>' + e(privacyNotice()) + "</strong>"];
    if (a.adminReadOnly) bits.push('<span class="ai-private-readonly">' + e(adminReadOnlyNotice()) + "</span>");
    if (a.closed) bits.push("<span>" + e(t("privateChannels.closedChatNote")) + "</span>");
    if (executionNotice) bits.push('<span class="ai-private-exec-note" role="status">' + e(executionNotice) + "</span>");
    bits.push("</div>");
    return bits.join("");
  }
  function request() {
    var id = roomId();
    if (!id) return false;
    state.loading = true;
    state.refused = "";
    render();
    if (!connected || !deps.send({ type: "channel_list", roomId: id })) return false;
    return true;
  }
  function openCloseDialog(opener) {
    if (!deps.els.closeDialog) return;
    closeOpener = opener || null;
    if (deps.els.closeDialogText) deps.els.closeDialogText.textContent =
      t("privateChannels.closeDialogText");
    deps.els.closeDialog.classList.remove("hidden");
    // An irreversible action: focus starts on 취소, so a stray Enter does not close the channel.
    var cancel = deps.els.closeDialog.querySelector("[data-private-close-cancel]");
    if (cancel) cancel.focus();
  }
  function closeDialog() {
    if (!deps.els.closeDialog) return;
    deps.els.closeDialog.classList.add("hidden");
    if (closeOpener && closeOpener.focus) closeOpener.focus();
    closeOpener = null;
  }
  // Another private session in the viewer's own channel (the rail's "+" and the composer's 새 세션).
  function startNew() {
    var id = roomId();
    if (!connected || !id || pendingCreate) return;
    pendingCreate = true;
    privateSessionRequested = false;
    state.refused = "";
    // The channel is already known and open: the server ensures it again itself, so the session is asked for
    // straight away (one round trip less). Only a first-ever session goes through channel_ensure.
    var known = ownChannelState(state, id) === "active";
    if (known) privateSessionRequested = true;
    var sent = deps.send(known ? { type: "new_session", private: true, roomId: id } : { type: "channel_ensure", roomId: id });
    if (!sent) { pendingCreate = false; privateSessionRequested = false; connected = false; render(); return; }
    optimistic = true;
    clearTimeout(createTimer);
    createTimer = setTimeout(function () { failCreate(createFailed()); }, CREATE_TIMEOUT_MS);
    render();
    if (deps.rerenderChat) deps.rerenderChat();
  }
  function endOptimistic() {
    optimistic = false;
    clearTimeout(createTimer);
    createTimer = null;
  }
  // The server did not create the session (refused, error, no answer, connection lost): take the stand-in away
  // and say so.
  function failCreate(text) {
    if (!pendingCreate && !optimistic) return;
    pendingCreate = false;
    privateSessionRequested = false;
    endOptimistic();
    if (deps.toast) deps.toast(text || createFailed());
    render();
    if (deps.rerenderChat) deps.rerenderChat();
  }
  function canStartNew() { return !!view().canCreate; }
  // The viewer's own channel as the "⋯" menu needs it (row-menus resolves "channel:<id>" through this).
  function getChannel(id) {
    var v = view();
    if (!v.hasChannel || String(v.channelId) !== String(id)) return null;
    return { id: v.channelId, roomId: v.roomId, name: v.channelName, label: v.channelLabel, owner: true, active: !v.closed, canClose: !!v.canClose && !v.pendingClose };
  }
  // 이름 변경 for the viewer's own channel: the "⋯" menu of the desktop tree and of the phone sidebar both land here.
  // An empty name clears it (the default label comes back).
  function openRename(restore) {
    var v = view();
    if (!deps.rename || !v.hasChannel || v.closed) return;
    var rid = v.roomId;
    deps.rename.open({
      title: t("privateChannels.renameTitle"), value: v.channelName, min: 0, max: CHANNEL_NAME_MAX,
      hint: t("privateChannels.renameHint", { name: v.defaultChannelLabel }), restore: restore,
      onSave: function (name) { return !!deps.send({ type: "channel_rename", roomId: rid, name: name }); },
    });
  }
  // "나만의 채널" in the sidebar: the open private session stays; from anywhere else it opens the
  // most recent one, or starts the first one when there is none.
  function openOwn() {
    var v = view();
    // The channel list is still on its way: its sessions are not known yet, so nothing is created.
    if (v.loading && !v.hasChannel) { pendingOwnRoom = roomId(); return; }
    pendingOwnRoom = null;
    if (!v.ownSessions.length) { startNew(); return; }
    var a = access();
    if (a.isPrivate && a.owner) return;
    if (deps.switchSession) deps.switchSession(v.ownSessions[0].id);
  }
  function setMenu(open) {
    var a = access();
    var next = !!open && layout === "A" && a.isPrivate && a.owner;
    if (next === menuOpen) return;
    menuOpen = next;
    render();
    var el = deps.els.pop;
    if (next && el) {
      var first = el.querySelector('[aria-current="true"]') || el.querySelector("[data-private-new]") || el.querySelector("[data-private-session]");
      if (first && first.focus) first.focus();
    }
  }
  function onRailClick(ev) {
    var t = ev.target && ev.target.closest && ev.target.closest("[data-private-new],[data-private-session],[data-private-admin-session],[data-private-close],[data-private-open],[data-private-more],[data-private-admin-toggle],[data-private-folder],[data-private-group]");
    if (!t) return;
    var id = roomId();
    if (t.hasAttribute("data-private-open")) { openOwn(); return; }
    if (t.hasAttribute("data-private-more")) { showAll = true; render(); return; }
    if (t.hasAttribute("data-private-admin-toggle")) { adminOpen = !adminOpen; render(); return; }
    if (t.hasAttribute("data-private-group")) {
      var gKey = t.getAttribute("data-private-group");
      setGroupOpenState(groupStorage(), view().channelId, gKey, t.getAttribute("aria-expanded") !== "true");
      ev.agKeepMenu = true;
      render();
      return;
    }
    if (t.hasAttribute("data-private-folder")) {
      var who = t.getAttribute("data-private-folder");
      openFolders[who] = !openFolders[who];
      ev.agKeepMenu = true;   // re-rendering detaches the target: the outside-click handler must not read that as "outside"
      render();
      return;
    }
    if (menuOpen) { menuOpen = false; render(); }
    if (t.hasAttribute("data-private-new")) { startNew(); return; }
    if (t.hasAttribute("data-private-close")) {
      if (connected && id && !pendingClose) openCloseDialog(t);
      return;
    }
    var sessionId = t.getAttribute("data-private-session");
    if (sessionId === PENDING_ID) return;   // the stand-in of a session still being created
    if (sessionId == null) sessionId = t.getAttribute("data-private-admin-session");
    if (sessionId != null && deps.switchSession) {
      var n = Number(sessionId);
      deps.switchSession(String(n) === sessionId ? n : sessionId);
    }
  }

  [deps.els.rail, deps.els.col, deps.els.pop, deps.els.phoneList].concat(deps.els.surfaces || []).forEach(function (el) { if (el) el.addEventListener("click", onRailClick); });
  if (deps.els.closeDialog) {
    deps.els.closeDialog.addEventListener("click", function (ev) {
      var t = ev.target && ev.target.closest ? ev.target.closest("[data-private-close-confirm],[data-private-close-cancel]") : null;
      if (!t) return;
      if (t.hasAttribute("data-private-close-cancel")) return closeDialog();
      var id = roomId();
      if (!connected || !id || pendingClose) return closeDialog();
      pendingClose = true;
      closeDialog();
      if (!deps.send({ type: "channel_close", roomId: id })) { pendingClose = false; connected = false; }
      render();
    });
  }
  function menuTrigger() { return typeof document !== "undefined" ? document.querySelector('[data-ag-action="session-menu"]') : null; }
  if (typeof document !== "undefined") document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape" && deps.els.closeDialog && !deps.els.closeDialog.classList.contains("hidden")) closeDialog();
    else if (ev.key === "Escape" && menuOpen) {
      setMenu(false);
      var trigger = menuTrigger();
      if (trigger && trigger.focus) trigger.focus();
    } else if ((ev.key === "ArrowDown" || ev.key === "ArrowUp") && menuOpen && deps.els.pop && deps.els.pop.contains(document.activeElement)) {
      var items = Array.prototype.slice.call(deps.els.pop.querySelectorAll("[role=menuitem]"));
      var at = items.indexOf(document.activeElement);
      if (at === -1 || !items.length) return;
      ev.preventDefault();
      items[(at + (ev.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
    }
  });
  // A click anywhere else closes the title menu (its own trigger toggles it).
  if (typeof document !== "undefined") document.addEventListener("click", function (ev) {
    if (!menuOpen || ev.agKeepMenu) return;
    var inside = deps.els.pop && deps.els.pop.contains(ev.target);
    var trigger = ev.target && ev.target.closest ? ev.target.closest('[data-ag-action="session-menu"]') : null;
    if (!inside && !trigger) setMenu(false);
  });

  function handle(msg) {
    if (!msg || typeof msg.type !== "string") return false;
    if (msg.type === "channel_state") {
      var id = roomId();
      if (!id) return true;
      applyPrivateMessage(state, msg, id);
      if (pendingCreate && msg.ensured && !privateSessionRequested) {
        privateSessionRequested = true;
        if (!deps.send({ type: "new_session", private: true, roomId: id })) { pendingCreate = false; privateSessionRequested = false; connected = false; }
      }
      var refreshAfterClose = pendingClose;
      pendingClose = false;
      render();
      if (refreshAfterClose) request();
      if (pendingOwnRoom === id && !state.loading) openOwn();
      if (deps.rerenderChat) deps.rerenderChat();
      return true;
    }
    var friendly = friendlyPrivateError(msg);
    if (friendly === channelRefusedNotice()) {
      var wasCreating = pendingCreate || optimistic;
      pendingCreate = false;
      privateSessionRequested = false;
      pendingClose = false;
      endOptimistic();
      state.loading = false;
      state.refused = friendly;
      if (wasCreating && deps.toast) deps.toast(createFailed());
      render();
      if (wasCreating && deps.rerenderChat) deps.rerenderChat();
      return true;
    }
    if (friendly === nameInvalidNotice()) {
      if (deps.toast) deps.toast(friendly);
      return true;
    }
    if (isPrivateExecutionNotice(friendly)) {
      // A refused turn is a line in the thread plus the draft handed back (the page's job); the pinned
      // preamble note is only the fallback for a host that does not provide that.
      if (deps.onTurnRefused) { deps.onTurnRefused(friendly); return true; }
      if (!access().isPrivate) return false;
      executionNotice = friendly;
      if (deps.rerenderChat) deps.rerenderChat();
      return true;
    }
    return false;
  }
  function setConnected(value) {
    connected = !!value;
    if (!connected) {
      var wasCreating = pendingCreate || optimistic;
      pendingCreate = false; privateSessionRequested = false; pendingClose = false;
      if (wasCreating) { failCreate(createFailed()); return; }
    }
    render();
  }
  function onContextChanged() {
    var id = roomId();
    if (id !== state.roomId) {
      // No room at all is only the moment between session_switched and the session list that names the new
      // session's room: the channel state of the room that was shown must survive it (a different room resets it).
      if (id) { state = createPrivateState(); state.roomId = id; pendingOwnRoom = null; }
      pendingCreate = false;
      privateSessionRequested = false;
      pendingClose = false;
      endOptimistic();
      executionNotice = "";
      render();
      if (connected && id) request();
    } else render();
  }
  function settleCreatedSession() {
    var a = access();
    if (pendingCreate && a.isPrivate && a.owner) {
      pendingCreate = false;
      privateSessionRequested = false;
      endOptimistic();
      // Refresh the channel quietly: no "불러오는 중" flash over the list that is already right.
      var id = roomId();
      if (id && connected) deps.send({ type: "channel_list", roomId: id });
      render();
      return true;
    }
    return false;
  }
  function onSessionsChanged() { if (!settleCreatedSession()) render(); }
  function onSessionChanged() {
    menuOpen = false;
    settleCreatedSession();
    executionNotice = "";
    render();
  }

  // The center header names the open private session; under layout A that title is the menu trigger.
  function headerInfo() {
    var a = access();
    if (optimistic && roomId() && !(a.isPrivate && a.owner)) return { label: view().channelLabel, name: newSessionTitle(), menu: false, open: false };
    if (!a.isPrivate) return null;
    var v = view(), mine = null;
    v.ownSessions.forEach(function (x) { if (x.active) mine = x; });
    if (a.owner) return { label: v.channelLabel, name: mine ? mine.title : t("privateChannels.untitledSession"), menu: layout === "A", open: menuOpen };
    var sid = deps.getActiveSessionId ? deps.getActiveSessionId() : null, who = "", title = "";
    v.adminChannels.forEach(function (c) { c.sessions.forEach(function (x) { if (x.id === sid) { who = c.label; title = x.title; } }); });
    return { label: t("privateChannels.memberChannels"), name: (who ? who + " · " : "") + (title || t("privateChannels.session")), menu: false, open: false };
  }
  function setLayout(next) {
    layout = next === "A" || next === "B" ? next : "C";
    menuOpen = false;
    render();
  }

  render();
  onLangChange(function () { render(); if (deps.rerenderChat) deps.rerenderChat(); });
  return {
    setLayout: setLayout, getLayout: function () { return layout; }, headerInfo: headerInfo, treeHtml: treeHtml,
    toggleMenu: function () { setMenu(!menuOpen); }, isMenuOpen: function () { return menuOpen; },
    handle: handle, request: request, setConnected: setConnected,
    onContextChanged: onContextChanged, onSessionsChanged: onSessionsChanged, onSessionChanged: onSessionChanged,
    refresh: render, getAccess: access, getView: view, chatPreamble: chatPreamble, startNew: startNew, canStartNew: canStartNew,
    getChannel: getChannel, openRename: openRename, openClose: function (opener) { var v = view(); if (connected && v.roomId && v.canClose && !pendingClose) openCloseDialog(opener); }, openOwn: openOwn,
    cancelOpenOwn: function () { pendingOwnRoom = null; },
    isCreating: function () { return optimistic; }, creatingPreamble: creatingPreamble, failCreate: failCreate,
  };
}

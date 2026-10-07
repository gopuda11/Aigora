// agora-shell.js - DOM wiring for the Club Agora room UI.
//
// Progressive enhancement: with no rooms in the store (the server has not sent
// rooms_state, or sent none the client can ground) every container stays
// hidden and the existing project/session shell is untouched. Markup comes
// from agora-render.js; all data shaping lives in agora-model.js.

import { store } from "./store.js";
import { t, formatTime as formatClock } from "../aigora/i18n.js";
import { getWs } from "./ws-ref.js";
import { copyToClipboard } from "./utils.js";
import { refreshIcons } from "./icons.js";
import { getCachedSessions } from "./sidebar-sessions.js";
import { sessionActivity } from "./activity-state.js";
import {
  normalizeRooms, normalizeNarration, mergeNarration, resolveActiveRoomId,
  sessionsForRoom, summarizeAgents, sectionExpanded, toggleSection,
} from "./agora-model.js";
import {
  renderRoomRail, renderRoomSessions, renderPreviousConversations, renderRoomHeader, renderContextPanel, CONTEXT_TABS,
} from "./agora-render.js";
import { refreshOrchestrationPanel } from "./agora-orchestration-ui.js";
import { setHtmlKeepingNodes } from "./dom-morph.js";

var els = null;
var lastHtml = {};
var narrowQuery = null;
var sheetQuery = null;
var noticeTimer = null;
var rowMenu = null;
// Aigora: selecting a room opens its single main thread through this callback
// (roomId -> void), and the per-room session list becomes a collapsed "이전 대화"
// list of the sessions that predate it. Unset, the shell keeps the session list.
var roomMainOpener = null;
// Aigora only (all optional; unset, the shell behaves as the legacy club UI does):
//  - roomChildren(room) -> markup drawn under the selected room in the sidebar tree;
//  - sessionChrome = { header() -> {label,name,menu,open}|null, toggleMenu() } for the center title;
//  - inspector = { narrowQuery, read() -> bool, save(bool) }: the right panel starts from the
//    remembered state, is a column above 1024px and an overlay below it.
var roomChildren = null;
var sessionChrome = null;
var inspector = null;
// The last markup of each room's children, kept so a room that was just left can close
// (its rows stay in the DOM, inert and collapsed, instead of vanishing at once).
var childrenCache = {};

var NOTICE_MS = 8000;

// Below this width the context panel is a drawer, closed until asked for.
function isNarrow() {
  return !!(narrowQuery && narrowQuery.matches);
}

function narrationKey(sessionId) {
  return (store.get("currentSlug") || "") + ":" + sessionId;
}

function formatTime(ts) {
  try {
    // In the viewer's language ("오전 02:53" in ko, "2:53 AM" in en), never a fixed locale.
    return formatClock(ts, { hour: "2-digit", minute: "2-digit" });
  } catch (e) {
    return "";
  }
}

// --- WS handlers (registered in app-messages.js) -----------------------------

export function handleRoomsState(msg) {
  store.set({ rooms: normalizeRooms(msg && msg.rooms) });
}

// Optional rowMenu(kind, id) -> markup placed after each room / session row
// button (the standalone Aigora page supplies its "⋯" triggers this way).
export function setRowMenu(fn) {
  rowMenu = typeof fn === "function" ? fn : null;
}

export function setRoomMainOpener(fn) {
  roomMainOpener = typeof fn === "function" ? fn : null;
}

export function setRoomChildren(fn) {
  roomChildren = typeof fn === "function" ? fn : null;
}

export function setSessionChrome(chrome) {
  sessionChrome = chrome || null;
}

export function handleSessionNarration(msg) {
  if (!msg || msg.sessionId == null) return;
  var key = narrationKey(msg.sessionId);
  var all = store.get("agoraNarration") || {};
  var parsed = normalizeNarration(msg.entries);
  var next = Object.assign({}, all);
  next[key] = mergeNarration(all[key], parsed.entries, msg.replace !== false);
  store.set({ agoraNarration: next });
}

// --- Rendering -----------------------------------------------------------------

// Replace a container's markup only when it changed, keeping keyboard focus on
// the equivalent control after a rebuild.
function setHtml(el, html, keepNodes) {
  if (!el || lastHtml[el.id] === html) return;
  lastHtml[el.id] = html;
  var active = document.activeElement;
  var focusAttr = null;
  var focusVal = null;
  if (active && el.contains(active)) {
    ["data-row-menu", "data-ag-section", "data-ag-chev", "data-room-id", "data-session-id", "data-ag-tab", "data-ag-action", "data-ag-copy", "data-ag-turn", "data-ag-detail"].some(function (attr) {
      if (active.hasAttribute(attr)) { focusAttr = attr; focusVal = active.getAttribute(attr); return true; }
      return false;
    });
  }
  var top = el.scrollTop;
  if (keepNodes) setHtmlKeepingNodes(el, html);
  else el.innerHTML = html;
  if (top) el.scrollTop = top;
  if (typeof lucide !== "undefined") refreshIcons(el);
  if (focusAttr) {
    var again = el.querySelector("[" + focusAttr + '="' + String(focusVal).replace(/"/g, '\\"') + '"]');
    if (again) again.focus();
  }
}

function currentView() {
  var rooms = store.get("rooms") || [];
  var sessions = getCachedSessions() || [];
  var activeId = store.get("activeSessionId");
  var activeSession = null;
  for (var i = 0; i < sessions.length; i++) if (sessions[i].id === activeId) { activeSession = sessions[i]; break; }
  var roomId = resolveActiveRoomId(rooms, store.get("selectedRoomId"), activeSession);
  var room = null;
  for (var j = 0; j < rooms.length; j++) if (rooms[j].id === roomId) { room = rooms[j]; break; }
  var roomSessions = room ? sessionsForRoom(sessions, room.id, store.get("myUserId")) : [];
  var previous = room && roomMainOpener
    ? sessionsForRoom(sessions.filter(function (x) { return !x.roomMain; }), room.id, store.get("myUserId"))
    : roomSessions;
  var narration = store.get("agoraNarration") || {};
  var inRoom = room && activeSession && String(activeSession.roomId) === room.id;
  return {
    rooms: rooms,
    room: room,
    roomSessions: roomSessions,
    previous: previous,
    entries: inRoom && activeId != null ? (narration[narrationKey(activeId)] || []) : [],
    sessionId: inRoom && activeId != null ? activeId : null,
    // The room's own feed (its main thread) is what is open: the room row is the highlighted one.
    feedOpen: !!(inRoom && activeSession.roomMain === true),
    // Whether the open session is mid-turn (only the newest turn card can still be running).
    running: inRoom && activeSession ? sessionActivity(activeSession, null, { ignoreUnread: true }).active : false,
    onlineIds: (store.get("cachedOnlineIds") || []).map(String),
  };
}

export function refreshAgora() {
  if (!els) return;
  var v = currentView();
  var layout = els.layout;
  layout.classList.toggle("ag-has-rooms", v.rooms.length > 0);
  layout.classList.toggle("ag-room-mode", !!v.room);

  // The rail is rendered twice (sidebar and mobile sheet) from the same
  // disclosure state; the id prefix keeps aria-controls targets unique.
  var sections = store.get("agoraSections");
  function railHtml(idPrefix) {
    var opts = { idPrefix: idPrefix, expanded: sectionExpanded(sections, "rooms"), rowMenu: rowMenu, collapsed: store.get("agoraRoomCollapsed"), feedOpen: v.feedOpen };
    // Only the sidebar gets the tree.
    if (roomChildren && idPrefix === "ag-rail") {
      opts.roomChildren = function (room, current) {
        if (!current) return childrenCache[room.id] || "";
        childrenCache[room.id] = roomChildren(room) || "";
        return childrenCache[room.id];
      };
    }
    // The phone's 방 전환 sheet is rooms only: 이전 대화 and the channel's sessions are in the phone sidebar.
    if (roomMainOpener && idPrefix === "ag-sheet") return renderRoomRail(v.rooms, v.room && v.room.id, opts);
    return renderRoomRail(v.rooms, v.room && v.room.id, opts) +
      (roomMainOpener
        ? renderPreviousConversations(v.room, v.previous, { idPrefix: idPrefix, expanded: !!(sections && sections.previous === true), rowMenu: rowMenu })
        : renderRoomSessions(v.room, v.roomSessions, { idPrefix: idPrefix, expanded: sectionExpanded(sections, "sessions"), rowMenu: rowMenu }));
  }
  var rail = railHtml("ag-rail");
  setHtml(els.rail, rail, !!roomChildren);
  setHtml(els.sheetBody, railHtml("ag-sheet"));
  els.rail.classList.toggle("hidden", !rail);

  var panelOpen = !!store.get("agoraPanelOpen");
  var sheetOpen = !!store.get("agoraSheetOpen");
  els.sheet.classList.toggle("is-open", sheetOpen);
  setHtml(els.header, renderRoomHeader({
    room: v.room, entries: v.entries, panelOpen: panelOpen, sheetOpen: sheetOpen,
    session: sessionChrome ? sessionChrome.header() : null, sideButton: !!sessionChrome,
  }), false);
  els.header.classList.toggle("hidden", !v.room);

  var roomId = v.room ? v.room.id : null;
  setHtml(els.context, renderContextPanel({
    room: v.room,
    agents: summarizeAgents(v.roomSessions),
    entries: v.entries,
    turnUi: { open: store.get("agoraTurnOpen") || {}, detail: store.get("agoraTurnDetail") || {}, running: v.running },
    coaching: store.get("coachingTab"),
    sessionId: v.sessionId,
    onlineIds: v.onlineIds,
    tab: store.get("agoraTab"),
    formatTime: formatTime,
  }));
  refreshOrchestrationPanel();
  els.context.classList.toggle("hidden", !v.room);
  els.context.classList.toggle("is-open", panelOpen && !!v.room);
  // With the inspector as a column (above 1024px) there is nothing to dim.
  els.scrim.classList.toggle("is-on", (panelOpen && !!v.room && (!inspector || isNarrow())) || sheetOpen);
}

// --- Actions -------------------------------------------------------------------

function focusHeaderControl(action) {
  var back = els.header.querySelector('[data-ag-action="' + action + '"]');
  if (back && back.offsetParent !== null) back.focus();
}

// Hand keyboard focus back to the control that opened an overlay, so closing
// with Escape or the scrim never strands focus on a hidden element.
// Open or close the right panel. With the remembered inspector, the choice is saved
// only while it is a column: an overlay on a narrow screen is a passing look.
function setPanel(open) {
  store.set(open ? { agoraPanelOpen: true } : { agoraPanelOpen: false, sidePinned: false });
  if (inspector && !isNarrow()) inspector.save(open);
}

function closeOverlays() {
  var wasSheet = !!store.get("agoraSheetOpen");
  setNotice("");
  var hadFocus = els.sheet.contains(document.activeElement) || els.context.contains(document.activeElement);
  store.set({ agoraSheetOpen: false });
  setPanel(false);
  refreshAgora();
  if (hadFocus) focusHeaderControl(wasSheet ? "rooms" : "panel");
}

// Close only the room sheet (after a room or session pick), returning focus to
// its opener when focus was inside it.
function closeSheet() {
  var hadFocus = els.sheet.contains(document.activeElement);
  store.set({ agoraSheetOpen: false });
  refreshAgora();
  if (hadFocus) focusHeaderControl("rooms");
}

// Say so, in both the sidebar and the room sheet, when an action could not be
// done. The message replaces itself on the next attempt and fades after a while;
// nothing else changes, so the user can simply try again.
function setNotice(text) {
  clearTimeout(noticeTimer);
  noticeTimer = null;
  els.notices.forEach(function (n) {
    n.textContent = text;
    n.classList.toggle("is-on", !!text);
  });
  if (text) {
    noticeTimer = setTimeout(function () { setNotice(""); }, NOTICE_MS);
    if (noticeTimer && typeof noticeTimer.unref === "function") noticeTimer.unref();
  }
}

function isConnected() {
  var ws = getWs();
  return !!ws && ws.readyState === 1;
}

function selectRoom(roomId) {
  // Choosing a room (its row) shows its children again, even if the chevron had folded them.
  var folded = store.get("agoraRoomCollapsed");
  if (folded && folded[roomId]) store.set({ agoraRoomCollapsed: Object.assign({}, folded, { [roomId]: false }) });
  if (roomMainOpener) {
    // One shared feed per room: always its main thread, never a session pick.
    if (!isConnected()) return setNotice(t("agoraShell.offlineNotice"));
    store.set({ selectedRoomId: roomId });
    roomMainOpener(roomId);
    setNotice("");
    closeSheet();
    return;
  }
  var target = sessionsForRoom(getCachedSessions() || [], roomId, store.get("myUserId"));
  var needsSwitch = target.length > 0 && !target.some(function (s) { return s.id === store.get("activeSessionId"); });
  // Offline, choosing a room that needs a session switch would show the new
  // room over the old conversation. Stay put and say why instead.
  if (needsSwitch && !isConnected()) return setNotice(t("agoraShell.offlineNotice"));
  store.set({ selectedRoomId: roomId });
  if (needsSwitch) switchSession(target[0].id);
  else { setNotice(""); closeSheet(); }
}

// The phone sidebar's search and 방 전환 sheet: pick a room, open the sheet.
export function openRoom(roomId) { selectRoom(roomId); }
export function openRoomSheet() {
  setNotice("");
  store.set({ agoraSheetOpen: true });
  refreshAgora();
  var first = els && els.sheet.querySelector("button");
  if (first) first.focus();
}
// The right panel (a bottom sheet on a phone) on one of its tabs.
export function openContextPanel(tabId) {
  store.set({ agoraTab: tabId, agoraPanelOpen: true });
  refreshAgora();
  var closeBtn = els && els.context.querySelector('[data-ag-action="close-panel"]');
  if (closeBtn && closeBtn.offsetParent !== null) closeBtn.focus();
}

function switchSession(id) {
  if (!isConnected()) return setNotice(t("agoraShell.offlineNotice"));
  getWs().send(JSON.stringify({ type: "switch_session", id: id }));
  setNotice("");
  closeSheet();
}

function copySuggestion(entryId) {
  var v = currentView();
  for (var i = 0; i < v.entries.length; i++) {
    if (v.entries[i].id === entryId && v.entries[i].stage === "better_prompt") {
      copyToClipboard(v.entries[i].text);
      return;
    }
  }
}

function onClick(ev) {
  var t = ev.target.closest && ev.target.closest("[data-ag-section],[data-ag-chev],[data-room-id],[data-room-main],[data-session-id],[data-ag-tab],[data-ag-action],[data-ag-copy],[data-ag-turn],[data-ag-detail]");
  if (!t) return;
  if (t.hasAttribute("data-ag-turn") || t.hasAttribute("data-ag-detail")) {
    // The button knows what is showing: flip it. Keys are request ids, so a replay keeps the choice.
    var turnKey = t.getAttribute(t.hasAttribute("data-ag-turn") ? "data-ag-turn" : "data-ag-detail");
    var stateKey = t.hasAttribute("data-ag-turn") ? "agoraTurnOpen" : "agoraTurnDetail";
    var next = Object.assign({}, store.get(stateKey));
    next[turnKey] = t.getAttribute("aria-expanded") !== "true";
    var patch = {};
    patch[stateKey] = next;
    store.set(patch);
    refreshAgora();
    return;
  }
  if (t.hasAttribute("data-ag-section")) {
    var sectionKey = t.getAttribute("data-ag-section");
    var openSections = store.get("agoraSections");
    // "previous" starts collapsed: only an explicit open is remembered.
    store.set({ agoraSections: sectionKey === "previous"
      ? Object.assign({}, openSections, { previous: !(openSections && openSections.previous === true) })
      : toggleSection(openSections, sectionKey) });
    refreshAgora();
    return;
  }
  if (t.hasAttribute("data-ag-chev")) {
    // The chevron only folds or unfolds the open room's children; on another room it opens that room.
    var chevRoom = t.getAttribute("data-ag-chev");
    var shown = currentView().room;
    if (!shown || shown.id !== chevRoom) return selectRoom(chevRoom);
    var folds = store.get("agoraRoomCollapsed") || {};
    store.set({ agoraRoomCollapsed: Object.assign({}, folds, { [chevRoom]: !folds[chevRoom] }) });
    refreshAgora();
    return;
  }
  if (t.hasAttribute("data-room-id")) return selectRoom(t.getAttribute("data-room-id"));
  if (t.hasAttribute("data-room-main")) {
    var open = currentView().room;
    return open ? selectRoom(open.id) : undefined;
  }
  if (t.hasAttribute("data-session-id")) {
    var id = t.getAttribute("data-session-id");
    var n = Number(id);
    return switchSession(String(n) === id ? n : id);
  }
  if (t.hasAttribute("data-ag-tab")) {
    store.set({ agoraTab: t.getAttribute("data-ag-tab") });
    refreshAgora();
    return;
  }
  if (t.hasAttribute("data-ag-copy")) return copySuggestion(t.getAttribute("data-ag-copy"));
  var action = t.getAttribute("data-ag-action");
  if (action === "panel") {
    setPanel(!store.get("agoraPanelOpen"));
    refreshAgora();
    if (store.get("agoraPanelOpen")) {
      var closeBtn = els.context.querySelector('[data-ag-action="close-panel"]');
      if (closeBtn && closeBtn.offsetParent !== null) closeBtn.focus();
    }
  } else if (action === "close-panel") {
    closeOverlays();
  } else if (action === "side") {
    // Crowded layout: bring the folded sidebar back until the inspector closes.
    store.set({ sidePinned: !store.get("sidePinned") });
  } else if (action === "session-menu") {
    if (sessionChrome) sessionChrome.toggleMenu();
  } else if (action === "rooms") {
    setNotice("");
    store.set({ agoraSheetOpen: !store.get("agoraSheetOpen") });
    refreshAgora();
    if (store.get("agoraSheetOpen")) {
      var first = els.sheet.querySelector("button");
      if (first) first.focus();
    }
  }
}

function onKeydown(ev) {
  if (ev.key === "Escape" && (store.get("agoraSheetOpen") || (isNarrow() && store.get("agoraPanelOpen")))) {
    closeOverlays();
    return;
  }
  var tab = ev.target.closest && ev.target.closest("[data-ag-tab]");
  if (!tab || (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight" && ev.key !== "Home" && ev.key !== "End")) return;
  var ids = CONTEXT_TABS.map(function (x) { return x.id; });
  var at = ids.indexOf(tab.getAttribute("data-ag-tab"));
  var next = ev.key === "Home" ? 0 : ev.key === "End" ? ids.length - 1
    : (at + (ev.key === "ArrowRight" ? 1 : ids.length - 1)) % ids.length;
  ev.preventDefault();
  store.set({ agoraTab: ids[next] });
  refreshAgora();
  var moved = els.context.querySelector('[data-ag-tab="' + ids[next] + '"]');
  if (moved) moved.focus();
}

// --- Init ----------------------------------------------------------------------

export function initAgora(options) {
  inspector = options && options.inspector ? options.inspector : null;
  els = {
    layout: document.getElementById("layout"),
    rail: document.getElementById("agora-room-rail"),
    header: document.getElementById("agora-room-header"),
    context: document.getElementById("agora-context"),
    sheet: document.getElementById("agora-room-sheet"),
    sheetBody: document.getElementById("agora-room-sheet-body"),
    scrim: document.getElementById("agora-scrim"),
    notices: ["agora-rail-notice", "agora-sheet-notice"].map(function (id) { return document.getElementById(id); }).filter(Boolean),
  };
  if (!els.layout || !els.rail || !els.header || !els.context || !els.sheet || !els.sheetBody || !els.scrim) {
    els = null;
    return;
  }
  [els.rail, els.header, els.context, els.sheet].forEach(function (el) {
    el.addEventListener("click", onClick);
    el.addEventListener("keydown", onKeydown);
  });
  els.scrim.addEventListener("click", closeOverlays);

  // Wide: the panel starts open and can be collapsed. Narrow: it is a drawer
  // that starts closed. Crossing the breakpoint resets to that default.
  if (window.matchMedia) {
    narrowQuery = inspector ? window.matchMedia(inspector.narrowQuery) : window.matchMedia("(max-width: 1180px)");
    // Inspector (Aigora): closed until opened; the remembered choice applies as a column, and
    // narrow screens start without the overlay.
    store.set({ agoraPanelOpen: inspector ? inspector.read() && !narrowQuery.matches : !narrowQuery.matches });
    narrowQuery.addEventListener("change", function (ev) {
      store.set({ agoraPanelOpen: inspector ? inspector.read() && !ev.matches : !ev.matches, agoraSheetOpen: false });
      refreshAgora();
    });
    // The room sheet only exists at phone width (<=768px, where the sidebar is
    // hidden). Crossing that line while it is open would leave a scrim and a
    // stale aria-expanded behind a sheet that is no longer displayed.
    sheetQuery = window.matchMedia("(max-width: 768px)");
    sheetQuery.addEventListener("change", function () {
      store.set({ agoraSheetOpen: false });
      refreshAgora();
    });
  }

  store.subscribe(["rooms", "selectedRoomId", "agoraNarration", "agoraTab", "agoraTurnOpen", "agoraTurnDetail", "coachingTab", "agoraSections", "agoraSheetOpen", "cachedOnlineIds", "myUserId", "currentSlug"], refreshAgora);
  store.subscribe(["activeSessionId"], function () {
    // A session that belongs to a room drives the room view; drop a manual
    // selection so switching sessions can move the header to that room.
    var sessions = getCachedSessions() || [];
    var id = store.get("activeSessionId");
    for (var i = 0; i < sessions.length; i++) {
      if (sessions[i].id === id && sessions[i].roomId != null && store.get("selectedRoomId") != null) {
        store.set({ selectedRoomId: null });
        return;
      }
    }
    refreshAgora();
  });
  refreshAgora();
}

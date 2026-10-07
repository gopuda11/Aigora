import { queueStorage } from "./queue-storage.js";
// client.js - Minimal standalone Aigora client. It owns the WebSocket to
// /p/:slug/ws (same protocol as the legacy app), folds the messages that real
// chat needs into a thread, and drives the shared Agora shell (rooms, sessions,
// context panel, orchestration cards) through the store. It does not import the
// legacy app.js and touches only the ids declared in aigora/index.html.

import { createStore, store } from "../modules/store.js";
import { setWs, getWs } from "../modules/ws-ref.js";
import { initAgora, handleRoomsState, handleSessionNarration, refreshAgora, setRowMenu, setRoomMainOpener, setRoomChildren, setSessionChrome, openRoom, openRoomSheet, openContextPanel } from "../modules/agora-shell.js";
import { handleOrchestrationEvent, focusRunStep } from "../modules/agora-orchestration-ui.js";
import { resolveActiveRoomId, sessionsForRoom, summarizeStages, latestTurnEntries } from "../modules/agora-model.js";
import { initMenuButton } from "../modules/menu-button.js";
import { initAiUsage } from "../modules/ai-usage.js";
import { initAiPicker } from "./ai-picker.js";
import { setSessions, getCachedSessions, onHostNotice, copyToClipboard } from "./host.js";
import { createThread, applyMessage, renderThread, imageProblem, MAX_IMAGES, setImageBase, toggleRoute, startRouteFeedback, undoRouteFeedback } from "./chat-model.js";
import { findAsk, isLive, toggleOption, toggleOther, setOtherText, buildResponse } from "./ask-user-model.js";
import { createTurnNarrator } from "./turn-narration.js";
import { initRoomAdmin } from "./room-admin.js";
import { initSettings } from "./settings.js";
import { initAccountMenu } from "./account-menu.js";
import { initGuide } from "./guide.js";
import { GUIDE_VERSION } from "./guide-model.js";
import { initSocial } from "./social.js";
import { initSharedPosts } from "./shared-posts.js";
import { initAttachments } from "./attachments.js";
import { fileChipHtml } from "./attachments-model.js";
import { initOffice } from "./office.js";
import { initLightbox } from "./lightbox.js";
import { initCoaching } from "./coaching.js";
import { initPrivateChannels } from "./private-channels.js";
import { initSkills } from "./skills.js";
import { contextScope } from "./skills-model.js";
import { initRowMenus } from "./row-menus.js";
import { initRenameDialog } from "./rename-dialog.js";
import { initConfirmDialog } from "./confirm-dialog.js";
import { initPhoneNav } from "./phone-nav.js";
import { modeChip } from "./phone-nav-model.js";
import { t, applyDom, setLang, onLangChange } from "./i18n.js";
import { initLocalModel } from "./local-model.js";
import { listRooms } from "./room-admin-api.js";
import { normalizeLayout, readLayout, saveLayout, applyLayout, readReduceMotion, saveReduceMotion, applyReduceMotion, readInspector, saveInspector, readChannelInspector, saveChannelInspector, readCoaching, saveCoaching } from "./display-prefs.js";
import { isCrowded, effectiveLayout, COLUMN_MAX_PX } from "./session-layouts-model.js";
import { riseIn } from "./motion.js";
import { createScrollMemory, applyTarget } from "./scroll-memory.js";
import { createViewCache, visibleEntry, SKELETON_HTML } from "./view-cache.js";

var RECONNECT_MAX_MS = 5000;
var UNAUTH_RETRY_MS = 400;

var thread = createThread();
// Observable room-turn events -> 작업 설명 entries (the server only narrates orchestration runs).
var narrator = createTurnNarrator();
var els = {};
var attachments = [];   // { mediaType, data, name, thumb? }
var lastSent = null;    // { text, images, files } of the newest turn, handed back if the server refuses it
var reconnectDelay = 300;
var reconnectTimer = null;
var toastTimer = null;
var connectGen = 0;
var connected = false;
// One explicit offline send, captured independently of further draft edits.
// Dispatch once only after the socket confirms the target and fresh permissions.
// Once dispatched, never replay: message_ack confirms it, otherwise fail visibly.
var queueDisk = null;
var queuedSend = null;
var queuedTimer = null;
var QUEUE_CONFIRM_MS = 15000;
var unauthenticated = false;
var roomAdmin = null;
var mentionRoster = null;
var settings = null;
var accountMenu = null;
var guide = null;
var guideSeen = null;   // /api/me onboardingSeen; null until the viewer is known
var guideVersion = 0;   // /api/me onboardingVersion: the guide version this viewer last saw
var social = null;
var sharedPosts = null;
var attachmentsUi = null;
var officeUi = null;   // 함께 편집 / 새 문서 (Office co-editing), see office.js
var coaching = null;   // 지시 코칭 ("더 나은 지시"): author-only rubric, see coaching.js
var privateChannels = null;
var phoneNav = null;
var aiPicker = null;     // 자동 / Claude / Codex / ... chip, "@" list and phone sheet, see ai-picker.js
var localModel = null;   // local-model status for the AI picker, see local-model.js
var renameDialog = null;
var confirmDialog = null;
var skills = null;   // 스킬 sheet, indicator and "+" menu item (skills.js)
var bell = { badge: 0, pending: 0 };   // what social.js last drew on the bell: the phone's top bar mirrors it
// 세션 표시 방식 (A/B/C) and 동작 줄이기: the server's copy arrives with /api/me, localStorage covers first paint.
var sessionLayout = readLayout();
// What the thread showed last, to animate only what is new (a switch of session, a new message).
var chatKey = null;
var chatCount = 0;
// Where the reader was in each feed: coming back to a view lands there at once (scroll-memory.js).
var scrollMemory = createScrollMemory((function () { try { return window.sessionStorage; } catch (_) { return null; } })());
// The last rendered feed of the most recent views, in memory only (view-cache.js). Pruned whenever the room or
// session list changes (a view the viewer lost is never shown again) and cleared on logout / another viewer.
var viewCache = createViewCache();
// The view whose thread is drawn in els.chat (chatOwner / chatSessionId), the key of the view whose markup is on
// screen right now (domKey: null for a skeleton or an empty stand-in) and the markup last written (shownHtml).
var chatOwner = null, chatSessionId = null, domKey = null, shownHtml = "";
// A switch that was asked for but not confirmed yet is already painted from the cache (or a skeleton): previewKey.
// While it is pending, and while the confirmed view's history replays (restorePending), the feed is not redrawn
// per message: one render at history_done reconciles it with what the server sent.
var previewKey = null, previewTimer = null, previewByRoom = false;
var restorePending = null;
var RESTORE_MAX_MS = 2500;
var PREVIEW_MAX_MS = 4000;
// The preview of a private session that is being created: an empty feed, no cache involved.
var CREATING_KEY = "new:private";

function viewKey(id) { return (store.get("currentSlug") || "") + ":" + id; }
function holdingFeed() { return !!restorePending || (previewKey != null && previewKey !== chatOwner); }
function rememberScroll() {
  if (chatOwner == null || domKey !== chatOwner || restorePending || thread.replaying || !els.chat || !thread.items.length) return;
  scrollMemory.save(chatOwner, els.chat, thread.historyFrom);
}
function sessionById(id) {
  var found = null;
  (getCachedSessions() || []).forEach(function (s) { if (s && String(s.id) === String(id)) found = s; });
  return found;
}
// Leaving a view: remember where the reader was and keep its rendered feed for a quick return.
function leaveView() {
  if (chatOwner == null || domKey !== chatOwner || restorePending || thread.replaying || !els.chat || !thread.items.length || !shownHtml) return;
  rememberScroll();
  var s = chatSessionId != null ? sessionById(chatSessionId) : null;
  viewCache.put(chatOwner, { html: shownHtml, roomId: s && s.roomId != null ? s.roomId : null, sessionId: chatSessionId, from: thread.historyFrom });
}
// The feed shows the cached copy of `key` at the place the reader left it, else a light skeleton.
function paintInterim(key) {
  if (!els.chat || domKey === key) return;
  var cached = viewCache.get(key);
  if (key === CREATING_KEY && privateChannels) {
    els.chat.innerHTML = shownHtml = privateChannels.creatingPreamble() + renderThread(createThread(), { emptyText: t("client.emptyChat") });
    domKey = null;
  } else if (cached) {
    els.chat.innerHTML = shownHtml = cached.html;
    domKey = key;
    applyTarget(els.chat, scrollMemory.target(key, cached.from) || { bottom: true });
  } else {
    els.chat.innerHTML = shownHtml = SKELETON_HTML;
    domKey = null;
  }
}
// A switch to `key` (a session's view key, or "room:<id>" while a room's main thread is not known yet) was asked for.
function startPreview(key, byRoom) {
  if (previewKey === key) return;
  previewByRoom = !!byRoom;
  holdComposerHeight();
  leaveView();
  previewKey = key;
  paintInterim(key);
  updateControls();
  clearTimeout(previewTimer);
  previewTimer = setTimeout(function () { previewSpent = key; endPreview(); renderChat(); }, PREVIEW_MAX_MS);
}
// While a view is only painted, its composer is locked (and may lose its mode row): keep its height, so the feed
// above it does not move when the real one comes back.
var composerHeightBefore = 0;   // the composer's height as the last state change found it (before a click locked it)
function holdComposerHeight() {
  if (!els.form || !els.form.style || els.form.style.minHeight) return;
  var h = composerHeightBefore || els.form.offsetHeight;
  if (h) els.form.style.minHeight = h + "px";
}
function endPreview() {
  if (els.form && els.form.style) els.form.style.minHeight = "";
  previewKey = null;
  clearTimeout(previewTimer);
  previewTimer = null;
  if (domKey !== chatOwner) domKey = null;
  updateControls();
}
// Click on a session row: show it now, ask the server in the same breath.
function previewSession(id) {
  var key = viewKey(id);
  if (key === chatOwner && !holdingFeed()) return;
  startPreview(key);
}
// `hold` false: a session that has no history to replay is drawn at once, there is nothing to wait for.
function beginRestore(id, hold) {
  var key = viewKey(id);
  if (restorePending && restorePending.key === key) return;
  endRestore(false);
  leaveView();
  previewSpent = null;
  chatOwner = key;
  chatSessionId = id;
  if (hold === false) {
    if (previewKey != null) endPreview();
    domKey = null;
    return;
  }
  // The empty feed shown while this session was being created is already the right picture for it.
  if (previewKey === CREATING_KEY && !viewCache.has(key)) domKey = key;
  else paintInterim(key);
  restorePending = { key: key, timer: setTimeout(function () { endRestore(true); }, RESTORE_MAX_MS) };
}
// History is in: reconcile the feed with it in one render. A feed painted from the cache whose markup is identical
// is left untouched (nothing moves); otherwise the new markup goes in and the reader keeps their place.
function endRestore(apply) {
  if (!restorePending) return;
  var pending = restorePending;
  restorePending = null;
  clearTimeout(pending.timer);
  if (previewKey != null) endPreview();
  if (!apply || !els.chat) return;
  var onScreen = domKey === pending.key;
  var place = onScreen ? { top: els.chat.scrollTop, atBottom: els.chat.scrollHeight - els.chat.scrollTop - els.chat.clientHeight <= 40 } : null;
  if (commitChat(true)) applyTarget(els.chat, place ? (place.atBottom ? { bottom: true } : { top: place.top }) : (scrollMemory.target(pending.key, thread.historyFrom) || { bottom: true }));
}
// The cache belongs to one viewer: another one signing in on this page starts with nothing, and a changed room list
// drops the views of rooms that left it.
var cacheViewer;
function forgetViewsOfOthers() {
  var me = store.get("myUserId");
  if (cacheViewer !== undefined && cacheViewer !== me) viewCache.clear();
  cacheViewer = me;
  pruneViewCache();
}
// Drop what the viewer may no longer see: every cached view of a room or session that left the lists.
function pruneViewCache() {
  var rooms = store.get("rooms");
  var roomIds = Array.isArray(rooms) ? rooms.map(function (r) { return String(r.id); }) : null;
  var sessions = getCachedSessions();
  var sessionIds = sessionListSeen && Array.isArray(sessions) ? sessions.map(function (s) { return String(s.id); }) : null;
  viewCache.prune(function (e) { return visibleEntry(e, roomIds, sessionIds); });
  // A feed painted from the cache for a view that is gone is not kept on screen.
  if (previewKey != null && previewKey !== chatOwner && domKey === previewKey && !viewCache.has(previewKey)) { domKey = null; endPreview(); renderChat(); }
}
// The server still has this session open on the socket after the person picked
// another room; the client dropped it (activeSessionId null) until the room's
// main thread is open, and must not adopt it back from a later session_list.
var parkedSessionId = null;
// The room whose main thread was asked for and has not been switched to yet.
var openingRoomId = null;
// ensureRoomMainOpen waits for the first session list: until then "no open
// session" only means "not loaded yet", and a restored session must not be replaced.
var sessionListSeen = false;
// The last room a session belonged to, to fall back on when a room-less one is open.
var lastRoomId = null;
var rowMenus = null;
var myName = "";
var serverPresenceSeen = false;
// Who is looking, for the row menus. Unknown permission = offer, the server decides.
var viewer = { isAdmin: false, canDeleteSessions: true };

export function slugFromPath(pathname) {
  var m = /^\/p\/([a-z0-9_-]+)/.exec(pathname || "");
  return m ? m[1] : null;
}

// --- Small UI helpers ----------------------------------------------------------------

function toast(text) {
  if (!els.toast) return;
  els.toast.textContent = text;
  els.toast.classList.add("is-on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { els.toast.classList.remove("is-on"); }, 3200);
  if (toastTimer && typeof toastTimer.unref === "function") toastTimer.unref();
}

var connLabel = null;   // () => text of the connection indicator; redrawn on a language change
var lostConnection = false;   // the socket closed (or never opened): drives the offline banner
function setOfflineBanner() {
  var bar = document.getElementById("ai-offline");
  if (!bar) return;
  var on = lostConnection && !connected && !unauthenticated;
  bar.classList.toggle("hidden", !on);
  bar.textContent = on ? t("client.offlineBanner") : "";
}
function setConnState(state, label) {
  connected = state === "connected";
  if (connected) lostConnection = false;
  connLabel = label;
  if (els.connText) els.connText.textContent = label();
  if (els.connDot) els.connDot.setAttribute("data-state", state);
  setOfflineBanner();
  updateControls();
  if (sharedPosts) sharedPosts.setConnected(connected);
  if (privateChannels) {
    privateChannels.setConnected(connected);
    if (connected) privateChannels.request();
  }
  if (skills) skills.setConnected(connected);
}

function activeSession() {
  var id = store.get("activeSessionId");
  var active = null;
  (getCachedSessions() || []).forEach(function (s) { if (s.id === id) active = s; });
  return active;
}

// A session with no room is old private history. It stays readable and usable
// as-is, but it is not the selected room's conversation: it is never shared
// and never orchestrated until the owner starts a room-bound session.
function isLegacySession(s) {
  return !!s && s.roomId == null;
}

function currentRoom() {
  var rooms = store.get("rooms") || [];
  var active = activeSession();
  var roomId = resolveActiveRoomId(rooms, store.get("selectedRoomId"), active);
  for (var i = 0; i < rooms.length; i++) if (rooms[i].id === roomId) return rooms[i];
  return null;
}

// The room shown as selected and the room of the open session disagree. The
// server sends a message to the socket's open session, so the composer and the
// thread must not treat that session as the selected room's conversation.
// Room-less (legacy) sessions are not a mismatch; they are labelled instead.

function sessionInOtherRoom() {
  var active = activeSession();
  var room = currentRoom();
  return !!(active && active.roomId != null && room && String(active.roomId) !== String(room.id));
}

// An open session that the session cache does not (yet) contain cannot be
// proven to belong to the selected room, so it is treated as out of scope.
function sessionUnverified() {
  return store.get("activeSessionId") != null && !activeSession() && !!currentRoom();
}

// A room is selected but the open session is not one of its sessions (room-less
// legacy, none, or another room's): its main thread is still to be opened. The
// composer stays locked meanwhile, so nothing is ever sent into the open one.
function roomSessionNeeded() {
  var room = currentRoom();
  if (!room) return false;
  if (store.get("activeSessionId") == null) return true;
  var active = activeSession();
  return !!active && (isLegacySession(active) || sessionInOtherRoom());
}

// "AI에게 지시" (agents) or "조원에게 메시지" (members only), remembered per room.
// Private sessions and read-only members never get the choice.
var MODE_KEY = "aigora.sendMode.";
var memoryModes = {};
function sendModeAvailable() {
  var room = currentRoom();
  var access = privateChannels ? privateChannels.getAccess() : null;
  return !!room && room.role !== "viewer" && !roomSessionNeeded() && !(access && access.isPrivate);
}
// The AI picker is also offered in the owner's own private session (Claude, Codex, allowed endpoints); a member message is not.
function pickerPrivate() { var a = privateChannels ? privateChannels.getAccess() : null; return !!(a && a.isPrivate); }
function pickerAvailable() {
  if (sendModeAvailable()) return true;
  var a = privateChannels ? privateChannels.getAccess() : null, room = currentRoom();
  return !!(a && a.isPrivate && a.owner && !a.readOnly && room && room.role !== "viewer");
}
function sendMode() {
  var room = currentRoom();
  if (!room || !sendModeAvailable()) return "ai";
  try { return localStorage.getItem(MODE_KEY + room.id) === "member" ? "member" : "ai"; } catch (e) { return memoryModes[room.id] === "member" ? "member" : "ai"; }
}
function setSendMode(mode) {
  var room = currentRoom();
  if (!room) return;
  memoryModes[room.id] = mode;
  try { localStorage.setItem(MODE_KEY + room.id, mode); } catch (e) { /* applies for this visit only */ }
  updateControls();
}
var chipMode = null; // the mode the file chips were last drawn for
function renderSendMode() {
  var on = sendModeAvailable();
  var pickerOn = pickerAvailable();
  els.sendMode.classList.toggle("hidden", !on);
  els.modes.classList.toggle("hidden", !pickerOn);
  var mode = sendMode();
  els.sendMode.setAttribute("data-mode", mode);
  if (chipMode !== mode) { chipMode = mode; renderAttachments(); }
  els.sendMode.querySelectorAll("[data-send-mode]").forEach(function (b) {
    b.setAttribute("aria-pressed", b.getAttribute("data-send-mode") === mode ? "true" : "false");
  });
  var chAccess = privateChannels ? privateChannels.getAccess() : null;   // 나만의 채널 is not "this room"
  els.input.placeholder = on && mode === "member" ? t("composer.placeholderMember") : chAccess && chAccess.isPrivate ? t("composer.placeholderChannel") : t("composer.placeholderAi");
  // The phone's composer shows the same choice as one small chip (a tap switches).
  var chip = modeChip(mode);
  els.modeChip.classList.toggle("hidden", !pickerOn);
  els.modeChip.textContent = chip.text;
  els.modeChip.setAttribute("aria-label", chip.label);
  els.modeChip.setAttribute("title", chip.label);
  els.modeChip.setAttribute("data-mode", mode);
  if (aiPicker) { var pr = currentRoom(); aiPicker.render(pr ? String(pr.id) + (pickerPrivate() ? ":" + store.get("activeSessionId") : "") : ""); }
}

// Picking a room: drop the other room's session from the client state instead of
// only hiding it; the room's main thread replaces it (openRoomMain).
function detachFromOtherRoom() {
  var active = activeSession();
  var room = currentRoom();
  if (!active || active.roomId == null || !room || String(active.roomId) === String(room.id)) return;
  parkedSessionId = active.id;
  store.set({ activeSessionId: null });
}

// Only an admin decides a tool permission; a room owner who is not an admin waits like everyone else.
function canApprove() {
  return !!viewer.isAdmin;
}

// The turn is running or waiting for a slot ("대기 중 · n번째").
function isTurnBusy() { return !!(thread.processing || thread.queued > 0); }

// Who may stop it: its requester, the room owner or an admin. The requester is the author of the latest user
// message in the thread; an unknown author is left to the server, which enforces the same rule.
function canStopTurn() {
  var room = currentRoom();
  if (canApprove() || (room && room.role === "owner")) return true;
  for (var i = thread.items.length - 1; i >= 0; i--) {
    var it = thread.items[i];
    if (it.role !== "user") continue;
    return !!it.local || !it.name || it.name === myName;
  }
  return true;
}

function sendIsStop() { return isTurnBusy() && composerState().ok; }

function offlineQueueAllowed() {
  if (!activeSession() || sessionUnverified() || roomSessionNeeded() || (previewKey != null && previewKey !== chatOwner)) return false;
  var room = currentRoom();
  if (store.get("selectedRoomId") != null && !room) return false;
  if (room && room.role === "viewer") return false;
  var access = privateChannels ? privateChannels.getAccess() : null;
  return !(access && access.isPrivate && access.readOnly);
}

// Who may type: a live socket, an active session, and not a read-only viewer.
function composerState() {
  if (unauthenticated) return { ok: false, note: t("client.noteExpired") };
  // Offline: the box stays usable so a draft is not lost; sending is what waits (the note and a toast say so).
  if (!connected) return { ok: false, offline: true, queueAllowed: offlineQueueAllowed(), note: lostConnection ? t("client.noteOffline") : t("client.noteConnecting") };
  if (previewKey === CREATING_KEY) return { ok: true, note: "" };   // type already; sending waits for the session (submitMessage)
  if (previewKey != null && previewKey !== chatOwner && !previewByRoom) return { ok: false, note: t("client.noteOpeningSession") };   // a room preview is locked by roomSessionNeeded() below
  if (store.get("activeSessionId") == null && !roomSessionNeeded()) return { ok: false, note: t("client.notePickSession") };
  if (sessionUnverified()) return { ok: false, note: t("client.noteLoadingSession") };
  // The open session is not the selected room's: its main thread is being opened.
  if (roomSessionNeeded()) {
    return { ok: false, note: currentRoom().role === "viewer" ? t("client.noteViewerOnly") : t("client.noteOpeningRoom") };
  }
  if (isLegacySession(activeSession())) {
    return { ok: true, note: t("client.noteLegacy") };
  }
  var privateAccess = privateChannels ? privateChannels.getAccess() : null;
  if (privateAccess && privateAccess.isPrivate && privateAccess.readOnly) {
    return { ok: false, note: privateAccess.adminReadOnly ? t("client.noteAdminReadOnly") : t("client.noteClosedChannel") };
  }
  var room = currentRoom();
  if (room && room.role === "viewer") return { ok: false, note: t("client.noteViewerOnly") };
  return { ok: true, note: "" };
}

function updateControls() {
  if (!els.input) return;
  var st = composerState();
  els.input.disabled = !st.ok && !st.offline;
  var stopping = sendIsStop();
  els.send.disabled = !!queuedSend || (!st.ok && !st.queueAllowed) || (stopping && !canStopTurn());
  els.send.textContent = stopping ? "■" : "↑";
  els.send.setAttribute("aria-label", stopping ? t("composer.stop") : t("composer.send"));
  els.send.setAttribute("data-stop", stopping ? "1" : "0");
  if (stopping && els.send.disabled) els.send.setAttribute("title", t("composer.stopDenied"));
  else if (stopping) els.send.setAttribute("title", t("composer.stop"));
  else els.send.removeAttribute("title");
  els.note.textContent = queuedSend ? "" : st.note;
  renderQueuedSend();
  renderSendMode();
  // The room is one shared feed: 새 세션 belongs to 나만의 채널 only.
  var access = privateChannels ? privateChannels.getAccess() : null;
  var canNew = !!(connected && access && access.isPrivate && access.owner && (!access.readOnly || access.closed) && privateChannels.canStartNew());
  els.newSession.classList.toggle("hidden", !canNew);
  els.newSession.disabled = !canNew;
  if (attachmentsUi) attachmentsUi.refresh();
  if (officeUi) officeUi.onContext();
  syncPanelScope();
  syncChrome();
  refreshPhone();
}

// Every modal dialog keeps Tab inside itself and closes on Escape, whichever module opened it (a dialog that lost its focus,
// e.g. the focused button became disabled, would otherwise let Tab walk into the page behind it).
var TABBABLE = "a,button,input,select,textarea,[tabindex]";
function tabbable(el) {
  if (el.disabled || el.hasAttribute("hidden") || el.getAttribute("tabindex") === "-1") return false;
  if (el.tagName === "A" && !el.hasAttribute("href")) return false;
  if (el.tagName === "INPUT" && el.getAttribute("type") === "hidden") return false;
  return el.offsetParent !== null || el === document.activeElement;
}
function topModal() {
  var list = Array.prototype.slice.call(document.querySelectorAll("[aria-modal]")).filter(function (d) {
    return d.getAttribute("aria-modal") === "true" && !d.classList.contains("hidden") && !d.hasAttribute("hidden") && !d.hasAttribute("inert");
  });
  return list.length ? list[list.length - 1] : null;
}
function initDialogSafety() {
  document.addEventListener("keydown", function (ev) {
    if (ev.defaultPrevented) return;
    var dlg = topModal();
    if (!dlg) return;
    if (ev.key === "Escape") {
      // Sheets built on the fly (backups, confirms in 방 관리) have no handler of their own.
      if (dlg.classList.contains("att-sheet-layer")) { ev.preventDefault(); dlg.remove(); }
      return;
    }
    if (ev.key !== "Tab") return;
    var items = Array.prototype.slice.call(dlg.querySelectorAll(TABBABLE)).filter(tabbable);
    if (!items.length) return;
    var active = document.activeElement, inside = !!(active && dlg.contains(active));
    var first = items[0], last = items[items.length - 1];
    if (!inside || (ev.shiftKey && active === first) || (!ev.shiftKey && active === last)) {
      ev.preventDefault();
      (ev.shiftKey && inside ? last : first).focus();
    }
  });
}

function refreshPhone() { if (phoneNav) phoneNav.refresh(); }

// Classes on #layout that CSS reads: the crowding rule (list column + inspector together fold the
// sidebar below 1440px) and the sidebar pinned open again from the header button.
function syncChrome() {
  var layout = document.getElementById("layout");
  if (!layout) return;
  var access = privateChannels ? privateChannels.getAccess() : null;
  var w = window.innerWidth;
  var mid = typeof w === "number" && w > 1023 && w <= COLUMN_MAX_PX;
  var crowded = isCrowded({ layout: shownLayout(), privateOpen: !!(access && access.isPrivate), inspectorOpen: !!store.get("agoraPanelOpen"), midWidth: mid });
  layout.classList.toggle("is-crowded", crowded);
  layout.classList.toggle("is-side-pinned", crowded && !!store.get("sidePinned"));
  // A sidebar that is folded away (crowded, not pinned, below 1440px; on a phone phone-nav.js does this) is not a Tab stop.
  var side = document.getElementById("ai-sidebar");
  var phone = !!(window.matchMedia && window.matchMedia("(max-width: 768px)").matches);
  if (side && !phone) {
    var folded = crowded && !store.get("sidePinned") && typeof w === "number" && w < 1440;
    if (folded) side.setAttribute("inert", ""); else side.removeAttribute("inert");
  }
}

// A person picked another 세션 표시 방식 (설정 > 일반) or the server told us theirs.
// Tablet widths show the session list as the popover (A) even when the saved choice is C.
function shownLayout() { return effectiveLayout(sessionLayout, window.innerWidth); }
function useLayout(layout) {
  sessionLayout = normalizeLayout(layout);
  applyLayout(shownLayout());
  saveLayout(sessionLayout);
  if (privateChannels) privateChannels.setLayout(shownLayout());
  syncChrome();
}
// 나만의 채널 opens with the inspector closed unless it was last opened there; a room restores its own choice.
var panelScopePrivate = null;
function syncPanelScope() {
  var access = privateChannels ? privateChannels.getAccess() : null;
  var priv = !!(access && access.isPrivate);
  if (priv === panelScopePrivate) return;
  panelScopePrivate = priv;
  var narrow = window.matchMedia && window.matchMedia("(max-width: 1023px)").matches;
  if (narrow) return;
  var want = priv ? readChannelInspector() : readInspector();
  if (!!store.get("agoraPanelOpen") !== want) store.set(want ? { agoraPanelOpen: true } : { agoraPanelOpen: false, sidePinned: false });
}
function watchViewport() {
  if (!window.matchMedia) return;
  var mq = window.matchMedia("(max-width: " + COLUMN_MAX_PX + "px)");
  var again = function () { if (sessionLayout === "C") { applyLayout(shownLayout()); if (privateChannels) privateChannels.setLayout(shownLayout()); } syncChrome(); };
  if (mq.addEventListener) mq.addEventListener("change", again); else if (mq.addListener) mq.addListener(again);
}

function useCoaching(on) {
  saveCoaching(!!on);
  if (coaching) coaching.setEnabled(!!on);
}

function useReduceMotion(on) {
  applyReduceMotion(!!on);
  saveReduceMotion(!!on);
}

// The language changed (i18n.js onLangChange): redraw the static markup, then what is built from words.
// Each module that draws text once registers its own onLangChange (settings.js does); the composer is here.
function rerenderLanguage() {
  applyDom(document);
  if (connLabel && els.connText) els.connText.textContent = connLabel();
  setOfflineBanner();
  updateControls();   // draws the composer (renderSendMode, AI picker)
  renderChat();   // empty-feed text, approval cards, comment threads
}

function saveDisplayPrefs(patch) {
  fetch("/api/user/display-prefs", {
    method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
  }).then(function (res) {
    if (!res.ok) throw new Error("HTTP " + res.status);
  }).catch(function () { toast(t("client.toastPrefsNotSaved")); });
}

// The open session is the selected room's main thread (its shared feed).
function isRoomMainActive() {
  var active = activeSession();
  return !!active && active.roomMain === true && !sessionInOtherRoom();
}

// A room-less legacy thread belongs to no room, so it is never drawn under the selected one.
function legacyUnderRoom() {
  return isLegacySession(activeSession()) && !!currentRoom();
}

// Marks a preview that ran out of time, so the same one is not painted again and again.
var previewSpent = null;

// A selected room whose main thread is not open yet is painted at once: its cached feed when it has one, else a skeleton.
function roomPreview() {
  // A room's preview ends by itself once the open session is the selected room's after all (e.g. the session list arrived).
  if (previewByRoom && previewKey != null && previewKey !== CREATING_KEY && !restorePending && !roomSessionNeeded()) { domKey = null; endPreview(); }
  if (previewKey === CREATING_KEY && !(privateChannels && privateChannels.isCreating())) { domKey = null; endPreview(); }
  if (privateChannels && privateChannels.isCreating() && !restorePending) {
    var fresh = previewKey !== CREATING_KEY;
    startPreview(CREATING_KEY);
    if (fresh && els.input && !els.input.disabled && els.input.focus) els.input.focus();
    return;
  }
  if (restorePending || previewKey != null) return;
  var room = currentRoom();
  if (!room || !connected || !roomSessionNeeded()) return;
  var main = null;
  (getCachedSessions() || []).forEach(function (s) { if (s && s.roomMain === true && String(s.roomId) === String(room.id)) main = s; });
  var key = main ? viewKey(main.id) : "room:" + room.id;
  if (previewSpent === key) return;
  startPreview(key, true);
}

function renderChat() {
  if (!els.chat) return;
  roomPreview();
  if (holdingFeed()) { refreshPhone(); return; }
  commitChat(false);
  refreshPhone();
}

// Draw the open thread. `reconcile` (the history just finished) leaves the feed untouched when its markup is what is
// already on screen; returns whether the markup was replaced.
var scrollOwnSend = false;
function commitChat(reconcile) {
  var near = els.chat.scrollHeight - els.chat.scrollTop - els.chat.clientHeight < 120;
  var restoreFocus = social ? social.captureFocus() : function () {};
  var privatePreamble = privateChannels ? privateChannels.chatPreamble() : "";
  var elsewhere = sessionInOtherRoom() || legacyUnderRoom() || parkedSessionId != null;
  var html = privatePreamble + renderThread(elsewhere ? createThread() : thread, {
    extra: social ? social.extra : undefined,
    coachChip: coaching ? coaching.chipFor : undefined,
    attachCard: attachmentsUi ? attachmentsUi.cardHtml : undefined,
    canApprove: canApprove(),
    canAnswerAsk: canAnswerAsk(),
    endpointLabel: function (id) { var st = localModel && localModel.status(); var e = st && Array.isArray(st.endpoints) ? st.endpoints.filter(function (x) { return x && x.id === id; })[0] : null; return e ? e.label : id; },
    myUserId: store.get("myUserId"),
    emptyText: roomSessionNeeded() ? t("client.noteOpeningRoom") : store.get("activeSessionId") == null ? t("client.notePickSession") : isRoomMainActive() ? t("client.emptyRoom") : t("client.emptyChat"),
  });
  var onScreen = reconcile && !elsewhere && domKey === chatOwner;
  var wrote = !(onScreen && html === shownHtml);
  if (wrote) els.chat.innerHTML = shownHtml = html;
  domKey = elsewhere ? null : chatOwner;
  restoreFocus();
  if (attachmentsUi) attachmentsUi.renderInbox();
  if (wrote && (near || scrollOwnSend || thread.items.length <= 1)) els.chat.scrollTop = els.chat.scrollHeight;
  animateChat(onScreen);
  return wrote;
}

// A switch of room or session rises the whole thread in; afterwards only the messages that are new. A feed that was
// already on screen (painted from the cache) is not faded in again.
function animateChat(quiet) {
  var key = store.get("activeSessionId");
  var rows = els.chat.querySelectorAll(".message");
  if (key !== chatKey) {
    chatKey = key;
    if (!quiet) riseIn(els.chat);
  } else if (!quiet) {
    for (var i = chatCount; i < rows.length; i++) riseIn(rows[i]);
  }
  chatCount = rows.length;
}

// Files picked for the NEXT message show as chips next to the image chips in both modes, so a mode switch never hides or drops one;
// the next send (to the AI or to members) takes them.
function pickedFiles() { return attachmentsUi ? attachmentsUi.picked() : []; }
function renderAttachments() {
  var files = pickedFiles();
  els.attachments.classList.toggle("hidden", attachments.length === 0 && files.length === 0);
  els.attachments.innerHTML = files.map(fileChipHtml).join("");
  Array.prototype.forEach.call(els.attachments.querySelectorAll("[data-remove-file]"), function (b) {
    b.addEventListener("click", function () { attachmentsUi.removePicked(b.getAttribute("data-remove-file")); });
  });
  attachments.forEach(function (a, i) {
    var chip = document.createElement("span");
    chip.className = "ai-chip ai-chip-image";
    // A real thumbnail of the picked photo (the one made for the feed), so it can be told apart before sending.
    var src = a.thumb || (a.mediaType && a.data ? "data:" + a.mediaType + ";base64," + a.data : "");
    if (src) {
      var img = document.createElement("img");
      img.className = "ai-chip-thumb";
      img.alt = "";
      img.src = src;
      chip.appendChild(img);
    }
    var nameEl = document.createElement("span");
    nameEl.className = "ai-chip-name";
    nameEl.textContent = a.name;
    chip.appendChild(nameEl);
    var rm = document.createElement("button");
    rm.type = "button";
    rm.setAttribute("aria-label", t("client.removeAttachment", { name: a.name }));
    rm.setAttribute("data-remove-attachment", String(i));
    rm.textContent = "×";
    rm.addEventListener("click", function () { attachments.splice(i, 1); renderAttachments(); });
    chip.appendChild(rm);
    els.attachments.appendChild(chip);
  });
}

// --- Server messages -------------------------------------------------------------------

// New-version notice: the page's build (meta, written by the server when it served the page) against the one the server
// announces in its "info" frame. Only a RE-connect can raise it, and it is never an auto-reload: the user may be typing.
var DRAFT_KEY = "aigora.draftBeforeReload";
var connectCount = 0;
function pageBuild() {
  var m = document.querySelector('meta[name="aigora-build"]');
  return (m && m.getAttribute("content")) || "";
}
function checkBuild(announced) {
  var mine = pageBuild();
  if (connectCount < 2 || !announced || !mine || announced === mine) return;
  var btn = document.getElementById("ai-update");
  if (btn) btn.classList.remove("hidden");
}
function reloadForUpdate() {
  try { if (els.input && els.input.value) window.sessionStorage.setItem(DRAFT_KEY, els.input.value); } catch (e) { /* reload anyway */ }
  location.reload();
}
function restoreDraft() {
  try {
    var d = window.sessionStorage.getItem(DRAFT_KEY);
    if (d == null) return;
    window.sessionStorage.removeItem(DRAFT_KEY);
    if (els.input && !els.input.value) els.input.value = d;
  } catch (e) { /* no storage */ }
}

export function handleServerMessage(msg) {
  if (!msg || typeof msg.type !== "string") return;
  if (msg.type === "info") checkBuild(msg.build);
  if (queuedSend && (queuedSend.state === "sending" || (queuedSend.error === "client.queueUnconfirmed" && queuedSend.dispatchedGen === connectGen))) {
    if (msg.type === "message_ack" && msg.mid) {
      clearTimeout(queuedTimer);
      if (queueDisk) queueDisk.clear(queuedSend);
      queuedSend = null;
      renderQueuedSend();
      updateControls();
    } else if (msg.type === "error") failQueuedSend("client.queueUnconfirmed");
  }
  if (msg.type === "error" && (msg.code === "attach_refused" || msg.code === "agent_refused")) { onTurnRefused(msg.text); return; }
  if (msg.type === "error") abandonPreview();
  if (sharedPosts && sharedPosts.handle(msg)) return;
  if (coaching && coaching.handle(msg)) return;
  if (skills && skills.handle(msg)) return;
  if (msg.type === "error" && privateChannels && privateChannels.handle(msg)) return;
  if (msg.type === "social_state") {
    if (msg.sessionLocalId != null && String(msg.sessionLocalId) !== String(store.get("activeSessionId"))) return;
    mentionRoster = { roomId: msg.roomId, sessionId: store.get("activeSessionId"), people: Array.isArray(msg.mentionMembers) ? msg.mentionMembers : [] };
    if (aiPicker) aiPicker.render();
  }
  if (msg.type === "session_switched" || msg.type === "rooms_state") mentionRoster = null;
  if (social && social.handle(msg)) return;
  switch (msg.type) {
    case "rooms_state":
      handleRoomsState(msg);
      if (queuedSend && queuedSend.state === "waiting") queuedSend.roomsReady = true;
      if (store.get("selectedRoomId") == null) {
        var rooms = store.get("rooms") || [];
        var openOne = activeSession();
        // A restored room session already names its room; do not override it.
        if (rooms[0] && !(openOne && openOne.roomId != null)) store.set({ selectedRoomId: rooms[0].id });
      }
      refreshAgora();
      updateControls();
      if (sessionListSeen) ensureRoomMainOpen();
      flushQueuedSend();
      return;
    // Who is online (the 참여자 tab): the server-wide list wins; this project's own list covers the
    // moment before the first server-wide one arrives.
    case "projects_updated":
      if (Array.isArray(msg.serverUsers)) {
        serverPresenceSeen = true;
        store.set({ cachedOnlineIds: msg.serverUsers.map(function (u) { return String(u.id); }) });
      }
      return;
    case "client_count":
      if (!serverPresenceSeen && Array.isArray(msg.users)) store.set({ cachedOnlineIds: msg.users.map(function (u) { return String(u.id); }) });
      return;
    case "channel_state":
      store.set({ personalChannels: msg });
      if (privateChannels) privateChannels.handle(msg);
      return;
    case "session_list": {
      var list = Array.isArray(msg.sessions) ? msg.sessions : [];
      sessionListSeen = true;
      setSessions(list);
      if (queuedSend && queuedSend.state === "waiting" && connected) {
        var target = queuedTarget(list);
        if (!target) failQueuedSend("client.queueFailed");
      }
      pruneViewCache();
      var active = null;
      list.forEach(function (s) { if (s && s.active) active = s; });
      if (active && active.id !== store.get("activeSessionId") && active.id !== parkedSessionId) store.set({ activeSessionId: active.id });
      if (privateChannels) privateChannels.onSessionsChanged();
      if (phoneNav) phoneNav.onSessionChanged();
      refreshAgora();
      updateControls();
      renderChat();
      ensureRoomMainOpen();
      flushQueuedSend();
      return;
    }
    case "session_switched": {
      leaveView();
      beginRestore(msg.id, msg.hasHistory === true);
      var sessions = (getCachedSessions() || []).map(function (s) {
        return Object.assign({}, s, { active: s.id === msg.id });
      });
      setSessions(sessions);
      openingRoomId = null;
      parkedSessionId = null;
      thread = createThread();
      narrator.reset();
      thread.processing = !!msg.isProcessing;
      store.set({ activeSessionId: msg.id });
      if (queuedSend && queuedSend.state === "waiting") queuedSend.confirmed = String(msg.id) === String(queuedSend.sessionId);
      var switchedTo = activeSession();
      if (switchedTo && switchedTo.roomId != null) lastRoomId = String(switchedTo.roomId);
      if (privateChannels) privateChannels.onSessionChanged();
      if (phoneNav) phoneNav.onSessionChanged();
      refreshAgora();
      if (social) social.onSessionChanged(msg.id);
      renderChat();
      updateControls();
      ensureRoomMainOpen();
      flushQueuedSend();
      return;
    }
    case "history_prepend": {
      // Older turns go above the current ones; the reader's place on screen must not move.
      var keepHeight = els.chat.scrollHeight, keepTop = els.chat.scrollTop;
      if (applyMessage(thread, msg, { sessionId: store.get("activeSessionId") })) {
        renderChat();
        els.chat.scrollTop = keepTop + (els.chat.scrollHeight - keepHeight);
      }
      return;
    }
    case "session_narration":
      handleSessionNarration(msg);
      refreshPhone();
      return;
    case "orchestration_event":
      handleOrchestrationEvent(msg);
      // A run's terminal state ends the busy line of its own session only.
      if (applyMessage(thread, msg, { sessionId: store.get("activeSessionId") })) {
        renderChat();
        updateControls();
      }
      return;
    default: {
      var changed = applyMessage(thread, msg, { sessionId: store.get("activeSessionId") });
      if (msg.type === "history_meta") { narrator.reset(); if (store.get("activeSessionId") != null) beginRestore(store.get("activeSessionId")); }
      if (msg.type === "message_ack") {
        // The own message is known by its id only now: narrate it once, under that id.
        var acked = thread.items.filter(function (it) { return it.role === "user" && it.mid === msg.mid; })[0];
        if (acked) narrate({ type: "user_message", text: acked.text, _mid: msg.mid, _ts: Date.now() });
      } else narrate(msg);
      if (changed && msg.type === "tool_executing" && msg.name === "AskUserQuestion" && !thread.replaying) {
        var live = document.getElementById("ai-perm-live");
        if (live) live.textContent = t("client.announceAsk");
      }
      if (changed && (msg.type === "permission_request" || msg.type === "permission_request_pending") && !thread.replaying) announcePermission(msg);
      if (changed && !holdingFeed()) {
        renderChat();
        updateControls();
      } else if (msg.type === "history_done") updateControls();
      if (msg.type === "history_done") { endRestore(true); flushQueuedSend(); }
    }
  }
}

// --- Actions ---------------------------------------------------------------------------

// The requesting member may decide their own turn's request when the room allows it (the server re-checks).
function requesterOf(requestId) {
  var me = store.get("myUserId");
  return me != null && thread.items.some(function (it) { return it.role === "permission" && it.requestId === requestId && it.requesterId === me; });
}

// The legacy console's wire format: the card resolves when the server's permission_resolved comes back, for
// every viewer alike. The server re-checks that the sender is the room owner or an admin.
function decidePermission(requestId, decision) {
  if (!requestId || (decision !== "allow" && decision !== "deny") || !(canApprove() || requesterOf(requestId))) return false;
  if (!sendJson({ type: "permission_response", requestId: requestId, decision: decision })) { toast(t("client.toastDecisionLost")); return false; }
  return true;
}

// Who may answer Claude's question: in a private channel only its owner (the server's owner-only "active" class for
// ask_user_response); in a room any member who is not a viewer. Everyone else sees the card read-only.
function canAnswerAsk() {
  var access = privateChannels ? privateChannels.getAccess() : null;
  if (access && access.isPrivate) return !!(access.owner && !access.readOnly);
  var room = currentRoom();
  return !(room && room.role === "viewer");
}

function askCard(ev, attr) {
  var el = ev.target && ev.target.closest && ev.target.closest("[" + attr + "]");
  if (!el) return null;
  var item = findAsk(thread, el.getAttribute(attr));
  if (!item || !isLive(item, thread) || item.submitting || !canAnswerAsk()) return null;
  return { el: el, item: item, qi: Number(el.getAttribute("data-ask-q")) };
}

function submitAsk(item) {
  var payload = buildResponse(item);
  if (!payload) return;
  item.submitting = true;
  if (!sendJson(payload)) { item.submitting = false; toast(t("client.toastAskLost")); }
  renderChat();
}

// 👍/👎 on an automatically routed request. The buttons settle at once; the server stores only the first value.
function sendRouteFeedback(routeId, value) {
  if (startRouteFeedback(thread, routeId, value) === null) return;
  if (!sendJson({ type: "run_feedback", routeId: routeId, value: value })) { undoRouteFeedback(thread, routeId); toast(t("decision.feedbackLost")); }
  renderChat();
}

// The existing `stop` message: cancels a queued turn or aborts the running one (and denies what it waits on).
function stopTurn() {
  if (!isTurnBusy() || !canStopTurn()) return false;
  return sendJson({ type: "stop" });
}

// The "이전 대화 더 보기" control: ask the server for the complete turns that precede what is shown.
function loadEarlier() {
  if (!thread.earlierHidden || thread.loadingEarlier) return;
  if (!sendJson({ type: "load_more_history", before: thread.historyFrom })) { toast(t("client.toastHistoryLost")); return; }
  thread.loadingEarlier = true;
  renderChat();
}

// New request for a screen reader (live only, not a replay of history).
function announcePermission(msg) {
  var live = document.getElementById("ai-perm-live");
  if (!live) return;
  live.textContent = t("client.announceApproval", { tool: msg.toolName || t("client.toolFallback") }) + (canApprove() ? t("client.announceApprovalChoose") : t("client.announceApprovalWait"));
}

// Narration for a frame of the open session's turn; ids are stable, so replays merge in place.
function narrate(msg) {
  var sid = store.get("activeSessionId");
  if (sid == null) return;
  var entries = narrator.feed(msg);
  if (entries.length) handleSessionNarration({ sessionId: sid, replace: false, entries: entries });
}

function sendJson(obj) {
  var ws = getWs();
  if (!ws || ws.readyState !== 1) return false;
  try { ws.send(JSON.stringify(obj)); return true; }
  catch (_) { return false; } // socket may close between readyState and send
}

// The server refused this turn (a private channel whose AI execution is off, or unavailable): say so in the
// thread, stop the "working" state and hand the draft and its images back for another try.
function onTurnRefused(reason) {
  var inFlight = thread.processing;
  applyMessage(thread, { type: "turn_refused", text: reason });
  thread.processing = false;
  thread.activity = "";
  if (lastSent && inFlight) {
    if (lastSent.text) els.input.value = els.input.value.trim() ? lastSent.text + "\n" + els.input.value : lastSent.text;
    attachments = lastSent.images.concat(attachments).slice(0, MAX_IMAGES);
    if (lastSent.files && lastSent.files.length && attachmentsUi) attachmentsUi.setPicked(lastSent.files);
    if (lastSent.agent && aiPicker) aiPicker.set(lastSent.agent);
    lastSent = null;
    renderAttachments();
    autosize();
  }
  renderChat();
  updateControls();
}

function renderQueuedSend() {
  var bar = document.getElementById("ai-queued");
  if (!bar) return;
  bar.classList.toggle("hidden", !queuedSend);
  if (!queuedSend) return;
  var status = document.getElementById("ai-queued-status");
  status.setAttribute("role", queuedSend.state === "failed" ? "alert" : "status");
  status.textContent = t(queuedSend.error || (queuedSend.state === "sending" ? "client.queueConfirming" : "client.queueWaiting"));
  var cancel = document.getElementById("ai-queued-cancel");
  cancel.disabled = queuedSend.state === "sending";
  cancel.textContent = t(queuedSend.state === "failed" ? "client.queueRestore" : "client.queueCancel");
}

function failQueuedSend(key) {
  if (!queuedSend || queuedSend.state === "failed") return;
  clearTimeout(queuedTimer);
  queuedSend.state = "failed";
  queuedSend.error = key;
  if (queueDisk) queueDisk.save(queuedSend);
  updateControls();
}

function dropQueuedSend() {
  clearTimeout(queuedTimer);
  queuedSend = null;
  updateControls();
}

function cancelQueuedSend() {
  var q = queuedSend;
  if (!q || q.state === "sending") return;
  clearTimeout(queuedTimer);
  if (queueDisk) queueDisk.clear(q);
  queuedSend = null;
  // Usually the draft is still present. Preserve both if the user edited it.
  if (els.input.value !== q.draft) els.input.value = q.draft + (els.input.value ? "\n" + els.input.value : "");
  attachments = q.images.concat(attachments.filter(function (im) { return q.images.indexOf(im) === -1; })).slice(0, MAX_IMAGES);
  if (attachmentsUi && q.files.length) attachmentsUi.setPicked(q.files.concat(pickedFiles().filter(function (f) { return !q.files.some(function (it) { return it.id === f.id; }); })));
  renderAttachments();
  autosize();
  updateControls();
  els.input.focus();
}

function retryQueuedSend() {
  var q = queuedSend;
  if (!q || q.state !== "waiting") return;
  clearTimeout(queuedTimer);
  q.retries = (q.retries || 0) + 1;
  var delay = Math.min(10000, 500 * Math.pow(2, Math.min(q.retries - 1, 5)));
  q.retryAt = Date.now() + delay;
  if (queueDisk) queueDisk.save(q);
  queuedTimer = setTimeout(function () {
    if (queuedSend !== q || q.state !== "waiting") return;
    q.retryAt = 0;
    if (connected && !q.roomsReady) refreshQueuedRooms();
    flushQueuedSend();
  }, delay);
  if (queuedTimer && queuedTimer.unref) queuedTimer.unref();
  updateControls();
}

function refreshQueuedRooms() {
  var pending = queuedSend, gen = connectGen, ws = getWs();
  if (!pending || pending.state !== "waiting") return;
  listRooms().then(function (data) {
    if (gen !== connectGen || getWs() !== ws || queuedSend !== pending || pending.state !== "waiting") return;
    handleRoomsState({ rooms: data.rooms });
    pending.roomsReady = true;
    flushQueuedSend();
  }, function () {
    if (gen === connectGen && queuedSend === pending && pending.state === "waiting" && !pending.roomsReady) retryQueuedSend();
  });
}

function queuedTarget(list) {
  var q = queuedSend;
  if (!q) return null;
  var target = (list || []).find(function (s) {
    return q.sessionUid ? s.sessionUid === q.sessionUid : String(s.id) === String(q.sessionId);
  });
  if (!target || String(target.roomId == null ? null : target.roomId) !== String(q.roomId)) return null;
  if (String(target.id) !== String(q.sessionId)) {
    q.sessionId = target.id;
    q.confirmed = false;
    q.switchRequested = false;
    if (queueDisk) queueDisk.save(q);
  }
  return target;
}

function flushQueuedSend() {
  var q = queuedSend;
  if (!q || q.state !== "waiting" || !connected || !getWs() || getWs().readyState !== 1 || !sessionListSeen || !q.roomsReady || restorePending || thread.replaying) return;
  if (q.retryAt && Date.now() < q.retryAt) return;
  if (!q.confirmed) {
    var target = queuedTarget(getCachedSessions());
    if (!target) { failQueuedSend("client.queueFailed"); return; }
    if (!target.active && !q.switchRequested) {
      q.switchRequested = sendJson({ type: "switch_session", id: q.sessionId });
      if (!q.switchRequested) retryQueuedSend();
    }
    return;
  }
  if (String(currentRoom() ? currentRoom().id : null) !== String(q.roomId) || String(store.get("activeSessionId")) !== String(q.sessionId) || !composerState().ok || (q.mode === "ai" && q.files.length && isTurnBusy())) {
    failQueuedSend("client.queueFailed"); return;
  }
  // Another tab may have dispatched or replaced this shared record while we reconnected.
  var stored = queueDisk && queueDisk.read(q);
  if (!stored || stored.id !== q.id || stored.state !== "waiting") { dropQueuedSend(); return; }
  // Mark before sending: duplicate restore frames cannot trigger a second dispatch.
  q.state = "sending";
  q.dispatchedGen = connectGen;
  clearTimeout(queuedTimer);
  if (queueDisk && !queueDisk.save(q)) { q.state = "waiting"; retryQueuedSend(); return; }
  if (!sendNow(q.text, q.images, q.mode, q.files, q.agent, true)) { q.state = "waiting"; retryQueuedSend(); return; }
  if (els.input.value.trim() === q.draft.trim()) els.input.value = "";
  attachments = attachments.filter(function (im) { return q.images.indexOf(im) === -1; });
  if (attachmentsUi) q.files.forEach(function (f) { attachmentsUi.removePicked(f.id); });
  renderAttachments();
  autosize();
  scrollOwnSend = true;
  renderChat();
  scrollOwnSend = false;
  updateControls();
  queuedTimer = setTimeout(function () { failQueuedSend("client.queueUnconfirmed"); }, QUEUE_CONFIRM_MS);
  if (queuedTimer && queuedTimer.unref) queuedTimer.unref();
}

export function submitMessage() {
  // A view that is painted but not confirmed yet: the message would go to the session the server still has open.
  if (previewKey != null && previewKey !== chatOwner) {
    toast(previewKey === CREATING_KEY ? t("client.toastCreatingSession") : t("client.toastOpeningSession"));
    return false;
  }
  if (sessionUnverified()) { toast(t("client.toastLoadingSession")); return false; }
  var st = composerState();
  if (queuedSend) { toast(t("client.queueAlready")); return false; }
  var text = (aiPicker ? aiPicker.canonicalText() : els.input.value).trim();
  var files = pickedFiles();
  if (st.offline && (text || attachments.length || (sendMode() === "member" && files.length))) {
    if (!st.queueAllowed) { toast(t("client.queueFailed")); return false; }
    queuedSend = { id: "queue-" + Array.prototype.map.call(crypto.getRandomValues(new Uint32Array(2)), function (n) { return n.toString(36); }).join("-"),
      state: "waiting", text: text, draft: els.input.value, images: attachments.slice(), files: files.slice(),
      mode: sendMode(), agent: aiPicker ? aiPicker.outgoing() : null, sessionId: store.get("activeSessionId"), roomId: currentRoom() ? currentRoom().id : null,
      sessionUid: activeSession() && activeSession().sessionUid || null,
      confirmed: false, roomsReady: false, switchRequested: false };
    if (!queueDisk || !queueDisk.save(queuedSend)) {
      queuedSend = null;
      toast(t("client.queueStorageFailed"));
      updateControls();
      return false;
    }
    updateControls();
    return true;
  }
  if (!st.ok || (!text && !attachments.length && !(sendMode() === "member" && files.length))) return false;
  var mode = sendMode();
  var images = attachments.slice();
  if (mode === "ai" && files.length && isTurnBusy()) { toast(t("client.toastAiBusyFiles")); return false; }
  if (!sendNow(text, images, mode, files)) return false;
  attachments = [];
  attachmentsUi.clearPicked();
  if (mode === "ai" && aiPicker) aiPicker.reset();
  renderAttachments();
  els.input.value = "";
  autosize();
  scrollOwnSend = true;   // my own new message is shown even when I had scrolled up
  renderChat();
  scrollOwnSend = false;
  updateControls();
  return true;
}

// The two buttons under a failed explicit endpoint pick. Both are the user's own action; nothing is sent on its own.
function onPickFail(kind, agent, idx) {
  var it = thread.items[Number(idx)];
  if (!it || it.role !== "pickfail" || it.used || !it.retryText) return;
  if (kind === "retry") {
    var st = composerState();
    if (!st.ok || isTurnBusy()) { toast(t("client.toastPickFailBusy")); return; }
    it.used = true;
    if (sendNow(it.retryText, [], "ai", [], agent)) { renderChat(); updateControls(); }
    return;
  }
  it.used = true;
  renderChat();
  els.input.value = els.input.value.trim() ? it.retryText + "\n" + els.input.value : it.retryText;
  if (sendMode() !== "ai") setSendMode("ai");
  if (aiPicker) { aiPicker.set(null); aiPicker.openList(); }
  autosize();
}

// The one place a message leaves the composer. composerState() has already
// proven the open session is the selected room's (or a private one).
function sendNow(text, images, mode, files, agentOverride, capturedAgent) {
  if (mode === "member") {
    var memberPayload = { type: "member_message", text: text };
    if (files && files.length) memberPayload.attachmentIds = files.map(function (f) { return f.id; });
    if (images.length) memberPayload.images = images.map(function (a) { return { mediaType: a.mediaType, data: a.data }; });
    if (!sendJson(memberPayload)) { toast(t("client.toastSendLost")); return false; }
    applyMessage(thread, { type: "member_message", text: text, fromName: myName, _ts: Date.now(), _local: true,
      images: images.map(function (a) { var o = { mediaType: a.mediaType, src: "data:" + a.mediaType + ";base64," + a.data }; if (a.thumb) o.thumb = a.thumb; return o; }),
      files: (files || []).map(function (f) { return { id: f.id, name: f.name, size: f.size }; }) });
    return true;
  }
  var payload = { type: "message", text: text };
  if (coaching) coaching.decorateSend(payload);
  var agent = capturedAgent ? agentOverride : (agentOverride || (aiPicker ? aiPicker.outgoing() : null));
  if (agent) payload.agent = agent;
  if (files && files.length) payload.attachmentIds = files.map(function (f) { return f.id; });
  if (images.length) payload.images = images.map(function (a) { return { mediaType: a.mediaType, data: a.data }; });
  if (!sendJson(payload)) { toast(t("client.toastSendLost")); return false; }
  // The server relays a user message to the session's *other* viewers only.
  lastSent = { text: text, images: images, files: files || [], agent: agent };
  applyMessage(thread, { type: "user_message", text: text, imageCount: images.length, attachedFiles: files || [], images: images.map(function (a) { var o = { mediaType: a.mediaType, src: "data:" + a.mediaType + ";base64," + a.data }; if (a.thumb) o.thumb = a.thumb; return o; }), _local: true });
  thread.processing = true;
  return true;
}

// Selecting a room always opens its main thread: the server finds, adopts or
// creates it and switches this socket to it. One request in flight per room.
// Open a session: the cached copy of its feed (or a skeleton) is on screen at once, the server confirms behind it.
function switchToSession(id) {
  if (!sendJson({ type: "switch_session", id: id })) return false;
  previewSession(id);
  return true;
}

// The server refused the switch: the cached feed of that view must not stay on screen (nor in the cache).
function abandonPreview() {
  if (previewKey == null || previewKey === chatOwner) return;
  if (previewKey === CREATING_KEY) { if (privateChannels) privateChannels.failCreate(); return; }
  var key = previewKey;
  viewCache.drop(key);
  previewSpent = key;
  domKey = null;
  endPreview();
  renderChat();
}

function openRoomMain(roomId) {
  var active = activeSession();
  if (active && active.roomMain === true && String(active.roomId) === String(roomId)) return true;
  if (openingRoomId != null && String(openingRoomId) === String(roomId)) return true;
  if (!sendJson({ type: "open_room_main", roomId: roomId })) { toast(t("client.toastRoomLost")); return false; }
  openingRoomId = String(roomId);
  return true;
}

// Whenever the open session is not the selected room's (first load, a reconnect,
// a legacy session restored by the server), open the room's main thread.
function ensureRoomMainOpen() {
  if (queuedSend && queuedSend.state === "waiting") return;
  var room = currentRoom();
  if (!room && connected && sessionListSeen && isLegacySession(activeSession())) {
    // A room-less personal session is open while rooms exist: the person is in a
    // room, so show the one they were in (or the first).
    var rooms = store.get("rooms") || [];
    var back = rooms.filter(function (r) { return r.id === lastRoomId; })[0] || rooms[0];
    if (back) { store.set({ selectedRoomId: back.id }); room = currentRoom(); }
  }
  if (!connected || !room || !roomSessionNeeded() || sessionUnverified()) return;
  openRoomMain(room.id);
}

// 이름 변경 in a session row's "⋯" menu: the existing rename_session message, which the server
// accepts only from the session's owner or an administrator (a room's main thread has none).
function renameSession(target, restore) {
  renameDialog.open({
    title: t("client.renameSessionTitle"), value: target.current, min: 1, max: 60, restore: restore,
    onSave: function (name) { return sendJson({ type: "rename_session", id: target.id, title: name }); },
  });
}

// 새 세션 in the composer menu starts another private session in 나만의 채널.
function createSession() {
  if (!els.newSession || els.newSession.disabled || !privateChannels) return;
  privateChannels.startNew();
}

function autosize() {
  els.input.style.overflowY = "hidden";
  els.input.style.height = "auto";
  var height = els.input.scrollHeight || 0;
  els.input.style.height = Math.min(height, 180) + "px";
  els.input.style.overflowY = height > 180 ? "auto" : "hidden";
}

// A small preview so the thread does not re-decode a multi-MB image on every render. Browser-only; without a canvas the full image is used.
function makeThumb(dataUrl) {
  return new Promise(function (resolve) {
    try {
      if (typeof Image !== "function") return resolve("");
      var im = new Image();
      im.onload = function () {
        try {
          var k = Math.min(1, 320 / Math.max(im.width || 1, im.height || 1));
          var c = document.createElement("canvas");
          c.width = Math.max(1, Math.round(im.width * k)); c.height = Math.max(1, Math.round(im.height * k));
          c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
          resolve(c.toDataURL("image/jpeg", 0.8));
        } catch (_) { resolve(""); }
      };
      im.onerror = function () { resolve(""); };
      im.src = dataUrl;
    } catch (_) { resolve(""); }
  });
}

function readImage(file) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function () {
      var s = String(reader.result || "");
      var a = { mediaType: file.type, data: s.slice(s.indexOf(",") + 1), name: file.name };
      makeThumb(s).then(function (t) { if (t) a.thumb = t; resolve(a); });
    };
    reader.onerror = function () { reject(new Error("read")); };
    reader.readAsDataURL(file);
  });
}

export function addImages(files) {
  var chain = Promise.resolve();
  Array.prototype.slice.call(files || []).forEach(function (file) {
    chain = chain.then(function () {
      var problem = imageProblem(file, attachments.length);
      if (problem) { toast(problem); return; }
      return readImage(file).then(function (a) { attachments.push(a); }, function () { toast(t("client.toastImageRead")); });
    });
  });
  return chain.then(renderAttachments);
}


var closeAddMenu = function () {};
function onAddSelect(item) {
  if (item.disabled || item.getAttribute("aria-disabled") === "true") {
    if (item.getAttribute("aria-disabled") === "true") toast(t("client.unsupported"));
    return;
  }
  var action = item.getAttribute("data-add-action");
  if (action === "session") { createSession(); return; }
  if (action === "image") { els.imageInput.click(); return; }
  if (action === "camera") { els.cameraInput.click(); return; }
  if (action === "addon" && skills) { skills.open(item); return; }
  if (action === "file" && attachmentsUi) { attachmentsUi.pick(); return; }
  if (action === "inbox" && attachmentsUi) { attachmentsUi.openPicker(document.getElementById("input-more-btn")); return; }
  if (action === "newdoc" && officeUi) { officeUi.openNew(item); return; }
  toast(t("client.unsupported"));
}

// --- Connection ------------------------------------------------------------------------

function fetchTicket() {
  return fetch("/api/ws-ticket", { credentials: "same-origin" }).then(function (res) {
    if (res.status === 401) return { unauthenticated: true };
    if (!res.ok) return { ticket: null };
    return res.json().then(function (d) { return { ticket: (d && d.ticket) || null }; }, function () { return { ticket: null }; });
  }, function () { return { ticket: null }; });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(RECONNECT_MAX_MS, reconnectDelay * 2);
}

function expired() {
  unauthenticated = true;
  if (queuedSend) failQueuedSend("client.queueFailed");
  setConnState("closed", function () { return t("client.connExpired"); });
}

export function connect() {
  clearTimeout(reconnectTimer);
  var gen = ++connectGen;
  setConnState("connecting", function () { return t("client.connConnecting"); });
  return fetchTicket().then(function (r) {
    if (gen !== connectGen) return;
    if (r.unauthenticated) {
      // A single 401 right after wake-up can be a cookie-attachment gap; confirm once.
      return new Promise(function (resolve) { setTimeout(resolve, UNAUTH_RETRY_MS); }).then(fetchTicket).then(function (r2) {
        if (gen !== connectGen) return;
        if (r2.unauthenticated) return expired();
        open(r2.ticket, gen);
      });
    }
    open(r.ticket, gen);
  });
}

function open(ticket, gen) {
  var slug = store.get("currentSlug");
  var proto = location.protocol === "https:" ? "wss:" : "ws:";
  var url = proto + "//" + location.host + "/p/" + slug + "/ws";
  var ws = ticket ? new WebSocket(url, ["aigora.auth." + ticket]) : new WebSocket(url);
  setWs(ws);
  ws.onopen = function () {
    if (gen !== connectGen) return;
    reconnectDelay = 300;
    connectCount++;
    setConnState("connected", function () { return t("client.connConnected"); });
    if (queuedSend && queuedSend.state === "waiting") {
      queuedSend.confirmed = false;
      queuedSend.roomsReady = false;
      queuedSend.switchRequested = false;
      clearTimeout(queuedTimer);
      queuedSend.retryAt = 0;
      // Session restoration frames, not a wall-clock deadline, identify the send target.
      refreshQueuedRooms();
    }
  };
  ws.onmessage = function (ev) {
    var msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (gen !== connectGen || getWs() !== ws) return;
    handleServerMessage(msg);
  };
  ws.onclose = function () {
    if (gen !== connectGen || getWs() !== ws) return;
    if (queuedSend && queuedSend.state === "sending") failQueuedSend("client.queueUnconfirmed");
    clearTimeout(queuedTimer);
    if (queuedSend) queuedSend.confirmed = false;
    openingRoomId = null;
    sessionListSeen = false;
    lostConnection = true;
    setConnState("connecting", function () { return t("client.connLost"); });
    scheduleReconnect();
  };
  ws.onerror = function () {};
}

// --- Boot ------------------------------------------------------------------------------

function loadMe() {
  return fetch("/api/me", { credentials: "same-origin" }).then(function (res) {
    return res.ok ? res.json() : null;
  }).then(function (me) {
    if (me && me.user && me.user.id != null) {
      viewer = { isAdmin: me.user.role === "admin", canDeleteSessions: !me.permissions || me.permissions.sessionDelete !== false };
      myName = me.user.displayName || me.user.username || "";
      store.set({ myUserId: me.user.id });
      try { queueDisk = queueStorage(localStorage, store.get("currentSlug"), me.user.id); } catch (_) { queueDisk = null; }
      var restoredQueue = queueDisk && queueDisk.restore();
      if (!queuedSend && restoredQueue) {
        queuedSend = restoredQueue;
        if (sessionListSeen) queuedTarget(getCachedSessions());
        // /api/me can finish after the socket has restored its session/history.
        queuedSend.confirmed = connected && sessionListSeen && String(chatSessionId) === String(queuedSend.sessionId);
        store.set({ selectedRoomId: queuedSend.roomId });
        if (!els.input.value) els.input.value = queuedSend.draft;
        attachments = queuedSend.images.slice();
        if (attachmentsUi) attachmentsUi.setPicked(queuedSend.files);
        renderAttachments(); autosize(); updateControls();
        if (connected && queuedSend.state === "waiting") refreshQueuedRooms();
      }
      if (social) social.refresh();
      refreshAgora();
      if (privateChannels) privateChannels.refresh();
      if (roomAdmin) roomAdmin.setOwner(me.user.role === "admin", me.user.role === "admin");
      if (settings) { settings.setUser(me.user); settings.restoreFromHash(); }
      if (accountMenu) accountMenu.setUser(me.user);
      // The server's copy wins; localStorage is only the first-paint mirror of it.
      if (me.user.sessionLayout != null) useLayout(me.user.sessionLayout);
      if (me.user.reduceMotion != null) useReduceMotion(!!me.user.reduceMotion);
      if (me.user.promptCoaching != null) useCoaching(!!me.user.promptCoaching);
      // Same for the language: the server's copy wins (no write-back), a first visit keeps the browser's.
      if (me.user.language) setLang(me.user.language);
      if (settings) settings.setDisplayPrefs({ layout: sessionLayout, reduceMotion: readReduceMotion(), promptCoaching: readCoaching() });
      guideSeen = me.user.onboardingSeen !== false;   // only an explicit false is "new"
      guideVersion = me.user.onboardingVersion != null ? me.user.onboardingVersion : (guideSeen ? GUIDE_VERSION : 0);   // no field (old server): never nag
      maybeShowGuide();
      updateControls();
      if (sharedPosts) sharedPosts.refresh(false);
    }
  }, function () {});
}

// First-run 사용설명서: once the viewer is known to have not seen it and a room is open.
function maybeShowGuide() {
  if (guide && guideSeen != null) guide.maybeShow({ seen: guideSeen, version: guideVersion, hasRoom: !!currentRoom() });
}

function markGuideSeen() {
  if (guideSeen && guideVersion >= GUIDE_VERSION) return;
  guideSeen = true;
  guideVersion = GUIDE_VERSION;
  fetch("/api/user/onboarding-seen", { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: GUIDE_VERSION }) }).catch(function () {});
}

// End the session on the server, then reload into the sign-in page.
function logout() {
  viewCache.clear();
  return fetch("/auth/logout", { method: "POST", credentials: "same-origin" }).then(function (res) {
    // 401: the session is already gone; reloading lands on the sign-in page.
    if (!res.ok && res.status !== 401) throw new Error("HTTP " + res.status);
    location.reload();
  }).catch(function () { toast(t("client.toastLogoutFailed")); });
}

// 모든 기기에서 로그아웃: confirm in-page, then revoke every session of this account on the server
// (open sockets close, old cookies stop working) and reload into the sign-in page.
function logoutAll(opener) {
  confirmDialog.open({
    title: t("settings.logoutAllConfirmTitle"), text: t("settings.logoutAllConfirmText"),
    confirmLabel: t("settings.logoutAllDo"), cancelLabel: t("settings.confirmCancel"),
    restore: function () { if (opener && opener.focus) opener.focus(); },
    onConfirm: function () {
      return fetch("/auth/logout-all", { method: "POST", credentials: "same-origin", headers: { "X-Requested-With": "aigora" } }).then(function (res) {
        // 401: the session is already gone; reloading lands on the sign-in page.
        if (!res.ok && res.status !== 401) return t("settings.logoutAllFailed");
        viewCache.clear();
        location.reload();
        return true;
      }, function () { return t("settings.logoutAllFailed"); });
    },
  });
}

// Re-read the caller's rooms (after the owner created a room or removed a
// member) and optionally select one. The server list stays authoritative.
function refreshRooms(selectId, quiet) {
  return listRooms().then(function (data) {
    mentionRoster = null;
    handleRoomsState({ rooms: data.rooms });
    if (selectId) store.set({ selectedRoomId: selectId });
    refreshAgora();
    updateControls();
    // A room just created and selected has no open main thread yet (nothing else asks for it).
    if (selectId && sessionListSeen) ensureRoomMainOpen();
  }, function () { if (!quiet) toast(t("client.toastRoomsRefresh")); });
}
// Member counts and rosters change when someone joins elsewhere: the room list is re-read every 30 s while the page is
// visible and connected, and when the tab comes back (a counter that only moved on reload read as stale).
var roomsPollTimer = null;
function startRoomsPoll() {
  if (roomsPollTimer || typeof setInterval !== "function") return;
  roomsPollTimer = setInterval(function () { if (connected && !(typeof document !== "undefined" && document.hidden)) refreshRooms(null, true); }, 30000);
  if (roomsPollTimer && typeof roomsPollTimer.unref === "function") roomsPollTimer.unref();
  if (typeof document !== "undefined" && document.addEventListener) document.addEventListener("visibilitychange", function () { if (!document.hidden && connected) refreshRooms(null, true); });
}

export function boot() {
  document.getElementById("ai-queued-cancel").addEventListener("click", cancelQueuedSend);
  if (typeof window.addEventListener === "function") window.addEventListener("storage", function (ev) {
    if (!queuedSend || !queueDisk || ev.storageArea !== localStorage) return;
    if (ev.key === null || ev.key === queueDisk.key(queuedSend)) dropQueuedSend();
  });
  var slug = slugFromPath(location.pathname);
  initLightbox(document);
  if (slug) setImageBase("/p/" + slug);
  createStore({
    rooms: [], selectedRoomId: null, agoraNarration: {}, agoraTab: "timeline", agoraTurnOpen: {}, agoraTurnDetail: {}, coachingTab: null, agoraPanelOpen: false,
    agoraSheetOpen: false, sidePinned: false, agoraSections: {}, agoraRoomCollapsed: {}, activeSessionId: null, currentSlug: slug, myUserId: null,
    cachedOnlineIds: [], personalChannels: null,
  });
  applyDom(document);
  onLangChange(rerenderLanguage);
  els = {
    chat: document.getElementById("ai-chat"),
    form: document.getElementById("ai-composer"),
    input: document.getElementById("ai-input"),
    sendMode: document.getElementById("ai-send-mode"),
    modes: document.getElementById("ai-composer-modes"),
    modeChip: document.getElementById("ai-mode-chip"),
    send: document.getElementById("ai-send"),
    note: document.getElementById("ai-composer-note"),
    attachments: document.getElementById("ai-attachments"),
    imageInput: document.getElementById("ai-image-input"),
    cameraInput: document.getElementById("ai-camera-input"),
    newSession: document.getElementById("ai-new-session"),
    connText: document.getElementById("ai-conn-text"),
    connDot: document.getElementById("ai-conn-dot"),
    toast: document.getElementById("ai-toast"),
  };
  if (typeof window !== "undefined" && !window.lucide) window.lucide = { createIcons: function () {} };
  onHostNotice(toast);
  var updateBtn = document.getElementById("ai-update");
  if (updateBtn) updateBtn.addEventListener("click", reloadForUpdate);
  restoreDraft();

  els.form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    if (sendIsStop()) stopTurn(); else submitMessage();
  });
  initDialogSafety();
  var skip = document.querySelector(".ai-skip");
  if (skip) skip.addEventListener("click", function (ev) { ev.preventDefault(); if (els.chat && els.chat.focus) els.chat.focus(); });
  els.input.addEventListener("keydown", function (ev) {
    if (aiPicker && aiPicker.handleKey(ev)) return;
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing && ev.keyCode !== 229) {
      ev.preventDefault();
      submitMessage();
    }
  });
  els.input.addEventListener("input", autosize);
  // A shared-result card in the feed opens the 공유 결과 view on that post.
  els.chat.addEventListener("scroll", rememberScroll);
  els.chat.addEventListener("input", function (ev) {
    var ai = askCard(ev, "data-ask-other");
    if (!ai) return;
    setOtherText(ai.item, ai.qi, ev.target.value);
    // No re-render (it would drop the caret): only the send button follows.
    var sb = els.chat.querySelector('[data-ask-submit="' + ai.item.toolId.replace(/"/g, "") + '"]');
    if (sb) { if (buildResponse(ai.item)) sb.removeAttribute("disabled"); else sb.setAttribute("disabled", ""); }
  });
  els.chat.addEventListener("click", function (ev) {
    var pb = ev.target && ev.target.closest && ev.target.closest("[data-perm-decision]");
    var ao = askCard(ev, "data-ask-opt");
    if (ao) { if (toggleOption(ao.item, ao.qi, Number(ao.el.getAttribute("data-ask-o")))) renderChat(); return; }
    var at = askCard(ev, "data-ask-other-toggle");
    if (at) {
      if (toggleOther(at.item, at.qi)) {
        renderChat();
        var oi = els.chat.querySelector('[data-ask-other="' + at.item.toolId.replace(/"/g, "") + '"][data-ask-q="' + at.qi + '"]');
        if (oi && oi.focus) oi.focus();
      }
      return;
    }
    var as = askCard(ev, "data-ask-submit");
    if (as) { submitAsk(as.item); return; }
    if (pb) { decidePermission(pb.getAttribute("data-perm-id"), pb.getAttribute("data-perm-decision")); return; }
    if (ev.target && ev.target.closest && ev.target.closest("[data-load-earlier]")) { loadEarlier(); return; }
    var rc = ev.target && ev.target.closest && ev.target.closest("[data-route-chip]");
    if (rc) { if (toggleRoute(thread, rc.getAttribute("data-route-chip"))) renderChat(); return; }
    var pf = ev.target && ev.target.closest && ev.target.closest("[data-pickfail]");
    if (pf) { onPickFail(pf.getAttribute("data-pickfail"), pf.getAttribute("data-pickfail-agent"), pf.getAttribute("data-pickfail-item")); return; }
    var vl = ev.target && ev.target.closest && ev.target.closest("[data-verify-open]");
    if (vl) { openContextPanel("execution"); focusRunStep(vl.getAttribute("data-verify-open"), vl.getAttribute("data-verify-step")); return; }
    var rf = ev.target && ev.target.closest && ev.target.closest("[data-route-fb]");
    if (rf) { sendRouteFeedback(rf.getAttribute("data-route-fb"), Number(rf.getAttribute("data-value"))); return; }
    var b = ev.target && ev.target.closest && ev.target.closest("[data-open-post]");
    if (b && sharedPosts) sharedPosts.openPost(b.getAttribute("data-open-post"));
  });
  els.sendMode.addEventListener("click", function (ev) {
    var b = ev.target.closest && ev.target.closest("[data-send-mode]");
    if (b) setSendMode(b.getAttribute("data-send-mode"));
  });
  els.modeChip.addEventListener("click", function () { if (aiPicker) aiPicker.openSheet(); else setSendMode(modeChip(sendMode()).next); });
  // The menu owns activation of #ai-new-session (initMenuButton's delegated
  // click -> onAddSelect); a second direct listener here created two sessions.
  els.imageInput.addEventListener("change", function () {
    closeAddMenu();
    var files = els.imageInput.files;
    addImages(files).then(function () { els.imageInput.value = ""; });
  });
  els.cameraInput.addEventListener("change", function () {
    closeAddMenu();
    var files = els.cameraInput.files;
    addImages(files).then(function () { els.cameraInput.value = ""; });
  });

  var plus = document.getElementById("input-more-btn");
  var menu = initMenuButton({
    button: plus,
    menu: document.getElementById("input-add-menu"),
    onSelect: onAddSelect,
  });
  closeAddMenu = function () { menu.close(); };   // whatever was picked, the "+" menu does not stay open behind it
  plus.addEventListener("click", function (e) { e.stopPropagation(); menu.toggle(e); });
  localModel = initLocalModel({ basePath: slug ? "/p/" + slug + "/" : "/", onStatus: function () { if (aiPicker) aiPicker.render(); } });
  aiPicker = initAiPicker({
    els: { root: document.getElementById("ai-pick"), chip: document.getElementById("ai-pick-chip"), list: document.getElementById("ai-pick-list"), at: document.getElementById("ai-at-list"),
      mentions: document.getElementById("ai-member-mentions"), sheet: document.getElementById("ai-pick-sheet"), input: els.input, modeChip: els.modeChip },
    basePath: slug ? "/p/" + slug + "/" : "/",
    members: function () {
      var room = currentRoom();
      if (!room || roomSessionNeeded() || sessionInOtherRoom() || legacyUnderRoom()) return [];
      if (mentionRoster && mentionRoster.roomId === room.id && mentionRoster.sessionId === store.get("activeSessionId")) return mentionRoster.people;
      var active = activeSession();
      return pickerPrivate() || active && active.sessionVisibility === "private" ? [] : room.members || [];
    },
    selfId: function () { return store.get("myUserId"); },
    available: pickerAvailable, isPrivate: pickerPrivate, getMode: sendMode, setMode: setSendMode, onChange: autosize,
    localReady: function () { return !!(localModel && localModel.isOffered()); },
    status: function () { return localModel ? localModel.status() : null; },
  });

  if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
  initAiUsage({ basePath: slug ? "/p/" + slug + "/" : "/" });
  rowMenus = initRowMenus({
    els: {
      root: document.body, fallback: document.getElementById("agora-room-rail"), menu: document.getElementById("ai-row-menu"), dialog: document.getElementById("ai-row-confirm"),
      dialogTitle: document.getElementById("ai-row-confirm-title"), dialogText: document.getElementById("ai-row-confirm-text"),
      confirm: document.querySelector("[data-row-confirm]"), cancel: document.querySelector("[data-row-cancel]"),
    },
    getRooms: function () { return store.get("rooms"); },
    getSessions: getCachedSessions,
    onInvite: function (roomId, btn) { store.set({ selectedRoomId: roomId }); if (roomAdmin) roomAdmin.openInvite(btn); },
    getChannel: function (id) { return privateChannels ? privateChannels.getChannel(id) : null; },
    onCloseChannel: function (target, btn) { if (privateChannels) privateChannels.openClose(btn); },
    onRename: function (target, btn, restore) {
      if (target.kind === "channel") { if (privateChannels) privateChannels.openRename(restore); return; }
      renameSession(target, restore);
    },
    getViewer: function () { return { myUserId: store.get("myUserId"), isAdmin: viewer.isAdmin, canDeleteSessions: viewer.canDeleteSessions }; },
    send: sendJson,
    onRoomsChanged: refreshRooms,
    toast: toast,
  });
  renameDialog = initRenameDialog({
    root: document.getElementById("ai-rename"), title: document.getElementById("ai-rename-title"), input: document.getElementById("ai-rename-input"),
    msg: document.getElementById("ai-rename-msg"), cancel: document.querySelector("[data-rename-cancel]"), save: document.querySelector("[data-rename-save]"),
  });
  confirmDialog = initConfirmDialog({
    root: document.getElementById("ai-confirm"), title: document.getElementById("ai-confirm-title"), text: document.getElementById("ai-confirm-text"),
    msg: document.getElementById("ai-confirm-msg"), cancel: document.querySelector("[data-confirm-cancel]"), ok: document.querySelector("[data-confirm-ok]"),
  });
  setRowMenu(rowMenus.html);
  setRoomMainOpener(openRoomMain);
  setRoomChildren(function () { return privateChannels ? privateChannels.treeHtml() : ""; });
  setSessionChrome({
    header: function () { return privateChannels ? privateChannels.headerInfo() : null; },
    toggleMenu: function () { if (privateChannels) privateChannels.toggleMenu(); },
  });
  applyLayout(shownLayout());
  watchViewport();
  applyReduceMotion(readReduceMotion());
  initAgora({ inspector: { narrowQuery: "(max-width: 1023px)", read: function () { return panelScopePrivate ? readChannelInspector() : readInspector(); }, save: function (open) { if (panelScopePrivate) saveChannelInspector(open); else saveInspector(open); } } });
  var phoneEls = {
    layout: document.getElementById("layout"), side: document.getElementById("ai-sidebar"), scrim: document.getElementById("ai-phone-scrim"),
    main: document.getElementById("main-column"), edge: document.getElementById("ai-phone-edge"),
    seg: document.getElementById("ai-pb-seg"), segBtns: { room: document.querySelector('[data-pb-tab="room"]'), private: document.querySelector('[data-pb-tab="private"]') },
    menuBtn: document.getElementById("ai-pb-menu"), action: document.getElementById("ai-pb-action"), actionIcon: document.getElementById("ai-pb-action-icon"),
    badge: document.getElementById("ai-pb-badge"), caption: document.getElementById("ai-phone-room"),
    searchBtn: document.getElementById("ai-ps-search-btn"), searchForm: document.getElementById("ai-ps-search"), q: document.getElementById("ai-ps-q"),
    results: document.getElementById("ai-ps-results"), body: document.getElementById("ai-ps-body"), menu: document.getElementById("ai-ps-menu"),
    divider: document.getElementById("ai-ps-divider"), prev: document.getElementById("ai-ps-prev"), list: document.getElementById("ai-phone-list"),
    primary: document.getElementById("ai-ps-primary"), suggest: document.getElementById("ai-phone-suggest"), progress: document.getElementById("ai-phone-progress"),
    chat: els.chat, form: els.form,
  };
  privateChannels = initPrivateChannels({
    onTurnRefused: onTurnRefused,
    els: {
      phoneList: phoneEls.list,
      col: document.getElementById("ai-session-col"),
      pop: document.getElementById("ai-session-pop"),
      surfaces: [document.getElementById("agora-room-rail")],
      chat: els.chat,
      composer: els.form,
      closeDialog: document.getElementById("ai-private-close-dialog"),
      closeDialogText: document.getElementById("ai-private-close-text"),
    },
    send: sendJson,
    rowMenu: rowMenus.html,
    rename: renameDialog,
    toast: toast,
    getPhone: function () { return phoneNav ? phoneNav.getPhone() : null; },
    getRoom: currentRoom,
    getSessions: getCachedSessions,
    getMyId: function () { return store.get("myUserId"); },
    getActiveSessionId: function () { return store.get("activeSessionId"); },
    switchSession: function (id) { switchToSession(id); },
    rerenderChat: renderChat,
    onTreeChanged: refreshAgora,
    onAccessChanged: function () { updateControls(); if (social) social.refresh(); if (skills) skills.onContextChanged(); },
  });
  privateChannels.setLayout(shownLayout());
  phoneNav = initPhoneNav({
    els: phoneEls,
    getRoom: currentRoom,
    getRooms: function () { return store.get("rooms") || []; },
    getAccess: function () { return privateChannels.getAccess(); },
    getView: function () { return privateChannels.getView(); },
    getViewer: function () { return viewer; },
    canStartNew: function () { return privateChannels.canStartNew(); },
    startNew: function () { privateChannels.startNew(); },
    openRoomMain: openRoomMain,
    openOwn: function () { privateChannels.openOwn(); },
    cancelOpenOwn: function () { privateChannels.cancelOpenOwn(); },
    openRoom: openRoom,
    switchSession: function (id) { return switchToSession(id); },
    rowMenu: rowMenus.html,
    // 이전 대화: this room's sessions that predate the shared feed.
    getPrevious: function () {
      var r = currentRoom();
      return r ? sessionsForRoom((getCachedSessions() || []).filter(function (x) { return !x.roomMain; }), r.id, store.get("myUserId")) : [];
    },
    getBell: function () { return { count: bell.badge, pending: bell.pending }; },
    // Which of the existing tool buttons the modules currently offer (they hide their own button when it does not apply).
    getAvail: function () {
      function shown(id) { var n = document.getElementById(id); return !!n && !n.classList.contains("hidden"); }
      return { results: shown("ai-shared-posts-btn"), share: shown("ai-share-private"), pins: shown("ai-social-tools") };
    },
    getSkills: function () { return skills ? skills.status() : { on: false, count: 0 }; },
    getPosts: function () { return sharedPosts ? sharedPosts.state.posts : []; },
    isEmptyRoom: function () { return isRoomMainActive() && !roomSessionNeeded() && thread.items.length === 0 && !isTurnBusy(); },
    isRunning: isTurnBusy,
    getStages: function () {
      var id = store.get("activeSessionId");
      var all = store.get("agoraNarration") || {};
      return summarizeStages(id == null ? [] : latestTurnEntries(all[(store.get("currentSlug") || "") + ":" + id] || [])).filter(function (s) { return s.id !== "better_prompt"; });
    },
    openPost: function (id) { if (sharedPosts) sharedPosts.openPost(id); },
    pickFile: function () { onAddSelect(document.querySelector('[data-add-action="file"]')); },
    fillInput: function (text) {
      if (els.input.disabled) return;
      if (!els.input.value) els.input.value = text;
      autosize();
      updateControls();
      if (els.input.focus) els.input.focus();
    },
    // Every sidebar row and the bell call the module that owns the feature; `from` is the focus to return to.
    actions: {
      rooms: function () { openRoomSheet(); },
      results: function () { if (sharedPosts) sharedPosts.openPanel(); },
      share: function () { if (sharedPosts) sharedPosts.openShare(); },
      pins: function () { document.getElementById("ai-pin-btn").click(); },
      panel: function () { openContextPanel("timeline"); },
      members: function () { openContextPanel("members"); },
      coaching: function (from) { coaching.openHistory(null, from); },
      skills: function (from) { if (skills && skills.status().on) skills.open(from); else toast(t("client.unsupported")); },
      settings: function (from) { settings.open(null, { opener: from }); },
      guide: function (from) { guide.open(from); },
      approvals: function () { social.openApprovals(); },
      manage: function (from) { settings.open("rooms", { opener: from }); },
      bell: function () { document.getElementById("ai-notif-btn").click(); },
      "create-room": function () { document.getElementById("ai-room-create-sheet").click(); },
    },
  });
  document.getElementById("ai-room-create-sheet").addEventListener("click", function () { store.set({ agoraSheetOpen: false }); refreshAgora(); });
  social = initSocial({
    els: {
      chat: els.chat, tools: document.getElementById("ai-social-tools"), pinBtn: document.getElementById("ai-pin-btn"),
      notifBtn: document.getElementById("ai-notif-btn"), dot: document.getElementById("ai-notif-dot"),
      popPin: document.getElementById("ai-pop-pin"), popNotif: document.getElementById("ai-pop-notif"),
    },
    send: sendJson,
    coachInfo: function (item) { return coaching ? coaching.infoFor(item) : null; },
    isAdmin: function () { return !!viewer.isAdmin; },
    announce: function (text) { var live = document.getElementById("ai-perm-live"); if (live) live.textContent = text; },
    getRoomRole: function () {
      var a = privateChannels ? privateChannels.getAccess() : null;
      if (a && a.isPrivate && a.readOnly) return "viewer";
      var r = currentRoom(); return r ? r.role || null : null;
    },
    getMyId: function () { return store.get("myUserId"); },
    getSessionId: function () { return store.get("activeSessionId"); },
    switchSession: function (id) { switchToSession(id); },
    rerender: renderChat,
    onTools: function (b) { bell = b; refreshPhone(); },
    toast: toast,
  });
  // Push click: "?approvals=1" on a fresh window, or a message to an open one, opens the bell panel.
  try { if (/[?&]approvals=1/.test(location.search || "")) setTimeout(function () { social.openApprovals(); }, 0); } catch (_) {}
  try {
    if (typeof navigator !== "undefined" && navigator.serviceWorker && navigator.serviceWorker.addEventListener) {
      navigator.serviceWorker.addEventListener("message", function (ev) { if (ev.data && ev.data.type === "open_approvals") social.openApprovals(); });
    }
  } catch (_) {}
  sharedPosts = initSharedPosts({
    send: sendJson,
    getRoom: currentRoom,
    getSession: activeSession,
    getMyId: function () { return store.get("myUserId"); },
    getThread: function () { return thread; },
    isConnected: function () { return connected; },
    onChange: refreshPhone,
    toast: toast,
  });
  attachmentsUi = initAttachments({
    els: {
      chat: els.chat, root: document.body, fileInput: document.getElementById("ai-file-input"), uploads: document.getElementById("ai-uploads"),
      hint: document.getElementById("ai-attach-hint"), pickItem: document.querySelector('[data-add-action="inbox"]'), menuHint: document.getElementById("ai-file-hint"), dropZones: [els.chat, els.form],
    },
    base: function () { return "/p/" + store.get("currentSlug") + "/api/"; },
    getRoom: currentRoom,
    getSession: activeSession,
    getAccess: function () { return privateChannels ? privateChannels.getAccess() : null; },
    isRoomMain: function () { return isRoomMainActive() && !roomSessionNeeded(); },
    getRooms: function () { return store.get("rooms") || []; },
    getMyId: function () { return store.get("myUserId"); },
    getMode: sendMode,
    getThread: function () { return thread; },
    onPickedChange: renderAttachments,
    announce: function (text) { var live = document.getElementById("ai-perm-live"); if (live) live.textContent = text; },
    rerender: renderChat,
    toast: toast,
    officeActions: function (it) { return officeUi ? officeUi.cardActions(it) : ""; },
    officeVersion: function (it) { return officeUi ? officeUi.cardVersion(it) : ""; },
  });
  officeUi = initOffice({
    els: { chat: els.chat, root: document.body, menuItem: document.querySelector('[data-add-action="newdoc"]') },
    slug: function () { return store.get("currentSlug"); },
    getTarget: attachmentsUi.target,
    getScope: function () {
      var s = activeSession();
      var a = privateChannels ? privateChannels.getAccess() : null;
      if (a && a.isPrivate) return s && s.channelId ? { kind: "channel", channelId: s.channelId } : null;
      var room = currentRoom();
      return room ? { kind: "room", roomId: room.id } : null;
    },
    getRoom: currentRoom,
    getAccess: function () { return privateChannels ? privateChannels.getAccess() : null; },
    getMyId: function () { return store.get("myUserId"); },
    getThread: function () { return thread; },
    now: Date.now,
    announce: function (text) { var live = document.getElementById("ai-perm-live"); if (live) live.textContent = text; },
    rerender: renderChat,
    toast: toast,
    attachments: attachmentsUi,
    getPanelOpen: function () { return !!store.get("agoraPanelOpen"); },
    setPanelOpen: function (open) { store.set({ agoraPanelOpen: open }); }, // not saved: only the remembered choice (setPanel) is
  });
  coaching = initCoaching({
    send: sendJson,
    getMyId: function () { return store.get("myUserId"); },
    getActiveSessionId: function () { return store.get("activeSessionId"); },
    store: store,
    toast: toast,
    input: function () { return els.input; },
    onFilled: function () { autosize(); updateControls(); },
    rerender: renderChat,
  });
  coaching.setEnabled(readCoaching());
  skills = initSkills({
    els: { root: document.getElementById("ai-skills"), bar: document.getElementById("ai-skills-bar"), chip: document.getElementById("ai-skills-chip"),
      menuItem: document.querySelector('[data-add-action="addon"]'), plus: plus, live: document.getElementById("ai-skills-live") },
    send: sendJson,
    isConnected: function () { return connected; },
    getContext: function () { var r = currentRoom(); return r ? { roomId: r.id, scope: contextScope(privateChannels ? privateChannels.getAccess() : null) } : null; },
    onChange: refreshPhone,
    toast: toast,
  });
  settings = initSettings({
    logout: logout,
    logoutAll: logoutAll,
    onUserChange: function (u) { if (accountMenu) accountMenu.setUser(u); },
    onLayoutChange: function (layout) { useLayout(layout); saveDisplayPrefs({ sessionLayout: layout }); },
    onReduceMotionChange: function (on) { useReduceMotion(on); saveDisplayPrefs({ reduceMotion: on }); },
    onCoachingChange: function (on) { useCoaching(on); saveDisplayPrefs({ promptCoaching: on }); },
    onLanguageChange: function (lang) { setLang(lang); saveDisplayPrefs({ language: lang }); },
  });
  roomAdmin = initRoomAdmin({ settings: settings, confirm: function (o) { confirmDialog.open(o); }, getSelfId: function () { return store.get("myUserId"); }, getRoom: currentRoom, getRooms: function () { return store.get("rooms") || []; }, onRoomsChanged: refreshRooms, toast: toast, copy: copyToClipboard,
    skillsOn: function () { return !!skills && skills.status().on; },
    // 스킬 manage button in 방 관리: close the settings dialog, then open the sheet for the chosen room.
    openSkills: function (roomId) {
      var r = currentRoom();
      if (roomId && (!r || String(r.id) !== String(roomId))) store.set({ selectedRoomId: roomId });
      settings.close();
      if (skills) skills.open(null);
    } });
  accountMenu = initAccountMenu({
    actions: {
      settings: function (opener) { settings.open(null, { opener: opener }); },
      rooms: function (opener) { settings.open("rooms", { opener: opener }); },
      guide: function (opener) { guide.open(opener); },
      coaching: function (opener) { coaching.openHistory(null, opener); },
      logout: logout,
    },
  });
  guide = initGuide({ markSeen: markGuideSeen, isAdmin: function () { return !!viewer.isAdmin; } });
  store.subscribe(["agoraPanelOpen", "sidePinned"], syncChrome);
  store.subscribe(["rooms", "selectedRoomId", "activeSessionId", "myUserId"], function () {
    if (previewKey == null && els.form) composerHeightBefore = els.form.offsetHeight;
    forgetViewsOfOthers();
    detachFromOtherRoom();
    maybeShowGuide();
    roomAdmin.syncRooms();
    if (phoneNav) phoneNav.onContextChanged();
    if (privateChannels) privateChannels.onContextChanged();
    if (skills) skills.onContextChanged();
    updateControls();
    renderChat();
    social.refresh();
    sharedPosts.refresh(false);
  });
  renderChat();
  updateControls();
  if (!slug) { toast(t("client.toastNeedSlug")); return; }
  loadMe();
  connect();
  startRoomsPoll();
}

if (typeof document !== "undefined" && !globalThis.__AIGORA_NO_BOOT) boot();

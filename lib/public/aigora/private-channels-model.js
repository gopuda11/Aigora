// DOM-free model for Aigora personal channels.
import { t, formatRelativeTime } from "./i18n.js";

export function privacyNotice() { return t("privateChannels.privacyNotice"); }
export function adminReadOnlyNotice() { return t("privateChannels.adminReadOnlyNotice"); }
export function privateExecutionNotice() { return t("privateChannels.privateExecutionNotice"); }
export function channelRefusedNotice() { return t("privateChannels.channelRefusedNotice"); }
export function emptyNotice() { return t("privateChannels.emptyNotice"); }
// "<nick>'s channel" worded in the viewer's language from the raw nickname (the server's pre-worded text is the fallback).
function ownerDefault(own) { return own.nick ? t("privateChannels.channelOf", { name: own.nick }) : ""; }
export function defaultChannelLabel() { return t("privateChannels.defaultChannelLabel"); }
export function noSessionsLabel() { return t("privateChannels.noSessionsLabel"); }
export var CHANNEL_NAME_MAX = 30;
export function nameInvalidNotice() { return t("privateChannels.nameInvalidNotice"); }

function asId(v) {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" && isFinite(v)) return String(v);
  return null;
}
function asText(v, max) {
  if (typeof v !== "string") return "";
  var s = v.trim();
  return s.length > max ? s.slice(0, max) : s;
}
function asState(v) { return v === "active" ? "active" : "closed"; }

function normalizeOwn(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(function (r) {
    if (!r || typeof r !== "object") return null;
    var channelId = asId(r.channelId), roomId = asId(r.roomId);
    if (!channelId || !roomId) return null;
    return {
      channelId: channelId,
      roomId: roomId,
      state: asState(r.state),
      name: asText(r.name, CHANNEL_NAME_MAX),
      // "<닉네임>의 채널" (or the custom name) as the server resolved it for the current nickname.
      displayName: asText(r.displayName, 80),
      defaultName: asText(r.defaultName, 80),
      nick: asText(r.nick, 80),
      sessionCount: typeof r.sessionCount === "number" && isFinite(r.sessionCount) && r.sessionCount > 0
        ? Math.floor(r.sessionCount) : 0,
    };
  }).filter(Boolean);
}

function normalizeAdminRoom(raw, roomId) {
  if (!raw || typeof raw !== "object" || asId(raw.roomId) !== asId(roomId) || !Array.isArray(raw.channels)) return null;
  return {
    roomId: String(roomId),
    channels: raw.channels.map(function (c) {
      if (!c || typeof c !== "object") return null;
      var name = asText(c.ownerName, 80);
      if (!name) return null;
      var sessions = Array.isArray(c.sessions) ? c.sessions.map(function (s) {
        if (!s || typeof s !== "object" || s.id == null) return null;
        return { id: s.id, title: asText(s.title, 100) || t("privateChannels.untitledSession") };
      }).filter(Boolean) : [];
      return {
        ownerName: name,
        name: asText(c.name, CHANNEL_NAME_MAX),
        displayName: asText(c.displayName, 80),
        lastActivity: typeof c.lastActivity === "number" && isFinite(c.lastActivity) && c.lastActivity > 0 ? c.lastActivity : 0,
        state: asState(c.state),
        sessionCount: typeof c.sessionCount === "number" && isFinite(c.sessionCount) && c.sessionCount > 0
          ? Math.floor(c.sessionCount) : 0,
        sessions: sessions,
      };
    }).filter(Boolean),
  };
}

export function createPrivateState() {
  return { roomId: null, channelState: null, loading: true, refused: "" };
}

export function applyPrivateMessage(state, msg, roomId) {
  if (!state || !msg || msg.type !== "channel_state") return state;
  state.roomId = asId(roomId);
  state.channelState = { own: normalizeOwn(msg.own), room: normalizeAdminRoom(msg.room, roomId) };
  state.loading = false;
  state.refused = "";
  return state;
}

export function activityLabel(ts, now) {
  if (typeof ts !== "number" || !isFinite(ts) || ts <= 0) return t("privateChannels.noActivity");
  now = typeof now === "number" && isFinite(now) ? now : Date.now();
  return formatRelativeTime(ts, now) || t("privateChannels.noActivity");
}

function ownForRoom(state, roomId) {
  var list = state && state.channelState && state.channelState.own;
  if (!Array.isArray(list)) return null;
  // An owner can hold several records per room (closed ones, then a fresh one): the active one wins.
  var found = null;
  for (var i = 0; i < list.length; i++) {
    if (list[i].roomId !== String(roomId)) continue;
    if (list[i].state === "active") return list[i];
    if (!found) found = list[i];
  }
  return found;
}
export function derivePrivateView(state, opts) {
  opts = opts || {};
  var roomId = asId(opts.roomId);
  var own = roomId ? ownForRoom(state, roomId) : null;
  var sessions = Array.isArray(opts.sessions) ? opts.sessions : [];
  var myId = opts.myUserId == null ? null : String(opts.myUserId);
  var now = typeof opts.now === "number" ? opts.now : Date.now();
  var ownSessions = [];

  if (own) {
    sessions.forEach(function (s) {
      if (!s || s.channelId !== own.channelId || String(s.roomId) !== roomId) return;
      if (myId !== null && String(s.ownerId) !== myId) return;
      ownSessions.push({
        id: s.id,
        title: asText(s.title, 100) || t("privateChannels.untitledSession"),
        preview: asText(s.preview, 120),
        lastActivity: typeof s.lastActivity === "number" && isFinite(s.lastActivity) ? s.lastActivity : 0,
        lastActivityLabel: activityLabel(s.lastActivity, now),
        active: s.id === opts.activeSessionId,
      });
    });
    ownSessions.sort(function (a, b) { return b.lastActivity - a.lastActivity; });
  }

  var adminRoom = state && state.channelState && state.channelState.room;
  var adminVisible = !!(roomId && adminRoom && adminRoom.roomId === roomId);
  return {
    roomId: roomId,
    privacy: privacyNotice(),
    loading: !!(state && state.loading),
    refused: state && state.refused ? state.refused : "",
    offline: opts.connected === false,
    hasChannel: !!own,
    channelId: own ? own.channelId : null,
    channelName: own ? own.name : "",
    // What the owner's 나만의 채널 is called wherever it appears: the name they chose, else the default.
    channelLabel: own && (own.name || own.nick || own.displayName) ? own.name || ownerDefault(own) || own.displayName : defaultChannelLabel(),
    // What the label falls back to when the custom name is cleared ("<닉네임>의 채널"), for the rename hint.
    defaultChannelLabel: own && (own.nick || own.defaultName) ? ownerDefault(own) || own.defaultName : defaultChannelLabel(),
    canRename: !!roomId && opts.connected !== false && !!own && own.state === "active",
    closed: !!own && own.state !== "active",
    channelState: own ? own.state : null,
    ownSessions: ownSessions,
    emptyText: emptyNotice(),
    // A closed channel never blocks a fresh one; the old one stays closed (the server creates a new record).
    canCreate: !!roomId && opts.connected !== false,
    canClose: !!roomId && opts.connected !== false && !!own && own.state === "active",
    adminVisible: adminVisible,
    adminChannels: adminVisible ? adminChannelsView(adminRoom.channels, sessions, now) : [],
  };
}

// 조원 채널 for an administrator: one folder per member, the most recently active first (stable for
// ties and for channels with no activity record).
function adminChannelsView(channels, sessions, now) {
  var live = {};
  sessions.forEach(function (s) { if (s && s.id != null) live[s.id] = s; });
  return channels.map(function (c, index) {
    // Titles follow the live session list (a rename arrives there); the channel listing is the fallback.
    var latest = c.lastActivity;
    var rows = c.sessions.map(function (s) {
      var l = live[s.id];
      var title = l ? asText(l.title, 100) : "";
      var row = { id: s.id, title: title || s.title };
      if (l && typeof l.lastActivity === "number" && l.lastActivity > 0) { row.lastActivity = l.lastActivity; if (l.lastActivity > latest) latest = l.lastActivity; }
      return row;
    });
    var channelName = c.name || (c.displayName ? t("privateChannels.channelOf", { name: c.ownerName }) : "");
    return {
      index: index,
      ownerName: c.ownerName,
      channelName: c.name,
      // The channel as the folder names it: the custom name, else "<닉네임>의 채널".
      channelTitle: channelName,
      // "<닉네임> · <채널 이름>"; the nickname alone only for a payload that names no channel.
      label: channelName ? c.ownerName + " · " + channelName : c.ownerName,
      state: c.state,
      sessionCount: c.sessionCount,
      countLabel: c.sessions.length ? t("privateChannels.sessionCount", { count: c.sessions.length }) : noSessionsLabel(),
      lastActivity: latest,
      lastActivityLabel: activityLabel(latest, now),
      sessions: rows,
    };
  }).sort(function (a, b) { return b.lastActivity - a.lastActivity || a.index - b.index; });
}

export function privateSessionAccess(session, myUserId, ownState) {
  var isPrivate = !!(session && Object.prototype.hasOwnProperty.call(session, "channelId") &&
    session.channelId !== undefined && session.channelId !== null);
  if (!isPrivate) return { isPrivate: false, owner: false, adminReadOnly: false, closed: false, readOnly: false };
  var owner = myUserId != null && session.ownerId != null && String(session.ownerId) === String(myUserId);
  var adminReadOnly = !owner;
  // Until the channel record is confirmed active, owner writes fail closed.
  var closed = owner && ownState !== "active";
  return { isPrivate: true, owner: owner, adminReadOnly: adminReadOnly, closed: closed, readOnly: adminReadOnly || closed };
}

var EXEC_REASONS = ["private_execution_disabled", "credential_unavailable", "bubblewrap_unavailable", "probe_failed",
  "network_isolation_unavailable", "skills_unavailable", "resource_limit_reached"];
export function privateExecutionReasonNotice(reason) {
  return EXEC_REASONS.indexOf(reason) >= 0 ? t("privateChannels.exec." + reason) : null;
}
// True for the generic "not ready" notice and for every reason-specific one (same handling in the page).
export function isPrivateExecutionNotice(text) {
  return !!text && (text === privateExecutionNotice() || EXEC_REASONS.some(function (r) { return text === t("privateChannels.exec." + r); }));
}
export function friendlyPrivateError(msg) {
  if (!msg || msg.type !== "error") return null;
  var specific = privateExecutionReasonNotice(msg.reason);
  if (specific) return specific;
  if (msg.error === "Private execution unavailable") return privateExecutionNotice();
  if (msg.code === "channel_refused") return channelRefusedNotice();
  if (msg.code === "channel_name_invalid") return nameInvalidNotice();
  return null;
}

// With a channelId: that exact record's state (a session of an old closed channel stays closed even when a fresh
// active channel exists in the room; an unknown id fails closed as null).
export function ownChannelState(state, roomId, channelId) {
  if (channelId !== undefined) {
    var list = state && state.channelState && state.channelState.own;
    if (!Array.isArray(list)) return null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].roomId === String(roomId) && list[i].channelId === String(channelId)) return list[i].state;
    }
    return null;
  }
  var own = ownForRoom(state, roomId);
  return own ? own.state : null;
}

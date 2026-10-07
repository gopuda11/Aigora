// project-channels.js - personal-channel lifecycle over WebSocket.
//
// The owner is always the authenticated socket user; client channelId / ownerId
// are never read. The room is the client's roomId, else the active session's
// room, else the first room the user belongs to (as a legacy new_session does),
// and MUST pass the server-side membership check. Every refusal is one fixed,
// id-free error.
var { createPrivateSessionAccess } = require("./private-session-access");
var { channelDisplayName } = require("./personal-channels");

var MAX_LIST = 50;
var MAX_NAME = 30;
var TYPES = { channel_ensure: 1, channel_list: 1, channel_close: 1, channel_rename: 1 };

function attachChannels(c) {
  var sm = c.sm;
  var store = c.store;
  var users = c.users;
  var clients = c.clients || [];

  function invalidName(ws) {
    c.sendTo(ws, { type: "error", error: "Channel name must be 1-30 characters", code: "channel_name_invalid" });
  }
  function refuse(ws) {
    c.sendTo(ws, { type: "error", error: "Private channel request refused", code: "channel_refused" });
  }
  function actor(ws) {
    var u = ws._aigoraUser;
    return u && typeof u.id === "string" && u.id && !ws._aigoraAccessRevoked ? u : null;
  }
  function activeRoom(ws, u, msg) {
    var room = msg && msg.roomId !== undefined && msg.roomId !== null ? msg.roomId : null;
    if (room === null) {
      var s = sm.sessions.get(ws._aigoraActiveSession);
      room = s && s.roomId;
    }
    if (!room) { try { var rooms = users.getRoomsForUser(u.id); room = rooms && rooms[0] && rooms[0].id; } catch (_) { room = null; } }
    if (typeof room !== "string" || !room) return null;
    try { return users.canAccessRoom(u.id, room) === true ? room : null; } catch (_) { return null; }
  }
  function readable(ws, u, channelId) {
    var access = createPrivateSessionAccess(c.usersFor(ws));
    var out = [];
    sm.sessions.forEach(function (s) {
      if (s.channelId === channelId && !s.hidden && access.canReadSession(u, s, { visibility: "public" })) out.push(s);
    });
    return out;
  }
  function isAdmin(u, room) {
    try { return users.getRoomRole(u.id, room) === "owner"; } catch (_) { return false; }
  }
  // The member's current nickname: profile.name, else displayName, else the account name.
  function ownerName(id) {
    try { var o = users.findUserById(id); return o ? String((o.profile && o.profile.name) || o.displayName || o.username || "") : ""; } catch (_) { return ""; }
  }
  function canSee(u, rec) {
    try { return users.canAccessRoom(u.id, rec.roomId) === true; } catch (_) { return false; }
  }

  async function view(ws, u, ensured, roomId) {
    var all = await store.listChannels();
    // A closed channel is never reopened; the owner's active one (if any) is listed first so a long history of closed ones cannot push it out.
    var own = all.filter(function (r) { return r.ownerUserId === u.id && canSee(u, r); })
      .sort(function (x, y) { return (y.state === "active") - (x.state === "active"); }).slice(0, MAX_LIST).map(function (r) {
      var o = { channelId: r.channelId, roomId: r.roomId, state: r.state, sessionCount: readable(ws, u, r.channelId).length };
      if (r.name) o.name = r.name;
      var nick = ownerName(r.ownerUserId);
      var shown = channelDisplayName(r, nick), fallback = channelDisplayName(null, nick);
      if (shown) o.displayName = shown;
      if (fallback) o.defaultName = fallback;
      if (nick) o.nick = nick;   // the raw nickname: the client words "<nick>'s channel" in the viewer's language
      return o;
    });
    var room = null;
    if (roomId && isAdmin(u, roomId)) {
      room = { roomId: roomId, channels: all.filter(function (r) { return r.roomId === roomId && r.ownerUserId !== u.id; }).slice(0, MAX_LIST).map(function (r) {
        var list = readable(ws, u, r.channelId);
        var nick = ownerName(r.ownerUserId);
        var ch = {
          ownerName: nick, state: r.state, sessionCount: list.length,
          sessions: list.slice(0, MAX_LIST).map(function (s) { return { id: s.localId, title: s.title || "" }; }),
        };
        var latest = list.reduce(function (m, s) { return typeof s.lastActivity === "number" && s.lastActivity > m ? s.lastActivity : m; }, 0);
        if (latest) ch.lastActivity = latest;
        if (r.name) ch.name = r.name;
        var shown = channelDisplayName(r, nick);
        if (shown) ch.displayName = shown;
        return ch;
      }) };
    }
    var out = { type: "channel_state", own: own, room: room };
    if (ensured) out.ensured = ensured;
    c.sendTo(ws, out);
  }

  // The owner's other tabs and the room's administrators see the new name at once.
  function broadcastView(roomId, ownerId) {
    clients.forEach(function (peer) {
      var p = actor(peer);
      if (!p || (p.id !== ownerId && !isAdmin(p, roomId)) || !canSee(p, { roomId: roomId })) return;
      view(peer, p, null, roomId).catch(function () {});
    });
  }

  async function run(ws, msg) {
    var u = actor(ws);
    var roomId = u && activeRoom(ws, u, msg);
    if (!roomId) return refuse(ws);
    if (msg.type === "channel_ensure") {
      var rec = await store.ensurePersonalChannel(u, roomId);
      return view(ws, u, rec.channelId, roomId);
    }
    if (msg.type === "channel_rename") {
      // Owner only (never an administrator or another member), on an active channel, not for a view-only member.
      var role = null;
      try { role = users.getRoomRole(u.id, roomId); } catch (_) { role = null; }
      var own = (await store.listChannels()).filter(function (r) {
        return r.ownerUserId === u.id && r.roomId === roomId && r.state === "active";
      })[0];
      if (!own || role === "viewer") return refuse(ws);
      if (msg.name != null && typeof msg.name !== "string") return invalidName(ws);
      var nm = typeof msg.name === "string" ? msg.name.trim() : "";
      if (Array.from(nm).length > MAX_NAME) return invalidName(ws);
      if (!(await store.renameChannel(own.channelId, nm))) return refuse(ws);
      broadcastView(roomId, u.id);
      return;
    }
    if (msg.type === "channel_close") {
      var mine = (await store.listChannels()).filter(function (r) {
        return r.ownerUserId === u.id && r.roomId === roomId && r.state === "active";
      })[0];
      if (!mine) return refuse(ws);
      await store.setChannelState(mine.channelId, "closed");
    }
    return view(ws, u, null, roomId);
  }

  // Returns true when the message type belongs to this module.
  function handle(ws, msg) {
    if (!Object.prototype.hasOwnProperty.call(TYPES, msg.type)) return false;
    run(ws, msg).catch(function () { refuse(ws); });
    return true;
  }

  // Resolves to server-built session options, or null (refused).
  async function privateOpts(ws, msg) {
    try {
      var u = actor(ws);
      var roomId = u && activeRoom(ws, u, msg);
      if (!roomId) return null;
      var rec = await store.ensurePersonalChannel(u, roomId);
      if (rec.state !== "active" || !activeRoom(ws, u, msg) || !actor(ws)) return null;
      return { channelId: rec.channelId, ownerId: u.id, roomId: roomId };
    } catch (_) { return null; }
  }

  return { handle: handle, privateOpts: privateOpts, refuse: refuse };
}

module.exports = { attachChannels: attachChannels };

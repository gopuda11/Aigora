// project-social.js - WebSocket handlers for Aigora comments, pins and their
// notifications. The room is always taken from the server-side session bound
// to the socket, never from the client message, and nothing here is written
// to session history or fed to an agent.

var path = require("path");
var { resolveMentions } = require("./member-mentions");
var { createPrivateSessionAccess, isChannelBound } = require("./private-session-access");

var TYPES = {
  social_get: 1, comment_add: 1, comment_edit: 1, comment_delete: 1,
  pin_add: 1, pin_remove: 1, notif_read: 1, notif_prefs: 1,
};

var ERROR_TEXT = {
  forbidden: "이 작업을 할 권한이 없습니다.",
  invalid: "입력한 내용을 확인해 주세요.",
  not_found: "대상을 찾을 수 없습니다.",
  limit: "더 이상 추가할 수 없습니다.",
  rate_limited: "댓글을 너무 빨리 보내고 있습니다. 잠시 후 다시 시도해 주세요.",
  duplicate: "이미 고정된 항목입니다.",
  no_room: "방에 연결된 세션에서만 사용할 수 있습니다.",
};

function attachSocial(ctx) {
  var sm = ctx.sm;
  var clients = ctx.clients;
  var usersModule = ctx.usersModule;
  var sendTo = ctx.sendTo;
  var pushModule = ctx.pushModule || null;
  var isUserOnline = ctx.isUserOnline || function () { return false; };
  var slug = ctx.slug || "";
  var access = createPrivateSessionAccess(usersModule);
  var store = ctx.store || require("./room-social").createSocialStore({
    dir: path.join(require("./config").CONFIG_DIR, "room-social"),
    getRoomRole: function (userId, roomId) { return usersModule.getRoomRole(userId, roomId); },
  });

  function userName(id) {
    var u = usersModule.findUserById(id);
    if (!u) return "알 수 없음";
    var p = u.profile || {};
    return p.name || u.displayName || "Member";
  }

  // Every session (private channel, owner-only room session, shared) goes through
  // the same access check; unknown sessions fail closed. The store keys items by the
  // session's permanent uid, never by localId, which is renumbered on restart, so an
  // old numeric anchor matches no session.
  function sessionById(id) {
    var found = null;
    sm.sessions.forEach(function (s) { if (s.uid && s.uid === id) found = s; });
    return found;
  }
  function allowed(user, s, action) {
    if (!s) return false;
    try { access.assertSessionAction(user, s, { visibility: "public" }, action); return true; } catch (_) { return false; }
  }
  function visible(user, item) { return allowed(user, sessionById(item.sessionId), "read"); }
  function recipients(roomId, s, fn) {
    clients.forEach(function (c) {
      var u = c._aigoraUser;
      if (u && usersModule.getRoomRole(u.id, roomId) && allowed(u, s, "read")) fn(c, u);
    });
  }
  function canNotify(userId, s) {
    var u = usersModule.findUserById(userId);
    return !!u && allowed(u, s, "read");
  }

  function fail(ws, e) {
    var code = e && e.code;
    sendTo(ws, { type: "social_error", text: ERROR_TEXT[code] || "요청을 처리하지 못했습니다." });
    if (!ERROR_TEXT[code]) console.error("[social]", e && e.message ? e.message : e);
  }

  function decorateComment(c) {
    return Object.assign({}, c, { authorName: userName(c.authorId) });
  }
  // sessionLocalId is the current number the client switches by; the stored sessionId is the stable uid.
  function localIdOf(sessionId) {
    var s = sessionById(sessionId);
    return s ? s.localId : null;
  }
  function decoratePin(p) {
    return Object.assign({}, p, { pinnedByName: userName(p.pinnedBy), sessionLocalId: localIdOf(p.sessionId) });
  }
  function decorateNotif(n) {
    var room = usersModule.findRoomById(n.roomId || (sessionById(n.sessionId) || {}).roomId);
    return Object.assign({}, n, { roomId: room && room.id, roomName: room && room.name || "", actorName: userName(n.actorId), sessionLocalId: localIdOf(n.sessionId) });
  }

  function broadcastForSession(roomId, s, obj) {
    recipients(roomId, s, function (c) { sendTo(c, obj); });
  }

  function accessibleRooms(user) {
    var rooms = new Set();
    sm.sessions.forEach(function (s) { if (s.roomId && usersModule.getRoomRole(user.id, s.roomId) && allowed(user, s, "read")) rooms.add(s.roomId); });
    return [...rooms];
  }
  function notificationsFor(user) {
    return accessibleRooms(user).flatMap(function (rid) {
      return store.listNotifications(user.id, rid).filter(function (n) { return visible(user, n); })
        .map(function (n) { return decorateNotif(Object.assign({}, n, { roomId: rid })); });
    }).sort(function (a, b) { return a.ts - b.ts; });
  }
  function unreadFor(user) {
    return notificationsFor(user).filter(function (n) { return !n.read; }).length;
  }

  function sendToUser(userId, obj) {
    clients.forEach(function (c) {
      if (c._aigoraUser && c._aigoraUser.id === userId) sendTo(c, obj);
    });
  }

  // Members of a room by id, with their display names, for @mention matching.
  function roomPeople(roomId) {
    var room = usersModule.findRoomById(roomId);
    if (!room) return [];
    var ids = [room.ownerId].concat((room.members || []).map(function (m) { return m.userId; }));
    var seen = {};
    return ids.filter(function (id) { return id && !seen[id] && (seen[id] = true); })
      .map(function (id) { return { id: id, name: userName(id), role: usersModule.getRoomRole(id, roomId) || "member" }; });
  }

  // A personal channel currently has one member: its owner. Admin read
  // access is intentionally not membership and never enables a mention.
  function mentionPeople(session) {
    if (!session || !session.roomId) return [];
    return roomPeople(session.roomId).filter(function (p) {
      return usersModule.getRoomRole(p.id, session.roomId) && canNotify(p.id, session) &&
        (!isChannelBound(session) || p.id === session.ownerId);
    });
  }
  function prepareMentions(session, actorId, text, aiInstruction) {
    var actor = usersModule.findUserById(actorId);
    var people = actor && session && usersModule.getRoomRole(actorId, session.roomId) && allowed(actor, session, "mutate") && (!isChannelBound(session) || actorId === session.ownerId) ? mentionPeople(session) : [];
    return resolveMentions(text, people, aiInstruction ? { isAiAlias: ctx.isAiAlias || function (name) { return require("./orchestration/router").detectMentions("@" + name).length > 0; } } : null);
  }
  function notifyMessage(session, entry) {
    if (!session || !entry || !entry._mid || !entry.from) return;
    var valid = new Set(mentionPeople(session).map(function (p) { return p.id; }));
    [...new Set(entry.mentionIds || [])].forEach(function (uid) {
      if (uid === entry.from || !valid.has(uid) || !store.getPrefs(uid).inApp) return;
      try {
        var n = store.addNotification(uid, session.roomId, { kind: "mention", actorId: entry.from,
          mid: entry._mid, sessionId: session.uid, preview: entry.text });
        sendToUser(uid, { type: "social_notif", roomId: session.roomId, notif: decorateNotif(n), unread: unreadFor({ id: uid }) });
      } catch (_) { /* removed member or unavailable notification store */ }
    });
  }

  function messageAuthor(session, mid) {
    var h = session.history || [];
    for (var i = h.length - 1; i >= 0; i--) {
      if (h[i] && h[i]._mid === mid) return h[i].type === "user_message" ? h[i].from || null : null;
    }
    return null;
  }

  // "@민" must not match "@민지": the name has to end at a non-letter boundary.
  function mentions(text, name) {
    if (!name) return false;
    var escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp("@" + escaped + "(?![\\p{L}\\p{N}_])", "iu").test(text);
  }

  function notifyAbout(roomId, session, actorId, comment) {
    var kinds = {}; // userId -> kind, strongest wins: mention > reply > comment
    var rank = { comment: 1, reply: 2, mention: 3 };
    function want(id, kind) {
      if (!id || id === actorId) return;
      if (!kinds[id] || rank[kind] > rank[kinds[id]]) kinds[id] = kind;
    }
    want(messageAuthor(session, comment.mid), "comment");
    store.listComments(actorId, roomId, comment.sessionId).forEach(function (c) {
      if (c.mid === comment.mid && c.attachment === comment.attachment && !c.deleted && c.id !== comment.id) want(c.authorId, "reply");
    });
    roomPeople(roomId).forEach(function (p) {
      if (mentions(comment.text, p.name)) want(p.id, "mention");
    });
    Object.keys(kinds).forEach(function (uid) {
      if (!canNotify(uid, session)) return;
      var kind = kinds[uid];
      var prefs = store.getPrefs(uid);
      if (prefs.mentionsOnly && kind !== "mention") return;
      if (prefs.inApp) {
        var n;
        try {
          n = store.addNotification(uid, roomId, {
            kind: kind, actorId: actorId, mid: comment.mid, sessionId: comment.sessionId,
            attachment: comment.attachment, commentId: comment.id, preview: comment.text,
          });
        } catch (_) { return; } // lost access meanwhile
        sendToUser(uid, { type: "social_notif", roomId: roomId, notif: decorateNotif(n), unread: unreadFor({ id: uid }, roomId) });
      }
      if (prefs.push && pushModule && typeof pushModule.sendPushToUser === "function" && !isUserOnline(uid)) {
        try {
          pushModule.sendPushToUser(uid, {
            type: "comment", title: userName(actorId) + "님이 댓글을 남겼어요",
            body: comment.text.slice(0, 100), tag: "aigora-comment-" + uid,
            data: { slug: slug, sessionId: comment.sessionId },
          });
        } catch (e) { console.error("[social] push failed:", e && e.message ? e.message : e); }
      }
    });
  }

  function handleSocialMessage(ws, msg) {
    if (!msg || !TYPES[msg.type]) return false;
    var user = ws._aigoraUser;
    if (!user) { fail(ws, { code: "forbidden" }); return true; }
    var session = sm.sessions.get(ws._aigoraActiveSession) || null;
    var roomId = session && session.roomId;
    if (msg.type === "notif_prefs") {
      try {
        var prefs = store.setPrefs(user.id, msg);
        sendTo(ws, { type: "notif_state", prefs: prefs });
      } catch (e) { fail(ws, e); }
      return true;
    }
    if (!roomId) { fail(ws, { code: "no_room" }); return true; }
    var uid = user.id;
    var sid = session.uid;
    var own = { id: msg.id };
    try {
      if (msg.type === "social_get" && !allowed(user, session, "read")) throw { code: "forbidden" };
      // A comment or pin anchored on a file card must name a live attachment this user may comment on.
      if ((msg.type === "comment_add" || msg.type === "pin_add") && /^att-/.test(String(msg.mid)) &&
          !(ctx.attachments && ctx.attachments.commentable(user, session, msg.mid))) throw { code: "not_found" };
      if ((msg.type === "comment_add" || msg.type === "pin_add") && !allowed(user, session, "mutate")) throw { code: "forbidden" };
      if (msg.type === "comment_edit" || msg.type === "comment_delete") own = store.listComments(uid, roomId).filter(function (x) { return x.id === msg.id; })[0];
      if (msg.type === "pin_remove") own = store.listPins(uid, roomId).filter(function (x) { return x.id === msg.id; })[0];
      if (own && own.sessionId !== undefined && !allowed(user, sessionById(own.sessionId), "mutate")) throw { code: "forbidden" };
      switch (msg.type) {
        case "social_get":
          sendTo(ws, {
            type: "social_state", roomId: roomId, sessionId: sid, sessionLocalId: session.localId,
            mentionMembers: mentionPeople(session),
            comments: store.listComments(uid, roomId, sid).map(decorateComment),
            pins: store.listPins(uid, roomId).filter(function (x) { return visible(user, x); }).map(decoratePin),
            notifs: notificationsFor(user),
            unread: unreadFor(user, roomId), prefs: store.getPrefs(uid),
          });
          break;
        case "comment_add": {
          var c = store.addComment(uid, roomId, { mid: msg.mid, sessionId: sid, attachment: msg.attachment, text: msg.text });
          broadcastForSession(roomId, session, { type: "comment_event", action: "add", roomId: roomId, sessionId: sid, comment: decorateComment(c) });
          notifyAbout(roomId, session, uid, c);
          break;
        }
        case "comment_edit": {
          var e = store.editComment(uid, roomId, msg.id, msg.text);
          broadcastForSession(roomId, sessionById(e.sessionId), { type: "comment_event", action: "edit", roomId: roomId, sessionId: e.sessionId, comment: decorateComment(e) });
          break;
        }
        case "comment_delete": {
          var d = store.deleteComment(uid, roomId, msg.id);
          broadcastForSession(roomId, sessionById(d.sessionId), { type: "comment_event", action: "delete", roomId: roomId, sessionId: d.sessionId, comment: { id: d.id, mid: d.mid, attachment: d.attachment, deleted: true } });
          break;
        }
        case "pin_add": {
          var p = store.addPin(uid, roomId, { mid: msg.mid, sessionId: sid, attachment: msg.attachment, kind: msg.kind, title: msg.title });
          broadcastForSession(roomId, session, { type: "pin_event", action: "add", roomId: roomId, pin: decoratePin(p) });
          break;
        }
        case "pin_remove": {
          var r = store.removePin(uid, roomId, msg.id);
          broadcastForSession(roomId, sessionById(r.sessionId), { type: "pin_event", action: "remove", roomId: roomId, pin: { id: r.id } });
          break;
        }
        case "notif_read":
          accessibleRooms(user).forEach(function (rid) {
            var ids = notificationsFor(user).filter(function (n) { return n.roomId === rid && (msg.ids === "all" || Array.isArray(msg.ids) && msg.ids.includes(n.id)); }).map(function (n) { return n.id; });
            store.markNotificationsRead(uid, rid, ids);
          });
          sendTo(ws, { type: "notif_state", roomId: roomId, unread: unreadFor(user, roomId) });
          break;
      }
    } catch (err) { fail(ws, err); }
    return true;
  }

  return { handleSocialMessage: handleSocialMessage, prepareMentions: prepareMentions, notifyMessage: notifyMessage };
}

module.exports = { attachSocial: attachSocial };

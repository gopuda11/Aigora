// project-shared-posts.js - WebSocket and HTTP glue for shared posts. The room
// comes from the server-side source session or is role-checked by the store;
// the actor is always the authenticated socket/request user.

var path = require("path");
var { createSharedPosts } = require("./shared-posts");
var { createRoomMainThread } = require("./room-main-thread");

var TYPES = { post_share: 1, post_list: 1, post_delete: 1, post_comment: 1, post_pin: 1 };

function attachSharedPosts(ctx) {
  var sm = ctx.sm;
  var users = ctx.usersModule;
  var cfg = require("./config");
  var roomMain = createRoomMainThread({ sm: sm });
  var store = ctx.store || createSharedPosts({
    dir: path.join(cfg.CONFIG_DIR, "shared-posts"), usersModule: users, imagesDir: ctx.imagesDir,
    social: require("./room-social").createSocialStore({
      dir: path.join(cfg.CONFIG_DIR, "room-social"), getRoomRole: function (u, r) { return users.getRoomRole(u, r); },
    }),
    getSession: function (id) {
      var found = null;
      sm.sessions.forEach(function (s) { if (String(s.localId) === String(id)) found = s; });
      return found;
    },
    loadHistory: function (s) { sm.loadSessionHistory(s); },
    onPublished: function (post) {
      toRoom(post.roomId, { type: "post_event", action: "add", roomId: post.roomId, post: post });
      postCard(post);
    },
  });

  function userName(id) {
    var u = users.findUserById(id);
    if (!u) return "알 수 없음";
    var p = u.profile || {};
    return p.name || u.displayName || u.username || "알 수 없음";
  }
  // A shared result also lands in the room's feed as a compact card. It is its
  // own history type (never user_message), so no agent input path reads it.
  // Best-effort: the post is already committed.
  function postCard(post) {
    try {
      roomMain.append(users, post.roomId, {
        type: "shared_post_card", postId: post.id, roomId: post.roomId, authorId: post.authorId,
        authorName: userName(post.authorId), title: post.title, verification: post.verification,
        attachments: (post.attachments || []).map(function (a) { return { mediaType: a.mediaType, url: a.url }; }),
        _ts: post.createdAt,
      });
    } catch (_) { /* the post stands without its card */ }
  }
  function decorateComment(c) {
    return Object.assign({}, c, { authorName: userName(c.authorId) });
  }
  function decoratePin(p) {
    return Object.assign({}, p, { pinnedByName: userName(p.pinnedBy) });
  }
  function toRoom(roomId, obj) {
    ctx.clients.forEach(function (c) {
      var u = c._aigoraUser;
      var ok = false;
      try { ok = !!u && !!users.getRoomRole(u.id, roomId); } catch (_) { ok = false; }
      if (ok) { try { ctx.sendTo(c, obj); } catch (_) { /* keep broadcasting */ } }
    });
  }
  function withSocial(actor, roomId, post) {
    post.comments = store.listPostComments(actor, roomId, post.id).map(decorateComment);
    post.pins = store.listPostPins(actor, roomId, post.id).map(decoratePin);
    return post;
  }
  function roomOf(ws, msg) {
    if (msg.type !== "post_share") return String(msg.roomId || "");
    var found = null;
    sm.sessions.forEach(function (x) { if (String(x.localId) === String(msg.sourceSessionId)) found = x; });
    return found && typeof found.roomId === "string" ? found.roomId : "";
  }

  function handleMessage(ws, msg) {
    if (!msg || !TYPES[msg.type]) return false;
    var actor = ws._aigoraUser ? { id: ws._aigoraUser.id } : null;
    var roomId = roomOf(ws, msg);
    try {
      if (msg.type === "post_share") {
        var p = store.createSharedPost(actor, roomId, msg);
        ctx.sendTo(ws, { type: "post_shared", roomId: roomId, post: p });
      } else if (msg.type === "post_list") {
        ctx.sendTo(ws, { type: "post_list", roomId: roomId, posts: store.listPosts(actor, roomId).map(function (p) { return withSocial(actor, roomId, p); }) });
      } else if (msg.type === "post_delete") {
        store.deletePost(actor, roomId, msg.id);
        toRoom(roomId, { type: "post_event", action: "delete", roomId: roomId, post: { id: msg.id } });
      } else if (msg.type === "post_comment") {
        var c = decorateComment(store.addPostComment(actor, roomId, msg.id, msg.text));
        toRoom(roomId, { type: "post_comment_added", roomId: roomId, comment: c });
      } else {
        var pin = decoratePin(store.pinPost(actor, roomId, msg.id, msg.title));
        toRoom(roomId, { type: "post_pinned", roomId: roomId, pin: pin });
      }
    } catch (e) {
      var code = e && (e.code === "invalid" || e.code === "not_found" || e.code === "forbidden") ? e.code : "failed";
      ctx.sendTo(ws, { type: "post_error", code: code });
    }
    return true;
  }

  // GET /api/shared-posts/<room>/<post>/<attachment>
  function handleHttp(req, res, urlPath) {
    var m = String(urlPath || "").split("?")[0].match(/^\/api\/shared-posts\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_]+)\/([A-Za-z0-9_]+)$/);
    if (!m || req.method !== "GET") return false;
    var actor = req._aigoraUser ? { id: req._aigoraUser.id } : null;
    try {
      var f = store.readAttachment(actor, m[1], m[2], m[3]);
      res.writeHead(200, { "Content-Type": f.mediaType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
      res.end(f.data);
    } catch (e) {
      res.writeHead(e && e.code === "not_found" ? 404 : 403);
      res.end("Forbidden");
    }
    return true;
  }

  return { handleMessage: handleMessage, handleHttp: handleHttp, store: store };
}

module.exports = { attachSharedPosts: attachSharedPosts };

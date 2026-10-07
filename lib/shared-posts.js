// shared-posts.js - an owner explicitly publishes selected private-session
// content into a room as an independent post (copies, never references).
//
// Roles come from usersModule on every call. Source ids stay server-side
// (post._src); the public DTO carries none. Publication is all-or-nothing:
// files are copied into a staging dir, access is re-checked, then the post
// is committed and only then are members notified. Errors use fixed generic
// codes (forbidden | invalid | not_found | failed).

var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var { createPrivateSessionAccess } = require("./private-session-access");

var ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/;
var KEY_RE = /^[A-Za-z0-9_.:-]{1,120}$/;
var MID_RE = /^[A-Za-z0-9_.:-]{1,120}$/;
var IMG_RE = /^\d+-[a-f0-9]+\.(png|jpe?g|gif|webp)$/;
var IMG_SEL_RE = /^(?:\d+-[a-f0-9]+\.(?:png|jpe?g|gif|webp)|[A-Za-z0-9_.:-]{1,120}#a(?:0|[1-9]\d{0,2}))$/;
var POST_RE = /^sp_[a-f0-9]{16}$/;
var ATT_RE = /^a_[a-f0-9]{16}$/;
var MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
var VERIFY = ["unverified", "author_checked", "tests_passed"];
var MAX = { title: 200, body: 20000, evidence: 10000, limitations: 4000, ids: 100, files: 10, bytes: 10 * 1024 * 1024, comment: 2000, comments: 200, pins: 100 };

function fail(code) { var e = new Error(code); e.code = code; return e; }
function str(v, max, required) {
  if (v === undefined || v === null) v = "";
  if (typeof v !== "string") throw fail("invalid");
  v = v.trim();
  if (v.length > max || (required && !v)) throw fail("invalid");
  return v;
}
function ids(v, re, max) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > max) throw fail("invalid");
  v.forEach(function (x) { if (typeof x !== "string" || !re.test(x)) throw fail("invalid"); });
  return v.filter(function (x, i) { return v.indexOf(x) === i; });
}

function resolveImageFiles(hist, selected) {
  var known = {}, anchors = {};
  hist.forEach(function (e) {
    if (!e || e.type !== "user_message" || !Array.isArray(e.imageRefs)) return;
    e.imageRefs.forEach(function (r, i) {
      if (!r || typeof r.file !== "string" || !IMG_RE.test(r.file)) return;
      known[r.file] = r.file;
      if (typeof e._mid === "string" && MID_RE.test(e._mid)) anchors[e._mid + "#a" + i] = r.file;
    });
  });
  var files = selected.map(function (sel) {
    var name = known[sel] || anchors[sel];
    if (!name) throw fail("invalid");
    return name;
  });
  return files.filter(function (x, i) { return files.indexOf(x) === i; });
}

function createSharedPosts(opts) {
  var users = opts.usersModule;
  var access = createPrivateSessionAccess(users);
  var now = opts.now || Date.now;
  var copyFile = opts.copyFile || fs.copyFileSync;
  var project = opts.project || { visibility: "public" };

  function role(actor, roomId) {
    if (!actor || typeof actor.id !== "string" || !actor.id || typeof roomId !== "string" || !ROOM_RE.test(roomId)) throw fail("forbidden");
    if (!users || !opts.dir) throw fail("forbidden");
    var r;
    try { r = users.getRoomRole(actor.id, roomId); } catch (_) { throw fail("forbidden"); }
    if (r !== "owner" && r !== "member") throw fail("forbidden");
    return r;
  }
  function file(roomId) { return path.join(opts.dir, roomId + ".json"); }
  function load(roomId) {
    try { var d = JSON.parse(fs.readFileSync(file(roomId), "utf8")); if (d && Array.isArray(d.posts)) return d; } catch (_) { /* empty */ }
    return { posts: [] };
  }
  function save(roomId, data) {
    fs.mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
    var tmp = file(roomId) + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, file(roomId));
  }
  function filesDir(roomId, postId) { return path.join(opts.dir, "files", roomId, postId); }
  function dto(p) {
    return {
      id: p.id, roomId: p.roomId, authorId: p.authorId, title: p.title, body: p.body, messages: p.messages,
      evidence: p.evidence, verification: p.verification, limitations: p.limitations, createdAt: p.createdAt,
      attachments: p.attachments.map(function (a) {
        return { id: a.id, mediaType: a.mediaType, size: a.size, sha256: a.sha256, url: "/api/shared-posts/" + p.roomId + "/" + p.id + "/" + a.id };
      }),
    };
  }

  // The actor must be the owner of a private (channel-bound) session of this room.
  function authorize(actor, roomId, sessionId) {
    role(actor, roomId);
    try {
      if (typeof sessionId !== "string" || !opts.getSession) throw fail("forbidden");
      var s = opts.getSession(sessionId);
      if (!s || s.roomId !== roomId || s.channelId === undefined || s.channelId === null) throw fail("forbidden");
      access.assertSessionAction(actor, s, project, "mutate");
      return s;
    } catch (_) { throw fail("forbidden"); }
  }

  function createSharedPost(actor, roomId, input) {
    role(actor, roomId);
    if (!input || typeof input !== "object") throw fail("invalid");
    var title = str(input.title, MAX.title, true), body = str(input.body, MAX.body);
    var evidence = str(input.evidence, MAX.evidence), limitations = str(input.limitations, MAX.limitations);
    if (VERIFY.indexOf(input.verification) < 0 || (input.verification === "tests_passed" && !evidence)) throw fail("invalid");
    if (typeof input.idempotencyKey !== "string" || !KEY_RE.test(input.idempotencyKey)) throw fail("invalid");
    var mids = ids(input.selectedMessageIds, MID_RE, MAX.ids), atts = ids(input.selectedAttachmentIds, IMG_SEL_RE, MAX.files);
    var idem = crypto.createHash("sha256").update(actor.id + "\0" + roomId + "\0" + input.idempotencyKey).digest("hex");
    var data = load(roomId);
    var dup = data.posts.filter(function (p) { return p._idem === idem; })[0];
    if (dup) return dto(dup);

    var session = authorize(actor, roomId, input.sourceSessionId);
    if (opts.loadHistory) { try { opts.loadHistory(session); } catch (_) { throw fail("failed"); } }
    var hist = Array.isArray(session.history) ? session.history : [];
    var messages = hist.filter(function (e) { return e && mids.indexOf(e._mid) >= 0 && typeof e.text === "string"; });
    if (messages.length !== mids.length) throw fail("invalid");
    atts = resolveImageFiles(hist, atts);

    var postId = "sp_" + crypto.randomBytes(8).toString("hex");
    var stage = filesDir(roomId, ".tmp-" + postId), final = filesDir(roomId, postId);
    var copies = [];
    try {
      if (atts.length) fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
      atts.forEach(function (name) {
        var src = path.join(opts.imagesDir, name);
        var st = fs.lstatSync(src);
        if (!st.isFile() || st.size > MAX.bytes) throw fail("failed");
        var id = "a_" + crypto.randomBytes(8).toString("hex"), ext = name.split(".").pop().toLowerCase();
        var dest = path.join(stage, id + "." + ext);
        copyFile(src, dest);
        fs.chmodSync(dest, 0o444);
        var buf = fs.readFileSync(dest);
        copies.push({ id: id, ext: ext, mediaType: MIME[ext], size: buf.length, sha256: crypto.createHash("sha256").update(buf).digest("hex") });
      });
      authorize(actor, roomId, input.sourceSessionId); // revocation race: re-check right before commit
      if (atts.length) fs.renameSync(stage, final);
      var post = {
        id: postId, roomId: roomId, authorId: actor.id, title: title, body: body, evidence: evidence,
        verification: input.verification, limitations: limitations, createdAt: now(), attachments: copies,
        messages: messages.map(function (m) { return { role: m.type === "user_message" || m.type === "member_message" ? "user" : "assistant", text: m.text }; }),
        _idem: idem, _src: { sessionId: String(input.sourceSessionId), messageIds: mids, attachmentIds: atts },
      };
      var fresh = load(roomId);
      fresh.posts.push(post);
      try { save(roomId, fresh); } catch (e) { fs.rmSync(final, { recursive: true, force: true }); throw e; }
    } catch (e) {
      fs.rmSync(stage, { recursive: true, force: true });
      throw e.code === "forbidden" || e.code === "invalid" ? e : fail("failed");
    }
    publish(post);
    return dto(post);
  }

  // Only after the post is fully committed; notification problems never undo it.
  function publish(post) {
    try {
      var room = users.findRoomById(post.roomId);
      var members = [room.ownerId].concat((room.members || []).map(function (m) { return m.userId; }));
      members.filter(function (id, i) { return id && id !== post.authorId && members.indexOf(id) === i; }).forEach(function (uid) {
        try {
          if (opts.social) opts.social.addNotification(uid, post.roomId, { kind: "comment", actorId: post.authorId, mid: post.id, sessionId: post.id, preview: post.title });
        } catch (_) { /* member lost access meanwhile */ }
      });
    } catch (_) { /* no notification */ }
    try { if (opts.onPublished) opts.onPublished(dto(post)); } catch (_) { /* listener failure */ }
  }

  function listPosts(actor, roomId) {
    role(actor, roomId);
    return load(roomId).posts.map(dto);
  }
  function find(actor, roomId, postId) {
    var r = role(actor, roomId);
    var p = typeof postId === "string" && POST_RE.test(postId) ? load(roomId).posts.filter(function (x) { return x.id === postId; })[0] : null;
    if (!p) throw fail("not_found");
    return { role: r, post: p };
  }
  function deletePost(actor, roomId, postId) {
    var f = find(actor, roomId, postId);
    if (f.post.authorId !== actor.id && f.role !== "owner") throw fail("forbidden");
    var data = load(roomId);
    data.posts = data.posts.filter(function (x) { return x.id !== postId; });
    save(roomId, data);
    fs.rmSync(filesDir(roomId, postId), { recursive: true, force: true });
  }
  function readAttachment(actor, roomId, postId, attId) {
    var a = find(actor, roomId, postId).post.attachments.filter(function (x) { return x.id === attId; })[0];
    if (!a || !ATT_RE.test(attId)) throw fail("not_found");
    try { return { data: fs.readFileSync(path.join(filesDir(roomId, postId), a.id + "." + a.ext)), mediaType: a.mediaType }; } catch (_) { throw fail("not_found"); }
  }
  // Human-only comments and pins live in the room social store, anchored on the post id.
  function social(actor, roomId, postId, fn) {
    find(actor, roomId, postId);
    if (!opts.social) throw fail("failed");
    return fn(opts.social, { mid: postId, sessionId: postId });
  }
  function addPostComment(actor, roomId, postId, text) {
    return social(actor, roomId, postId, function (s, a) { a.text = text; return s.addComment(actor.id, roomId, a); });
  }
  function pinPost(actor, roomId, postId, title) {
    return social(actor, roomId, postId, function (s, a) { a.kind = "text"; a.title = title; return s.addPin(actor.id, roomId, a); });
  }
  function listPostComments(actor, roomId, postId) {
    return social(actor, roomId, postId, function (s) {
      return s.listComments(actor.id, roomId, postId).slice(-MAX.comments);
    });
  }
  function listPostPins(actor, roomId, postId) {
    return social(actor, roomId, postId, function (s) {
      return s.listPins(actor.id, roomId).filter(function (p) { return p.sessionId === postId; }).slice(-MAX.pins);
    });
  }

  return {
    createSharedPost: createSharedPost, listPosts: listPosts, deletePost: deletePost, readAttachment: readAttachment,
    addPostComment: addPostComment, pinPost: pinPost, listPostComments: listPostComments, listPostPins: listPostPins,
  };
}

module.exports = { createSharedPosts: createSharedPosts };

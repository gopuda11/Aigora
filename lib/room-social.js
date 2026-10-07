// room-social.js - Per-room human-only comments and pins for Aigora.
//
// Deliberately separate from session history: nothing here is ever fed to an
// agent. Permissions are re-derived from getRoomRole on every call, so a
// removed member loses read and write access immediately. Pure store: the
// caller injects the role lookup and the storage directory. Every call reads
// the room file fresh (small, synchronous) so several store instances on one
// directory never serve stale data or overwrite each other's writes.

var fs = require("fs");
var path = require("path");
var crypto = require("crypto");

var MAX_COMMENT_LEN = 2000;
var MAX_COMMENTS_PER_ANCHOR = 200;
var MAX_TITLE_LEN = 200;
var MAX_PINS_PER_ROOM = 100;
var PIN_KINDS = ["text", "image", "file"];
var MAX_NOTIFS_PER_USER = 200;
var NOTIF_KINDS = ["comment", "reply", "mention"];
var DEFAULT_PREFS = { inApp: true, push: false, mentionsOnly: false };
var ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/;
var ROOM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function fail(code, message) {
  var e = new Error(message || code);
  e.code = code;
  return e;
}

function newId(prefix) {
  return prefix + "_" + crypto.randomBytes(8).toString("hex");
}

function anchorKey(mid, attachment) {
  return attachment == null ? mid : mid + "#a" + attachment;
}

function cleanAnchor(input) {
  if (!input || typeof input.mid !== "string" || !ID_RE.test(input.mid)) throw fail("invalid", "mid");
  if (typeof input.sessionId !== "string" || !ID_RE.test(input.sessionId)) throw fail("invalid", "sessionId");
  var attachment = input.attachment == null ? null : input.attachment;
  if (attachment !== null && (!Number.isInteger(attachment) || attachment < 0 || attachment > 999)) throw fail("invalid", "attachment");
  return { mid: input.mid, sessionId: input.sessionId, attachment: attachment };
}

function createSocialStore(opts) {
  var dir = opts.dir;
  var getRoomRole = opts.getRoomRole;
  var now = opts.now || Date.now;
  var rateLimit = opts.rateLimitPerMinute || 10;
  var recent = new Map();

  function fileFor(roomId) {
    return path.join(dir, roomId + ".json");
  }

  function load(roomId) {
    var data = { comments: [], pins: [], notifs: [] };
    try {
      var parsed = JSON.parse(fs.readFileSync(fileFor(roomId), "utf8"));
      if (parsed && Array.isArray(parsed.comments)) data.comments = parsed.comments;
      if (parsed && Array.isArray(parsed.pins)) data.pins = parsed.pins;
      if (parsed && Array.isArray(parsed.notifs)) data.notifs = parsed.notifs;
    } catch (_) { /* missing or unreadable: start empty */ }
    return data;
  }

  function save(roomId, data) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    var tmp = fileFor(roomId) + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, fileFor(roomId));
  }

  // Returns the actor's effective room role, or throws forbidden.
  function requireRole(userId, roomId, writable) {
    if (typeof roomId !== "string" || !ROOM_ID_RE.test(roomId)) throw fail("forbidden");
    var role = getRoomRole(userId, roomId);
    if (!role) throw fail("forbidden");
    if (writable && role !== "owner" && role !== "member") throw fail("forbidden");
    return role;
  }

  function checkRate(userId) {
    var t = now();
    var list = (recent.get(userId) || []).filter(function (x) { return t - x < 60000; });
    if (list.length >= rateLimit) throw fail("rate_limited");
    list.push(t);
    recent.set(userId, list);
  }

  function publicComment(c) {
    return c.deletedTs
      ? { id: c.id, mid: c.mid, sessionId: c.sessionId, attachment: c.attachment, authorId: c.authorId, ts: c.ts, deleted: true, text: "" }
      : c;
  }

  function addComment(userId, roomId, input) {
    requireRole(userId, roomId, true);
    var anchor = cleanAnchor(input);
    var text = typeof input.text === "string" ? input.text.trim() : "";
    if (!text || text.length > MAX_COMMENT_LEN) throw fail("invalid", "text");
    var data = load(roomId);
    var key = anchorKey(anchor.mid, anchor.attachment);
    var used = data.comments.filter(function (c) { return !c.deletedTs && anchorKey(c.mid, c.attachment) === key; }).length;
    if (used >= MAX_COMMENTS_PER_ANCHOR) throw fail("limit");
    checkRate(userId);
    var comment = {
      id: newId("c"), mid: anchor.mid, sessionId: anchor.sessionId, attachment: anchor.attachment,
      authorId: userId, text: text, ts: now(),
    };
    data.comments.push(comment);
    save(roomId, data);
    return comment;
  }

  function findComment(data, id) {
    return data.comments.find(function (c) { return c.id === id && !c.deletedTs; }) || null;
  }

  function editComment(userId, roomId, id, text) {
    requireRole(userId, roomId, true);
    var data = load(roomId);
    var c = findComment(data, id);
    if (!c) throw fail("not_found");
    if (c.authorId !== userId) throw fail("forbidden");
    var clean = typeof text === "string" ? text.trim() : "";
    if (!clean || clean.length > MAX_COMMENT_LEN) throw fail("invalid", "text");
    c.text = clean;
    c.editedTs = now();
    save(roomId, data);
    return c;
  }

  function deleteComment(userId, roomId, id) {
    var role = requireRole(userId, roomId, true);
    var data = load(roomId);
    var c = findComment(data, id);
    if (!c) throw fail("not_found");
    if (c.authorId !== userId && role !== "owner") throw fail("forbidden");
    c.deletedTs = now();
    c.text = "";
    save(roomId, data);
    return c;
  }

  function listComments(userId, roomId, sessionId) {
    requireRole(userId, roomId, false);
    return load(roomId).comments
      .filter(function (c) { return !sessionId || c.sessionId === sessionId; })
      .map(publicComment);
  }

  function commentCounts(userId, roomId, sessionId) {
    requireRole(userId, roomId, false);
    var counts = Object.create(null);
    load(roomId).comments.forEach(function (c) {
      if (c.deletedTs || (sessionId && c.sessionId !== sessionId)) return;
      var k = anchorKey(c.mid, c.attachment);
      counts[k] = (counts[k] || 0) + 1;
    });
    return counts;
  }

  function addPin(userId, roomId, input) {
    requireRole(userId, roomId, true);
    var anchor = cleanAnchor(input);
    if (PIN_KINDS.indexOf(input.kind) < 0) throw fail("invalid", "kind");
    if (input.kind !== "text" && anchor.attachment === null) throw fail("invalid", "attachment");
    var title = typeof input.title === "string" ? input.title.trim() : "";
    if (!title || title.length > MAX_TITLE_LEN) throw fail("invalid", "title");
    var data = load(roomId);
    var key = anchorKey(anchor.mid, anchor.attachment);
    if (data.pins.some(function (p) { return anchorKey(p.mid, p.attachment) === key && p.kind === input.kind; })) throw fail("duplicate");
    if (data.pins.length >= MAX_PINS_PER_ROOM) throw fail("limit");
    var pin = {
      id: newId("p"), mid: anchor.mid, sessionId: anchor.sessionId, attachment: anchor.attachment,
      kind: input.kind, title: title, pinnedBy: userId, ts: now(),
    };
    data.pins.push(pin);
    save(roomId, data);
    return pin;
  }

  function removePin(userId, roomId, id) {
    var role = requireRole(userId, roomId, true);
    var data = load(roomId);
    var i = data.pins.findIndex(function (p) { return p.id === id; });
    if (i < 0) throw fail("not_found");
    if (data.pins[i].pinnedBy !== userId && role !== "owner") throw fail("forbidden");
    var removed = data.pins.splice(i, 1)[0];
    save(roomId, data);
    return removed;
  }

  function listPins(userId, roomId) {
    requireRole(userId, roomId, false);
    return load(roomId).pins.slice();
  }

  // ---- notifications: per user, per room, own read state ----

  // Called by the server after it has decided who to notify. Access is
  // re-checked here so a removed member can never accumulate notifications.
  function addNotification(targetUserId, roomId, input) {
    requireRole(targetUserId, roomId, false);
    var anchor = cleanAnchor(input);
    if (NOTIF_KINDS.indexOf(input.kind) < 0) throw fail("invalid", "kind");
    var data = load(roomId);
    var n = {
      id: newId("n"), userId: targetUserId, kind: input.kind, actorId: String(input.actorId || ""),
      mid: anchor.mid, sessionId: anchor.sessionId, attachment: anchor.attachment,
      commentId: String(input.commentId || ""), preview: String(input.preview || "").slice(0, 140),
      ts: now(), read: false,
    };
    data.notifs.push(n);
    var mine = data.notifs.filter(function (x) { return x.userId === targetUserId; });
    if (mine.length > MAX_NOTIFS_PER_USER) {
      var drop = new Set(mine.slice(0, mine.length - MAX_NOTIFS_PER_USER).map(function (x) { return x.id; }));
      data.notifs = data.notifs.filter(function (x) { return !drop.has(x.id); });
    }
    save(roomId, data);
    return n;
  }

  function listNotifications(userId, roomId) {
    requireRole(userId, roomId, false);
    return load(roomId).notifs.filter(function (n) { return n.userId === userId; });
  }

  function unreadCount(userId, roomId) {
    return listNotifications(userId, roomId).filter(function (n) { return !n.read; }).length;
  }

  function markNotificationsRead(userId, roomId, ids) {
    requireRole(userId, roomId, false);
    var data = load(roomId);
    var all = ids === "all";
    var wanted = new Set(Array.isArray(ids) ? ids : []);
    var changed = false;
    data.notifs.forEach(function (n) {
      if (n.userId === userId && !n.read && (all || wanted.has(n.id))) { n.read = true; changed = true; }
    });
    if (changed) save(roomId, data);
  }

  // ---- preferences: one small file per user, shared by every room ----

  function prefsFile(userId) {
    if (typeof userId !== "string" || !ID_RE.test(userId)) throw fail("invalid", "userId");
    return path.join(dir, "users", userId + ".json");
  }

  function getPrefs(userId) {
    var file = prefsFile(userId);
    var prefs = Object.assign({}, DEFAULT_PREFS);
    try {
      var saved = JSON.parse(fs.readFileSync(file, "utf8"));
      Object.keys(DEFAULT_PREFS).forEach(function (k) { if (typeof saved[k] === "boolean") prefs[k] = saved[k]; });
    } catch (_) { /* defaults */ }
    return prefs;
  }

  function setPrefs(userId, patch) {
    var file = prefsFile(userId);
    var prefs = getPrefs(userId);
    Object.keys(DEFAULT_PREFS).forEach(function (k) { if (patch && typeof patch[k] === "boolean") prefs[k] = patch[k]; });
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    var tmp = file + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(prefs), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return prefs;
  }

  return {
    addComment: addComment, editComment: editComment, deleteComment: deleteComment,
    listComments: listComments, commentCounts: commentCounts,
    addPin: addPin, removePin: removePin, listPins: listPins,
    addNotification: addNotification, listNotifications: listNotifications, unreadCount: unreadCount,
    markNotificationsRead: markNotificationsRead, getPrefs: getPrefs, setPrefs: setPrefs,
  };
}

module.exports = { createSocialStore: createSocialStore, anchorKey: anchorKey };

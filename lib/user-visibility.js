// user-visibility.js - who may see whom (Club Agora: presence and user data never cross rooms).
//
// A viewer scope is built once per recipient:
//   - no viewer id (single-user / no-auth mode): unrestricted, legacy shape (unchanged behaviour)
//   - admin: unrestricted, may also see login usernames
//   - everyone else: only themselves and users sharing a non-archived room; never another
//     person's username (the login is username + PIN, so the username is half a credential).
var crypto = require("crypto");

function scopeFor(users, viewer) {
  if (!viewer || !viewer.id) return { unrestricted: true, admin: true, ids: null, selfId: null };
  var ids = users.getVisibleUserIds(viewer.id);
  return { unrestricted: ids === null, admin: ids === null, ids: ids, selfId: viewer.id };
}

function canSee(scope, userId) {
  return scope.unrestricted || !!(scope.ids && scope.ids[userId]);
}

// Non-identifying avatar fallback (never the login username).
function avatarSeedOf(user) {
  var p = user.profile || {};
  return p.avatarSeed || crypto.createHash("sha256").update("avatar:" + user.id).digest("hex").slice(0, 12);
}

function displayNameOf(scope, user, fallback) {
  var p = user.profile || {};
  return p.name || user.displayName || (scope && scope.admin ? user.username : "") || fallback || "Member";
}

// The identity card sent to one recipient. Extra fields (role, avatarColor) are added by callers.
function shapeUser(scope, user, extra) {
  var p = user.profile || {};
  var out = {
    id: user.id,
    displayName: displayNameOf(scope, user),
    avatarStyle: p.avatarStyle || "thumbs",
    avatarSeed: avatarSeedOf(user),
    avatarCustom: p.avatarCustom || "",
  };
  if (scope.admin || scope.selfId === user.id) out.username = user.username;
  if (extra) Object.keys(extra).forEach(function (k) { out[k] = extra[k]; });
  return out;
}

// Users from a raw list (live ws users, or users.getAllUsers()) that this viewer may see.
function visibleUsers(scope, list, extraFn) {
  return list.filter(function (u) { return canSee(scope, u.id); }).map(function (u) {
    return shapeUser(scope, u, extraFn ? extraFn(u) : null);
  });
}

// The projects_updated user lists for one viewer: who is online anywhere, and the user directory.
function presenceFor(scope, onlineUsers, allUserRecords) {
  return {
    serverUsers: visibleUsers(scope, onlineUsers),
    allUsers: visibleUsers(scope, allUserRecords, function (u) {
      return { role: u.role, avatarColor: (u.profile || {}).avatarColor || "#7c3aed" };
    }),
  };
}

// Copy of a project status for one viewer: onlineUsers limited to people they may see.
// A missing viewer scope (userless broadcast in multi-user mode) gets no online users.
function scopeStatus(scope, status, onlineUsers) {
  var copy = Object.assign({}, status);
  copy.onlineUsers = scope ? visibleUsers(scope, onlineUsers || []) : [];
  return copy;
}

module.exports = { presenceFor: presenceFor, visibleUsers: visibleUsers, scopeStatus: scopeStatus, scopeFor: scopeFor, canSee: canSee, avatarSeedOf: avatarSeedOf, displayNameOf: displayNameOf, shapeUser: shapeUser };

// Strict allow-list for client-supplied dmKey values.
// Accepts exactly two segments separated by a single colon, each containing
// only alphanumeric characters, hyphens, and underscores. This prevents path
// traversal via .. or / while keeping all legitimate userId:otherId keys valid.
var DM_KEY_RE = /^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/;

function isValidDmKey(key) {
  return typeof key === "string" && DM_KEY_RE.test(key);
}

var visibility = require("./user-visibility");

function attachDm(ctx) {
  var users = ctx.users;
  var dm = ctx.dm;
  var projects = ctx.projects;
  var pushModule = ctx.pushModule;

  function handleMessage(ws, msg) {
    if (!ws._aigoraUser) return false;
    var userId = ws._aigoraUser.id;

    if (msg.type === "dm_list") {
      var dmList = dm.getDmList(userId);
      // Enrich with user info; people the viewer shares no room with are not listed
      var dmScope = visibility.scopeFor(users, ws._aigoraUser);
      dmList = dmList.filter(function (d) { return visibility.canSee(dmScope, d.otherUserId); });
      for (var i = 0; i < dmList.length; i++) {
        var otherUser = users.findUserById(dmList[i].otherUserId);
        if (otherUser) dmList[i].otherUser = visibility.shapeUser(dmScope, otherUser, { avatarColor: (otherUser.profile || {}).avatarColor || "#7c3aed" });
      }
      ws.send(JSON.stringify({ type: "dm_list", dms: dmList }));
      return true;
    }

    if (msg.type === "dm_open") {
      if (!msg.targetUserId) return true;

      var openScope = visibility.scopeFor(users, ws._aigoraUser);
      if (!visibility.canSee(openScope, msg.targetUserId)) return true;
      var result = dm.openDm(userId, msg.targetUserId);
      var targetUser = users.findUserById(msg.targetUserId);
      ws.send(JSON.stringify({
        type: "dm_history",
        dmKey: result.dmKey,
        messages: result.messages,
        targetUser: targetUser ? visibility.shapeUser(openScope, targetUser, { avatarColor: (targetUser.profile || {}).avatarColor || "#7c3aed" }) : null,
      }));
      return true;
    }

    if (msg.type === "dm_typing") {
      // Relay typing indicator to DM partner
      var dmKey = msg.dmKey;
      if (!dmKey) return true;
      // Reject any key not matching the strict allow-list pattern to prevent
      // path traversal via crafted dmKey values (lr-6849).
      if (!isValidDmKey(dmKey)) return true;
      var parts = dmKey.split(":");
      if (parts.indexOf(userId) === -1) return true;
      var targetId = parts[0] === userId ? parts[1] : parts[0];
      if (!visibility.canSee(visibility.scopeFor(users, ws._aigoraUser), targetId)) return true;
      projects.forEach(function (ctx) {
        ctx.forEachClient(function (otherWs) {
          if (otherWs === ws) return;
          if (!otherWs._aigoraUser || otherWs._aigoraUser.id !== targetId) return;
          if (otherWs.readyState !== 1) return;
          otherWs.send(JSON.stringify({ type: "dm_typing", dmKey: dmKey, userId: userId, typing: !!msg.typing }));
        });
      });
      return true;
    }

    if (msg.type === "dm_send") {
      if (!msg.dmKey || !msg.text) return true;
      // Reject any key not matching the strict allow-list pattern to prevent
      // path traversal via crafted dmKey values (lr-6849).
      if (!isValidDmKey(msg.dmKey)) return true;
      var parts = msg.dmKey.split(":");

      // Verify sender is a participant
      if (parts.indexOf(userId) === -1) return true;
      var sendTargetId = parts[0] === userId ? parts[1] : parts[0];
      if (!visibility.canSee(visibility.scopeFor(users, ws._aigoraUser), sendTargetId)) return true;
      var message = dm.sendMessage(msg.dmKey, userId, msg.text);
      // Send confirmation to sender
      ws.send(JSON.stringify({ type: "dm_message", dmKey: msg.dmKey, message: message }));
      // Broadcast to target user's connections across all projects
      var targetId = parts[0] === userId ? parts[1] : parts[0];
      projects.forEach(function (ctx) {
        ctx.forEachClient(function (otherWs) {
          if (otherWs === ws) return;
          if (!otherWs._aigoraUser || otherWs._aigoraUser.id !== targetId) return;
          if (otherWs.readyState !== 1) return;
          otherWs.send(JSON.stringify({ type: "dm_message", dmKey: msg.dmKey, message: message }));
        });
      });
      // Send push notification to target user
      var senderName = ws._aigoraUser ? (((ws._aigoraUser.profile || {}).name) || ws._aigoraUser.displayName || "Someone") : "Someone";
      var preview = (msg.text || "").substring(0, 140);
      if (pushModule && pushModule.sendPushToUser) {
        pushModule.sendPushToUser(targetId, {
          type: "dm",
          title: senderName,
          body: preview,
          tag: "dm-" + msg.dmKey,
          dmKey: msg.dmKey,
        });
      }
      // Create in-app notification via any project's notifications module
      var _nmCtx = null;
      projects.forEach(function (pCtx) { if (!_nmCtx && pCtx.getNotificationsModule) _nmCtx = pCtx; });
      if (_nmCtx) {
        var _nm = _nmCtx.getNotificationsModule();
        if (_nm) {
          _nm.notify("mate_dm", {
            senderName: senderName,
            preview: preview,
            mateId: userId,
          });
        }
      }
      return true;
    }

    if (msg.type === "dm_add_favorite") {
      if (!msg.targetUserId) return true;
      var favScope = visibility.scopeFor(users, ws._aigoraUser);
      if (!visibility.canSee(favScope, msg.targetUserId)) return true;
      users.removeDmHidden(userId, msg.targetUserId);
      var updatedFavorites = users.addDmFavorite(userId, msg.targetUserId);
      var allUsersList = visibility.visibleUsers(favScope, users.getAllUsers(), function (u) {
        return { role: u.role, avatarColor: (u.profile || {}).avatarColor || "#7c3aed" };
      });
      ws.send(JSON.stringify({
        type: "dm_favorites_updated",
        dmFavorites: updatedFavorites,
        allUsers: allUsersList,
      }));
      return true;
    }

    if (msg.type === "dm_remove_favorite") {
      if (!msg.targetUserId) return true;
      users.addDmHidden(userId, msg.targetUserId);
      var updatedFavorites = users.removeDmFavorite(userId, msg.targetUserId);
      ws.send(JSON.stringify({
        type: "dm_favorites_updated",
        dmFavorites: updatedFavorites,
      }));
      return true;
    }

    return false;
  }

  return {
    handleMessage: handleMessage,
  };
}

module.exports = { attachDm: attachDm };


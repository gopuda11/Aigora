var { createPrivateSessionAccess } = require("./private-session-access");
var { onAccessChanged } = require("./private-session-revocation");

function attachPrivateRevocation(ctx) {
  var access = createPrivateSessionAccess(ctx.users);
  var revokedUsers = new Set();
  function bound(s) { return !!s && s.channelId !== undefined && s.channelId !== null; }
  function canRead(actor, s) {
    if (!access.canReadSession(actor, s, { visibility: "public" })) return false;
    if (!access.canReadSession({ id: s.ownerId }, s, { visibility: "public" })) return false;
    try {
      return ctx.sm.isPersonalSessionActive(s);
    } catch (_) { return false; }
  }
  function mayRead(ws, s) {
    if (!bound(s)) return true;
    return !ws._aigoraAccessRevoked && canRead(ws._aigoraUser, s);
  }
  // Live-traffic gate: private sessions follow mayRead; a room session also needs current room access,
  // so a removed member or anyone in an archived room stops receiving frames without sending one.
  function mayReceive(ws, s) {
    if (bound(s)) return mayRead(ws, s);
    if (!s || !s.roomId || !ws._aigoraUser) return true;
    return ctx.users.canAccessSession(ws._aigoraUser.id, s, { visibility: "public" }) === true;
  }
  function detach(ws, s) {
    var active = ws._aigoraActiveSession === s.localId;
    if (active) ws._aigoraActiveSession = null;
    if (ws._aigoraUnread) delete ws._aigoraUnread[s.localId];
    var actor = ws._aigoraUser;
    if (actor) {
      var stored = ctx.presence.getPresence(ctx.slug, actor.id);
      if (stored && stored.sessionId === s.localId) ctx.presence.clearPresence(ctx.slug, actor.id);
    }
    if (active && actor && ctx.onDetach) {
      try { ctx.onDetach(ws, s, actor.id); } catch (_) {}
    }
    if (active) ctx.sendTo(ws, { type: "error", error: "Room access revoked" });
  }
  function checkSocket(ws) {
    ctx.sm.sessions.forEach(function (s) {
      if (bound(s) && !mayRead(ws, s)) detach(ws, s);
    });
    var active = ctx.sm.sessions.get(ws._aigoraActiveSession);
    if (active && !bound(active) && !mayReceive(ws, active)) {
      detach(ws, active);
      if (ws._aigoraUser) ctx.sendTo(ws, { type: "rooms_state", rooms: ctx.users.getRoomsForUser(ws._aigoraUser.id) });
    }
  }
  function cancelWork(s) {
    function revoked(item) {
      if (item && item.ws && !mayRead(item.ws, s)) return true;
      var actor = item && item.ws ? item.ws._aigoraUser : null;
      var id = actor ? actor.id : s._privateWorkOwnerId;
      if (!actor && item && Object.prototype.hasOwnProperty.call(item, "userId")) id = item.userId;
      return revokedUsers.has(id) || (item && item.ws && item.ws._aigoraAccessRevoked) || !canRead({ id: id }, s);
    }
    if (s.pendingMessages) s.pendingMessages = s.pendingMessages.filter(function (m) { return !revoked(m); });
    if (s.messageQueue && typeof s.messageQueue.discard === "function") s.messageQueue.discard(revoked);
    if (s.scheduledMessage && revoked(s.scheduledMessage)) {
      clearTimeout(s.scheduledMessage.timer);
      s.scheduledMessage = null;
      s.rateLimitAutoContinuePending = false;
    }
    ["pendingPermissions", "pendingAskUser", "pendingElicitations"].forEach(function (key) {
      var pending = s[key] || {};
      Object.keys(pending).forEach(function (id) {
        if (!revoked(pending[id])) return;
        var entry = pending[id];
        delete pending[id];
        if (key === "pendingPermissions") delete ctx.sm.permissionRequestIndex[id];
        try { entry.resolve(key === "pendingElicitations" ? { action: "reject" } : { behavior: "deny", message: "Room access revoked" }); } catch (_) {}
      });
    });
    if (require("./private-claude-execution").scopeChanged(s) || require("./private-codex-execution").scopeChanged(s) || revoked({ userId: s._privateWorkOwnerId })) {
      var query = s.queryInstance;
      var controller = s.abortController;
      var worker = s.worker || (s._adapterWorkerState && s._adapterWorkerState.worker);
      s.queryInstance = null;
      s.abortController = null;
      s.worker = null;
      s._adapterWorkerState = null;
      s.isProcessing = false;
      try { if (controller) controller.abort(); } catch (_) {}
      try { if (s._privateScopeCleanup) s._privateScopeCleanup(); } catch (_) {}
      try { if (worker) worker.kill(); } catch (_) {}
      try { if (query) { var closing = query.close(); if (closing && closing.catch) closing.catch(function () {}); } } catch (_) {}
    }
  }
  function recheck(change) {
    change = change || {};
    if (change.tokensRevoked) revokedUsers.add(change.userId);
    ctx.clients.forEach(function (ws) {
      try {
        if (change.tokensRevoked && ws._aigoraUser && ws._aigoraUser.id === change.userId) ws._aigoraAccessRevoked = true;
        if (ws._aigoraUser) {
          try {
            var current = ctx.users.findUserById(ws._aigoraUser.id);
            if (current) ws._aigoraUser = current;
          } catch (_) {}
        }
        checkSocket(ws);
      } catch (_) {}
    });
    ctx.sm.sessions.forEach(function (s) { if (bound(s)) { try { cancelWork(s); } catch (_) {} } });
    // A token revocation is one event: it cancels the work that existed then, not work the user starts after logging in again.
    if (change.tokensRevoked) revokedUsers.delete(change.userId);
    try { ctx.broadcastPresence(); } catch (_) {}
  }
  return { mayRead: mayRead, mayReceive: mayReceive, checkSocket: checkSocket, recheck: recheck, dispose: onAccessChanged(recheck), isPrivate: bound };
}
module.exports = { attachPrivateRevocation: attachPrivateRevocation };

module.exports = require("./extensions").select("project-notifications", function () {
var module = { exports: {} };
// project-notifications.js - Global notification queue, event-based creation
// Single instance shared by all projects. All formatting logic lives here.
// Follows attachXxx(ctx) pattern per MODULE_MAP.md

var fs = require("fs");
var path = require("path");
var config = require("./config");

var NOTIF_FILE = path.join(config.CONFIG_DIR, "notifications.json");
var REMINDER_INTERVAL = 60 * 60 * 1000; // 1 hour

function generateId() {
  var rand = Math.random().toString(36).substring(2, 8);
  return "n_" + Date.now() + "_" + rand;
}

// ========================================================
// Event -> notification formatters
// ========================================================

var formatters = {
  auth_required: function (data) {
    var vendor = data.vendor || "claude";
    var title = data.title || ((vendor === "codex" ? "Codex" : "Claude") + " requires an API key");
    return {
      type: "auth_required",
      title: title,
      body: data.body || "Ask the administrator to add the provider API key.",
      meta: {
        vendor: vendor,



      },
    };
  },

  loop_complete: function (data) {
    var reason = data.reason || "complete";
    var body = (reason === "pass" || reason === "complete")
      ? "Completed after " + (data.iterations || 0) + " iteration(s)"
      : reason === "max_iterations"
        ? "Reached max iterations (" + (data.maxIterations || "?") + ")"
        : reason === "stopped"
          ? "Stopped by user"
          : "Ended due to error";
    return {
      type: reason === "error" ? "loop_error" : "loop_complete",
      title: (data.name || "Loop") + " " + (reason === "error" ? "failed" : "complete"),
      body: body,
      meta: { reason: reason, iterations: data.iterations },
    };
  },

  response_done: function (data) {
    return {
      type: "response_done",
      title: data.title || "Response ready",
      body: data.preview || "",
    };
  },

  permission_request: function (data) {
    return {
      type: "permission_request",
      title: data.title || "Permission requested",
      body: data.body || "",
      meta: { requestId: data.requestId, toolName: data.toolName, toolInput: data.toolInput || null },
    };
  },

  // A contained room turn waits for an admin. Audience (admin ids) is set by the caller; meta.status is null while pending.
  approval_request: function (data) {
    return {
      type: "approval_request",
      title: data.title || "승인 요청",
      body: data.body || "",
      meta: {
        requestId: data.requestId, toolName: data.toolName || "", summary: data.summary || "",
        requesterName: data.requesterName || "", riskText: data.riskText || "", roomId: data.roomId || null, roomName: data.roomName || "",
        sessionId: data.sessionId || null, status: null, persistent: true,
      },
    };
  },

  mate_dm: function (data) {
    return {
      type: "mate_dm",
      title: data.senderName || "Message",
      body: data.preview || "Sent you a message",
    };
  },

  mention_response: function (data) {
    return {
      type: "mention_response",
      title: data.title || "Mention response ready",
      body: data.preview || "",
      meta: { avatarMateId: data.avatarMateId || null },
    };
  },

  user_mention: function (data) {
    return {
      type: "user_mention",
      title: "@" + (data.fromName || "Someone"),
      body: data.preview || "Mentioned you",
      meta: {
        fromUserId: data.fromUserId || null,
        fromName: data.fromName || "",
        fromAvatarStyle: data.fromAvatarStyle || null,
        fromAvatarSeed: data.fromAvatarSeed || null,
        fromAvatarColor: data.fromAvatarColor || null,
        fromAvatarCustom: data.fromAvatarCustom || "",
        persistent: true,
      },
    };
  },
};

// ========================================================
// Module (global singleton)
// ========================================================

function attachNotifications(ctx) {
  var broadcastAll = ctx.broadcastAll;
  var sendToUser = ctx.sendToUser || null; // (userId, msg) -> void; iterates all project clients
  var isPrivateSession = ctx.isPrivateSession || null; // (slug, sessionId) -> bool, for records stored before audiences existed
  var pushModule = ctx.pushModule;
  var notifications = loadNotifications();
  var reminderTimer = null;

  function loadNotifications() {
    try {
      var raw = fs.readFileSync(NOTIF_FILE, "utf8");
      var parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(settleStaleApproval);
    } catch (e) {}
    return [];
  }

  // A pending approval from before a restart can no longer be decided: its turn is gone.
  function settleStaleApproval(n) {
    if (n && n.type === "approval_request" && n.meta && !n.meta.status) n.meta.status = "cancelled";
    return n;
  }

  function isPendingApproval(n) { return n.type === "approval_request" && !(n.meta && n.meta.status); }
  function isCounted(n) { return n.type !== "approval_request" || isPendingApproval(n); }

  // Durable write of a list; throws on failure.
  function persistNotifications(list) {
    var tmp = NOTIF_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, NOTIF_FILE);
  }
  function saveNotifications() {
    try {
      persistNotifications(notifications);
    } catch (e) {
      console.error("[notifications] Failed to save:", e.message);
    }
  }

  // A private notification carries its audience (user ids); records stored
  // before audiences existed are resolved through the session when possible.
  function audienceOf(n) {
    if (Array.isArray(n.audience)) return n.audience;
    var bound = false;
    try { bound = !!isPrivateSession && n.sessionId != null && !!isPrivateSession(n.slug, n.sessionId); } catch (e) { bound = true; }
    return bound ? [n.ownerId || ""] : null;
  }

  function visibleTo(n, userId) {
    var aud = audienceOf(n);
    return !aud || (!!userId && aud.indexOf(userId) !== -1);
  }

  function userIdOf(ws) {
    return ws && ws._aigoraUser && ws._aigoraUser.id || null;
  }

  function getUnreadCount(userId) {
    return notifications.filter(function (n) { return visibleTo(n, userId) && isCounted(n); }).length;
  }

  // Counts carried by broadcasts: only what every client may see.
  function publicCount() {
    return notifications.filter(function (n) { return !audienceOf(n) && isCounted(n); }).length;
  }

  // --- Core API ---

  function notify(event, data) {
    data = data || {};
    var formatter = formatters[event];
    if (!formatter) {
      console.warn("[notifications] Unknown event: " + event);
      return null;
    }
    // One approval notification per request: a repeated request id (replay) returns the existing one.
    if (event === "approval_request" && data.requestId) {
      for (var i = 0; i < notifications.length; i++) {
        if (notifications[i].type === "approval_request" && notifications[i].meta && notifications[i].meta.requestId === data.requestId) return notifications[i];
      }
    }
    var formatted = formatter(data || {});
    if (!formatted) return null;

    var notif = {
      id: generateId(),
      type: formatted.type || event,
      title: formatted.title || "",
      body: formatted.body || "",
      slug: data.slug || "",
      sessionId: data.sessionId || null,
      mateId: data.mateId || null,
      ownerId: data.ownerId || null,
      targetUserId: data.targetUserId || null,
      createdAt: Date.now(),
      meta: formatted.meta || {},
    };
    if (Array.isArray(data.audience)) notif.audience = data.audience.filter(function (id) { return typeof id === "string" && id; });
    else if (data.private) notif.audience = data.targetUserId ? [data.targetUserId] : [];
    if (notif.audience && !notif.audience.length) return null; // private and nobody to tell
    notifications.unshift(notif);
    saveNotifications();
    var payload = {
      type: "notification_created",
      notification: notif,
      unreadCount: notif.audience ? getUnreadCount(notif.audience[0]) : publicCount(),
    };
    // If targeted at a specific user, deliver only to that user's connections.
    // Otherwise broadcast to everyone (existing behavior).
    if (notif.audience) {
      if (typeof sendToUser === "function") notif.audience.forEach(function (id) { sendToUser(id, Object.assign({}, payload, { unreadCount: getUnreadCount(id) })); });
    } else if (notif.targetUserId && typeof sendToUser === "function") {
      sendToUser(notif.targetUserId, payload);
    } else {
      broadcastAll(payload);
      recount();
    }
    return notif;
  }

  // Broadcast frames carry the public count; people with private notifications
  // are told their own count afterwards.
  function recount() {
    if (typeof sendToUser !== "function") return;
    var seen = {};
    notifications.forEach(function (n) {
      (audienceOf(n) || []).forEach(function (id) {
        if (!id || seen[id]) return;
        seen[id] = true;
        sendToUser(id, { type: "notification_dismissed", ids: [], unreadCount: getUnreadCount(id) });
      });
    });
  }

  // Private notifications can be dismissed only by their audience, and the
  // news goes only to it.
  function removeAndTell(gone, userId, all) {
    if (!gone.length) return;
    notifications = notifications.filter(function (n) { return gone.indexOf(n) === -1; });
    saveNotifications();
    var open = gone.filter(function (n) { return !audienceOf(n); }).map(function (n) { return n.id; });
    var hasPrivate = notifications.some(function (n) { return audienceOf(n); });
    if (all && !hasPrivate && open.length === gone.length) broadcastAll({ type: "notification_dismissed_all", unreadCount: 0 });
    else if (open.length) broadcastAll({ type: "notification_dismissed", ids: open, unreadCount: publicCount() });
    if (open.length < gone.length && userId && typeof sendToUser === "function") {
      sendToUser(userId, { type: "notification_dismissed", ids: gone.map(function (n) { return n.id; }), unreadCount: getUnreadCount(userId) });
    }
    recount();
  }

  function dismiss(ids, userId) {
    removeAndTell(notifications.filter(function (n) { return ids.indexOf(n.id) !== -1 && visibleTo(n, userId); }), userId, false);
  }

  function dismissAll(userId) {
    removeAndTell(notifications.filter(function (n) { return visibleTo(n, userId); }), userId, true);
  }

  // The request was decided, stopped or cancelled: the item stays listed with its outcome and leaves the pending count.
  function resolveApproval(requestId, status) {
    if (!requestId || ["allow", "deny", "cancelled"].indexOf(status) === -1) return null;
    var n = notifications.filter(function (x) { return x.type === "approval_request" && x.meta && x.meta.requestId === requestId; })[0];
    if (!n || n.meta.status) return null;
    n.meta.status = status;
    saveNotifications();
    var aud = audienceOf(n) || [];
    if (typeof sendToUser === "function") aud.forEach(function (id) {
      sendToUser(id, { type: "notification_updated", notification: n, unreadCount: getUnreadCount(id) });
    });
    return n;
  }

  // --- Periodic reminder ---

  function startReminder() {
    // Reminder push is suppressed in multi-user mode: the unread count is
    // per-project state that would leak to all push subscribers regardless of
    // which user owns the notifications.
  }

  function stopReminder() {
    if (reminderTimer) { clearInterval(reminderTimer); reminderTimer = null; }
  }

  startReminder();

  // --- Connection state (called per-client with sendTo) ---

  function sendConnectionState(ws, sendTo) {
    if (!sendTo) return;
    var uid = userIdOf(ws);
    sendTo(ws, {
      type: "notifications_state",
      notifications: notifications.filter(function (n) { return visibleTo(n, uid); }),
      unreadCount: getUnreadCount(uid),
    });
  }

  // --- Message handler ---

  function handleNotificationMessage(ws, msg) {
    if (msg.type === "notification_dismiss") {
      dismiss(msg.ids || [], userIdOf(ws));
      return true;
    }
    if (msg.type === "notification_dismiss_all") {
      dismissAll(userIdOf(ws));
      return true;
    }
    return false;
  }

  return {
    notify: notify,
    resolveApproval: resolveApproval,
    getUnreadCount: getUnreadCount,
    sendConnectionState: sendConnectionState,
    handleNotificationMessage: handleNotificationMessage,
    stopReminder: stopReminder,
    // Drops a room's notifications (room purge); returns how many were removed.
    purgeRoom: function (roomId) {
      var before = notifications.length;
      var kept = notifications.filter(function (n) { return !(n && n.meta && n.meta.roomId === roomId); });
      if (kept.length !== before) { persistNotifications(kept); notifications = kept; }   // throws: memory is untouched
      return before - kept.length;
    },
  };
}

module.exports = { attachNotifications: attachNotifications };

return module.exports;
});

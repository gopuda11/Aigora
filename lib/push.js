var webpush = require("web-push");
var fs = require("fs");
var path = require("path");
var config = require("./config");
var store = require("./store");

function loadOrCreateVapidKeys() {
  var dir = config.CONFIG_DIR;
  var keyFile = path.join(dir, "vapid.json");

  // Synchronous read at startup so initPush() can return keys immediately.
  try {
    var data = fs.readFileSync(keyFile, "utf8");
    return JSON.parse(data);
  } catch (e) {
    // Generate new keys and write via store.js (async, 0o600).
  }

  var keys = webpush.generateVAPIDKeys();
  store.writeJson("vapid.json", keys).catch(function (err) {
    process.stderr.write("[push] Failed to write vapid.json: " + (err && err.message ? err.message : err) + "\n");
  });
  return keys;
}

var DEFAULT_VAPID_SUBJECT = "mailto:aigora@localhost";

// VAPID subject: AIGORA_PUSH_SUBJECT env, then daemon config push.subject, then a neutral default.
// Must be an https: or mailto: URL (web-push validates this); invalid values fall back to the default.
// The subject is not part of a subscription's identity, so changing it keeps existing subscriptions.
function resolveVapidSubject(env, cfg) {
  env = env || process.env;
  var candidates = [env.AIGORA_PUSH_SUBJECT, cfg && cfg.push && cfg.push.subject];
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i];
    if (typeof c !== "string" || !c) continue;
    try {
      var proto = new URL(c).protocol;
      if (proto === "https:" || proto === "mailto:") return c;
    } catch (e) {}
  }
  return DEFAULT_VAPID_SUBJECT;
}

function initPush() {
  var keys = loadOrCreateVapidKeys();

  var vapidDetails = {
    subject: resolveVapidSubject(process.env, (function () { try { return config.loadConfig(); } catch (e) { return null; } })()),
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
  };

  var dir = config.CONFIG_DIR;
  var subFile = path.join(dir, "push-subs.json");
  var subscriptions = new Map();

  // Load persisted subscriptions synchronously at startup; writes go through store.js.
  try {
    var saved = JSON.parse(fs.readFileSync(subFile, "utf8"));
    if (saved.vapidKey && saved.vapidKey !== keys.publicKey) {
      saved.subs = [];
    }
    var subs = saved.subs || saved;
    if (Array.isArray(subs)) {
      for (var i = 0; i < subs.length; i++) {
        if (subs[i] && subs[i].endpoint) subscriptions.set(subs[i].endpoint, subs[i]);
      }
    }
  } catch (e) {}

  function save() {
    // Async atomic write through store.js (queued, 0o600). Fire-and-forget.
    store.writeJson("push-subs.json", {
      vapidKey: keys.publicKey,
      subs: Array.from(subscriptions.values()),
    }).catch(function (err) {
      process.stderr.write("[push] save failed: " + (err && err.message ? err.message : err) + "\n");
    });
  }

  save();

  // Purge stale subscriptions on startup
  var startupEndpoints = Array.from(subscriptions.keys());
  for (var si = 0; si < startupEndpoints.length; si++) {
    (function (ep) {
      var sub = subscriptions.get(ep);
      webpush.sendNotification(sub, JSON.stringify({ type: "test" }), { TTL: 0, vapidDetails: vapidDetails })
        .then(function () {})
        .catch(function (err) {
          if (err.statusCode === 403 || err.statusCode === 410 || err.statusCode === 404) {
            subscriptions.delete(ep);
            save();
          }
        });
    })(startupEndpoints[si]);
  }

  function addSubscription(sub, replaceEndpoint, userId) {
    if (!sub || !sub.endpoint) return;
    // Remove previous subscription from the same client if endpoint changed.
    // Only delete replaceEndpoint if it belongs to the same caller — prevents an
    // unauthenticated request from unsubscribing arbitrary known endpoints.
    if (replaceEndpoint && replaceEndpoint !== sub.endpoint) {
      var existing = subscriptions.get(replaceEndpoint);
      // In multi-user mode (userId set), require ownership match.
      // In single-user / anonymous mode (userId null), allow the replacement
      // only if the stored subscription is also anonymous (no _userId).
      var callerOwns = userId
        ? (existing && existing._userId === userId)
        : (existing && !existing._userId);
      if (callerOwns) {
        subscriptions.delete(replaceEndpoint);
      }
    }
    // Attach userId for per-user targeting (backward-compatible: old subs without userId still work for broadcast)
    if (userId) sub._userId = userId;
    // Store immediately, then validate async. Invalid subs get cleaned on first sendPush.
    subscriptions.set(sub.endpoint, sub);
    save();
    // Validate with a silent push (TTL 0 = don't actually deliver if device offline)
    webpush.sendNotification(sub, JSON.stringify({ type: "test" }), { TTL: 0, vapidDetails: vapidDetails })
      .then(function () {})
      .catch(function (err) {
        if (err.statusCode === 403 || err.statusCode === 410 || err.statusCode === 404) {
          subscriptions.delete(sub.endpoint);
          save();
        }
      });
  }

  function removeSubscription(endpoint) {
    subscriptions.delete(endpoint);
    save();
  }

  function sendPush(payload) {
    var json = JSON.stringify(payload);
    subscriptions.forEach(function (sub, endpoint) {
      webpush.sendNotification(sub, json, { vapidDetails: vapidDetails })
        .then(function () {})
        .catch(function (err) {
          if (err.statusCode === 410 || err.statusCode === 404 || err.statusCode === 403) {
            subscriptions.delete(endpoint);
            save();
          }
        });
    });
  }

  function sendPushToUser(userId, payload) {
    if (!userId) return;
    var json = JSON.stringify(payload);
    subscriptions.forEach(function (sub, endpoint) {
      if (sub._userId !== userId) return;
      webpush.sendNotification(sub, json, { vapidDetails: vapidDetails })
        .then(function () {})
        .catch(function (err) {
          if (err.statusCode === 410 || err.statusCode === 404 || err.statusCode === 403) {
            subscriptions.delete(endpoint);
            save();
          }
        });
    });
  }

  // Drop subscriptions whose user no longer qualifies (removed or token-revoked).
  function pruneSubscriptions(keep) {
    var changed = false;
    Array.from(subscriptions.keys()).forEach(function (endpoint) {
      var sub = subscriptions.get(endpoint);
      var uid = sub && sub._userId;
      var ok = true;
      if (uid) { try { ok = keep(uid) !== false; } catch (e) { ok = false; } }
      if (!ok) { subscriptions.delete(endpoint); changed = true; }
    });
    if (changed) save();
  }

  return {
    pruneSubscriptions: pruneSubscriptions,
    publicKey: keys.publicKey,
    addSubscription: addSubscription,
    removeSubscription: removeSubscription,
    sendPush: sendPush,
    sendPushToUser: sendPushToUser,
  };
}

module.exports = { initPush, resolveVapidSubject, DEFAULT_VAPID_SUBJECT };


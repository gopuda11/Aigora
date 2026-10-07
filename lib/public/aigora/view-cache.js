// view-cache.js - the last rendered feed of the views the person visited most recently (room feed, private
// session, ...), kept in memory ONLY (never in storage), so coming back to one paints it at once while the
// server's replay is reconciled in the background.
//
// An entry = { html, roomId, sessionId, from }: the markup that was in the feed, the room it belongs to, the session
// whose feed it is and thread.historyFrom at that time. Security: an entry must never outlive the viewer's right to
// see it - the page prunes the cache whenever the room list or the session list changes (prune(), which drops every
// entry whose room or session is no longer visible) and clears it on logout / another viewer (clear()).

import { t, onLangChange } from "./i18n.js";

export var MAX_VIEWS = 6;

// A live binding: rebuilt on a language switch so importers always read the current text.
export var SKELETON_HTML = skeletonHtml();
onLangChange(function () { SKELETON_HTML = skeletonHtml(); });

function skeletonHtml() {
  return '<div class="ai-skeleton" role="status" aria-label="' + t("viewCache.loading") + '">' +
  '<span class="ai-sk-line" style="width:38%"></span><span class="ai-sk-block" style="width:72%"></span>' +
  '<span class="ai-sk-line" style="width:24%"></span><span class="ai-sk-block" style="width:58%"></span>' +
  '<span class="ai-sk-line" style="width:31%"></span><span class="ai-sk-block" style="width:66%"></span></div>';
}

export function createViewCache(max) {
  var limit = max > 0 ? max : MAX_VIEWS;
  var entries = {};
  var order = [];   // least recently used first

  function touch(k) { order = order.filter(function (x) { return x !== k; }); order.push(k); }

  return {
    put: function (key, entry) {
      if (key == null || !entry || typeof entry.html !== "string" || !entry.html) return;
      var k = String(key);
      entries[k] = { html: entry.html, roomId: entry.roomId == null ? null : String(entry.roomId), sessionId: entry.sessionId == null ? null : entry.sessionId, from: entry.from || 0 };
      touch(k);
      while (order.length > limit) delete entries[order.shift()];
    },
    get: function (key) {
      var k = key == null ? null : String(key);
      if (k == null || !entries[k]) return null;
      touch(k);
      return entries[k];
    },
    has: function (key) { return key != null && !!entries[String(key)]; },
    drop: function (key) {
      if (key == null) return;
      var k = String(key);
      delete entries[k];
      order = order.filter(function (x) { return x !== k; });
    },
    // keep(entry) -> false drops the entry (a room or session the viewer no longer has).
    prune: function (keep) {
      order = order.filter(function (k) {
        if (keep(entries[k])) return true;
        delete entries[k];
        return false;
      });
    },
    clear: function () { entries = {}; order = []; },
    size: function () { return order.length; },
    keys: function () { return order.slice(); },
  };
}

// Keep an entry only while its room is in the viewer's room list and its session is in the session list.
// A list that has not been received yet (null) cannot prove anything: the entry is kept until it arrives.
export function visibleEntry(entry, roomIds, sessionIds) {
  if (!entry) return false;
  if (entry.roomId != null && roomIds && roomIds.indexOf(entry.roomId) === -1) return false;
  if (entry.sessionId != null && sessionIds && sessionIds.indexOf(String(entry.sessionId)) === -1) return false;
  return true;
}

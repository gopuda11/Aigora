// One explicit pending send per browser tab, stored separately for each room
// and authenticated user. Never erase a draft until acknowledged or restored.
export function queueStorage(storage, slug, userId) {
  var prefix = "aigora.queued." + encodeURIComponent(slug) + "." + encodeURIComponent(userId) + ".";
  var index = prefix + "pending";
  function key(q) { return prefix + "room." + encodeURIComponent(q.roomId == null ? "private" : q.roomId); }
  function keys() {
    var raw = storage.getItem(index), list = [];
    if (raw && raw.startsWith(prefix + "room.")) list = [raw]; // previous single-room format
    else if (raw) list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter(function (k) { return typeof k === "string" && k.startsWith(prefix + "room."); }) : [];
  }
  return {
    save: function (q) {
      try {
        var list = keys(), target = key(q);
        if (!list.includes(target)) list.push(target);
        storage.setItem(target, JSON.stringify(q)); storage.setItem(index, JSON.stringify(list)); return true;
      }
      catch (_) { return false; }
    },
    restore: function () {
      try {
        var list = keys();
        var q = null;
        for (var target of list) {
          try { q = JSON.parse(storage.getItem(target)); } catch (_) { q = null; }
          if (q && typeof q.draft === "string" && typeof q.text === "string" && q.sessionId != null && Array.isArray(q.images) && Array.isArray(q.files)) break;
          q = null;
        }
        if (!q || typeof q.draft !== "string" || typeof q.text !== "string" || q.sessionId == null || !Array.isArray(q.images) || !Array.isArray(q.files)) return null;
        // Socket delivery may have happened before reload. Do not replay it.
        if (q.state === "sending") { q.state = "failed"; q.error = "client.queueUnconfirmed"; }
        if (q.state !== "waiting" && q.state !== "failed") return null;
        q.confirmed = false; q.roomsReady = false; q.switchRequested = false; q.retryAt = 0;
        return q;
      } catch (_) { return null; }
    },
    clear: function (q) {
      try {
        var list = keys().filter(function (k) { return k !== key(q); });
        // Update the index first: a failed write must leave the durable draft available.
        if (list.length) storage.setItem(index, JSON.stringify(list)); else storage.removeItem(index);
        storage.removeItem(key(q));
      } catch (_) { /* in-memory recovery remains available */ }
    },
  };
}

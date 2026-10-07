// scroll-memory.js - where the reader was in each feed (room / channel / session view), so that coming back to a
// view lands there at once instead of replaying a scroll from the top. Kept in memory and mirrored to sessionStorage
// (which may be missing or throw; the memory copy then still serves the page's lifetime).
//
// A record = { top, atBottom, from }: the scrollTop, whether the reader was at (within BOTTOM_SLACK px of) the bottom,
// and the first history entry that was loaded then (thread.historyFrom). When older history was loaded
// ("이전 대화 더 보기") and is not any more, `top` points into content that is gone: fall back to the bottom.

export var BOTTOM_SLACK = 40;
var STORE_KEY = "aigora.feedScroll.v1";
var MAX_VIEWS = 60;

export function createScrollMemory(storage) {
  var memory = {};
  var order = [];
  try {
    var raw = storage && storage.getItem(STORE_KEY);
    var saved = raw ? JSON.parse(raw) : null;
    if (saved && typeof saved === "object" && !Array.isArray(saved)) {
      Object.keys(saved).forEach(function (k) {
        var r = saved[k];
        if (r && typeof r.top === "number" && isFinite(r.top)) { memory[k] = { top: r.top, atBottom: !!r.atBottom, from: typeof r.from === "number" ? r.from : 0 }; order.push(k); }
      });
    }
  } catch (_) { /* an unreadable copy is just an empty one */ }

  function persist() {
    try { if (storage) storage.setItem(STORE_KEY, JSON.stringify(memory)); } catch (_) { /* memory only */ }
  }

  return {
    // el: the feed element; from: thread.historyFrom (0 when the whole history is loaded).
    save: function (key, el, from) {
      if (key == null || !el) return;
      var k = String(key);
      var atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK;
      memory[k] = { top: el.scrollTop, atBottom: atBottom, from: from || 0 };
      order = order.filter(function (x) { return x !== k; });
      order.push(k);
      while (order.length > MAX_VIEWS) delete memory[order.shift()];
      persist();
    },
    // Where to put a feed that has just been rendered: { bottom: true } or { top: n }. null = nothing remembered.
    target: function (key, from) {
      var r = key == null ? null : memory[String(key)];
      if (!r) return null;
      if (r.atBottom || (from || 0) > r.from) return { bottom: true };
      return { top: r.top };
    },
    has: function (key) { return key != null && !!memory[String(key)]; },
  };
}

// Put a rendered feed where the reader left it (instantly: scroll-behavior is forced to auto for this one move).
// The caller runs this synchronously after rendering, before the browser paints.
export function applyTarget(el, target) {
  if (!el) return;
  var prev = el.style ? el.style.scrollBehavior : "";
  if (el.style) el.style.scrollBehavior = "auto";
  var max = Math.max(0, el.scrollHeight - el.clientHeight);
  el.scrollTop = !target || target.bottom ? el.scrollHeight : Math.min(target.top, max);
  if (el.style) el.style.scrollBehavior = prev;
}

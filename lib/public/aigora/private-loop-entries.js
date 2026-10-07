// Loops and schedules are not supported in private channels (v1): while the open session is channel-bound,
// their sidebar entries are hidden and their openers refuse. The server refuses them regardless.

export var LOOP_ENTRY_IDS = ["loop-tool-btn", "scheduler-btn", "ralph-loop-section"];

var hidden = false;

export function loopEntriesHidden(sessions, activeId) {
  if (!Array.isArray(sessions) || activeId === undefined || activeId === null) return false;
  for (var i = 0; i < sessions.length; i++) {
    var s = sessions[i];
    if (!s || String(s.id) !== String(activeId)) continue;
    return Object.prototype.hasOwnProperty.call(s, "channelId") && s.channelId !== undefined && s.channelId !== null;
  }
  return false;
}

export function syncPrivateLoopEntries(sessions, activeId, doc) {
  hidden = loopEntriesHidden(sessions, activeId);
  var d = doc || (typeof document !== "undefined" ? document : null);
  if (!d) return hidden;
  LOOP_ENTRY_IDS.forEach(function (id) {
    try {
      var el = d.getElementById(id);
      if (!el || !el.style) return;
      el.style.display = hidden ? "none" : "";
      if (hidden) el.setAttribute("aria-hidden", "true"); else el.removeAttribute("aria-hidden");
    } catch (_) {}
  });
  return hidden;
}

export function loopEntriesBlocked() { return hidden; }

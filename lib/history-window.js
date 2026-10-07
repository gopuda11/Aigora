/**
 * history-window.js - pure helpers that pick which part of a session's history
 * is replayed to a client, and shrink it for the wire. UI/replay only: nothing
 * here touches what is persisted or what an agent receives.
 *
 * Why turns, not raw entries: one streamed answer is hundreds of `delta`
 * entries, so a window counted in raw entries could start in the middle of an
 * answer (or skip it entirely). A window always starts at a turn boundary and
 * holds at least the last N complete turns.
 */

// Entries that open a visible turn in the room feed.
var TURN_START_TYPES = {
  user_message: 1,
  member_message: 1,
  shared_post_card: 1,
  coaching_share_card: 1,
};

// Entries that close an agent turn; a boundary found after one of these is safe to cut at.
var TURN_END_TYPES = { done: 1, result: 1, error: 1 };

function isTurnStart(entry) {
  return !!entry && TURN_START_TYPES[entry.type] === 1;
}

// A member note or card can land in the middle of a running agent turn. Cutting
// there would orphan the turn's earlier deltas, so step back to the user_message
// that opened it, unless the previous turn was already closed.
function snapToTurnOpen(history, i) {
  if (history[i].type === "user_message") return i;
  for (var j = i - 1; j >= 0; j--) {
    var t = history[j] && history[j].type;
    if (t === "user_message") return j;
    if (TURN_END_TYPES[t] === 1 || isTurnStart(history[j])) return i;
  }
  return i;
}

/**
 * Start index of a window over history[0..end) holding the last `turns` turns,
 * or -1 when the array holds fewer than `turns` turn starts (the caller then
 * knows older entries may exist elsewhere, e.g. on disk).
 */
function findWindowStart(history, end, turns) {
  var count = 0;
  for (var i = Math.min(end, history.length) - 1; i >= 0; i--) {
    if (!isTurnStart(history[i])) continue;
    count++;
    if (count >= turns) return snapToTurnOpen(history, i);
  }
  return -1;
}

/**
 * Merge runs of consecutive `delta` entries into one entry so a whole answer is
 * a single wire item. A delta that carries a different _mid starts a new
 * message and is never merged. Returns a new array; inputs are not mutated.
 */
function coalesceDeltas(items) {
  var out = [];
  var last = null;
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (it && it.type === "delta" && typeof it.text === "string") {
      if (last && (!it._mid || it._mid === last._mid)) {
        last.text += it.text;
        continue;
      }
      last = Object.assign({}, it);
      out.push(last);
      continue;
    }
    last = null;
    out.push(it);
  }
  return out;
}

module.exports = {
  HISTORY_WINDOW_TURNS: 20,
  isTurnStart: isTurnStart,
  findWindowStart: findWindowStart,
  coalesceDeltas: coalesceDeltas,
};

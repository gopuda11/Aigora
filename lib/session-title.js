// Titles of private-channel sessions: "새 세션" until the first AI instruction, then a cleaned preview of it.
var NEW_CHANNEL_SESSION_TITLE = "새 세션";
var PREVIEW_MAX = 24;

// First line that still has text once its leading @mentions are gone, whitespace-collapsed, at most 24 code points.
// "" when nothing is left.
function firstInstructionTitle(text) {
  if (typeof text !== "string") return "";
  var line = text.split(/\r?\n/).map(function (l) {
    return l.replace(/^\s*(?:@\S+\s*)+/, "").replace(/\s+/g, " ").trim();
  }).filter(Boolean)[0] || "";
  return Array.from(line).slice(0, PREVIEW_MAX).join("").trim();
}

// The start of a session's first user message (<= 120 chars), for the sidebar's grouping of similar sessions. Cached once
// found; "" while unknown (no message yet, or the start of the history was trimmed out of memory).
function firstInstructionPreview(session) {
  if (typeof session._firstInstruction === "string") return session._firstInstruction;
  if (session._historyBaseIndex > 0 || !Array.isArray(session.history)) return "";
  for (var i = 0; i < session.history.length && i < 200; i++) {
    var h = session.history[i];
    if (h && h.type === "user_message" && typeof h.text === "string" && h.text.trim()) {
      session._firstInstruction = Array.from(h.text.replace(/\s+/g, " ").trim()).slice(0, 120).join("");
      return session._firstInstruction;
    }
  }
  return "";
}

module.exports = { NEW_CHANNEL_SESSION_TITLE: NEW_CHANNEL_SESSION_TITLE, firstInstructionTitle: firstInstructionTitle, firstInstructionPreview: firstInstructionPreview };

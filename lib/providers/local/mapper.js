"use strict";
// Turns OpenAI-style stream chunks into neutral parts the adapter maps to session events:
//   { kind: "text", text }  { kind: "thinking", text }  { kind: "usage", input, output }  { kind: "finish", reason }
// Reasoning arrives either in a delta field (reasoning_content / reasoning, see quirks) or inline as <think>...</think>
// in the content (qwen3, deepseek-r1); both become "thinking" and never reach "text". Tags may be split across chunks.
// tool_calls deltas are ignored: this release is chat-only.
var OPEN = "<think>", CLOSE = "</think>";

// Longest suffix of s that is a proper prefix of tag (a tag possibly cut by a chunk boundary).
function partialTail(s, tag) {
  for (var n = Math.min(tag.length - 1, s.length); n > 0; n--) if (tag.indexOf(s.slice(s.length - n)) === 0) return n;
  return 0;
}

function createChunkMapper(quirks) {
  var inThink = false, hold = "", sawContent = false, afterThink = false;
  var keys = (quirks && quirks.reasoningKeys) || ["reasoning_content", "reasoning"];

  function emitText(parts, kind, s) {
    if (!s) return;
    if (kind === "text") {
      if (afterThink) { s = s.replace(/^\s+/, ""); if (!s) return; afterThink = false; }
      sawContent = true;
    }
    var last = parts[parts.length - 1];
    if (last && last.kind === kind) last.text += s; else parts.push({ kind: kind, text: s });
  }

  function content(parts, s, final) {
    var text = hold + s;
    hold = "";
    for (;;) {
      var tag = inThink ? CLOSE : OPEN;
      var i = text.indexOf(tag);
      if (i === -1) break;
      emitText(parts, inThink ? "thinking" : "text", text.slice(0, i));
      text = text.slice(i + tag.length);
      if (inThink) afterThink = true;
      inThink = !inThink;
    }
    var keep = final ? 0 : partialTail(text, inThink ? CLOSE : OPEN);
    hold = keep ? text.slice(text.length - keep) : "";
    emitText(parts, inThink ? "thinking" : "text", text.slice(0, text.length - keep));
  }

  return {
    feed: function (chunk) {
      var parts = [];
      if (!chunk || typeof chunk !== "object") return parts;
      var choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
      var delta = choice && choice.delta;
      if (delta) {
        for (var k = 0; k < keys.length; k++) {
          if (typeof delta[keys[k]] === "string" && delta[keys[k]]) { emitText(parts, "thinking", delta[keys[k]]); break; }
        }
        if (typeof delta.content === "string" && delta.content) content(parts, delta.content, false);
      }
      if (chunk.usage && typeof chunk.usage === "object") {
        parts.push({ kind: "usage", input: Number(chunk.usage.prompt_tokens) || 0, output: Number(chunk.usage.completion_tokens) || 0 });
      }
      if (choice && choice.finish_reason) parts.push({ kind: "finish", reason: String(choice.finish_reason) });
      return parts;
    },
    // End of stream: release text held back while waiting for a tag to complete.
    flush: function () {
      var parts = [];
      if (hold) content(parts, "", true);
      return parts;
    },
    sawContent: function () { return sawContent; },
  };
}

module.exports = { createChunkMapper: createChunkMapper };

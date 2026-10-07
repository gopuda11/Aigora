"use strict";

// Secret/link redaction for model output that is shown to a room or sent to another model.

// Model output can quote private conversation links, capability URLs or credentials it saw.
// Those never reach the room.
var REDACTIONS = [
  [/https?:\/\/(?:www\.)?(?:chatgpt\.com|chat\.openai\.com)\/[^\s)"'<>\]]*/gi, "[redacted ChatGPT link]"],
  [/https?:\/\/[^\s\/$.?#].[^\s]*\/mcp\/[a-f0-9]{64}\b[^\s)"'<>\]]*/gi, "[redacted MCP capability URL]"],
  [/\/mcp\/[a-f0-9]{64}\b/gi, "/mcp/[redacted]"],
  [/https?:\/\/[A-Za-z0-9_.-]*trycloudflare\.com[^\s)"'<>\]]*/gi, "[redacted tunnel URL]"],
  [/\b((?:controller|task|api|access)[_ -]?(?:key|token)|token|secret|password|authorization)(["']?\s*[:=]\s*["']?)(?:bearer\s+)?[^\s"',;]+/gi, "$1$2[redacted]"],
  [/\bBearer\s+[A-Za-z0-9._~+\/=-]{16,}/gi, "Bearer [redacted]"],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, "[redacted key]"],
  [/\bAIzaSy[A-Za-z0-9_-]{33}\b/g, "[redacted key]"],
];

function redactText(text) {
  var count = 0;
  var out = String(text == null ? "" : text);
  REDACTIONS.forEach(function (rule) {
    var matches = out.match(rule[0]);
    if (matches) count += matches.length;
    out = out.replace(rule[0], rule[1]);
  });
  return { text: out, count: count };
}

module.exports = { redactText: redactText };

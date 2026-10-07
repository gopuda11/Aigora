"use strict";
// Differences between OpenAI-compatible servers live here as data, not as code forks.
//   streamUsage    send stream_options.include_usage (the usage chunk is still optional: the adapter falls back to an estimate)
//   reasoningKeys  delta fields that carry the reasoning text, first match wins
//   noThinkBody    extra request fields that skip the reasoning phase when config.thinking is false
//   dataPlaneOnly  only /v1/chat/completions and /v1/models are ever called (no vendor management APIs)
var BASE = { streamUsage: true, reasoningKeys: ["reasoning_content", "reasoning"], noThinkBody: null };
var TABLE = {
  ollama: { streamUsage: true, reasoningKeys: ["reasoning", "reasoning_content"], noThinkBody: { reasoning_effort: "none" } },
  lmstudio: { streamUsage: true, reasoningKeys: ["reasoning_content", "reasoning"], noThinkBody: null },
  llamacpp: { streamUsage: true, reasoningKeys: ["reasoning_content"], noThinkBody: null },
  // Generic OpenAI-compatible server that honours reasoning_effort:"none" (hint only; never guessed from the port).
  openai: { streamUsage: true, reasoningKeys: ["reasoning_content", "reasoning"], noThinkBody: { reasoning_effort: "none" } },
  vllm: { streamUsage: true, reasoningKeys: ["reasoning_content", "reasoning"], noThinkBody: null },
};
var PORTS = { "11434": "ollama", "1234": "lmstudio", "8080": "llamacpp", "8000": "vllm" };

function detectServer(baseUrl, hint) {
  if (hint && Object.prototype.hasOwnProperty.call(TABLE, hint)) return hint;
  try { return PORTS[new URL(baseUrl).port] || "generic"; } catch (_) { return "generic"; }
}

// -> { server, streamUsage, reasoningKeys, noThinkBody }
function quirksFor(baseUrl, hint) {
  var server = detectServer(baseUrl, hint);
  return Object.assign({ server: server }, BASE, TABLE[server] || {});
}

module.exports = { quirksFor: quirksFor, detectServer: detectServer, TABLE: TABLE };

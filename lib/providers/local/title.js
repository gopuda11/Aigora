"use strict";
// Session titles from a local model (providers.local.titleModel). One non-streaming request, thinking off, short
// timeout. Resolves a title string, or null on ANY problem (not configured, disabled, server down, timeout, empty or
// unusable answer) so the caller falls back to the session's own adapter. Never rejects.
var cfgMod = require("./config");
var client = require("./client");
var quirksMod = require("./quirks");

var TITLE_TIMEOUT_MS = 15000;
var MAX_TITLE = 100;
var SYSTEM = "Write a short title (at most 8 words) for the conversation below, in the same language as the user's messages. Reply with the title only: no quotes, no punctuation at the end, no explanation.";

function cleanTitle(raw) {
  if (typeof raw !== "string") return null;
  var s = raw.replace(/<think>[\s\S]*?<\/think>/gi, "");
  if (/<\/?think>/i.test(s)) return null;      // unclosed reasoning block: nothing trustworthy left
  s = s.trim().split(/\r?\n/).filter(function (l) { return l.trim(); })[0] || "";
  s = s.replace(/^(?:title|제목)\s*[:：]\s*/i, "").replace(/^[#*\s]+|[*\s]+$/g, "").replace(/^["'“”‘’「『`]+|["'“”‘’」』`.。]+$/g, "").trim();
  if (s.length < 2) return null;
  return s.slice(0, MAX_TITLE);
}

function titleModelConfigured(getConfig) {
  var cfg = (getConfig || cfgMod.loadLocalConfig)();
  return cfg.enabled && !!cfg.titleModel;
}

// o: { getConfig?, fetch?, timeoutMs? }
async function generateLocalTitle(userMessages, o) {
  o = o || {};
  try {
    var cfg = (o.getConfig || cfgMod.loadLocalConfig)();
    if (!cfg.enabled || !cfg.titleModel || !Array.isArray(userMessages) || !userMessages.length) return null;
    var target = cfgMod.targetFor(cfg, cfg.titleModel);
    // A "<id>/<model>" whose endpoint was removed must not be sent to the primary server under that name.
    if (!target.endpoint && cfg.titleModel.indexOf("/") > 0 && cfgMod.allowedModels(cfg).indexOf(cfg.titleModel) === -1) return null;
    var quirks = quirksMod.quirksFor(target.baseUrl, target.server);
    var body = {
      model: target.model, max_tokens: 200, temperature: 0.2,
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: userMessages.map(function (m) { return "- " + String(m).slice(0, 200); }).join("\n") }],
    };
    if (quirks.noThinkBody) Object.assign(body, quirks.noThinkBody);
    var res = await client.completeOnce({ baseUrl: target.baseUrl, apiKey: target.apiKey, body: body, fetch: o.fetch, timeoutMs: o.timeoutMs || TITLE_TIMEOUT_MS });
    var msg = res && res.choices && res.choices[0] && res.choices[0].message;
    return cleanTitle(msg && msg.content);
  } catch (_) { return null; }
}

module.exports = { generateLocalTitle: generateLocalTitle, titleModelConfigured: titleModelConfigured, cleanTitle: cleanTitle };

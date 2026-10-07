// "@" suggestion list. No DOM, no network. The ids and aliases mirror lib/orchestration/router.js (MENTION_ALIASES,
// AT_ONLY_ALIASES); a test keeps the two in step. The server validates every choice again.
// `label` and `sub` are getters: the shown words follow the interface language (i18n.js).
import { t } from "./i18n.js";

// Offered by the picker, in this order. `names` is what the "@" list matches against; `mention` is the canonical text.
export var AGENTS = [
  { id: "claude", label: "Claude", get sub() { return t("aiPicker.subClaude"); }, mention: "@claude", names: ["claude", "클로드"] },
  { id: "codex", label: "Codex", get sub() { return t("aiPicker.subCodex"); }, mention: "@codex", names: ["codex", "gpt", "gpt-codex", "코덱스"] },

  { id: "local", get label() { return t("aiPicker.localLabel"); }, get sub() { return t("aiPicker.subLocal"); }, mention: "@local", names: ["local", "로컬", "ollama", "올라마"] },
];

// Extra endpoints (config, via publicStatus) are added to AGENTS by setEndpoints(status); nothing about them is hardcoded.
var FIXED = AGENTS.slice();
var ALIAS = {};
function rebuildAliases() {
  ALIAS = {};
  AGENTS.forEach(function (a) { a.names.forEach(function (n) { ALIAS[n] = a.id; }); });
}

// One picker entry per endpoint the owner made pickable and whose last probe lists a model. id = the frame's agent value.
export function endpointAgents(status) {
  var eps = status && Array.isArray(status.endpoints) ? status.endpoints : [];
  return eps.filter(function (e) { return e && typeof e.id === "string" && e.pickable === true && e.ready === true; }).map(function (e) {
    var label = typeof e.label === "string" && e.label ? e.label : e.id;
    var names = [e.id].concat(Array.isArray(e.aliases) ? e.aliases : []).map(function (n) { return String(n).toLowerCase(); });
    return { id: "local:" + e.id, endpoint: true, label: label, canWork: e.canWork === true, privateAllowed: e.privateAllowed === true,
      get sub() { return t("aiPicker.subEndpoint") + (this.canWork ? t("aiPicker.subCanWork") : ""); }, mention: "@" + e.id, names: names };
  });
}

// Replace the endpoint entries (AGENTS keeps its identity).
export function setEndpoints(status) {
  AGENTS.length = 0;
  FIXED.concat(endpointAgents(status)).forEach(function (a) { AGENTS.push(a); });
  rebuildAliases();
}
rebuildAliases();

export function agentById(id) {
  for (var i = 0; i < AGENTS.length; i++) if (AGENTS[i].id === id) return AGENTS[i];
  return null;
}

// provider as ready, 로컬 when the local-model provider is enabled and ready. Unknown usage offers nothing.
// the primary local model. The server checks every choice again.
export function availableAgents(usage, localReady, opts) {
  var ready = {};
  var priv = !!(opts && opts.private);
  (usage && Array.isArray(usage.providers) ? usage.providers : []).forEach(function (p) { if (p && p.status === "ready") ready[p.id] = true; });
  return AGENTS.filter(function (a) {
    if (priv && !a.endpoint && a.id === "local") return false;
    if (priv && a.endpoint && a.privateAllowed !== true) return false;
    return a.endpoint ? true : a.id === "local" ? !!localReady : ready[a.id] === true;
  });
}

// The first @mention in the draft, as the router reads it (an @ at the start or after a space/bracket/punctuation).
export function typedAgent(text) {
  var s = typeof text === "string" ? text : "";
  if (typeof s.normalize === "function") s = s.normalize("NFC");
  var re = /(^|[\s(\[{,.;:!?"'])@([A-Za-zㄱ-힣][A-Za-z0-9ㄱ-힣_-]*)/g;
  var m;
  while ((m = re.exec(s))) {
    var id = ALIAS[m[2].toLowerCase()];
    if (id) return id;
  }
  return null;
}

// What the chip shows: a typed mention wins over the picked agent; nothing picked is 자동.
export function chipState(pick, text, priv) {
  var typed = priv ? null : typedAgent(text); // a private session does not read "@" mentions
  var id = typed || pick || null;
  var a = id ? agentById(id) : null;
  return { id: id, typed: !!typed, text: a ? a.label : t("aiPicker.auto") };
}

// "@" being typed at the caret: at the start or after whitespace. -> { start, end, query } | null
export function atQuery(text, caret) {
  var s = typeof text === "string" ? text : "";
  var upto = s.slice(0, typeof caret === "number" ? caret : s.length);
  var m = /(^|\s)@([\p{L}\p{M}\p{N}_.-]*)$/u.exec(upto);
  if (!m) return null;
  return { start: upto.length - m[2].length - 1, end: upto.length, query: m[2] };
}

export function suggestions(query, options) {
  var q = String(query || "").normalize("NFC").toLowerCase();
  return options.filter(function (a) {
    return !q || a.names.some(function (n) { return n.indexOf(q) === 0; }) || a.label.toLowerCase().indexOf(q) === 0;
  });
}

// Replace the "@query" at the caret with the canonical mention and a space; returns the new text and caret.
export function insertMention(text, q, agent) {
  var s = typeof text === "string" ? text : "";
  var rest = s.slice(q.end);
  var add = agent.mention + (rest.charAt(0) === " " ? "" : " ");
  return { text: s.slice(0, q.start) + add + rest, caret: q.start + add.length };
}

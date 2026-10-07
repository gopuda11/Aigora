module.exports = require("../extensions").select("orchestration/router", function () {
var module = { exports: {} };
// router.js - aigora-router-v1: deterministic multi-agent routing for one
// room message.
//
// Pure function of (text, root session vendor). No model call, no clock, no
// I/O, no randomness: the same input always yields the same plan, so a plan
// can be recomputed and audited later from the stored inputs.
//
// Signals (Korean + English):
//   evidence      - the answer needs external, current or cited material
//                   -> research step on the admin's researchModel (only when one is set and listed)
//   browser       - the task is an action in a web browser
//   code          - repository/code work -> the root session's own agent
//   verification  - an independent check -> the *other* session agent
// Explicit @mentions override the signals and keep the order they were
// written in. So does explicit natural-language assignment ("코덱스로
// 리뷰해줘", "use codex to research"), see detectAssignments; it is recorded
// as rule "nl.assign". A plan never has more than MAX_STEPS sequential steps.
// Extra endpoints (a ChatGPT bridge, ...) come in as DATA: route({ endpoints: [{ id, aliases, model }] }). Their ids count for "@" only,
// their aliases for "@" and natural-language assignment; each yields { agent: "local", model: "<id>/<model>" }.

"use strict";

var VERSION = "aigora-router-v1";
var MAX_STEPS = 3;
// Agents the composer's AI picker may choose.
var PICKABLE = ["claude", "codex", "local"];

var AGENTS = {
  claude: { id: "claude", label: "Claude", kind: "session" },
  codex: { id: "codex", label: "Codex", kind: "session" },

  // Local model (Ollama), chat-only. Only an explicit @mention/pick, or a route the engine decided (Clef executor, default off),
  // ever lands here; route() itself never chooses it from a signal or sentence.
  local: { id: "local", label: "로컬 (Ollama)", kind: "session" },
};

// @mention aliases -> agent id. Matching is case-insensitive.
var MENTION_ALIASES = {
  claude: "claude", "클로드": "claude",
  codex: "codex", gpt: "codex", "gpt-codex": "codex", "코덱스": "codex",
};

// Aliases that count only as an explicit "@name" (never in natural-language assignment, where common words such as
// "로컬이" or "local" would send ordinary sentences to the slow local model).
var AT_ONLY_ALIASES = { local: "local", "로컬": "local", ollama: "local", "올라마": "local" };

// Each rule: [signal, id, RegExp]. The rule id is reported in the plan so a
// reviewer can see exactly which phrase moved the message.
var RULES = [
  ["evidence", "en.research", /\b(?:research|look\s+up|web\s+search|search\s+(?:the\s+)?(?:web|internet|online)|latest|up-to-date|citations?|cite|literature|papers?|news|evidence)\b/],
  ["evidence", "en.sources", /\bsources?\b(?!\s+(?:code|file|files|tree|map|maps))/],
  ["evidence", "ko.research", /조사|검색|찾아\s?(?:봐|줘|주)|최신|출처|논문|문헌|리서치|근거\s?자료|동향|뉴스/],
  ["browser", "en.browser", /\b(?:browser|web\s?page|website|navigate\s+to|click|screenshot|scrape|open\s+(?:the\s+)?(?:page|site|url|link))\b/],
  ["browser", "ko.browser", /브라우저|웹\s?페이지|웹사이트|사이트에?\s?접속|접속해|클릭|스크린샷|화면\s?캡처|페이지\s?열어/],
  ["code", "en.code", /\b(?:code|coding|implement|implementation|refactor|bug|bugfix|fix|function|script|compile|build|unit\s+tests?|repository|repo|pull\s+request|stack\s+trace)\b/],
  ["code", "ko.code", /코드|구현|리팩터|리팩토링|버그|고쳐|수정해|함수|스크립트|컴파일|빌드|테스트\s?코드|저장소/],
  ["verification", "en.verify", /\b(?:verify|verification|double-check|cross-check|fact-check|validate|validation|review|audit|sanity\s+check)\b/],
  ["verification", "ko.verify", /검증|검토|교차\s?확인|다시\s?확인|확인해\s?(?:줘|주)|팩트\s?체크|사실\s?확인|리뷰/],
];

// Token-heavy work goes to the optional researchModel (its own budget) and is read by the root agent afterwards.
var HEAVY_CHARS = 2500;
var HEAVY_RULES = [
  ["heavy", "en.heavy", /\b(?:entire|whole|full)\s+(?:code\s?base|repo|repository|project)|\bdeep[- ](?:dive|research|analysis)|\bcomprehensive\b|\bexhaustive(?:ly)?\b|\blarge[- ]scale\b|\bsurvey\b/],
  ["heavy", "ko.heavy", /(?:코드베이스|저장소|프로젝트)\s?전체|전체\s?(?:코드|저장소|프로젝트|파일)|대규모|대량|모든\s?파일|전수\s?조사|심층|종합\s?분석|장문/],
];

// Lower number is dropped first when a plan exceeds MAX_STEPS.
var ROLE_PRIORITY = { research: 4, verify: 3, browser: 2, work: 1, mention: 5, consume: 4 };

function normalizeText(text) {
  var s = typeof text === "string" ? text : "";
  if (typeof s.normalize === "function") s = s.normalize("NFC");
  return s.toLowerCase();
}

function rootAgent(vendor) {
  return vendor === "codex" ? "codex" : "claude";
}

function otherAgent(vendor) {
  return rootAgent(vendor) === "claude" ? "codex" : "claude";
}

function detectSignals(text) {
  var t = normalizeText(text);
  var signals = { evidence: false, browser: false, code: false, verification: false, heavy: false };
  var hits = [];
  RULES.concat(HEAVY_RULES).forEach(function (rule) {
    if (rule[2].test(t)) {
      signals[rule[0]] = true;
      hits.push(rule[1]);
    }
  });
  if (t.length >= HEAVY_CHARS) { signals.heavy = true; hits.push("length.heavy"); }
  return { signals: signals, rules: hits };
}

// explicit false counts as unavailable, so callers that know nothing keep the
// old behaviour.
function isUp(available, id) {
  return !available || available[id] !== false;
}

// with no availability info the old "other vendor" rule applies.
function verifierFor(root, available) {
  if (!available) return otherAgent(root);
  var other = otherAgent(root);
  return isUp(available, other) ? other : null;
}

function mentionHits(text, tables) {
  tables = tables || tablesFor(null);
  var s = typeof text === "string" ? text : "";
  if (typeof s.normalize === "function") s = s.normalize("NFC");
  var re = /(^|[\s(\[{,.;:!?"'])@([A-Za-zㄱ-힣][A-Za-z0-9ㄱ-힣_-]*)/g;
  var out = [];
  var m;
  while ((m = re.exec(s))) {
    var name = m[2].toLowerCase();
    var agent = Object.prototype.hasOwnProperty.call(tables.at, name) ? tables.at[name] : null;
    if (agent) out.push({ agent: agent, index: m.index + m[1].length });
  }
  return out;
}

// @name tokens at a word start. Unknown names (mates, people) are ignored.
function detectMentions(text, endpoints) {
  var out = [];
  mentionHits(text, tablesFor(endpoints)).forEach(function (h) { if (out.indexOf(h.agent) === -1) out.push(h.agent); });
  return out;
}

// Natural-language assignment: the agent name is the TARGET of the work.
// Names come from MENTION_ALIASES (the only alias table). Matching is
// case-insensitive; an alias only counts as a whole word (not inside
// "mychatgpt", not as an email local part, not after a letter/digit/-/_/@
// except a plain "@" mention, which detectMentions already owns).
//
// Korean: <name><particle><0-3 words><request verb>, same clause (no . , ; : ! ?)
//   particle      로 | 으로 | 한테 | 에게 | 께 | 가 | 이, directly after the name
//   request verb  a word ending in 줘 줄래 주세요 주라 봐 보세요 해라 하세요
//                 하자 시켜 맡겨 맡기자 돌려 (+ optional 요), e.g. 해줘 해봐 맡겨
//   words between must not end in 은 는 한 된 던 든 온 쓴 운 른 (modifier/topic:
//   만든, 말한, 나온) or start with 대로/처럼/같이, and must not contain another alias.
//   Plain statements (읽어, 했어, 하지 마) and 은/는 topics do not trigger.
// English (whole-word, base forms only; "asked" never triggers):
//   use|using|via <name> to <word>      ask|tell|get <name> to <word>
//   have|let <name> <action verb>       delegate|assign|hand off|hand over [this|it|...] to <name>
//   not after don't / do not / never / not / without / no / stop / avoid.
var NL_BEFORE = "(^|[^A-Za-z0-9_\\-ㄱ-힣])";
var KO_REQUEST_END = /(?:줘|줄래|주세요|주라|봐|보세요|해라|하세요|하자|시켜|맡겨|맡기자|돌려)요?$/;
var EN_ACTIONS = "research|review|verify|check|plan|investigate|implement|write|fix|build|summari[sz]e|analy[sz]e|audit|validate|search|find|draft|test|refactor|debug|explain|handle|compare|design|create|generate|browse|navigate|scrape|answer|look|cross-check|double-check|fact-check|take|do|run";

function escapeRe(n) { return n.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&"); }

// Name tables for one call: the built-in aliases plus the extra endpoints given as data. `nl` = names natural-language
// assignment may use (built-ins and endpoint aliases, never an endpoint id), `at` = names after "@" (also ids and the
// at-only aliases). Values are agent keys: a built-in id, or "local:<endpointId>".
var tableCache = { key: null, value: null };
function tablesFor(endpoints) {
  var list = Array.isArray(endpoints) ? endpoints.filter(function (e) {
    return e && typeof e.id === "string" && /^[a-z0-9][a-z0-9-]{0,19}$/.test(e.id) && typeof e.model === "string" && e.model !== "";
  }) : [];
  var key = JSON.stringify(list.map(function (e) { return [e.id, e.model, (e.aliases || []).slice().sort()]; }));
  if (tableCache.key === key) return tableCache.value;
  var nl = Object.assign({}, MENTION_ALIASES), at = Object.assign({}, MENTION_ALIASES, AT_ONLY_ALIASES), byKey = {};
  list.forEach(function (e) {
    var k = "local:" + e.id;
    byKey[k] = { id: e.id, model: e.id + "/" + e.model };
    (Array.isArray(e.aliases) ? e.aliases : []).forEach(function (a) {
      if (typeof a !== "string" || !a) return;
      var n = a.normalize("NFC").toLowerCase();
      if (Object.prototype.hasOwnProperty.call(nl, n)) return; // a built-in name always wins
      nl[n] = k; at[n] = k;
    });
  });
  list.forEach(function (e) { if (!Object.prototype.hasOwnProperty.call(at, e.id)) at[e.id] = "local:" + e.id; });
  var alternation = Object.keys(nl).sort(function (a, b) { return b.length - a.length; }).map(escapeRe).join("|");
  var enName = "(" + alternation + ")(?![A-Za-z0-9_\\-])";
  var value = {
    nl: nl, at: at, byKey: byKey,
    nameOnly: new RegExp("(?:^|[^A-Za-z0-9_\\-ㄱ-힣])(?:" + alternation + ")(?![A-Za-z0-9_\\-ㄱ-힣])", "i"),
    ko: alternation ? new RegExp(NL_BEFORE + "(" + alternation + ")(으로|로|한테|에게|께|가|이)(?=\\s)", "gi") : null,
    en: alternation ? [
      new RegExp("\\b(?:use|using|via)\\s+" + enName + "\\s+to\\s+[a-z]", "gi"),
      new RegExp("\\b(?:ask|tell|get)\\s+" + enName + "\\s+to\\s+[a-z]", "gi"),
      new RegExp("\\b(?:have|let)\\s+" + enName + "\\s+(?:" + EN_ACTIONS + ")\\b", "gi"),
      new RegExp("\\b(?:delegate|assign|hand\\s+(?:off|over))\\s+(?:(?:this|it|that|the\\s+(?:task|work|job)|everything)\\s+)?to\\s+" + enName, "gi"),
    ] : [],
  };
  tableCache = { key: key, value: value };
  return value;
}
var EN_NEGATION_RE = /\b(?:don'?t|do\s+not|never|not|without|no|stop|avoid)\s+(?:\w+\s+){0,2}$/i;

// Modifier/topic endings (만든, 말한, 나온, 은, 는) and 대로/처럼/같이 mean the
// name is not the target of the request.
function koWordOk(word) {
  return !/(?:은|는|한|된|던|든|온|쓴|운|른)$/.test(word) && !/^(?:대로|처럼|같이)/.test(word);
}

function assignmentHits(text, tables) {
  tables = tables || tablesFor(null);
  var s = typeof text === "string" ? text : "";
  if (typeof s.normalize === "function") s = s.normalize("NFC");
  var hits = [];
  var m;
  var KO_ASSIGN_RE = tables.ko;
  if (KO_ASSIGN_RE) KO_ASSIGN_RE.lastIndex = 0;
  while (KO_ASSIGN_RE && (m = KO_ASSIGN_RE.exec(s))) {
    var clause = s.slice(m.index + m[0].length).split(/[.,;:!?。\n]/)[0];
    var words = clause.split(/\s+/).filter(Boolean).slice(0, 4);
    for (var i = 0; i < words.length; i++) {
      if (!KO_REQUEST_END.test(words[i])) continue;
      var between = words.slice(0, i);
      var ok = between.length <= 3 && between.every(function (w) { return koWordOk(w) && !tables.nameOnly.test(" " + w); });
      if (ok) hits.push({ agent: tables.nl[m[2].toLowerCase()], index: m.index + m[1].length });
      break;
    }
  }
  tables.en.forEach(function (re) {
    re.lastIndex = 0;
    while ((m = re.exec(s))) {
      if (EN_NEGATION_RE.test(s.slice(Math.max(0, m.index - 30), m.index))) continue;
      hits.push({ agent: tables.nl[m[1].toLowerCase()], index: m.index });
    }
  });
  return hits;
}

function detectAssignments(text, endpoints) {
  var out = [];
  assignmentHits(text, tablesFor(endpoints)).sort(function (a, b) { return a.index - b.index; })
    .forEach(function (h) { if (out.indexOf(h.agent) === -1) out.push(h.agent); });
  return out;
}

// Agents addressed by @mention or natural-language assignment, in order of
// appearance (a mention wins a tie), de-duplicated. `assigned` lists the
// agents that only natural language named.
function explicitAgents(text, tables) {
  var at = mentionHits(text, tables).map(function (h, i) { return { agent: h.agent, index: h.index, order: i, nl: false }; });
  var nl = assignmentHits(text, tables).map(function (h, i) { return { agent: h.agent, index: h.index, order: at.length + i, nl: true }; });
  var all = at.concat(nl).sort(function (a, b) { return a.index - b.index || a.order - b.order; });
  var agents = [];
  var assigned = [];
  all.forEach(function (h) {
    if (agents.indexOf(h.agent) !== -1) return;
    agents.push(h.agent);
    if (h.nl) assigned.push(h.agent);
  });
  return { agents: agents, assigned: assigned };
}

// "<endpointId>/<model>" or null.
function researchModelOf(v) {
  return typeof v === "string" && /^[a-z0-9][a-z0-9-]{0,19}\/./.test(v) ? v : null;
}

function step(agent, role, reason, model) {
  var s = { agent: agent, role: role, reason: reason };
  if (model) s.model = model;
  return s;
}

// Drop the lowest-priority steps (latest first on ties) until the plan fits.
function capSteps(steps) {
  var dropped = [];
  var list = steps.slice();
  while (list.length > MAX_STEPS) {
    var victim = 0;
    for (var i = 1; i < list.length; i++) {
      if (ROLE_PRIORITY[list[i].role] <= ROLE_PRIORITY[list[victim].role]) victim = i;
    }
    dropped.push(list[victim]);
    list.splice(victim, 1);
  }
  return { steps: list, dropped: dropped };
}

/**
 * route({ text, rootVendor, available, pick, endpoints, researchModel }) -> plan
 *
 * `endpoints` = [{ id, aliases, model }]: the extra endpoints a person may address by hand, as data (this module does no I/O).
 * `@id`, `@alias`, natural-language assignment to an alias and pick "local:<id>" give { agent: "local", model: "<id>/<model>" }.
 *
 * `researchModel` = "<endpointId>/<model>" of a listed endpoint: the evidence/heavy signals then plan [local(researchModel):research, root:consume].
 *
 * `pick` is the composer picker's choice (an id from PICKABLE, or "local:<endpointId>"). It acts exactly like an explicit @mention of that
 * agent at the start of the text (step role "mention", reason "pick.<agent>"), but only when the text carries no
 * mention or assignment of its own: what the user typed wins.
 *
 * plan = {
 *   version: "aigora-router-v1",
 *   mode: "direct" | "orchestrate",
 *   rootAgent, signals, mentions, rules,
 *   steps: [{ index, agent, role, reason, model? }],   // [] when direct
 *   dropped: [{ agent, role, reason }],        // removed by the step cap
 * }
 *
 * "direct" means the message should go to the root session's own agent
 * exactly as it would without orchestration.
 */
function route(input) {
  input = input || {};
  var root = rootAgent(input.rootVendor);
  var detected = detectSignals(input.text);
  var sig = detected.signals;
  var tables = tablesFor(input.endpoints);
  var explicit = explicitAgents(require("../member-mentions").withoutMemberMentions(input.text, input.memberMentions), tables);
  var mentions = explicit.agents;
  var picked = !mentions.length && (PICKABLE.indexOf(input.pick) !== -1 || (typeof input.pick === "string" && Object.prototype.hasOwnProperty.call(tables.byKey, input.pick))) ? input.pick : null;
  if (picked) mentions = [picked];
  var steps = [];
  var unavailable = [];
  var available = input.available;

  if (mentions.length) {
    mentions.forEach(function (agent) {
      var ep = tables.byKey[agent] || null, name = ep ? "local" : agent;
      steps.push(step(name, "mention", (picked ? "pick." : explicit.assigned.indexOf(agent) === -1 ? "mention." : "assign.") + name, ep && ep.model));
    });
  } else {
    var research = sig.evidence || sig.heavy;
    // Research runs only on the admin's researchModel; without one the root agent handles the request itself.
    var researchOn = research && researchModelOf(input.researchModel);
    if (researchOn) steps.push(step("local", "research", sig.evidence ? "signal.evidence" : "signal.heavy", researchOn));
    if (sig.code) steps.push(step(root, "work", "signal.code"));
    else if (researchOn) steps.push(step(root, "consume", "research.consumer"));
    if (sig.verification) {
      var verifier = verifierFor(root, available);
      if (verifier) {
        // Verification checks work, it never replaces it: with no other step before it, the room's own agent does
        // the work first ("검증용 보고서 작성해줘" asks for a report, not for a check of nothing).
        if (!steps.length) steps.push(step(root, "work", "work.default"));
        steps.push(step(verifier, "verify", "signal.verification"));
      }
      else unavailable.push(step(otherAgent(root), "verify", "unavailable"));
    }
  }

  var capped = capSteps(steps);
  steps = capped.steps;
  // Only the root agent doing ordinary work is not worth orchestrating.
  var direct = steps.length === 0 || (steps.length === 1 && steps[0].agent === root && steps[0].role !== "verify");
  return {
    version: VERSION,
    mode: direct ? "direct" : "orchestrate",
    rootAgent: root,
    signals: sig,
    mentions: mentions,
    rules: explicit.assigned.length ? detected.rules.concat("nl.assign") : detected.rules,
    steps: direct ? [] : steps.map(function (s, i) { return Object.assign({ index: i, agent: s.agent, role: s.role, reason: s.reason }, s.model ? { model: s.model } : {}); }),
    dropped: capped.dropped.concat(unavailable),
  };
}

// The one agent a plan hands to a real room turn: a single step, a session agent (Claude or Codex) the user chose
// explicitly (picker, @mention or "코덱스로 해줘") or the engine's decided executor (reason "decision.<agent>", the same
// turn the picker would have started). Automatic signal steps and multi-step plans never qualify.
function pickedSessionAgent(plan) {
  var s = plan && plan.steps && plan.steps.length === 1 ? plan.steps[0] : null;
  if (!s || s.role !== "mention" || !/^(?:pick|mention|assign|decision)\./.test(s.reason || "")) return null;
  return s.agent === "claude" || s.agent === "codex" ? s.agent : null;
}

// The one NON-session worker a plan hands to a write-capable room run: the same single explicit or decided mention step
// write is the engine's decision; this only says which worker was chosen.
function pickedWorker(plan) {
  var s = plan && plan.steps && plan.steps.length === 1 ? plan.steps[0] : null;
  if (!s || s.role !== "mention" || !/^(?:pick|mention|assign|decision)\./.test(s.reason || "")) return null;
  if (s.agent === "local" && typeof s.model === "string" && /^[a-z0-9][a-z0-9-]{0,19}\/./.test(s.model)) return { agent: "local", model: s.model };
  return null;
}

// A plan where a session agent (Claude or Codex) does the work and one other agent then verifies it, exactly
// [<agent>:work, <other>:verify]. The caller runs the work as that agent's real room turn and the engine verifies the
// turn's result afterwards. -> { work: agent, verify: agent } or null (every other plan keeps hidden workers).
function workThenVerify(plan) {
  var st = plan && plan.steps;
  if (!st || st.length !== 2 || st[0].role !== "work" || st[1].role !== "verify") return null;
  if (st[0].agent !== "claude" && st[0].agent !== "codex") return null;
  if (st[1].agent === st[0].agent) return null;
  return { work: st[0].agent, verify: st[1].agent };
}

module.exports = {
  pickedSessionAgent: pickedSessionAgent,
  pickedWorker: pickedWorker,
  workThenVerify: workThenVerify,
  VERSION: VERSION,
  MAX_STEPS: MAX_STEPS,
  PICKABLE: PICKABLE,
  AGENTS: AGENTS,
  route: route,
  detectSignals: detectSignals,
  detectMentions: detectMentions,
  detectAssignments: detectAssignments,
};

return module.exports;
});

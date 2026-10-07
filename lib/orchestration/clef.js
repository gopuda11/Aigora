module.exports = require("../extensions").select("orchestration/clef", function () {
var module = { exports: {} };
// clef.js - semantic task routing through a decision model (Cloudflare Clef / Clef-flash on Workers AI, or any
// compatible endpoint). Typed questions in, probabilities out. Design: docs/superpowers/specs/2026-10-01-aigora-jev-routing-design.md
// (section "2026-10-04 decision").
//
// Boundaries: router.route() stays synchronous and deterministic; this module only runs at the engine boundary before a
// run starts, for an eligible unresolved request, and ANY failure (off, timeout, 4xx/5xx, malformed answer) returns
// null so the caller keeps the deterministic plan. The model decides no permission and never raises a model/effort
// ceiling; it can only add a research or verification step the user could have asked for by hand.
//
// Credentials: AIGORA_CLEF_API_TOKEN / AIGORA_CLEF_ACCOUNT_ID (env wins) or the admin-settings file clef.json (0600) in
// the config dir. The token is write-only (never returned by the admin API) and never logged.
"use strict";

var fs = require("fs");
var { quarantineCorrupt } = require("../quarantine-corrupt");
var path = require("path");
var crypto = require("crypto");

var MAX_STATE_BYTES = 8 * 1024;
// Default decision deadline: on timeout the run starts with the deterministic plan (AIGORA_CLEF_TIMEOUT_MS overrides).
var TIMEOUT_MS = 4000;
var MODEL_ID_RE = /^[A-Za-z0-9._:@\/-]{1,80}$/;
var PROB_SUM_TOLERANCE = 0.05;
var DEFAULT_MODEL = "clef-flash";
var CF_BASE = "https://api.cloudflare.com/client/v4";
var KINDS = ["research", "frontend", "backend", "cross_file", "verification", "other"];
// Application policy (needs labelled calibration, see spec): a high probability is not permission or proof.
var RESEARCH_MIN = 0.8;
// Automatic model selection: a pick below this probability is not taken (admin-tunable inside the bounds).
var ABSTAIN_MIN_DEFAULT = 0.4, ABSTAIN_MIN_LOW = 0.3, ABSTAIN_MIN_HIGH = 0.95;
var OUTCOME_TIMEOUT_MS = 2000;
var MAX_RESPONSE_BYTES = 64 * 1024;
var OUTCOME_EVENTS = ["chosen", "started", "succeeded", "failed", "retried", "override", "feedback", "cost"];
var CHOSEN_REASONS = ["decided", "abstain_default", "recheck_next", "recheck_default", "explicit", "override"];
var OPTION_ID_RE = /^[A-Za-z0-9._:@\/-]{1,90}$/;
var VERIFY_MIN = 0.7;

var QUESTIONS = {
  task_kind: {
    type: "choice",
    instructions: "What kind of work does this request ask for?",
    criteria: {
      research: "Finding or summarising external or current information, sources, papers or news",
      frontend: "User interface, styling or browser-side code",
      backend: "Server, API, database or script logic",
      cross_file: "Investigation or change spanning several files or modules",
      verification: "Independently checking, reviewing or validating existing work",
      other: "Anything else, including chat or unclear requests",
    },
  },
  needs_current_sources: {
    type: "noul",
    instructions: "Does answering this request require current or external sources that the assistant cannot know offline?",
  },
  complexity: {
    type: "score",
    instructions: "How complex is the work?",
    criteria: ["Bounded, routine work", "Multi-step local work", "Cross-file investigation"],
  },
};

// Asked only with automatic model selection on (the three above stay the whole set otherwise). `executor` is built per call
// from the options that are allowed right now (executorOptions); `risk` and `needs_edit` are recorded for later calibration.
var EXTRA_QUESTIONS = {
  risk: {
    type: "score",
    instructions: "How risky is carrying out this request?",
    criteria: ["No risk: chat or read-only", "Config or copy change", "Touches data, permissions or user files", "Security boundary, deletion or live production data"],
  },
  needs_edit: {
    type: "noul",
    instructions: "Does this request require editing files or changing state, rather than only answering?",
  },
};

// Agents the decision may pick (the research model is deliberately absent: it only runs the research step, see planFrom).
var EXECUTOR_QUESTION = { type: "choice", instructions: "Which assistant should handle this request? Prefer the default (claude) unless another option's strength is clearly needed." };
var EXECUTOR_AGENTS = {
  claude: { criteria: "Default. Chat, explanations, planning, writing in Korean or English, document and file work, and multi-step coding or tool tasks in the room workspace that need judgment.", cost_tier: 2, caps: ["code", "write", "reasoning"], read_only: false },
  codex: { criteria: "Code-focused work: bounded fixes, debugging, and review of a diff or module. Quota is scarce. Not for ordinary chat, documents or open-ended multi-step tasks.", cost_tier: 2, caps: ["code", "write"], read_only: false },

  // Only extra-endpoint models an admin marked routable are ever offered (as "local:<endpoint>/<model>"); the primary local provider never is.
  local: { criteria: "Only when the user names it or asks for a second opinion. Text only, no tools or files, slow. For independent checking, an alternate answer or a web-research view.", cost_tier: 0, caps: ["chat"], read_only: true },
};
// Described differently when the worker may create and edit files in the room workspace (a write run, spec 2026-10-04 2.3).
var WRITE_CAPABLE = {

  local: { criteria: "Only when the user names it. Can create and edit files in the workspace, no shell. Slow. For an alternate approach on a bounded text or code edit.", cost_tier: 0, caps: ["write", "chat"], read_only: false },
};
var MAX_EXTRA_OPTIONS = 8;
var DECISION_BACKENDS = ["clef", "jev", "ensemble", "endpoint"];

// Options for the `executor` question from what is up right now. `available` is the router's availability map (claude
// extra-endpoint models ("<endpoint>/<model>") whose endpoint the admin marked routable. The primary local provider's models are
// the workers that can take a write run in this room; they get the write-capable description and read_only:false.
// -> { ids, criteria, meta, map }, ids empty when nothing is offered.
// One model per extra endpoint (vote-splitting guard: every model of an endpoint would otherwise split one endpoint's probability).
// `picks` = { "<endpointId>": configured pickModel }. A configured pick that is not listed drops the endpoint (never swapped for another
// model); without one the first listed model stands in. -> the chosen "<endpoint>/<model>" values, in endpoint order.
function onePerEndpoint(models, picks) {
  var listed = new Map(), order = [];
  (Array.isArray(models) ? models : []).forEach(function (m) {
    if (typeof m !== "string") return;
    var i = m.indexOf("/");
    if (i < 1) return;
    var ep = m.slice(0, i);
    if (!listed.has(ep)) { listed.set(ep, []); order.push(ep); }
    listed.get(ep).push(m);
  });
  var out = [];
  order.forEach(function (ep) {
    var pick = picks && Object.prototype.hasOwnProperty.call(picks, ep) ? picks[ep] : "";
    var want = typeof pick === "string" && pick ? ep + "/" + pick : "";
    if (want) { if (listed.get(ep).indexOf(want) !== -1) out.push(want); } else out.push(listed.get(ep)[0]);
  });
  return out;
}

function executorOptions(available, extraModels, caps) {
  var ids = [], criteria = {}, meta = {}, map = {};
  var workModels = caps && Array.isArray(caps.workModels) ? caps.workModels : [];
  function add(id, agent, model, text) {
    var e = EXECUTOR_AGENTS[agent];
    var w = (agent === "local" && model && workModels.indexOf(model) !== -1) ? WRITE_CAPABLE[agent] : null;
    if (w) e = w;
    ids.push(id); criteria[id] = text || e.criteria;
    meta[id] = { cost_tier: e.cost_tier, caps: e.caps.slice(), read_only: e.read_only };
    map[id] = { agent: agent, model: model || null };
  }
  var av = available || {};
  if (av.claude !== false) add("claude", "claude");
  if (av.codex !== false) add("codex", "codex");
  if (av.local === true) {
    onePerEndpoint((Array.isArray(extraModels) ? extraModels : []).filter(function (m) { return typeof m === "string" && MODEL_ID_RE.test(m); }), null)
      .slice(0, MAX_EXTRA_OPTIONS).forEach(function (m) { add("local:" + m, "local", m); });
  }
  return { ids: ids, criteria: criteria, meta: meta, map: map };
}

// Only the fixed fields of an outcome are ever sent: option ids, a reason from the list, a feedback value.
function cleanOutcome(event, data) {
  if (OUTCOME_EVENTS.indexOf(event) === -1) return null;
  data = data && typeof data === "object" ? data : {};
  if (event === "chosen") {
    if (typeof data.option !== "string" || !OPTION_ID_RE.test(data.option) || CHOSEN_REASONS.indexOf(data.reason) === -1) return null;
    return { option: data.option, reason: data.reason };
  }
  if (event === "feedback") return data.value === 1 || data.value === -1 ? { value: data.value } : null;
  if (event === "failed" || event === "retried") return typeof data.option === "string" && OPTION_ID_RE.test(data.option) ? { option: data.option } : {};
  return {};
}

function byteLen(s) { return Buffer.byteLength(String(s || ""), "utf8"); }
function prob(x) { return typeof x === "number" && isFinite(x) && x >= 0 && x <= 1; }

// Validate a decision-model answer set (same shape for Clef and JEV). Returns a compact object or null.
function parseAnswers(body, opts) {
  var root = body && typeof body === "object" ? (body.result && typeof body.result === "object" ? body.result : body) : null;
  var a = root && root.answers;
  if (!a || typeof a !== "object") return null;
  var k = a.task_kind, n = a.needs_current_sources, c = a.complexity;
  if (!k || k.type !== "choice" || KINDS.indexOf(k.choice) === -1 || !k.probabilities || typeof k.probabilities !== "object") return null;
  var probs = {}, sum = 0;
  for (var i = 0; i < KINDS.length; i++) {
    var v = k.probabilities[KINDS[i]];
    if (!prob(v)) return null;
    probs[KINDS[i]] = v;
    sum += v;
  }
  // A distribution, not just numbers: all-zero or non-normalized output is malformed.
  if (Math.abs(sum - 1) > PROB_SUM_TOLERANCE) return null;
  if (probs[k.choice] < Math.max.apply(null, KINDS.map(function (x) { return probs[x]; })) - 1e-9) return null;
  if (!prob(k.confidence)) return null;
  if (!n || n.type !== "noul" || !prob(n.noul)) return null;
  if (!c || c.type !== "score" || typeof c.score !== "number" || !isFinite(c.score) || c.score < 0 || c.score > 2) return null;
  // Optional extras (automatic selection). Absent is fine; present but invalid rejects the whole answer.
  var executor = null, risk = null, needsEdit = null;
  var ex = a.executor;
  if (ex !== undefined && opts && opts.executor && opts.executor.ids.length) {
    var ids = opts.executor.ids, eprobs = {}, esum = 0;
    if (!ex || ex.type !== "choice" || ids.indexOf(ex.choice) === -1 || !ex.probabilities || typeof ex.probabilities !== "object") return null;
    // An option that was not offered, or a distribution that is not one, is a failure, never a route.
    if (Object.keys(ex.probabilities).length !== ids.length) return null;
    for (var j = 0; j < ids.length; j++) {
      var ev = ex.probabilities[ids[j]];
      if (!prob(ev)) return null;
      eprobs[ids[j]] = ev; esum += ev;
    }
    if (Math.abs(esum - 1) > PROB_SUM_TOLERANCE) return null;
    if (eprobs[ex.choice] < Math.max.apply(null, ids.map(function (x) { return eprobs[x]; })) - 1e-9) return null;
    if (!prob(ex.confidence)) return null;
    executor = { choice: ex.choice, confidence: ex.confidence, probabilities: eprobs };
  }
  if (a.risk !== undefined) {
    if (!a.risk || a.risk.type !== "score" || typeof a.risk.score !== "number" || !isFinite(a.risk.score) || a.risk.score < 0 || a.risk.score > 3) return null;
    risk = a.risk.score;
  }
  if (a.needs_edit !== undefined) {
    if (!a.needs_edit || a.needs_edit.type !== "noul" || !prob(a.needs_edit.noul)) return null;
    needsEdit = a.needs_edit.noul;
  }
  // Usage is untrusted: only finite non-negative numbers are kept, anything else rejects the answer, so no free text
  // from the provider can reach the log through it.
  var usage = null;
  if (root.usage !== undefined && root.usage !== null) {
    if (typeof root.usage !== "object" || Array.isArray(root.usage)) return null;
    usage = {};
    var names = ["input_tokens", "output_tokens"];
    for (var u = 0; u < names.length; u++) {
      var x = root.usage[names[u]];
      if (x === undefined) { usage[names[u]] = 0; continue; }
      if (typeof x !== "number" || !isFinite(x) || x < 0) return null;
      usage[names[u]] = x;
    }
  }
  return {
    model: typeof root.model === "string" && MODEL_ID_RE.test(root.model) ? root.model : null,
    task_kind: { choice: k.choice, confidence: k.confidence, probabilities: probs },
    needs_current_sources: n.noul,
    complexity: c.score,
    executor: executor, risk: risk, needs_edit: needsEdit,
    usage: usage,
  };
}

// The endpoint's x_* fields (absent on a real Clef). Everything is shape-checked: nothing free-form is kept.
function parseMeta(body) {
  var b = body && typeof body === "object" ? body : {};
  return {
    id: typeof b.x_decision_id === "string" && /^d_[0-9a-f]{16}$/.test(b.x_decision_id) ? b.x_decision_id : null,
    by: typeof b.x_decided_by === "string" && /^[a-z]{2,12}$/.test(b.x_decided_by) ? b.x_decided_by : null,
    abstain: b.x_abstain === true,
  };
}
// A decision endpoint that decided nothing answers 200 with empty answers: that is an abstention, not a malformed body.
function isNoDecision(body, meta) {
  var root = body && typeof body === "object" ? (body.result && typeof body.result === "object" ? body.result : body) : null;
  var a = root && root.answers;
  return !!a && typeof a === "object" && !Array.isArray(a) && Object.keys(a).length === 0 && (meta.by === "none" || meta.abstain);
}

// Reads a response body as a stream with a hard byte cap; rejects (and cancels the body) when the cap is exceeded or the
// stream fails, so a hostile endpoint cannot make us buffer or parse an unbounded body.
function readCapped(res, max) {
  if (!res.body || !res.body.getReader) return Promise.reject(new Error("no_body"));
  var reader = res.body.getReader();
  var chunks = [], total = 0;
  function step() {
    return reader.read().then(function (r) {
      if (r.done) return Buffer.concat(chunks).toString("utf8");
      total += r.value.length;
      if (total > max) { reader.cancel().catch(function () {}); throw new Error("too_large"); }
      chunks.push(Buffer.from(r.value));
      return step();
    });
  }
  return step();
}

// One POST to a decision-model endpoint. Resolves { ok, answers?, reason?, latencyMs }; never rejects.
function ask(opts) {
  var t0 = Date.now();
  var ctl = new AbortController();
  var timedOut = false;
  var timer = setTimeout(function () { timedOut = true; ctl.abort(); }, opts.timeoutMs || TIMEOUT_MS);
  // An external signal (Stop) aborts the request itself, not just the wait for it.
  if (opts.signal) {
    if (opts.signal.aborted) { clearTimeout(timer); return Promise.resolve({ ok: false, reason: "cancelled", latencyMs: 0 }); }
    opts.signal.addEventListener("abort", function () { ctl.abort(); }, { once: true });
  }
  var headers = { "Content-Type": "application/json" };
  if (opts.token) headers.Authorization = "Bearer " + opts.token;
  var payload = { model: opts.model, state: opts.state, questions: opts.questions || QUESTIONS };
  if (opts.extensions) Object.keys(opts.extensions).forEach(function (k) { payload[k] = opts.extensions[k]; });
  return fetch(opts.url, { method: "POST", headers: headers, body: JSON.stringify(payload), signal: ctl.signal, redirect: "error" })
    .then(function (res) {
      if (!res.ok) return { ok: false, reason: "http_" + res.status };
      return readCapped(res, MAX_RESPONSE_BYTES).then(function (text) { return JSON.parse(text); }).then(function (body) {
        var meta = parseMeta(body);
        var answers = parseAnswers(body, { executor: opts.executor });
        if (answers) return { ok: true, answers: answers, meta: meta };
        return isNoDecision(body, meta) ? { ok: true, answers: null, meta: meta } : { ok: false, reason: "malformed" };
      }, function () { ctl.abort(); return { ok: false, reason: "malformed" }; });
    }, function (e) { return { ok: false, reason: e && e.name === "AbortError" ? (timedOut ? "timeout" : "cancelled") : "network" }; })
    .then(function (r) { clearTimeout(timer); r.latencyMs = Date.now() - t0; return r; });
}

// --- Admin settings + env ---------------------------------------------------------------------------------------

// Settings-file reads are cached (active() runs on every message). Any save/clear in this process bumps the generation
// (the admin API uses its own instance), and a short TTL picks up out-of-process edits, so an unconfigured deployment
// does no file I/O per message.
var FILE_CACHE_TTL_MS = 5000;
var fileGeneration = 0;

function createClef(options) {
  options = options || {};
  var env = options.env || process.env;
  var dirFn = options.dir ? function () { return options.dir; } : function () { return require("../config").CONFIG_DIR; };
  var envTimeout = parseInt(env.AIGORA_CLEF_TIMEOUT_MS, 10);
  var timeoutMs = options.timeoutMs || (envTimeout > 0 ? envTimeout : TIMEOUT_MS);
  // Under the config dir's "routing" subdirectory (0700). Contained agents never see the config dir (private-agent-scope
  // masks it), and agent subprocess env is stripped of AIGORA_CLEF_*/AIGORA_JEV_* (lib/agent-env.js).
  function file() { return path.join(dirFn(), "routing", "clef.json"); }
  var cache = null;
  function readFile() {
    var now = Date.now(), f = file();
    if (cache && cache.gen === fileGeneration && cache.file === f && now - cache.at < FILE_CACHE_TTL_MS) return cache.value;
    var v;
    try { var o = JSON.parse(fs.readFileSync(f, "utf8")); v = o && typeof o === "object" ? o : {}; } catch (e) { v = {}; quarantineCorrupt(f, e); }
    cache = { gen: fileGeneration, file: f, at: now, value: v };
    return v;
  }
  function writeFile(o) {
    fileGeneration++;
    var f = file();
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    // Never write secrets into a file that may already be broadly readable: new 0600 temp, then atomic rename.
    var tmp = f + "." + process.pid + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
    var fd = null;
    try {
      fd = fs.openSync(tmp, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify(o)); // loops until every byte is written
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = null;
      fs.renameSync(tmp, f);
      fileGeneration++;
    } catch (e) {
      if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
      try { fs.unlinkSync(tmp); } catch (_) {} // any failure leaves no secret-bearing temp file behind
      throw e;
    }
  }
  function resolve() {
    var f = readFile();
    var token = env.AIGORA_CLEF_API_TOKEN || f.token || "";
    var accountId = env.AIGORA_CLEF_ACCOUNT_ID || f.accountId || "";
    var endpointUrl = env.AIGORA_CLEF_BASE_URL || "";
    var backend = env.AIGORA_DECISION_BACKEND || f.backend || (endpointUrl ? "endpoint" : "clef");
    var baseUrl = backend === "endpoint" ? endpointUrl : "";
    var jevKey = env.AIGORA_JEV_API_KEY || f.jevKey || "";
    var model = env.AIGORA_CLEF_MODEL || DEFAULT_MODEL;
    var cloudConfigured = !!(token && accountId);
    var configured = backend === "endpoint" ? !!baseUrl : backend === "clef" ? cloudConfigured : backend === "jev" ? !!jevKey : backend === "ensemble" ? !!(cloudConfigured && jevKey) : false;
    var enabled = f.enabled !== false && env.AIGORA_CLEF_ENABLED !== "0";
    var abstainMin = typeof f.abstainMin === "number" && f.abstainMin >= ABSTAIN_MIN_LOW && f.abstainMin <= ABSTAIN_MIN_HIGH ? f.abstainMin : ABSTAIN_MIN_DEFAULT;
    return { token: token, accountId: accountId, baseUrl: baseUrl, backend: backend, jevKey: jevKey, model: model, configured: configured, enabled: enabled, autoSelect: f.autoSelect === true, abstainMin: abstainMin, storeText: f.storeText === true };
  }
  function urlOf(c) {
    if (c.baseUrl) return c.baseUrl.replace(/\/+$/, "") + "/v1/systemone";
    return options.url || CF_BASE + "/accounts/" + encodeURIComponent(c.accountId) + "/ai/run/@cf/cloudflare/" + encodeURIComponent(c.model);
  }
  var jevClient;
  function jevAsk(req) {
    if (!jevClient) jevClient = require("./jev-shadow").createJevShadow({ env: env, dir: path.join(dirFn(), "routing"), url: options.jevUrl, timeoutMs: timeoutMs, key: function () { return resolve().jevKey; } });
    // Endpoint extensions and Cloudflare credentials must never go to JEV.
    return jevClient.ask({ state: req.state, questions: req.questions, executor: req.executor, timeoutMs: req.timeoutMs, signal: req.signal });
  }

  return {
    active: function () { var c = resolve(); return c.configured && c.enabled; },
    // Off unless an admin turned it on. Only meaningful while the decision endpoint itself is active.
    autoSelect: function () { var c = resolve(); return c.configured && c.enabled && c.autoSelect; },
    abstainMin: function () { return resolve().abstainMin; },
    // Request text is stored by the endpoint only when an admin allowed it; otherwise it keeps a hash.
    storeText: function () { return resolve().storeText; },
    // Reporting an explicit choice (x_explicit) needs an endpoint that understands it: a self-hosted one, never Workers AI.
    reportsExplicit: function () { var c = resolve(); return c.configured && c.enabled && c.autoSelect && !!c.baseUrl; },
    // Never exposes the token or account id.
    status: function () { var c = resolve(); return { configured: c.configured, enabled: c.configured && c.enabled, backend: c.backend, model: c.backend === "jev" ? env.AIGORA_JEV_MODEL || require("./jev-shadow").MODEL_DEFAULT : c.model, hasToken: !!c.token, hasAccountId: !!c.accountId, hasJevKey: !!c.jevKey, autoSelect: c.autoSelect, abstainMin: c.abstainMin, storeText: c.storeText }; },
    // Foreground attempts consume the same cap even when they fail: never shadow
    // them again. Disabled/missing active credentials also must not trigger shadow.
    usesJev: function () { return ["jev", "ensemble"].indexOf(resolve().backend) !== -1; },
    // Admin write: undefined fields are kept, "" clears. Env values still win at call time.
    save: function (patch) {
      fileGeneration++; // read-modify-write must see the file, not the cache
      var f = readFile();
      if (patch.backend !== undefined && DECISION_BACKENDS.indexOf(patch.backend) === -1) throw new Error("invalid_backend");
      ["token", "accountId", "jevKey"].forEach(function (k) {
        if (typeof patch[k] === "string") { if (patch[k].trim()) f[k] = patch[k].trim().slice(0, 300); else delete f[k]; }
      });
      if (typeof patch.enabled === "boolean") f.enabled = patch.enabled;
      if (typeof patch.autoSelect === "boolean") f.autoSelect = patch.autoSelect;
      if (typeof patch.storeText === "boolean") f.storeText = patch.storeText;
      if (patch.backend !== undefined) f.backend = patch.backend;
      if (typeof patch.abstainMin === "number" && patch.abstainMin >= ABSTAIN_MIN_LOW && patch.abstainMin <= ABSTAIN_MIN_HIGH) f.abstainMin = patch.abstainMin;
      writeFile(f);
    },
    // Removes the settings file and any leftover temp files from an interrupted write.
    clear: function () {
      fileGeneration++;
      var f = file(), d = path.dirname(f), base = path.basename(f);
      try { fs.unlinkSync(f); } catch (_) {}
      fileGeneration++;
      try {
        fs.readdirSync(d).forEach(function (n) { if (n.indexOf(base + ".") === 0 && /\.tmp$/.test(n)) { try { fs.unlinkSync(path.join(d, n)); } catch (_) {} } });
      } catch (_) {}
    },
    timeoutMs: function () { return timeoutMs; },

    // Fire-and-forget outcome for a decision the endpoint numbered. Resolves true/false, never rejects or throws, 2 s at most,
    // and only for a self-hosted endpoint (a real Clef returns no id, so there is nothing to send). The caller never awaits it.
    postOutcome: function (decisionId, event, data) {
      try {
        var c = resolve();
        if (!c.configured || !c.enabled || !c.baseUrl) return Promise.resolve(false);
        if (typeof decisionId !== "string" || !/^d_[0-9a-f]{16}$/.test(decisionId)) return Promise.resolve(false);
        var clean = cleanOutcome(event, data);
        if (!clean) return Promise.resolve(false);
        var body = JSON.stringify({ decision_id: decisionId, event: event, data: clean });
        if (byteLen(body) > 4096) return Promise.resolve(false);
        var ctl = new AbortController();
        var timer = setTimeout(function () { ctl.abort(); }, OUTCOME_TIMEOUT_MS);
        if (timer.unref) timer.unref();
        var headers = { "Content-Type": "application/json" };
        if (c.token) headers.Authorization = "Bearer " + c.token;
        return fetch(c.baseUrl.replace(/\/+$/, "") + "/v1/outcome", { method: "POST", headers: headers, body: body, signal: ctl.signal, redirect: "error" })
          .then(function (res) {
            // The deadline covers the whole exchange: discard the body and abort before the timer is cleared.
            var ok = res.ok;
            try { if (res.body) res.body.cancel().catch(function () {}); } catch (_) {}
            ctl.abort();
            return ok;
          }, function () { return false; })
          .then(function (ok) { clearTimeout(timer); return ok; }, function () { clearTimeout(timer); return false; });
      } catch (_) { return Promise.resolve(false); }
    },

    // Ask Clef; resolves { ok, answers, latencyMs, model } or { ok:false, reason }.
    ask: function (state, askOpts) {
      var c = resolve();
      if (!c.configured || !c.enabled) return Promise.resolve({ ok: false, reason: "off", latencyMs: 0 });
      if (byteLen(state) > MAX_STATE_BYTES) return Promise.resolve({ ok: false, reason: "too_large", latencyMs: 0 });
      var o = askOpts || {};
      // A private channel's text: only a self-hosted decision endpoint (it understands x_text_policy) may see it, and it is told to keep
      // a hash only, whatever the admin's storeText says. Workers AI direct cannot carry the policy, so nothing is sent there.
      var priv = o.privateText === true;
      if (priv && !c.baseUrl) return Promise.resolve({ ok: false, reason: "private_unsupported", latencyMs: 0 });
      var explicit = typeof o.explicit === "string" && OPTION_ID_RE.test(o.explicit) ? o.explicit : null;
      if (explicit && !c.baseUrl) return Promise.resolve({ ok: false, reason: "explicit", latencyMs: 0 });
      var exec = !explicit && o.executor && o.executor.ids && o.executor.ids.length ? o.executor : null;
      var req = { url: urlOf(c), token: c.token, model: c.model, state: state, timeoutMs: timeoutMs, signal: o.signal };
      if (exec) {
        req.executor = exec;
        req.questions = Object.assign({ executor: Object.assign({}, EXECUTOR_QUESTION, { criteria: exec.criteria }) }, QUESTIONS, EXTRA_QUESTIONS);
      }
      // x_* fields are for a self-hosted decision endpoint; Workers AI gets the plain typed request. The endpoint is asked to
      // answer before our own deadline, and text is stored only as a hash unless an admin allowed storing it.
      if (c.baseUrl && (exec || explicit || priv)) {
        req.extensions = { x_source: "aigora", x_text_policy: !priv && c.storeText ? "store" : "hash", x_deadline_ms: Math.max(500, timeoutMs - 400) };
        if (exec) req.extensions.x_options_meta = exec.meta;
        // The user already chose: the endpoint is told which option (and only records it), no executor question is asked.
        if (explicit) req.extensions.x_explicit = explicit;
      }
      var t0 = Date.now(), pending;
      if (c.backend === "ensemble") {
        pending = Promise.all([ask(req), jevAsk(req)]).then(function (rs) { return require("./decision-ensemble").combine(rs[0], rs[1]); });
      } else if (c.backend === "jev") {
        pending = jevAsk(req).then(function (r) {
          if (r.ok) {
            var policy = require("./decision-ensemble");
            var reason = r.answers && policy.abstention(r.answers, policy.JEV_MIN, true);
            r.meta = Object.assign({}, r.meta, { by: "jev", abstain: !!reason || !!(r.meta && r.meta.abstain), reason: reason || (r.meta && r.meta.abstain ? (r.meta.reason || "abstain_default") : "decided") });
          }
          return r;
        });
      } else pending = ask(req).then(function (r) { r.model = c.model; r.meta = Object.assign({ by: c.backend }, r.meta, { by: r.meta && r.meta.by || c.backend }); return r; });
      return pending.then(function (r) { r.latencyMs = Date.now() - t0; r.jevUsed = c.backend === "jev" || c.backend === "ensemble"; return r; });
    },
  };
}

// Map validated answers to a plan, or null to keep the baseline. `base` is the deterministic plan (direct, unresolved).
// `researchModel` = "<endpointId>/<model>" of a listed research endpoint, or null (then current sources plan no research step).
function planFrom(answers, base, rootAgent, available, researchModel) {
  function up(id) { return !available || available[id] !== false; }
  var steps = null, rule = null;
  if (answers.needs_current_sources >= RESEARCH_MIN && researchModel) {
    steps = [{ agent: "local", role: "research", reason: "clef.sources", model: researchModel }, { agent: rootAgent, role: "consume", reason: "research.consumer" }];
    rule = "clef.sources";
  } else if (answers.task_kind.choice === "verification" && answers.task_kind.confidence >= VERIFY_MIN) {
    var other = rootAgent === "claude" ? "codex" : "claude";
    var who = up(other) ? other : null;
    if (who) { steps = [{ agent: who, role: "verify", reason: "clef.verification" }]; rule = "clef.verification"; }
  }
  if (!steps) return null;
  return Object.assign({}, base, {
    mode: "orchestrate",
    rules: base.rules.concat(rule),
    steps: steps.map(function (s, i) { return Object.assign({ index: i, agent: s.agent, role: s.role, reason: s.reason }, s.model ? { model: s.model } : {}); }),
  });
}

// Turn the executor answer into a choice, or the reason the default plan is kept. `options` comes from executorOptions;
// policy = { abstainMin, allowed(entry) -> bool } where `allowed` is the engine's live model-policy / availability re-check.
// Candidates are taken in probability order while they stay at or above abstainMin; the first that passes wins
// ("decided" for the top one, "recheck_next" for a later one). -> null when there is no executor answer, else
// { agent, model, option, p, reason, top } with agent null for "abstain_default" / "recheck_default".
function pickFrom(answers, options, policy) {
  var ex = answers && answers.executor;
  if (!ex || !options || !options.map) return null;
  var ranked = Object.keys(ex.probabilities).filter(function (id) { return options.map[id]; })
    .map(function (id) { return { option: id, p: ex.probabilities[id] }; })
    .sort(function (a, b) { return b.p - a.p || (a.option < b.option ? -1 : 1); });
  if (!ranked.length) return null;
  var top = ranked.slice(0, 3);
  var min = policy && typeof policy.abstainMin === "number" ? policy.abstainMin : ABSTAIN_MIN_DEFAULT;
  if (ranked[0].p < min) return { agent: null, model: null, option: null, p: ranked[0].p, reason: "abstain_default", top: top };
  for (var i = 0; i < ranked.length && ranked[i].p >= min; i++) {
    var entry = options.map[ranked[i].option];
    var ok = false;
    try { ok = !policy || typeof policy.allowed !== "function" || policy.allowed(entry) === true; } catch (_) { ok = false; }
    if (ok) return { agent: entry.agent, model: entry.model, option: ranked[i].option, p: ranked[i].p, reason: i === 0 ? "decided" : "recheck_next", top: top };
  }
  return { agent: null, model: null, option: null, p: ranked[0].p, reason: "recheck_default", top: top };
}

// The other candidates of the same answer, in probability order, that stay at or above abstainMin; `chosenOption` is left out.
// Not filtered by availability: the caller checks each one again at the moment it is needed. -> [{ option, agent, model }]
function fallbackFrom(answers, options, policy, chosenOption) {
  var ex = answers && answers.executor;
  if (!ex || !options || !options.map) return [];
  var min = policy && typeof policy.abstainMin === "number" ? policy.abstainMin : ABSTAIN_MIN_DEFAULT;
  return Object.keys(ex.probabilities).filter(function (id) { return options.map[id] && id !== chosenOption && ex.probabilities[id] >= min; })
    .sort(function (a, b) { return ex.probabilities[b] - ex.probabilities[a] || (a < b ? -1 : 1); })
    .map(function (id) { return { option: id, agent: options.map[id].agent, model: options.map[id].model }; });
}

module.exports = {
  DECISION_BACKENDS: DECISION_BACKENDS,
  fallbackFrom: fallbackFrom,
  EXECUTOR_IDS: { claude: 1, codex: 1,  local: 1 },
  pickFrom: pickFrom, executorOptions: executorOptions, onePerEndpoint: onePerEndpoint, EXTRA_QUESTIONS: EXTRA_QUESTIONS, ABSTAIN_MIN_DEFAULT: ABSTAIN_MIN_DEFAULT,
  TIMEOUT_MS: TIMEOUT_MS, MAX_STATE_BYTES: MAX_STATE_BYTES, QUESTIONS: QUESTIONS, KINDS: KINDS,
  parseAnswers: parseAnswers, ask: ask, createClef: createClef, planFrom: planFrom, byteLen: byteLen,
  sha256: function (s) { return crypto.createHash("sha256").update(String(s)).digest("hex"); },
};

return module.exports;
});

"use strict";
// YOKE adapter for OpenAI-compatible local servers (Ollama first). Chat-only: no tools are sent, no tool loop runs.
// The daemon calls the server directly, so nothing inside a contained run ever talks to it. History is kept in the
// query handle (the server has no session); the oldest turns are dropped past config.contextTokens.
//
// Events use the same flat yokeType shapes the Codex adapter emits, restricted to what the session processor handles:
// turn_start, text_start/text_delta, thinking_start/thinking_delta, block_stop, result, system (error text), diagnostic.
var crypto = require("crypto");
var cfgMod = require("./config");
var client = require("./client");
var quirksMod = require("./quirks");
var mapper = require("./mapper");
var stateMod = require("./state");

var DEFAULT_SYSTEM = "You are a helpful assistant running as a local model. Answer concisely, in the language the user writes in.";
// Fixed texts per error code. The primary server keeps the "local model / Ollama" wording; an extra endpoint is named by
// its configured label ("<label>가 ..."). `lang` is "ko" (default) or "en".
var PRIMARY = {
  ko: {
    unreachable: "로컬 모델 서버에 연결할 수 없어요. Ollama가 실행 중인지 확인해 주세요.",
    model_missing: "로컬 서버에 이 모델이 없어요. 모델이 설치돼 있는지 확인해 주세요.",
    auth: "로컬 모델 서버가 요청을 거부했어요. API 키 설정을 확인해 주세요.",
    idle: "로컬 모델이 한동안 응답하지 않아 멈췄어요. 모델이 너무 크거나 컴퓨터가 바쁠 수 있어요.",
    timeout: "로컬 모델이 시간 안에 답하지 않았어요. 모델이 너무 크거나 컴퓨터가 바쁠 수 있어요.",
    http: "로컬 모델 서버가 오류를 반환했어요.",
    bad_response: "로컬 모델 서버의 응답을 이해하지 못했어요.",
    empty: "로컬 모델이 빈 답을 반환했어요. 다시 시도하거나 다른 모델을 골라 주세요.",
  },
  en: {
    unreachable: "Could not reach the local model server. Check that Ollama is running.",
    model_missing: "The local server does not have this model. Check that it is installed.",
    auth: "The local model server rejected the request. Check the API key setting.",
    idle: "The local model stopped responding for a while. It may be too large or the computer may be busy.",
    timeout: "The local model did not answer in time. It may be too large or the computer may be busy.",
    http: "The local model server returned an error.",
    bad_response: "Could not understand the local model server's response.",
    empty: "The local model returned an empty answer. Try again or pick another model.",
  },
};
var EXTRA = {
  ko: {
    unreachable: function (l) { return l + "에 연결할 수 없었어요."; },
    model_missing: function (l) { return l + "에 이 모델이 없어요."; },
    auth: function (l) { return l + " 서버가 요청을 거부했어요. API 키 설정을 확인해 주세요."; },
    idle: function (l) { return l + "가 한동안 응답하지 않아 멈췄어요."; },
    timeout: function (l) { return l + "가 시간 안에 답하지 않았어요."; },
    http: function (l) { return l + " 서버가 오류를 돌려줬어요."; },
    bad_response: function (l) { return l + " 서버의 응답을 이해하지 못했어요."; },
    empty: function (l) { return l + "가 빈 답을 돌려줬어요. 다시 시도하거나 다른 AI를 골라 주세요."; },
  },
  en: {
    unreachable: function (l) { return "Could not reach " + l + "."; },
    model_missing: function (l) { return l + " does not have this model."; },
    auth: function (l) { return l + " rejected the request. Check the API key setting."; },
    idle: function (l) { return l + " stopped responding for a while."; },
    timeout: function (l) { return l + " did not answer in time."; },
    http: function (l) { return l + " returned a server error."; },
    bad_response: function (l) { return "Could not understand the response from " + l + "."; },
    empty: function (l) { return l + " returned an empty answer. Try again or pick another AI."; },
  },
};
// e: an error with .code, or a bare code string. label: the extra endpoint's label, or falsy for the primary server.
function messageFor(e, label, lang) {
  var code = typeof e === "string" ? e : e && e.code;
  if (code === "stream_error") code = "http";
  var l = lang === "en" ? "en" : "ko";
  if (label) { var f = EXTRA[l][code] || EXTRA[l].http; return f(label); }
  return PRIMARY[l][code] || PRIMARY[l].http;
}

// ~3 chars per token for mixed Korean/English text; only used for budgeting and when the server reports no usage.
function estimateTokens(s) { return Math.ceil(String(s || "").length / 3); }

// Drop the oldest turns (user+assistant pairs) until system + history fits the budget; the newest user message is kept.
function trimToBudget(system, history, budget) {
  var h = history.slice();
  function total() { return estimateTokens(system) + h.reduce(function (n, m) { return n + estimateTokens(m.content) + 4; }, 0); }
  while (h.length > 1 && total() > budget) h.shift();
  return h;
}

// One generation at a time per endpoint (keyed by baseUrl): a CPU runs one 7-14B model at a time, and non-scheduled
// paths (admin sessions outside rooms) do not pass through the run scheduler. A slow endpoint never blocks
// another one (Ollama, the NPU title model).
var gates = new Map();
function exclusive(key, fn) {
  var gate = gates.get(key) || Promise.resolve();
  var run = gate.then(fn, fn);
  var tail = run.then(function () {}, function () {});
  gates.set(key, tail);
  tail.then(function () { if (gates.get(key) === tail) gates.delete(key); });
  return run;
}
function posMs(v, dflt) { return typeof v === "number" && isFinite(v) && v > 0 ? Math.floor(v) : dflt; }

function uuid() { return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex"); }

function createLocalAdapter(opts) {
  opts = opts || {};
  var getConfig = opts.getConfig || cfgMod.loadLocalConfig;
  var state = opts.state || stateMod.getLocalState();
  var f = opts.fetch;

  async function init() {
    var snap = await state.refresh(true);
    if (!snap.ready) { var err = new Error("local model server not ready: " + (snap.reason || "unknown")); err.code = snap.reason; throw err; }
    return {
      models: snap.models, defaultModel: snap.models[0].value, skills: [], slashCommands: [], fastModeState: null,
      capabilities: { thinking: false, betas: false, rewind: false, sessionResume: false, promptSuggestions: false, elicitation: false,
        fileCheckpointing: false, contextCompacting: false, toolPolicy: ["ask", "allow-all"], tools: snap.tools || "unknown", local: true },
    };
  }

  function createQuery(queryOpts) {
    queryOpts = queryOpts || {};
    var cfg = getConfig();
    var model = queryOpts.model || cfg.models.chat || cfg.models.code;
    var system = queryOpts.systemPrompt || DEFAULT_SYSTEM;
    var history = [];
    var events = [], waiting = null, ended = false, aborted = false, closed = false, inputEnded = false;
    var pending = [], turnActive = false, loopStarted = false, turnCtl = null;

    function push(ev) {
      if (ended) return;
      if (waiting) { var w = waiting; waiting = null; w({ value: ev, done: false }); } else events.push(ev);
    }
    function end() {
      if (ended) return;
      ended = true;
      if (waiting) { var w = waiting; waiting = null; w({ value: undefined, done: true }); }
    }

    async function runTurn(text, targetNow) {
      var started = Date.now();
      var block = null, blockN = 0, answer = "", usage = null, finish = null, failed = null;
      function open(kind) {
        if (block && block.kind === kind) return;
        close();
        block = { kind: kind, id: "blk_" + (++blockN) };
        push({ yokeType: kind === "text" ? "text_start" : "thinking_start", blockId: block.id });
      }
      function close() { if (block) { push({ yokeType: "block_stop", blockId: block.id }); block = null; } }
      function apply(parts) {
        parts.forEach(function (p) {
          if (p.kind === "text") { open("text"); answer += p.text; push({ yokeType: "text_delta", blockId: block.id, text: p.text }); }
          else if (p.kind === "thinking") { open("thinking"); push({ yokeType: "thinking_delta", blockId: block.id, text: p.text }); }
          else if (p.kind === "usage") usage = p;
          else if (p.kind === "finish") finish = p.reason;
        });
      }
      push({ yokeType: "turn_start", uuid: uuid(), messageType: "user" });
      history.push({ role: "user", content: text });
      var sent = trimToBudget(system, history, cfg.contextTokens);
      var messages = [{ role: "system", content: system }].concat(sent);
      // Resolved per turn: an extra endpoint brings its own URL, key and quirks (never the primary server's).
      var target = targetNow;
      var quirks = quirksMod.quirksFor(target.baseUrl, target.server);
      var body = { model: target.model, messages: messages, max_tokens: cfg.maxTokens };
      if (quirks.streamUsage) body.stream_options = { include_usage: true };
      if (!cfg.thinking && quirks.noThinkBody) Object.assign(body, quirks.noThinkBody);
      var ep = target.endpoint, label = ep ? ep.label : null;
      var map = mapper.createChunkMapper(quirks);
      turnCtl = new AbortController();
      try {
        for await (var chunk of client.streamChat({ baseUrl: target.baseUrl, apiKey: target.apiKey, body: body, signal: turnCtl.signal, idleTimeoutMs: posMs(ep && ep.idleTimeoutMs, cfg.idleTimeoutMs), timeoutMs: posMs(ep && ep.timeoutMs, 0), fetch: f })) {
          apply(map.feed(chunk));
        }
        apply(map.flush());
      } catch (e) {
        if (!(e && e.code === "aborted") && !aborted) failed = e;
      }
      close();
      turnCtl = null;
      if (aborted) return;
      if (failed) {
        // Fixed message only: server text never reaches the room. The turn still ends with a result so the UI unlocks.
        push({ yokeType: "system", subtype: "local_error", error: messageFor(failed, label, queryOpts.lang), errorCode: failed.code || null, errorStatus: failed.status || null });
        history.pop();
      } else {
        history.push({ role: "assistant", content: answer });
        if (finish === "length") push({ yokeType: "diagnostic", severity: "warning", source: "cli", message: "로컬 모델이 길이 제한(" + cfg.maxTokens + " 토큰)에서 답을 멈췄어요." });
        if (!answer.trim()) push({ yokeType: "system", subtype: "local_error", error: messageFor("empty", label, queryOpts.lang) });
      }
      var inTok = usage ? usage.input : estimateTokens(messages.map(function (m) { return m.content; }).join("\n"));
      var outTok = usage ? usage.output : estimateTokens(answer);
      var mu = {}; mu[model] = { contextWindow: cfg.contextTokens };
      push({ yokeType: "result", uuid: uuid(), messageType: "assistant", cost: null, duration: Date.now() - started,
        usage: failed ? null : { input_tokens: inTok, output_tokens: outTok, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        modelUsage: mu, sessionId: null, lastStreamInputTokens: null, local: { tokensPerSecond: outTok && Date.now() > started ? Math.round(outTok / ((Date.now() - started) / 1000) * 10) / 10 : null } });
    }

    async function loop() {
      while (!aborted && !closed) {
        if (!pending.length) {
          if (inputEnded) break;
          await new Promise(function (r) { loop.wake = r; });
          continue;
        }
        var next = pending.shift();
        turnActive = true;
        var tgt = cfgMod.targetFor(cfg, model);
        try { await exclusive(tgt.baseUrl, function () { return aborted ? null : runTurn(next, tgt); }); } finally { turnActive = false; }
        if (inputEnded && !pending.length) break;
      }
      end();
    }
    function wake() { if (loop.wake) { var w = loop.wake; loop.wake = null; w(); } }

    var handle = {
      [Symbol.asyncIterator]: function () {
        return { next: function () {
          if (events.length) return Promise.resolve({ value: events.shift(), done: false });
          if (ended) return Promise.resolve({ value: undefined, done: true });
          return new Promise(function (r) { waiting = r; });
        } };
      },
      pushMessage: function (text, images) {
        if (images && images.length) push({ yokeType: "diagnostic", severity: "warning", source: "cli", message: "로컬 모델은 이미지를 볼 수 없어서 이미지는 보내지 않았어요." });
        pending.push(String(text || ""));
        if (!loopStarted) { loopStarted = true; loop(); } else wake();
      },
      setModel: function (m) { if (m) model = m; return Promise.resolve(); },
      setEffort: function () { return Promise.resolve(); },
      setToolPolicy: function () { return Promise.resolve(); },
      stopTask: function () { return Promise.resolve(); },
      getContextUsage: function () { return Promise.resolve(null); },
      abort: function () { aborted = true; if (turnCtl) turnCtl.abort(); pending.length = 0; wake(); end(); },
      close: function () { closed = true; if (turnCtl) turnCtl.abort(); wake(); end(); },
      endInput: function () { inputEnded = true; wake(); },
    };
    if (queryOpts.abortController && queryOpts.abortController.signal) {
      queryOpts.abortController.signal.addEventListener("abort", function () { if (!aborted) handle.abort(); }, { once: true });
    }
    return handle;
  }

  return {
    vendor: "local",
    init: init,
    supportedModels: function () { var s = state.snapshot(); return Promise.resolve(s.models.slice()); },
    createToolServer: function () { return null; },
    createQuery: createQuery,
  };
}

module.exports = { createLocalAdapter: createLocalAdapter, messageFor: messageFor, trimToBudget: trimToBudget, estimateTokens: estimateTokens };

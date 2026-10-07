"use strict";
// Write-capable endpoint worker (spec 2026-10-04 section 2.6, option b): a text action protocol loop run by Aigora.
// The endpoint is chat-only. Each model reply is either a final answer or exactly one fenced `aigora-actions` JSON block
// (at most 8 actions: list/read/write/edit). Aigora runs the batch through lib/sandbox/room-fileops.py inside the room
// scope (bwrap, no credential, no shell, no network use), feeds the results back, and repeats for at most `workRounds` requests.
// Nothing here touches the workspace directly: every file effect happens in the sandboxed helper.
var fs = require("fs");
var path = require("path");
var cp = require("child_process");
var roomPolicy = require("../room-permission-policy");

var LIMITS = {
  actionsPerRound: 8,
  readBytes: 64 * 1024, readRun: 256 * 1024,
  writeBytes: 1024 * 1024, writeRun: 8 * 1024 * 1024,
  filesRun: 20,
  helperMs: 60000, helperOut: 4 * 1024 * 1024, replyChars: 10 * 1024 * 1024,
};
var DEFAULT_ROUNDS = 6;
var HELPER_FILE = path.join(__dirname, "..", "sandbox", "room-fileops.py");
var helperSource = null;
function fileopsSource() {
  if (helperSource === null) helperSource = fs.readFileSync(HELPER_FILE, "utf8");
  return helperSource;
}

var SYSTEM = [
  "You work in a shared room workspace through a small file protocol. You have no shell and no other tools.",
  "To use files, reply with exactly one fenced block like this (at most 8 actions per reply):",
  "```aigora-actions",
  '{"actions":[{"op":"list","path":"."},{"op":"read","path":"inbox/a.md","offset":0,"limit":65536},',
  '{"op":"write","path":"outbox/report.md","content":"..."},{"op":"edit","path":"notes.md","old":"exact text","new":"replacement"}]}',
  "```",
  "Paths are relative to the workspace (no leading /, no ..). `inbox/` holds this instruction's attachments and is read-only.",
  "Put files meant for the room in `outbox/`. You cannot create links, run commands or reach anything outside the workspace.",
  "Limits: a read returns at most 64 KiB (use offset to continue); a write at most 1 MiB; at most 20 files per run.",
  "I run your actions and send the results back. When you are done, reply with your final answer as plain text and no aigora-actions block.",
].join("\n");
var CORRECTIVE = "Your last aigora-actions block was not valid. Reply with exactly one fenced ```aigora-actions block containing JSON of the form " +
  '{"actions":[{"op":"list"|"read"|"write"|"edit", "path":"relative/path", ...}]} with 1 to 8 actions, or reply with your final answer as plain text.';

var OPEN_LINE = /^[ \t]*```[ \t]*aigora-actions[ \t]*$/, CLOSE_LINE = /^[ \t]*```[ \t]*$/;
var PATH_MAX = 512;

function isStr(v) { return typeof v === "string"; }
function intOrUndef(v) { return v === undefined || (Number.isInteger(v) && v >= 0); }
// One action -> normalized action, or null when malformed. Unknown fields are dropped.
function normalizeAction(a) {
  if (!a || typeof a !== "object" || Array.isArray(a) || !isStr(a.op)) return null;
  if (!isStr(a.path) && !(a.op === "list" && a.path === undefined)) return null;
  var p = a.path === undefined ? "." : a.path;
  if (p.length > PATH_MAX) return null;
  if (a.op === "list") return { op: "list", path: p };
  if (a.op === "read") {
    if (!intOrUndef(a.offset) || !(a.limit === undefined || (Number.isInteger(a.limit) && a.limit >= 1))) return null;
    return { op: "read", path: p, offset: a.offset || 0, limit: a.limit === undefined ? LIMITS.readBytes : a.limit };
  }
  if (a.op === "write") return isStr(a.content) ? { op: "write", path: p, content: a.content } : null;
  if (a.op === "edit") return isStr(a.old) && a.old !== "" && isStr(a.new) ? { op: "edit", path: p, old: a.old, new: a.new } : null;
  return null;
}
// -> { kind: "final", text } | { kind: "actions", actions, prose } | { kind: "bad" }
// Linear line scan (no backtracking regex): the reply comes from an untrusted server and may be megabytes long.
function parseReply(text) {
  text = isStr(text) ? text : "";
  var lines = text.split("\n"), blocks = [], prose = [], cur = null, sawOpen = false;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].replace(/\r$/, "");
    if (cur) {
      if (CLOSE_LINE.test(line)) { blocks.push(cur.join("\n")); cur = null; } else cur.push(line);
    } else if (OPEN_LINE.test(line)) { sawOpen = true; cur = []; } else prose.push(lines[i]);
  }
  if (cur) return { kind: "bad" }; // an opened aigora-actions fence that never closed
  if (!blocks.length) return sawOpen ? { kind: "bad" } : { kind: "final", text: text.trim() };
  if (blocks.length > 1) return { kind: "bad" };
  var obj;
  try { obj = JSON.parse(blocks[0]); } catch (_) { return { kind: "bad" }; }
  if (!obj || typeof obj !== "object" || Array.isArray(obj) || !Array.isArray(obj.actions)) return { kind: "bad" };
  if (obj.actions.length < 1 || obj.actions.length > LIMITS.actionsPerRound) return { kind: "bad" };
  var actions = obj.actions.map(normalizeAction);
  if (actions.some(function (a) { return a === null; })) return { kind: "bad" };
  return { kind: "actions", actions: actions, prose: prose.join("\n").trim() };
}

// Daemon-side relative-path rule (the helper enforces the same again; this only keeps obviously bad paths off the wire).
function relativeProblem(p) {
  if (p.indexOf("\0") !== -1) return "bad_path";
  if (p.charAt(0) === "/" || p.charAt(0) === "\\") return "absolute_path";
  if (p.split("/").indexOf("..") !== -1) return "parent_path";
  return null;
}
var TOOL_OF = { list: "LS", read: "Read", write: "Write", edit: "Edit" };

// Settles only after the helper process has exited ("close"): Stop, timeout and output-limit kill the whole process group,
// record why, and keep killing until the child is gone, so the engine never reverts files or releases the workspace lock
// while the helper may still be writing.
function runHelper(ops, o) {
  return new Promise(function (resolve) {
    var done = false, child = null, w = null, out = "", cancel = null, retry = null;
    function finish(r) {
      if (done) return; done = true;
      clearTimeout(timer); clearInterval(retry);
      if (o.signal) o.signal.removeEventListener("abort", onAbort);
      try { if (w && typeof w.cleanup === "function") w.cleanup(); } catch (_) {}
      resolve(r);
    }
    function kill() {
      try { require("../private-agent-scope").killTree(child); } catch (_) { try { child.kill("SIGKILL"); } catch (__) {} }
    }
    function cancelWith(reason) {
      if (done || cancel) return;
      cancel = reason;
      if (!child) return finish({ error: reason }); // nothing was started
      kill();
      retry = setInterval(kill, 1000); // keep going until the child's close
      if (retry.unref) retry.unref();
    }
    function onAbort() { cancelWith("aborted"); }
    var timer = setTimeout(function () { cancelWith("sandbox_timeout"); }, o.helperMs || LIMITS.helperMs);
    if (timer.unref) timer.unref();
    if (o.signal) { if (o.signal.aborted) return finish({ error: "aborted" }); o.signal.addEventListener("abort", onAbort, { once: true }); }
    try {
      w = o.scope.wrap("/usr/bin/python3", ["-I", "-S", "-c", fileopsSource(), o.workspace], {});
      child = (o.spawn || cp.spawn)(w.command, w.args, { cwd: o.workspace, env: w.env, stdio: ["pipe", "pipe", "ignore"], detached: true });
    } catch (_) { return finish({ error: "sandbox_unavailable" }); }
    child.stdout.on("data", function (c) {
      if (cancel) return;
      out += c.toString("utf8");
      if (out.length > LIMITS.helperOut) { out = ""; cancelWith("sandbox_output"); }
    });
    // A spawn that never produced a process has nothing to wait for; otherwise the exit is reported by close.
    child.on("error", function () { if (!child.pid) finish({ error: cancel || "sandbox_unavailable" }); });
    child.on("close", function (code) {
      if (cancel) return finish({ error: cancel });
      var parsed;
      try { parsed = JSON.parse(out); } catch (_) { return finish({ error: "sandbox_failed" }); }
      if (code !== 0 || !parsed || !Array.isArray(parsed.results) || parsed.results.length !== ops.length) return finish({ error: "sandbox_failed" });
      finish({ results: parsed.results });
    });
    child.stdin.on("error", function () {});
    child.stdin.end(JSON.stringify({ ops: ops, remainingBytes: o.remainingBytes }));
  });
}

function clipResults(results, budget) {
  var reads = results.filter(function (r) { return r && typeof r.content === "string"; });
  if (!reads.length) return results;
  var per = Math.max(500, Math.floor(budget / reads.length));
  return results.map(function (r) {
    if (r && typeof r.content === "string" && r.content.length > per) return Object.assign({}, r, { content: r.content.slice(0, per), clipped: true });
    return r;
  });
}

function textOf(chunk) {
  var c = chunk && chunk.choices && chunk.choices[0];
  var d = c && c.delta && c.delta.content;
  return typeof d === "string" ? d : "";
}

function createEndpointWorker(deps) {
  deps = deps || {};
  var client = deps.client || require("../providers/local/client");
  function auditFn() { return deps.audit || function (action, ctx) { try { require("../audit").log(action, ctx); } catch (_) {} }; }

  // run({ baseUrl, apiKey, model, label, workRounds, idleTimeoutMs, timeoutMs, contextTokens, maxTokens,
  //       prompt, work, signal, launchError, actorId, roomId, runId, audit })
  //   work = the openRoomWork() result: { workspace, scope, note }. launchError() -> string | null, called before every request.
  // Resolves (never rejects): { ok, answer, rounds, applied, files, limit?, unavailable?, code?, message? }
  //   code: aborted | launch_refused | bad_actions | empty | sandbox_unavailable | sandbox_failed | sandbox_timeout | sandbox_output |
  //         the local client's codes (unreachable | idle | timeout | http | auth | stream_error | bad_response ...) | internal
  // unavailable:true only when the very first request failed before any action was applied (the caller may use a fallback).
  async function run(o) {
    var audit = o.audit || auditFn();
    var work = o.work || {};
    var rounds = 0, applied = 0, readBytes = 0, writeBytes = 0, written = new Set(), filesCount = 0, corrected = false;
    var maxRounds = Number.isInteger(o.workRounds) && o.workRounds >= 1 && o.workRounds <= 12 ? o.workRounds : DEFAULT_ROUNDS;
    var budget = Math.min(256 * 1024, Math.max(4000, (Number.isInteger(o.contextTokens) && o.contextTokens > 0 ? o.contextTokens : 8192) * 2));
    function state() { return { rounds: rounds, applied: applied, files: Array.from(written) }; }
    function fail(code, message, extra) { return Object.assign({ ok: false, code: code, message: message || code, answer: "" }, state(), extra || {}); }
    function log(op, p, size, outcome) {
      try { audit("room.endpoint.action", { actorId: o.actorId || null, target: o.roomId || null,
        metadata: { runId: o.runId || null, op: op, path: String(p).slice(0, 200), size: size, outcome: outcome } }); } catch (_) {}
    }
    try {
      if (!work.workspace || !work.scope || typeof work.scope.wrap !== "function") return fail("sandbox_unavailable", "no room scope");
      var messages = [{ role: "system", content: SYSTEM }, { role: "user", content: (work.note || "") + String(o.prompt || "") }];
      var correcting = false, first = true;
      for (;;) {
        if (o.signal && o.signal.aborted) return fail("aborted", "aborted");
        if (typeof o.launchError === "function") {
          var le = await o.launchError();
          if (le) return fail("launch_refused", typeof le === "string" ? le : "launch_refused");
        }
        if (!correcting) rounds++; // a corrective reply is an extra request inside the same round
        var reply = "";
        try {
          var body = { model: o.model, messages: messages };
          if (Number.isInteger(o.maxTokens) && o.maxTokens > 0) body.max_tokens = o.maxTokens;
          for await (var chunk of client.streamChat({ baseUrl: o.baseUrl, apiKey: o.apiKey, body: body, signal: o.signal,
            idleTimeoutMs: o.idleTimeoutMs || 0, timeoutMs: o.timeoutMs || 0, fetch: o.fetch })) {
            reply += textOf(chunk);
            if (reply.length > LIMITS.replyChars) break; // 8 writes of 1 MiB must fit
          }
        } catch (e) {
          if (o.signal && o.signal.aborted) return fail("aborted", "aborted");
          var code = e && e.code ? String(e.code) : "unreachable";
          return fail(code, String((e && e.message) || code).slice(0, 200), { unavailable: first && applied === 0 });
        }
        if (o.signal && o.signal.aborted) return fail("aborted", "aborted");
        var wasFirst = first; first = false;
        var parsed = parseReply(reply);
        if (parsed.kind === "final") {
          if (!parsed.text) return fail("empty", "empty answer", { unavailable: wasFirst && applied === 0 });
          return Object.assign({ ok: true, answer: parsed.text }, state());
        }
        if (parsed.kind === "bad") {
          if (corrected) return fail("bad_actions", "malformed aigora-actions block");
          corrected = true; correcting = true;
          messages.push({ role: "assistant", content: reply }, { role: "user", content: CORRECTIVE });
          continue;
        }
        correcting = false;
        // Gate every action (room policy + caps), then run the allowed ones as one batch inside the room scope.
        var results = new Array(parsed.actions.length), batch = [], slot = [], pending = new Set(), planRead = 0, planWrite = 0;
        parsed.actions.forEach(function (a, i) {
          var why = relativeProblem(a.path);
          if (!why && !roomPolicy.autoAllow(TOOL_OF[a.op], { file_path: a.path, path: a.path }, work.workspace)) why = "outside_workspace";
          var key = path.posix.normalize(a.path);
          if (!why && a.op === "read") {
            var left = LIMITS.readRun - readBytes - planRead; // a batch counts each read at its upper bound
            if (left <= 0) why = "read_cap"; else { a = Object.assign({}, a, { limit: Math.min(a.limit, LIMITS.readBytes, left) }); planRead += a.limit; }
          }
          if (!why && (a.op === "write" || a.op === "edit")) {
            var size = Buffer.byteLength(a.op === "write" ? a.content : a.new);
            if (size > LIMITS.writeBytes) why = "write_too_large";
            else if (writeBytes + planWrite + size > LIMITS.writeRun) why = "write_cap";
            else if (!written.has(key) && !pending.has(key) && filesCount + pending.size >= LIMITS.filesRun) why = "file_cap";
            else { pending.add(key); planWrite += size; }
          }
          if (why) { results[i] = { ok: false, error: "denied", reason: why }; log(a.op, a.path, 0, "denied:" + why); return; }
          batch.push(a); slot.push(i);
        });
        if (batch.length) {
          var ran = await runHelper(batch, { scope: work.scope, workspace: work.workspace, signal: o.signal, spawn: deps.spawn, helperMs: deps.helperMs,
            remainingBytes: Math.max(0, LIMITS.writeRun - writeBytes) });
          if (ran.error === "aborted") return fail("aborted", "aborted");
          if (ran.error) return fail(ran.error, ran.error);
          batch.forEach(function (a, k) {
            var r = ran.results[k] || { ok: false, error: "internal" };
            var size = a.op === "write" ? Buffer.byteLength(a.content) : a.op === "edit" ? Buffer.byteLength(a.new) : (r.bytes || 0);
            log(a.op, a.path, size, r.ok ? "ok" : String(r.error));
            if (r.ok) {
              if (a.op === "read") readBytes += Buffer.byteLength(r.content || "");
              if (a.op === "write" || a.op === "edit") {
                applied++; writeBytes += r.bytes || 0;
                var key2 = path.posix.normalize(a.path);
                if (!written.has(key2)) { written.add(key2); filesCount++; }
              }
            }
            results[slot[k]] = r;
          });
        }
        if (rounds >= maxRounds) {
          return Object.assign({ ok: true, answer: parsed.prose || "(round limit reached)", limit: "rounds" }, state());
        }
        messages.push({ role: "assistant", content: reply });
        messages.push({ role: "user", content: "[aigora-results]\n" + JSON.stringify({ results: clipResults(results, budget) }) + "\nContinue, or reply with your final answer as plain text." });
      }
    } catch (e) {
      return fail("internal", String((e && e.message) || e).slice(0, 200));
    }
  }
  return { run: run };
}

var shared = null;
function sharedWorker() { return shared || (shared = createEndpointWorker()); }

module.exports = {
  run: function (o) { return sharedWorker().run(o); },
  createEndpointWorker: createEndpointWorker,
  parseReply: parseReply,
  LIMITS: LIMITS,
  SYSTEM_PROMPT: SYSTEM,
};

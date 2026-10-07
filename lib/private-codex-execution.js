module.exports = require("./extensions").select("private-codex-execution", function () {
var module = { exports: {} };
"use strict";
// Private (channel-bound) Codex execution. Mirrors private-claude-execution.js:
// one gate, a dedicated per-run app-server started through the isolation scope,
// never the shared adapter app-server.
var path = require("path");
var cp = require("child_process");
var fs = require("fs");
var scopes = require("./private-agent-scope");
var modelPolicy = require("./model-policy");
var { createPrivateSessionAccess } = require("./private-session-access");
var { isPrivateExecutionEnabled } = require("./private-execution-flags");
var roomExec = require("./room-execution");
var active = new WeakMap();
var sessions = new WeakMap();
var preparing = new WeakSet();
var contexts = new WeakMap();
var bindings = new WeakMap();
function binding(session) { return JSON.stringify([session.ownerId, session.roomId, session.channelId, session.localId]); }
function assertBinding(scope, session) { if (bindings.get(scope) !== binding(session)) throw unavailable(); }
function unavailable() { return new Error("Private execution unavailable"); }
function authorize(ctx) {
  if (ctx.room) return roomExec.authorize(ctx, "codex");
  if (!ctx.actor || ctx.actor.id !== ctx.session.ownerId) throw unavailable();
  createPrivateSessionAccess(ctx.users).assertSessionAction(ctx.actor, ctx.session, { visibility: "public" }, "mutate");
  if (ctx.isActive && ctx.isActive() !== true) throw unavailable();
  if ((ctx.session.vendor || ctx.adapter.vendor) !== "codex" || ctx.adapter.vendor !== "codex" ||
    (ctx.isEnabled || isPrivateExecutionEnabled)("codex") !== true) throw unavailable();
}
// True when the session was re-bound (owner/room/channel/id) after its scope was prepared.
function scopeChanged(session) { var scope = sessions.get(session); return !!scope && bindings.get(scope) !== binding(session); }
function modelAllowed(model, effort) {
  return modelPolicy.checkModel("codex", model).ok && modelPolicy.checkEffort("codex", effort).ok;
}
function applyPrivateCodexScope(scope, serverOpts) {
  if (!scopes.isPreparedPrivateScope(scope) || !active.has(scope)) throw unavailable();
  var lease = require("./credential-leases").scopeCredential(scope, "codex");
  serverOpts.credentialLease = lease;
  serverOpts.containedCredential = true;
  serverOpts.cwd = scope.workspace;
  serverOpts.env = { PATH: "/usr/bin:/bin" };
  serverOpts.spawn = function (command, args) {
    try {
      var ctx = contexts.get(scope);
      authorize(ctx);
      require("./credential-leases").assertCredentialLease(lease, "codex");
      assertBinding(scope, ctx.session);
      var real = fs.realpathSync(command);
      // 0.160 layout: <triple>/bin/codex with sibling codex-resources/ (bwrap) and codex-path/ (rg); bind the whole <triple> dir (read-only).
      var binDir = path.dirname(real);
      if (path.basename(binDir) === "bin" && fs.existsSync(path.join(path.dirname(binDir), "codex-resources"))) binDir = path.dirname(binDir);
      var w = scope.wrap(real, args, { env: { PATH: "/usr/bin:/bin" },
        binaryDirs: [binDir].filter(function (p) { return path.isAbsolute(p) && p !== "/"; }) });
      var child = cp.spawn(w.command, w.args, { shell: false, cwd: scope.workspace, env: w.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
      active.get(scope).add(child);
      child.once("exit", function () { var children = active.get(scope); if (children) children.delete(child); if (typeof w.cleanup === "function") w.cleanup(); });
      child.once("error", function () { if (typeof w.cleanup === "function") w.cleanup(); });
      return child;
    } catch (_) { scope.cleanup(); throw unavailable(); }
  };
}
// Called by the Codex adapter instead of its shared app-server path.
async function createPrivateCodexQuery(q, deps) {
  var server;
  try {
    var scope = q.privateScope;
    // "untrusted": every command outside Codex's own trusted set goes to requestApproval -> canUseTool -> room policy.
    // Codex's built-in "known safe" commands (read-only ones such as ls/cat/grep) run WITHOUT asking, with arbitrary
    // paths. No codex 0.160 config key forces a prompt for them (approval_policy is rejected in config, "granular"
    // only gates rules/skills), so this is accepted and bounded by the sandbox: the outer bwrap/Landlock scope
    // (no host reads, no network beyond the policy) stays the boundary (the readable provider credential is a documented residual).
    // Codex >= 0.160 rejects approval_policy = "untrusted" in --config ("no longer supported"); the policy is
    // enforced per thread via approvalPolicy: "untrusted" below (still in the protocol AskForApproval enum).
    var opts = { config: Object.assign({ sandbox_mode: "workspace-write" }, modelPolicy.CODEX_CHILD_GUARD_CONFIG) };
    applyPrivateCodexScope(scope, opts);
    server = new deps.AppServer(null, opts);
    await server.start();
    await server.send("initialize", { clientInfo: { name: "aigora", title: "Aigora", version: "1.0.0" }, capabilities: { experimentalApi: true } });
    server.notify("initialized", {});
    return deps.createHandle(server, {
      model: q.model, defaultModel: q.model, cwd: scope.workspace, systemPrompt: q.systemPrompt || "",
      abortController: q.abortController || new AbortController(), canUseTool: q.canUseTool || null, onElicitation: q.onElicitation || null,
      resumeSessionId: q.resumeSessionId || null, homeOverride: scope.workspace, modelReasoningEffort: q.effort,
      toolPolicy: null, approvalPolicy: "untrusted", sandboxMode: "workspace-write",
      onFinished: function () { try { server.stop(); } catch (_) {} },
    });
  } catch (_) {
    try { if (server) server.stop(); } catch (_) {}
    throw unavailable();
  }
}
function refuse(ctx) {
  try { if (ctx.refuse && ctx.actor) ctx.refuse({ type: "error", error: "Private execution unavailable" }); } catch (_) {}
}
async function startPrivateCodexQuery(ctx) {
  var scope, handle, ownsPreparation = false, failReason = null, closeBroker = null;
  function cleanup() {
    // Revoke the run token on every path (also when the scope never became ready).
    if (closeBroker) { var c = closeBroker; closeBroker = null; try { c(); } catch (_) {} }
    if (!scope) return;
    var children = active.get(scope);
    if (sessions.get(ctx.session) === scope) sessions.delete(ctx.session);
    if (children) children.forEach(function (child) { scopes.killTree(child); });
    active.delete(scope);
    contexts.delete(scope);
    bindings.delete(scope);
    try { if (scope.cleanup() === false) console.error("[private-scope] cleanup incomplete"); } catch (_) {}
    if (ctx.session._privateScopeCleanup === cleanup) delete ctx.session._privateScopeCleanup;
  }
  try {
    authorize(ctx);
    var q = ctx.queryOptions || {};
    if (!modelAllowed(q.model, q.effort)) throw unavailable();
    if (preparing.has(ctx.session) || sessions.has(ctx.session)) throw unavailable();
    preparing.add(ctx.session); ownsPreparation = true;
    var originalBinding = binding(ctx.session);
    // Private runs (channel and room alike) never honour the host ~/.codex/config.toml, and in particular never its
    // They get an empty per-run config and no extra allowTcpPorts; a missing host config.toml is therefore irrelevant.
    // In api_key mode the broker's config (base URL of the per-run broker, no key) replaces it (spec D1); credentials follow
    var cred;
    try { cred = await roomExec.prepareCredential(ctx, "codex"); }
    catch (e) { failReason = e && (e.message === "budget_exhausted") ? e.message : "credential_unavailable"; throw e; }
    closeBroker = cred.close;
    // S4: a room run never reads an AGENTS.md planted in the shared workspace by another agent.
    var s4 = ctx.room ? "project_doc_max_bytes = 0\n" : "";
    var mini = { ports: [], text: s4 };
    var prepared = ctx.room ? Object.assign({}, ctx.scopeOptions, roomExec.scopeBaseOptions(ctx, "codex"), { allowTcpPorts: mini.ports, codexConfigText: mini.text }, cred.options)
      : Object.assign({}, ctx.scopeOptions, {
        agent: "codex", actorId: ctx.actor.id, roomId: ctx.session.roomId,
        channelId: ctx.session.channelId, rootSessionId: String(ctx.session.localId),
        isEnabled: ctx.isEnabled || isPrivateExecutionEnabled, persistCodexState: true, probeMaxAgeMs: 0,
        allowTcpPorts: mini.ports, codexConfigText: mini.text,
      }, roomExec.privateToolchainOptions(ctx), cred.options);
    if (s4 && typeof prepared.codexConfigText === "string" && prepared.codexConfigText.indexOf("project_doc_max_bytes") === -1) prepared.codexConfigText = s4 + prepared.codexConfigText;
    scope = await scopes.preparePrivateAgentScope(prepared);
    roomExec.closeWithScope(scope, closeBroker);
    if (scope.ready) require("./credential-leases").bindScope(scope, cred);
    if (ctx.room) { failReason = scope.reason; if (scope.ready) ctx.networkPolicy = scope.networkPolicy; }
    if (!scope.ready || !scopes.isPreparedPrivateScope(scope)) throw unavailable();
    authorize(ctx);
    bindings.set(scope, originalBinding);
    assertBinding(scope, ctx.session);
    active.set(scope, new Set());
    contexts.set(scope, ctx);
    sessions.set(ctx.session, scope);
    ctx.session._privateScopeCleanup = cleanup;
    handle = await ctx.adapter.createQuery(Object.assign({}, q, { cwd: scope.workspace, privateScope: scope }));
    authorize(ctx);
    assertBinding(scope, ctx.session);
    var iterator = handle[Symbol.asyncIterator].bind(handle);
    ["setModel", "setEffort", "setToolPolicy", "pushMessage"].forEach(function (name) {
      var original = handle[name];
      if (!original) return;
      handle[name] = function (a, b) {
        var bad = (name === "setModel" && !modelPolicy.checkModel("codex", a).ok) || (name === "setEffort" && !modelPolicy.checkEffort("codex", a).ok) ||
          (name === "setToolPolicy" && a === "allow-all") || (name === "pushMessage" && b && b.length > 0);
        if (bad) { var e = unavailable(); if (name === "pushMessage") throw e; return Promise.reject(e); }
        return original.apply(handle, arguments);
      };
    });
    handle[Symbol.asyncIterator] = async function* () {
      try { for await (var event of { [Symbol.asyncIterator]: iterator }) { assertBinding(scope, ctx.session); yield event; } }
      catch (_) { throw unavailable(); }
      finally { cleanup(); }
    };
    ["close", "abort"].forEach(function (name) {
      var original = handle[name];
      handle[name] = function () { try { if (original) return original.apply(handle, arguments); } finally { cleanup(); } };
    });
    var signal = q.abortController && q.abortController.signal;
    if (signal) { signal.addEventListener("abort", cleanup, { once: true }); if (signal.aborted) { handle.close(); throw unavailable(); } }
    return handle;
  } catch (_) {
    var thrown = _;
    try { if (handle) handle.close(); } catch (_) {}
    cleanup();
    if (ctx.room) {
      failReason = failReason || roomExec.failReasonOf(thrown);
      ctx.failure = { reason: failReason };
      try { if (ctx.refuse) ctx.refuse({ type: "error", error: roomExec.messageFor(failReason, "codex", roomExec.isAdminActor(ctx)) }); } catch (_) {}
      return null;
    }
    if (thrown && (thrown.message === "credential_unavailable" || thrown.message === "budget_exhausted")) {
      try { if (ctx.refuse && ctx.actor) ctx.refuse({ type: "error", error: roomExec.messageFor(thrown.message) }); } catch (_) {}
      return null;
    }
    refuse(ctx);
    return null;
  } finally { if (ownsPreparation) preparing.delete(ctx.session); }
}
// Closes the session's open handle (its scope cleanup runs through the wrapped close).
function closeOpenHandle(session) { try { if (session.queryInstance) session.queryInstance.close(); } catch (_) {} }


function pushPrivateCodexMessage(ctx, text, images) {
  try {
    authorize(ctx);
    var scope = sessions.get(ctx.session);
    if (!scope || !scopes.isPreparedPrivateScope(scope) || !ctx.session.queryInstance) throw unavailable();
    assertBinding(scope, ctx.session);
    try { require("./credential-leases").scopeCredential(scope, "codex"); }
    catch (e) { closeOpenHandle(ctx.session); throw e; }
    ctx.session.queryInstance.pushMessage(text, images);
    return true;
  } catch (_) { refuse(ctx); return false; }
}
function canQueuePrivateCodexMessage(ctx) {
  try { authorize(ctx); return true; } catch (_) { refuse(ctx); return false; }
}
function workspaceFor(session) { var scope = sessions.get(session); return scope && typeof scope.workspace === "string" ? scope.workspace : null; }
module.exports = { workspaceFor: workspaceFor, scopeChanged: scopeChanged, canQueuePrivateCodexMessage: canQueuePrivateCodexMessage, pushPrivateCodexMessage: pushPrivateCodexMessage,
  startPrivateCodexQuery: startPrivateCodexQuery, applyPrivateCodexScope: applyPrivateCodexScope, createPrivateCodexQuery: createPrivateCodexQuery,
  removePrivateCodexState: scopes.removePrivateCodexState };

return module.exports;
});

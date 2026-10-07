module.exports = require("./extensions").select("private-claude-execution", function () {
var module = { exports: {} };
"use strict";
var path = require("path");
var cp = require("child_process");
var fs = require("fs");
var scopes = require("./private-agent-scope");
var modelPolicy = require("./model-policy");
var { createPrivateSessionAccess } = require("./private-session-access");
var { isPrivateExecutionEnabled } = require("./private-execution-flags");
var roomExec = require("./room-execution");
var memoryIsolation = require("./memory-isolation");
var skillsFlags = require("./skills-flags");
var skillsCatalog = require("./skills-catalog");
var active = new WeakMap();
var sessions = new WeakMap();
var preparing = new WeakSet();
var contexts = new WeakMap();
var bindings = new WeakMap();
function binding(session) { return JSON.stringify([session.ownerId, session.roomId, session.channelId, session.localId]); }
function assertBinding(scope, session) { if (bindings.get(scope) !== binding(session)) throw unavailable(); }
function authorize(ctx) {
  if (ctx.room) return roomExec.authorize(ctx, "claude");
  if (!ctx.actor || ctx.actor.id !== ctx.session.ownerId) throw unavailable();
  createPrivateSessionAccess(ctx.users).assertSessionAction(ctx.actor, ctx.session, { visibility: "public" }, "mutate");
  if (ctx.isActive && ctx.isActive() !== true) throw unavailable();
  if ((ctx.session.vendor || ctx.adapter.vendor) !== "claude" || ctx.adapter.vendor !== "claude" ||
    (ctx.isEnabled || isPrivateExecutionEnabled)("claude") !== true) throw unavailable();
}
// Owner-visible refusal reasons for private runs. Only these fixed codes ever reach the client; anything else
// (workspace_unavailable, invalid_*, thrown paths, internals) stays the generic "Private execution unavailable".
var PRIVATE_REASONS = { private_execution_disabled: 1, credential_unavailable: 1,  budget_exhausted: 1, bubblewrap_unavailable: 1, network_isolation_unavailable: 1, resource_limits_unavailable: 1,
  skills_unavailable: 1, resource_limit_reached: 1, probe_failed: 1 };
var MSG_DISABLED = "개인 채널 AI 실행이 꺼져 있어요 (관리자 설정)";
function privateRefusal(reason) {
  if (typeof reason !== "string" || !Object.prototype.hasOwnProperty.call(PRIVATE_REASONS, reason)) return { type: "error", error: "Private execution unavailable" };
  return { type: "error", error: reason === "private_execution_disabled" ? MSG_DISABLED : roomExec.messageFor(reason), reason: reason };
}
// Reason for a fail-closed authorize() of an already-verified owner: only the flag being off is distinguishable.
function ownerFlagOff(ctx) {
  try { return (ctx.isEnabled || isPrivateExecutionEnabled)("claude") !== true ? "private_execution_disabled" : null; } catch (_) { return null; }
}
// True when the session was re-bound (owner/room/channel/id) after its scope was prepared.
function scopeChanged(session) { var scope = sessions.get(session); return !!scope && bindings.get(scope) !== binding(session); }
function unavailable() { return new Error("Private execution unavailable"); }
var ROOM_ASK_TOOLS = ["Bash", "WebFetch", "WebSearch"];
function roomEnforcingSettings() {
  return { permissions: { ask: ROOM_ASK_TOOLS.slice(), defaultMode: "default" }, sandbox: { autoAllowBashIfSandboxed: false } };
}
// The run's own skill set (flag off: none). Room turns read the room's enablement, private-channel turns the actor's own;
// the two never mix. Any error means no skills (never a wider set).
function activeSkills(ctx) {
  try {
    if (!(ctx.isSkillsEnabled || skillsFlags.isSkillsEnabled)()) return undefined;
    var catalog = ctx.skillsCatalog || skillsCatalog.getDefault();
    var list = catalog.activeFor(ctx.room ? { roomId: ctx.session.roomId } : { roomId: ctx.session.roomId, userId: ctx.actor.id });
    return list.length ? list : undefined;
  } catch (e) { console.error("[skills] resolve failed"); return undefined; }
}
function applyPrivateClaudeScope(scope, options) {
  if (!scopes.isPreparedPrivateScope(scope) || !active.has(scope)) throw unavailable();
  var lease = require("./credential-leases").scopeCredential(scope, "claude");
  if (options.pathToClaudeCodeExecutable) options.pathToClaudeCodeExecutable = fs.realpathSync(options.pathToClaudeCodeExecutable);
  options.cwd = scope.workspace;
  options.env = { PATH: "/usr/bin:/bin" };
  // Room and private-channel runs alike: no hooks (a model-writable workspace .claude/ could define them), and the
  // CLI auto-approves read-only Bash ("Read-only command is allowed") before canUseTool while a workspace
  // .claude/settings.json could add allow rules. Load no settings files, force the default mode, and make every
  // non-file tool ask (ask rules outrank allow and the read-only shortcut).
  options.settings = Object.assign({}, options.settings, { disableAllHooks: true }, roomEnforcingSettings());
  options.settingSources = [];
  // Room skills (spec 2026-10-03-room-skills-plugins.md section 4): the only plugin is the server-assembled read-only bind;
  // nothing the caller or the workspace names survives. No active skills: none of these keys are set.
  delete options.plugins; delete options.skills; delete options.strictMcpConfig;
  if (scope.skillPlugin && scope.skillPlugin.names.length) {
    options.plugins = [{ type: "local", path: scope.skillPlugin.path, skipMcpDiscovery: true }];
    options.skills = scope.skillPlugin.names.slice();
    options.strictMcpConfig = true;
  }
  options.permissionMode = "default";
  delete options.allowedTools;
  if (options.permissionMode === "bypassPermissions") options.permissionMode = "default";
  delete options.allowDangerouslySkipPermissions;
  options.spawnClaudeCodeProcess = function (o) {
    try {
      var ctx = contexts.get(scope);
      authorize(ctx);
      require("./credential-leases").assertCredentialLease(lease, "claude");
      assertBinding(scope, ctx.session);
      var pins = Object.assign(modelPolicy.claudeChildEnv(), memoryIsolation.CLAUDE_MEMORY_OFF_ENV);
      var w = scope.wrap(o.command, o.args, { env: Object.assign({}, o.env, pins), passEnv: Object.keys(pins),
        binaryDirs: [path.dirname(options.pathToClaudeCodeExecutable || o.command)].filter(function (p) { return path.isAbsolute(p) && p !== "/"; }) });
      var child = cp.spawn(w.command, w.args, { shell: false, cwd: scope.workspace, env: w.env, stdio: ["pipe", "pipe", "pipe"], detached: true, signal: o.signal });
      active.get(scope).add(child);
      child.once("exit", function () { var children = active.get(scope); if (children) children.delete(child); if (typeof w.cleanup === "function") w.cleanup(); });
      child.once("error", function () { if (typeof w.cleanup === "function") w.cleanup(); });
      return child;
    } catch (_) { scope.cleanup(); throw unavailable(); }
  };
}
async function startPrivateClaudeQuery(ctx) {
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
    try { authorize(ctx); } catch (e) {
      // A verified owner (the only actor authorize() lets reach the flag check) learns that the flag is off.
      if (!ctx.room && ctx.actor && ctx.actor.id === ctx.session.ownerId && (!ctx.isActive || ctx.isActive() === true) && ctx.adapter && ctx.adapter.vendor === "claude" && (ctx.session.vendor || ctx.adapter.vendor) === "claude") {
        try { createPrivateSessionAccess(ctx.users).assertSessionAction(ctx.actor, ctx.session, { visibility: "public" }, "mutate"); failReason = ownerFlagOff(ctx); } catch (_) {}
      }
      throw e;
    }
    if (preparing.has(ctx.session) || sessions.has(ctx.session)) throw unavailable();
    preparing.add(ctx.session); ownsPreparation = true;
    var originalBinding = binding(ctx.session);
    var cred;
    try { cred = await roomExec.prepareCredential(ctx, "claude"); }
    catch (e) { failReason = e && (e.message === "budget_exhausted") ? e.message : "credential_unavailable"; throw e; }
    closeBroker = cred.close;
    var prepared = ctx.room ? Object.assign({}, ctx.scopeOptions, roomExec.scopeBaseOptions(ctx, "claude"), cred.options) : Object.assign({}, ctx.scopeOptions, {
      agent: "claude", actorId: ctx.actor.id, roomId: ctx.session.roomId,
      channelId: ctx.session.channelId, rootSessionId: String(ctx.session.localId),
      isEnabled: ctx.isEnabled || isPrivateExecutionEnabled, persistClaudeState: ctx.ephemeral !== true, probeMaxAgeMs: 0,
    }, roomExec.privateToolchainOptions(ctx), cred.options);
    prepared.skills = activeSkills(ctx);
    scope = await scopes.preparePrivateAgentScope(prepared);
    roomExec.closeWithScope(scope, closeBroker);
    if (scope.ready) require("./credential-leases").bindScope(scope, cred);
    failReason = scope.reason; if (ctx.room && scope.ready) ctx.networkPolicy = scope.networkPolicy;
    if (!scope.ready || !scopes.isPreparedPrivateScope(scope)) throw unavailable();
    authorize(ctx);
    bindings.set(scope, originalBinding);
    assertBinding(scope, ctx.session);
    active.set(scope, new Set());
    contexts.set(scope, ctx);
    sessions.set(ctx.session, scope);
    ctx.session._privateScopeCleanup = cleanup;
    handle = await ctx.adapter.createQuery(Object.assign({}, ctx.queryOptions, { cwd: scope.workspace, privateScope: scope }));
    authorize(ctx);
    assertBinding(scope, ctx.session);
    var iterator = handle[Symbol.asyncIterator].bind(handle);
    var originalPermission = handle.setPermissionMode;
    if (originalPermission) handle.setPermissionMode = function (mode) {
      if (mode === "bypassPermissions") return Promise.reject(unavailable());
      return originalPermission.call(handle, mode);
    };
    var originalPolicy = handle.setToolPolicy;
    if (originalPolicy) handle.setToolPolicy = function (policy) {
      if (policy === "allow-all") return Promise.reject(unavailable());
      return originalPolicy.call(handle, policy);
    };
    handle[Symbol.asyncIterator] = async function* () {
      try { for await (var event of { [Symbol.asyncIterator]: iterator }) { assertBinding(scope, ctx.session); yield event; } }
      catch (_) { throw unavailable(); }
      finally { cleanup(); }
    };
    ["close", "abort"].forEach(function (name) {
      var original = handle[name];
      handle[name] = function () { try { if (original) return original.apply(handle, arguments); } finally { cleanup(); } };
    });
    var signal = ctx.queryOptions && ctx.queryOptions.abortController && ctx.queryOptions.abortController.signal;
    if (signal) { signal.addEventListener("abort", cleanup, { once: true }); if (signal.aborted) { handle.close(); throw unavailable(); } }
    return handle;
  } catch (_) {
    var thrown = _;
    try { if (handle) handle.close(); } catch (_) {}
    cleanup();
    if (ctx.room) {
      failReason = failReason || roomExec.failReasonOf(thrown);
      ctx.failure = { reason: failReason };
      try { if (ctx.refuse) ctx.refuse({ type: "error", error: roomExec.messageFor(failReason, "claude", roomExec.isAdminActor(ctx)) }); } catch (_) {}
      return null;
    }
    try { if (ctx.refuse && ctx.actor) ctx.refuse(privateRefusal(thrown && thrown.message === "credential_unavailable" ? "credential_unavailable" : failReason)); } catch (_) {}
    return null;
  } finally { if (ownsPreparation) preparing.delete(ctx.session); }
}
// Closes the session's open handle (its scope cleanup runs through the wrapped close).
function closeOpenHandle(session) { try { if (session.queryInstance) session.queryInstance.close(); } catch (_) {} }


function pushPrivateClaudeMessage(ctx, text, images) {
  try {
    authorize(ctx);
    var scope = sessions.get(ctx.session);
    if (!scope || !scopes.isPreparedPrivateScope(scope) || !ctx.session.queryInstance) throw unavailable();
    assertBinding(scope, ctx.session);
    try { require("./credential-leases").scopeCredential(scope, "claude"); }
    catch (e) { closeOpenHandle(ctx.session); throw e; }
    ctx.session.queryInstance.pushMessage(text, images);
    return true;
  } catch (_) {
    try { if (ctx.refuse && ctx.actor) ctx.refuse({ type: "error", error: "Private execution unavailable" }); } catch (_) {}
    return false;
  }
}
function canQueuePrivateClaudeMessage(ctx) {
  try { authorize(ctx); return true; }
  catch (_) {
    try { if (ctx.refuse && ctx.actor) ctx.refuse({ type: "error", error: "Private execution unavailable" }); } catch (_) {}
    return false;
  }
}
// The prepared scope's workspace for a live contained session (null when none).
function workspaceFor(session) { var scope = sessions.get(session); return scope && typeof scope.workspace === "string" ? scope.workspace : null; }
module.exports = { roomEnforcingSettings: roomEnforcingSettings, workspaceFor: workspaceFor, scopeChanged: scopeChanged, canQueuePrivateClaudeMessage: canQueuePrivateClaudeMessage, pushPrivateClaudeMessage: pushPrivateClaudeMessage,   startPrivateClaudeQuery: startPrivateClaudeQuery, applyPrivateClaudeScope: applyPrivateClaudeScope,
  removePrivateClaudeState: scopes.removePrivateClaudeState };

return module.exports;
});

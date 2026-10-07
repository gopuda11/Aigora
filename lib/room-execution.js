module.exports = require("./extensions").select("room-execution", function () {
var module = { exports: {} };
"use strict";
// Room-turn containment (docs/superpowers/specs/2026-10-03-room-turn-containment.md).
// A turn is "room context" when its session has a roomId and no channelId (the room main thread, orchestration
// workers of a room run, any shared room session), whoever triggers it, admin included. By default (and with
// roomExecution.<agent> true) such a turn runs only inside the private-agent-scope sandbox, keyed per room, and fails closed otherwise.
// Admin sessions with no roomId are not room context and keep the unconfined path.
//
// KNOWN GAP (documented, not built): there is no explicit "host session" entry yet. Web-created sessions get the
// user's first room (project-sessions.js), so an admin only gets an unconfined session when no room applies.
// Credential broker (docs/superpowers/specs/2026-10-04-credential-broker-design.md): in api_key mode (broker not explicitly
// disabled) the sandbox gets only a per-run token and a base URL; the real key stays in the daemon (prepareCredential below).
var fs = require("fs");
var path = require("path");
var flags = require("./room-execution-flags");
var scopes = require("./private-agent-scope");
var { isChannelBound } = require("./private-session-access");

function isRoomContext(session) {
  return !!session && typeof session === "object" && typeof session.roomId === "string" && session.roomId !== "" && !isChannelBound(session);
}
// On the contained path = room context AND the vendor is claude/codex AND not explicitly roomExecution.unconfined.
// An agent set to false is on this path too, but authorize() refuses it ("agent_unavailable"): never unconfined.
function isContained(session, vendor) { var m = flags.roomExecutionMode(vendor); return isRoomContext(session) && (m === "contained" || m === "unavailable"); }

// Server messages are Korean + English in one string (the server has no i18n layer; the client shows the text as is).
function both(ko, en) { return ko + "\n" + en; }
var MSG_SANDBOX = both("이 룸의 AI 실행 환경(격리 샌드박스)을 사용할 수 없어 실행하지 않았습니다. 관리자에게 문의하세요.",
  "The isolated sandbox for AI turns in this room is not available, so nothing was run. Please contact the administrator.");
var MESSAGES = {
  bubblewrap_unavailable: MSG_SANDBOX,
  network_isolation_unavailable: MSG_SANDBOX,
  resource_limits_unavailable: MSG_SANDBOX,
  probe_failed: MSG_SANDBOX,
  credential_unavailable: both("AI 계정 인증(API 키)이 설정되지 않아 실행하지 않았습니다. 관리자에게 문의하세요.",
    "No AI credential (API key) is configured for this agent, so nothing was run. Please contact the administrator."),
  agent_unavailable: both("이 에이전트는 이 서버에서 룸 실행에 사용할 수 없도록 설정되어 있습니다. 관리자에게 문의하세요.",
    "This agent is disabled for room turns on this server. Please contact the administrator."),

  skills_unavailable: both("이 방의 스킬을 준비하지 못해 실행하지 않았습니다. 관리자에게 문의하세요.",
    "This room's skills could not be prepared, so nothing was run. Please contact the administrator."),
  budget_exhausted: both("이 방 또는 사용자의 AI 사용 한도에 도달해 실행하지 않았습니다. 잠시 후 다시 시도하거나 관리자에게 문의하세요.",
    "The AI usage budget for this run, user or room has been reached, so nothing was run. Please try again later or contact the administrator."),
  resource_limit_reached: both("현재 AI 실행이 많아 잠시 후 다시 시도해 주세요.", "AI runs are busy right now; please try again shortly."),
};
// What the administrator must do. Shown to admin requesters and written to the daemon log; never to other members.
function adminHintFor(reason, vendor) {
  var v = vendor === "codex" ? "codex" : "claude";
  if (reason === "bubblewrap_unavailable") return both("[관리자] 호스트에 bubblewrap(bwrap)을 설치하세요 (예: apt install bubblewrap / pacman -S bubblewrap). 이미 설치돼 있다면 사용자 네임스페이스가 막힌 것입니다(Ubuntu 24.04는 AppArmor 규칙이 필요하고, 컨테이너는 seccomp 설정이 필요합니다). 원인은 데몬 로그의 [private-scope] 줄과 docs/guides/GETTING-STARTED 를 보세요. 해결 전에는 룸 AI 실행이 모두 거부됩니다.",
    "[admin] Install bubblewrap (bwrap) on the host (e.g. apt install bubblewrap / pacman -S bubblewrap). If it is already installed, user namespaces are blocked (Ubuntu 24.04 needs an AppArmor rule; containers need a seccomp profile that allows them). See the [private-scope] line in the daemon log and docs/guides/GETTING-STARTED. Until then all room AI turns are refused.");
  if (reason === "credential_unavailable") {
    var env = flags.apiKeyEnvName(v);
    return both("[관리자] 데몬 환경에 " + env + " 를 설정하거나 roomExecution.apiKeys." + v + " 를 지정하세요.",
      "[admin] Set " + env + " in the daemon environment, or roomExecution.apiKeys." + v + ".");
  }
  if (reason === "budget_exhausted") return both("[관리자] 사용 한도(실행·사용자·방·전체 일일)에 도달했습니다. roomExecution.broker.limits 로 한도를 조정하세요. 사용량은 broker-usage.json 에 있습니다.",
    "[admin] A usage budget (run, user, room or global daily) was reached. Adjust roomExecution.broker.limits. Usage is in broker-usage.json.");

  if (reason === "agent_unavailable") return both("[관리자] roomExecution." + v + " 가 false 입니다. 룸에서 쓰려면 이 항목을 제거하거나 true 로 바꾸세요.",
    "[admin] roomExecution." + v + " is false. Remove it or set it to true to allow this agent in rooms.");
  if (reason === "network_isolation_unavailable" || reason === "probe_failed") return both("[관리자] 샌드박스 점검에 실패했습니다. bubblewrap 설치와 사용자 네임스페이스 허용(Ubuntu 24.04는 AppArmor 설정 필요), /usr/bin/python3, Linux x64, Landlock ABI 6 이상(커널 6.12+)을 확인하세요. 정확한 원인은 데몬 로그의 [private-scope] 줄에 있고, 방법은 docs/guides/GETTING-STARTED 에 있습니다.",
    "[admin] The sandbox probe failed. Check that bubblewrap is installed and may create user namespaces (Ubuntu 24.04 needs an AppArmor rule), /usr/bin/python3 exists, the host is Linux x64, and the kernel has Landlock ABI 6 or later (Linux 6.12+). The exact cause is in the daemon log on a [private-scope] line; the fix is in docs/guides/GETTING-STARTED.");
  if (reason === "resource_limits_unavailable") return both("[관리자] systemd-run --user 를 사용할 수 없어 자원 제한을 걸 수 없습니다. 사용자 systemd 세션을 확인하거나, 제한 없이 실행을 감수하려면 privateExecution.allowUnlimited: true 를 설정하세요.",
    "[admin] systemd-run --user is unavailable, so resource limits cannot be applied. Check the user systemd session, or accept running without limits by setting privateExecution.allowUnlimited: true.");
  return "";
}
// Every reason (including unknown ones) maps to a message; none ever means "run unconfined". admin=true appends the hint.
function messageFor(reason, vendor, admin) {
  var m = Object.prototype.hasOwnProperty.call(MESSAGES, reason) ? MESSAGES[reason] : MSG_SANDBOX;
  var h = admin === true ? adminHintFor(reason, vendor) : "";
  return h ? m + "\n" + h : m;
}
// Failure reason for an exception raised while starting a room turn.
function failReasonOf(err) {
  var m = err && (err.code || err.message);
  return m === "credential_unavailable" || m === "agent_unavailable" || m === "budget_exhausted" ? m : "probe_failed";
}
function isAdminActor(ctx) { return !!(ctx && ctx.actor && ctx.actor.role === "admin"); }

// Actor must be a current non-viewer member of the room (owner equality is NOT required). Orchestration workers have
// no socket: they are authorized by the run's actor (session.ownerId), re-checked on every call so a member who left
// stops the run. Viewers, non-members and archived rooms are refused.
function authorize(ctx, vendor) {
  var s = ctx.session;
  if (!isRoomContext(s)) throw new Error("not_room_context");
  if (!ctx.isRoomEnabled && flags.roomExecutionMode(vendor) === "unavailable") throw new Error("agent_unavailable");
  if (!(ctx.isRoomEnabled || flags.isRoomExecutionEnabled)(vendor) || ctx.adapter.vendor !== vendor || (s.vendor || ctx.adapter.vendor) !== vendor) throw new Error("not_enabled");
  var id;
  if (ctx.actor) { if (typeof ctx.actor.id !== "string") throw new Error("no_actor"); id = ctx.actor.id; }
  else if (s.hidden && s.orchestration && typeof s.ownerId === "string") id = s.ownerId;
  else throw new Error("no_actor");
  var role = ctx.users && typeof ctx.users.getRoomRole === "function" ? ctx.users.getRoomRole(id, s.roomId) : null;
  if (role !== "owner" && role !== "member") throw new Error("not_member");
  if (ctx.actor && ctx.isActive && ctx.isActive() !== true) throw new Error("inactive");
}

// "admin"; there is no other owner marker). Room: every non-viewer member (room owner plus memberships with role
// owner/member) must be an admin. Private channel: the channel owner must be an admin. Anything unknown (no users
// module, missing room or user, throwing lookup) counts as shared: fail closed.


// Credential options shared by room and private-channel runs: api_key unless roomExecution explicitly selects
function credentialOptions(ctx, vendor) {
  return require("./credential-leases").credentialOptions(Object.assign({}, ctx, { contained: true }), vendor);
}

// else, including a missing or unrecognised mode, counts as holding it: fail closed.

// Re-check before every push into an already-open contained handle (membership may have changed since it started):


// Contained and host execution share one resolver; only contained runs use
// the egress transport and the existing room/private sharing policy.
function prepareCredential(ctx, vendor) {
  return require("./credential-leases").resolveCredential(Object.assign({}, ctx, { contained: true }), vendor);
}
// Ties the broker session to the scope: the scope's own cleanup (every path that releases it) revokes the token first.
function closeWithScope(scope, close) {
  if (!scope || !close || typeof scope.cleanup !== "function") return;
  var inner = scope.cleanup;
  scope.cleanup = function () { close(); return inner.apply(scope, arguments); };
}

// Options for preparePrivateAgentScope without the credential part.
function scopeBaseOptions(ctx, vendor) {
  var s = ctx.session, worker = !!(s.hidden && s.orchestration);
  var o = {
    agent: vendor, actorId: "room", roomId: s.roomId, channelId: s.roomId, rootSessionId: String(s.localId),
    isEnabled: ctx.isRoomEnabled || flags.isRoomExecutionEnabled, capGroup: "room", maxConcurrent: flags.maxRoomConcurrent(),
    probeMaxAgeMs: 0,
    // Main thread: one persistent workspace and CLI store per room. Workers: ephemeral run workspace, no resume store.
    persistentWorkspace: !worker,
  };
  if (!worker) { if (vendor === "claude") o.persistClaudeState = true; else o.persistCodexState = true; }
  var toolchain = (ctx.toolchainDir || flags.toolchainDir)();
  if (toolchain) o.toolchainDir = toolchain;
  return o;
}
// Private channels: the same toolchain, unless privateExecution.toolchain is false. The scope re-validates it (fail closed).
function privateToolchainOptions(ctx) {
  var t = (ctx.privateToolchainDir || flags.privateToolchainDir)();
  return t ? { toolchainDir: t } : {};
}
function scopeOptions(ctx, vendor) { return Object.assign(scopeBaseOptions(ctx, vendor), credentialOptions(ctx, vendor)); }

// ---- resume and recap ------------------------------------------------------------------------------------------

function storeHas(dir, id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(id)) return false;
  var stack = [dir], seen = 0;
  while (stack.length && seen++ < 2000) {
    var d = stack.pop(), names;
    try { names = fs.readdirSync(d); } catch (_) { continue; }
    for (var i = 0; i < names.length; i++) {
      if (names[i].indexOf(id) !== -1) return true;
      try { if (fs.lstatSync(path.join(d, names[i])).isDirectory()) stack.push(path.join(d, names[i])); } catch (_) {}
    }
  }
  return false;
}
var RECAP_CHARS = 6000, RECAP_ITEM = 1200;
function clip(t, n) { t = String(t || "").replace(/\s+$/, ""); return t.length > n ? t.slice(0, n) + "..." : t; }
// Bounded recap from the room feed. Only AI-directed prompts (user_message) and the AI's answers (delta text) are used:
// Every other feed entry type (member chat, shared cards, tool output) is NEVER fed to the agent: room AI must not read them.
// Orchestration step prompts are internal and skipped.
function buildRecap(history) {
  var items = [], answer = "";
  function flush() { if (answer.trim()) items.push("AI: " + clip(answer, RECAP_ITEM)); answer = ""; }
  (Array.isArray(history) ? history : []).forEach(function (h) {
    if (!h || typeof h !== "object") return;
    // A request still pending a routing decision, or cancelled/denied/failed before it started, never ran: not context.
    if (h.type === "user_message" && h._exec !== undefined && h._exec !== "dispatched") return;
    if (h.type === "user_message" && typeof h.text === "string" && !h.orchestration) { flush(); items.push("사용자: " + clip(h.text, RECAP_ITEM)); }
    else if (h.type === "delta" && typeof h.text === "string") answer += h.text;
    else if (h.type === "done") flush();
  });
  flush();
  var out = [], total = 0;
  for (var i = items.length - 1; i >= 0 && total + items[i].length < RECAP_CHARS; i--) { out.unshift(items[i]); total += items[i].length; }
  return out.length ? "[이전 대화 요약 - 컨텍스트 참고용]\n" + out.join("\n") + "\n[요약 끝]\n\n" : "";
}
// Before the first contained turn: a resume id whose transcript is not in the room store cannot be resumed (the old
// unconfined transcript is invisible in the sandbox). Returns { resumeSessionId, recap }.
function resumeFor(session, vendor, baseDir) {
  var id = session.cliSessionId;
  if (!id || (session.hidden && !session.roomVendorMain)) return { resumeSessionId: undefined, recap: "" };
  var dir = scopes.privateStatePath({ actorId: "room", channelId: session.roomId, baseDir: baseDir }, vendor);
  if (dir && storeHas(dir, id)) return { resumeSessionId: id, recap: "" };
  return { resumeSessionId: undefined, recap: buildRecap(session.history) };
}

module.exports = { isRoomContext: isRoomContext, isContained: isContained, messageFor: messageFor, adminHintFor: adminHintFor, failReasonOf: failReasonOf, isAdminActor: isAdminActor, authorize: authorize,
  scopeOptions: scopeOptions, scopeBaseOptions: scopeBaseOptions, privateToolchainOptions: privateToolchainOptions, prepareCredential: prepareCredential, closeWithScope: closeWithScope, credentialOptions: credentialOptions,    buildRecap: buildRecap, resumeFor: resumeFor, MESSAGES: MESSAGES };

return module.exports;
});

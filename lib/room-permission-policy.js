"use strict";
// room-permission-policy.js - who may decide, and what is auto-allowed, for a contained room turn
// (room context + roomExecution ON). Unconfined paths never call this module.
//
// Auto-allow: read-only workspace-confined Bash (room-bash-policy.js) and file tools whose target resolves (symlinks and ".." followed) inside the room scope workspace.
// Everything else asks: other Bash, WebFetch, WebSearch, MCP and unknown tools, and any path outside the workspace.
// 443 egress is open, so anything that can run code or fetch a URL stays behind an approval.
var fs = require("fs");
var path = require("path");

// tool -> input field holding the target path; optional=true means "no path" = the workspace (cwd).
var FILE_TOOLS = {
  Read: { field: "file_path" }, Write: { field: "file_path" }, Edit: { field: "file_path" }, MultiEdit: { field: "file_path" },
  NotebookEdit: { field: "notebook_path" },
  Glob: { field: "path", optional: true, glob: "pattern" }, Grep: { field: "path", optional: true, glob: "glob" },
  LS: { field: "path" },
};

// realpath of `target` even when its tail does not exist yet; null when a dangling symlink is in the way.
function resolveReal(target) {
  var rest = [], cur = target;
  for (;;) {
    try { return path.join.apply(null, [fs.realpathSync(cur)].concat(rest)); }
    catch (e) {
      var st = null;
      try { st = fs.lstatSync(cur); } catch (_) {}
      if (st && st.isSymbolicLink()) return null;          // dangling link: its target is unknown
      var parent = path.dirname(cur);
      if (parent === cur) return null;
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

function inside(root, p) { return p === root || p.indexOf(root.endsWith(path.sep) ? root : root + path.sep) === 0; }

// A glob/pattern must not reach out of the workspace: absolute or containing a ".." segment asks.
function patternEscapes(p) { return typeof p === "string" && (path.isAbsolute(p) || /(^|[\\/])\.\.([\\/]|$)/.test(p)); }

// Bash: auto-allowed only when provably read-only and confined to the workspace (see room-bash-policy.js).
function autoAllow(toolName, input, workspace, opts) {
  if (toolName === "Bash") {
    return !!input && typeof input === "object" && typeof input.command === "string" &&
      require("./room-bash-policy").readOnlyInWorkspace(input.command, workspace, opts).allow;
  }
  // Codex fileChange approval: input.paths lists every touched path (source and move destination); all must be inside.
  if (toolName === "Edit" && input && Array.isArray(input.paths)) {
    return input.paths.length > 0 && input.paths.every(function (p) { return typeof p === "string" && p !== "" && autoAllow("Edit", { file_path: p }, workspace, opts); });
  }
  var spec = Object.prototype.hasOwnProperty.call(FILE_TOOLS, toolName) ? FILE_TOOLS[toolName] : null;
  if (!spec || typeof workspace !== "string" || !path.isAbsolute(workspace) || !input || typeof input !== "object") return false;
  var root;
  try { root = fs.realpathSync(workspace); } catch (_) { return false; }
  var raw = input[spec.field];
  if (raw == null || raw === "") { if (!spec.optional) return false; raw = "."; }
  if (typeof raw !== "string" || raw.indexOf("\0") !== -1) return false;
  if (spec.glob && patternEscapes(input[spec.glob])) return false;
  var real = resolveReal(path.resolve(root, raw));
  return !!real && inside(root, real);
}

// Only an admin (user.role === "admin") decides a contained turn's permission, whoever asked for the turn.
// A room owner who is not an admin cannot.
// With the room's requesterCanApprove ON (snapshot on the pending entry), the member who sent the turn's instruction may too.
function canDecide(usersModule, user, session, pending) {
  if (!user || typeof user.id !== "string" || !session || typeof session.roomId !== "string") return false;
  if (user.role === "admin") return true;
  return !!pending && pending.requesterCanApprove === true && typeof pending.requesterId === "string" && pending.requesterId === user.id;
}

// One authorization decision for resolving a pending permission, shared by the WebSocket and HTTP paths so the two cannot drift.
// `contained` = the session runs on the contained room path (caller computes it). `access` = project argument for canAccessSession.
// Returns { ok, gated }. Gated requests (snapshot on the pending entry, private channel, contained room) are admin-only
// (requester only with requesterCanApprove); no identity cannot decide a gated request.
function authorizeResolve(o) {
  var usersModule = o.usersModule, user = o.user, session = o.session, pending = o.pending;
  var bound = !!session && Object.prototype.hasOwnProperty.call(session, "channelId") && session.channelId !== undefined && session.channelId !== null;
  var gated = !!(pending && pending.gated) || bound || !!o.contained;
  if (!user) return { ok: !gated, gated: gated };
  var ok;
  try {
    if (bound) ok = canDecide(usersModule, user, session);
    else if (!usersModule.canAccessSession(user.id, session, o.access || { visibility: "public" })) ok = false;
    else if (gated) ok = canDecide(usersModule, user, session, pending);
    else ok = session.ownerId === user.id || user.role === "admin" || canDecide(usersModule, user, session);
  } catch (_) { ok = false; }  // iron-laws: ignore[IL-301] fail-closed permission policy; any failure denies (ok=false)
  return { ok: ok === true, gated: gated };
}

// Stop of a contained room turn: its requester, the room owner or an admin (stopping is not approving).
function canStop(usersModule, user, session) {
  if (!user || typeof user.id !== "string") return false;
  var requester = session && (session._privateWorkOwnerId || session.ownerId);
  if (user.id === requester || canDecide(usersModule, user, session)) return true;
  try { return !!session && usersModule.getRoomRole(user.id, session.roomId) === "owner"; } catch (_) { return false; }
}

module.exports = { autoAllow: autoAllow, canDecide: canDecide, authorizeResolve: authorizeResolve, canStop: canStop };

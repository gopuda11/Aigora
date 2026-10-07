module.exports = require("../extensions").select("orchestration/room-work", function () {
var module = { exports: {} };
"use strict";
// write runs hold the room's one persistent workspace exactly like a Claude/Codex room turn does.
//
//   openRoomWork({ roomId, agent, actorId, turnFiles, signal, ... }) -> { workspace, scope, note, finish(), abort() }
//
// 1. wait (bounded, Stop-cancellable) until no contained turn / other worker holds the workspace; idle Claude/Codex handles are closed
// 2. prepare the room scope (lock, realpath checks, room cap, probe) - fails closed with room-execution.messageFor(reason)
// 3. back up the workspace (snapshot, kind "turn"), keep a private copy of the instruction files, fill the inbox
// 4. finish(): revert instruction files (a failed revert publishes nothing), publish outbox files as cards, empty the inbox, release the scope
//    abort(): the same cleanup without publishing. Both must be called after the run's processes have ended; both are idempotent.
//
// Errors are Error objects with .code: "aborted" (Stop during the wait), "wait_timeout", "launch_refused" (launchError returned text),
// "scope_unavailable" (+ .reason, .userMessage), "snapshot_failed" (instruction files could not be backed up), "invalid_agent".
var fs = require("fs");
var path = require("path");
var crypto = require("crypto");

var SCOPE_AGENT = {  endpoint: "endpoint", local: "endpoint" };
var BACKUP_MAX_BYTES = 8 * 1024 * 1024;

function coded(code, message, extra) { var e = new Error(message || code); e.code = code; return Object.assign(e, extra || {}); }
function sleep(ms, signal) {
  return new Promise(function (resolve) {
    var t = setTimeout(done, ms);
    function done() { clearTimeout(t); if (signal) signal.removeEventListener("abort", done); resolve(); }
    if (signal) signal.addEventListener("abort", done, { once: true });
  });
}
function treeBytes(p, limit) {
  var total = 0, stack = [p];
  while (stack.length) {
    var cur = stack.pop(), st;
    try { st = fs.lstatSync(cur); } catch (_) { continue; }
    total += st.size;
    if (total > limit) return total;
    if (st.isDirectory()) { try { fs.readdirSync(cur).forEach(function (n) { stack.push(path.join(cur, n)); }); } catch (_) {} }
  }
  return total;
}

function symlinkTarget(p) { try { return fs.lstatSync(p).isSymbolicLink() ? fs.readlinkSync(p) : null; } catch (_) { return null; } }
// True when a directory tree holds anything but plain files and directories (the revert copies back plain entries only).
function hasUnrestorable(p) {
  var stack = [p];
  while (stack.length) {
    var cur = stack.pop(), st;
    try { st = fs.lstatSync(cur); } catch (_) { return true; }
    if (st.isDirectory()) { try { fs.readdirSync(cur).forEach(function (n) { stack.push(path.join(cur, n)); }); } catch (_) { return true; } }
    else if (!st.isFile()) return true;
  }
  return false;
}

function createRoomWork(deps) {
  deps = deps || {};
  function mod(name, fallback) { return deps[name] || fallback(); }
  var scopes = function () { return mod("scopes", function () { return require("../private-agent-scope"); }); };
  var flags = function () { return mod("flags", function () { return require("../room-execution-flags"); }); };
  var roomExec = function () { return mod("roomExec", function () { return require("../room-execution"); }); };
  var snapshots = function () { return mod("snapshots", function () { return require("../workspace-snapshots").sharedSnapshots(); }); };
  var inbox = function () { return mod("inbox", function () { return require("../attachment-ai").sharedInbox(); }); };
  var instructions = function () { return mod("instructions", function () { return require("./instruction-files"); }); };
  var auditLog = function (action, ctx) { try { (deps.audit || require("../audit").log)(action, ctx); } catch (_) {} };
  function findUser(id) { try { return (deps.findUser || require("../users").findUserById)(id); } catch (_) { return null; } }

  //    sdk ({ prepareRoomWorkspace(roomId), roomWorkspaceBusy(roomId) }; default: the one given to setSdk),
  //    postCard(entry) (called by finish() for each attachment_card / ai_result_files entry), onWait() (once, when the wait starts),
  //    launchError() -> string|null (actor re-check, called after the wait), label / runId / agentName (audit + card text),
  //    waitMs (default 600000), pollMs (default 2000)
  async function openRoomWork(o) {
    o = o || {};
    var scopeAgent = Object.prototype.hasOwnProperty.call(SCOPE_AGENT, o.agent) ? SCOPE_AGENT[o.agent] : null;
    if (!scopeAgent || typeof o.roomId !== "string" || !o.roomId) throw coded("invalid_agent");
    var sdk = o.sdk || deps.sdk || null;
    var signal = o.signal || null;
    var pollMs = Number.isInteger(o.pollMs) && o.pollMs > 0 ? o.pollMs : 2000;
    var deadline = Date.now() + (Number.isInteger(o.waitMs) && o.waitMs >= 0 ? o.waitMs : 600000);
    var snaps = snapshots(), workspacePath = snaps.workspaceOf(o.roomId);
    function live() { try { return !!workspacePath && scopes().isWorkspaceLive(workspacePath); } catch (_) { return true; } }
    function busy() { try { return !!(sdk && sdk.roomWorkspaceBusy && sdk.roomWorkspaceBusy(o.roomId)); } catch (_) { return true; } }

    var scope = null, waited = false;
    for (;;) {
      if (signal && signal.aborted) throw coded("aborted");
      if (Date.now() > deadline) throw coded("wait_timeout");
      var holding = busy();
      if (!holding) {
        // Nothing is processing: end idle Claude/Codex handles of the room first (they hold a live scope), then look at what is left.
        try { if (sdk && sdk.prepareRoomWorkspace) await sdk.prepareRoomWorkspace(o.roomId); } catch (_) {}
        holding = live();
      }
      if (holding) {
        if (!waited) { waited = true; try { if (o.onWait) o.onWait(); } catch (_) {} }
        await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())), signal);
        continue;
      }
      if (signal && signal.aborted) throw coded("aborted");
      if (typeof o.launchError === "function") {
        var le = await o.launchError();
        if (le) throw coded("launch_refused", typeof le === "string" ? le : "launch_refused");
      }
      var sc = scopes();
      // deps.scopeOptions (tests: baseDir, home, env...) go first so nothing configurable can weaken the fixed options below.
      var prepared = await sc.preparePrivateAgentScope(Object.assign({}, deps.scopeOptions, {
        agent: scopeAgent, actorId: "room", roomId: o.roomId, channelId: o.roomId, rootSessionId: "work-" + crypto.randomBytes(6).toString("hex"),
        isEnabled: flags().isRoomExecutionEnabled, capGroup: "room", maxConcurrent: flags().maxRoomConcurrent(), probeMaxAgeMs: 0,
        persistentWorkspace: true, injectEnv: {}, credentialMode: "api_key",
      }));
      if (prepared.ready) { scope = prepared; break; }
      // Lost a race for the workspace (another worker took it between the check and the prepare): wait again.
      if (prepared.reason === "resource_limit_reached" && live()) continue;
      throw coded("scope_unavailable", prepared.reason, { reason: prepared.reason, userMessage: roomExec().messageFor(prepared.reason) });
    }

    var workspace = scope.workspace, closed = null, backupDir = null, snapId = null, links = null, filesDir = null;
    function release() { try { if (scope.cleanup() === false) console.error("[room-work] scope cleanup incomplete"); } catch (_) {} }
    function dropBackup() { if (backupDir) { try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch (_) {} backupDir = null; } }
    try {
      if (signal && signal.aborted) throw coded("aborted");
      var actor = findUser(o.actorId), name = (actor && ((actor.profile && actor.profile.name) || actor.displayName || actor.username)) || "";
      var snap = snaps.take(o.roomId, { actorId: o.actorId || null, actorName: name, preview: o.label || "", kind: "turn" });
      snapId = snap && snap.id || null;
      // A private copy of the instruction files, outside the workspace, so a revert can always restore (the snapshot may be skipped).
      backupDir = fs.mkdtempSync(path.join(path.dirname(workspace), ".instr-backup-"));
      filesDir = path.join(backupDir, "files");
      links = Object.create(null);
      fs.mkdirSync(filesDir, { mode: 0o700 });
      instructions().INSTRUCTION_FILES.forEach(function (n) {
        var src = path.join(workspace, n), st = null;
        try { st = fs.lstatSync(src); } catch (_) { return; }
        if (st.isSymbolicLink()) { // by metadata, never followed
          try { links[n] = fs.readlinkSync(src); } catch (_) { throw coded("snapshot_failed", "instruction link cannot be read: " + n); }
          return;
        }
        if (hasUnrestorable(src)) throw coded("snapshot_failed", "instruction file holds a link or special file that cannot be restored: " + n);
        if (treeBytes(src, BACKUP_MAX_BYTES) > BACKUP_MAX_BYTES) throw coded("snapshot_failed", "instruction file too large to back up: " + n);
        fs.cpSync(src, path.join(filesDir, n), { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true });
      });
      var started = inbox().turnStart({ roomId: o.roomId }, workspace, o.turnFiles || []);
      auditLog("room.worker.write.start", { actorId: o.actorId || null, target: o.roomId,
        metadata: { agent: o.agent, label: o.label || null, runId: o.runId || null, snapshot: snapId } });
    } catch (e) {
      try { inbox().emptyInbox(workspace); } catch (_) {}
      dropBackup(); release();
      throw e;
    }

    function revert() {
      var r;
      var before = {};
      Object.keys(links).forEach(function (n) { before[n] = symlinkTarget(path.join(workspace, n)); });
      try { r = instructions().revertInstructionFiles(workspace, { filesDir: filesDir }); } catch (_) { r = { changed: [], restored: [], removed: [], failed: instructions().INSTRUCTION_FILES.slice() }; }
      // The shared revert treats every symlink as planted; put the original links back and do not report an unchanged one.
      Object.keys(links).forEach(function (n) {
        var p = path.join(workspace, n), unchanged = before[n] === links[n];
        try {
          if (symlinkTarget(p) !== links[n]) { fs.rmSync(p, { recursive: true, force: true }); fs.symlinkSync(links[n], p); }
          if (symlinkTarget(p) !== links[n]) throw new Error("link not restored");
          r.failed = r.failed.filter(function (x) { return x !== n; });
        } catch (_) { if (r.failed.indexOf(n) === -1) r.failed.push(n); return; }
        [r.changed, r.removed, r.restored].forEach(function (a) { var i = a.indexOf(n); if (i !== -1) a.splice(i, 1); });
        if (!unchanged) { r.changed.push(n); r.restored.push(n); }
      });
      if (r.changed && r.changed.length) {
        auditLog("room.worker.instruction_revert", { actorId: o.actorId || null, target: o.roomId,
          metadata: { agent: o.agent, runId: o.runId || null, changed: r.changed, restored: r.restored, removed: r.removed, failed: r.failed } });
      }
      return r;
    }
    function cleanupAll() {
      try { inbox().emptyInbox(workspace); } catch (_) {}
      dropBackup();
      release();
    }
    function cardOf(dto) {
      var u = findUser(dto.uploaderId), p = (u && u.profile) || {};
      return { type: "attachment_card", attachmentId: dto.id, scope: dto.kind, roomId: dto.roomId, channelId: dto.channelId,
        name: dto.name, ext: dto.ext, size: dto.size, version: dto.version, mediaType: dto.mediaType, fileType: dto.type,
        authorId: dto.uploaderId, authorName: p.name || (u && (u.displayName || u.username)) || "알 수 없음",
        aiMade: true, agentName: typeof o.agentName === "string" ? o.agentName : (o.label || ""), _ts: dto.createdAt, _mid: "att-" + dto.id };
    }

    // -> { ok, files: [names], skipped, revert, error? }. ok:false with error "instruction_revert_failed" = nothing was published.
    async function finish() {
      if (closed) return closed;
      var res = { ok: true, files: [], skipped: [], revert: null };
      closed = res;
      try {
        res.revert = revert();
        if (res.revert.failed.length) { res.ok = false; res.error = "instruction_revert_failed"; return res; }
        var r = inbox().collectResults({ roomId: o.roomId }, workspace, o.actorId);
        if (r) {
          var entries = r.files.map(cardOf);
          if (r.skipped.length) entries.push({ type: "ai_result_files", resultId: crypto.randomBytes(16).toString("hex"), scope: "room", roomId: o.roomId, files: [], skipped: r.skipped, _ts: Date.now() });
          entries.forEach(function (e) { try { if (typeof o.postCard === "function") o.postCard(e); } catch (_) { /* the file stands without its card */ } });
          res.files = r.files.map(function (d) { return d.name; });
          res.skipped = r.skipped;
          if (res.files.length || res.skipped.length) auditLog("room.worker.write.files", { actorId: o.actorId || null, target: o.roomId,
            metadata: { agent: o.agent, runId: o.runId || null, files: res.files.slice(0, 20), skipped: res.skipped.length } });
        }
      } catch (e) { res.ok = false; res.error = "publish_failed"; }
      finally { cleanupAll(); }
      return res;
    }
    // Stop / timeout / error: partial writes stay (the snapshot restores them), nothing is published.
    async function abort() {
      if (closed) return closed;
      var res = { ok: true, files: [], skipped: [], revert: null };
      closed = res;
      try { res.revert = revert(); if (res.revert.failed.length) { res.ok = false; res.error = "instruction_revert_failed"; } }
      finally { cleanupAll(); }
      return res;
    }
    return { workspace: workspace, scope: scope, note: started && started.note || "", snapshot: snapId, waited: waited, finish: finish, abort: abort };
  }
  return { openRoomWork: openRoomWork };
}

var shared = null, sdkRef = null;
function sharedRoomWork() { return shared || (shared = createRoomWork({ get sdk() { return sdkRef; } })); }
module.exports = {
  createRoomWork: createRoomWork,
  // T5 wiring: the sdk-bridge instance ({ prepareRoomWorkspace(roomId), roomWorkspaceBusy(roomId) }).
  setSdk: function (sdk) { sdkRef = sdk || null; },
  openRoomWork: function (o) { return sharedRoomWork().openRoomWork(o); },
};

return module.exports;
});

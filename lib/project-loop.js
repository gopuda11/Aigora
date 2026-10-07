var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var { execFileSync } = require("child_process");
var { createLoopRegistry } = require("./scheduler");
var store = require("./store");
var usersModule = require("./users");
var { createPrivateSessionAccess } = require("./private-session-access");
var authzGate = require("./authz-gate");
var { writeHandoff, buildHandoffPreamble } = require("./loop-handoff");

var LOOP_ID_RE = /^loop_[A-Za-z0-9_-]+$/;

// lr-7025: pendingUserMessages is unbounded — handleLoopMessage() pushed to
// it with no cap on queue length or per-message size, and saveLoopState()
// persists the growing array to disk on every push. These caps bound both
// in-memory growth and the on-disk state file. Chosen policy: reject (not
// drop-oldest) once the queue is full, so a caller retrying doesn't silently
// lose an earlier message the loop hasn't seen yet.
var LOOP_MESSAGE_MAX_QUEUE_LENGTH = 20;
var LOOP_MESSAGE_MAX_TEXT_LENGTH = 4000;

/**
 * Validate a loop ID before using it as a path component.
 *
 * Returns true if the id passes the allowlist regex.
 * Returns false for any value that could enable path traversal or injection.
 * All handlers that build a loop directory path from a user-supplied value
 * must route through this function before any path.join / path.resolve call.
 */
function validateLoopId(id) {
  return LOOP_ID_RE.test(id || "");
}

/**
 * Attach loop engine to a project context.
 *
 * ctx fields:
 *   cwd, slug, sm, sdk, clients, send, sendTo, sendToSession, pushModule,
 *   getHubSchedules, getAllProjectSessions, getSessionUnread, getStatus,
 *   getLinuxUserForSession, onProcessingChanged,
 *   hydrateImageRefs
 */
function attachLoop(ctx) {
  var cwd = ctx.cwd;
  var slug = ctx.slug;
  var sm = ctx.sm;
  var clients = ctx.clients || [];
  var sdk = ctx.sdk;
  var send = ctx.send;
  var sendTo = ctx.sendTo;
  var sendToSession = ctx.sendToSession;
  var pushModule = ctx.pushModule;
  var notificationsModule = ctx.notificationsModule;
  var getHubSchedules = ctx.getHubSchedules;
  var getAllProjectSessions = ctx.getAllProjectSessions;
  // lr-0aa7b6: per-session unread lookup — (ws, sessionProjectSlug, localId) => count.
  var getSessionUnread = ctx.getSessionUnread || function () { return 0; };
  var getStatus = ctx.getStatus;
  var getLinuxUserForSession = ctx.getLinuxUserForSession;
  var onProcessingChanged = ctx.onProcessingChanged;
  var hydrateImageRefs = ctx.hydrateImageRefs;

  // --- Ralph Loop state ---
  var loopState = {
    active: false,
    phase: "idle", // idle | crafting | approval | executing | done
    promptText: "",
    judgeText: "",
    iteration: 0,
    maxIterations: 20,
    baseCommit: null,
    currentSessionId: null,
    judgeSessionId: null,
    results: [],
    stopping: false,
    wizardData: null,
    craftingSessionId: null,
    startedAt: null,
    loopId: null,
    loopFilesId: null,
    // Monotonic counter incremented each time startLoop() runs.
    // Lets stopLoop() snapshot the identity at stop-time and guard its
    // fallback timer against a concurrently restarted loop. (lr-e823)
    _loopSeq: 0,
    // Human messages sent while an iteration is in flight, queued for
    // delivery at the next iteration boundary (lr-e31b). Each entry:
    // { text, from, fromName, ts }. Cleared once consumed by
    // runNextIteration(), and on stop/finish so nothing leaks into a
    // future run.
    pendingUserMessages: [],
  };

  function loopDir() {
    var id = loopState.loopFilesId || loopState.loopId;
    if (!id) return null;
    return path.join(cwd, ".claude", "loops", id);
  }

  function generateLoopId() {
    return "loop_" + Date.now() + "_" + crypto.randomBytes(3).toString("hex");
  }

  // Loop state persistence
  var _loopConfig = require("./config");
  var _loopUtils = require("./utils");
  var _loopDir = path.join(_loopConfig.CONFIG_DIR, "loops");
  var _loopEncodedCwd = _loopUtils.resolveEncodedFile(_loopDir, cwd, ".json");
  var _loopStatePath = path.join(_loopDir, _loopEncodedCwd + ".json");

  function saveLoopState() {
    // Async atomic write through store.js (queued per path, 0o600). Fire-and-forget.
    var data = {
      phase: loopState.phase,
      active: loopState.active,
      iteration: loopState.iteration,
      maxIterations: loopState.maxIterations,
      baseCommit: loopState.baseCommit,
      results: loopState.results,
      wizardData: loopState.wizardData,
      startedAt: loopState.startedAt,
      loopId: loopState.loopId,
      loopFilesId: loopState.loopFilesId || null,
      pendingUserMessages: loopState.pendingUserMessages || [],
    };
    store.writeJsonAt(_loopStatePath, data).catch(function (err) {
      console.error("[ralph-loop] Failed to save state:", err && err.message ? err.message : err);
    });
  }

  function loadLoopState() {
    try {
      var raw = fs.readFileSync(_loopStatePath, "utf8");
      var data = JSON.parse(raw);
      loopState.phase = data.phase || "idle";
      loopState.active = data.active || false;
      loopState.iteration = data.iteration || 0;
      loopState.maxIterations = data.maxIterations || 20;
      loopState.baseCommit = data.baseCommit || null;
      loopState.results = data.results || [];
      loopState.wizardData = data.wizardData || null;
      loopState.startedAt = data.startedAt || null;
      loopState.loopId = data.loopId || null;
      loopState.loopFilesId = data.loopFilesId || null;
      loopState.pendingUserMessages = Array.isArray(data.pendingUserMessages) ? data.pendingUserMessages : [];
      // SDK sessions cannot survive daemon restart
      loopState.currentSessionId = null;
      loopState.judgeSessionId = null;
      loopState.craftingSessionId = null;
      loopState.stopping = false;
      // If was executing, schedule resume after SDK is ready
      if (loopState.phase === "executing" && loopState.active) {
        loopState._needsResume = true;
      }
      // If was crafting, check if files exist and move to approval
      if (loopState.phase === "crafting") {
        var hasFiles = checkLoopFilesExist();
        if (hasFiles) {
          loopState.phase = "approval";
          saveLoopState();
        } else {
          loopState.phase = "idle";
          saveLoopState();
        }
      }
    } catch (e) {
      // No saved state, use defaults
    }
    // Recover orphaned loops: if idle but completed loop files exist in .claude/loops/
    if (loopState.phase === "idle") {
      var _loopsBase = path.join(cwd, ".claude", "loops");
      try {
        var _loopDirs = fs.readdirSync(_loopsBase).filter(function (d) {
          return d.indexOf("loop_") === 0;
        });
        for (var _li = 0; _li < _loopDirs.length; _li++) {
          var _ld = path.join(_loopsBase, _loopDirs[_li]);
          try {
            fs.accessSync(path.join(_ld, "PROMPT.md"));
            fs.accessSync(path.join(_ld, "LOOP.json"));
            var _loopCfg = JSON.parse(fs.readFileSync(path.join(_ld, "LOOP.json"), "utf8"));
            var _isSimple = _loopCfg.loopMode === "simple";
            if (!_isSimple) fs.accessSync(path.join(_ld, "JUDGE.md"));
            // Found a completed loop — recover to approval phase
            loopState.loopId = _loopDirs[_li];
            loopState.phase = "approval";
            loopState.maxIterations = _loopCfg.maxIterations || 20;
            if (!loopState.wizardData) loopState.wizardData = {};
            loopState.wizardData.loopMode = _loopCfg.loopMode || "judge";
            saveLoopState();
            console.log("[ralph-loop] Recovered orphaned loop: " + _loopDirs[_li]);
            break;
          } catch (e) {}
        }
      } catch (e) {}
    }
  }

  function clearLoopState() {
    loopState.active = false;
    loopState.phase = "idle";
    loopState.promptText = "";
    loopState.judgeText = "";
    loopState.iteration = 0;
    loopState.maxIterations = 20;
    loopState.baseCommit = null;
    loopState.currentSessionId = null;
    loopState.judgeSessionId = null;
    loopState.results = [];
    loopState.stopping = false;
    loopState.wizardData = null;
    loopState.craftingSessionId = null;
    loopState.startedAt = null;
    loopState.loopId = null;
    loopState.loopFilesId = null;
    loopState.pendingUserMessages = [];
    saveLoopState();
  }

  function checkLoopFilesExist() {
    var dir = loopDir();
    if (!dir) return false;
    var hasPrompt = false;
    var hasJudge = false;
    try { fs.accessSync(path.join(dir, "PROMPT.md")); hasPrompt = true; } catch (e) {}
    try { fs.accessSync(path.join(dir, "JUDGE.md")); hasJudge = true; } catch (e) {}
    var isSimple = loopState.wizardData && loopState.wizardData.loopMode === "simple";
    return isSimple ? hasPrompt : (hasPrompt && hasJudge);
  }

  // .claude/ directory watcher for PROMPT.md / JUDGE.md
  var claudeDirWatcher = null;
  var claudeDirDebounce = null;

  function startClaudeDirWatch() {
    if (claudeDirWatcher) return;
    var watchDir = loopDir();
    if (!watchDir) return;
    try { fs.mkdirSync(watchDir, { recursive: true }); } catch (e) {}
    try {
      claudeDirWatcher = fs.watch(watchDir, function () {
        if (claudeDirDebounce) clearTimeout(claudeDirDebounce);
        claudeDirDebounce = setTimeout(function () {
          broadcastLoopFilesStatus();
        }, 300);
      });
      claudeDirWatcher.on("error", function () {});
    } catch (e) {
      console.error("[ralph-loop] Failed to watch .claude/:", e.message);
    }
  }

  function stopClaudeDirWatch() {
    if (claudeDirWatcher) {
      claudeDirWatcher.close();
      claudeDirWatcher = null;
    }
    if (claudeDirDebounce) {
      clearTimeout(claudeDirDebounce);
      claudeDirDebounce = null;
    }
  }

  function broadcastLoopFilesStatus() {
    var dir = loopDir();
    var hasPrompt = false;
    var hasJudge = false;
    var hasLoopJson = false;
    if (dir) {
      try { fs.accessSync(path.join(dir, "PROMPT.md")); hasPrompt = true; } catch (e) {}
      try { fs.accessSync(path.join(dir, "JUDGE.md")); hasJudge = true; } catch (e) {}
      try { fs.accessSync(path.join(dir, "LOOP.json")); hasLoopJson = true; } catch (e) {}
    }
    var isSimple = loopState.wizardData && loopState.wizardData.loopMode === "simple";
    var bothReady = isSimple ? hasPrompt : (hasPrompt && hasJudge);
    send({
      type: "ralph_files_status",
      promptReady: hasPrompt,
      judgeReady: hasJudge,
      loopJsonReady: hasLoopJson,
      bothReady: bothReady,
      taskId: loopState.loopId,
    });
    // Auto-transition to approval phase when files are ready
    if (bothReady && loopState.phase === "crafting") {
      loopState.phase = "approval";
      saveLoopState();

      // Parse recommended title from crafting session conversation
      // lr-2ea2a7: backward scan over the heap tail — crafting sessions are
      // short single-turn conversations that never approach HISTORY_INMEM_MAX,
      // so this always sees the full conversation; tolerant of a trimmed head
      // regardless (a title marker in trimmed content would just not be found).
      if (loopState.craftingSessionId && loopState.loopId) {
        var craftSess = sm.sessions.get(loopState.craftingSessionId);
        if (craftSess && craftSess.history) {
          for (var hi = craftSess.history.length - 1; hi >= 0; hi--) {
            var entry = craftSess.history[hi];
            var entryText = entry.text || "";
            var titleMatch = entryText.match(/\[\[LOOP_TITLE:\s*(.+?)\]\]/);
            if (titleMatch) {
              var suggestedTitle = titleMatch[1].trim();
              if (suggestedTitle) {
                loopRegistry.updateRecord(loopState.loopId, { name: suggestedTitle });
              }
              break;
            }
          }
        }
      }
    }
  }

  // Load persisted state on startup
  loadLoopState();

  // --- Loop Registry (unified one-off + scheduled) ---
  var activeRegistryId = null; // track which registry record triggered current loop
  var pendingTriggers = []; // queue for deferred triggers when skipIfRunning=false

  function triggerFromQueue(record) {
    if (skipPrivateTrigger(record)) return;
    // For schedule records, resolve the linked task to get loop files
    var loopFilesId = record.id;
    if (record.source === "schedule") {
      if (!record.linkedTaskId) {
        console.error("[loop-registry] Schedule has no linked task: " + record.name);
        return;
      }
      loopFilesId = record.linkedTaskId;
      console.log("[loop-registry] Schedule triggered: " + record.name + " -> linked task " + loopFilesId);
    }

    // Validate the loop ID before using it as a path component (path traversal guard).
    // linkedTaskId flows from client-supplied sData.taskId via schedule_create.
    if (!validateLoopId(loopFilesId)) {
      console.error("[loop-registry] Invalid loop ID rejected: " + loopFilesId);
      return;
    }

    // Verify the loop directory and PROMPT.md exist
    var recDir = path.join(cwd, ".claude", "loops", loopFilesId);
    try {
      fs.accessSync(path.join(recDir, "PROMPT.md"));
    } catch (e) {
      console.error("[loop-registry] PROMPT.md missing for " + loopFilesId);
      return;
    }
    // Set the loopId to the schedule's own id (not the linked task) so sidebar groups correctly
    loopState.loopId = record.id;
    loopState.loopFilesId = loopFilesId;
    // Restore loopMode from LOOP.json so simple loops work correctly on trigger
    var _triggerCfg = {};
    try { _triggerCfg = JSON.parse(fs.readFileSync(path.join(recDir, "LOOP.json"), "utf8")); } catch (e) {}
    loopState.wizardData = { loopMode: _triggerCfg.loopMode || "judge" };
    activeRegistryId = record.id;
    console.log("[loop-registry] Auto-starting loop: " + record.name + " (" + loopState.loopId + ")");
    send({ type: "schedule_run_started", recordId: record.id });
    startLoop({ maxIterations: record.maxIterations, name: record.name });
  }

  // delete_loop_group guard. Any channel-bound participant (defined, non-null
  // channelId, even malformed) requires owner MUTATE on EVERY matching session
  // plus the global sessionDelete permission, all-or-nothing. Pure legacy
  // groups keep the old behavior. Dependency failures deny.
  function mayDeleteLoopGroup(ws, groupSessions) {
    var bound = groupSessions.some(function (s) {
      return Object.prototype.hasOwnProperty.call(s, "channelId") && s.channelId !== undefined && s.channelId !== null;
    });
    if (!bound) return true;
    try {
      var actor = ws && ws._aigoraUser;
      var perms = usersModule.getEffectivePermissions(actor, ctx.osUsers || false);
      if (!actor || !perms) return false;
      // A viewer in any of the group's rooms never deletes, even with global sessionDelete.
      if (groupSessions.some(function (s) { return s.roomId && usersModule.getRoomRole(actor.id, s.roomId) === "viewer"; })) return false;
      // Without global sessionDelete, a member may still delete a group made only of their own sessions
      // (same exception as delete_session); viewers never.
      if (!perms.sessionDelete && !groupSessions.every(function (s) {
        if (typeof actor.id !== "string" || !actor.id || s.ownerId !== actor.id) return false;
        if (!s.roomId) return true;
        var role = usersModule.getRoomRole(actor.id, s.roomId);
        return !!role && role !== "viewer";
      })) return false;
      var access = createPrivateSessionAccess(usersModule);
      for (var i = 0; i < groupSessions.length; i++) {
        access.assertSessionAction(actor, groupSessions[i], { visibility: "public" }, "mutate");
      }
      return true;
    } catch (e) { return false; }
  }

  // TEMPORARY bounded safety gate (not complete privacy): while private agent
  // execution/queue output scoping and provider isolation are unproven,
  // loop_start/loop_stop/loop_message/loop_message_remove are refused for
  // EVERYONE (owner/admin included) when any authoritative loop target is
  // channel-bound. Targets come only from server loop state (loopId,
  // current/judge/crafting session ids + sessions carrying that loopId),
  // never from the client msg or the ws viewing session. A referenced session
  // that is missing or belongs to another loop is ambiguous => deny.
  // Registry provenance also counts when no session carries the loopId.
  var LOOP_CONTROL_TYPES = { loop_start: 1, loop_stop: 1, loop_message: 1, loop_message_remove: 1 };
  var LOOP_CONTROL_DENIED_TEXT = "Loop controls are temporarily unavailable for this project";

  function isChannelBound(s) {
    return Object.prototype.hasOwnProperty.call(s, "channelId") && s.channelId !== undefined && s.channelId !== null;
  }

  function hasRegistryProvenance(record) {
    return !!record && ["channelId", "ownerId", "roomId"].some(function (key) {
      return Object.prototype.hasOwnProperty.call(record, key);
    });
  }

  function creationProvenance(ws) {
    var origin = sm.sessions.get(ws._aigoraActiveSession);
    if (!origin) {
      if (ws._aigoraActiveSession !== undefined && ws._aigoraActiveSession !== null) throw new Error("Forbidden");
      return null;
    }
    if (typeof origin !== "object" || Array.isArray(origin) || origin.localId !== ws._aigoraActiveSession) throw new Error("Forbidden");
    if (!isChannelBound(origin)) return null;
    createPrivateSessionAccess(usersModule).assertSessionAction(ws._aigoraUser, origin, { visibility: "public" }, "mutate");
    if (sm.validateChannelBinding(origin.channelId, origin.ownerId, origin.roomId, true)) throw new Error("Forbidden");
    return { channelId: origin.channelId, ownerId: origin.ownerId, roomId: origin.roomId };
  }

  function sendRegistryState(recId, obj) {
    for (var ws of clients) {
      if (ws.readyState !== 1 || registryAccessDenied(ws, recId, "read")) continue;
      try { sendTo(ws, obj); } catch (e) {}
    }
  }

  function refusePrivateExecution() {
    if (!loopControlsBlocked()) return false;
    sendRegistryState(loopState.loopId, { type: "loop_error", text: LOOP_CONTROL_DENIED_TEXT });
    return true;
  }

  function loopControlsBlocked() {
    try {
      var hasLoopId = loopState.loopId !== null && loopState.loopId !== undefined;
      var targets = [];
      if (hasLoopId && registryAccessDenied(null, loopState.loopId, "execute")) return true;
      if (hasLoopId) {
        sm.sessions.forEach(function (s) {
          if (s && s.loop && s.loop.loopId === loopState.loopId) targets.push(s);
        });
      }
      var refs = [loopState.currentSessionId, loopState.judgeSessionId, loopState.craftingSessionId];
      for (var i = 0; i < refs.length; i++) {
        if (refs[i] === null || refs[i] === undefined) continue;
        var ref = sm.sessions.get(refs[i]);
        if (!ref) return true;
        if (hasLoopId && !(ref.loop && ref.loop.loopId === loopState.loopId)) return true;
        targets.push(ref);
      }
      return targets.some(isChannelBound);
    } catch (e) { return true; }
  }

  // Registry read/mutation guard. The record id is the loopId, so the group is
  // every session carrying that loopId. Any channel-bound member (defined,
  // non-null channelId, even malformed) requires the actor's read (or owner
  // mutate) right on EVERY session of the group, all-or-nothing; "execute"
  // (rerun) is refused for everyone while private execution is unproven.
  // Record provenance adds a private target even after all sessions are deleted.
  // Groups and records without private provenance keep the old behavior.
  // The hub list also carries other projects' records; those are judged by their own provenance (foreignRecordDenied).
  function registryAccessDenied(ws, recId, action) {
    try {
      var group = [];
      sm.sessions.forEach(function (s) {
        if (s && s.loop && s.loop.loopId === recId) group.push(s);
      });
      var record = loopRegistry.getById(recId);
      var provenance = hasRegistryProvenance(record);
      if (!provenance && !group.some(isChannelBound)) return false;
      if (provenance) {
        if (typeof record.channelId !== "string" || !record.channelId) return true;
        group.push({ channelId: record.channelId, ownerId: record.ownerId, roomId: record.roomId, sessionVisibility: "private" });
      }
      if (action === "execute") return true;
      var actor = ws && ws._aigoraUser;
      var access = createPrivateSessionAccess(usersModule);
      for (var i = 0; i < group.length; i++) {
        access.assertSessionAction(actor, group[i], { visibility: "public" }, action);
      }
      return false;
    } catch (e) { return true; }
  }

  // File-content replies are answers to one requester. For a channel-bound group they go to that socket only;
  // legacy groups keep the old broadcast.
  function registryReply(ws, recId, obj) {
    var bound = hasRegistryProvenance(loopRegistry.getById(recId));
    try {
      sm.sessions.forEach(function (s) { if (s && s.loop && s.loop.loopId === recId && isChannelBound(s)) bound = true; });
    } catch (e) { bound = true; }
    if (bound) sendTo(ws, obj); else send(obj);
  }

  // Only for handlers that otherwise decide from sessions alone: a record's own provenance still gates them.
  function denyProvenance(ws, recId, action) {
    return hasRegistryProvenance(loopRegistry.getById(recId)) && denyRegistry(ws, recId, action);
  }

  function denyRegistry(ws, recId, action) {
    if (!registryAccessDenied(ws, recId, action)) return false;
    sendTo(ws, { type: "loop_registry_error", text: "Forbidden" });
    return true;
  }

  // A record of another project cannot be judged from this project's sessions, so its own provenance decides:
  // the actor must currently read the personal channel it names. Malformed provenance denies.
  function foreignRecordDenied(ws, r) {
    if (!hasRegistryProvenance(r)) return false;
    try {
      if (typeof r.channelId !== "string" || !r.channelId) return true;
      var actor = ws && ws._aigoraUser;
      return !createPrivateSessionAccess(usersModule).canReadSession(actor, { channelId: r.channelId, ownerId: r.ownerId, roomId: r.roomId, sessionVisibility: "private" }, { visibility: "public" });
    } catch (e) { return true; }
  }

  function filterRegistryRecords(ws, records) {
    return records.filter(function (r) {
      if (!r) return true;
      if (r.projectSlug !== undefined && r.projectSlug !== slug) return !foreignRecordDenied(ws, r);
      return !registryAccessDenied(ws, r.id, "read") && !foreignRecordDenied(ws, r);
    });
  }

  // Loops are unsupported in private channels (v1): a socket whose open session is channel-bound never starts or reruns one.
  function activeSessionIsPrivate(ws) {
    try {
      var origin = sm.sessions.get(ws._aigoraActiveSession);
      return !!origin && isChannelBound(origin);
    } catch (e) { return true; }
  }

  function broadcastRegistryUpdated() {
    var records = getHubSchedules();
    for (var ws of clients) {
      if (ws.readyState !== 1) continue;
      try { sendTo(ws, { type: "loop_registry_updated", records: filterRegistryRecords(ws, records) }); } catch (e) {}
    }
  }

  function skipPrivateTrigger(record) {
    // A schedule runs the files of its linked task, so that task's group counts too.
    var linked = record.source === "schedule" && record.linkedTaskId;
    if (!registryAccessDenied(null, record.id, "execute") && !(linked && registryAccessDenied(null, linked, "execute"))) return false;
    console.log("[loop-registry] Skipping trigger — private execution disabled");
    return true;
  }

  var loopRegistry = createLoopRegistry({
    cwd: cwd,
    onTrigger: function (record) {
      if (skipPrivateTrigger(record)) return;
      // Skip or queue trigger if a loop is already active
      if (loopState.active || loopState.phase === "executing") {
        if (record.skipIfRunning !== false) {
          console.log("[loop-registry] Skipping trigger for " + record.name + " — loop already active (skipIfRunning)");
          return;
        }
        console.log("[loop-registry] Loop active, queuing trigger for " + record.name);
        pendingTriggers.push(record);
        return;
      }

      triggerFromQueue(record);
    },
    onChange: function () {
      broadcastRegistryUpdated();
    },
  });
  loopRegistry.load();
  loopRegistry.startTimer();

  // Wire loop info resolution for session list broadcasts
  sm.setResolveLoopInfo(function (loopId) {
    var rec = loopRegistry.getById(loopId);
    if (!rec) return null;
    return { name: rec.name || null, source: rec.source || null };
  });

  function startLoop(opts) {
    if (refusePrivateExecution()) return;
    var loopOpts = opts || {};
    var dir = loopDir();
    if (!dir) {
      send({ type: "loop_error", text: "No loop directory. Run the wizard first." });
      return;
    }
    var promptPath = path.join(dir, "PROMPT.md");
    var judgePath = path.join(dir, "JUDGE.md");
    var promptText, judgeText;
    try {
      promptText = fs.readFileSync(promptPath, "utf8");
    } catch (e) {
      send({ type: "loop_error", text: "Missing PROMPT.md in " + dir });
      return;
    }
    try {
      judgeText = fs.readFileSync(judgePath, "utf8");
    } catch (e) {
      judgeText = null;
    }

    var baseCommit;
    try {
      baseCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: cwd, encoding: "utf8", timeout: 5000,
      }).trim();
    } catch (e) {
      send({ type: "loop_error", text: "Failed to get git HEAD: " + e.message });
      return;
    }

    // Read loop config from LOOP.json in loop directory
    var loopConfig = {};
    try {
      loopConfig = JSON.parse(fs.readFileSync(path.join(dir, "LOOP.json"), "utf8"));
    } catch (e) {}

    var isSimple = loopState.wizardData && loopState.wizardData.loopMode === "simple";
    loopState._loopSeq++;  // unique identity for this run; read by stopLoop() fallback guard (lr-e823)
    loopState.active = true;
    loopState.phase = "executing";
    loopState.promptText = promptText;
    loopState.judgeText = isSimple ? null : judgeText;
    loopState.iteration = 0;
    if (isSimple) {
      loopState.maxIterations = (loopOpts.maxIterations >= 1 ? loopOpts.maxIterations : null) || loopConfig.maxIterations || 5;
    } else {
      loopState.maxIterations = judgeText ? ((loopOpts.maxIterations >= 1 ? loopOpts.maxIterations : null) || loopConfig.maxIterations || 20) : 1;
    }
    loopState.baseCommit = baseCommit;
    loopState.currentSessionId = null;
    loopState.judgeSessionId = null;
    loopState.results = [];
    loopState.stopping = false;
    loopState.name = loopOpts.name || null;
    loopState.settings = loopConfig.settings || null;
    loopState.startedAt = Date.now();
    loopState.pendingUserMessages = [];
    saveLoopState();

    stopClaudeDirWatch();

    send({ type: "loop_started", maxIterations: loopState.maxIterations, name: loopState.name });
    runNextIteration();
  }

  function runNextIteration() {
    if (refusePrivateExecution()) return;
    console.log("[ralph-loop] runNextIteration called, iteration: " + loopState.iteration + ", active: " + loopState.active + ", stopping: " + loopState.stopping);
    if (!loopState.active || loopState.stopping) {
      finishLoop("stopped");
      return;
    }

    loopState.iteration++;
    if (loopState.iteration > loopState.maxIterations) {
      finishLoop("max_iterations");
      return;
    }

    var session = sm.createSession();
    var loopSource = loopRegistry.getById(loopState.loopId);
    var loopName = (loopState.wizardData && loopState.wizardData.name) || (loopSource && loopSource.name) || "";
    var loopSourceTag = (loopSource && loopSource.source) || null;
    var isRalphLoop = loopSourceTag === "ralph";
    session.loop = { active: true, iteration: loopState.iteration, role: "coder", loopId: loopState.loopId, name: loopName, source: loopSourceTag, startedAt: loopState.startedAt };
    session.title = (isRalphLoop ? "Ralph" : "Task") + (loopName ? " " + loopName : "") + " #" + loopState.iteration;
    sm.saveSessionFile(session);
    sm.broadcastSessionList();

    loopState.currentSessionId = session.localId;

    send({
      type: "loop_iteration",
      iteration: loopState.iteration,
      maxIterations: loopState.maxIterations,
      sessionId: session.localId,
    });

    var coderCompleted = false;
    session.onQueryComplete = function(completedSession) {
      if (coderCompleted) return;
      coderCompleted = true;
      if (coderWatchdog) { clearTimeout(coderWatchdog); coderWatchdog = null; }
      console.log("[ralph-loop] Coder #" + loopState.iteration + " onQueryComplete fired, history length: " + completedSession.history.length);
      if (!loopState.active) { console.log("[ralph-loop] Coder: loopState.active is false, skipping"); return; }
      // Check if session ended with error
      // lr-2ea2a7: slice(-3) on the heap tail — tolerant of a trimmed head by
      // construction (only ever wants the LAST 3 entries, which are always
      // in the retained tail window regardless of how much was trimmed).
      var lastItems = completedSession.history.slice(-3);
      var hadError = false;
      for (var i = 0; i < lastItems.length; i++) {
        if (lastItems[i].type === "error" || (lastItems[i].type === "done" && lastItems[i].code === 1)) {
          hadError = true;
          break;
        }
      }
      if (hadError) {
        loopState.results.push({
          iteration: loopState.iteration,
          verdict: "error",
          summary: "Iteration ended with error",
        });
        send({
          type: "loop_verdict",
          iteration: loopState.iteration,
          verdict: "error",
          summary: "Iteration ended with error, retrying...",
        });
        setTimeout(function() { runNextIteration(); }, 2000);
        return;
      }
      // lr-ed10: Write handoff-to-disk at the iteration boundary (opt-in).
      // writeHandoff is a no-op when compactHandoff is not enabled in loopSettings.
      writeHandoff({ loopState: loopState, session: completedSession, verdict: null });

      var _isSimple = loopState.wizardData && loopState.wizardData.loopMode === "simple";
      if (_isSimple) {
        // Simple mode: no judge, proceed to next iteration or finish
        if (loopState.iteration >= loopState.maxIterations) {
          finishLoop("complete");
        } else {
          setTimeout(function() { runNextIteration(); }, 1000);
        }
      } else if (loopState.judgeText && loopState.maxIterations > 1) {
        runJudge();
      } else {
        finishLoop("pass");
      }
    };

    // Watchdog: if onQueryComplete hasn't fired after 10 minutes, force error and retry
    var coderWatchdog = setTimeout(function() {
      if (!coderCompleted && loopState.active && !loopState.stopping) {
        console.error("[ralph-loop] Coder #" + loopState.iteration + " watchdog triggered — onQueryComplete never fired");
        coderCompleted = true;
        loopState.results.push({
          iteration: loopState.iteration,
          verdict: "error",
          summary: "Coder session timed out (no completion signal)",
        });
        send({
          type: "loop_verdict",
          iteration: loopState.iteration,
          verdict: "error",
          summary: "Coder session timed out, retrying...",
        });
        setTimeout(function() { runNextIteration(); }, 2000);
      }
    }, 10 * 60 * 1000);

    // lr-ed10: Prepend handoff preamble from prior iteration when compaction is enabled.
    // buildHandoffPreamble returns null on first iteration or when disabled — no-op.
    var _handoffPreamble = buildHandoffPreamble({ loopState: loopState });
    var _iterationPrompt = _handoffPreamble
      ? _handoffPreamble + loopState.promptText
      : loopState.promptText;

    // lr-e31b: Deliver human messages queued during the prior iteration at this
    // boundary. Ephemeral loop-iteration sessions are single-turn (their SDK
    // input stream is closed immediately after the first push — see
    // yoke/adapters/claude.js endInput()), so mid-flight injection into a live
    // iteration is not viable without a broader architecture change. Boundary
    // delivery reuses the same session.history / user_message path a normal
    // chat message takes, so the human's text is visible in the transcript and
    // the coder session actually reads it (folded into the iteration prompt).
    var _queuedMsgs = loopState.pendingUserMessages || [];
    if (_queuedMsgs.length > 0) {
      var _queuedBlock = ["## Message from user (sent during the previous iteration)", ""];
      for (var _qi = 0; _qi < _queuedMsgs.length; _qi++) {
        var _qm = _queuedMsgs[_qi];
        _queuedBlock.push(_qm.text);
        // Record as its own history entry so the transcript shows exactly what
        // the human sent and when, distinct from the coder's own prompt text.
        var _qUserMsg = { type: "user_message", text: _qm.text, _ts: _qm.ts || Date.now() };
        if (_qm.from) { _qUserMsg.from = _qm.from; _qUserMsg.fromName = _qm.fromName || ""; }
        // lr-2ea2a7: routes through the shared history-cap helper (see
        // grep-guard test) — Ralph/crew loop sessions are exactly the
        // long-running isProcessing sessions this fix bounds.
        sm.recordHistoryEntry(session, _qUserMsg, true);
        sm.appendToSessionFile(session, _qUserMsg);
      }
      _queuedBlock.push("", "---", "");
      _iterationPrompt = _queuedBlock.join("\n") + _iterationPrompt;
      loopState.pendingUserMessages = [];
      saveLoopState();
      send({ type: "loop_pending_messages", messages: [] });
    }

    var userMsg = { type: "user_message", text: _iterationPrompt };
    sm.recordHistoryEntry(session, userMsg, true);
    sm.appendToSessionFile(session, userMsg);

    session.isProcessing = true;
    onProcessingChanged();
    session.sentToolResults = {};
    sendToSession(session.localId, { type: "status", status: "processing" });
    session.acceptEditsAfterStart = true;
    session.singleTurn = true;
    if (loopState.settings) session.loopSettings = loopState.settings;
    sdk.startQuery(session, _iterationPrompt, undefined, getLinuxUserForSession(session));
  }

  function runJudge() {
    if (refusePrivateExecution()) return;
    if (!loopState.active || loopState.stopping) {
      finishLoop("stopped");
      return;
    }

    var diff;
    try {
      diff = execFileSync("git", ["diff", loopState.baseCommit], {
        cwd: cwd, encoding: "utf8", timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (e) {
      send({ type: "loop_error", text: "Failed to generate git diff: " + e.message });
      finishLoop("error");
      return;
    }

    var gitLog = "";
    try {
      gitLog = execFileSync("git", ["log", "--oneline", loopState.baseCommit + "..HEAD"], {
        cwd: cwd, encoding: "utf8", timeout: 10000,
      }).trim();
    } catch (e) {}

    var judgePrompt = "You are a judge evaluating whether a coding task has been completed.\n\n" +
      "## Original Task (PROMPT.md)\n\n" + loopState.promptText + "\n\n" +
      "## Evaluation Criteria (JUDGE.md)\n\n" + loopState.judgeText + "\n\n" +
      "## Commit History\n\n```\n" + (gitLog || "(no commits yet)") + "\n```\n\n" +
      "## Changes Made (git diff)\n\n```diff\n" + diff + "\n```\n\n" +
      "Based on the evaluation criteria, has the task been completed successfully?\n\n" +
      "IMPORTANT: The git diff above may not show everything. If criteria involve checking whether " +
      "specific files, classes, or features exist, use tools (Read, Glob, Grep, Bash) to verify " +
      "directly in the codebase. Do NOT assume something is missing just because it is not in the diff.\n\n" +
      "After your evaluation, respond with exactly one of:\n" +
      "- PASS: [brief explanation]\n" +
      "- FAIL: [brief explanation of what is still missing]";

    var judgeSession = sm.createSession();
    var judgeSource = loopRegistry.getById(loopState.loopId);
    var judgeName = (loopState.wizardData && loopState.wizardData.name) || (judgeSource && judgeSource.name) || "";
    var judgeSourceTag = (judgeSource && judgeSource.source) || null;
    var isRalphJudge = judgeSourceTag === "ralph";
    judgeSession.loop = { active: true, iteration: loopState.iteration, role: "judge", loopId: loopState.loopId, name: judgeName, source: judgeSourceTag, startedAt: loopState.startedAt };
    judgeSession.title = (isRalphJudge ? "Ralph" : "Task") + (judgeName ? " " + judgeName : "") + " Judge #" + loopState.iteration;
    sm.saveSessionFile(judgeSession);
    sm.broadcastSessionList();
    loopState.judgeSessionId = judgeSession.localId;

    send({
      type: "loop_judging",
      iteration: loopState.iteration,
      sessionId: judgeSession.localId,
    });

    var judgeCompleted = false;
    judgeSession.onQueryComplete = function(completedSession) {
      if (judgeCompleted) return;
      judgeCompleted = true;
      if (judgeWatchdog) { clearTimeout(judgeWatchdog); judgeWatchdog = null; }
      console.log("[ralph-loop] Judge #" + loopState.iteration + " onQueryComplete fired, history length: " + completedSession.history.length);
      var verdict = parseJudgeVerdict(completedSession);
      console.log("[ralph-loop] Judge verdict: " + (verdict.pass ? "PASS" : "FAIL") + " - " + verdict.explanation);

      loopState.results.push({
        iteration: loopState.iteration,
        verdict: verdict.pass ? "pass" : "fail",
        summary: verdict.explanation,
      });

      send({
        type: "loop_verdict",
        iteration: loopState.iteration,
        verdict: verdict.pass ? "pass" : "fail",
        summary: verdict.explanation,
      });

      // lr-ed10: Update the iteration handoff with the judge verdict (opt-in).
      // This overwrites the handoff written at the coder boundary with the verdict included.
      // writeHandoff is a no-op when compactHandoff is not enabled.
      writeHandoff({ loopState: loopState, session: completedSession, verdict: verdict.pass ? "pass" : "fail" });

      if (verdict.pass) {
        finishLoop("pass");
      } else {
        setTimeout(function() { runNextIteration(); }, 1000);
      }
    };

    // Watchdog: judge may use tools to verify, so allow more time
    var judgeWatchdog = setTimeout(function() {
      if (!judgeCompleted && loopState.active && !loopState.stopping) {
        console.error("[ralph-loop] Judge #" + loopState.iteration + " watchdog triggered — onQueryComplete never fired");
        judgeCompleted = true;
        loopState.results.push({
          iteration: loopState.iteration,
          verdict: "error",
          summary: "Judge session timed out (no completion signal)",
        });
        send({
          type: "loop_verdict",
          iteration: loopState.iteration,
          verdict: "error",
          summary: "Judge session timed out, retrying...",
        });
        setTimeout(function() { runNextIteration(); }, 2000);
      }
    }, 10 * 60 * 1000);

    var userMsg = { type: "user_message", text: judgePrompt };
    // lr-2ea2a7: routes through the shared history-cap helper (see grep-guard test).
    sm.recordHistoryEntry(judgeSession, userMsg, true);
    sm.appendToSessionFile(judgeSession, userMsg);

    judgeSession.isProcessing = true;
    onProcessingChanged();
    judgeSession.sentToolResults = {};
    judgeSession.acceptEditsAfterStart = true;
    judgeSession.singleTurn = true;
    if (loopState.settings) judgeSession.loopSettings = loopState.settings;
    sdk.startQuery(judgeSession, judgePrompt, undefined, getLinuxUserForSession(judgeSession));
  }

  // lr-2ea2a7: forward-accumulates delta/text across the FULL heap array —
  // safe because judge sessions are singleTurn (project-loop.js's
  // runJudge()) and short, never approaching HISTORY_INMEM_MAX; the heap
  // array is always the complete judge conversation, never trimmed.
  function parseJudgeVerdict(session) {
    var text = "";
    for (var i = 0; i < session.history.length; i++) {
      var h = session.history[i];
      if (h.type === "delta" && h.text) text += h.text;
      if (h.type === "text" && h.text) text += h.text;
    }
    console.log("[ralph-loop] Judge raw text (last 500 chars): " + text.slice(-500));
    var upper = text.toUpperCase();
    var passIdx = upper.indexOf("PASS");
    var failIdx = upper.indexOf("FAIL");
    if (passIdx !== -1 && (failIdx === -1 || passIdx < failIdx)) {
      var explanation = text.substring(passIdx + 4).replace(/^[\s:]+/, "").split("\n")[0].trim();
      return { pass: true, explanation: explanation || "Task completed" };
    }
    if (failIdx !== -1) {
      var explanation = text.substring(failIdx + 4).replace(/^[\s:]+/, "").split("\n")[0].trim();
      return { pass: false, explanation: explanation || "Task not yet complete" };
    }
    return { pass: false, explanation: "Could not parse judge verdict" };
  }

  function finishLoop(reason) {
    console.log("[ralph-loop] finishLoop called, reason: " + reason + ", iteration: " + loopState.iteration);

    // Unlock the last coder session so users can continue interacting with it.
    // Capture owner before clearing state so push routing still works.
    var _loopOwnerUserId = null;
    var _loopPrivTo = null; // null: legacy, "": private and nobody to tell
    var _lastSessionId = loopState.currentSessionId;
    if (loopState.currentSessionId) {
      var lastCoderSession = sm.sessions.get(loopState.currentSessionId);
      if (lastCoderSession) {
        lastCoderSession.singleTurn = false;
        _loopOwnerUserId = lastCoderSession.ownerId || null;
        _loopPrivTo = createPrivateSessionAccess(usersModule).privateOwner(lastCoderSession);
      }
    }

    // lr-fd38ac: clear the stale-resumability marker on EVERY session that
    // belongs to this loop run, not just the last coder session. Four
    // writers set `session.loop.active = true` (coder at runNextIteration(),
    // judge at runJudge(), crafting at the two wizard-crafting sites) — every
    // judge session and every prior iteration's coder session was left
    // permanently orphaned at active:true, and the one session this used to
    // fix reverted across a daemon restart because the clear was never
    // persisted (sessions.js:109 writes session.loop into the on-disk meta
    // line; sessions.js:711 rehydrates it — an in-memory-only clear never
    // reaches either). Persist the clear on each session so it survives a
    // restart and so switching into ANY finished loop session (coder, judge,
    // any iteration) is resumable, not just the last one.
    if (loopState.loopId) {
      sm.sessions.forEach(function (s) {
        if (s && s.loop && s.loop.loopId === loopState.loopId && s.loop.active) {
          s.loop.active = false;
          sm.saveSessionFile(s);
        }
      });
    }

    loopState.active = false;
    loopState.phase = "done";
    loopState.stopping = false;
    loopState.currentSessionId = null;
    loopState.judgeSessionId = null;
    // Drop any messages queued but never delivered to an iteration — the loop
    // is done, so there is no future boundary to deliver them at (lr-e31b).
    var _hadUndelivered = loopState.pendingUserMessages && loopState.pendingUserMessages.length > 0;
    loopState.pendingUserMessages = [];
    saveLoopState();

    send({
      type: "loop_finished",
      reason: reason,
      iterations: loopState.iteration,
      results: loopState.results,
    });
    if (_hadUndelivered) {
      send({ type: "loop_pending_messages", messages: [] });
    }

    // Record result in loop registry
    if (loopState.loopId) {
      loopRegistry.recordRun(loopState.loopId, {
        reason: reason,
        startedAt: loopState.startedAt,
        iterations: loopState.iteration,
      });
    }
    if (activeRegistryId) {
      send({ type: "schedule_run_finished", recordId: activeRegistryId, reason: reason, iterations: loopState.iteration });
      activeRegistryId = null;
    }

    if (pushModule && _loopPrivTo !== "") {
      var _finishBody = reason === "pass" || reason === "complete"
        ? "Completed after " + loopState.iteration + " iteration(s)"
        : reason === "max_iterations"
          ? "Reached max iterations (" + loopState.maxIterations + ")"
          : reason === "stopped" ? "Stopped by user" : "Ended due to error";
      var _loopDonePayload = {
        type: "done", slug: slug, title: "Loop Complete", body: _finishBody, tag: "ralph-loop-done",
      };
      // Route to loop session owner only — body carries iteration status.
      if (_loopOwnerUserId && pushModule.sendPushToUser) {
        pushModule.sendPushToUser(_loopOwnerUserId, _loopDonePayload);
      } else {
        pushModule.sendPush(_loopDonePayload);
      }
    }

    if (notificationsModule && _loopPrivTo !== "") {
      notificationsModule.notify("loop_complete", {
        private: _loopPrivTo !== null,
        targetUserId: _loopPrivTo || undefined,
        reason: reason,
        name: loopState.name,
        iterations: loopState.iteration,
        maxIterations: loopState.maxIterations,
        sessionId: _lastSessionId,
      });
    }

    // Process next queued trigger if any
    if (pendingTriggers.length > 0) {
      var next = pendingTriggers.shift();
      console.log("[loop-registry] Processing queued trigger: " + next.name);
      setTimeout(function () {
        triggerFromQueue(next);
      }, 1000);
    }
  }

  function resumeLoop() {
    if (refusePrivateExecution()) return;
    var dir = loopDir();
    if (!dir) {
      console.error("[ralph-loop] Cannot resume: no loop directory");
      loopState.active = false;
      loopState.phase = "idle";
      saveLoopState();
      return;
    }
    try {
      loopState.promptText = fs.readFileSync(path.join(dir, "PROMPT.md"), "utf8");
    } catch (e) {
      console.error("[ralph-loop] Cannot resume: missing PROMPT.md");
      loopState.active = false;
      loopState.phase = "idle";
      saveLoopState();
      return;
    }
    var _isSimpleResume = loopState.wizardData && loopState.wizardData.loopMode === "simple";
    if (!_isSimpleResume) {
      try {
        loopState.judgeText = fs.readFileSync(path.join(dir, "JUDGE.md"), "utf8");
      } catch (e) {
        console.error("[ralph-loop] Cannot resume: missing JUDGE.md");
        loopState.active = false;
        loopState.phase = "idle";
        saveLoopState();
        return;
      }
    } else {
      loopState.judgeText = null;
    }
    // Retry the interrupted iteration (runNextIteration will increment)
    if (loopState.iteration > 0) {
      loopState.iteration--;
    }
    console.log("[ralph-loop] Resuming loop, next iteration will be " + (loopState.iteration + 1) + "/" + loopState.maxIterations);
    send({ type: "loop_started", maxIterations: loopState.maxIterations });
    runNextIteration();
  }

  function stopLoop() {
    if (!loopState.active) return;
    console.log("[ralph-loop] stopLoop called");
    loopState.stopping = true;

    // Abort all loop-related sessions (coder + judge)
    var sessionIds = [loopState.currentSessionId, loopState.judgeSessionId];
    for (var i = 0; i < sessionIds.length; i++) {
      if (sessionIds[i] == null) continue;
      var s = sm.sessions.get(sessionIds[i]);
      if (!s) continue;
      // End message queue so SDK exits prompt wait
      if (s.messageQueue) { try { s.messageQueue.end(); } catch (e) {} }
      // Abort active API call
      if (s.abortController) { try { s.abortController.abort(); } catch (e) {} }
    }

    send({ type: "loop_stopping" });

    // Capture loop identity before the async gap so the fallback timer can
    // verify it is still operating on the same loop run — not a restarted one.
    // Without this snapshot a rapid stop/restart causes the timer to fire and
    // terminate the newly started loop. (lr-e823)
    var stoppingSeq = loopState._loopSeq;

    // Fallback: force finish if onQueryComplete hasn't fired after 5s
    setTimeout(function() {
      if (loopState._loopSeq === stoppingSeq && loopState.active && loopState.stopping) {
        console.log("[ralph-loop] Stop fallback triggered — forcing finishLoop");
        finishLoop("stopped");
      }
    }, 5000);
  }

  // --- Message handler for loop-related messages ---
  function handleLoopMessage(ws, msg) {
    if ((msg.type === "loop_start" || msg.type === "loop_registry_rerun") && activeSessionIsPrivate(ws)) {
      if (msg.type === "loop_start") sendTo(ws, { type: "error", text: LOOP_CONTROL_DENIED_TEXT });
      else sendTo(ws, { type: "loop_registry_error", text: "Forbidden" });
      return true;
    }
    if (LOOP_CONTROL_TYPES.hasOwnProperty(msg.type) && loopControlsBlocked()) {
      sendTo(ws, { type: "error", text: LOOP_CONTROL_DENIED_TEXT });
      return true;
    }
    if (msg.type === "loop_start") {
      // If this loop has a cron schedule, don't run immediately
      if (loopState.wizardData && loopState.wizardData.cron) {
        loopState.active = false;
        loopState.phase = "done";
        saveLoopState();
        send({ type: "loop_finished", reason: "scheduled", iterations: 0, results: [] });
        send({ type: "ralph_phase", phase: "idle", wizardData: null });
        send({ type: "loop_scheduled", recordId: loopState.loopId, cron: loopState.wizardData.cron });
        return true;
      }
      // Save per-loop settings to LOOP.json if provided
      if (msg.settings && Object.keys(msg.settings).length > 0) {
        var lDir3 = loopDir();
        if (lDir3) {
          var ljPath = path.join(lDir3, "LOOP.json");
          var lj = {};
          try { lj = JSON.parse(fs.readFileSync(ljPath, "utf8")); } catch (e) {}
          lj.settings = authzGate.sanitizeLoopSettings(ws, msg.settings);
          fs.writeFileSync(ljPath, JSON.stringify(lj, null, 2), "utf8");
        }
      }
      startLoop({ maxIterations: msg.maxIterations });
      return true;
    }

    if (msg.type === "loop_stop") {
      stopLoop();
      return true;
    }

    // lr-e31b: Queue a human message for delivery at the next iteration
    // boundary. See the comment in runNextIteration() for why this is
    // boundary-delivered rather than injected into the live iteration.
    //
    // lr-6fe5fc: this gate and the client's queue-mode UI gate
    // (isLoopQueueSession() in app-loop-ui.js) are intentionally NOT the
    // same predicate. This one answers "does the project have a running
    // loop that will accept a queued message at all" — loopState.active
    // alone, since pendingUserMessages is a single project-wide queue
    // delivered at the next iteration boundary regardless of which session
    // sent the WS message (loop_message carries no sessionId — see
    // input.js). The client's gate additionally requires the loop's
    // current session to be the one actually being viewed, which is a UX
    // constraint (don't claim "queued for the next iteration" on a session
    // that has nothing to do with that queue) this server-side accept
    // check has no need to enforce, since it is already correctly scoped
    // to the one loop this project can run at a time. Collapsing these
    // into one shared function would misrepresent one of the two questions
    // as the other; each stays the single authority for what it actually
    // answers.
    if (msg.type === "loop_message") {
      if (!loopState.active) {
        sendTo(ws, { type: "loop_message_error", text: "No loop is currently running." });
        return true;
      }
      var _lmText = (msg.text || "").trim();
      if (!_lmText) return true;
      if (_lmText.length > LOOP_MESSAGE_MAX_TEXT_LENGTH) {
        sendTo(ws, {
          type: "loop_message_error",
          text: "Message too long (" + _lmText.length + " chars, max " + LOOP_MESSAGE_MAX_TEXT_LENGTH + "). Not queued.",
        });
        return true;
      }
      if (loopState.pendingUserMessages.length >= LOOP_MESSAGE_MAX_QUEUE_LENGTH) {
        sendTo(ws, {
          type: "loop_message_error",
          text: "Message queue is full (max " + LOOP_MESSAGE_MAX_QUEUE_LENGTH + " pending). Wait for the next iteration boundary before sending more.",
        });
        return true;
      }
      // lr-4a9c: stable per-message id so a queued message can be targeted
      // for removal (loop_message_remove below) independent of its array
      // position, which shifts as other messages are queued/delivered.
      var _lmEntry = { id: crypto.randomBytes(8).toString("hex"), text: _lmText, ts: Date.now() };
      if (ws && ws._aigoraUser) {
        _lmEntry.from = ws._aigoraUser.id;
        _lmEntry.fromName = ws._aigoraUser.displayName || ws._aigoraUser.username || "";
      }
      loopState.pendingUserMessages.push(_lmEntry);
      saveLoopState();
      send({ type: "loop_pending_messages", messages: loopState.pendingUserMessages });
      return true;
    }

    // lr-4a9c: Remove a single queued message before it is delivered at the
    // next iteration boundary. Mirrors loop_message's validation shape and
    // reuses the same pendingUserMessages / loop_pending_messages plumbing —
    // no parallel queue or broadcast mechanism.
    if (msg.type === "loop_message_remove") {
      if (!loopState.active) {
        sendTo(ws, { type: "loop_message_error", text: "No loop is currently running." });
        return true;
      }
      var _lmrId = msg.id;
      if (!_lmrId) {
        sendTo(ws, { type: "loop_message_error", text: "No message id given to remove." });
        return true;
      }
      var _lmrIdx = loopState.pendingUserMessages.findIndex(function (m) { return m.id === _lmrId; });
      if (_lmrIdx === -1) {
        sendTo(ws, { type: "loop_message_error", text: "Queued message not found (already delivered or removed)." });
        return true;
      }
      loopState.pendingUserMessages.splice(_lmrIdx, 1);
      saveLoopState();
      send({ type: "loop_pending_messages", messages: loopState.pendingUserMessages });
      return true;
    }

    if (msg.type === "ralph_wizard_complete") {
      var wData = msg.data || {};
      var wizardProvenance, preparedCraftSession;
      try {
        wizardProvenance = creationProvenance(ws);
        var needsCraft = !(wData.mode === "own" && wData.promptText) ||
          (!wData.judgeText && wData.loopMode !== "simple" && wData.source !== "task");
        if (needsCraft) preparedCraftSession = sm.createSession(wizardProvenance || undefined, wizardProvenance ? ws : undefined);
      } catch (e) {
        sendTo(ws, { type: "loop_registry_error", text: "Forbidden" });
        return true;
      }
      var maxIter = wData.maxIterations || null;
      var wizardCron = wData.cron || null;
      var newLoopId = generateLoopId();
      loopState.loopId = newLoopId;
      var recordSource = wData.source === "task" ? null : "ralph";
      loopState.wizardData = {
        name: wData.name || wData.task || "Untitled",
        task: wData.task || "",
        maxIterations: maxIter,
        cron: wizardCron,
        loopMode: wData.loopMode || "judge",
        promptAuthor: require("./rebrand-migrate").normalizePromptAuthor(wData.promptAuthor),
        judgeAuthor: wData.judgeAuthor || null,
        source: recordSource,
      };
      loopState.phase = "crafting";
      loopState.startedAt = Date.now();
      saveLoopState();

      // Register in loop registry
      loopRegistry.register(Object.assign({
        id: newLoopId,
        name: loopState.wizardData.name,
        task: wData.task || "",
        cron: wizardCron,
        enabled: wizardCron ? true : false,
        maxIterations: maxIter,
        source: recordSource,
      }, wizardProvenance || {}));

      // Create loop directory and write LOOP.json
      var lDir = loopDir();
      try { fs.mkdirSync(lDir, { recursive: true }); } catch (e) {}
      var loopJsonPath = path.join(lDir, "LOOP.json");
      var tmpLoopJson = loopJsonPath + ".tmp";
      fs.writeFileSync(tmpLoopJson, JSON.stringify({ maxIterations: maxIter, loopMode: wData.loopMode || "judge" }, null, 2));
      fs.renameSync(tmpLoopJson, loopJsonPath);

      var craftName = (loopState.wizardData && loopState.wizardData.name) || "";
      var isRalphCraft = recordSource === "ralph";

      // User provided their own PROMPT.md (and optionally JUDGE.md)
      if (wData.mode === "own" && wData.promptText) {
        // Write PROMPT.md
        var promptPath = path.join(lDir, "PROMPT.md");
        var tmpPrompt = promptPath + ".tmp";
        fs.writeFileSync(tmpPrompt, wData.promptText);
        fs.renameSync(tmpPrompt, promptPath);

        if (wData.judgeText) {
          // Both provided: write JUDGE.md too
          var judgePath = path.join(lDir, "JUDGE.md");
          var tmpJudge = judgePath + ".tmp";
          fs.writeFileSync(tmpJudge, wData.judgeText);
          fs.renameSync(tmpJudge, judgePath);
        } else if (wData.loopMode === "simple" || !recordSource) {
          // Simple loop or scheduled task with no judge: go straight to approval
          loopState.phase = "approval";
          saveLoopState();
          sendRegistryState(newLoopId, { type: "ralph_phase", phase: "approval", source: recordSource, wizardData: loopState.wizardData });
          sendRegistryState(newLoopId, { type: "ralph_files_status", promptReady: true, judgeReady: false, bothReady: true });
          return true;
        } else {
          // Ralph with judge mode but no judge provided: start a crafting session to create JUDGE.md
          loopState.phase = "crafting";
          saveLoopState();

          var judgeCraftPrompt = "Use the /ralph-loop skill to design ONLY a JUDGE.md for an existing Ralph Loop. " +
            "The user has already provided PROMPT.md, so do NOT create or modify PROMPT.md. " +
            "You MUST invoke the ralph-loop skill — do NOT execute the task yourself. " +
            "Your job is to read the existing PROMPT.md and create a JUDGE.md " +
            "that will evaluate whether the coder session completed the task successfully.\n\n" +
            "## Task\n" + (wData.task || "") +
            "\n\n## Loop Directory\n" + lDir;

          var judgeCraftSession = preparedCraftSession;
          judgeCraftSession.title = (isRalphCraft ? "Ralph" : "Task") + (craftName ? " " + craftName : "") + " Crafting";
          judgeCraftSession.ralphCraftingMode = true;
          judgeCraftSession.loop = { active: true, iteration: 0, role: "crafting", loopId: newLoopId, name: craftName, source: recordSource, startedAt: loopState.startedAt };
          sm.saveSessionFile(judgeCraftSession);
          sm.switchSession(judgeCraftSession.localId, wizardProvenance ? ws : null, hydrateImageRefs);
          loopState.craftingSessionId = judgeCraftSession.localId;

          loopRegistry.updateRecord(newLoopId, { craftingSessionId: judgeCraftSession.localId });

          startClaudeDirWatch();

          // lr-2ea2a7: routes through the shared history-cap helper (see
          // grep-guard test); a single object instance now backs both the
          // heap entry and the durable append (previously two separate
          // literals — harmless before, but recordHistoryEntry mutates the
          // object it's given, so a shared reference is the correct shape).
          var judgeCraftUserMsg = { type: "user_message", text: judgeCraftPrompt };
          sm.recordHistoryEntry(judgeCraftSession, judgeCraftUserMsg, true);
          sm.appendToSessionFile(judgeCraftSession, judgeCraftUserMsg);
          sendToSession(judgeCraftSession.localId, judgeCraftUserMsg);
          judgeCraftSession.isProcessing = true;
          onProcessingChanged();
          judgeCraftSession.sentToolResults = {};
          sendToSession(judgeCraftSession.localId, { type: "status", status: "processing" });
          sdk.startQuery(judgeCraftSession, judgeCraftPrompt, undefined, getLinuxUserForSession(judgeCraftSession));

          sendRegistryState(newLoopId, { type: "ralph_crafting_started", sessionId: judgeCraftSession.localId, taskId: newLoopId, source: recordSource });
          sendRegistryState(newLoopId, { type: "ralph_phase", phase: "crafting", wizardData: loopState.wizardData, craftingSessionId: judgeCraftSession.localId });
          sendRegistryState(newLoopId, { type: "ralph_files_status", promptReady: true, judgeReady: false, bothReady: false });
          return true;
        }

        // Both prompt and judge provided: go straight to approval
        loopState.phase = "approval";
        saveLoopState();
        sendRegistryState(newLoopId, { type: "ralph_phase", phase: "approval", source: recordSource, wizardData: loopState.wizardData });
        sendRegistryState(newLoopId, { type: "ralph_files_status", promptReady: true, judgeReady: true, bothReady: true });
        return true;
      }

      // Default: "draft" mode — crafts files via the ralph-loop skill
      var _draftIsSimple = wData.loopMode === "simple";
      var craftingPrompt;
      if (_draftIsSimple) {
        craftingPrompt = "Use the /ralph-loop skill to design a Ralph Loop for the following task. " +
          "You MUST invoke the ralph-loop skill — do NOT execute the task yourself. " +
          "This is a Simple Loop (no judge). Your job is to create ONLY a PROMPT.md file " +
          "that a future autonomous session will execute. Do NOT create a JUDGE.md file.\n\n" +
          "## Task\n" + (wData.task || "") +
          "\n\n## Loop Directory\n" + lDir;
      } else if (wData.judgeAuthor === "me") {
        craftingPrompt = "Use the /ralph-loop skill to design a Ralph Loop for the following task. " +
          "You MUST invoke the ralph-loop skill — do NOT execute the task yourself. " +
          "The user will provide their own JUDGE.md, so create ONLY a PROMPT.md file " +
          "that a future autonomous session will execute. Do NOT create a JUDGE.md file.\n\n" +
          "## Task\n" + (wData.task || "") +
          "\n\n## Loop Directory\n" + lDir;
      } else {
        craftingPrompt = "Use the /ralph-loop skill to design a Ralph Loop for the following task. " +
          "You MUST invoke the ralph-loop skill — do NOT execute the task yourself. " +
          "Your job is to interview me, then create PROMPT.md and JUDGE.md files " +
          "that a future autonomous session will execute.\n\n" +
          "## Task\n" + (wData.task || "") +
          "\n\n## Loop Directory\n" + lDir;
      }

      // Pre-write user-provided files before crafting starts
      if (wData.judgeText && wData.judgeAuthor === "me") {
        var _judgePathDraft = path.join(lDir, "JUDGE.md");
        var _tmpJudgeDraft = _judgePathDraft + ".tmp";
        fs.writeFileSync(_tmpJudgeDraft, wData.judgeText);
        fs.renameSync(_tmpJudgeDraft, _judgePathDraft);
      }

      // Create a new session for crafting
      var craftingSession = preparedCraftSession;
      craftingSession.title = (isRalphCraft ? "Ralph" : "Task") + (craftName ? " " + craftName : "") + " Crafting";
      craftingSession.ralphCraftingMode = true;
      craftingSession.loop = { active: true, iteration: 0, role: "crafting", loopId: newLoopId, name: craftName, source: recordSource, startedAt: loopState.startedAt };
      sm.saveSessionFile(craftingSession);
      sm.switchSession(craftingSession.localId, wizardProvenance ? ws : null, hydrateImageRefs);
      loopState.craftingSessionId = craftingSession.localId;

      // Store crafting session ID in the registry record
      loopRegistry.updateRecord(newLoopId, { craftingSessionId: craftingSession.localId });

      // Start .claude/ directory watcher
      startClaudeDirWatch();

      // Send crafting prompt and start the conversation with Claude.
      // lr-2ea2a7: routes through the shared history-cap helper (see
      // grep-guard test); single object instance shared across the heap
      // entry, the durable append, and the client send.
      var craftingUserMsg = { type: "user_message", text: craftingPrompt };
      sm.recordHistoryEntry(craftingSession, craftingUserMsg, true);
      sm.appendToSessionFile(craftingSession, craftingUserMsg);
      sendToSession(craftingSession.localId, craftingUserMsg);
      craftingSession.isProcessing = true;
      onProcessingChanged();
      craftingSession.sentToolResults = {};
      sendToSession(craftingSession.localId, { type: "status", status: "processing" });
      sdk.startQuery(craftingSession, craftingPrompt, undefined, getLinuxUserForSession(craftingSession));

      sendRegistryState(newLoopId, { type: "ralph_crafting_started", sessionId: craftingSession.localId, taskId: newLoopId, source: recordSource });
      sendRegistryState(newLoopId, { type: "ralph_phase", phase: "crafting", wizardData: loopState.wizardData, craftingSessionId: craftingSession.localId });
      return true;
    }

    if (msg.type === "loop_registry_files") {
      var recId = msg.id;
      if (denyRegistry(ws, recId, "read")) return true;
      // Validate ID before using it as a path component (path traversal guard).
      if (!validateLoopId(recId)) {
        send({ type: "loop_registry_error", text: "invalid_loop_id" });
        return true;
      }
      var loopBase = path.resolve(cwd, ".claude", "loops");
      var lDir = path.resolve(loopBase, recId);
      if (!lDir.startsWith(loopBase + path.sep)) {
        send({ type: "loop_registry_error", text: "invalid_loop_id" });
        return true;
      }
      var promptContent = "";
      var judgeContent = "";
      var loopSettings = null;
      try { promptContent = fs.readFileSync(path.join(lDir, "PROMPT.md"), "utf8"); } catch (e) {}
      try { judgeContent = fs.readFileSync(path.join(lDir, "JUDGE.md"), "utf8"); } catch (e) {}
      try {
        var loopJson = JSON.parse(fs.readFileSync(path.join(lDir, "LOOP.json"), "utf8"));
        loopSettings = loopJson.settings || null;
      } catch (e) {}
      registryReply(ws, recId, {
        type: "loop_registry_files_content",
        id: recId,
        prompt: promptContent,
        judge: judgeContent,
        settings: loopSettings,
      });
      return true;
    }

    if (msg.type === "loop_registry_save_files") {
      var recId2 = msg.id;
      if (denyRegistry(ws, recId2, "mutate")) return true;
      // Validate ID before using it as a path component (path traversal guard).
      if (!validateLoopId(recId2)) {
        send({ type: "loop_registry_error", text: "invalid_loop_id" });
        return true;
      }
      var loopBase2 = path.resolve(cwd, ".claude", "loops");
      var lDir2 = path.resolve(loopBase2, recId2);
      if (!lDir2.startsWith(loopBase2 + path.sep)) {
        send({ type: "loop_registry_error", text: "invalid_loop_id" });
        return true;
      }
      try {
        fs.mkdirSync(lDir2, { recursive: true });
        if (msg.prompt !== undefined) {
          fs.writeFileSync(path.join(lDir2, "PROMPT.md"), msg.prompt, "utf8");
        }
        if (msg.judge !== undefined) {
          fs.writeFileSync(path.join(lDir2, "JUDGE.md"), msg.judge, "utf8");
        }
        if (msg.settings !== undefined) {
          var loopJsonPath2 = path.join(lDir2, "LOOP.json");
          var loopJson2 = {};
          try { loopJson2 = JSON.parse(fs.readFileSync(loopJsonPath2, "utf8")); } catch (e) {}
          loopJson2.settings = authzGate.sanitizeLoopSettings(ws, msg.settings);
          fs.writeFileSync(loopJsonPath2, JSON.stringify(loopJson2, null, 2), "utf8");
        }
        registryReply(ws, recId2, { type: "loop_registry_save_files_result", id: recId2, ok: true });
        // Re-send updated content so the UI refreshes
        var updatedPrompt = "";
        var updatedJudge = "";
        var updatedSettings = null;
        try { updatedPrompt = fs.readFileSync(path.join(lDir2, "PROMPT.md"), "utf8"); } catch (e) {}
        try { updatedJudge = fs.readFileSync(path.join(lDir2, "JUDGE.md"), "utf8"); } catch (e) {}
        try {
          var uj = JSON.parse(fs.readFileSync(path.join(lDir2, "LOOP.json"), "utf8"));
          updatedSettings = uj.settings || null;
        } catch (e) {}
        registryReply(ws, recId2, { type: "loop_registry_files_content", id: recId2, prompt: updatedPrompt, judge: updatedJudge, settings: updatedSettings });
      } catch (e) {
        registryReply(ws, recId2, { type: "loop_registry_save_files_result", id: recId2, ok: false, error: e.message });
      }
      return true;
    }

    if (msg.type === "ralph_preview_files") {
      if (denyRegistry(ws, loopState.loopId, "read")) return true;
      var promptContent = "";
      var judgeContent = "";
      var previewDir = loopDir();
      if (previewDir) {
        try { promptContent = fs.readFileSync(path.join(previewDir, "PROMPT.md"), "utf8"); } catch (e) {}
        try { judgeContent = fs.readFileSync(path.join(previewDir, "JUDGE.md"), "utf8"); } catch (e) {}
      }
      sendTo(ws, {
        type: "ralph_files_content",
        prompt: promptContent,
        judge: judgeContent,
      });
      return true;
    }

    if (msg.type === "ralph_wizard_cancel") {
      if (denyRegistry(ws, loopState.loopId, "mutate")) return true;
      stopClaudeDirWatch();
      // Clean up loop directory
      var cancelDir = loopDir();
      if (cancelDir) {
        try { fs.rmSync(cancelDir, { recursive: true, force: true }); } catch (e) {}
      }
      clearLoopState();
      send({ type: "ralph_phase", phase: "idle", wizardData: null });
      return true;
    }

    if (msg.type === "ralph_cancel_crafting") {
      if (denyRegistry(ws, loopState.loopId, "mutate")) return true;
      // Abort the crafting session if running
      if (loopState.craftingSessionId != null) {
        var craftSession = sm.sessions.get(loopState.craftingSessionId) || null;
        if (craftSession && craftSession.abortController) {
          craftSession.abortController.abort();
        }
      }
      stopClaudeDirWatch();
      // Clean up loop directory
      var craftCancelDir = loopDir();
      if (craftCancelDir) {
        try { fs.rmSync(craftCancelDir, { recursive: true, force: true }); } catch (e) {}
      }
      clearLoopState();
      send({ type: "ralph_phase", phase: "idle", wizardData: null });
      return true;
    }

    // --- Schedule create (from calendar click) ---
    if (msg.type === "schedule_create") {
      var sData = msg.data || {};
      var scheduleProvenance;
      try { scheduleProvenance = creationProvenance(ws); } catch (e) {
        sendTo(ws, { type: "loop_registry_error", text: "Forbidden" });
        return true;
      }
      loopRegistry.register(Object.assign({
        name: sData.name || "Untitled",
        task: sData.name || "",
        description: sData.description || "",
        date: sData.date || null,
        time: sData.time || null,
        allDay: sData.allDay !== undefined ? sData.allDay : true,
        linkedTaskId: sData.taskId || null,
        cron: sData.cron || null,
        enabled: sData.cron ? (sData.enabled !== false) : false,
        maxIterations: sData.maxIterations || 3,
        source: "schedule",
        color: sData.color || null,
        recurrenceEnd: sData.recurrenceEnd || null,
        skipIfRunning: sData.skipIfRunning !== undefined ? sData.skipIfRunning : true,
        intervalEnd: sData.intervalEnd || null,
      }, scheduleProvenance || {}));
      return true;
    }

    // --- Hub: cross-project schedule aggregation ---
    if (msg.type === "hub_schedules_list") {
      sendTo(ws, { type: "hub_schedules", schedules: filterRegistryRecords(ws, getHubSchedules()) });
      return true;
    }

    // --- Hub: cross-project recent sessions ---
    if (msg.type === "hub_recent_sessions_list") {
      // Gather EVERY project uniformly (includeSelf=true) so the global recency
      // sort is honest. Previously self was special-cased: other projects came
      // through getAllProjectSessions() and self's sessions were appended
      // separately. Combined with a too-small top-10 slice, the currently
      // connected (most-recently-active) project crowded out the genuinely most
      // recent sessions overall. getAllProjectSessions returns annotated shallow
      // copies carrying _projectSlug/_projectTitle/_projectIcon for every project.
      var hubUserId = ws._aigoraUser ? ws._aigoraUser.id : null;
      var allSessions = getAllProjectSessions ? getAllProjectSessions(true, hubUserId) : [];
      // Sort newest-first by lastActivity
      allSessions.sort(function (a, b) {
        return (b.lastActivity || b.createdAt || 0) - (a.lastActivity || a.createdAt || 0);
      });
      // The global sort above is the actual fix: every project is gathered
      // uniformly, so the top-N is the genuinely most-recent overall rather
      // than whatever the connected project happened to touch. The Hub card
      // shows 10; selection is now honest, so 10 is a display cap, not a
      // project-biased pool.
      var top = allSessions.slice(0, 10);
      var mapped = top.map(function (s) {
        var sessProjectSlug = s._projectSlug || slug;
        return {
          id: s.localId,
          title: s.title || "New Session",
          lastActivity: s.lastActivity || s.createdAt || 0,
          projectSlug: sessProjectSlug,
          projectTitle: s._projectTitle || slug,
          projectIcon: s._projectIcon || null,
          vendor: s.vendor || null,
          agentName: s.agentName || null,
          isProcessing: !!s.isProcessing,
          // lr-0aa7b6: THIS session's own unread count, not the project
          // aggregate — the client keys the merged status dot's alert(red)
          // state on this field so only the actually-notifying session's
          // row lights up, not every sibling row in the same project.
          unread: getSessionUnread(ws, sessProjectSlug, s.localId),
          // lr-66c118: multi-user activity tone. ownerId was already on the
          // session object (createSession) but never projected onto this
          // wire shape — the frontend derivation module (activity-state.js)
          // needs it to distinguish "my activity" from "another user's
          // activity" the same way session_list already does.
          ownerId: s.ownerId || null,
        };
      });
      sendTo(ws, { type: "hub_recent_sessions", sessions: mapped });
      return true;
    }

    // --- Loop Registry messages ---
    if (msg.type === "loop_registry_list") {
      sendTo(ws, { type: "loop_registry_updated", records: filterRegistryRecords(ws, getHubSchedules()) });
      return true;
    }

    if (msg.type === "loop_registry_update") {
      if (denyRegistry(ws, msg.id, "mutate")) return true;
      var updatedRec = loopRegistry.update(msg.id, msg.data || {});
      if (!updatedRec) {
        sendTo(ws, { type: "loop_registry_error", text: "Record not found" });
      }
      return true;
    }

    if (msg.type === "loop_registry_rename") {
      if (denyRegistry(ws, msg.id, "mutate")) return true;
      if (msg.id && msg.name) {
        loopRegistry.updateRecord(msg.id, { name: String(msg.name).substring(0, 100) });
        sm.broadcastSessionList();
      }
      return true;
    }

    if (msg.type === "loop_registry_remove") {
      if (denyRegistry(ws, msg.id, "mutate")) return true;
      var removedRec = loopRegistry.remove(msg.id);
      if (!removedRec) {
        sendTo(ws, { type: "loop_registry_error", text: "Record not found" });
      }
      return true;
    }

    if (msg.type === "loop_registry_convert") {
      if (denyRegistry(ws, msg.id, "mutate")) return true;
      // Convert ralph source to regular task (remove source tag)
      if (msg.id) {
        loopRegistry.updateRecord(msg.id, { source: null });
        sm.broadcastSessionList();
      }
      return true;
    }

    if (msg.type === "delete_loop_group") {
      // Delete all sessions belonging to this loopId, then remove registry record
      var loopIdToDel = msg.loopId;
      if (!loopIdToDel) return true;
      if (denyProvenance(ws, loopIdToDel, "mutate")) return true;
      var sessionIds = [];
      var groupSessions = [];
      sm.sessions.forEach(function (s, lid) {
        if (s.loop && s.loop.loopId === loopIdToDel) { sessionIds.push(lid); groupSessions.push(s); }
      });
      if (!mayDeleteLoopGroup(ws, groupSessions)) {
        sendTo(ws, { type: "error", text: "You do not have permission to delete this loop group" });
        return true;
      }
      var groupSnaps = {};
      for (var di = 0; di < sessionIds.length; di++) {
        var groupSnap = sm.deleteSessionQuiet(sessionIds[di]);
        if (groupSnap) groupSnaps[sessionIds[di]] = groupSnap;
      }
      // lr-0827ba (PEACHES follow-up): notify clients of exactly which
      // sessions were deleted so per-session client state (rate-limit-state.js)
      // can be pruned instead of leaking a background timer forever.
      if (sessionIds.length > 0) sm.broadcastSessionDeleted(sessionIds, groupSnaps);
      loopRegistry.remove(loopIdToDel);
      sm.broadcastSessionList();
      return true;
    }

    if (msg.type === "loop_registry_toggle") {
      if (denyRegistry(ws, msg.id, "mutate")) return true;
      var toggledRec = loopRegistry.toggleEnabled(msg.id);
      if (!toggledRec) {
        sendTo(ws, { type: "loop_registry_error", text: "Record not found or not scheduled" });
      }
      return true;
    }

    if (msg.type === "loop_registry_rerun") {
      if (denyRegistry(ws, msg.id, "execute")) return true;
      // Re-run an existing job (one-off from library)
      if (loopState.active || loopState.phase === "executing") {
        sendTo(ws, { type: "loop_registry_error", text: "A loop is already running" });
        return true;
      }
      var rerunRec = loopRegistry.getById(msg.id);
      if (!rerunRec) {
        sendTo(ws, { type: "loop_registry_error", text: "Record not found" });
        return true;
      }
      var rerunDir = path.join(cwd, ".claude", "loops", rerunRec.id);
      try {
        fs.accessSync(path.join(rerunDir, "PROMPT.md"));
      } catch (e) {
        sendTo(ws, { type: "loop_registry_error", text: "PROMPT.md missing for " + rerunRec.id });
        return true;
      }
      loopState.loopId = rerunRec.id;
      loopState.loopFilesId = null;
      activeRegistryId = null; // not a scheduled trigger
      send({ type: "loop_rerun_started", recordId: rerunRec.id });
      startLoop();
      return true;
    }

    return false; // not handled
  }

  // --- Connection state: send loop state to newly connected client ---
  function sendConnectionState(ws) {
    if (loopState.loopId && registryAccessDenied(ws, loopState.loopId, "read")) {
      sendTo(ws, { type: "loop_available", available: false, active: false });
      return;
    }
    // Ralph Loop availability
    var _connIsSimple = loopState.wizardData && loopState.wizardData.loopMode === "simple";
    var hasLoopFiles = false;
    try {
      fs.accessSync(path.join(cwd, ".claude", "PROMPT.md"));
      if (!_connIsSimple) fs.accessSync(path.join(cwd, ".claude", "JUDGE.md"));
      hasLoopFiles = true;
    } catch (e) {}
    // Also check loop directory files
    if (!hasLoopFiles && loopState.loopId) {
      var _avDir = loopDir();
      if (_avDir) {
        try {
          fs.accessSync(path.join(_avDir, "PROMPT.md"));
          if (!_connIsSimple) fs.accessSync(path.join(_avDir, "JUDGE.md"));
          hasLoopFiles = true;
        } catch (e) {}
      }
    }
    sendTo(ws, {
      type: "loop_available",
      available: hasLoopFiles,
      active: loopState.active,
      iteration: loopState.iteration,
      maxIterations: loopState.maxIterations,
      name: loopState.name || null,
    });

    // lr-e31b: Restore the queued-message indicator on reconnect so a
    // client that joins mid-iteration sees what is already queued.
    if (loopState.active && loopState.pendingUserMessages && loopState.pendingUserMessages.length > 0) {
      sendTo(ws, { type: "loop_pending_messages", messages: loopState.pendingUserMessages });
    }

    // Ralph phase state
    // Derive source from wizardData for reconnect (so client can distinguish ralph vs task)
    var _connSource = loopState.wizardData ? (loopState.wizardData.source || null) : null;
    sendTo(ws, {
      type: "ralph_phase",
      phase: loopState.phase,
      wizardData: loopState.wizardData,
      craftingSessionId: loopState.craftingSessionId || null,
      source: _connSource,
    });
    if (loopState.phase === "crafting" || loopState.phase === "approval") {
      var _hasPrompt = false;
      var _hasJudge = false;
      var _lDir = loopDir();
      if (_lDir) {
        try { fs.accessSync(path.join(_lDir, "PROMPT.md")); _hasPrompt = true; } catch (e) {}
        try { fs.accessSync(path.join(_lDir, "JUDGE.md")); _hasJudge = true; } catch (e) {}
      }
      var _connBothReady = _connIsSimple ? _hasPrompt : (_hasPrompt && _hasJudge);
      sendTo(ws, {
        type: "ralph_files_status",
        promptReady: _hasPrompt,
        judgeReady: _hasJudge,
        bothReady: _connBothReady,
        taskId: loopState.loopId,
      });
    }
  }

  // --- Public API ---
  return {
    filterRegistryRecords: filterRegistryRecords,
    loopState: loopState,
    loopRegistry: loopRegistry,
    loopDir: loopDir,
    startLoop: startLoop,
    stopLoop: stopLoop,
    resumeLoop: resumeLoop,
    handleLoopMessage: handleLoopMessage,
    sendConnectionState: sendConnectionState,
    stopClaudeDirWatch: stopClaudeDirWatch,
    getSchedules: function () { return loopRegistry.getAll(); },
    importSchedule: function (data) { return loopRegistry.register(data); },
    removeSchedule: function (id) { return loopRegistry.remove(id); },
    stopTimer: function () { loopRegistry.stopTimer(); },
  };
}

module.exports = {
  attachLoop: attachLoop,
  validateLoopId: validateLoopId,
  LOOP_MESSAGE_MAX_QUEUE_LENGTH: LOOP_MESSAGE_MAX_QUEUE_LENGTH,
  LOOP_MESSAGE_MAX_TEXT_LENGTH: LOOP_MESSAGE_MAX_TEXT_LENGTH,
};

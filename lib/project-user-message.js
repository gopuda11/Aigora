module.exports = require("./extensions").select("project-user-message", function () {
var module = { exports: {} };
var path = require("path");
var { isChannelBound } = require("./private-session-access");
var { createRoomMainThread } = require("./room-main-thread");
var { createPrivateVendorThread } = require("./private-vendor-thread");
var { pickedSessionAgent, workThenVerify } = require("./orchestration/router");
var roomExec = require("./room-execution");
var { NEW_CHANNEL_SESSION_TITLE, firstInstructionTitle } = require("./session-title");
var fs = require("fs");
var PRIVATE_WAIT_TEXT = "앞의 AI 작업이 끝난 뒤에 다시 보내 주세요.";

/**
 * Attach user-message handler and remaining small handlers
 * (sticky notes, terminals, context sources, browser extension,
 *  scheduled tasks gate, loop delegation, schedule_message,
 *  and the main "message" dispatch) to a project context.
 *
 * ctx fields:
 *   cwd, slug, isMate, osUsers,
 *   sm, sdk, nm, tm,
 *   send, sendTo, sendToSession, sendToSessionOthers,
 *   clients, opts,
 *   usersModule, matesModule,
 *   getSessionForWs, getLinuxUserForSession, ensureProjectAccessForSession, getOsUserInfoForWs,
 *   hydrateImageRefs, saveImageFile, imagesDir,
 *   onProcessingChanged, onSessionDone,
 *   _loop              - { handleLoopMessage: fn(ws, msg) }
 *   browserState       - { _browserTabList, _extensionWs, pendingExtensionRequests } (mutable refs)
 *   sendExtensionCommandAny, requestTabContext,
 *   startFileWatch, stopFileWatch,
 *   scheduleMessage, cancelScheduledMessage,
 *   loadContextSources, saveContextSources,
 *   digestDmTurn,
 *   adapter            - YOKE adapter instance
 */
// lr-62157d (BOBBIE, PR #406): truncation works on code points (Array.from), never UTF-16 code units, so a cut can not
// split a surrogate pair into a lone surrogate (emoji, supplementary-plane CJK in pasted text).
// A provisional title that is cut shows where: it ends at a word boundary (a space after at least 20 characters) and
// carries an ellipsis, 50 characters at most in all. Text with no usable space (CJK, one long token) is cut hard.
function truncateTitle(str, maxLen) {
  var codePoints = Array.from(str);
  if (codePoints.length <= maxLen) return str;
  var head = codePoints.slice(0, maxLen - 1);
  var at = -1;
  for (var i = head.length - 1; i >= 20; i--) { if (head[i] === " ") { at = i; break; } }
  var cut = (at > 0 ? head.slice(0, at) : head).join("").replace(/[\s,.;:!?\-]+$/, "");
  return cut + "\u2026";
}

// lr-62157d: pure helper — derives the FIRST-message provisional title
// (before any turn has completed / before autoGenerateTitle can run).
// Prefers real message text; falls back to the first paste when text is
// empty (a >=500-char paste is diverted server-side into msg.pastes[] with
// msg.text empty by the client's paste-chip handling — see input.js — so
// msg.text alone previously always fell through to the "Image" literal for
// a text paste, not just a genuine image-only message). "Image" is reserved
// for the case where neither text nor a paste is present. Whitespace is
// collapsed before truncating since pastes are commonly multi-line and an
// un-normalized 50-char slice renders as a broken sidebar entry.
// Exported as _test_deriveProvisionalTitle (see codex.js's
// _test_resolveTitleModel for the established convention) so this is
// directly unit-testable without constructing the full WS message handler.
function deriveProvisionalTitle(msg) {
  var source = msg && msg.text;
  if (!source && msg && msg.pastes && msg.pastes.length > 0) {
    source = msg.pastes[0];
  }
  // PEACHES fnd-439007: msg is raw client-controlled WS JSON with no
  // server-side schema validation (see project-connection.js's bare
  // JSON.parse) — the bundled browser client only ever sends strings in
  // pastes[] (input.js's paste handler pushes p.text, always a string), but
  // nothing enforces that for an arbitrary WS client. A non-string entry
  // (e.g. an object) must not reach .replace(), which only exists on
  // strings — fall through to the "Image" literal instead, exactly the case
  // it was originally written for.
  var collapsed = typeof source === "string"
    ? truncateTitle(source.replace(/\s+/g, " ").trim(), 50)
    : "";
  return collapsed || "Image";
}

function attachUserMessage(ctx) {
  var cwd = ctx.cwd;
  var slug = ctx.slug;
  var osUsers = ctx.osUsers;

  var sm = ctx.sm;
  var sdk = ctx.sdk;
  var nm = ctx.nm;
  var tm = ctx.tm;

  var send = ctx.send;
  var sendTo = ctx.sendTo;
  var sendToSession = ctx.sendToSession;
  var sendToSessionOthers = ctx.sendToSessionOthers;

  var clients = ctx.clients;
  var opts = ctx.opts;

  var usersModule = ctx.usersModule;

  var getSessionForWs = ctx.getSessionForWs;
  var getLinuxUserForSession = ctx.getLinuxUserForSession;
  var ensureProjectAccessForSession = ctx.ensureProjectAccessForSession;
  var getOsUserInfoForWs = ctx.getOsUserInfoForWs;

  var hydrateImageRefs = ctx.hydrateImageRefs;
  var saveImageFile = ctx.saveImageFile;
  var imagesDir = ctx.imagesDir;

  var onProcessingChanged = ctx.onProcessingChanged;

  var _loop = ctx._loop;
  var browserState = ctx.browserState;

  var sendExtensionCommandAny = ctx.sendExtensionCommandAny;
  var requestTabContext = ctx.requestTabContext;

  var scheduleMessage = ctx.scheduleMessage;
  var cancelScheduledMessage = ctx.cancelScheduledMessage;

  var loadContextSources = ctx.loadContextSources;
  var saveContextSources = ctx.saveContextSources;

  var adapter = ctx.adapter;

  // --------------- Terminal list broadcast ---------------

  // Each client only sees their own terminals — send filtered term_list messages individually.
  function broadcastTermList() {
    for (var bws of clients) {
      if (bws.readyState === 1) {
        sendTo(bws, { type: "term_list", terminals: tm.list(bws) });
      }
    }
  }

  // --------------- Sticky notes ---------------

  function syncNotesKnowledge() {
    // No-op stub (mate-only feature, lr-316f)
  }

  // Notes are project-wide and not scoped to a room, so only the global admin may read or change them.
  function isAdminWs(w) { return !!(w._aigoraUser && w._aigoraUser.role === "admin"); }
  function sendNoteEvent(obj) {
    for (var nws of clients) {
      if (nws.readyState === 1 && isAdminWs(nws)) sendTo(nws, obj);
    }
  }

  // --------------- Main handler ---------------

  // session -> { tail: promise of its last held message, n: held count }, so messages accepted during a semantic
  // decision start in order. Bounded per session; beyond the bound a message simply starts with the baseline plan.
  var semanticTails = new WeakMap();
  var MAX_HELD = 20;

  function handleUserMessage(ws, msg) {
    // --- Sticky notes ---
    if ((msg.type === "note_create" || msg.type === "note_update" || msg.type === "note_delete" || msg.type === "note_bring_front") && !isAdminWs(ws)) {
      sendTo(ws, { type: "error", text: "Admin access required" });
      return true;
    }
    if (msg.type === "note_create") {
      var note = nm.create(msg);
      if (note) {
        sendNoteEvent({ type: "note_created", note: note });
        syncNotesKnowledge();
      }
      return true;
    }

    if (msg.type === "note_update") {
      if (!msg.id) return true;
      var updated = nm.update(msg.id, msg);
      if (updated) {
        sendNoteEvent({ type: "note_updated", note: updated });
        if (msg.text !== undefined || msg.hidden !== undefined) syncNotesKnowledge();
      }
      return true;
    }

    if (msg.type === "note_delete") {
      if (!msg.id) return true;
      if (nm.remove(msg.id)) {
        sendNoteEvent({ type: "note_deleted", id: msg.id });
        syncNotesKnowledge();
      }
      return true;
    }

    if (msg.type === "note_list_request") {
      sendTo(ws, { type: "notes_list", notes: isAdminWs(ws) ? nm.list() : [] });
      return true;
    }

    if (msg.type === "note_bring_front") {
      if (!msg.id) return true;
      var front = nm.bringToFront(msg.id);
      if (front) sendNoteEvent({ type: "note_updated", note: front });
      return true;
    }

    // --- Web terminal ---
    if (msg.type === "term_create") {
      if (ws._aigoraUser) {
        var termPerms = usersModule.getEffectivePermissions(ws._aigoraUser, osUsers);
        if (!termPerms.terminal) {
          sendTo(ws, { type: "term_error", error: "Terminal access is not permitted" });
          return true;
        }
      }
      var t = tm.create(msg.cols || 80, msg.rows || 24, getOsUserInfoForWs(ws), ws);
      if (!t) {
        sendTo(ws, { type: "term_error", error: "Cannot create terminal (node-pty not available or limit reached)" });
        return true;
      }
      tm.attach(t.id, ws);
      broadcastTermList();
      sendTo(ws, { type: "term_created", id: t.id });
      return true;
    }

    if (msg.type === "term_attach") {
      if (msg.id) {
        var attached = tm.attach(msg.id, ws);
        if (!attached) {
          sendTo(ws, { type: "term_error", error: "Terminal not found or access denied" });
        }
      }
      return true;
    }

    if (msg.type === "term_detach") {
      if (msg.id) tm.detach(msg.id, ws);
      return true;
    }

    if (msg.type === "term_input") {
      if (msg.id) tm.write(msg.id, msg.data, ws);
      return true;
    }

    if (msg.type === "term_resize") {
      if (msg.id && msg.cols > 0 && msg.rows > 0) {
        tm.resize(msg.id, msg.cols, msg.rows, ws);
      }
      return true;
    }

    if (msg.type === "term_close") {
      if (msg.id) {
        tm.close(msg.id, ws);
        broadcastTermList();
        // Remove closed terminal from context sources
        var _termSessionId = ws._aigoraActiveSession || null;
        var saved = loadContextSources(slug, _termSessionId);
        var termKey = "term:" + msg.id;
        var filtered = saved.filter(function(id) { return id !== termKey; });
        if (filtered.length !== saved.length) {
          saveContextSources(slug, _termSessionId, filtered);
          send({ type: "context_sources_state", active: filtered });
        }
      }
      return true;
    }

    if (msg.type === "term_rename") {
      if (msg.id && msg.title) {
        tm.rename(msg.id, msg.title, ws);
        broadcastTermList();
      }
      return true;
    }

    // --- Context Sources ---
    if (msg.type === "context_sources_save") {
      var activeIds = msg.active || [];
      // In multi-user mode, strip any term:N IDs the caller does not own.
      // This prevents User B from saving A's terminal into their context and
      // reading A's scrollback on the next message via getScrollback.
      activeIds = activeIds.filter(function(srcId) {
        if (srcId.startsWith("tab:")) return require("./browser-extension-owner").mayUseExtension(browserState._extensionWs, ws._aigoraUser || null);
        if (!srcId.startsWith("term:")) return true;
        var tid = parseInt(srcId.split(":")[1], 10);
        return tm.getScrollback(tid, ws) !== null;
      });
      var _saveSessionId = ws._aigoraActiveSession || null;
      saveContextSources(slug, _saveSessionId, activeIds);
      return true;
    }

    // --- Browser Extension ---
    if (msg.type === "browser_tab_list") {
      browserState._extensionWs = ws; // Track which client has the extension
      if (msg.extensionId) browserState._extensionId = msg.extensionId;
      var tabs = msg.tabs || [];
      browserState._browserTabList = {};
      for (var bti = 0; bti < tabs.length; bti++) {
        browserState._browserTabList[tabs[bti].id] = tabs[bti];
      }
      return true;
    }

    if (msg.type === "extension_result") {
      var pending = browserState.pendingExtensionRequests[msg.requestId];
      if (pending) {
        clearTimeout(pending.timer);
        pending.resolve(msg.result);
        delete browserState.pendingExtensionRequests[msg.requestId];
      }
      return true;
    }

    // --- Scheduled tasks permission gate ---
    if (msg.type === "loop_start" || msg.type === "loop_stop" || msg.type === "loop_registry_files" ||
        msg.type === "loop_registry_save_files" || msg.type === "loop_registry_list" ||
        msg.type === "loop_registry_update" || msg.type === "loop_registry_rename" ||
        msg.type === "loop_registry_remove" || msg.type === "loop_registry_convert" ||
        msg.type === "loop_registry_toggle" || msg.type === "loop_registry_rerun" ||
        msg.type === "schedule_create" || msg.type === "schedule_move") {
      if (ws._aigoraUser) {
        var schPerms = usersModule.getEffectivePermissions(ws._aigoraUser, osUsers);
        if (!schPerms.scheduledTasks) {
          sendTo(ws, { type: "error", text: "Scheduled tasks access is not permitted" });
          return true;
        }
      }
    }

    // --- Loop message delegation (project-loop.js) ---
    if (_loop.handleLoopMessage(ws, msg)) return true;

    // --- Schedule message for after rate limit resets ---
    if (msg.type === "schedule_message") {
      var schedSession = getSessionForWs(ws);
      if (!schedSession || !msg.text || !msg.resetsAt) return true;
      scheduleMessage(schedSession, msg.text, msg.resetsAt, ws);
      return true;
    }

    if (msg.type === "cancel_scheduled_message") {
      var cancelSession = getSessionForWs(ws);
      if (!cancelSession) return true;
      cancelScheduledMessage(cancelSession);
      return true;
    }

    if (msg.type === "send_scheduled_now") {
      var nowSession = getSessionForWs(ws);
      if (!nowSession || !nowSession.scheduledMessage) return true;
      // lr-f7c100: reachable only via a live WS client explicitly forcing a
      // scheduled send — same human-presence rationale as the "message"
      // handler above.
      nowSession.humanOriginated = true;
      var schedText = nowSession.scheduledMessage.text;
      clearTimeout(nowSession.scheduledMessage.timer);
      nowSession.scheduledMessage = null;
      console.log("[project] Scheduled message sent immediately for session " + nowSession.localId);
      sm.sendAndRecord(nowSession, { type: "scheduled_message_sent" });
      var userMsg = { type: "user_message", text: schedText, _ts: Date.now() };
      // lr-2ea2a7: routes through the shared history-cap helper (see grep-guard
      // test) instead of pushing directly, so a long-running session's heap
      // history stays bounded even for scheduled-message injection.
      sm.recordHistoryEntry(nowSession, userMsg, true);
      sm.appendToSessionFile(nowSession, userMsg);
      sendToSession(nowSession.localId, userMsg);
      nowSession.isProcessing = true;
      onProcessingChanged();
      sendToSession(nowSession.localId, { type: "status", status: "processing" });
      sdk.startQuery(nowSession, schedText, null, ensureProjectAccessForSession(nowSession), ws);
      sm.broadcastSessionList();
      return true;
    }

    // Aigora room "조원에게 메시지": a plain human note to the room's members.
    // Recorded and broadcast like any history entry, but it is a distinct type
    // that no agent input path reads, so it never starts a turn, a run or routing.
    if (msg.type === "member_message") {
      var memberText = typeof msg.text === "string" ? msg.text.trim() : "";
      var memberImages = msg.images === undefined || msg.images === null ? [] : msg.images;
      var memberFileIds = msg.attachmentIds === undefined || msg.attachmentIds === null ? [] : msg.attachmentIds;
      if (!Array.isArray(memberImages) || !Array.isArray(memberFileIds)) return true;
      if (!memberText && !memberImages.length && !memberFileIds.length) return true;
      var memberSession = getSessionForWs(ws);
      var memberUser = ws._aigoraUser || null;
      var memberRole = null;
      if (memberSession && memberUser && memberSession.roomId) {
        try { memberRole = usersModule.getRoomRole(memberUser.id, memberSession.roomId) || null; } catch (e) { memberRole = null; }
      }
      if (!memberSession || !memberSession.roomId || isChannelBound(memberSession) || !memberRole || memberRole === "viewer") {
        sendTo(ws, { type: "error", text: "이 방에는 조원 메시지를 보낼 권한이 없습니다." });
        return true;
      }
      // Files: the same room-scoped check as an AI instruction's picks (the sender must be allowed to attach each one).
      // Fail closed: a pick that cannot be verified refuses the whole message, nothing is recorded.
      var memberFiles = [];
      if (memberFileIds.length) {
        try {
          if (typeof ctx.getAttachments !== "function") throw new Error("no attachments");
          memberFiles = ctx.getAttachments().selectForTurn({ id: memberUser.id }, memberSession, memberFileIds.slice(0, 50))
            .map(function (f) { return { id: f.id, name: f.name, size: f.size }; });
        } catch (e) {
          sendTo(ws, { type: "error", code: "attach_refused", text: e && e.code === "quota" ? "첨부한 파일이 너무 많거나 커서 보낼 수 없어요. 일부를 빼고 다시 보내 주세요." : "첨부한 파일을 사용할 수 없어요. 파일을 다시 골라 주세요." });
          return true;
        }
      }
      // Pictures: stored exactly like an AI instruction's (saveImageFile -> imageRefs); they never go to an agent.
      var memberImageRefs = [];
      if (memberImages.length) {
        var okType = /^image\/(png|jpeg|gif|webp)$/;
        var badImage = memberImages.length > 4 || memberImages.some(function (im) { return !im || !okType.test(im.mediaType) || typeof im.data !== "string" || !im.data; });
        if (!badImage) {
          for (var mi = 0; mi < memberImages.length; mi++) {
            var savedMember = saveImageFile(memberImages[mi].mediaType, memberImages[mi].data, getLinuxUserForSession(memberSession));
            if (!savedMember) { badImage = true; break; }
            memberImageRefs.push({ mediaType: memberImages[mi].mediaType, file: savedMember });
          }
        }
        if (badImage) {
          sendTo(ws, { type: "error", text: "이미지를 보낼 수 없어요. 다시 시도해 주세요." });
          return true;
        }
      }
      var memberProfile = memberUser.profile || {};
      var memberEntry = {
        type: "member_message",
        text: memberText.slice(0, 4000),
        from: memberUser.id,
        fromName: memberProfile.name || memberUser.displayName || memberUser.username || "",
        fromAvatar: {
          style: memberProfile.avatarStyle || "thumbs",
          seed: require("./user-visibility").avatarSeedOf(memberUser),
          color: memberProfile.avatarColor || "#7c3aed",
        },
        _ts: Date.now(),
      };
      if (memberImageRefs.length) { memberEntry.imageCount = memberImageRefs.length; memberEntry.imageRefs = memberImageRefs; }
      if (memberFiles.length) memberEntry.files = memberFiles;
      if (ctx.social) Object.assign(memberEntry, ctx.social.prepareMentions(memberSession, memberUser.id, memberEntry.text));
      sm.recordHistoryEntry(memberSession, memberEntry, true);
      sm.appendToSessionFile(memberSession, memberEntry);
      if (ctx.social) ctx.social.notifyMessage(memberSession, memberEntry);
      sendToSessionOthers(ws, memberSession.localId, hydrateImageRefs(memberEntry));
      if (memberEntry._mid) sendTo(ws, { type: "message_ack", mid: memberEntry._mid, text: memberEntry.text, mentions: memberEntry.mentions });
      return true;
    }

    // 👍/👎 on an automatically routed request: the engine accepts it only from the member who sent that request.
    if (msg.type === "run_feedback") {
      if (ws._aigoraUser && !ws._aigoraAccessRevoked && ctx.orchestrator && typeof ctx.orchestrator.feedback === "function") {
        var fb = ctx.orchestrator.feedback(ws._aigoraUser, msg.routeId, msg.value);
        if (fb && fb.ok) sendTo(ws, { type: "run_feedback_ack", routeId: fb.routeId, value: fb.value });
      }
      return true;
    }

    if (msg.type !== "message") return false;
    if (!msg.text && (!msg.images || msg.images.length === 0) && (!msg.pastes || msg.pastes.length === 0)) return true;

    var session = getSessionForWs(ws);
    if (!session) {
      // lr-5450ef: this used to be a bare `return true` — the message was
      // silently swallowed with no feedback to the sender whatsoever (not
      // even a server log line), the same silence-to-UI failure class as
      // the pendingMessages buffering fixed alongside this in sdk-bridge.js.
      // getSessionForWs returning null here means the client's websocket
      // has no session bound to it (e.g. stale/detached client, session
      // deleted from under it) — surface that instead of pretending the
      // message was handled.
      console.error("[project-user-message] Dropping user message: no session bound to this websocket (slug=" + slug + ")");
      sendTo(ws, { type: "error", text: "Aigora couldn't find your session — try reloading." });
      return true;
    }

    // A room's main thread is shared by everyone in the room: read-only members
    // (and anyone who lost access) cannot instruct the AI there.
    if (session.roomId && !isChannelBound(session) && ws._aigoraUser) {
      var sendRole = null;
      try { sendRole = usersModule.getRoomRole(ws._aigoraUser.id, session.roomId) || null; } catch (e) { sendRole = null; }
      if (!sendRole || sendRole === "viewer") {
        sendTo(ws, { type: "error", text: "이 방에서는 읽기만 할 수 있습니다." });
        return true;
      }
    }

    // Files attached to THIS instruction only (ids of room / own-channel files). Checked against the sender's access
    // before anything is recorded; a bad pick refuses the whole instruction.
    var turnFiles = null;
    if (Array.isArray(msg.attachmentIds) && msg.attachmentIds.length && ws._aigoraUser && typeof ctx.getAttachments === "function") {
      try { turnFiles = ctx.getAttachments().selectForTurn({ id: ws._aigoraUser.id }, session, msg.attachmentIds.slice(0, 50)); }
      catch (e) {
        sendTo(ws, { type: "error", code: "attach_refused", text: e && e.code === "quota" ? "첨부한 파일이 너무 많거나 커서 보낼 수 없어요. 일부를 빼고 다시 보내 주세요." : "첨부한 파일을 사용할 수 없어요. 파일을 다시 골라 주세요." });
        return true;
      }
    }

    // The composer's AI picker (`agent`): validated against the router's agent ids and availability before anything
    // is recorded. A bad pick refuses the whole instruction (the client restores the draft).
    var pickedAgent = null;
    if (msg.agent !== undefined && msg.agent !== null && msg.agent !== "") {
      var pickRefusal = !ctx.orchestrator ? "이 대화에서는 AI를 고를 수 없어요. 자동으로 보내 주세요."
        : ctx.orchestrator.checkPick(session, msg.agent, { images: !!(msg.images && msg.images.length), files: !!(turnFiles && turnFiles.length) });
      if (pickRefusal) {
        sendTo(ws, { type: "error", code: "agent_refused", text: pickRefusal });
        return true;
      }
      pickedAgent = msg.agent;
    }
    // A private session runs one executor at a time: an endpoint request or another vendor's turn still going (or a pick of
    // another executor while its own turn runs) holds the next message back, before anything is recorded.
    if (isChannelBound(session) && ctx.orchestrator && typeof ctx.orchestrator.privateBlocked === "function" && ctx.orchestrator.privateBlocked(session, pickedAgent, { accept: true })) {
      sendTo(ws, { type: "error", code: "agent_refused", text: PRIVATE_WAIT_TEXT });
      return true;
    }

    // lr-f7c100: this handler is reachable ONLY via a live WebSocket client
    // sending a {type:"message"} frame — headless session drivers
    // (project-loop.js's Ralph Loop iterations, project-external-trigger.js,
    // scheduler.js) build their own history entries and call sdk.startQuery
    // directly, never through here. That makes this the one structural (not
    // heuristic) point in the codebase where "a human is in this session" is
    // true by construction, independent of session state that a headless
    // caller could otherwise set. Sticky once set — later processing (e.g. a
    // scheduled message firing for the same session) never has a chance to
    // clear it, matching the "a session mints iff a human is in it" rule.
    session.humanOriginated = true;

    // Bind vendor to session on first message (if not already set)
    if (!session.vendor && msg.vendor) {
      session.vendor = msg.vendor;
      sm.saveSessionFile(session);
      sm.broadcastSessionList();
    }

    // Backfill ownerId for legacy sessions restored without one (multi-user only)
    if (!session.ownerId && ws._aigoraUser) {
      session.ownerId = ws._aigoraUser.id;
      sm.saveSessionFile(session);
    }

    // Keep any pending scheduled message alive when user sends a regular message

    var userMsg2 = { type: "user_message", text: msg.text || "" };
    // Attach sender info for multi-user attribution (backward-compatible: old clients ignore these)
    if (ws._aigoraUser) {
      userMsg2.from = ws._aigoraUser.id;
      userMsg2.fromName = ws._aigoraUser.displayName || ws._aigoraUser.username || "";
    }
    if (ctx.social && ws._aigoraUser) Object.assign(userMsg2, ctx.social.prepareMentions(session, ws._aigoraUser.id, userMsg2.text, true));
    var savedImagePaths = [];
    if (msg.images && msg.images.length > 0) {
      userMsg2.imageCount = msg.images.length;
      // Save images as files, store URL references in history
      var imageRefs = [];
      for (var imgIdx = 0; imgIdx < msg.images.length; imgIdx++) {
        var img = msg.images[imgIdx];
        var savedName = saveImageFile(img.mediaType, img.data, getLinuxUserForSession(session));
        if (savedName) {
          imageRefs.push({ mediaType: img.mediaType, file: savedName });
          savedImagePaths.push(path.join(imagesDir, savedName));
        }
      }
      if (imageRefs.length > 0) {
        userMsg2.imageRefs = imageRefs;
      }
    }
    if (msg.pastes && msg.pastes.length > 0) {
      userMsg2.pastes = msg.pastes;
    }
    // The files attached to this instruction (already validated above): history shows them as chips.
    if (turnFiles && turnFiles.length) userMsg2.attachedFiles = turnFiles.map(function (f) { return { id: f.id, name: f.name, size: f.size }; });
    if (!userMsg2._ts) userMsg2._ts = Date.now();

    // Aigora orchestration (room sessions only). The deterministic router
    // decides whether this message needs more than the room session's own
    // agent. Messages with images stay on the direct path (steps are
    // text-only), as does anything without an authenticated sender.
    var orchestrator = ctx.orchestrator || null;
    var orchestrationPlan = null;
    var hasImages = !!(msg.images && msg.images.length > 0);
    var carryFiles = !!(turnFiles && turnFiles.length);
    // Automatic selection only offers executors that can take the message's files or pictures (both room and private).
    var privateInfo = isChannelBound(session) ? { noEndpoint: carryFiles, files: carryFiles, images: hasImages } : (carryFiles || hasImages ? { files: carryFiles, images: hasImages } : undefined);
    var imagesViaPick = false;
    if (orchestrator && ws._aigoraUser && (!hasImages || imagesViaPick)) {
      try { orchestrationPlan = orchestrator.planFor(session, userMsg2, pickedAgent); } catch (e) {
        console.error("[project] orchestration routing skipped:", e.message);
      }
      // The picture-carrying pick was valid a moment ago; if it is no longer a write run, refuse rather than drop the pictures.
      if (imagesViaPick && !(orchestrationPlan && orchestrationPlan.steps.length === 1 && orchestrationPlan.steps[0].write === true)) {
        sendTo(ws, { type: "error", code: "agent_refused", text: "사진과 함께 보낼 때는 이 AI를 고를 수 없어요. 자동으로 보내 주세요." });
        return true;
      }
      if (orchestrationPlan) {
        var launchDenied = orchestrator.launchDenied(ws._aigoraUser.id, session);
        if (launchDenied) {
          // Refused before anything is recorded, so nothing half-runs.
          sendTo(ws, { type: "error", text: launchDenied === "viewer"
            ? "보기 전용 멤버는 에이전트 실행을 시작할 수 없습니다."
            : "이 방에서 에이전트를 실행할 권한이 없습니다." });
          return true;
        }
      }
    }

    // A request that may wait for a routing decision is persisted as "pending" and only becomes "dispatched" when its run
    // really starts; cancelled/denied/failed ones keep their state and never feed an execution recap (room-execution).
    var heldState = orchestrator ? semanticTails.get(session) : null;
    var mayHold = !!orchestrator && !!ws._aigoraUser && !hasImages
      && (!!(heldState && heldState.n > 0) || (typeof orchestrator.willDecide === "function" && orchestrator.willDecide(session, userMsg2, pickedAgent, privateInfo)));
    if (mayHold && !(heldState && heldState.n >= MAX_HELD)) userMsg2._exec = "pending";

    // lr-2ea2a7: routes through the shared history-cap helper (see grep-guard
    // test) instead of pushing directly.
    sm.recordHistoryEntry(session, userMsg2, true);
    sm.appendToSessionFile(session, userMsg2);
    if (ctx.social) ctx.social.notifyMessage(session, userMsg2);
    sendToSessionOthers(ws, session.localId, hydrateImageRefs(userMsg2));
    // The sender's own client never receives its message back, so tell it the
    // stable id that comments and pins anchor to.
    if (userMsg2._mid) sendTo(ws, { type: "message_ack", mid: userMsg2._mid, text: userMsg2.text, mentions: userMsg2.mentions });
    // Prompt coaching: author-only, separate store, never part of the turn (see project-prompt-coaching.js).
    if (ctx.coaching) ctx.coaching.onUserMessage(ws, session, userMsg2, { revisionOf: msg.coachedFrom });

    // A private-channel session still carrying its "새 세션" placeholder (never renamed by the user) takes a
    // cleaned preview of its first instruction; the auto-title refines it later (titleProvisional stays true).
    var placeholderTitle = isChannelBound(session) && session.title === NEW_CHANNEL_SESSION_TITLE
      && session.titleProvisional === true && !session.titleManuallySet && !session.titleAutoGenerated;
    if (placeholderTitle) {
      var preview = firstInstructionTitle(msg && msg.text);
      if (preview) session.title = preview;
      sm.saveSessionFile(session);
      sm.broadcastSessionList();
    } else if (!session.title) {
      session.title = deriveProvisionalTitle(msg);
      // This is only a provisional title — autoGenerateTitle (sdk-bridge.js)
      // is allowed to overwrite it once a real LLM-generated title is ready,
      // as long as the user hasn't manually renamed the session since.
      session.titleProvisional = true;
      sm.saveSessionFile(session);
      sm.broadcastSessionList();
      // Sync auto-title to SDK
      if (session.cliSessionId && !(sm.isPlaceholderCliId && sm.isPlaceholderCliId(session.cliSessionId))) { // a roommain- placeholder is no SDK session yet
        adapter.renameSession(session.cliSessionId, session.title, { dir: cwd }).catch(function(e) {
          console.error("[project] SDK renameSession failed:", e.message);
        });
      }
    }

    // Semantic routing (Clef). The message above is already accepted, recorded and acked in THIS session; what follows
    // is bound to that session and actor (captured here, never re-resolved from the socket). The decision can only
    // refine the plan of a run that has not started: Stop, a deleted session or lost launch rights drop it, a timeout
    // or failure keeps the deterministic plan. Messages accepted meanwhile wait their turn so order is preserved.
    var decision = null, heldCtl = null, dispatchDone = null;
    // Set for a non-explicit turn with executor selection on. If it ends up as a real turn of the session's own agent (no hidden-worker run,
    // no endpoint), that turn gets a run record and the decision its outcome (engine.recordBaseline).
    var baselineCtx = null;
    if (orchestrator && ws._aigoraUser && !hasImages && typeof orchestrator.decide === "function") {
      try { decision = orchestrator.decide(session, userMsg2, pickedAgent, ws._aigoraUser.id, privateInfo); } catch (e) { decision = null; }
    }
    var tailState = orchestrator ? semanticTails.get(session) : null;
    if (userMsg2._exec === "pending" && !decision && !(tailState && tailState.n > 0)) {
      // Nothing to wait for after all: the pending record already on disk must be superseded too.
      if (typeof sm.recordExecState === "function") sm.recordExecState(session, userMsg2, "dispatched");
      else { userMsg2._exec = "dispatched"; sm.saveSessionFile(session); }
    }
    if (decision || (tailState && tailState.n > 0)) {
      if (tailState && tailState.n >= MAX_HELD) {
        // Overload: do not queue without bound; start now with the deterministic plan.
        if (decision) { orchestrator.cancelDecisions(session); }
        return proceed();
      }
      var heldActorId = ws._aigoraUser && ws._aigoraUser.id;
      var handle = decision || orchestrator.hold(session, heldActorId);
      var prior = tailState ? tailState.tail : Promise.resolve();
      var mine = tailState || { tail: null, n: 0 };
      mine.n++;
      function endState(state) {
        try {
          if (typeof sm.recordExecState === "function") sm.recordExecState(session, userMsg2, state);
          else { userMsg2._exec = state; sm.saveSessionFile(session); }
        } catch (e) { userMsg2._exec = state; console.error("[project] could not persist execution state:", e && e.message); }
      }
      function terminal(text) { try { sm.sendAndRecord(session, { type: "error", text: text }); } catch (e) { sendTo(ws, { type: "error", text: text }); } }
      // Cancellation generation, socket revocation and launch permission, checked before the continuation proceeds AND
      // again right before the dispatch (browser-context collection can take a while). Marks the final state when false.
      function recheck() {
        var state = orchestrator.decisionState(session, handle.token, heldActorId, ws);
        var live = !sm.sessions || typeof sm.sessions.get !== "function" || sm.sessions.get(session.localId) === session;
        if (state === "cancelled" || !live) { endState("cancelled"); return false; } // Stop or a deleted session: no run
        if (state !== true) {
          endState("denied");
          terminal(state === "revoked" ? "접근 권한이 해제되어 이 지시를 실행하지 않았습니다." : "이 방에서 에이전트를 실행할 권한이 없어 이 지시를 실행하지 않았습니다.");
          return false;
        }
        return true;
      }
      heldCtl = {
        recheck: recheck,
        // The run really started: only now does the request become context for later turns.
        ok: function () { if (userMsg2._exec === "pending") endState("dispatched"); },
        fail: function (e) {
          console.error("[project] semantic routing dispatch failed:", e && e.message);
          if (userMsg2._exec === "pending") endState("failed");
          terminal("지시를 실행하지 못했어요. 다시 보내 주세요.");
        },
      };
      var held = Promise.race([prior, handle.cancelled]).then(function () { return orchestrator.settle(handle); }).then(function (res) {
        if (res.cancelled) { endState("cancelled"); return null; }
        if (!recheck()) return null;
        // A failing refinement is never fatal: the baseline plan still runs.
        try { if (res.plan) { var refined = orchestrator.applyRefinement(session, userMsg2, res.plan, privateInfo); if (refined) orchestrationPlan = refined; } }
        catch (e) { console.error("[project] semantic refinement ignored:", e && e.message); }
        // What the decision did is recorded (chip, ledger, outcome) just before the dispatch, from the plan that really runs.
        var routeId = null;
        try { if (res.decision && typeof orchestrator.announceRoute === "function") routeId = orchestrator.announceRoute({ session: session, userMsg: userMsg2, actor: { id: heldActorId }, decision: res.decision, plan: orchestrationPlan }); }
        catch (e) { console.error("[project] route record ignored:", e && e.message); }
        if (res.decision || res.baseline === true) baselineCtx = { decision: res.decision || null, routeId: routeId };
        // The tail waits for the real dispatch start (including browser-context collection), not just the call.
        try { proceed(); return dispatchDone; } catch (e) { return Promise.reject(e); }
      }).catch(function (e) {
        console.error("[project] semantic routing continuation failed:", e && e.message);
        if (userMsg2._exec === "pending") endState("failed");
        terminal("지시를 실행하지 못했어요. 다시 보내 주세요.");
      }).then(function () {
        try { handle.release(); } catch (e) {}
        mine.n--;
        if (mine.n <= 0) semanticTails.delete(session);
      });
      mine.tail = held;
      semanticTails.set(session, mine);
      return true;
    }
    return proceed();

    function proceed() {
    // An agent the member chose explicitly (picker, @mention, "코덱스로 해줘") alone is a real contained room turn, like
    // the room's own AI, not a read-only hidden worker: it runs in the room's main session for that vendor and
    // reports into this feed. Automatic signal steps and multi-step plans keep the hidden workers.
    var turnSession = session;
    var privToken = null;
    function releasePriv() { if (privToken && orchestrator) { try { orchestrator.privateRelease(session, privToken); } catch (_) {} } }
    function privateFail(text) {
      if (heldCtl && userMsg2._exec === "pending") { try { sm.recordExecState ? sm.recordExecState(session, userMsg2, "failed") : sm.saveSessionFile(session); } catch (_) {} }
      try { sm.sendAndRecord(session, { type: "error", text: text }); } catch (_) { sendTo(ws, { type: "error", text: text }); }
    }
    var pickedVendor = orchestrationPlan && session.roomMain === true ? pickedSessionAgent(orchestrationPlan) : null;
    if (pickedVendor && roomExec.isContained(session, pickedVendor)) {
      var vendorMain = createRoomMainThread({ sm: sm }).ensureVendor(usersModule, session.roomId, pickedVendor);
      if (vendorMain) { turnSession = vendorMain; orchestrationPlan = null; }
    }
    // "<agent> works, another verifies": the work is the room's real contained turn of that agent (like a picker choice),
    // and the verify step runs read-only on its result once the turn ends cleanly (engine.verifyAfterTurn, armed at dispatch).
    var verifyPlan = null;
    var wv = !pickedVendor && orchestrationPlan && session.roomMain === true && typeof orchestrator.verifyAfterTurn === "function" ? workThenVerify(orchestrationPlan) : null;
    if (wv && roomExec.isContained(session, wv.work)) {
      var workMain = createRoomMainThread({ sm: sm }).ensureVendor(usersModule, session.roomId, wv.work);
      if (workMain) { turnSession = workMain; verifyPlan = orchestrationPlan; orchestrationPlan = null; }
    }

    // Private session: the picked or decided executor runs alone. A vendor other than the session's own runs on that vendor's
    // per-session private thread (mirrored into this feed); an endpoint is a text-only chat the engine starts. Never a room
    // plan, never hidden workers.
    if (orchestrationPlan && isChannelBound(session)) {
      var privPlan = orchestrationPlan.private === true && Array.isArray(orchestrationPlan.steps) && orchestrationPlan.steps.length === 1 ? orchestrationPlan : null;
      orchestrationPlan = null;
      if (!privPlan) return true;
      if (heldCtl && !heldCtl.recheck()) return true;
      var privStep = privPlan.steps[0];
      var privTextOnly = privStep.agent === "local"; // endpoint answers do not use a vendor thread
      if (privTextOnly && orchestrator.privateBlocked(session, privStep.agent)) { privateFail(PRIVATE_WAIT_TEXT); return true; }
      if (privTextOnly) {
        try {
          orchestrator.runPrivateEndpoint({ actor: ws._aigoraUser, ws: ws, session: session, userMsg: userMsg2, plan: privPlan, info: privateInfo,
            // The one-time fallback of a Clef-chosen endpoint can hand the same message to Claude/Codex.
            runVendor: function (vendor) { orchestrationPlan = { private: true, steps: [{ index: 0, agent: vendor, role: "mention", reason: "fallback." + vendor }] }; return proceed(); } });
          if (heldCtl) heldCtl.ok();
        } catch (e) { privateFail(e && e.status && e.status < 500 ? e.message : "지시를 실행하지 못했어요. 다시 보내 주세요."); }
        return true;
      }
      // The whole feed is reserved before anything asynchronous (browser context) happens, for the vendor captured in the plan.
      privToken = orchestrator.privateReserve(session, privStep.agent);
      if (!privToken) { privateFail(PRIVATE_WAIT_TEXT); return true; }
      var privThread = null;
      try { privThread = createPrivateVendorThread({ sm: sm }).ensure(session, privStep.agent, orchestrator.privateOwnVendor(session)); } catch (e) { privThread = null; }
      if (!privThread) { releasePriv(); privateFail("지금은 이 AI로 보낼 수 없어요. 다시 보내 주세요."); return true; }
      turnSession = privThread;
    }
    // A private message without a plan runs on the session's own vendor: reserved the same way.
    if (!orchestrationPlan && !privToken && orchestrator && isChannelBound(session) && typeof orchestrator.privateReserve === "function") {
      privToken = orchestrator.privateReserve(session, orchestrator.privateOwnVendor(session));
      if (!privToken) { privateFail(PRIVATE_WAIT_TEXT); return true; }
    }

    if (orchestrationPlan) {
      // The run's steps execute in hidden workers and report back into this
      // conversation; the root session's own agent is not queried now.
      if (heldCtl && !heldCtl.recheck()) return true;
      // Hidden-worker steps take files only as a single write run: anything else would drop them silently, so say so.
      var filesNo = turnFiles && turnFiles.length && typeof orchestrator.filesRefusal === "function" ? orchestrator.filesRefusal(session, orchestrationPlan) : null;
      if (filesNo) {
        if (heldCtl && userMsg2._exec === "pending") { userMsg2._exec = "failed"; try { sm.recordExecState ? sm.recordExecState(session, userMsg2, "failed") : sm.saveSessionFile(session); } catch (_) {} }
        sm.sendAndRecord(session, { type: "error", text: filesNo });
        return true;
      }
      try {
        // turnFiles (attachment picks) and saved pictures reach a write run's inbox; the engine ignores them for any other run.
        orchestrator.submit({ actor: ws._aigoraUser, session: session, userMsg: userMsg2, plan: orchestrationPlan, turnFiles: turnFiles || [],
          turnImages: (userMsg2.imageRefs || []).map(function (r) { return { mediaType: r.mediaType, path: path.join(imagesDir, r.file) }; }) });
        if (heldCtl) heldCtl.ok();
      } catch (e) {
        sm.sendAndRecord(session, { type: "error", text: e && e.status && e.status < 500 ? e.message : "Aigora orchestration could not start." });
        if (heldCtl && userMsg2._exec === "pending") { userMsg2._exec = "failed"; try { sm.recordExecState ? sm.recordExecState(session, userMsg2, "failed") : sm.saveSessionFile(session); } catch (_) {} }
      }
      return true;
    }

    var fullText = userMsg2.text;
    // Prepend saved image paths so Claude can copy/save them
    if (savedImagePaths.length > 0) {
      var imgPathLines = savedImagePaths.map(function (p) { return "[Uploaded image: " + p + "]"; }).join("\n");
      fullText = imgPathLines + (fullText ? "\n" + fullText : "");
    }
    if (msg.pastes && msg.pastes.length > 0) {
      for (var pi = 0; pi < msg.pastes.length; pi++) {
        if (fullText) fullText += "\n\n";
        fullText += msg.pastes[pi];
      }
    }

    // Inject pending @mention context so the current agent sees the exchange
    if (session.pendingMentionContexts && session.pendingMentionContexts.length > 0) {
      var mentionPrefix = session.pendingMentionContexts.join("\n\n");
      session.pendingMentionContexts = [];
      fullText = mentionPrefix + "\n\n" + fullText;
    }

    // Inject active terminal context sources (delta only: send new output since last message)
    var TERM_CONTEXT_MAX = 8192; // 8KB max per terminal per message
    var TERM_HEAD_SIZE = 2048;   // keep first 2KB for error context
    var TERM_TAIL_SIZE = 6144;   // keep last 6KB for recent state
    var ctxSources = loadContextSources(slug, session.localId);
    if (ctxSources.length > 0) {
      if (!session._termContextCursors) session._termContextCursors = {};
      var termContextParts = [];
      for (var ci = 0; ci < ctxSources.length; ci++) {
        var srcId = ctxSources[ci];
        if (srcId.startsWith("term:")) {
          var termId = parseInt(srcId.split(":")[1], 10);
          var sb = tm.getScrollback(termId, ws);
          if (sb) {
            var lastCursor;
            if (termId in session._termContextCursors) {
              lastCursor = session._termContextCursors[termId];
              // Terminal was recycled (closed and reopened with same ID) -- reset cursor
              if (lastCursor > sb.totalBytesWritten) lastCursor = 0;
            } else {
              // First time seeing this terminal -- include last 8KB (what user can see now)
              lastCursor = Math.max(0, sb.totalBytesWritten - TERM_CONTEXT_MAX);
            }
            var newBytes = sb.totalBytesWritten - lastCursor;
            session._termContextCursors[termId] = sb.totalBytesWritten;
            if (newBytes <= 0) continue;
            // Build timestamped delta from chunks
            var deltaChunks = [];
            var bytePos = sb.bufferStart;
            for (var chunkIdx = 0; chunkIdx < sb.chunks.length; chunkIdx++) {
              var chunk = sb.chunks[chunkIdx];
              var chunkEnd = bytePos + chunk.data.length;
              if (chunkEnd > lastCursor) {
                // This chunk has new content
                var chunkData = chunk.data;
                if (bytePos < lastCursor) {
                  // Partial chunk: only the part after lastCursor
                  chunkData = chunkData.slice(lastCursor - bytePos);
                }
                deltaChunks.push({ ts: chunk.ts, data: chunkData });
              }
              bytePos = chunkEnd;
            }
            if (deltaChunks.length === 0) continue;
            // Format with timestamps: group by second to avoid excessive timestamps
            var lines = [];
            var lastTimeSec = 0;
            for (var di = 0; di < deltaChunks.length; di++) {
              var dc = deltaChunks[di];
              var cleaned = dc.data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
              if (!cleaned) continue;
              var timeSec = Math.floor(dc.ts / 1000);
              if (timeSec !== lastTimeSec) {
                var d = new Date(dc.ts);
                var timeStr = d.toTimeString().slice(0, 8); // HH:MM:SS
                lines.push("[" + timeStr + "] " + cleaned);
                lastTimeSec = timeSec;
              } else {
                lines.push(cleaned);
              }
            }
            var delta = lines.join("").trim();
            if (!delta) continue;
            var termInfo = tm.list(ws).find(function(t) { return t.id === termId; });
            var termTitle = termInfo ? termInfo.title : "Terminal " + termId;
            var header;
            if (delta.length > TERM_CONTEXT_MAX) {
              var head = delta.slice(0, TERM_HEAD_SIZE);
              var tail = delta.slice(-TERM_TAIL_SIZE);
              var omittedBytes = delta.length - TERM_HEAD_SIZE - TERM_TAIL_SIZE;
              var omittedLines = delta.slice(TERM_HEAD_SIZE, delta.length - TERM_TAIL_SIZE).split("\n").length;
              delta = head + "\n\n... (" + omittedLines + " lines / " + Math.round(omittedBytes / 1024) + "KB omitted) ...\n\n" + tail;
              header = "[New terminal output from " + termTitle + " (large output, head+tail shown)]";
            } else {
              header = "[New terminal output from " + termTitle + "]";
            }
            termContextParts.push(header + "\n```\n" + delta + "\n```");
          }
        }
      }
      if (termContextParts.length > 0) {
        fullText = termContextParts.join("\n\n") + "\n\n" + fullText;
      }
    }

    // Collect browser tab context (async: requires round-trip to client extension)
    var _browserTabList = browserState._browserTabList;
    var tabSources = ctxSources.filter(function(id) {
      if (!id.startsWith("tab:")) return false;
      // Only include tabs that currently exist in the browser
      var tid = parseInt(id.split(":")[1], 10);
      // A live extension socket owned by someone else is never read for this actor (requestTabContext re-checks at collection time).
      return !!_browserTabList[tid] && (!browserState._extensionWs || require("./browser-extension-owner").mayUseExtension(browserState._extensionWs, ws._aigoraUser || null));
    });

    function dispatchToSdk(finalText) {
      try {
        // The reservation is checked again: another executor may have started on this feed while the context was collected.
        if (privToken) {
          if (orchestrator.privateBlocked(session, privToken.agent, { token: privToken })) { privateFail(PRIVATE_WAIT_TEXT); return; }
          // The executor is the vendor captured when the message was accepted, resolved again now: a feed whose vendor was
          // switched meanwhile never turns this message into a turn of the new vendor.
          var captured = null;
          try { captured = createPrivateVendorThread({ sm: sm }).ensure(session, privToken.agent, orchestrator.privateOwnVendor(session)); } catch (_) { captured = null; }
          if (!captured) { privateFail("지금은 이 AI로 보낼 수 없어요. 다시 보내 주세요."); return; }
          turnSession = captured;
        }
        return dispatchToSdkInner(finalText);
      } finally { releasePriv(); } // the executor's running flag (or a refusal) takes over
    }
    function dispatchToSdkInner(finalText) {
      // Last gate before anything starts: Stop, revocation or lost launch rights during browser-context collection.
      if (heldCtl && !heldCtl.recheck()) return;
      var startedP = null, baselineGuard = null;
      if (!turnSession.isProcessing) {
        turnSession.isProcessing = true;
        onProcessingChanged();
        turnSession.sentToolResults = {};
        // A watcher left by an earlier turn is stale (every turn ends with a done record): never reuse it.
        turnSession.onTurnRecord = null; turnSession._turnWatch = null;
        // This turn's files, whichever way it starts: a warm contained handle (queryInstance already open) takes the
        // push branch below and reads them there; setting them only for startQuery lost them for every such turn.
        turnSession._turnFiles = turnFiles;
        // Every new turn boundary (explicit turns too) closes a baseline record that an earlier turn left open.
        if (orchestrator && typeof orchestrator.abandonBaseline === "function") orchestrator.abandonBaseline(turnSession);
        if (baselineCtx && !verifyPlan && typeof orchestrator.recordBaseline === "function") {
          baselineGuard = orchestrator.recordBaseline({ session: session, turnSession: turnSession, actor: ws._aigoraUser, userMsg: userMsg2, decision: baselineCtx.decision, routeId: baselineCtx.routeId,
            agent: privToken ? privToken.agent : (turnSession.vendor === "codex" ? "codex" : "claude") }) || null;
        }
        if (verifyPlan) orchestrator.verifyAfterTurn({ actor: ws._aigoraUser, session: session, turnSession: turnSession, userMsg: userMsg2, plan: verifyPlan });
        sendToSession(session.localId, { type: "status", status: "processing" });
        if (!turnSession.queryInstance && (!turnSession.worker || turnSession.messageQueue !== "worker")) {
          // No active query (or worker idle between queries): start a new query
          turnSession._queryStartTs = Date.now();
          // _turnFiles is consumed once at the turn start (sdk-bridge inboxNote)
          console.log("[PERF] project.js: startQuery called, localId=" + turnSession.localId + " t=0ms");
          startedP = sdk.startQuery(turnSession, finalText, msg.images, ensureProjectAccessForSession(turnSession), ws);
        } else {
          if (turnSession._turnWatch) turnSession._turnWatch.started = true; // no startQuery for this turn: the watcher is already bound
          sdk.pushMessage(turnSession, finalText, msg.images, ws);
        }
      } else {
        sdk.pushMessage(turnSession, finalText, msg.images, ws);
        if (turnSession._turnWatch) turnSession._turnWatch.tainted = true; // another message joined a watched turn: no verify
        if (turnFiles && turnFiles.length) sendTo(ws, { type: "info", text: "AI가 작업 중이라 이번 지시에는 파일을 첨부하지 못했어요. 끝난 뒤 다시 첨부해 보내 주세요." });
      }
      // A held request becomes "dispatched" only once the SDK query has started; a rejected start ends it "failed".
      // (Unconfigured/default path: heldCtl is null and the start promise is left alone, as before.)
      // A start that is refused or rejected without a done record ends the baseline record as failed. The derived promise keeps the
      // original rejection's fate: it is rethrown only where nothing else handled the start (no held request).
      if (baselineGuard) {
        if (startedP && typeof startedP.then === "function") startedP.then(function () { baselineGuard.check(false); }, function (e) { baselineGuard.check(true); if (!heldCtl) throw e; });
        else baselineGuard.check(false);
      }
      if (heldCtl) {
        if (startedP && typeof startedP.then === "function") startedP.then(heldCtl.ok, heldCtl.fail);
        else heldCtl.ok();
      }
      sm.broadcastSessionList();
    }

    if (tabSources.length > 0) {
      // Request tab context from all active browser tab sources
      var tabPromises = tabSources.map(function(srcId) {
        var tabId = parseInt(srcId.split(":")[1], 10);
        return requestTabContext(tabId, ws._aigoraUser || null);
      });
      dispatchDone = Promise.all(tabPromises).then(function(results) {
        if (heldCtl && !heldCtl.recheck()) return; // Stop/revocation while collecting: no side effects, no dispatch
        var tabContextParts = [];
        var screenshotImages = [];

        for (var ti = 0; ti < results.length; ti++) {
          if (!results[ti]) continue;
          var tabId2 = parseInt(tabSources[ti].split(":")[1], 10);
          var tabInfo = _browserTabList[tabId2];
          var tabLabel = tabInfo ? (tabInfo.title || tabInfo.url || "Tab " + tabId2) : "Tab " + tabId2;
          var r = results[ti];
          var parts = [];

          // Console logs
          if (r.console && r.console.logs) {
            try {
              var logs = typeof r.console.logs === "string" ? JSON.parse(r.console.logs) : r.console.logs;
              if (logs && logs.length > 0) {
                var logLines = [];
                var logSlice = logs.slice(-50);
                for (var li = 0; li < logSlice.length; li++) {
                  var entry = logSlice[li];
                  var ts = entry.ts ? new Date(entry.ts).toTimeString().slice(0, 8) : "";
                  var lvl = (entry.level || "log").toUpperCase();
                  logLines.push("[" + ts + " " + lvl + "] " + (entry.text || ""));
                }
                parts.push("Console:\n" + logLines.join("\n"));
              }
            } catch (e) {
              // ignore parse errors
            }
          }

          // Network requests
          if (r.network && r.network.network) {
            try {
              var netLog = typeof r.network.network === "string" ? JSON.parse(r.network.network) : r.network.network;
              if (netLog && netLog.length > 0) {
                var netLines = [];
                var netSlice = netLog.slice(-30);
                for (var ni = 0; ni < netSlice.length; ni++) {
                  var req = netSlice[ni];
                  var line = (req.method || "GET") + " " + (req.url || "") + " " + (req.status || 0) + " " + (req.duration || 0) + "ms";
                  if (req.error) line += " [" + req.error + "]";
                  netLines.push(line);
                }
                parts.push("Network (last " + netSlice.length + " requests):\n" + netLines.join("\n"));
              }
            } catch (e) {
              // ignore parse errors
            }
          }

          // Page text (from tab_page_text command)
          if (r.pageText && (r.pageText.text || r.pageText.value)) {
            var pageContent = r.pageText.text || r.pageText.value;
            if (pageContent.length > 0) {
              if (pageContent.length > 32768) {
                pageContent = pageContent.substring(0, 32768) + "\n... (truncated)";
              }
              parts.push("Page text:\n" + pageContent);
            }
          }

          // Screenshot -- save to disk and add to images for SDK
          if (r.screenshot && r.screenshot.image) {
            try {
              var screenshotData = r.screenshot.image;
              var screenshotName = saveImageFile("image/png", screenshotData, getLinuxUserForSession(session));
              if (screenshotName) {
                var screenshotPath = path.join(imagesDir, screenshotName);
                // Add to images array for SDK multimodal
                screenshotImages.push({
                  mediaType: "image/png",
                  data: screenshotData,
                  file: screenshotName,
                  tabTitle: tabLabel,
                  tabUrl: tabInfo ? tabInfo.url : "",
                  tabFavIconUrl: tabInfo ? tabInfo.favIconUrl : ""
                });
                parts.push("[Screenshot saved: " + screenshotPath + "]");
              }
            } catch (e) {
              // ignore screenshot save errors
            }
          }

          if (r.console && r.console.error) {
            parts.push("(Console error: " + r.console.error + ")");
          }
          if (r.network && r.network.error) {
            parts.push("(Network error: " + r.network.error + ")");
          }

          if (parts.length > 0) {
            tabContextParts.push("[Browser tab: " + tabLabel + "]\n" + parts.join("\n\n"));
          }
        }

        if (tabContextParts.length > 0) {
          fullText = "[The following browser tab data is automatically attached as context sources. Do NOT call browser_read_page, browser_console, browser_network, or browser_screenshot for these tabs -- the data is already here.]\n\n" +
            tabContextParts.join("\n\n---\n\n") + "\n\n" + fullText;
        }

        // If screenshots were captured, send context preview cards and add to SDK images
        if (screenshotImages.length > 0) {
          if (!msg.images) msg.images = [];
          for (var si = 0; si < screenshotImages.length; si++) {
            var ss = screenshotImages[si];
            // Save context_preview to history so it restores on session load
            var previewEntry = {
              type: "context_preview",
              tab: {
                title: ss.tabTitle || "",
                url: ss.tabUrl || "",
                favIconUrl: ss.tabFavIconUrl || "",
                screenshotFile: ss.file
              }
            };
            // lr-2ea2a7: routes through the shared history-cap helper (see
            // grep-guard test) instead of pushing directly.
            // Note (lr-f940): this push is not paired with appendToSessionFile
            // (unlike every other .history.push site in this file), so pass
            // persisted=false — sm.saveSessionFile()'s historyMatchesDisk()
            // length check below will detect the mismatch and still do a
            // full rewrite, exactly as before this fix.
            sm.recordHistoryEntry(session, previewEntry, false);
            // Send context card to all clients
            sendToSession(session.localId, {
              type: "context_preview",
              tab: {
                title: ss.tabTitle || "",
                url: ss.tabUrl || "",
                favIconUrl: ss.tabFavIconUrl || "",
                screenshotUrl: "/p/" + slug + "/images/" + ss.file
              }
            });
            // Add to SDK images for multimodal
            msg.images.push({ mediaType: ss.mediaType, data: ss.data });
          }
          sm.saveSessionFile(session);
        }

        dispatchToSdk(fullText);
      });
      dispatchDone = dispatchDone.then(releasePriv, function (e) { releasePriv(); throw e; });
    } else {
      dispatchToSdk(fullText);
    }

    return true;
    } // proceed
  }

  return {
    handleUserMessage: handleUserMessage,
  };
}

module.exports = { attachUserMessage: attachUserMessage, _test_deriveProvisionalTitle: deriveProvisionalTitle };


return module.exports;
});

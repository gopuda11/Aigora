// project-prompt-coaching.js - Server glue for prompt coaching ("더 나은 지시").
//
// onUserMessage runs once per AI-directed user_message (room "AI에게 지시" and private sessions), after the
// message is recorded. It computes the deterministic rubric (lib/prompt-coaching.js), keeps it in a separate
// per-user store (never in session history, never an agent event), and sends it ONLY to the author's own
// sockets. Other members and admins learn of it only if the author explicitly shares it (coaching_share):
// then it becomes a coaching_share_card in the room's main thread (a history type no agent input path reads)
// and the shared rubric is sent to the room's members. There is no ranking or score board anywhere.
// Any failure here is swallowed: coaching can never alter or block execution.

var path = require("path");
var { isChannelBound } = require("./private-session-access");
var { coachPrompt } = require("./prompt-coaching");
var { createCoachingStore } = require("./prompt-coaching-store");
var { createRoomMainThread } = require("./room-main-thread");
var ai = require("./prompt-coaching-ai");
var { createPrivateSessionAccess } = require("./private-session-access");

var ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/;

// What a client may see of a result: statuses and reasons, never anything internal.
function publicResult(r) {
  return {
    score: r.score, level: r.level, hint: r.hint, suggestion: r.suggestion,
    criteria: (r.criteria || []).map(function (c) { return { id: c.id, label: c.label, status: c.status, reason: c.reason }; }),
  };
}

function attachPromptCoaching(ctx) {
  var sm = ctx.sm;
  var users = ctx.usersModule;
  var store = ctx.store || createCoachingStore({ dir: path.join(require("./config").CONFIG_DIR, "prompt-coaching") });
  var roomMain = createRoomMainThread({ sm: sm });
  var slug = typeof ctx.slug === "string" ? ctx.slug : "";
  // One limiter for the whole daemon (not per project): the budget is per user, whichever project the request is in.
  var limiter = ctx.limiter || ai.daemonLimiter();
  var oneShot = ctx.complete || ai.createOneShot({ adapter: ctx.adapter, users: users });

  function enabledFor(userId) {
    try { var u = users.findUserById(userId); return !(u && u.promptCoaching === false); } catch (_) { return true; }
  }
  function ownSockets(ws, userId) {
    var out = [ws];
    if (ctx.clients) ctx.clients.forEach(function (c) {
      if (c !== ws && c._aigoraUser && c._aigoraUser.id === userId && c.readyState === 1) out.push(c);
    });
    return out;
  }
  function payload(entry, shared, authorId) {
    var out = { type: "prompt_coaching", sessionId: entry.sessionId, mid: entry.id, ts: entry.ts, shared: !!shared, authorId: authorId, result: entry.result };
    // The author's own sockets also get what the history view needs; the room-wide shared copy carries none of it.
    if (!shared) { out.text = entry.text; out.roomId = entry.roomId; if (entry.revisionOf) out.revisionOf = entry.revisionOf; }
    return out;
  }

  // HOOK: an optional LLM explanation (lib/prompt-coaching.js explainWithLlm) would be requested here, only
  // for ambiguous prompts or when the author explicitly asks. Not implemented; no model is ever called.
  function onUserMessage(ws, session, userMsg, extra) {
    try {
      var user = ws && ws._aigoraUser;
      if (!user || !session || !userMsg || !userMsg._mid || !enabledFor(user.id)) return;
      var result = coachPrompt(userMsg.text);
      if (!result.applicable) return;
      var entry = {
        id: userMsg._mid, sessionId: String(session.localId), roomId: typeof session.roomId === "string" ? session.roomId : null,
        // The stable identity "AI로 완성하기" must match later: localId is project-local and reassigned on restart.
        sessionUid: typeof session.uid === "string" && session.uid ? session.uid : null, slug: slug,
        channelId: isChannelBound(session) ? String(session.channelId) : null,
        private: isChannelBound(session),
        ts: userMsg._ts || Date.now(), text: userMsg.text, result: publicResult(result),
      };
      if (extra && typeof extra.revisionOf === "string" && ID_RE.test(extra.revisionOf)) entry.revisionOf = extra.revisionOf;
      store.record(user.id, entry);
      var msg = payload(entry, false, user.id);
      ownSockets(ws, user.id).forEach(function (c) { try { ctx.sendTo(c, msg); } catch (_) { /* next socket */ } });
    } catch (e) {
      console.error("[prompt-coaching] skipped:", e && e.message);
    }
  }

  function toRoom(roomId, obj) {
    ctx.clients.forEach(function (c) {
      var u = c._aigoraUser;
      var ok = false;
      try { ok = !!u && !!users.getRoomRole(u.id, roomId); } catch (_) { ok = false; }
      if (ok) { try { ctx.sendTo(c, obj); } catch (_) { /* keep broadcasting */ } }
    });
  }
  function authorName(user) {
    var p = user.profile || {};
    return p.name || user.displayName || user.username || "";
  }

  function share(ws, id) {
    var user = ws._aigoraUser;
    var entry = typeof id === "string" && ID_RE.test(id) ? store.get(user.id, id) : null;
    if (!entry || !entry.roomId) return ctx.sendTo(ws, { type: "coaching_error", code: "not_found" });
    var role = null;
    try { role = users.getRoomRole(user.id, entry.roomId) || null; } catch (_) { role = null; }
    if (role !== "owner" && role !== "member") return ctx.sendTo(ws, { type: "coaching_error", code: "forbidden" });
    if (!entry.shared) {
      var saved = store.markShared(user.id, entry.id);
      if (!saved) return ctx.sendTo(ws, { type: "coaching_error", code: "failed" });
      entry = saved;
      // The earlier prompt this one revised, when the author built it from a suggestion.
      var prior = entry.revisionOf ? store.get(user.id, entry.revisionOf) : null;
      var before = prior ? prior.text : "";
      try {
        roomMain.append(users, entry.roomId, {
          type: "coaching_share_card", shareId: entry.id, authorId: user.id, authorName: authorName(user),
          text: entry.text, before: before, suggestion: entry.result.suggestion || "",
          criteria: entry.result.criteria.map(function (c) { return { id: c.id, label: c.label, status: c.status }; }),
          _ts: entry.sharedAt,
        });
      } catch (_) { /* the share stands without its card */ }
      // A private session's id stays out of other members' sockets; the card above is what they see.
      if (!entry.private) toRoom(entry.roomId, payload(entry, true, user.id));
    }
    ctx.sendTo(ws, { type: "coaching_shared", mid: entry.id });
  }

  // --- AI로 완성하기: only on the author's explicit request, one tool-less model call, result to the author's sockets only ---

  // The session an entry was written in, found by its stable uid (never by the restart-reassigned localId).
  function findSessionByUid(uid) {
    var found = null;
    if (sm.sessions && typeof sm.sessions.forEach === "function") sm.sessions.forEach(function (s) { if (!found && s && s.uid === uid) found = s; });
    return found;
  }
  // An entry carries the identity of the session it was written in; entries from before that was recorded lack it.
  function hasIdentity(entry) {
    return typeof entry.sessionUid === "string" && !!entry.sessionUid && typeof entry.slug === "string" && "channelId" in entry && "roomId" in entry;
  }
  // The author may still use this entry's session: the session's stable uid, project, room and channel must ALL equal
  // what the entry recorded, then a current non-viewer room member for the room feed, the owner for a private channel
  // session. Anything else (no room, mismatch, missing session, throwing lookups) is refused.
  function mayComplete(user, entry, session) {
    try {
      if (!session || !hasIdentity(entry) || session.uid !== entry.sessionUid || entry.slug !== slug) return false;
      if (isChannelBound(session)) {
        if (!entry.private || entry.channelId !== String(session.channelId) || session.ownerId !== user.id || (entry.roomId || null) !== (session.roomId || null)) return false;
        createPrivateSessionAccess(users).assertSessionAction(user, session, { visibility: "public" }, "mutate");
        return true;
      }
      if (entry.private || entry.channelId !== null || typeof session.roomId !== "string" || !session.roomId || entry.roomId !== session.roomId) return false;
      var role = users.getRoomRole(user.id, session.roomId) || null;
      return role === "owner" || role === "member";
    } catch (_) { return false; }
  }
  function placeName(user, session) {
    try {
      if (isChannelBound(session)) {
        var c = ctx.channels && ctx.channels.getChannelSync ? ctx.channels.getChannelSync(session.channelId) : null;
        if (c && typeof c.name === "string" && c.name) return c.name;
      }
      var room = users.findRoomById(session.roomId);
      return room && typeof room.name === "string" ? room.name : "";
    } catch (_) { return ""; }
  }
  function completeFail(ws, user, mid, code) {
    ownSockets(ws, user.id).forEach(function (c) { try { ctx.sendTo(c, { type: "coaching_complete_error", mid: mid, code: code }); } catch (_) { /* next */ } });
  }
  function complete(ws, msg) {
    var user = ws._aigoraUser;
    var id = msg && typeof msg.id === "string" && ID_RE.test(msg.id) ? msg.id : null;
    if (!user || ws._aigoraAccessRevoked) return ctx.sendTo(ws, { type: "coaching_complete_error", mid: id, code: "forbidden" });
    // The store is the caller's own: another member's entry id is simply not there.
    var entry = id ? store.get(user.id, id) : null;
    if (!entry) return ctx.sendTo(ws, { type: "coaching_complete_error", mid: id, code: "not_found" });
    if (!enabledFor(user.id)) return ctx.sendTo(ws, { type: "coaching_complete_error", mid: id, code: "forbidden" });
    if (!hasIdentity(entry)) return ctx.sendTo(ws, { type: "coaching_complete_error", mid: id, code: "resend" });
    var session = findSessionByUid(entry.sessionUid);
    if (!mayComplete(user, entry, session)) return ctx.sendTo(ws, { type: "coaching_complete_error", mid: id, code: "forbidden" });
    var criteria = (entry.result && Array.isArray(entry.result.criteria)) ? entry.result.criteria : [];
    // Everything below comes from this one session and this one entry. A message that is not in the session is refused.
    var turns = ai.collectTurns(session.history, entry.id);
    if (!turns) return ctx.sendTo(ws, { type: "coaching_complete_error", mid: id, code: "not_found" });
    var slot = limiter.acquire(user.id);
    if (!slot.ok) return ctx.sendTo(ws, { type: "coaching_complete_error", mid: id, code: slot.code });
    var req;
    try {
      req = ai.buildCoachingRequest({
        original: entry.text, criteria: criteria,
        turns: turns, files: ai.attachedFileNames(session.history, entry.id),
        roomName: placeName(user, session),
      });
    } catch (e) { slot.release(); throw e; }
    Promise.resolve().then(function () {
      return oneShot({ session: session, actor: user, isActive: function () { return !ws._aigoraAccessRevoked && mayComplete(user, entry, findSessionByUid(entry.sessionUid)); }, system: req.system, prompt: req.prompt });
    }).then(function (raw) {
      // Access may have ended while the model ran: then nothing is delivered or kept.
      if (ws._aigoraAccessRevoked || !mayComplete(user, entry, findSessionByUid(entry.sessionUid))) return completeFail(ws, user, entry.id, "forbidden");
      var text = ai.finalizeCompletion(entry.text, raw);
      if (!text) return completeFail(ws, user, entry.id, "failed");
      var saved = store.setAi(user.id, entry.id, text);
      var out = { type: "coaching_completed", mid: entry.id, text: text, ts: saved ? saved.aiAt : Date.now() };
      ownSockets(ws, user.id).forEach(function (c) { try { ctx.sendTo(c, out); } catch (_) { /* next */ } });
    }).catch(function (e) {
      var code = e && (e.code === "unavailable" || e.code === "timeout") ? e.code : "failed";
      completeFail(ws, user, entry.id, code);
    }).then(function () { slot.release(); }, function () { slot.release(); });
  }

  function handleMessage(ws, msg) {
    if (msg && msg.type === "coaching_complete") {
      var u = ws._aigoraUser;
      if (!u) { ctx.sendTo(ws, { type: "coaching_complete_error", mid: null, code: "forbidden" }); return true; }
      try { complete(ws, msg); } catch (_) { ctx.sendTo(ws, { type: "coaching_complete_error", mid: typeof msg.id === "string" ? msg.id.slice(0, 120) : null, code: "failed" }); }
      return true;
    }
    if (!msg || (msg.type !== "coaching_list" && msg.type !== "coaching_share")) return false;
    var user = ws._aigoraUser;
    if (!user) { ctx.sendTo(ws, { type: "coaching_error", code: "forbidden" }); return true; }
    try {
      if (msg.type === "coaching_list") ctx.sendTo(ws, { type: "prompt_coaching_history", entries: store.list(user.id) });
      else share(ws, msg.id);
    } catch (_) {
      ctx.sendTo(ws, { type: "coaching_error", code: "failed" });
    }
    return true;
  }

  return { onUserMessage: onUserMessage, handleMessage: handleMessage, store: store };
}

module.exports = { attachPromptCoaching: attachPromptCoaching };

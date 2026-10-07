// private-session-access.js - one read/mutate guard for session-bearing paths.
//
// The actor id must come from the authenticated server connection; any role
// carried on the actor is ignored. Channel-bound sessions (any defined,
// non-null channelId, even a malformed one) are decided only by the personal
// predicates; everything else keeps the existing canAccessSession rule.
// Missing dependencies and throwing predicates deny.

function isChannelBound(session) {
  return !!session && typeof session === "object" &&
    Object.prototype.hasOwnProperty.call(session, "channelId") &&
    session.channelId !== undefined && session.channelId !== null;
}

function createPrivateSessionAccess(usersModule) {
  function decide(actor, session, project, action) {
    if (action !== "read" && action !== "mutate") return false;
    if (!actor || typeof actor.id !== "string" || !actor.id) return false;
    if (!session || typeof session !== "object") return false;
    if (!usersModule) return false;
    var fn;
    if (isChannelBound(session)) fn = action === "read" ? usersModule.canReadPersonalSession : usersModule.canMutatePersonalSession;
    else fn = usersModule.canAccessSession;
    if (typeof fn !== "function") return false;
    try { return fn.call(usersModule, actor.id, session, project) === true; } catch (e) { return false; }
  }

  function canReadSession(actor, session, project) {
    return decide(actor, session, project, "read");
  }

  function assertSessionAction(actor, session, project, action) {
    if (decide(actor, session, project, action)) return;
    var err = new Error("Forbidden");
    err.status = 403;
    err.statusCode = 403;
    throw err;
  }

  // Legacy sessions are not decided here (callers keep their old rule); a
  // channel-bound session is observable only by a current reader.
  function mayObserve(actor, session) {
    return !isChannelBound(session) || decide(actor, session, { visibility: "public" }, "read");
  }

  // null for a legacy session; for a bound one the owner id while the owner
  // can still read it, otherwise "" (nobody is notified).
  function privateOwner(session) {
    if (!isChannelBound(session)) return null;
    return session.ownerId && mayObserve({ id: session.ownerId }, session) ? session.ownerId : "";
  }

  return { canReadSession: canReadSession, assertSessionAction: assertSessionAction, mayObserve: mayObserve, privateOwner: privateOwner };
}

module.exports = { createPrivateSessionAccess: createPrivateSessionAccess, isChannelBound: isChannelBound };

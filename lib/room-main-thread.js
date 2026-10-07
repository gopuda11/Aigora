// room-main-thread.js - every Aigora room has exactly one main session: the
// team's shared feed (member messages, shared-result cards, AI turns). It is
// marked `roomMain` in the session meta and found, adopted or created here.
//
// Race safety: ensure() is fully synchronous (no await, no I/O callback between
// the lookup and the registration), so on Node's single thread two callers can
// never both see "no main" - the second always finds the first one's session.
// Per-room serialization is therefore inherent; it must stay synchronous.
//
// Existing rooms are migrated lazily by the same call: a room with no main
// adopts its most recent visible shared room session (flag only, nothing is
// rewritten or deleted) and only creates one when it has none.

function isPrivateBound(s) {
  return Object.prototype.hasOwnProperty.call(s, "channelId") && s.channelId !== undefined && s.channelId !== null;
}

function createRoomMainThread(opts) {
  var sm = opts.sm;

  function inRoom(s, roomId) { return !!s && s.roomId === roomId && !isPrivateBound(s); }

  function findMain(roomId) {
    var found = null;
    sm.sessions.forEach(function (s) {
      if (!inRoom(s, roomId) || s.roomMain !== true) return;
      // Normally exactly one. If a crash ever left several, the oldest wins so
      // every caller converges on the same one.
      if (!found || (s.createdAt || 0) < (found.createdAt || 0)) found = s;
    });
    return found;
  }

  function adoptable(roomId) {
    var best = null;
    sm.sessions.forEach(function (s) {
      if (!inRoom(s, roomId) || s.hidden || !s.ownerId || s.sessionVisibility === "private") return;
      var at = s.lastActivity || s.createdAt || 0;
      if (!best || at > (best.lastActivity || best.createdAt || 0)) best = s;
    });
    return best;
  }

  // The room's main session, or null when the room is unknown or archived.
  function ensure(usersModule, roomId) {
    if (typeof roomId !== "string" || !roomId) return null;
    var room = null;
    try { room = usersModule.findRoomById(roomId); } catch (e) { room = null; }
    if (!room || room.archived) return null;
    var main = findMain(roomId);
    if (main) return main;
    var adopt = adoptable(roomId);
    if (adopt) {
      sm.markRoomMain(adopt);
      sm.broadcastSessionList();
      return adopt;
    }
    var created = sm.createSessionRaw({ ownerId: room.ownerId, roomId: roomId });
    sm.markRoomMain(created);
    sm.broadcastSessionList();
    return created;
  }

  // The room's main session for one vendor, created lazily. For the vendor the main thread itself runs it is that
  // thread. For another vendor it is a hidden session of the same room (same workspace, same containment) whose turns
  // are mirrored into the feed. Synchronous for the same race-safety reason as ensure().
  function ensureVendor(usersModule, roomId, vendor) {
    var main = ensure(usersModule, roomId);
    if (!main || !vendor || main.vendor === vendor) return main;
    var found = null;
    sm.sessions.forEach(function (s) {
      if (!inRoom(s, roomId) || s.roomVendorMain !== true || s.vendor !== vendor) return;
      if (!found || (s.createdAt || 0) < (found.createdAt || 0)) found = s;
    });
    if (found) return found;
    var room = usersModule.findRoomById(roomId);
    return sm.markRoomVendorMain(sm.createSessionRaw({ ownerId: room.ownerId, roomId: roomId, vendor: vendor }));
  }

  // Add an entry to the room's feed: recorded for replay and sent live to the
  // viewers of the thread. It is never user_message, so no agent reads it.
  function append(usersModule, roomId, entry) {
    var main = ensure(usersModule, roomId);
    if (!main) return false;
    sm.sendAndRecord(main, entry);
    return true;
  }

  return { ensure: ensure, ensureVendor: ensureVendor, findMain: findMain, append: append };
}

module.exports = { createRoomMainThread: createRoomMainThread };

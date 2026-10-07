"use strict";
// private-vendor-thread.js - the per-vendor session of a private session (docs/superpowers/specs/2026-10-05-private-channel-picker-design.md).
// Picking Codex in a Claude private session (or the reverse) runs on a hidden session bound to the SAME channel, owner and room as
// the visible ("feed") session, keyed by (feed session uid, vendor), so conversation memory never crosses sessions and each vendor
// keeps its own resumable CLI session. Its records are mirrored into the feed (sessions.js, `privateVendorFeed`). Because it is a
// channel-bound session, every access rule (owner-only mutation, admin read, revocation, admin-only approvals, contained
var { isChannelBound } = require("./private-session-access");

function createPrivateVendorThread(opts) {
  var sm = opts.sm;

  function belongs(s, feed, vendor) {
    return !!s && s.privateVendorFeed === feed.uid && s.hidden === true && s.vendor === vendor && isChannelBound(s) &&
      s.channelId === feed.channelId && s.ownerId === feed.ownerId && s.roomId === feed.roomId;
  }

  // The feed session itself when `vendor` is the vendor it runs (`ownVendor`), else its vendor session (created lazily).
  // null when the feed is not a live, active, visible private session or the vendor is not claude/codex.
  function ensure(feed, vendor, ownVendor) {
    if (!feed || !feed.uid || feed.hidden || !isChannelBound(feed) || (vendor !== "claude" && vendor !== "codex")) return null;
    if (sm.sessions.get(feed.localId) !== feed || (typeof sm.isPersonalSessionActive === "function" && sm.isPersonalSessionActive(feed) !== true)) return null;
    if (vendor === ownVendor) return feed;
    var found = null;
    sm.sessions.forEach(function (s) {
      if (!belongs(s, feed, vendor)) return;
      if (!found || (s.createdAt || 0) < (found.createdAt || 0)) found = s;
    });
    if (found) return found;
    // createSessionRaw re-validates (channel, owner, room) against the authoritative channel record and throws when it does not match.
    var created = sm.createSessionRaw({ ownerId: feed.ownerId, roomId: feed.roomId, channelId: feed.channelId, vendor: vendor });
    return sm.markPrivateVendorMain(created, feed);
  }

  return { ensure: ensure };
}

module.exports = { createPrivateVendorThread: createPrivateVendorThread };

"use strict";
// Internal capability for the local mcp-bridge child (lib/yoke/mcp-bridge-server.js).
// The token is derived from a per-process random secret and the project slug; it is handed only to the bridge
// child's environment and never to browsers. The HTTP bridge endpoint accepts nothing else (not a user cookie,
// not loopback), so an authenticated member cannot reach tool handlers by POSTing to it.
var crypto = require("crypto");

var SECRET = crypto.randomBytes(32);
var HEADER = "x-aigora-bridge-token";

function tokenFor(slug) {
  return crypto.createHmac("sha256", SECRET).update("mcp-bridge\0" + String(slug || "")).digest("hex");
}

function verify(slug, presented) {
  if (typeof presented !== "string" || presented.length !== 64) return false;  // iron-laws: ignore[IL-307] fail-closed capability check; invalid token is denied, not an error
  var a = Buffer.from(tokenFor(slug), "utf8"), b = Buffer.from(presented, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { tokenFor: tokenFor, verify: verify, HEADER: HEADER };

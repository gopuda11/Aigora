// office-jwt.js - HS256 JWTs for the Document Server (config tokens, command calls, callback
// verification) and the short-lived docTokens Aigora puts in the URLs it hands to DS.
// Zero dependencies. Only HS256 is accepted: "alg" is checked, so "none" or a different
// algorithm never verifies.

var crypto = require("crypto");

function b64(buf) { return Buffer.from(buf).toString("base64url"); }

function sign(payload, secret) {
  var head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" })) + "." + b64(JSON.stringify(payload));
  return head + "." + crypto.createHmac("sha256", secret).update(head).digest("base64url");
}

// Returns the payload, or null for anything invalid: shape, algorithm, signature, expiry.
// opts.requireExp: tokens Aigora mints always carry exp, so one without it is refused. DS-signed tokens keep the default.
function verify(token, secret, nowMs, vopts) {
  if (typeof token !== "string" || token.length > 16384) return null;
  var parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  try {
    var header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (!header || header.alg !== "HS256") return null;
    var expect = crypto.createHmac("sha256", secret).update(parts[0] + "." + parts[1]).digest();
    var got = Buffer.from(parts[2], "base64url");
    if (got.length !== expect.length || !crypto.timingSafeEqual(got, expect)) return null;
    var payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!payload || typeof payload !== "object") return null;
    var now = (nowMs === undefined ? Date.now() : nowMs) / 1000;
    if (vopts && vopts.requireExp && typeof payload.exp !== "number") return null;
    if (typeof payload.exp === "number" && payload.exp <= now) return null;
    return payload;
  } catch (_) { return null; }
}

// docTokens use a key derived from the DS secret, so a token DS itself signed can never pass as one of ours.
function docKey(secret) { return crypto.createHmac("sha256", secret).update("aigora-office-doc-token").digest(); }

module.exports = { sign: sign, verify: verify, docKey: docKey };

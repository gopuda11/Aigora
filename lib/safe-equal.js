// Constant-time string equality for secrets (tokens, codes, passwords).
// Both sides are hashed first so inputs of different length compare in the
// same time and timingSafeEqual never throws. Non-strings never match.
var crypto = require("crypto");

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  var ha = crypto.createHash("sha256").update(a).digest();
  var hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

module.exports = { safeEqual: safeEqual };

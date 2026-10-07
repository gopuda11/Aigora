"use strict";
// Network policy of contained agent scopes. Read from roomExecution (rooms) or privateExecution (private channels):
//   network:    "proxy" (default: own network namespace + host egress proxy) | "landlock" (explicit opt-in: shared host namespace, residual recorded)
//   egressMode: "public" (default: any public DNS name on 443) | "providers" (model providers only)
// Anything else is treated as the strictest value: an unknown network value is "proxy", an unknown egressMode is "providers".
function own(o, k) { return !!o && typeof o === "object" && !Array.isArray(o) && Object.prototype.hasOwnProperty.call(o, k); }
function section(kind) {
  try {
    var s = require("./config").loadConfig();
    s = s && s[kind === "room" ? "roomExecution" : "privateExecution"];
    return s && typeof s === "object" && !Array.isArray(s) ? s : null;
  } catch (_) { return null; }
}
function networkMode(kind) {
  var s = section(kind);
  return own(s, "network") && s.network === "landlock" ? "landlock" : "proxy";
}
function egressMode(kind) {
  var s = section(kind);
  if (!own(s, "egressMode")) return "public";
  return s.egressMode === "public" ? "public" : "providers";
}
module.exports = { networkMode: networkMode, egressMode: egressMode };

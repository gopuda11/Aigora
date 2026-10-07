"use strict";
// WebSocket upgrade Origin check (CSRF / cross-site WebSocket hijacking).
// The full origin must match the host the request was addressed to: same hostname AND same effective port.
// Comparing ports alone lets a same-site sibling (https://evil.example.com) ride the victim's cookies to https://aigora.example.com.
// Behind a TLS-terminating proxy the browser-visible host is the Host header; X-Forwarded-Host is read only when the
// operator declared the proxy trusted. Loopback names (localhost, 127.0.0.1, ::1) are interchangeable for local development.
var LOOPBACK = { "localhost": true, "127.0.0.1": true, "[::1]": true, "::1": true };

function parseHost(value, defaultPort) {
  if (typeof value !== "string" || value === "") return null;  // iron-laws: ignore[IL-307] fail-closed origin check; missing host yields null (denied)
  try {
    var u = new URL("http://" + value.split(",")[0].trim());
    return { hostname: u.hostname.toLowerCase(), port: String(u.port || defaultPort) };
  } catch (_) { return null; }  // iron-laws: ignore[IL-301] unparsable Host header is untrusted input; null means denied
}

function originAllowed(o) {
  var originUrl;
  try { originUrl = new URL(o.origin); } catch (_) { return false; }  // iron-laws: ignore[IL-301] unparsable Origin is untrusted input; false means denied
  if (originUrl.protocol !== "https:" && originUrl.protocol !== "http:") return false;
  var defPort = originUrl.protocol === "https:" ? "443" : "80";
  var oHost = originUrl.hostname.toLowerCase();
  var oPort = String(originUrl.port || defPort);
  var hosts = [parseHost(o.host, defPort)];
  if (o.trustedProxy) hosts.push(parseHost(o.forwardedHost, defPort));
  for (var i = 0; i < hosts.length; i++) {
    var h = hosts[i];
    if (!h || h.port !== oPort) continue;
    if (h.hostname === oHost) return true;
    if (LOOPBACK[h.hostname] && LOOPBACK[oHost]) return true;
  }
  return false;
}

module.exports = { originAllowed: originAllowed };

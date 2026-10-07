"use strict";

var net = require("net");

// Client-IP resolution for rate limiting / lockouts / audit lines.
//
// Public users reach the daemon through a reverse proxy (ngrok) on the same
// host, so the socket peer is always loopback. Only in that case is
// X-Forwarded-For consulted, and only its RIGHTMOST entry: the proxy appends
// the real client address last, so everything to its left is client-supplied.
// A non-loopback peer is always used as-is and headers are ignored.
//
// Opt-out: daemon.json `trustLoopbackProxy: false` (passed as opts) or env
// AIGORA_TRUST_LOOPBACK_PROXY=0. Default is on.
//
// Non-loopback proxies (docker network, another host): daemon.json `trustedProxies` lists their addresses or CIDRs
// (opts.trustedProxies). Default empty. XFF is honoured only when the socket peer is loopback or listed. The header is
// then read from the right, skipping hops that are themselves listed; the first unlisted hop is the client. A malformed
// hop on the way means the header is not trusted at all and the socket peer is used.

function isLoopback(addr) {
  if (!addr) return false;
  if (addr === "::1") return true;
  var m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  var v4 = m ? m[1] : addr;
  return net.isIPv4(v4) && v4.split(".")[0] === "127";
}

// Any spelling of an IPv4-mapped address (hex groups, expanded zeros, upper case) reduced to dotted IPv4; anything else unchanged.
function mappedToV4(a) {
  var host;
  try { host = new URL("http://[" + a + "]/").hostname; } catch (_) { return a; }
  var h = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(host);
  if (!h) return a;
  var hi = parseInt(h[1], 16), lo = parseInt(h[2], 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
}

// Canonical form: lower-case, IPv4-mapped IPv6 reduced to dotted IPv4. Returns "" when not an IP.
function normalize(addr) {
  if (typeof addr !== "string") return "";
  var a = addr.trim();
  var m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  if (m) a = m[1];
  else if (net.isIPv6(a) && a.indexOf("%") === -1) a = mappedToV4(a);
  return net.isIP(a) ? a.toLowerCase() : "";
}

var matchers = new WeakMap();
// Build (once per list object) a BlockList from IPs and CIDRs. Invalid entries are dropped: less trust, never more.
function matcherFor(list) {
  if (!Array.isArray(list) || !list.length) return null;
  var cached = matchers.get(list);
  if (cached) return cached;
  var bl = new net.BlockList(), n = 0;
  list.forEach(function (entry) {
    if (typeof entry !== "string") return;
    var parts = entry.trim().split("/");
    var addr = normalize(parts[0]);
    if (!addr || parts.length > 2) return;
    var v6 = net.isIPv6(addr);
    try {
      if (parts.length === 2) {
        if (!/^\d{1,3}$/.test(parts[1])) return;
        var bits = Number(parts[1]);
        // An IPv4-mapped /N prefix is expressed in IPv6 bits; map it onto the IPv4 prefix, only when it became IPv4.
        if (!v6 && net.isIPv6(parts[0].trim())) bits -= 96;
        if (bits < 0 || bits > (v6 ? 128 : 32)) return;
        bl.addSubnet(addr, bits, v6 ? "ipv6" : "ipv4");
      } else bl.addAddress(addr, v6 ? "ipv6" : "ipv4");
      n++;
    } catch (_) {}
  });
  var fn = n ? function (ip) { var a = normalize(ip); return !!a && bl.check(a, net.isIPv6(a) ? "ipv6" : "ipv4"); } : null;
  matchers.set(list, fn || function () { return false; });
  return matchers.get(list);
}

function clientIp(req, opts) {
  var peer = (req.socket && req.socket.remoteAddress)
    || (req.connection && req.connection.remoteAddress)
    || "";
  var listed = matcherFor(opts && opts.trustedProxies) || function () { return false; };
  var loopbackOn = !(opts && opts.trustLoopbackProxy === false) && process.env.AIGORA_TRUST_LOOPBACK_PROXY !== "0";
  if (!((loopbackOn && isLoopback(peer)) || listed(peer))) return peer;
  var xff = req.headers && req.headers["x-forwarded-for"];
  if (Array.isArray(xff)) xff = xff.join(",");
  if (typeof xff !== "string" || !xff.trim()) return peer;
  var parts = xff.split(",");
  for (var i = parts.length - 1; i >= 0; i--) {
    var hop = parts[i].trim();
    if (!net.isIP(hop)) return peer;
    if (i > 0 && listed(hop)) continue;
    return hop;
  }
  return peer;
}

module.exports = { clientIp: clientIp };

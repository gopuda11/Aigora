# Running Aigora behind a reverse proxy

Login, PIN and invite lockouts are keyed by client IP. Aigora reads `X-Forwarded-For` only from a trusted proxy.

- A proxy on the same host (ngrok, cloudflared, Caddy or nginx on localhost) connects from loopback and is trusted by default. Nothing to configure.
- A proxy on another host or container (docker network, Kubernetes ingress, a separate nginx box) connects from a non-loopback address. Until you list it, Aigora ignores its `X-Forwarded-For` and every user shares the proxy's IP. One user's failed logins then lock out everybody.

## Configure

Add the proxy's address or CIDR to `daemon.json`:

```json
{
  "trustedProxies": ["172.18.0.0/16", "10.0.0.5", "fd00::/8"]
}
```

- Entries are IPv4/IPv6 addresses or CIDRs. IPv4-mapped IPv6 (`::ffff:10.0.0.5`) is treated as the IPv4 address. Invalid entries are ignored (they never add trust).
- Default is empty: today's behaviour (loopback only).
- Restart the daemon after editing.

## How the client IP is chosen

1. If the socket peer is not loopback and not listed, the peer address is used and the header is ignored. A client cannot spoof its IP by sending its own `X-Forwarded-For`.
2. Otherwise the header is read from the right. Hops that are listed in `trustedProxies` are skipped; the first unlisted hop is the client.
3. If any hop on the way is not a valid IP, the header is not trusted and the peer address is used.

Loopback is trusted as the peer but loopback hops inside the header are not skipped. If a local proxy forwards to Aigora after another proxy, add `127.0.0.1` to `trustedProxies`.

Your proxy must append the address it actually saw to `X-Forwarded-For` (nginx: `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`). A proxy that passes the client's header through without appending leaves the client in control of the last hop. Make sure only the proxy can reach the Aigora port (firewall or an internal docker network).

`trustedProxy: true` is a separate setting: it only governs `X-Forwarded-Proto` (HTTPS detection). To disable loopback trust, set `trustLoopbackProxy: false` or `AIGORA_TRUST_LOOPBACK_PROXY=0`.

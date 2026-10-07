# Office co-editing (ONLYOFFICE Document Server)

Phase E of `docs/superpowers/specs/2026-10-03-room-attachments-office.md`, applying the results in
`docs/superpowers/specs/2026-10-03-onlyoffice-spike-results.md`. Members of a room (or the owner of a
private channel) co-edit `docx`, `xlsx` and `pptx` attachments in a full-screen editor inside Aigora.
Everything else stays download-only: HWP / HWPX / HML are never sent to the Document Server (a 16 KB
HWP hung its single converter for 5 minutes in the spike), and ODF / legacy Office files were not
verified in DS, so they are download-only in v1.

## Run-book (owner)

The container runs on a user-defined bridge because docker port publishing (iptables DNAT) does not work
on this host. No port is published; Aigora reaches DS at `http://10.77.77.10` (default subnet `10.77.77.0/24`, see below) directly from the host.

```
# once: the firewall rule (root), lets DS call back to Aigora's second listener (only if a host firewall is active)
sudo ufw allow in on br-aigora-oo from 10.77.77.0/24 to 10.77.77.1 port 25891 proto tcp

# start (creates network aigora-office 10.77.77.0/24 / bridge br-aigora-oo, generates the 0600 secret
# file if missing, starts onlyoffice/documentserver:9.3.0.1 at 10.77.77.10, --restart unless-stopped)
AIGORA_HOME=~/.local/share/aigora scripts/aigora-office.sh up
scripts/aigora-office.sh status          # container, network, secret file, health, callback reachability
scripts/aigora-office.sh down            # remove the container (volumes and network stay)
scripts/aigora-office.sh down --purge    # also remove the volumes and the network
```

Another subnet (the default may clash with a VPN or an existing docker network): set these on every call of the
script. A network that already exists keeps the addresses it was created with; `down --purge` removes it.

| Env | Default | Meaning |
| --- | --- | --- |
| `AIGORA_OFFICE_SUBNET` | `10.77.77.0/24` | docker network, must be `A.B.C.0/24` |
| `AIGORA_OFFICE_GATEWAY` | `.1` of the subnet | host side of the bridge, where Aigora's second listener binds |
| `AIGORA_OFFICE_DS_IP` | `.10` of the subnet | fixed address of the Document Server container |
| `AIGORA_OFFICE_BRIDGE` | `br-aigora-oo` | bridge interface name (max 15 characters) |
| `AIGORA_OFFICE_CB_PORT` | `25891` | callback port (match `office.callbackPort`) |
| `AIGORA_OFFICE_MEM` / `AIGORA_OFFICE_CPUS` | `6g` / `4` | container limits |

The secret file is `<AIGORA_HOME>/console/office-jwt.secret` (mode 0600, 64 hex characters, never printed;
override with `AIGORA_OFFICE_SECRET_FILE`). The script passes it to docker through an env file on a pipe, so it
is not in `ps` or in this output. Aigora refuses a secret file that is group/world readable or a symlink.

Enable it in the daemon config (`daemon.json`), then restart Aigora once (not done by this change):

```json
"office": { "enabled": true, "dsUrl": "http://10.77.77.10", "callbackHost": "10.77.77.1", "callbackPort": 25891, "jwtSecretFile": "<optional, default <config dir>/office-jwt.secret>" }
```

`dsUrl` (plain `http://<ip>`, no credentials or path) and `callbackHost` must match the script's `AIGORA_OFFICE_DS_IP`
and `AIGORA_OFFICE_GATEWAY`; the defaults above are the script's defaults. `callbackHost` must be loopback or an
address in the same /24 as `dsUrl`, otherwise the listener refuses to start.

Default is disabled. When disabled the editor UI is hidden (HWP cards still say "다운로드만 가능 (HWP)").

Verify the callback path once the ufw rule exists:

```
scripts/aigora-office.sh status           # "callback:  DS can reach <gateway>:25891" (needs Aigora running with office.enabled)
ss -ltn | grep 25891                      # exactly one line, local address <callbackHost>:25891, never 0.0.0.0
docker exec aigora-office bash -c "timeout 3 bash -c '</dev/tcp/10.77.77.1/25891' && echo reachable"
```

Opt-in real integration test (brings the container up and down by itself, throwaway Aigora on a free port with
a temp `AIGORA_HOME`, headless Chrome):

```
AIGORA_OFFICE_INTEGRATION=1 node --test test/aigora-office-integration.test.js
```

## Architecture

| Piece | Where |
| --- | --- |
| Editor config (per user, signed, 1 h), health probe, presence, revocation, DS-facing listener | `lib/office.js` |
| Reverse proxy `/p/<slug>/office/web/**` (HTTP + WebSocket) | `lib/office-proxy.js`, hooked in `lib/server.js` (upgrade) and `lib/project-http.js` |
| Browser routes `/p/<slug>/office/...` (host page, config, status, versions, restore) | `lib/project-office.js` |
| Versions, save path, `edit` authorization, CP949 transcoding, DS size limits | `lib/room-attachments.js` |
| Blank docx/xlsx/pptx (`POST .../blank`) | `lib/office-blank.js`, `lib/project-attachments.js` |
| Client | `lib/public/aigora/office.js`, `office-model.js`, `office-host.js`, `css/aigora-office.css` |

Two listeners, strictly separated: the public one (25808, behind the session cookie) serves the browser routes;
the second one, bound to `office.callbackHost:office.callbackPort` only (the code refuses anything but loopback or an address in the DS's /24, never a
wildcard), serves only `GET /office-internal/download/<docToken>` and `POST /office-internal/callback/<docToken>`
and answers only to the Document Server's address.

### Spike corrections, as applied

1. Host networking: user-defined bridge with a fixed address instead of the compose `ports:` line; callbacks go to the
   bridge-bound second listener with a `remoteAddress` check (DS address only).
2. Callback fetch: the status-2 `url` is the browser-facing URL built from `X-Forwarded-Host`
   (`/p/<slug>/office/web/cache/files/...`). Aigora requires that exact shape, then fetches
   `<DS internal base>/cache/files/...` and never contacts the host in the URL. No redirects, size cap, 60 s timeout,
   the bytes go through the same type checks as an upload. Idempotent by `(attachmentId, key)`, serialised per attachment.
3. `drop` is not a revocation primitive: the proxy registers each editor WebSocket and destroys it when access changes
   (member removed, role downgraded, room archived or deleted, file deleted, logout); `drop` is sent best effort.
4. Limits follow DS: docx/pptx 50 MB and xlsx 300 MB uncompressed, 100 MB download, min with Aigora's 25 MB per file.
5. HWP never reaches DS. CP949 CSV (Korean Excel) is transcoded to UTF-8 with a BOM on upload.
6. Env names verified: `JWT_ENABLED`, `JWT_SECRET`, `JWT_HEADER=Authorization`, `JWT_IN_BODY=true`,
   `ALLOW_PRIVATE_IP_ADDRESS=true`. DS signs callbacks in the header AND the body; Aigora requires both.

### Authorization

Single path `authorizeAttachment(actor, ref, id, action)` with the new action `edit` (room member or owner; the
private channel's owner; never a viewer, never an admin reading a private channel). The config route first
authorizes `view` (404 for anyone outside the room, same as a missing file), then decides `edit` or `view` mode.
The DS host page is served with `frame-ancestors 'self'`, a `script-src 'self'` CSP and no inline script. The
download token lives 2 minutes, the callback token 24 hours (the save arrives when the last editor leaves), the
signed editor config 1 hour. Document keys are `<attachmentId>-v<n>` and change only when a version commits.

### Failure modes

- Container down or unhealthy: the config route answers 503 `office_unavailable`; the card shows "문서 편집기를 사용할 수
  없어요. 관리자에게 문의하세요" and keeps Download. Health is probed at `/healthcheck`, cached 10 s.
- A save that fails validation answers `{"error":1}` (DS retries), the previous version stays current, the card shows
  "마지막 저장에 실패했어요".
- A restore is refused (409) while anyone has the document open or DS has not yet called back.
- Aigora restart: sessions are in memory; every proxied request is re-judged against the live membership, so a removed
  user cannot reopen.

## Residual risk: same origin

The free ngrok plan gives one domain, so the editor is served under `/p/<slug>/office/` on the Aigora origin. A
cross-site scripting bug in the Document Server would run with the Aigora origin and could call Aigora's APIs as the
logged-in user. Mitigations in place: the session cookie is `HttpOnly` (and `SameSite=Lax`, unchanged: `Strict` would
break opening a shared link from a chat app); every office route and the proxy additionally refuse requests whose
`Sec-Fetch-Site` is cross-site or same-site (stricter than `SameSite=Lax`); `Cookie` and `Authorization` are stripped
toward DS and `Set-Cookie` is stripped from DS responses, so DS can neither read nor plant a cookie on this origin;
the DS image is pinned (`9.3.0.1`); mutating routes need `X-Requested-With`. Prefer a second hostname for the editor
when the plan allows it.

## Known limits

- Community edition: 20 simultaneous editor connections, per connection (two tabs of one person count twice).
- One converter process: a slow or hung conversion delays everyone (HWP is kept away for this reason).
- Version retention is the newest 50 per file (the spec's "all within 7 days, daily beyond" is not implemented).
- The signed editor config lives 1 hour; a reconnect after that needs the editor to be reopened (not exercised against
  a real DS beyond minutes).
- Cold start: `/healthcheck` turns true on the first docservice start, but the image restarts docservice about 20 s
  later and that drops every open editor socket (found by the integration test). After `up`, wait about 70 s;
  `scripts/aigora-office.sh status` says "still settling" until then. Editors that were open reconnect by themselves.
- The Aigora listener binds `office.callbackHost`, which exists only after the network is created: if Aigora starts before
  `aigora-office.sh up`, it retries every 15 s until the bridge is there.

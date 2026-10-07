# API-only setup

The public build uses explicit API credentials. No existing desktop account or provider login is an authentication source. This guide describes the configuration implemented in this tree; it does not promise access to a provider's models.

## Install and run

```sh
npm ci
export ANTHROPIC_API_KEY='<your-api-key>'
export OPENAI_API_KEY='<your-api-key>'
node bin/cli.js --host 127.0.0.1 --no-https --no-update
```

Node.js 22.15+ is required. There is no asset compilation step. First run is an interactive setup wizard; create the admin in the browser using the terminal's setup code. The project console is `/`; collaboration is `/aigora/`. Use TLS through a reverse proxy for access beyond loopback. Do not disable containment merely to work around missing Linux prerequisites; room agents fail closed if the sandbox cannot start.

## Config locations and precedence

Default state home is `~/.aigora`; set **`AIGORA_HOME`** to a dedicated directory to relocate it. The config directory is **`$AIGORA_HOME/console`**, and normal daemon settings are **`console/daemon.json`** (`daemon-dev.json` with `--dev`). These are local server files, not project files. Preserve the wizard's existing fields when adding this fragment:

```json
{
  "roomExecution": {
    "apiKeyEnv": { "claude": "ANTHROPIC_API_KEY", "codex": "OPENAI_API_KEY" },
    "broker": { "enabled": true },
    "claude": true,
    "codex": true,
    "egressMode": "providers"
  },
  "privateExecution": {
    "claude": true,
    "codex": true,
    "egressMode": "providers"
  }
}
```

Agent key lookup, including private/host/title/coaching/scheduled runs, is:

1. A nonempty **`roomExecution.apiKeys.claude`** / **`.codex`** string in `daemon.json`.
2. The environment variable named by **`roomExecution.apiKeyEnv.claude`** / **`.codex`**; defaults are `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`.

If you store keys in JSON instead, add `"apiKeys": { "claude": "<your-api-key>", "codex": "<your-api-key>" }` inside `roomExecution`. JSON keys take precedence over environment keys. Protect that file and backups (owner-only permissions). Environment keys must be present in the **daemon's** environment; setting them in a different shell after daemon launch is insufficient. `CODEX_API_KEY` is injected for the Codex subprocess but is not the default daemon lookup variable. There is no `privateExecution.apiKeys` lookup.

The broker is enabled by default. It keeps the real upstream key in the daemon and gives an agent an expiring run token. Default upstreams are Anthropic HTTPS `/v1/messages` and OpenAI HTTPS `/v1/responses`; arbitrary `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL` inherited from the host are stripped. There is no production `daemon.json` switch for overriding those broker upstreams. Tests inject isolated mock upstreams through `createCredentialBroker({ upstream })`; compatible third-party chat services use `providers.local` below.

Setting `roomExecution.broker.enabled: false` injects the real key into the agent environment and logs a warning. Keep it enabled. Broker limits can be configured as `roomExecution.broker.limits.{run,actorDaily,roomDaily,globalDaily}.{requests,inputTokens,outputTokens}` (positive integers); `ttlMs` accepts 60000–86400000. Budget estimates are not provider invoices.

## Other API-key services

| Feature/provider | Exact settings | Storage / behavior |
| --- | --- | --- |
| Compatible chat provider | `providers.local.enabled: true`, `baseUrl`, `apiKey`, `models.chat`, `models.code`, `models.manual`; `endpoints[]` entries have `id`, `label`, `baseUrl`, `apiKey`, optional aliases/routing capabilities | In `daemon.json`; UI endpoint/title/research/verifier changes overlay in `local-model/overrides.json`; primary enabled/baseUrl/models remain in daemon config. The historical `local` configuration namespace also accepts remote HTTP(S) compatible providers; protocol support is checked, not inferred from a vendor name. Primary adapter is chat-only. |
| Speech API | `transcription.enabled: true`, `baseUrl: "https://api.openai.com/v1"`, `apiKey`, `model: "whisper-1"`, optional `language`, `maxBytes` | `daemon.json`, overlaid by admin `transcription.json`; no automatic reuse of `OPENAI_API_KEY`. Uses multipart `/audio/transcriptions`, requests `verbose_json`. Other services must implement that contract. |
| Clef / Cloudflare Workers AI | `AIGORA_CLEF_API_TOKEN`, `AIGORA_CLEF_ACCOUNT_ID`; optional `AIGORA_CLEF_MODEL`; `AIGORA_DECISION_BACKEND=clef` | Environment wins over `routing/clef.json` fields `token`, `accountId`, `backend`; save via admin Routing settings. Both credentials required. |
| TypeSafe System One / JEV | `AIGORA_JEV_API_KEY`, `AIGORA_DECISION_BACKEND=jev`, optional `AIGORA_JEV_MODEL` | Environment wins over `routing/clef.json` `jevKey` / `backend`. `ensemble` needs both Clef and JEV credentials. |
| Compatible decision endpoint | `AIGORA_DECISION_BACKEND=endpoint`, `AIGORA_CLEF_BASE_URL`, optional `AIGORA_CLEF_API_TOKEN` | Endpoint must implement `/v1/systemone` and optionally `/v1/outcome`, not chat completions. |

Routing settings `enabled`, `autoSelect`, `abstainMin`, `storeText` are stored in `routing/clef.json`; `autoSelect` is opt-in. `AIGORA_CLEF_ENABLED=0` disables decisions. Optional JEV shadow calls use `AIGORA_JEV_API_KEY`, `AIGORA_JEV_DAILY_CAP` (default 200) and `AIGORA_JEV_LOG_TEXT=1` (raw task logging opt-in). Setting a shadow key can send eligible routing state to that service independently of the chosen execution agent.

Admin-written credential files use atomic owner-only writes. Stored keys are **plaintext**, not an encrypted vault. Agent transcript persistence uses `console/api-agent-state`; temporary API homes exclude host login state. Never commit state directories, environment files or keys. See [PRIVACY.md](../PRIVACY.md).

## Models and cost

The shipped `lib/model-policy.js` pins Claude to **`claude-sonnet-5-5`**, Codex to **`gpt-6.1-sol`**, and effort to `low` or `medium` (default `medium`). Explicit incompatible choices are refused with `Model policy: ... sessions must use ...`; stale inherited choices normalize to the pinned value. These are source policy identifiers, not a claim that every account can access them. Verify entitlement against your provider before deployment; the UI model catalog does not override this policy.

Provider calls are billed to the configured API account. Agents can make multiple calls; titles, coaching, retries, verification, routing, scheduled jobs and speech processing can incur additional charges. Set provider spending limits as well as broker budgets. This build reports API credential readiness rather than an invented account quota. Provider prices and terms should be checked in their official billing documentation.

## Missing credentials and failures

| Condition | Observed public behavior / message |
| --- | --- |
| Claude or Codex has no explicit key | Before broker, sandbox or SDK launch: `credential_unavailable: Ask the administrator to add an API key (ANTHROPIC_API_KEY / OPENAI_API_KEY or roomExecution.apiKeys)`. No host-login fallback. |
| Room credential unavailable | Member message: `No AI credential (API key) is configured for this agent, so nothing was run. Please contact the administrator.` Administrators also receive the API configuration hint. |
| API usage readiness without a key | Provider `status: unavailable`, message `API credential required`; no account-login probe. |
| Key invalid or API model inaccessible | Provider authentication/model error; broker forwards supported API errors, does not switch credential sources. |
| Broker budget exhausted | `budget_exhausted`; the request is refused. |
| Clef/JEV credentials missing | Decision service inactive/unconfigured (`reason: off`); ordinary agent selection can still work with its own key. |
| Compatible chat endpoint requires a missing/invalid key | `The local model server rejected the request. Check the API key setting.` There is no generic preflight key requirement because unauthenticated local servers are valid. |
| Speech key missing | Transcription config can still be enabled (local endpoints may need no key); an authenticated service rejects the request, recorded as `auth` rather than exposing its body/key. |
| Speech disabled / malformed URL/model | `disabled`; unsupported upload/transcription operation is refused. |
| Sandbox prerequisites absent | Contained run refused with the mapped sandbox reason; no unconfined fallback. |

For a stopped daemon, correct keys/config then restart from the intended environment. API setup does not require any real-key test: `test-public/public-api-path.test.js` exercises isolated mock upstreams, and its socket/real-agent portion requires an ordinary host that allows local listeners and subprocesses.

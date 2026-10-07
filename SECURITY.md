# Security

Report vulnerabilities through GitHub private vulnerability reporting in the public repository Security tab when available. If that channel is unavailable, open an issue asking for a private reporting channel without exploit details or secrets. Include affected version, a minimal reproduction using synthetic data and the impact. No response-time or audit guarantee is offered.

## Execution defaults

| Context | Actual default |
| --- | --- |
| Claude/Codex room turn | Contained. Explicit `roomExecution.claude/codex: false` disables that room agent; it does not run unconfined. |
| Claude/Codex private channel | **Containment off.** Only literal `privateExecution.claude/codex: true` enables it. Otherwise agent execution has host-user filesystem privileges despite API credential isolation. |
| Primary local chat | Daemon calls the endpoint directly, text-only, no tool loop. |
| Endpoint room file worker | Off unless `roomExecution.endpoints: true`; also needs configured compatible endpoint capabilities. |
| Terminal, browser/MCP, plugins, skills and administrative operations | Separate host features/trust boundaries; not covered merely by agent containment. |

Set private containment explicitly before admitting untrusted members. `roomExecution.unconfined: true` is an unsafe room opt-out (explicit per-agent true/false wins). Trusted configured `extensions` execute administrator-supplied JavaScript and can replace core behavior: leave that setting empty for a standard public installation.

## What contained execution provides

Linux x64 scopes use bubblewrap namespaces, restricted filesystem mounts, isolated agent state, resource limits and a network policy. Missing mandatory prerequisites refuse the turn rather than silently weakening it. The default network mode is `proxy`: an isolated network namespace and mediated host egress; optional Landlock provides defense in depth when available. Explicit `network: landlock` uses the host network namespace and has residual risks; it requires the supported kernel ABI and is not equivalent to network namespace isolation.

Default `egressMode` is **`public`**, allowing public DNS names on HTTPS port 443, not just model providers. Set `egressMode: providers` in each execution section for narrower egress. Malformed modes normalize restrictively. A workspace-readable secret can still be transmitted to an allowed public destination or in a model prompt. Sandboxing does not prevent prompt injection, malicious content in permitted files, wrong model decisions, provider data retention or kernel/runtime vulnerabilities.

Resource controls need working `systemd-run --user`. `privateExecution.allowUnlimited: true` explicitly weakens that requirement. An optional `roomExecution.toolchainDir` is a read-only tool installation shared with contained scopes; do not point it at credential or personal-data directories. Tool approval mode is separate from filesystem/network confinement. Neither a successful unit test nor an enabled flag proves the host sandbox works: validate with the real containment tests on the deployment host.

## Credentials and access

The public agent path requires an explicit Anthropic/OpenAI API key before launching. The broker defaults on, issues expiring run tokens, restricts API routes/models and enforces budgets; it does not encrypt stored credentials. With `roomExecution.broker.enabled: false`, agents can read the real provider key. Keys in daemon/admin JSON are plaintext; restrict filesystem permissions and backup access. Host API launches use temporary credential homes, but those homes do **not** contain filesystem/tool effects.

Rooms, attachments, private channels and sessions have server-side access checks. A private channel is application-level access control, not end-to-end encryption against the server administrator or root. Optional OS-user separation provides an additional host boundary; do not assume ordinary multi-user mode enables it. Workspace snapshots can retain deleted content.

## Network and files

The CLI defaults to `0.0.0.0`; use `--host 127.0.0.1` unless deliberately exposing it. TLS is not guaranteed: without certificate setup the daemon may use HTTP. Put remote deployments behind properly configured TLS/authenticated network access. Set up PIN/accounts, protect setup codes and check reverse-proxy/WebSocket origin configuration.

Uploads, document conversion, video decoders and Office callbacks process untrusted bytes. Type/size checks, bounded parsers and resource limits reduce risk; they are not proof that arbitrary files are safe. ONLYOFFICE runs separately and needs its own patching, JWT secret and restricted callback access. Browser assets fetched from CDNs introduce third-party supply-chain and availability dependencies.

The public-safety scanner/export denylist prevents known private integrations, identifiers and common secret formats from shipping. It is a release check, not a complete secret detector or a runtime sandbox. Run it on the materialized export as well as the source, and manually review new files and unknown asset provenance.

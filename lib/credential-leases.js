module.exports = require("./extensions").select("credential-leases", function () {
var module = { exports: {} };
"use strict";
// Every agent launch uses a daemon-issued lease. Consumer-login selection is
var fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto");
var flags = require("./room-execution-flags");
var issued = new WeakMap(), scopeLeases = new WeakMap(), sharedBrokerInstance;
function unavailable() { var e = new Error("credential_unavailable: Ask the administrator to add an API key (ANTHROPIC_API_KEY / OPENAI_API_KEY or roomExecution.apiKeys)"); e.code = "credential_unavailable"; return e; }
function validKey(key) { return typeof key === "string" && /^[\x21-\x7e]+$/.test(key); }
function requireVendor(vendor) { if (vendor !== "claude" && vendor !== "codex") throw unavailable(); }
function generation(ctx, vendor) {
  return crypto.createHash("sha256").update(JSON.stringify([flags.credentialSource(vendor), flags.apiKey(vendor, ctx.env),
    flags.brokerEnabled(), flags.brokerTtlMs(), flags.brokerLimits()])).digest("hex");
}
function credentialAvailable(vendor, env) {
  requireVendor(vendor);
  return validKey(flags.apiKey(vendor, env));
}

// until extraction step 3. They use the same selection and lease validation.

function credentialOptions(ctx, vendor) {
  requireVendor(vendor);
  var key = flags.apiKey(vendor, ctx.env);
  if (!validKey(key)) throw unavailable();
  var env = {};
  flags.cliKeyNames(vendor).forEach(function (n) { env[n] = key; });
  return { credentialMode: "api_key", injectEnv: env };
}
function sharedBroker() {
  if (!sharedBrokerInstance) {
    var opts = { getKey: function (v) { return flags.apiKey(v); }, checkModel: require("./model-policy").checkModel };
    var ttl = flags.brokerTtlMs(); if (ttl !== undefined) opts.ttlMs = ttl;
    sharedBrokerInstance = require("./credential-broker").createCredentialBroker(opts);
  }
  return sharedBrokerInstance;
}
function actorId(ctx) {
  if (ctx.actor && typeof ctx.actor.id === "string" && ctx.actor.id) return ctx.actor.id;
  var s = ctx.session;
  if (s && typeof s.ownerId === "string" && s.ownerId && (!ctx.contained || (s.hidden && s.orchestration))) return s.ownerId;
  // Startup/discovery have no user session: keep their budget attribution
  // distinct from user turns. Contained calls still require an actual actor.
  if (!ctx.contained) return "daemon";
  throw unavailable();
}
function viaEgress(ctx) {
  if (!ctx.contained) return false;
  var n = ctx.scopeOptions && ctx.scopeOptions.network;
  return (n === undefined ? require("./sandbox-network-flags").networkMode(ctx.room ? "room" : "private") : n) === "proxy";
}
async function resolveCredential(ctx, vendor) {
  ctx = ctx || {}; requireVendor(vendor);
  var gen = generation(ctx, vendor), source = flags.credentialSource(vendor), opts, run, home, closed = false;
  var expiresAt = Infinity, children = new Set();
  function cleanupHome() { if (home && closed && !children.size) { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} } }
  {
    // Check before opening even a broker socket, and never accept an OAuth token.
    opts = credentialOptions(ctx, vendor);
    if (flags.brokerEnabled()) {
      var s = ctx.session || {}, egress = viaEgress(ctx);
      try {
        var a = { vendor: vendor, runId: crypto.randomUUID(), actorId: actorId(ctx), roomId: s.roomId || null,
          channelId: ctx.room ? null : (s.channelId || null), transport: egress ? "egress" : "tcp" };
        var lim = flags.brokerLimits(); if (lim !== undefined) a.limits = lim;
        run = await (ctx.credentialBroker || sharedBroker()).open(a);
        expiresAt = Date.now() + (flags.brokerTtlMs() || 2 * 3600 * 1000);
        if (!run || typeof run.close !== "function" || !run.env || !flags.cliKeyNames(vendor).every(function (n) { return validKey(run.env[n]); }) ||
          !Object.keys(run.env).every(function (n) { return ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "OPENAI_API_KEY", "CODEX_API_KEY"].includes(n) && typeof run.env[n] === "string" && run.env[n] && !run.env[n].includes("\0"); }) ||
          (egress ? typeof run.handle !== "function" : !(Number.isInteger(run.port) && run.port > 0))) throw unavailable();
        if (vendor === "claude" && !run.env.ANTHROPIC_BASE_URL) throw unavailable();
        if (vendor === "codex" && !/^openai_base_url = "[^"\n]+"/m.test(run.codexConfigText || "")) throw unavailable();
        opts = { credentialMode: "api_key", injectEnv: Object.assign({}, run.env) };
        if (egress) opts.egressBroker = { handleBrokerRequest: function (req, res) { return run.handle(req, res); } };
        else opts.allowTcpPorts = [run.port];
        if (vendor === "codex") opts.codexConfigText = run.codexConfigText;
      } catch (e) {
        if (run && run.close) { try { await run.close(); } catch (_) {} }
        throw e && e.message === "budget_exhausted" ? e : unavailable();
      }
    } else (ctx.log || console.warn)("[room-execution] WARNING: roomExecution.broker.enabled is false: the " + vendor + " API key is injected into the " + (ctx.contained ? "sandbox" : "agent environment") + " for this run");
    if (!ctx.contained) {
      try {
        home = fs.mkdtempSync(path.join(os.tmpdir(), "aigora-api-"));
        for (var d of [".claude", ".codex", ".config", ".cache", ".local/share"]) fs.mkdirSync(path.join(home, d), { recursive: true, mode: 0o700 });
        // Persist only transcripts, never auth/config, so host API sessions
        // can resume across per-run homes without importing consumer logins.
        var s = ctx.session || {}, binding = crypto.createHash("sha256").update(JSON.stringify([s.ownerId || actorId(ctx), s.roomId || null, s.channelId || null])).digest("hex");
        var transcriptRoot = ctx.transcriptRoot || path.join(require("./config").CONFIG_DIR, "api-agent-state");
        var stateRoot = path.join(transcriptRoot, vendor, gen, binding);
        var relative = vendor === "claude" ? ".claude/projects" : ".codex/sessions";
        var state = path.join(stateRoot, "sessions");
        fs.mkdirSync(state, { recursive: true, mode: 0o700 });
        if (ctx.transcriptOwner && typeof process.getuid === "function" && process.getuid() === 0) {
          for (var dir of [transcriptRoot, path.join(transcriptRoot, vendor), path.join(transcriptRoot, vendor, gen), stateRoot, state]) {
            fs.chownSync(dir, ctx.transcriptOwner.uid, ctx.transcriptOwner.gid);
          }
        }
        fs.symlinkSync(state, path.join(home, relative), "dir");
      } catch (e) { if (run) { try { await run.close(); } catch (_) {} } if (home) fs.rmSync(home, { recursive: true, force: true }); throw unavailable(); }
    }
  }
  var lease = { vendor: vendor, source: source, generation: gen, options: opts, home: home || null,
    close: function () {
      if (closed) return Promise.resolve(); closed = true;
      cleanupHome();
      try { return Promise.resolve(run && run.close()).catch(function () {}); } catch (_) { return Promise.resolve(); }
    } };
  issued.set(lease, { ctx: ctx, generation: gen, children: children, cleanupHome: cleanupHome, closed: function () { return closed || Date.now() >= expiresAt; } });
  // Config/credentials may have changed while broker preparation was pending.
  try { assertCredentialLease(lease, vendor); } catch (e) { await lease.close(); throw e; }
  return lease;
}
function assertCredentialLease(lease, vendor, ctx) {
  var record = lease && issued.get(lease);
  if (!record || record.closed() || lease.vendor !== vendor || generation(record.ctx, vendor) !== record.generation) throw unavailable();
  if (ctx && generation(ctx, vendor) !== record.generation) throw unavailable();
  if (ctx && lease.source === "api_key") {
    var old = record.ctx.session || {}, next = ctx.session || {};
    if (actorId(ctx) !== actorId(record.ctx) || (old.roomId || null) !== (next.roomId || null) || (old.channelId || null) !== (next.channelId || null)) throw unavailable();
  }
  return lease;
}
function trackProcess(lease, child) {
  var record = issued.get(lease);
  if (!record || !child || typeof child.once !== "function") throw unavailable();
  record.children.add(child);
  function exited() { record.children.delete(child); record.cleanupHome(); }
  child.once("exit", exited); child.once("error", exited);
  return child;
}
function bindScope(scope, lease) { assertCredentialLease(lease, lease.vendor); if (scope.credentialMode !== undefined && scope.credentialMode !== lease.source) throw unavailable(); scopeLeases.set(scope, lease); }
function scopeCredential(scope, vendor) { return assertCredentialLease(scopeLeases.get(scope), vendor); }
function executionEnv(lease, base) {
  assertCredentialLease(lease, lease.vendor);
  var env = require("./agent-env").stripRoutingSecrets(base || {});
  // Remove all competing authentication/provider/config discovery routes.
  var pins = ["CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_DISABLE_AUTO_MEMORY", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_SMALL_FAST_MODEL"];
  Object.keys(env).forEach(function (n) {
    if (pins.indexOf(n) === -1 && /^(ANTHROPIC_|OPENAI_|CODEX_|CLAUDE_|AWS_|GOOGLE_|GCLOUD_|CLOUD_ML_|AZURE_|DBUS_|GNOME_KEYRING|SSH_AUTH_SOCK$|SUDO_)/.test(n)) delete env[n];
  });
  delete env[flags.apiKeyEnvName("claude")]; delete env[flags.apiKeyEnvName("codex")];
  Object.assign(env, lease.options.injectEnv);
  if (lease.home) {
    env.HOME = lease.home;
    env.USERPROFILE = lease.home;
    env.CLAUDE_CONFIG_DIR = path.join(lease.home, ".claude");
    env.CODEX_HOME = path.join(lease.home, ".codex");
    env.XDG_CONFIG_HOME = path.join(lease.home, ".config");
    env.XDG_CACHE_HOME = path.join(lease.home, ".cache");
    env.XDG_DATA_HOME = path.join(lease.home, ".local/share");
  }
  return env;
}
function applyClaudeCredential(lease, options) {
  assertCredentialLease(lease, "claude");
  options.env = executionEnv(lease, options.env || process.env);
  if (lease.source !== "api_key") return;
  options.settingSources = [];
  options.settings = Object.assign({}, typeof options.settings === "object" ? options.settings : {});
  delete options.settings.apiKeyHelper;
  // Settings.env is applied inside the CLI, after its subprocess environment.
  // It must not reintroduce a competing key, token, provider or config path.
  if (options.settings.env) {
    var clean = executionEnv(lease, options.settings.env);
    options.settings.env = clean;
  }
  options.extraArgs = Object.assign({}, options.extraArgs || {});
  for (var n of ["settings", "setting-sources", "api-key-helper"]) delete options.extraArgs[n];
}
function codexAuthConfig(lease) {
  assertCredentialLease(lease, "codex");
  if (lease.source !== "api_key") return {};
  var match = /^openai_base_url = "([^"\n]+)"/m.exec(lease.options.codexConfigText || "");
  var base = match ? match[1] : "https://api.openai.com/v1";
  return { forced_login_method: "api", cli_auth_credentials_store: "file", openai_base_url: base,
    model_provider: "aigora_api", model_providers: { aigora_api: { name: "Aigora API", base_url: base, env_key: "OPENAI_API_KEY",
      wire_api: "responses", requires_openai_auth: false, supports_websockets: false } } };
}
function guardHandle(handle, lease, ownsLease) {
  var close = handle.close && handle.close.bind(handle), iterator = handle[Symbol.asyncIterator] && handle[Symbol.asyncIterator].bind(handle);
  function validate() { try { assertCredentialLease(lease, lease.vendor); } catch (e) { try { if (close) close(); } catch (_) {} lease.close(); throw e; } }
  for (var n of ["pushMessage", "setModel", "setEffort", "setToolPolicy", "setPermissionMode", "forkSession", "rewindFiles", "endInput"]) {
    if (typeof handle[n] !== "function") continue;
    (function (name, original) { handle[name] = function () { validate(); if (name === "pushMessage" && /^\s*\/(?:login|logout|auth)(?:\s|$)/i.test(String(arguments[0] || ""))) throw unavailable(); return original.apply(handle, arguments); }; })(n, handle[n]);
  }
  if (ownsLease) {
    handle.close = function () { try { return close && close(); } finally { lease.close(); } };
    if (iterator) handle[Symbol.asyncIterator] = async function* () {
      var it = iterator();
      try { while (true) { validate(); var step = await it.next(); if (step.done) return; yield step.value; } }
      finally { try { if (it.return) await it.return(); } finally { lease.close(); } }
    };
  }
  return handle;
}
function serializeWorkerCredential(lease) {
  assertCredentialLease(lease, "claude");
  return { vendor: "claude", source: lease.source, env: lease.options.injectEnv || {}, home: lease.home };
}
function applyWorkerCredential(wire, options) {
  // Worker IPC is private daemon->worker input. Bind the selected source to
  // the worker at launch; an empty/mismatched message can never inherit login.
  if (!wire || wire.vendor !== "claude" || wire.source !== process.env.AIGORA_WORKER_CREDENTIAL_SOURCE ||
      wire.source !== "api_key") throw unavailable();
  if (!validKey(wire.env && wire.env.ANTHROPIC_API_KEY) || !wire.home || !path.isAbsolute(wire.home) || wire.home !== process.env.HOME) throw unavailable();
  // Reuse the same sanitization with a locally issued, config-independent wire
  // lease. The daemon validates generation before each IPC push.
  var lease = { vendor: "claude", source: "api_key", options: { injectEnv: wire.env }, home: wire.home };
  var ctx = {}; issued.set(lease, { ctx: ctx, generation: generation(ctx, "claude"), closed: function () { return false; } });
  applyClaudeCredential(lease, options);
}
module.exports = { resolveCredential: resolveCredential,  credentialOptions: credentialOptions,
  credentialAvailable: credentialAvailable,  assertCredentialLease: assertCredentialLease, executionEnv: executionEnv, applyClaudeCredential: applyClaudeCredential,
  codexAuthConfig: codexAuthConfig, guardHandle: guardHandle, bindScope: bindScope, scopeCredential: scopeCredential,
  trackProcess: trackProcess, serializeWorkerCredential: serializeWorkerCredential, applyWorkerCredential: applyWorkerCredential };

return module.exports;
});

"use strict";
// Real public adapters + credential broker, synthetic upstreams only. No daemon,
// real accounts, host login files, project data or external model services.
const os = require("node:os");
const isolatedFs = require("node:fs");
const isolatedPath = require("node:path");
const isolatedHome = isolatedFs.mkdtempSync(isolatedPath.join(os.tmpdir(), "aigora-api-path-"));
process.env.HOME = isolatedHome;
process.env.AIGORA_HOME = isolatedPath.join(isolatedHome, ".aigora");
process.env.XDG_CONFIG_HOME = isolatedPath.join(isolatedHome, ".config");
process.env.XDG_DATA_HOME = isolatedPath.join(isolatedHome, ".local/share");
process.env.XDG_CACHE_HOME = isolatedPath.join(isolatedHome, ".cache");
delete process.env.SUDO_USER; delete process.env.SUDO_HOME;
process.on("exit", () => isolatedFs.rmSync(isolatedHome, { recursive: true, force: true }));

// Entry points supply a local callback so node:test attributes cases to them.
module.exports = function registerPublicApiPathTests(test) {
  const assert = require("node:assert/strict");
  const fs = require("node:fs");
  const path = require("node:path");
  const http = require("node:http");
  const https = require("node:https");
  const cp = require("node:child_process");
  for (const name of Object.keys(process.env)) {
    if (/^(ANTHROPIC_|OPENAI_|CODEX_|CLAUDE_|AIGORA_CLEF_|AIGORA_JEV_)/.test(name)) delete process.env[name];
  }
  const config = require("../lib/config");
  const flags = require("../lib/room-execution-flags");
  const credentials = require("../lib/credential-leases");
  const policy = require("../lib/model-policy");
  let daemon = {};
  config.loadConfig = () => daemon;
  const KEY = { claude: "fixture-anthropic-api-key", codex: "fixture-openai-api-key" };

  function listen(server) {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(server.address().port); });
    });
  }
  async function close(server) {
    server.closeAllConnections?.();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
  function apiAdapter(vendor, cwd) {
    return vendor === "claude"
      ? require("../lib/yoke/adapters/claude").createClaudeAdapter({ cwd })
      : require("../lib/yoke/adapters/codex").createCodexAdapter({ cwd });
  }

  test("both public agents fail clearly without keys, before a broker or agent launch", async () => {
    daemon = {};
    let opens = 0;
    for (const vendor of ["claude", "codex"]) {
      const adapter = apiAdapter(vendor, process.env.HOME);
      try {
        await assert.rejects(adapter.createQuery({ cwd: process.env.HOME,
          credentialContext: { env: {}, credentialBroker: { open() { opens++; assert.fail("missing-key broker opened"); } } } }),
          error => error.code === "credential_unavailable" && /add an API key/.test(error.message));
      } finally { if (adapter.shutdown) await adapter.shutdown(); }
    }
    assert.equal(opens, 0);
  });

  function stream(res, events) {
    res.writeHead(200, { "content-type": "text/event-stream", "request-id": "mock-request" });
    for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.end();
  }
  function answer(vendor, req, res, body) {
    if (vendor === "claude") {
      if (req.url.startsWith("/v1/messages/count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" }); res.end('{"input_tokens":8}'); return;
      }
      assert.equal(req.url.split("?")[0], "/v1/messages");
      const message = { id: "msg_mock", type: "message", role: "assistant", model: body.model, content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, output_tokens: 0 } };
      if (!body.stream) { message.content = [{ type: "text", text: "mock API answer" }]; message.stop_reason = "end_turn";
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(message)); return; }
      stream(res, [
        ["message_start", { type: "message_start", message }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "mock API answer" } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } }],
        ["message_stop", { type: "message_stop" }],
      ]);
    } else {
      assert.equal(req.url, "/v1/responses");
      const item = { id: "msg_mock", type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "mock API answer", annotations: [] }] };
      const response = { id: "resp_mock", object: "response", created_at: 1, model: body.model, status: "completed",
        output: [item], usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 } };
      let sequence = 0;
      const event = (type, fields) => [type, { type, sequence_number: sequence++, ...fields }];
      stream(res, [
        event("response.created", { response: { ...response, status: "in_progress", output: [] } }),
        event("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } }),
        event("response.content_part.added", { item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }),
        event("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: "mock API answer" }),
        event("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text: "mock API answer" }),
        event("response.output_item.done", { output_index: 0, item }),
        event("response.completed", { response }),
      ]);
    }
  }

  test("real Anthropic and OpenAI agent runs use configured keys through mock HTTP upstreams", { timeout: 60000 }, async t => {
    // Probe the sandbox limitation first, without starting an agent or making paid calls.
    const probe = http.createServer();
    try { await listen(probe); }
    catch (error) { if (error.code === "EPERM" || error.code === "EACCES") { t.skip(`NOT_RUN: localhost listen blocked (${error.code})`); return; } throw error; }
    finally { await close(probe); }
    const tlsDir = fs.mkdtempSync(path.join(process.env.HOME, "mock-tls-"));
    const keyFile = path.join(tlsDir, "key.pem"), certFile = path.join(tlsDir, "cert.pem");
    const tls = cp.spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", keyFile, "-out", certFile], { stdio: "ignore" });
    if (tls.error?.code === "EPERM") { t.skip("NOT_RUN: test certificate subprocess blocked (EPERM)"); return; }
    assert.equal(tls.status, 0, "openssl is required to create the ephemeral mock HTTP-over-TLS certificate");
    const requests = [], mockErrors = [], servers = {}, upstream = {};
    let broker, handle;
    // The real agent binaries talk only to the synthetic broker upstreams. Opt in
    // locally after the listen probe, with every login/config path in this home.
    const previousAllow = process.env.AIGORA_ALLOW_REAL_CLI;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = path.join(isolatedHome, ".codex");
    fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
    process.env.AIGORA_ALLOW_REAL_CLI = "1";
    try {
      for (const vendor of ["claude", "codex"]) {
        // The production broker forwards HTTPS, so mocks speak HTTP over TLS.
        const server = https.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }, (req, res) => {
          const chunks = [];
          req.on("data", chunk => chunks.push(chunk));
          req.on("end", () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString());
              assert.equal(vendor === "claude" ? req.headers["x-api-key"] : req.headers.authorization,
                vendor === "claude" ? KEY[vendor] : "Bearer " + KEY[vendor]);
              assert.equal(body.model, policy.POLICY[vendor].model);
              requests.push({ vendor, path: req.url, keyPresent: true });
              answer(vendor, req, res, body);
            } catch (error) { mockErrors.push(error); res.writeHead(500); res.end("mock assertion failed"); }
          });
        });
        servers[vendor] = server;
        upstream[vendor] = { host: "127.0.0.1", port: await listen(server), ca: fs.readFileSync(certFile) };
      }
      daemon = { roomExecution: { apiKeys: { ...KEY }, broker: { enabled: true } } };
      broker = require("../lib/credential-broker").createCredentialBroker({
        getKey: vendor => flags.apiKey(vendor, {}), checkModel: policy.checkModel, upstream, dir: path.join(process.env.HOME, "broker"),
      });
      for (const vendor of ["claude", "codex"]) {
        const cwd = fs.mkdtempSync(path.join(isolatedHome, "workspace-"));
        const adapter = apiAdapter(vendor, cwd);
        const context = { env: {}, actor: { id: "fixture-user" }, session: { channelId: "fixture-channel" }, credentialBroker: broker };
        const lease = await credentials.resolveCredential(context, vendor);
        assert.equal(lease.source, "api_key");
        assert.notEqual(lease.options.injectEnv[vendor === "claude" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"], KEY[vendor], "agent receives a run token, not the upstream key");
        const events = [];
        try {
          handle = await adapter.createQuery({ cwd, model: policy.POLICY[vendor].model, effort: "low", credentialContext: context, credentialLease: lease,
            adapterOptions: { CLAUDE: { maxTurns: 1, tools: [], permissionMode: "default" }, CODEX: { webSearchMode: "disabled", approvalPolicy: "never", sandboxMode: "read-only" } } });
          handle.pushMessage("Reply exactly: mock API answer");
          for await (const event of handle) {
            events.push(event);
            if (event.type === "result" || event.yokeType === "result") break;
          }
          assert.match(JSON.stringify(events), /mock API answer/, vendor + " run consumed the mock API answer");
          assert.ok(requests.some(req => req.vendor === vendor), vendor + " request reached the synthetic upstream with the configured key");
          assert.deepEqual(mockErrors, []);
        } finally { handle?.close(); handle = null; if (adapter.shutdown) await adapter.shutdown(); await lease.close(); }
        // Removing the key must reject a new run before any new upstream request.
        delete daemon.roomExecution.apiKeys[vendor];
        const before = requests.length;
        await assert.rejects(credentials.resolveCredential(context, vendor), /credential_unavailable.*API key/);
        assert.equal(requests.length, before);
      }
    } finally {
      if (previousAllow === undefined) delete process.env.AIGORA_ALLOW_REAL_CLI; else process.env.AIGORA_ALLOW_REAL_CLI = previousAllow;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodexHome;
      handle?.close();
      for (const server of Object.values(servers)) await close(server);
      daemon = {};
      fs.rmSync(tlsDir, { recursive: true, force: true });
    }
  });
};

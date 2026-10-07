#!/usr/bin/env node
// Aigora MCP Bridge - Native Messaging Host
// Communicates with the Aigora Chrome Extension via Chrome Native Messaging protocol.
// Spawns and manages local MCP server processes, relays JSON-RPC messages.

var child_process = require("child_process");
var fs = require("fs");
var path = require("path");
var os = require("os");

// ---------- Native Messaging I/O ----------

var _inputBuffer = Buffer.alloc(0);

function sendMessage(obj) {
  var json = JSON.stringify(obj);
  var buf = Buffer.from(json, "utf8");
  var header = Buffer.alloc(4);
  header.writeUInt32LE(buf.length, 0);
  process.stdout.write(header);
  process.stdout.write(buf);
}

process.stdin.on("readable", function () {
  var chunk;
  while ((chunk = process.stdin.read()) !== null) {
    _inputBuffer = Buffer.concat([_inputBuffer, chunk]);
    drainInput();
  }
});

function drainInput() {
  while (_inputBuffer.length >= 4) {
    var msgLen = _inputBuffer.readUInt32LE(0);
    if (_inputBuffer.length < 4 + msgLen) break;
    var json = _inputBuffer.slice(4, 4 + msgLen).toString("utf8");
    _inputBuffer = _inputBuffer.slice(4 + msgLen);
    try {
      var msg = JSON.parse(json);
      handleMessage(msg);
    } catch (e) {
      sendMessage({ type: "error", error: "Invalid JSON: " + e.message });
    }
  }
}

process.stdin.on("end", function () {
  // Extension disconnected, clean up all processes
  shutdown();
});

// ---------- MCP Process Manager ----------

var _processes = {}; // name -> { proc, buffer, ready, tools, pendingInit }
var _configCache = null; // parsed config
// Only local configuration present at startup grants executable authority.
// Native messages may select these fixed entries, never create executable authority.
var _approvedProcesses = new Map();
var _approvedImports = [];
var _pendingRequests = {}; // callId -> { name, timer }
var _jsonRpcId = 1;
var _initCallbacks = {}; // jsonRpcId -> { name, resolve }

function validProcessConfig(cfg) {
  return cfg && typeof cfg.command === "string" && cfg.command.trim() && cfg.command.indexOf("\0") === -1 &&
    (cfg.args === undefined || (Array.isArray(cfg.args) && cfg.args.every(function (arg) {
      return typeof arg === "string" && arg.indexOf("\0") === -1;
    }))) && (cfg.env === undefined || (cfg.env && typeof cfg.env === "object" && !Array.isArray(cfg.env) &&
      Object.keys(cfg.env).every(function (key) {
        return key && !/[=\0]/.test(key) && typeof cfg.env[key] === "string" && cfg.env[key].indexOf("\0") === -1;
      })));
}

function approvedProcess(name, cfg) {
  var approved = _approvedProcesses.get(name);
  if (!approved || !validProcessConfig(cfg) || cfg.command !== approved.command ||
      JSON.stringify(cfg.args || []) !== JSON.stringify(approved.args)) return null;
  var env = cfg.env || {}, keys = Object.keys(env);
  if (keys.length !== Object.keys(approved.env).length || keys.some(function (key) {
    return !Object.prototype.hasOwnProperty.call(approved.env, key) || env[key] !== approved.env[key];
  })) return null;
  return approved;
}

function readConfig(configPath) {
  var resolved = configPath.replace(/^~/, os.homedir());
  try {
    var raw = fs.readFileSync(resolved, "utf8");
    var parsed = JSON.parse(raw);
    _configCache = parsed.mcpServers || {};
    var servers = [];
    var names = Object.keys(_configCache);
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var cfg = _configCache[name];
      servers.push({
        name: name,
        transport: cfg.url ? "http" : "stdio",
        command: cfg.command || null,
        url: cfg.url || null,
      });
    }
    return { servers: servers };
  } catch (e) {
    return { error: e.message };
  }
}

function spawnServer(name) {
  if (_processes[name]) {
    return { error: "Server already running: " + name };
  }
  if (!_configCache || !_configCache[name]) {
    return { error: "Server not found in config: " + name };
  }
  var cfg = _configCache[name];
  if (cfg.url) {
    return { error: "HTTP servers do not need spawning: " + name };
  }
  if (!cfg.command) {
    return { error: "No command configured for: " + name };
  }
  // Use the pinned executable/argv/env, not values supplied by add_server/read_config.
  cfg = approvedProcess(name, cfg);
  if (!cfg) return { error: "Stdio server is not approved by local startup config: " + name };

  // Ensure PATH includes common Node.js binary locations
  // (Chrome launches native hosts with a minimal PATH)
  var nodeBinDir = path.dirname(process.execPath);
  var extraPaths = [
    nodeBinDir,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    path.join(os.homedir(), ".nvm/versions/node", process.version, "bin"),
  ];
  var currentPath = process.env.PATH || "";
  var fullPath = extraPaths.concat(currentPath.split(path.delimiter)).filter(Boolean);
  var seen = {};
  var dedupedPath = [];
  for (var pi = 0; pi < fullPath.length; pi++) {
    if (!seen[fullPath[pi]]) { seen[fullPath[pi]] = true; dedupedPath.push(fullPath[pi]); }
  }

  var env = Object.assign({}, process.env, cfg.env || {}, { PATH: dedupedPath.join(path.delimiter) });
  var proc;
  try {
    proc = child_process.spawn(cfg.command, cfg.args || [], {
      env: env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
  } catch (e) {
    return { error: "Failed to spawn: " + e.message };
  }

  var entry = {
    proc: proc,
    buffer: "",
    ready: false,
    tools: [],
    pendingInit: null,
  };
  _processes[name] = entry;

  proc.stdout.on("data", function (chunk) {
    entry.buffer += chunk.toString("utf8");
    drainJsonRpc(name, entry);
  });

  proc.stderr.on("data", function (chunk) {
    sendMessage({ type: "server_log", server: name, log: chunk.toString("utf8") });
  });

  proc.on("error", function (err) {
    sendMessage({ type: "server_status", server: name, status: "error", error: err.message });
    delete _processes[name];
  });

  proc.on("exit", function (code, signal) {
    sendMessage({ type: "server_status", server: name, status: "exited", code: code, signal: signal });
    delete _processes[name];
  });

  // Send initialize
  var initId = _jsonRpcId++;
  var initMsg = JSON.stringify({
    jsonrpc: "2.0",
    id: initId,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "aigora-mcp-bridge", version: "1.0.0" },
    },
  }) + "\n";
  proc.stdin.write(initMsg);

  _initCallbacks[initId] = { name: name, phase: "initialize" };

  return { ok: true };
}

function killServer(name) {
  var entry = _processes[name];
  if (!entry) return { error: "Server not running: " + name };
  entry.proc.kill("SIGTERM");
  setTimeout(function () {
    if (entry.proc && !entry.proc.killed) entry.proc.kill("SIGKILL");
  }, 3000);
  delete _processes[name];
  return { ok: true };
}

function drainJsonRpc(name, entry) {
  // MCP uses newline-delimited JSON-RPC
  var lines = entry.buffer.split("\n");
  entry.buffer = lines.pop(); // keep incomplete line
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    try {
      var msg = JSON.parse(line);
      handleMcpResponse(name, msg);
    } catch (e) {
      // skip unparseable lines
    }
  }
}

function handleMcpResponse(name, msg) {
  // Check if this is a response to our initialize or tools/list call
  if (msg.id !== undefined && _initCallbacks[msg.id]) {
    var cb = _initCallbacks[msg.id];
    delete _initCallbacks[msg.id];

    if (cb.phase === "initialize") {
      // Send initialized notification
      var entry = _processes[name];
      if (entry) {
        entry.proc.stdin.write(JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }) + "\n");

        // Now request tools/list
        var toolsId = _jsonRpcId++;
        _initCallbacks[toolsId] = { name: name, phase: "tools_list" };
        entry.proc.stdin.write(JSON.stringify({
          jsonrpc: "2.0",
          id: toolsId,
          method: "tools/list",
          params: {},
        }) + "\n");
      }
      return;
    }

    if (cb.phase === "tools_list") {
      var tools = (msg.result && msg.result.tools) || [];
      var entry2 = _processes[name];
      if (entry2) {
        entry2.tools = tools;
        entry2.ready = true;
      }
      sendMessage({
        type: "server_ready",
        server: name,
        tools: tools,
      });
      return;
    }
  }

  // Regular tool call response: forward to extension
  if (msg.id !== undefined && _pendingRequests[msg.id]) {
    var req = _pendingRequests[msg.id];
    delete _pendingRequests[msg.id];
    if (req.timer) clearTimeout(req.timer);

    if (msg.error) {
      sendMessage({
        type: "mcp_response",
        callId: req.callId,
        error: msg.error.message || JSON.stringify(msg.error),
      });
    } else {
      sendMessage({
        type: "mcp_response",
        callId: req.callId,
        result: msg.result,
      });
    }
    return;
  }

  // Notifications from MCP server (e.g. progress, log)
  if (!msg.id && msg.method) {
    sendMessage({
      type: "server_notification",
      server: name,
      method: msg.method,
      params: msg.params,
    });
  }
}

function relayToolCall(name, callId, method, params) {
  var entry = _processes[name];
  if (!entry || !entry.ready) {
    sendMessage({
      type: "mcp_response",
      callId: callId,
      error: "Server not running or not ready: " + name,
    });
    return;
  }

  var rpcId = _jsonRpcId++;
  _pendingRequests[rpcId] = {
    callId: callId,
    name: name,
    timer: setTimeout(function () {
      delete _pendingRequests[rpcId];
      sendMessage({
        type: "mcp_response",
        callId: callId,
        error: "Tool call timed out after 30s",
      });
    }, 30000),
  };

  var rpcMsg = JSON.stringify({
    jsonrpc: "2.0",
    id: rpcId,
    method: method,
    params: params,
  }) + "\n";
  entry.proc.stdin.write(rpcMsg);
}

function getStatus() {
  var result = {};
  var names = Object.keys(_processes);
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    var entry = _processes[name];
    result[name] = {
      ready: entry.ready,
      tools: entry.tools.length,
      pid: entry.proc.pid,
    };
  }
  return result;
}

// ---------- Aigora Config Management (<home>/mcp.json) ----------
// <home> follows lib/env-compat.js resolveHome: AIGORA_HOME, else dirname(AIGORA_CONFIG), else ~/.aigora.
// Chrome spawns this process without the daemon's environment, and the daemon's migration of the
// legacy ~/.clagentic may not have run yet. So when no env is set, ~/.aigora is absent and
// ~/.clagentic or ~/.clay (first found) exists, the config is READ from the legacy dir; nothing is ever written there
// (writes are refused until the daemon has migrated the data dir). Legacy CLAGENTIC_HOME is ignored.
// Evaluated on every call so a migration that happens while this host runs is picked up.

function resolveConfigLocation() {
  var envHome = process.env.AIGORA_HOME;
  if (!envHome && process.env.AIGORA_CONFIG) {
    // Same rule as lib/env-compat.js: <home>/console/daemon.json -> home is the parent of console/.
    var cfgDir = path.dirname(process.env.AIGORA_CONFIG);
    envHome = path.basename(cfgDir) === "console" ? path.dirname(cfgDir) : cfgDir;
  }
  if (envHome) return { file: path.join(envHome, "mcp.json"), legacy: false };
  var fresh = path.join(os.homedir(), ".aigora");
  if (!fs.existsSync(fresh)) {
    // Both legacy homes are read-only fallbacks; ~/.aigora is never created while one exists.
    var olds = [path.join(os.homedir(), ".clagentic"), path.join(os.homedir(), ".clay")];
    for (var i = 0; i < olds.length; i++) {
      if (fs.existsSync(olds[i])) return { file: path.join(olds[i], "mcp.json"), legacy: true };
    }
  }
  return { file: path.join(fresh, "mcp.json"), legacy: false };
}

function ensureAigoraConfig() {
  var loc = resolveConfigLocation();
  if (loc.legacy) return loc;
  var dir = path.dirname(loc.file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(loc.file)) {
    fs.writeFileSync(loc.file, JSON.stringify({ mcpServers: {}, include: [] }, null, 2));
  }
  return loc;
}

function readAigoraConfig() {
  var loc = ensureAigoraConfig();
  try {
    return JSON.parse(fs.readFileSync(loc.file, "utf8"));
  } catch (e) {
    return { mcpServers: {}, include: [] };
  }
}

function migratedAigoraConfig() {
  var loc = ensureAigoraConfig();
  if (loc.legacy) throw new Error("Aigora data directory is not migrated yet (only a legacy ~/.clagentic or ~/.clay exists). Start Aigora once, then retry.");
  return loc;
}

function writeAigoraConfig(config) {
  fs.writeFileSync(migratedAigoraConfig().file, JSON.stringify(config, null, 2));
}

// The built-in aigora-* server names are reserved; an external server may not take them.
var RESERVED_SERVER_NAMES = ["aigora-browser", "aigora-tools", "aigora-datastore"];

function addServer(name, command, args, env) {
  if (RESERVED_SERVER_NAMES.indexOf(name) !== -1) return { ok: false, error: "Reserved MCP server name: " + name };
  migratedAigoraConfig();
  var approved = approvedProcess(name, { command: command, args: args, env: env });
  if (!approved) return { ok: false, error: "Configure stdio executables, argv and env in local mcp.json, then restart the native host." };
  var config = readAigoraConfig();
  config.mcpServers = config.mcpServers || {};
  config.mcpServers[name] = approved;
  writeAigoraConfig(config);
  // Also update in-memory cache
  _configCache = _configCache || {};
  _configCache[name] = config.mcpServers[name];
  spawnServer(name);
  return { ok: true };
}

function removeServer(name) {
  var config = readAigoraConfig();
  if (config.mcpServers && config.mcpServers[name]) {
    delete config.mcpServers[name];
    writeAigoraConfig(config);
  }
  // Kill if running
  if (_processes[name]) killServer(name);
  if (_configCache) delete _configCache[name];
  return { ok: true };
}

function getAllServers() {
  var config = readAigoraConfig();
  var merged = Object.assign({}, config.mcpServers || {});

  // Merge included configs
  var includes = config.include || [];
  for (var i = 0; i < includes.length; i++) {
    var resolved = includes[i].replace(/^~/, os.homedir());
    try {
      var ext = JSON.parse(fs.readFileSync(resolved, "utf8"));
      var extServers = ext.mcpServers || {};
      var names = Object.keys(extServers);
      for (var j = 0; j < names.length; j++) {
        if (!merged[names[j]]) merged[names[j]] = extServers[names[j]];
      }
    } catch (e) {
      // Skip unreadable files
    }
  }

  // Update cache
  _configCache = merged;

  var servers = [];
  var allNames = Object.keys(merged);
  for (var k = 0; k < allNames.length; k++) {
    var n = allNames[k];
    var cfg = merged[n];
    servers.push({
      name: n,
      transport: cfg.url ? "http" : "stdio",
      command: cfg.command || null,
      url: cfg.url || null,
      running: !!(_processes[n] && _processes[n].ready)
    });
  }
  return { servers: servers };
}

function importConfig(filePath) {
  // Persisting a message-selected import would bypass approval on the next startup.
  if (typeof filePath !== "string" || _approvedImports.indexOf(filePath) === -1) {
    return { error: "Configure imports in local mcp.json, then restart the native host." };
  }
  var resolved = filePath.replace(/^~/, os.homedir());
  try {
    var ext = JSON.parse(fs.readFileSync(resolved, "utf8"));
    var count = Object.keys(ext.mcpServers || {}).length;
    if (count === 0) return { error: "No mcpServers found in " + filePath };

    var config = readAigoraConfig();
    config.include = config.include || [];
    if (config.include.indexOf(filePath) === -1) {
      config.include.push(filePath);
      writeAigoraConfig(config);
    }
    return { ok: true, count: count };
  } catch (e) {
    return { error: "Cannot read file: " + e.message };
  }
}

function getImports() {
  var config = readAigoraConfig();
  return { paths: config.include || [] };
}

function removeImport(filePath) {
  var config = readAigoraConfig();
  config.include = (config.include || []).filter(function (p) { return p !== filePath; });
  writeAigoraConfig(config);
  return { ok: true };
}

// ---------- Message Router ----------

function handleMessage(msg) {
  switch (msg.type) {
    case "ping":
      sendMessage({ callId: msg.callId, type: "pong" });
      break;

    // Config management
    case "add_server":
      var addResult = addServer(msg.name, msg.command, msg.args, msg.env);
      sendMessage({ callId: msg.callId, ok: addResult.ok, error: addResult.error });
      break;

    case "remove_server":
      var removeResult = removeServer(msg.name);
      sendMessage({ callId: msg.callId, ok: removeResult.ok, error: removeResult.error });
      break;

    case "get_servers":
      var serversResult = getAllServers();
      sendMessage({ callId: msg.callId, servers: serversResult.servers });
      break;

    case "import_config":
      var importResult = importConfig(msg.path);
      sendMessage({ callId: msg.callId, ok: importResult.ok, count: importResult.count, error: importResult.error });
      break;

    case "get_imports":
      var importsResult = getImports();
      sendMessage({ callId: msg.callId, paths: importsResult.paths });
      break;

    case "remove_import":
      var removeImpResult = removeImport(msg.path);
      sendMessage({ callId: msg.callId, ok: removeImpResult.ok });
      break;

    // Legacy: read external config directly
    case "read_config":
      var configResult = readConfig(msg.path);
      sendMessage({ type: "config_result", callId: msg.callId, data: configResult });
      break;

    // Process management
    case "spawn_server":
      var spawnResult = spawnServer(msg.name);
      sendMessage({ type: "spawn_result", callId: msg.callId, server: msg.name, data: spawnResult });
      break;

    case "kill_server":
      var killResult = killServer(msg.name);
      sendMessage({ type: "kill_result", callId: msg.callId, server: msg.name, data: killResult });
      break;

    case "mcp_request":
      relayToolCall(msg.server, msg.callId, msg.method, msg.params);
      break;

    case "status":
      sendMessage({ type: "status_result", callId: msg.callId, servers: getStatus() });
      break;

    default:
      sendMessage({ callId: msg.callId, error: "Unknown message type: " + msg.type });
  }
}

// ---------- Cleanup ----------

function shutdown() {
  var names = Object.keys(_processes);
  for (var i = 0; i < names.length; i++) {
    var entry = _processes[names[i]];
    if (entry && entry.proc) {
      try { entry.proc.kill("SIGTERM"); } catch (e) { /* ignore */ }
    }
  }
  _processes = {};
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ---------- Auto-start servers from config ----------

(function autoStart() {
  var config = readAigoraConfig();
  _approvedImports = Object.freeze((Array.isArray(config.include) ? config.include : []).slice());
  var result = getAllServers();
  var servers = result.servers || [];
  for (var ai = 0; ai < servers.length; ai++) {
    var cfg = _configCache[servers[ai].name];
    if (cfg.url || !validProcessConfig(cfg)) continue;
    _approvedProcesses.set(servers[ai].name, Object.freeze({ command: cfg.command,
      args: Object.freeze((cfg.args || []).slice()),
      env: Object.freeze(Object.assign(Object.create(null), cfg.env || {})) }));
  }
  for (var i = 0; i < servers.length; i++) {
    if (servers[i].transport === "stdio" && servers[i].command) {
      spawnServer(servers[i].name);
    }
  }
})();

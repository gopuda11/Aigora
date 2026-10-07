module.exports = require("./extensions").select("project", function () {
var module = { exports: {} };
var fs = require("fs");
var path = require("path");
var os = require("os");
var crypto = require("crypto");
var { createSessionManager, stampActivityLocalId } = require("./sessions");
var { createSDKBridge, createMessageQueue } = require("./sdk-bridge");
var { createTerminalManager } = require("./terminal-manager");
var { createNotesManager } = require("./notes");
var { fetchLatestVersion, fetchVersion, isNewer } = require("./updater");
var { execFileSync, spawn } = require("child_process");
var usersModule = require("./users");
var { resolveOsUserInfo, fsAsUser, grantProjectAccess } = require("./os-users");
var crisisSafety = require("./crisis-safety");
var userPresence = require("./user-presence");
var visibility = require("./user-visibility");
var { attachUserMention } = require("./project-user-mention");
var { attachSocial } = require("./project-social");
var { attachLoop } = require("./project-loop");
var { attachFileWatch } = require("./project-file-watch");
var { attachHTTP } = require("./project-http");
var { attachImage } = require("./project-image");
var { attachKnowledge } = require("./project-knowledge");
var { attachFilesystem } = require("./project-filesystem");
var { attachSessions } = require("./project-sessions");
var { createPrivateSessionAccess, isChannelBound } = require("./private-session-access");
var { attachUserMessage } = require("./project-user-message");
var { attachConnection } = require("./project-connection");
var { detectLite } = require("./lite-detect");
var { attachMcp } = require("./project-mcp");
var { createLocalMcp } = require("./mcp-local");
var { attachTeam } = require("./project-team");
// project-notifications is attached globally in server.js, passed via opts.notificationsModule

// --- Context Sources persistence ---
var _ctxSrcConfig = require("./config");
var _ctxSrcDir = path.join(_ctxSrcConfig.CONFIG_DIR, "context-sources");

function loadContextSources(slug, sessionId) {
  try {
    var key = sessionId ? slug + "--" + sessionId : slug;
    var filePath = path.join(_ctxSrcDir, key + ".json");
    var data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return data.active || [];
  } catch (e) {
    return [];
  }
}

function saveContextSources(slug, sessionId, activeIds) {
  try {
    if (!fs.existsSync(_ctxSrcDir)) {
      fs.mkdirSync(_ctxSrcDir, { recursive: true });
    }
    var key = sessionId ? slug + "--" + sessionId : slug;
    var filePath = path.join(_ctxSrcDir, key + ".json");
    fs.writeFileSync(filePath, JSON.stringify({ active: activeIds }), "utf8");
  } catch (e) {
    console.error("[context-sources] Failed to save:", e.message);
  }
}

// Validate environment variable string (KEY=VALUE per line)
// Returns null if valid, or an error string if invalid
function validateEnvString(str) {
  if (!str || !str.trim()) return null;
  var lines = str.split("\n");
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line || line.charAt(0) === "#") continue;
    // Must be KEY=VALUE format
    var eqIdx = line.indexOf("=");
    if (eqIdx < 1) return "Invalid format at line " + (i + 1) + ": expected KEY=VALUE";
    var key = line.substring(0, eqIdx);
    // Key must be valid env var name (no shell metacharacters)
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
      return "Invalid variable name at line " + (i + 1) + ": " + key;
    }
    // Value must not contain shell injection characters
    var value = line.substring(eqIdx + 1);
    if (/[`$\\;|&><(){}\n]/.test(value) && !/^["'].*["']$/.test(value)) {
      return "Potentially unsafe value at line " + (i + 1) + ": shell metacharacters detected";
    }
  }
  return null;
}

// YOKE adapter (replaces direct SDK access)
var yoke = require("./yoke");

// --- Shared constants ---
var IGNORED_DIRS = new Set(["node_modules", ".git", ".next", "__pycache__", ".cache", "dist", "build", ".aigora", ".clagentic", ".clay", ".claude-relay"]);
var BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx",
  ".exe", ".dll", ".so", ".dylib",
  ".mp3", ".mp4", ".wav", ".avi", ".mov",
  ".pyc", ".o", ".a", ".class",
]);
var IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"]);
var FS_MAX_SIZE = 512 * 1024;
function safePath(base, requested) {
  var resolved = path.resolve(base, requested);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  try {
    var real = fs.realpathSync(resolved);
    if (real !== base && !real.startsWith(base + path.sep)) return null;
    return real;
  } catch (e) {
    return null;
  }
}

// Resolve an absolute path without requiring it to be within cwd.
// Used as fallback in OS user mode where ACL enforces access at the OS level.
function safeAbsPath(requested) {
  if (!requested) return null;
  var resolved = path.resolve(requested);
  try {
    return fs.realpathSync(resolved);
  } catch (e) {
    return null;
  }
}

// Resolve an absolute path within the Claude data directory (~/.claude/).
// Used as read-only fallback so plan files and other Claude-owned paths that live
// outside the project cwd (e.g. ~/.claude/plans/) can be previewed in the file viewer.
function safeClaudePath(requested) {
  if (!requested) return null;
  var claudeDir = path.join(require("./config").REAL_HOME, ".claude");
  var resolved = path.resolve(requested);
  if (resolved !== claudeDir && !resolved.startsWith(claudeDir + path.sep)) return null;
  try {
    var real = fs.realpathSync(resolved);
    if (real !== claudeDir && !real.startsWith(claudeDir + path.sep)) return null;
    return real;
  } catch (e) {
    return null;
  }
}

// Per-recipient session filter for sm.sendEach. The revocation tracker is the private-session gate; without it
// nothing can be judged, so every session is refused (fail closed). Deletion notices and read-content frames
// reach only the owner or the current room administrator; other frames follow canAccessSession.
function sendEachFilter(revocation, privateAccess, usersModule, user, socket, purpose) {
  return function (s) {
    if (!revocation) return false;
    if (revocation.isPrivate(s) && !revocation.mayRead(socket, s)) return false;
    if (purpose === "session_deleted" || purpose === "session_read") {
      if (!privateAccess) return false;
      return privateAccess.canReadSession(user, s, { visibility: "public" });
    }
    return usersModule.canAccessSession(user.id, s, { visibility: "public" });
  };
}

/**
 * Create a project context — per-project state and handlers.
 * opts: { cwd, slug, title, pushModule, debug, dangerouslySkipPermissions,
 *         currentVersion, canAccessProjectSlug }
 */
function createProjectContext(opts) {
  var cwd = opts.cwd;
  var slug = opts.slug;
  var project = path.basename(cwd);
  var title = opts.title || null;
  var icon = opts.icon || null;
  var folderName = opts.folderName || null;
  var preferredAgent = opts.preferredAgent || null;
  var pushModule = opts.pushModule || null;
  var debug = opts.debug || false;
  // dangerouslySkipPermissions is a global bypass that disables tool-call approval
  // for EVERY user in the daemon. In multi-user mode this is unsafe: an admin enabling
  // it for convenience removes approval gates for all users simultaneously.
  // We hard-disable it when multi-user mode is active so the per-user permission
  // model remains intact. Admins who want bypassPermissions must do so per-session.
  var dangerouslySkipPermissionsConfigured = opts.dangerouslySkipPermissions || false;
  var dangerouslySkipPermissions = false;
  var currentVersion = opts.currentVersion;
  var lanHost = opts.lanHost || null;
  var getProjectCount = opts.getProjectCount || function () { return 1; };
  var getProjectList = opts.getProjectList || function () { return []; };
  var getProjectAccess = typeof opts.getProjectAccess === "function"
    ? opts.getProjectAccess
    : function () { return null; };
  // Cross-project forwarding is denied unless the server re-authorizes the
  // authenticated principal against the target project's authoritative ACL.
  var canAccessProjectSlug = typeof opts.canAccessProjectSlug === "function"
    ? opts.canAccessProjectSlug
    : function () { return false; };
  var getAllProjectSessions = opts.getAllProjectSessions || function () { return []; };
  var getHubSchedules = opts.getHubSchedules || function () { return []; };
  // lr-0aa7b6: per-session unread lookup consumed by the Home Hub Recent
  // Sessions data path (project-loop.js hub_recent_sessions_list) to
  // attribute alert state to the individual notifying session rather than
  // the whole project.
  var getSessionUnread = opts.getSessionUnread || function () { return 0; };
  var moveScheduleToProject = opts.moveScheduleToProject || function () { return { ok: false, error: "Not supported" }; };
  var moveAllSchedulesToProject = opts.moveAllSchedulesToProject || function () { return { ok: false, error: "Not supported" }; };
  var getScheduleCount = opts.getScheduleCount || function () { return 0; };
  var onProcessingChanged = opts.onProcessingChanged || function () {};
  var onSessionDone = opts.onSessionDone || function () {};
  // lr-13c047: fired when a session is deleted so server.js can prune the
  // corresponding crossProjectUnread entry (Badge A prune-on-delete fix).
  var onSessionDeleted = opts.onSessionDeleted || function () {};
  var onPresenceChange = opts.onPresenceChange || function () {};
  var updateChannel = opts.updateChannel || "stable";
  var onSetUpdateChannel = opts.onSetUpdateChannel || null;
  var osUsers = opts.osUsers || false;
  var projectOwnerId = opts.projectOwnerId || null;
  var worktreeMeta = opts.worktreeMeta || null; // { parentSlug, branch, accessible }
  var onCreateWorktree = opts.onCreateWorktree || null;
  var serverPort = opts.port || 2633;
  var serverTls = opts.tls || false;
  var serverAuthToken = opts.authToken || null;
  // lr-2ea2a7: daemon.json knob overriding the in-heap session-history tail
  // cap (default HISTORY_INMEM_MAX_DEFAULT=1000 in lib/sessions.js).
  var historyInMemMax = opts.historyInMemMax;
  var latestVersion = null;
  var sessionTitleMigrationScheduled = false;

  // --- Lite detection (cached once per project context, not per WS connect) ---
  var _liteStatus = detectLite();

  // --- YOKE adapters (multi-vendor, lazy init) ---
  var _yokeState = yoke.createAdapters({ cwd: cwd, slug: slug });
  var adapters = _yokeState.adapters;
  var defaultVendor = adapters.claude ? "claude" : Object.keys(adapters)[0] || "claude";
  var adapter = adapters[defaultVendor] || null;

  // Browser MCP server runs in-process via createSdkMcpServer (no child process spawn).
  // Do NOT write to .claude-local/settings.json -- the SDK reads that too, causing duplicate spawns.

  // --- Image engine (delegated to project-image.js) ---
  var _image = attachImage({ cwd: cwd, slug: slug });
  var imagesDir = _image.imagesDir;
  var hydrateImageRefs = _image.hydrateImageRefs;
  var saveImageFile = _image.saveImageFile;

  // --- OS-level user isolation helper ---
  // Returns the Linux username for the session owner.
  // Each session uses its own owner's Claude account and credits.
  function getLinuxUserForSession(session) {
    if (!osUsers) return null;
    if (!session.ownerId) return null;
    var user = usersModule.findUserById(session.ownerId);
    if (!user || !user.linuxUser) return null;
    return user.linuxUser;
  }

  function ensureProjectAccessForSession(session) {
    var linuxUser = getLinuxUserForSession(session);
    if (linuxUser) {
      grantProjectAccess(cwd, linuxUser);
    }
    return linuxUser;
  }

  function getLinuxUserForWs(ws) {
    if (!osUsers) return null;
    if (!ws._aigoraUser || !ws._aigoraUser.linuxUser) return null;
    return ws._aigoraUser.linuxUser;
  }

  // Cache resolved OS user info to avoid repeated getent calls
  var osUserInfoCache = {};
  function getOsUserInfoForWs(ws) {
    var linuxUser = getLinuxUserForWs(ws);
    if (!linuxUser) return null;
    if (osUserInfoCache[linuxUser]) return osUserInfoCache[linuxUser];
    try {
      var info = resolveOsUserInfo(linuxUser);
      osUserInfoCache[linuxUser] = info;
      return info;
    } catch (e) {
      console.error("[project] Failed to resolve OS user info for " + linuxUser + ":", e.message);
      return null;
    }
  }

  function getOsUserInfoForReq(req) {
    if (!osUsers) return null;
    if (!req._aigoraUser || !req._aigoraUser.linuxUser) return null;
    var linuxUser = req._aigoraUser.linuxUser;
    if (osUserInfoCache[linuxUser]) return osUserInfoCache[linuxUser];
    try {
      var info = resolveOsUserInfo(linuxUser);
      osUserInfoCache[linuxUser] = info;
      return info;
    } catch (e) {
      console.error("[project] Failed to resolve OS user info for " + linuxUser + ":", e.message);
      return null;
    }
  }

  // --- Per-project clients ---
  var clients = new Set();

  // --- Browser extension state (shared mutable object) ---
  var _extToken = crypto.randomUUID(); // Auth token for MCP server bridge
  var browserState = {
    _browserTabList: {},
    _extensionWs: null,
    pendingExtensionRequests: {}
  };

  function sendExtensionCommand(ws, command, args, timeout) {
    return new Promise(function(resolve) {
      var requestId = crypto.randomUUID();
      var ms = timeout || 3000;
      var timer = setTimeout(function() {
        delete browserState.pendingExtensionRequests[requestId];
        resolve(null);
      }, ms);
      browserState.pendingExtensionRequests[requestId] = { resolve: resolve, timer: timer };
      sendTo(ws, {
        type: "extension_command",
        command: command,
        args: args,
        requestId: requestId
      });
    });
  }

  // Send extension command via the tracked extension client (for MCP bridge)
  function sendExtensionCommandAny(command, args, timeout) {
    if (!browserState._extensionWs || browserState._extensionWs.readyState !== 1) {
      return Promise.reject(new Error("Browser extension not connected"));
    }
    return sendExtensionCommand(browserState._extensionWs, command, args, timeout);
  }

  function requestTabContext(tabId, actorUser) {
    if (!browserState._extensionWs || browserState._extensionWs.readyState !== 1) {
      return Promise.resolve(null);
    }
    // Re-authorized on every collection: only the account that owns the extension socket may read its tabs.
    if (!require("./browser-extension-owner").mayUseExtension(browserState._extensionWs, actorUser || null)) {
      return Promise.resolve(null);
    }
    var extWs = browserState._extensionWs;
    // Try inject first (best-effort), then request all data in parallel.
    // Even if inject fails (CSP etc.), page text and screenshot still work.
    return sendExtensionCommand(extWs, "tab_inject", { tabId: tabId }).then(function() {}, function() {}).then(function() {
      return Promise.all([
        sendExtensionCommand(extWs, "tab_console", { tabId: tabId }),
        sendExtensionCommand(extWs, "tab_network", { tabId: tabId }),
        sendExtensionCommand(extWs, "tab_page_text", { tabId: tabId }),
        sendExtensionCommand(extWs, "tab_screenshot", { tabId: tabId })
      ]);
    }).then(function(results) {
      return {
        console: results[0],
        network: results[1],
        pageText: results[2],
        screenshot: results[3]
      };
    }).catch(function() {
      return null;
    });
  }

  function send(obj) {
    var data = JSON.stringify(obj);
    for (var ws of clients) {
      if (ws.readyState === 1) ws.send(data);
    }
  }

  function sendTo(ws, obj) {
    if (ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch (_) {} }
  }

  function sendToAdmins(obj) {
    var data = JSON.stringify(obj);
    for (var ws of clients) {
      if (ws.readyState === 1 && ws._aigoraUser && ws._aigoraUser.role === "admin") ws.send(data);
    }
  }

  // Unique live user objects of this project (raw; shape per recipient before sending).
  function getOnlineUsers() {
    var seen = {};
    var list = [];
    for (var c of clients) {
      if (!c._aigoraUser) continue;
      var u = c._aigoraUser;
      if (seen[u.id]) continue;
      seen[u.id] = true;
      list.push(u);
    }
    return list;
  }

  // Built per recipient: only users sharing a room with them (admins: everyone) and only the
  // connections of those users are counted. Without a user (no-auth mode) nothing is filtered.
  function broadcastClientCount() {
    var online = getOnlineUsers();
    for (var rcpt of clients) {
      if (rcpt.readyState !== 1) continue;
      var scope = visibility.scopeFor(usersModule, rcpt._aigoraUser);
      var count = 0;
      for (var c of clients) {
        if (!c._aigoraUser || visibility.canSee(scope, c._aigoraUser.id)) count++;
      }
      sendTo(rcpt, { type: "client_count", count: count, users: visibility.visibleUsers(scope, online) });
    }
    onPresenceChange();
  }

  function sendToOthers(sender, obj) {
    var data = JSON.stringify(obj);
    for (var ws of clients) {
      if (ws !== sender && ws.readyState === 1) ws.send(data);
    }
  }

  function sendToSession(sessionId, obj) {
    // Stamp localId on status/done/auth_required so the client can
    // session-scope the edge write instead of applying it blind to
    // whichever session is currently focused — see sessions.js's
    // stampActivityLocalId doc comment for the full rationale/type list.
    stampActivityLocalId(sessionId, obj);
    var target = sm.sessions.get(sessionId);
    if (!target) return;
    for (var ws of clients) {
      if (revocation && target && !revocation.mayReceive(ws, target)) { revocation.checkSocket(ws); continue; }
      if (ws.readyState === 1 && ws._aigoraActiveSession === sessionId) {
        sendTo(ws, obj);
      }
    }
  }

  // obj may be a function (recipientWs) => message | null to build or withhold it per recipient
  // (e.g. identity cards that depend on who the recipient may see).
  function sendToSessionOthers(sender, sessionId, obj) {
    var perRecipient = typeof obj === "function" ? obj : null;
    if (!perRecipient) stampActivityLocalId(sessionId, obj);
    var target = sm.sessions.get(sessionId);
    if (!target) return;
    for (var ws of clients) {
      if (ws === sender) continue;
      if (revocation && target && !revocation.mayReceive(ws, target)) { revocation.checkSocket(ws); continue; }
      if (ws !== sender && ws.readyState === 1 && ws._aigoraActiveSession === sessionId) {
        var payload = perRecipient ? perRecipient(ws) : obj;
        if (!payload) continue;
        if (perRecipient) stampActivityLocalId(sessionId, payload);
        sendTo(ws, payload);
      }
    }
  }

  // --- Knowledge engine (delegated to project-knowledge.js) ---
  var _knowledge = attachKnowledge({
    cwd: cwd,
    sendTo: sendTo,
    getProjectOwnerId: function () { return projectOwnerId; },
  });

  // --- File/directory watcher engine (delegated to project-file-watch.js) ---
  var _fileWatch = attachFileWatch({
    cwd: cwd,
    send: send,
    safePath: safePath,
    BINARY_EXTS: BINARY_EXTS,
    FS_MAX_SIZE: FS_MAX_SIZE,
    IGNORED_DIRS: IGNORED_DIRS,
  });
  var startFileWatch = _fileWatch.startFileWatch;
  var stopFileWatch = _fileWatch.stopFileWatch;
  var startDirWatch = _fileWatch.startDirWatch;
  var stopDirWatch = _fileWatch.stopDirWatch;
  var stopAllDirWatches = _fileWatch.stopAllDirWatches;

  // --- Session manager ---
  var channelStore = require("./personal-channels").createPersonalChannelStore({ dir: require("./config").CONFIG_DIR, canAccessRoom: usersModule.canAccessRoom });
  var sm = createSessionManager({
    cwd: cwd,
    send: send,
    sendTo: sendTo,
    onSessionDeleted: onSessionDeleted,
    getPersonalChannel: channelStore.getChannelSync,
    canReadSession: function (ws, s) { return !!revocation && revocation.mayRead(ws, s); },
    onSessionAccessChanged: function (s) { if (revocation && revocation.isPrivate(s)) revocation.recheck(); },
    sendEach: function (fn, purpose) {
      for (var ws of clients) {
        var user = ws._aigoraUser;
        var filterFn = null;
        if (user) filterFn = sendEachFilter(revocation, privateAccess, usersModule, user, ws, purpose);
        try { fn(ws, filterFn); } catch (_) {}
      }
    },
    onSessionDone: onSessionDone,
    historyInMemMax: historyInMemMax,
  });
  sm.availableVendors = Object.keys(adapters);
  sm.defaultVendor = defaultVendor;

  var _projMode = typeof opts.onGetProjectDefaultMode === "function" ? opts.onGetProjectDefaultMode(slug) : null;
  var _srvMode = typeof opts.onGetServerDefaultMode === "function" ? opts.onGetServerDefaultMode() : null;
  sm._savedDefaultMode = (_projMode && _projMode.mode) || (_srvMode && _srvMode.mode) || "default";
  // Immediately apply the saved default so config_state on connect reflects it
  // before the SDK has warmed up and fired system/init.
  if (sm._savedDefaultMode) sm.currentPermissionMode = sm._savedDefaultMode;

  var _projEffort = typeof opts.onGetProjectDefaultEffort === "function" ? opts.onGetProjectDefaultEffort(slug) : null;
  var _srvEffort = typeof opts.onGetServerDefaultEffort === "function" ? opts.onGetServerDefaultEffort() : null;
  sm.currentEffort = require("./model-policy").normalizeEffortAny((_projEffort && _projEffort.effort) || (_srvEffort && _srvEffort.effort) || "medium");

  var _projModel = typeof opts.onGetProjectDefaultModel === "function" ? opts.onGetProjectDefaultModel(slug) : null;
  var _srvModel = typeof opts.onGetServerDefaultModel === "function" ? opts.onGetServerDefaultModel() : null;
  sm._savedDefaultModel = (_projModel && _projModel.model) || (_srvModel && _srvModel.model) || null;
  // Immediately apply the saved default so config_state on connect reflects it
  // before the SDK has warmed up and fired system/init.
  if (sm._savedDefaultModel) sm.currentModel = sm._savedDefaultModel;

  var _projBetas = typeof opts.onGetProjectDefaultBetas === "function" ? opts.onGetProjectDefaultBetas(slug) : null;
  var _srvBetas = typeof opts.onGetServerDefaultBetas === "function" ? opts.onGetServerDefaultBetas() : null;
  sm.currentBetas = (_projBetas && _projBetas.betas) || (_srvBetas && _srvBetas.betas) || [];

  // --- Local MCP (direct process management for localhost clients) ---
  var _localMcp = createLocalMcp();

  // --- MCP bridge (remote MCP servers via Chrome Extension) ---
  var _mcp = attachMcp({
    send: send,
    sendTo: sendTo,
    slug: slug,
    getExtensionWs: function () { return browserState._extensionWs; },
    getExtensionId: function () { return browserState._extensionId || null; },
    getEnabledMcpServers: function () {
      return typeof opts.onGetProjectMcpServers === "function"
        ? opts.onGetProjectMcpServers(slug) : [];
    },
    setEnabledMcpServers: function (servers) {
      if (typeof opts.onSetProjectMcpServers === "function") {
        opts.onSetProjectMcpServers(slug, servers);
      }
    },
    localMcp: _localMcp,
  });

  // --- MCP tool servers (created via YOKE adapter) ---
  var mcpServers = (function () {
    var servers = {};

    // Browser MCP server
    {
      try {
        var browserMcp = require("./browser-mcp-server");
        var browserToolDefs = browserMcp.getToolDefs(sendExtensionCommandAny, function () {
          return Object.values(browserState._browserTabList || {});
        }, {
          watchTab: function (tabId) {
            var key = "tab:" + tabId;
            // Apply to all connected clients' active sessions
            for (var c of clients) {
              if (c.readyState !== 1) continue;
              var sid = c._aigoraActiveSession || null;
              var active = loadContextSources(slug, sid);
              if (active.indexOf(key) === -1) {
                active.push(key);
                saveContextSources(slug, sid, active);
                c.send(JSON.stringify({ type: "context_sources_state", active: active }));
              }
            }
            return [];
          },
          unwatchTab: function (tabId) {
            var key = "tab:" + tabId;
            for (var c of clients) {
              if (c.readyState !== 1) continue;
              var sid = c._aigoraActiveSession || null;
              var active = loadContextSources(slug, sid);
              var idx = active.indexOf(key);
              if (idx !== -1) {
                active.splice(idx, 1);
                saveContextSources(slug, sid, active);
                c.send(JSON.stringify({ type: "context_sources_state", active: active }));
              }
            }
            // Mirrors watchTab's return value above: this call fans out across
            // every connected client's own per-session context sources, so
            // there is no single "the" active list to report back. The prior
            // code returned the loop-scoped `active` var, which is undefined
            // whenever there are zero connected clients and otherwise just the
            // last-iterated client's list -- neither is meaningful to the
            // caller (lr-1bdb item E). Return a deterministic constant instead.
            return [];
          },
        });
        // The SDK loads asynchronously; register the server once the adapter is
        // ready. `servers` is read lazily (getLocalMcpServers), so a late add is seen.
        var ready = adapter && typeof adapter.whenReady === "function" ? adapter.whenReady() : Promise.resolve(true);
        ready.then(function () {
          var mcpConfig = adapter.createToolServer({ name: "aigora-browser", version: "1.0.0", tools: browserToolDefs });
          if (mcpConfig) servers[mcpConfig.name || "aigora-browser"] = mcpConfig;
        }).catch(function (e) {
          console.error("[project] Failed to create browser MCP server:", e.message);
        });
      } catch (e) {
        console.error("[project] Failed to create browser MCP server:", e.message);
      }
    }

    return servers;
  })();

  // Gate in-app MCP servers on the underlying capability actually being
  // available. Without this, tools show up in every session's tool list
  // even when the user can't use them, which wastes context and can cause
  // the model to pick the wrong MCP when the user has another one
  // configured (see issue #325).
  //
  //   aigora-browser -> only when the Chrome extension is connected
  function getLocalMcpServers() {
    if (!mcpServers) return undefined;
    var extWs = browserState._extensionWs;
    var extConnected = !!(extWs && extWs.readyState === 1);
    var keys = Object.keys(mcpServers);
    var filtered = {};
    var hasAny = false;
    for (var i = 0; i < keys.length; i++) {
      var name = keys[i];
      if (name === "aigora-browser" && !extConnected) continue;
      filtered[name] = mcpServers[name];
      hasAny = true;
    }
    return hasAny ? filtered : undefined;
  }

  // --- Team activity watcher (delegated to project-team.js) ---
  var _team = attachTeam({ send: send, config: require("./config"), sm: sm });

  // --- SDK bridge ---
  var sdk = createSDKBridge({
    cwd: cwd,
    slug: slug,
    sessionManager: sm,
    send: send,
    pushModule: pushModule,
    adapter: adapter,
    adapters: adapters,
    getNotificationsModule: function () { return _notifications; },
    dangerouslySkipPermissions: dangerouslySkipPermissions,
    mcpServers: getLocalMcpServers,
    getRemoteMcpServers: function () { return _mcp.getMcpServers(); },
    aigoraPort: serverPort,
    aigoraTls: serverTls,
    aigoraAuthToken: serverAuthToken,
    onProcessingChanged: onProcessingChanged,
    onTurnDone: null,
    onTeamCreate: function (teamId, cliSessionId, cwd) { _team.onTeamCreate(teamId, cliSessionId, cwd); },
    onTeamDelete: function () { _team.onTeamDelete(); },
    scheduleMessage: function (session, text, resetsAt) {
      scheduleMessage(session, text, resetsAt);
    },
    getAutoContinueSetting: function (session) {
      if (session && session.ownerId) {
        return usersModule.getAutoContinue(session.ownerId);
      }
      return false;
    },
    // lr-2d91: Live config callback so sdk-bridge reads the current threshold on
    // every query — not a stale value cached at bridge creation time.
    getConfig: function () {
      if (typeof opts.onGetDaemonConfig === "function") {
        return opts.onGetDaemonConfig();
      }
      return {};
    },
  });

  // --- Loop engine (delegated to project-loop.js) ---
  // --- Notification center (global singleton from server.js) ---
  var _notifications = opts.notificationsModule || null;

  var _loop = attachLoop({
    clients: clients,
    cwd: cwd,
    osUsers: osUsers,
    slug: slug,
    sm: sm,
    sdk: sdk,
    send: send,
    sendTo: sendTo,
    sendToSession: sendToSession,
    pushModule: pushModule,
    notificationsModule: _notifications,
    getHubSchedules: getHubSchedules,
    getAllProjectSessions: getAllProjectSessions,
    getSessionUnread: getSessionUnread,
    getStatus: getStatus,
    getLinuxUserForSession: getLinuxUserForSession,
    onProcessingChanged: onProcessingChanged,
    hydrateImageRefs: hydrateImageRefs,
  });
  function getReadableHubSchedules(ws) {
    return _loop.filterRegistryRecords(ws, getHubSchedules());
  }
  var loopState = _loop.loopState;
  var loopRegistry = _loop.loopRegistry;
  var loopDir = _loop.loopDir;
  var startLoop = _loop.startLoop;
  var stopLoop = _loop.stopLoop;
  var resumeLoop = _loop.resumeLoop;

  // --- Terminal manager ---
  // broadcastTermList sends each connected client only the terminals they own.
  var tm;
  function broadcastTermListToAll() {
    for (var bws of clients) {
      if (bws.readyState === 1) {
        sendTo(bws, { type: "term_list", terminals: tm.list(bws) });
      }
    }
  }
  tm = createTerminalManager({
    cwd: cwd,
    send: send,
    sendTo: sendTo,
    isMultiUser: true,
    broadcastTermList: broadcastTermListToAll,
  });
  var nm = createNotesManager({ cwd: cwd, send: send, sendTo: sendTo });

  // Update checks disabled — this is a fork; updates are managed via aigora-console releases.
  function runVersionCheck() { /* no-op */ }
  function scheduleNextHourlyBroadcast() { /* no-op */ }

  // --- WS connection handler (delegated to project-connection.js) ---
  function handleConnection(ws, wsUser) {
    _connection.handleConnection(ws, wsUser, handleMessage, handleDisconnection);

    // Initialize local MCP when a localhost client connects
    if (ws._aigoraLocal && _localMcp && !_localMcp.isReady()) {
      _localMcp.initialize(function () {
        // Rebuild proxy servers and broadcast state when local servers are ready
        _mcp.rebuildAndBroadcast();
      });
    }
  }

  // --- WS message handler ---
  function getSessionForWs(ws) {
    var session = sm.sessions.get(ws._aigoraActiveSession) || null;
    if (session && revocation && !revocation.mayRead(ws, session)) {
      revocation.checkSocket(ws); return null;
    }
    if (session && ws._aigoraUser &&
        !usersModule.canAccessSession(ws._aigoraUser.id, session, { visibility: "public" })) {
      return null;
    }
    return session;
  }

  // --- Schedule / cancel a message (used by WS handler and auto-continue) ---
  function scheduleMessage(session, text, resetsAt, actorWs) {
    if (revocation && revocation.isPrivate(session) && !sdk.canQueuePrivateMessage(session, actorWs)) return;
    if (!session || !text || !resetsAt) return;
    // Cancel any existing scheduled message
    if (session.scheduledMessage && session.scheduledMessage.timer) {
      clearTimeout(session.scheduledMessage.timer);
    }
    var isPastReset = resetsAt <= Date.now();
    var schedDelay = isPastReset ? 5000 : Math.max(0, resetsAt - Date.now()) + 60000; // +1min buffer after reset, or 5s for immediate
    var sendsAt = Date.now() + schedDelay;
    var schedEntry = {
      type: "scheduled_message_queued",
      text: text,
      resetsAt: sendsAt,
      scheduledAt: Date.now(),
      localId: session.localId,
    };
    sm.sendAndRecord(session, schedEntry);
    session.scheduledMessage = {
      ws: actorWs,
      text: text,
      resetsAt: resetsAt,
      timer: setTimeout(function () {
        session.scheduledMessage = null;
        if (session.destroying) return;
        console.log("[project] Scheduled message firing for session " + session.localId);
        sm.sendAndRecord(session, { type: "scheduled_message_sent", localId: session.localId });
        var schedUserMsg = { type: "user_message", text: text, _ts: Date.now() };
        // lr-2ea2a7: routes through the shared history-cap helper (see grep-guard test).
        sm.recordHistoryEntry(session, schedUserMsg, true);
        sm.appendToSessionFile(session, schedUserMsg);
        sendToSession(session.localId, schedUserMsg);
        session.isProcessing = true;
        onProcessingChanged();
        sendToSession(session.localId, { type: "status", status: "processing" });
        sdk.startQuery(session, text, null, ensureProjectAccessForSession(session), actorWs);
        sm.broadcastSessionList();
      }, schedDelay),
    };
  }

  function cancelScheduledMessage(session) {
    if (!session) return;
    if (session.scheduledMessage && session.scheduledMessage.timer) {
      clearTimeout(session.scheduledMessage.timer);
      session.scheduledMessage = null;
      session.rateLimitAutoContinuePending = false;
      sm.sendAndRecord(session, { type: "scheduled_message_cancelled", localId: session.localId });
    }
  }

  var privMsg = require("./private-message-classes");
  function mayMutatePrivate(ws, session) {
    if (!isChannelBound(session)) return true;
    try { createPrivateSessionAccess(usersModule).assertSessionAction(ws._aigoraUser, session, { visibility: "public" }, "mutate"); return true; } catch (e) { return false; }
  }

  function handleMessage(ws, msg) {
    // --- Cross-project routing (e.g. permission_response from notification banner) ---
    if (msg.targetSlug && msg.targetSlug !== slug && opts.getProject) {
      var routeUser = ws && ws._aigoraUser;
      if (!routeUser || !canAccessProjectSlug(routeUser.id, msg.targetSlug)) {
        sendTo(ws, { type: "error", text: "Project access denied" });
        return;
      }
      var targetCtx = opts.getProject(msg.targetSlug);
      if (targetCtx) {
        targetCtx.handleMessage(ws, msg);
        return;
      }
    }

    var requested = msg.type === "switch_session" ? sm.sessions.get(msg.id) : null;
    if (requested && revocation.isPrivate(requested) && !revocation.mayRead(ws, requested)) {
      sendTo(ws, { type: "error", error: "Room access revoked" }); return;
    }

    // Re-check room membership on every message. This closes the live-socket
    // gap where an owner removes a member after the socket was authenticated:
    // a stale client must not keep using its previously active room session.
    var boundSession = sm.sessions.get(ws._aigoraActiveSession) || null;
    if (boundSession && ws._aigoraUser &&
        !usersModule.canAccessSession(ws._aigoraUser.id, boundSession, { visibility: "public" }) &&
        !(isChannelBound(boundSession) && revocation.mayRead(ws, boundSession))) { // the room administrator may read
      ws._aigoraActiveSession = null;
      sendTo(ws, { type: "rooms_state", rooms: usersModule.getRoomsForUser(ws._aigoraUser.id) });
      sendTo(ws, { type: "error", error: "Room access revoked" });
      if (msg.type !== "new_session") return;
    }

    // One owner-only gate before every session mutator (the administrator may only read).
    if (privMsg.targetsOf(msg, boundSession, sm.sessions).some(function (t) { return !mayMutatePrivate(ws, t); })) {
      sendTo(ws, { type: "error", text: privMsg.DENIED_TEXT }); return;
    }

    // --- Team activity messages (delegated to project-team.js) ---
    if (_team.handleClientMsg(ws, msg)) return;

    // --- DM messages (delegated to server-level handler) ---
    if (msg.type === "dm_open" || msg.type === "dm_send" || msg.type === "dm_list" || msg.type === "dm_typing" || msg.type === "dm_add_favorite" || msg.type === "dm_remove_favorite") {
      if (typeof opts.onDmMessage === "function") {
        opts.onDmMessage(ws, msg);
      }
      return;
    }

    // --- Aigora room comments, pins and their notifications ---
    if (boundSession && revocation.isPrivate(boundSession) &&
        ["social_get", "comment_add", "comment_edit", "comment_delete", "pin_add", "pin_remove", "notif_read", "notif_prefs"].indexOf(msg.type) !== -1 && !getSessionForWs(ws)) return;
    if (_social.handleSocialMessage(ws, msg)) return;
    if (_posts.handleMessage(ws, msg)) return;
    if (_skills.handleMessage(ws, msg)) return;
    if (_coaching.handleMessage(ws, msg)) return;

    // --- @Mention: user-to-user side conversation in this session ---
    if (msg.type === "user_mention") {
      handleUserMention(ws, msg);
      return;
    }

    // --- Vendor model switching ---
    if (msg.type === "get_vendor_models") {
      (async function() {
        if (msg.vendor) {
          try {
            var vendorAdapter = adapters[msg.vendor] || null;
            if (!vendorAdapter) {
              vendorAdapter = await yoke.lazyCreateAdapter(adapters, msg.vendor, {
                cwd: cwd,
                aigoraPort: serverPort,
                aigoraTls: serverTls,
                aigoraAuthToken: serverAuthToken,
                slug: slug,
              });
            } else if ((!sm.modelsByVendor || !sm.modelsByVendor[msg.vendor]) && typeof vendorAdapter.init === "function") {
              await vendorAdapter.init({
                cwd: cwd,
                aigoraPort: serverPort,
                aigoraTls: serverTls,
                aigoraAuthToken: serverAuthToken,
                slug: slug,
              });
            }
            if (vendorAdapter) {
              sm.availableVendors = Object.keys(adapters);
              sm.modelsByVendor = sm.modelsByVendor || {};
              if (!sm.modelsByVendor[msg.vendor] && typeof vendorAdapter.supportedModels === "function") {
                sm.modelsByVendor[msg.vendor] = await vendorAdapter.supportedModels();
              }
            }
          } catch (e) {
            console.error("[project] get_vendor_models lazy init failed for " + msg.vendor + ":", e.message || e);
          }
        }
        var vendorModels = (sm.modelsByVendor && sm.modelsByVendor[msg.vendor]) || [];
        var firstModel = vendorModels[0] || "";
        // model value can be string or {value, displayName} object
        var defaultModel = typeof firstModel === "string" ? firstModel : (firstModel.value || "");
        // Preserve the user's current model selection if it belongs to this
        // vendor, rather than always snapping back to the vendor's default.
        var modelToSend = defaultModel;
        if (sm.currentModel) {
          for (var mi = 0; mi < vendorModels.length; mi++) {
            var mv = typeof vendorModels[mi] === "string" ? vendorModels[mi] : (vendorModels[mi].value || "");
            if (mv === sm.currentModel) {
              modelToSend = sm.currentModel;
              break;
            }
          }
        }
        sendTo(ws, { type: "model_info", model: modelToSend, models: vendorModels, vendor: msg.vendor, availableVendors: sm.availableVendors || [], installedVendors: sm.installedVendors || [] });
      })();
      return;
    }

    // --- Debate ---
    // --- MCP bridge (remote MCP servers via extension) ---
    if (_mcp.handleMcpMessage(ws, msg)) return;

    // --- Knowledge file management (delegated to project-knowledge.js) ---
    if (_knowledge.handleKnowledgeMessage(ws, msg)) return;

    // --- Notifications (delegated to project-notifications.js) ---
    if (_notifications.handleNotificationMessage(ws, msg)) return;

    // --- Sessions, config, project mgmt (delegated to project-sessions.js) ---
    if (_sessions.handleSessionsMessage(ws, msg)) return;

    // --- Filesystem, settings, env (delegated to project-filesystem.js) ---
    if (_filesystem.handleFilesystemMessage(ws, msg)) return;

    // --- Notes, terminals, context, user message (delegated to project-user-message.js) ---
    if (_userMessage.handleUserMessage(ws, msg)) return;
  }

  // --- Shared helpers ---

  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // --- User-to-user mention engine (delegated to project-user-mention.js) ---
  var _userMention = attachUserMention({
    slug: slug,
    sm: sm,
    send: send,
    sendTo: sendTo,
    sendToSession: sendToSession,
    sendToSessionOthers: sendToSessionOthers,
    getSessionForWs: getSessionForWs,
    getLinuxUserForSession: getLinuxUserForSession,
    saveImageFile: saveImageFile,
    hydrateImageRefs: hydrateImageRefs,
    usersModule: usersModule,
    pushModule: pushModule,
    isUserOnline: opts.isUserOnline || function () { return false; },
    getNotificationsModule: function () { return _notifications; },
    getProjectTitle: function () { return title || slug; },
  });
  var handleUserMention = _userMention.handleUserMention;

  // --- Room comments / pins (delegated to project-social.js) ---
  var _social = attachSocial({
    isAiAlias: function (name) { return _orchestrator ? _orchestrator.isAiAlias(name) : require("./orchestration/router").detectMentions("@" + name).length > 0; },
    // _attachments is assigned further down; resolve it when a comment arrives.
    attachments: { commentable: function (user, session, mid) { return _attachments.commentable(user, session, mid); } },
    slug: slug,
    sm: sm,
    clients: clients,
    usersModule: usersModule,
    sendTo: sendTo,
    pushModule: pushModule,
    isUserOnline: opts.isUserOnline || function () { return false; },
  });

  // --- Session presence (who is viewing which session) ---
  // Built per recipient: a session appears only if it exists now and, when it
  // is channel-bound, both the recipient and the viewer may currently read it
  // (owner or server room administrator). Explicit null or non-string/blank channelId
  // is malformed and denied; an absent channelId is legacy and keeps its old visibility.
  var privateAccess = createPrivateSessionAccess(usersModule);
  var revocation = require("./project-private-revocation").attachPrivateRevocation({
    users: usersModule, sm: sm, clients: clients, presence: userPresence, slug: slug,
    sendTo: sendTo, broadcastPresence: broadcastPresence,
    onDetach: function (ws, s, id) { sendToSessionOthers(ws, s.localId, function (r) { return visibility.canSee(visibility.scopeFor(usersModule, r._aigoraUser), id) ? { type: "cursor_leave", userId: id } : null; }); },
  });
  function mayReadPresenceSession(user, session) {
    if (!session || typeof session !== "object") return false;
    if (!Object.prototype.hasOwnProperty.call(session, "channelId") || session.channelId === undefined) return true;
    if (typeof session.channelId !== "string" || !session.channelId.trim()) return false;
    return !!user && privateAccess.canReadSession(user, session, { visibility: "public" });
  }

  function broadcastPresence() {
    var viewers = [];
    for (var c of clients) {
      if (!c._aigoraUser || !c._aigoraActiveSession) continue;
      var vs = sm.sessions.get(c._aigoraActiveSession);
      if (!vs) continue; // unknown/stale session id: never broadcast
      if (revocation && !revocation.mayRead(c, vs)) continue;
      viewers.push({ user: c._aigoraUser, sid: c._aigoraActiveSession, session: vs });
    }
    for (var rcpt of clients) {
      if (rcpt.readyState !== 1) continue;
      var rcptScope = visibility.scopeFor(usersModule, rcpt._aigoraUser);
      var presence = {};
      for (var vi = 0; vi < viewers.length; vi++) {
        var v = viewers[vi];
        if (revocation && !revocation.mayRead(rcpt, v.session)) continue;
        if (!mayReadPresenceSession(rcpt._aigoraUser, v.session)) continue;
        if (!mayReadPresenceSession(v.user, v.session)) continue;
        var sid = v.sid;
        var u = v.user;
        if (!visibility.canSee(rcptScope, u.id)) continue;
        if (!presence[sid]) presence[sid] = [];
        // Deduplicate: skip if this user is already listed for this session
        var dominated = false;
        for (var di = 0; di < presence[sid].length; di++) {
          if (presence[sid][di].id === u.id) { dominated = true; break; }
        }
        if (dominated) continue;
        presence[sid].push(visibility.shapeUser(rcptScope, u));
      }
      sendTo(rcpt, { type: "session_presence", presence: presence });
    }
  }

  // --- WS disconnection handler (delegated to project-connection.js) ---
  function handleDisconnection(ws) {
    // Clean up extension WS reference if this was the extension client
    if (browserState._extensionWs === ws) {
      browserState._extensionWs = null;
      browserState._extensionId = null;
      if (_mcp) _mcp.handleExtensionDisconnect();
    }
    _connection.handleDisconnection(ws);
  }

  // --- Sessions/config/project handler (delegated to project-sessions.js) ---
  var _sessions = attachSessions({
    getOrchestrator: function () { return _orchestrator; },
    cwd: cwd,
    slug: slug,
    osUsers: osUsers,
    debug: debug,
    dangerouslySkipPermissions: dangerouslySkipPermissions,
    currentVersion: currentVersion,
    sm: sm,
    sdk: sdk,
    tm: tm,
    clients: clients,
    send: send,
    sendTo: sendTo,
    sendToAdmins: sendToAdmins,
    sendToSession: sendToSession,
    sendToSessionOthers: sendToSessionOthers,
    opts: opts,
    usersModule: usersModule,
    channelStore: channelStore,
    userPresence: userPresence,
    pushModule: pushModule,
    getSessionForWs: getSessionForWs,
    getLinuxUserForSession: getLinuxUserForSession,
    ensureProjectAccessForSession: ensureProjectAccessForSession,
    getOsUserInfoForWs: getOsUserInfoForWs,
    hydrateImageRefs: hydrateImageRefs,
    onProcessingChanged: onProcessingChanged,
    broadcastPresence: broadcastPresence,
    adapter: adapter,
    getProjectList: getProjectList,
    getProjectCount: getProjectCount,
    getScheduleCount: getScheduleCount,
    moveScheduleToProject: moveScheduleToProject,
    moveAllSchedulesToProject: moveAllSchedulesToProject,
    getHubSchedules: getReadableHubSchedules,
    fetchVersion: fetchVersion,
    isNewer: isNewer,
    scheduleMessage: scheduleMessage,
    cancelScheduledMessage: cancelScheduledMessage,
    getProjectOwnerId: function () { return projectOwnerId; },
    setProjectOwnerId: function (id) { projectOwnerId = id; },
    getUpdateChannel: function () { return updateChannel; },
    setUpdateChannel: function (ch) {
      updateChannel = ch;
      if (onSetUpdateChannel) onSetUpdateChannel(ch);
    },
    getLatestVersion: function () { return latestVersion; },
    setLatestVersion: function (v) { latestVersion = v; },
    onCreateWorktree: onCreateWorktree,
    IGNORED_DIRS: IGNORED_DIRS,
    loadContextSources: loadContextSources,
    saveContextSources: saveContextSources,
  });

  // --- Aigora orchestration (lib/orchestration) ---
  // Room messages that need research, a browser, or an independent check are
  // run as a sequence of hidden single-turn steps and projected back into the
  // same room conversation. AIGORA_ORCHESTRATION=off disables it.
  var _orchestrator = null;
  if (require("./orchestration/engine").flagEnabled(process.env)) {
    try {
      var _orchConfigDir = require("./config").CONFIG_DIR;
      var _orchKey = String(slug).replace(/[^A-Za-z0-9_.-]/g, "_") + "-" +
        require("crypto").createHash("sha256").update(String(slug)).digest("hex").slice(0, 8);
      _orchestrator = require("./orchestration/engine").createOrchestrator({
        slug: slug,
        sm: sm,
        sdk: sdk,
        usersModule: usersModule,
        defaultVendor: adapter && adapter.vendor,
        // Which agents can take a step right now; the router avoids the others.
        availability: function () {
          var usageLib = require("./ai-usage");
          usageLib.readSharedUsage(false).catch(function () {}); // keep the cache fresh for the next message
          var usage = usageLib.peekSharedUsage();
          return require("./orchestration/availability").buildAvailability({
            usage: usage,
            localReady: require("./providers/local/state").getLocalState().isReady(),
          });
        },
        // An explicit @local step re-probes the server first (the cached probe may predate "ollama serve").
        checkLocal: function () { return require("./providers/local/state").getLocalState().refresh(true).then(function (s) { return !!(s && s.ready); }); },
        stateFile: path.join(_orchConfigDir, "orchestration", _orchKey + ".json"),
        scratchDir: path.join(_orchConfigDir, "orchestration", "worker-work", _orchKey),
        getProjectAccess: function () { return getProjectAccess(slug) || { visibility: "public" }; },
        linuxUserFor: ensureProjectAccessForSession,
        log: function (line) { console.error(line); },
      });
      _orchestrator.boot();
    } catch (e) {
      console.error("[project] Aigora orchestration unavailable:", e && e.message);
      _orchestrator = null;
    }
  }

  // Prompt coaching ("더 나은 지시"): per-user, separate from session history.
  var _coaching = require("./project-prompt-coaching").attachPromptCoaching({ slug: slug, sm: sm, clients: clients, usersModule: usersModule, sendTo: sendTo, adapter: adapters.claude || adapter, channels: { getChannelSync: channelStore.getChannelSync } });

  // --- User message handler (delegated to project-user-message.js) ---
  var _userMessage = attachUserMessage({
    social: _social,
    coaching: _coaching,
    getAttachments: function () { return _attachments; },
    cwd: cwd,
    slug: slug,
    osUsers: osUsers,
    sm: sm,
    sdk: sdk,
    nm: nm,
    tm: tm,
    clients: clients,
    send: send,
    sendTo: sendTo,
    sendToSession: sendToSession,
    sendToSessionOthers: sendToSessionOthers,
    opts: opts,
    usersModule: usersModule,
    getSessionForWs: getSessionForWs,
    getLinuxUserForSession: getLinuxUserForSession,
    ensureProjectAccessForSession: ensureProjectAccessForSession,
    getOsUserInfoForWs: getOsUserInfoForWs,
    hydrateImageRefs: hydrateImageRefs,
    saveImageFile: saveImageFile,
    imagesDir: imagesDir,
    onProcessingChanged: onProcessingChanged,
    _loop: _loop,
    browserState: browserState,
    sendExtensionCommandAny: sendExtensionCommandAny,
    requestTabContext: requestTabContext,
    scheduleMessage: scheduleMessage,
    cancelScheduledMessage: cancelScheduledMessage,
    loadContextSources: loadContextSources,
    saveContextSources: saveContextSources,
    escapeRegex: escapeRegex,
    adapter: adapter,
    getHubSchedules: getHubSchedules,
    getProjectOwnerId: function () { return projectOwnerId; },
    orchestrator: _orchestrator,
  });

  // --- Filesystem handler (delegated to project-filesystem.js) ---
  var _filesystem = attachFilesystem({
    cwd: cwd,
    slug: slug,
    osUsers: osUsers,
    sm: sm,
    send: send,
    sendTo: sendTo,
    safePath: safePath,
    safeAbsPath: safeAbsPath,
    safeClaudePath: safeClaudePath,
    getOsUserInfoForWs: getOsUserInfoForWs,
    startFileWatch: startFileWatch,
    stopFileWatch: stopFileWatch,
    startDirWatch: startDirWatch,
    usersModule: usersModule,
    fsAsUser: fsAsUser,
    validateEnvString: validateEnvString,
    opts: opts,
    IGNORED_DIRS: IGNORED_DIRS,
    BINARY_EXTS: BINARY_EXTS,
    IMAGE_EXTS: IMAGE_EXTS,
    FS_MAX_SIZE: FS_MAX_SIZE,
  });

  // --- MCP bridge handler for Codex (Track 2) ---
  // Provides list_tools and call_tool operations over HTTP for mcp-bridge-server.js.
  // Excludes local MCP servers since Codex manages those natively via Track 1.
  // The bridge child serves host-path Codex turns only. Its shared app-server cannot name the calling session, so the
  // capability is honored only while an admin-owned (or single-user) non-room, non-channel session is mid-turn.
  function authorizeMcpBridge() {
    var ok = false;
    sm.sessions.forEach(function (s) {
      if (ok || !s || !s.isProcessing) return;
      if (require("./private-session-access").isChannelBound(s) || require("./room-execution").isRoomContext(s)) return;
      if (!s.ownerId) { ok = true; return; }
      var u = null;
      try { u = usersModule.findUserById(s.ownerId); } catch (_) {}  // iron-laws: ignore[IL-301] fail-closed admin check; a lookup failure leaves u null and grants nothing
      if (u && u.role === "admin") ok = true;
    });
    return ok;
  }
  function getMcpBridgeHandler() {
    // Build set of local MCP server names to exclude (Codex handles these natively)
    var localMcpNames = {};
    try {
      var mcpLocalModule = require("./mcp-local");
      var localConfig = mcpLocalModule.readMergedServers();
      var lcNames = Object.keys(localConfig);
      for (var li = 0; li < lcNames.length; li++) {
        localMcpNames[lcNames[li]] = true;
      }
    } catch (e) { /* no local MCP config */ }

    return {
      listTools: function () {
        var tools = [];
        var toJSONSchema;
        try { toJSONSchema = require("zod").toJSONSchema; } catch (e) { /* fallback */ }

        // Helper to extract tools from an SDK MCP server object
        function extractServerTools(serverName, server) {
          if (!server || !server.instance || !server.instance._registeredTools) return;
          var toolNames = Object.keys(server.instance._registeredTools);
          for (var j = 0; j < toolNames.length; j++) {
            var toolDef = server.instance._registeredTools[toolNames[j]];
            var inputSchema = { type: "object", properties: {} };
            try {
              if (toJSONSchema && toolDef.inputSchema) inputSchema = toJSONSchema(toolDef.inputSchema);
            } catch (e) { /* fallback */ }
            tools.push({
              server: serverName,
              name: toolNames[j],
              description: toolDef.description || toolNames[j],
              inputSchema: inputSchema,
            });
          }
        }

        // In-app MCP servers (browser tools).
        // Use getLocalMcpServers() so aigora-browser is hidden unless the
        // Chrome extension is currently connected (see issue #325).
        var localMcp = getLocalMcpServers();
        if (localMcp) {
          var inAppNames = Object.keys(localMcp);
          for (var i = 0; i < inAppNames.length; i++) {
            extractServerTools(inAppNames[i], localMcp[inAppNames[i]]);
          }
        }

        // Remote MCP servers (extension-proxied only, skip local proxy servers)
        var remoteServers = _mcp.getMcpServers();
        if (remoteServers) {
          var remoteNames = Object.keys(remoteServers);
          for (var ri = 0; ri < remoteNames.length; ri++) {
            // Skip servers that Codex manages natively via Track 1
            if (localMcpNames[remoteNames[ri]]) continue;
            extractServerTools(remoteNames[ri], remoteServers[remoteNames[ri]]);
          }
        }

        return Promise.resolve(tools);
      },
      callTool: function (serverName, toolName, args) {
        // Saved clay-* names alias to the internal servers only; an externally registered server
        // (remote proxy or mcp.json) keeps its own name, and a name held by both an internal and
        // an external server is refused outright.
        var _utils = require("./utils");
        var externalNames = Object.assign({}, localMcpNames, _mcp.getMcpServers() || {});
        serverName = _utils.normalizeMcpServerName(serverName, externalNames);
        if (_utils.isInternalMcpServerName(serverName) && Object.prototype.hasOwnProperty.call(externalNames, serverName)) {
          return Promise.reject(new Error("MCP server name collision: " + serverName + " is registered both internally and externally"));
        }
        // Try in-app servers first (gated by extension connectivity for aigora-browser).
        var localMcp = getLocalMcpServers();
        if (localMcp && localMcp[serverName]) {
          var server = localMcp[serverName];
          if (server.instance && server.instance._registeredTools && server.instance._registeredTools[toolName]) {
            var handler = server.instance._registeredTools[toolName].handler;
            if (typeof handler === "function") {
              return Promise.resolve(handler(args));
            }
          }
        }
        // Try remote/local proxy servers
        var remoteServers = _mcp.getMcpServers();
        if (remoteServers && remoteServers[serverName]) {
          var rServer = remoteServers[serverName];
          if (rServer.instance && rServer.instance._registeredTools && rServer.instance._registeredTools[toolName]) {
            var rHandler = rServer.instance._registeredTools[toolName].handler;
            if (typeof rHandler === "function") {
              return Promise.resolve(rHandler(args));
            }
          }
        }
        return Promise.reject(new Error("Tool not found: " + serverName + "/" + toolName));
      },
    };
  }

  var _skills = require("./project-skills").attachSkills({ sm: sm, clients: clients, usersModule: usersModule, sendTo: sendTo });
  var _posts = require("./project-shared-posts").attachSharedPosts({ sm: sm, clients: clients, usersModule: usersModule, sendTo: sendTo, imagesDir: imagesDir });
  var _attachments = require("./project-attachments").attachAttachments({ sm: sm, usersModule: usersModule, getChannel: channelStore.getChannelSync, onRemoved: function () { if (_office) _office.sweep(); } });
  var _office = require("./project-office").attachOffice({ slug: slug, usersModule: usersModule, attachments: _attachments });

  // --- HTTP handler (delegated to project-http.js) ---
  var _http = attachHTTP({
    sharedPosts: _posts,
    attachments: _attachments,
    office: _office,
    cwd: cwd,
    slug: slug,
    project: title || project,
    getProjectAccess: function () { return getProjectAccess(slug); },
    sm: sm,
    send: send,
    imagesDir: imagesDir,
    osUsers: osUsers,
    pushModule: pushModule,
    safePath: safePath,
    safeAbsPath: safeAbsPath,
    getOsUserInfoForReq: getOsUserInfoForReq,
    sendExtensionCommandAny: sendExtensionCommandAny,
    _extToken: _extToken,
    _browserTabList: browserState._browserTabList,
    getMcpBridgeHandler: getMcpBridgeHandler,
    authorizeMcpBridge: authorizeMcpBridge,
    orchestrator: _orchestrator,
  });
  var handleHTTP = _http.handleHTTP;

  // --- Connection handler (delegated to project-connection.js) ---
  var _connection = attachConnection({
    canReadSession: function (user, s) { return revocation.mayRead({ _aigoraUser: user }, s); },
    cwd: cwd,
    slug: slug,
    liteStatus: _liteStatus,
    osUsers: osUsers,
    debug: debug,
    dangerouslySkipPermissions: dangerouslySkipPermissions,
    dangerouslySkipPermissionsConfigured: dangerouslySkipPermissionsConfigured,
    currentVersion: currentVersion,
    lanHost: lanHost,
    sm: sm,
    tm: tm,
    nm: nm,
    clients: clients,
    send: send,
    sendTo: sendTo,
    opts: opts,
    _loop: _loop,
    _mcp: _mcp,
    _notifications: _notifications,
    hydrateImageRefs: hydrateImageRefs,
    broadcastClientCount: broadcastClientCount,
    broadcastPresence: broadcastPresence,
    getProjectList: getProjectList,
    getHubSchedules: getReadableHubSchedules,
    loadContextSources: loadContextSources,
    saveContextSources: saveContextSources,
    stopFileWatch: stopFileWatch,
    stopAllDirWatches: stopAllDirWatches,
    getProjectOwnerId: function () { return projectOwnerId; },
    setProjectOwnerId: function (id) { projectOwnerId = id; },
    getLatestVersion: function () { return latestVersion; },
    getTitle: function () { return title; },
    getProject: function () { return project; },
    // Exposed so the first websocket connection can lazily warm up the
    // adapters for this project (see project-connection handleConnection).
    warmup: function () {
      sdk.warmup();
      sdk.startIdleReaper();
      if (!osUsers && !sessionTitleMigrationScheduled) {
        sessionTitleMigrationScheduled = true;
        setTimeout(function () {
          try {
            sm.migrateSessionTitles(adapter, cwd);
          } catch (e) {
            console.error("[project] Session title migration failed for " + slug + ":", e && e.message ? e.message : e);
          }
        }, 5000);
      }
    },
  });

  // --- Destroy ---
  function destroy() {
    _loop.stopTimer();
    stopFileWatch();
    stopAllDirWatches();
    // Abort all active sessions and clean up mention sessions
    sm.sessions.forEach(function (session) {
      session.destroying = true;
      if (session.autoContinueTimer) {
        clearTimeout(session.autoContinueTimer);
        session.autoContinueTimer = null;
      }
      if (session.scheduledMessage && session.scheduledMessage.timer) {
        clearTimeout(session.scheduledMessage.timer);
        session.scheduledMessage = null;
      }
      if (session.abortController) {
        try { session.abortController.abort(); } catch (e) {}
      }
      // Close SDK query to terminate the underlying claude child process
      if (session.queryInstance && typeof session.queryInstance.close === "function") {
        try { session.queryInstance.close(); } catch (e) {}
      }
      session.queryInstance = null;
      if (session.messageQueue) {
        try { session.messageQueue.end(); } catch (e) {}
      }
      if (session.worker) {
        try { session.worker.kill(); } catch (e) {}
        session.worker = null;
      }
    });
    // Deregister the process-level exit listener added by createSessionManager
    // so it does not accumulate across project open/close cycles (lr-daca).
    sm.destroy();
    // Kill all terminals
    tm.destroyAll();
    // Shut down local MCP stdio child processes to prevent zombie processes
    // and port conflicts when the project is re-created (lr-4078).
    if (_localMcp && typeof _localMcp.shutdown === "function") {
      try { _localMcp.shutdown(); } catch (e) {}
    }
    for (var ws of clients) {
      try { ws.close(); } catch (e) {}
    }
    clients.clear();
    // Cleanup tmp upload directory
    try {
      var cwdHash = crypto.createHash("sha256").update(cwd).digest("hex").substring(0, 12);
      var tmpDir = path.join(os.tmpdir(), "aigora-" + cwdHash);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {}

    var codexShutdown = Promise.resolve(true);
    if (adapters && adapters.codex && typeof adapters.codex.shutdown === "function") {
      codexShutdown = adapters.codex.shutdown().catch(function(err) {
        console.error("[project] Codex shutdown failed for " + slug + ":", err && err.message ? err.message : err);
        return false;
      });
    }
    return codexShutdown;
  }

  // --- Status info ---
  function getStatus() {
    var sessionCount = 0;
    var hasProcessing = false;
    var pendingPermCount = 0;
    sm.sessions.forEach(function (s) {
      if (revocation && revocation.isPrivate(s)) return; // project cards must not reveal private sessions
      sessionCount++;
      if (s.isProcessing) hasProcessing = true;
      if (s.pendingPermissions) {
        pendingPermCount += Object.keys(s.pendingPermissions).length;
      }
    });
    var status = {
      slug: slug,
      path: cwd,
      project: project,
      title: title,
      icon: icon,
      folderName: folderName || null,
      preferredAgent: preferredAgent,
      clients: clients.size,
      sessions: sessionCount,
      isProcessing: hasProcessing,
      pendingPermissions: pendingPermCount,
      projectOwnerId: projectOwnerId,
    };
    if (worktreeMeta) {
      status.isWorktree = true;
      status.parentSlug = worktreeMeta.parentSlug;
      status.branch = worktreeMeta.branch;
      status.worktreeAccessible = worktreeMeta.accessible;
    }
    var seen = {};
    var onlineUsers = [];
    for (var c of clients) {
      if (!c._aigoraUser) continue;
      var u = c._aigoraUser;
      if (seen[u.id]) continue;
      seen[u.id] = true;
      var p = u.profile || {};
      onlineUsers.push({
        id: u.id,
        displayName: p.name || u.displayName || u.username,
        username: u.username,
        avatarStyle: p.avatarStyle || "thumbs",
        avatarSeed: p.avatarSeed || u.username,
        avatarCustom: p.avatarCustom || "",
      });
    }
    status.onlineUsers = onlineUsers;
    return status;
  }

  function setTitle(newTitle) {
    title = newTitle || null;
    // Built per recipient: an unscoped getProjectList() would hand every client the full project list.
    var listByUser = {};
    for (var ws of clients) {
      var uid = ws._aigoraUser ? ws._aigoraUser.id : "";
      if (!listByUser[uid]) listByUser[uid] = getProjectList(uid || undefined);
      var scoped = listByUser[uid];
      sendTo(ws, { type: "info", cwd: cwd, slug: slug, project: title || project, version: currentVersion, debug: !!debug, osUsers: osUsers, lanHost: lanHost, projectCount: scoped.length, projects: scoped, projectOwnerId: projectOwnerId });
    }
  }

  function setIcon(newIcon) {
    icon = newIcon || null;
  }

  function setFolderName(name) {
    folderName = name || null;
  }

  function setPreferredAgent(agent) {
    preferredAgent = agent || null;
  }

  return {
    cwd: cwd,
    slug: slug,
    project: project,
    clients: clients,
    sm: sm,
    sdk: sdk,
    send: send,
    sendTo: sendTo,
    forEachClient: function (fn) {
      for (var ws of clients) {
        if (ws.readyState === 1) fn(ws);
      }
    },
    handleConnection: handleConnection,
    handleMessage: handleMessage,
    handleDisconnection: handleDisconnection,
    handleHTTP: handleHTTP,
    office: _office,
    getMcpBridgeHandler: getMcpBridgeHandler,
    authorizeMcpBridge: authorizeMcpBridge,
    getStatus: getStatus,
    getOnlineUsers: getOnlineUsers,
    getSessionManager: function () { return sm; },
    // Room purge (lib/room-deletion.js): drops this project's live loop-registry records and orchestration runs of a room.
    purgeRoomData: function (roomId) {
      var out = { loops: 0, runs: 0 };
      loopRegistry.getAll().filter(function (r) { return r && r.roomId === roomId; }).forEach(function (r) { if (loopRegistry.remove(r.id)) out.loops++; });
      if (_orchestrator && _orchestrator.store) out.runs = _orchestrator.store.purgeRoom(roomId);
      return out;
    },
    getNotificationsModule: function () { return _notifications; },
    getSchedules: _loop.getSchedules,
    importSchedule: _loop.importSchedule,
    removeSchedule: _loop.removeSchedule,
    setTitle: setTitle,
    setIcon: setIcon,
    setFolderName: setFolderName,
    setPreferredAgent: setPreferredAgent,
    setProjectOwner: function (ownerId) { projectOwnerId = ownerId; },
    getProjectOwner: function () { return projectOwnerId; },
    recheckPrivateSessionAccess: revocation.recheck,
    refreshUserProfile: function (userId) {
      var user = usersModule.findUserById(userId);
      if (!user) return;
      for (var ws of clients) {
        if (ws._aigoraUser && ws._aigoraUser.id === userId) {
          ws._aigoraUser = user;
        }
      }
      broadcastClientCount();
      broadcastPresence();
    },
    onProcessingChanged: onProcessingChanged,
    getLinuxUserForSession: getLinuxUserForSession,
    destroy: function () {
      revocation.dispose();
      sdk.stopIdleReaper();
      return destroy();
    },
  };
}

module.exports = { createProjectContext: createProjectContext, sendEachFilter: sendEachFilter, safePath: safePath, safeClaudePath: safeClaudePath, validateEnvString: validateEnvString };

return module.exports;
});

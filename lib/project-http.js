module.exports = require("./extensions").select("project-http", function () {
var module = { exports: {} };
var fs = require("fs");
var path = require("path");
var os = require("os");
var { safeEqual } = require("./safe-equal");
var crypto = require("crypto");
var { execFileSync, execFile, spawn } = require("child_process");
var { fsAsUser } = require("./os-users");
var usersModule = require("./users");
var { createPrivateSessionAccess, isChannelBound } = require("./private-session-access");
var readSharedUsage = require("./ai-usage").readSharedUsage;

var IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"]);
var MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
};
var MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB

function parseJsonBody(req, maxBytes) {
  return new Promise(function (resolve, reject) {
    var body = "";
    var bodyBytes = 0;
    // Hard cap: enforce limit while buffering, not only after full accumulation.
    // 1.4x headroom covers base64-encoded payloads (base64 expands by ~4/3).
    var hardCap = maxBytes || MAX_UPLOAD_BYTES * 1.4;
    var rejected = false;
    req.on("data", function (chunk) {
      if (rejected) return;
      bodyBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
      if (bodyBytes > hardCap) {
        rejected = true;
        if (typeof req.destroy === "function") req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      body += chunk;
    });
    req.on("end", function () {
      if (rejected) return;
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(e); }
    });
  });
}

/**
 * Attach HTTP request handler to a project context.
 *
 * ctx fields:
 *   cwd, slug, project, sm, send, sendTo, imagesDir, osUsers, pushModule,
 *   safePath, safeAbsPath, getOsUserInfoForReq, sendExtensionCommandAny,
 *   _extToken, _browserTabList
 */
function attachHTTP(ctx) {
  var cwd = ctx.cwd;
  var slug = ctx.slug;
  var project = ctx.project;
  var getProjectAccess = typeof ctx.getProjectAccess === "function" ? ctx.getProjectAccess : null;
  var sm = ctx.sm;
  var send = ctx.send;
  var imagesDir = ctx.imagesDir;
  var osUsers = ctx.osUsers;
  var pushModule = ctx.pushModule;
  var safePath = ctx.safePath;
  var safeAbsPath = ctx.safeAbsPath;
  var getOsUserInfoForReq = ctx.getOsUserInfoForReq;
  var sendExtensionCommandAny = ctx.sendExtensionCommandAny;
  var _extToken = ctx._extToken;
  var _browserTabList = ctx._browserTabList;

  // Inline controls on an orchestration card in the root conversation. The
  // orchestrator re-checks room membership and role on every call.
  function handleOrchestration(req, res, m) {
    function reply(status, obj) {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(obj));
    }
    var caller = req._aigoraUser || null;
    if (!caller) return reply(401, { error: "Authentication required" });
    var orch = ctx.orchestrator || null;
    if (!orch) return reply(404, { error: "Not found" });
    var runId, stepId = null;
    try {
      runId = decodeURIComponent(m[1]);
    } catch (_) { return reply(400, { error: "Invalid path" }); }
    var action = m[2];
    try {
      if (!stepId && action === "cancel" && req.method === "POST") return reply(200, { run: orch.cancelRun(caller, runId) });
      if (!stepId && action === "retry" && req.method === "POST") return reply(200, { run: orch.retryStep(caller, runId) });
    } catch (err) {
      var status = err && err.status >= 400 && err.status < 600 ? err.status : 500;
      return reply(status, { error: status === 500 ? "Orchestration request failed" : err.message });
    }
    reply(404, { error: "Not found" });
  }

  // Every session whose history references this image file (positive hits are cached briefly; a miss is
  // never cached, so a freshly bound private image cannot be classed as unbound). Re-validated against the
  // live session map on each use.
  var imageOwnerCache = new Map();
  function imageOwners(name) {
    var hit = imageOwnerCache.get(name);
    if (hit && Date.now() - hit.at < 30000) {
      var live = hit.ids.map(function (id) { return sm.sessions.get(id); }).filter(Boolean);
      if (live.length) return live;
      imageOwnerCache.delete(name);
    }
    var found = [];
    sm.sessions.forEach(function (s, id) {
      var hist = [];
      try { hist = sm.readSessionHistoryFromDisk(s) || []; } catch (e) { hist = []; }
      for (var i = 0; i < hist.length; i++) {
        var refs = hist[i] && hist[i].imageRefs;
        if (Array.isArray(refs) && refs.some(function (r) { return r && r.file === name; })) { found.push({ id: id, session: s }); break; }
      }
    });
    if (found.length) {
      if (imageOwnerCache.size > 2000) imageOwnerCache.clear();
      imageOwnerCache.set(name, { at: Date.now(), ids: found.map(function (f) { return f.id; }) });
    }
    return found.map(function (f) { return f.session; });
  }

  // A chat image is readable by whoever may read a session that references it. An image no session
  // references is "unbound": served to admins and room members, never to an invited guest account.
  function mayReadImage(user, owners) {
    if (!owners.length) {
      if (!user) return true; // no authenticated user: single-user mode, auth is enforced upstream otherwise
      var u = null;
      try { u = (ctx.usersModule || usersModule).findUserById(user.id); } catch (_) { u = null; }  // iron-laws: ignore[IL-301] fail-closed access check; a lookup failure leaves u null and denies
      return !!u && u.accountType !== "invite_guest";
    }
    if (!user) return !owners.some(isChannelBound);
    var access = createPrivateSessionAccess(ctx.usersModule || usersModule);
    var projectAccess = getProjectAccess ? getProjectAccess() : project;
    return owners.some(function (s) {
      if (isChannelBound(s)) return access.mayObserve(user, s); // private: the personal read predicate decides
      if (!projectAccess || typeof projectAccess !== "object" || projectAccess.error) return false;
      return access.canReadSession(user, s, projectAccess);
    });
  }

  function handleHTTP(req, res, urlPath) {
    var cleanOrchPath = (urlPath || "").split("?")[0].replace(/\/+$/, "");
    var orchMatch = cleanOrchPath.match(/^\/api\/orchestration\/runs\/([^/]+)\/(cancel|retry)$/);
    if (orchMatch) {
      handleOrchestration(req, res, orchMatch);
      return true;
    }
    if (req.method === "GET" && urlPath === "/api/ai-usage") {
      if (!req._aigoraUser) {
        res.writeHead(401, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end('{"error":"Authentication required"}');
        return true;
      }
      readSharedUsage(false).then(function (usage) {
        // Local models: a status-only row ("로컬 · 제한 없음"), present only while the provider is enabled.
        var localRow = null;
        var endpointRow = null;
        try {
          var _ls = require("./providers/local/state");
          localRow = _ls.usageRow(_ls.getLocalState().snapshot());
          endpointRow = _ls.endpointsUsageRow(_ls.getLocalState().snapshot());
          _ls.getLocalState().refresh(false).catch(function () {});
        } catch (_) {}
        var extraRows = [endpointRow, localRow].filter(Boolean);
        var body = extraRows.length ? Object.assign({}, usage, { providers: usage.providers.concat(extraRows) }) : usage;
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(body));
      }).catch(function () {
        res.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end('{"error":"Usage unavailable"}');
      });
      return true;
    }
    if (req.method === "GET" && urlPath === "/api/local-model") {
      if (!req._aigoraUser) {
        res.writeHead(401, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end('{"error":"Authentication required"}');
        return true;
      }
      var _lm = require("./providers/local/state");
      _lm.getLocalState().refresh(false).then(function (snap) {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(_lm.publicStatus(snap)));
      }).catch(function () {
        res.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end('{"error":"Local model status unavailable"}');
      });
      return true;
    }
    if (ctx.sharedPosts && ctx.sharedPosts.handleHttp(req, res, urlPath)) return true;
    if (ctx.attachments && ctx.attachments.handleHttp(req, res, urlPath)) return true;
    if (ctx.office && ctx.office.handleHttp(req, res, urlPath)) return true;
    // Owner-only one-link add-on setup. Arguments are passed directly to the
    // supported CLIs (never through a shell), and only public GitHub HTTPS
    // repository URLs without credentials/query strings are accepted.
    if (req.method === "POST" && urlPath === "/api/add-from-github") {
      var addonUser = req._aigoraUser || null;
      if (!addonUser || addonUser.role !== "admin") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":"Owner access required"}');
        return true;
      }
      parseJsonBody(req).then(function (body) {
        var rawUrl = typeof body.url === "string" ? body.url.trim() : "";
        var kind = body.kind === "plugin" ? "plugin" : "skill";
        var parsed;
        try { parsed = new URL(rawUrl); } catch (_) {}
        if (!parsed || parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.username || parsed.password || parsed.search || parsed.hash || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(parsed.pathname)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"GitHub 저장소 링크만 사용할 수 있습니다"}');
          return;
        }
        var repoUrl = parsed.origin + parsed.pathname.replace(/\/$/, "");
        var command = kind === "plugin" ? "codex" : "npx";
        var args = kind === "plugin"
          ? ["plugin", "marketplace", "add", repoUrl, "--json"]
          : ["--yes", "skills", "add", repoUrl, "--all", "--project", "--json"];
        execFile(command, args, { cwd: cwd, env: require("./agent-env").stripRoutingSecrets(process.env), timeout: 120000, maxBuffer: 1024 * 1024 }, function (err, stdout, stderr) {
          if (err) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: (stderr || err.message || "설치 실패").trim().slice(0, 800) }));
            return;
          }
          if (kind !== "plugin") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, kind: kind, message: "저장소의 Claude 호환 스킬을 지원 에이전트에 추가했습니다.", output: String(stdout || "").slice(0, 2000) }));
            return;
          }
          var addResult = {};
          try { addResult = JSON.parse(stdout || "{}"); } catch (_) {}
          var marketplaceName = addResult.name || addResult.marketplaceName || (addResult.marketplace && addResult.marketplace.name) || null;
          if (!marketplaceName || !/^[A-Za-z0-9_.-]+$/.test(marketplaceName)) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, kind: kind, message: "Claude/Codex 플러그인 저장소를 추가했습니다. 플러그인 목록에서 설치할 수 있습니다." }));
            return;
          }
          execFile("codex", ["plugin", "list", "--marketplace", marketplaceName, "--available", "--json"], { cwd: cwd, env: require("./agent-env").stripRoutingSecrets(process.env), timeout: 60000, maxBuffer: 1024 * 1024 }, function (listErr, listOut) {
            var listData = {};
            try { listData = JSON.parse(listOut || "{}"); } catch (_) {}
            var available = Array.isArray(listData.plugins) ? listData.plugins : (Array.isArray(listData) ? listData : []);
            if (listErr || available.length !== 1) {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: true, kind: kind, message: available.length > 1 ? "플러그인 저장소를 추가했습니다. 여러 플러그인이 있어 목록에서 하나를 선택해 주세요." : "플러그인 저장소를 추가했습니다. 플러그인 목록에서 설치할 수 있습니다." }));
              return;
            }
            var pluginName = available[0].name || available[0].id;
            if (!pluginName || !/^[A-Za-z0-9_.-]+$/.test(pluginName)) {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: true, kind: kind, message: "플러그인 저장소를 추가했습니다. 플러그인 목록에서 설치할 수 있습니다." }));
              return;
            }
            execFile("codex", ["plugin", "add", pluginName + "@" + marketplaceName, "--json"], { cwd: cwd, env: require("./agent-env").stripRoutingSecrets(process.env), timeout: 120000, maxBuffer: 1024 * 1024 }, function (installErr, installOut, installErrOut) {
              res.writeHead(installErr ? 400 : 200, { "Content-Type": "application/json" });
              res.end(JSON.stringify(installErr ? { error: String(installErrOut || installErr.message).slice(0, 800) } : { ok: true, kind: kind, message: "플러그인을 추가했습니다. 새 대화부터 사용할 수 있습니다.", output: String(installOut || "").slice(0, 2000) }));
            });
          });
        });
      }).catch(function () {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end('{"error":"Invalid request"}');
      });
      return true;
    }
    // Browser MCP extension bridge: forward commands to Chrome extension
    if (req.method === "POST" && urlPath === "/ext-command") {
      parseJsonBody(req).then(function (body) {
        // Validate auth token
        if (!body.token || !safeEqual(body.token, _extToken)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end('{"error":"Invalid token"}');
          return;
        }
        var command = body.command;
        var args = body.args || {};
        var timeout = Math.min(body.timeout || 5000, 30000); // max 30s

        // Special command: list_tabs (no extension round-trip needed)
        if (command === "list_tabs") {
          var tabArr = [];
          for (var tid in _browserTabList) {
            tabArr.push(_browserTabList[tid]);
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ result: { tabs: tabArr } }));
          return;
        }

        sendExtensionCommandAny(command, args, timeout).then(function (result) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ result: result || {} }));
        }).catch(function (err) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message || "Extension command failed" }));
        });
      }).catch(function () {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end('{"error":"Invalid JSON body"}');
      });
      return true;
    }

    // Serve chat images
    if (req.method === "GET" && urlPath.indexOf("/images/") === 0) {
      var imgName = path.basename(urlPath);
      // Sanitize: only allow expected filename pattern
      if (!/^\d+-[a-f0-9]+\.\w+$/.test(imgName)) {
        res.writeHead(400);
        res.end("Bad request");
        return true;
      }
      var imgPath = path.join(imagesDir, imgName);
      var imgOwners = imageOwners(imgName);
      var imgOwner = imgOwners.some(isChannelBound);
      if (!mayReadImage(req._aigoraUser || null, imgOwners)) {
        res.writeHead(404);
        res.end("Not found");
        return true;
      }
      try {
        var imgBuf = fs.readFileSync(imgPath);
        var ext = path.extname(imgName).toLowerCase();
        var mime = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : "image/jpeg";
        res.writeHead(200, { "Content-Type": mime, "Cache-Control": imgOwner ? "private, no-store" : "private, max-age=86400" });
        res.end(imgBuf);
      } catch (e) {
        res.writeHead(404);
        res.end("Not found");
      }
      return true;
    }

    // File upload
    if (req.method === "POST" && urlPath === "/api/upload") {
      // Legacy host-temp upload: no room scope, quota or expiry, so only the host admin may use it.
      // Members attach files through the scoped room attachment pipeline.
      if (req._aigoraUser && req._aigoraUser.role !== "admin") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":"upload not permitted"}');
        return true;
      }
      parseJsonBody(req).then(function (body) {
        var fileName = body.name;
        var fileData = body.data; // base64
        if (!fileName || !fileData) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"missing name or data"}');
          return;
        }
        // Sanitize filename — strip path separators
        var safeName = path.basename(fileName).replace(/[\x00-\x1f\/\\:*?"<>|]/g, "_");
        if (!safeName) safeName = "upload";

        // Check size
        var estimatedBytes = fileData.length * 0.75;
        if (estimatedBytes > MAX_UPLOAD_BYTES) {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end('{"error":"file too large (max 50MB)"}');
          return;
        }

        // Create tmp dir: os.tmpdir()/aigora-{hash}/
        var cwdHash = crypto.createHash("sha256").update(cwd).digest("hex").substring(0, 12);
        var tmpDir = path.join(os.tmpdir(), "aigora-" + cwdHash);
        try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (e) {}

        // Add timestamp prefix to avoid collisions
        var ts = Date.now();
        var destName = ts + "-" + safeName;
        var destPath = path.join(tmpDir, destName);

        try {
          var buf = Buffer.from(fileData, "base64");
          fs.writeFileSync(destPath, buf);
          // Make readable by all local users and chown to session owner
          try { fs.chmodSync(destPath, 0o644); } catch (e2) {}
          try { fs.chmodSync(tmpDir, 0o755); } catch (e2) {}
          if (req._aigoraUser && req._aigoraUser.linuxUser) {
            try {
              var _osUM = require("./os-users");
              var _uid = _osUM.getLinuxUserUid(req._aigoraUser.linuxUser);
              if (_uid != null) {
                execFileSync("chown", [String(_uid), destPath]);
                execFileSync("chown", [String(_uid), tmpDir]);
              }
            } catch (e2) {}
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ path: destPath, name: safeName }));
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          console.error("[upload] failed to save:", e && e.message);
          res.end(JSON.stringify({ error: "failed to save" }));
        }
      }).catch(function () {
        res.writeHead(400);
        res.end("Bad request");
      });
      return true;
    }

    // Push subscribe
    if (req.method === "POST" && urlPath === "/api/push-subscribe") {
      parseJsonBody(req).then(function (body) {
        var sub = body.subscription || body;
        if (pushModule) pushModule.addSubscription(sub, body.replaceEndpoint);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      }).catch(function () {
        res.writeHead(400);
        res.end("Bad request");
      });
      return true;
    }

    // Permission response from push notification
    if (req.method === "POST" && urlPath === "/api/permission-response") {
      parseJsonBody(req).then(function (data) {
        var requestId = data.requestId;
        var decision = data.decision;
        if (!requestId || !decision) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"missing requestId or decision"}');
          return;
        }
        // Resolve the owning session via the O(1) request index. Only when the
        // index is unavailable (older session manager) scan sessions instead.
        var session = null;
        var index = sm.permissionRequestIndex;
        if (index && typeof index === "object") {
          var sessionId = index[requestId];
          if (sessionId !== undefined && sessionId !== null) session = sm.sessions.get(sessionId) || null;
        } else {
          sm.sessions.forEach(function (s) {
            if (!session && s.pendingPermissions && s.pendingPermissions[requestId]) session = s;
          });
        }
        var pending = session && session.pendingPermissions ? session.pendingPermissions[requestId] : null;

        // Fail closed for authenticated callers: owner or admin, and the session
        // must be accessible. Requests with no _aigoraUser (single-user mode,
        // where server routing never sets one) keep the legacy behavior.
        var caller = req._aigoraUser;
        var allowed = false;
        if (pending) {
          var um = ctx.usersModule || usersModule;
          var projectAccess = getProjectAccess ? getProjectAccess() : project;
          if (!caller || (!!projectAccess && typeof projectAccess === "object" && !projectAccess.error)) {
            // Same policy as the WebSocket permission_response (room-permission-policy.authorizeResolve).
            allowed = require("./room-permission-policy").authorizeResolve({
              usersModule: um, user: caller || null, session: session, pending: pending, access: projectAccess,
              contained: require("./room-execution").isContained(session, session.vendor || (ctx.adapter && ctx.adapter.vendor) || "claude"),
            }).ok;
          }
        }
        // Denied and missing look identical so request IDs cannot be probed;
        // denial leaves pendingPermissions and permissionRequestIndex untouched.
        if (!allowed) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end('{"error":"permission request not found"}');
          return;
        }

        delete session.pendingPermissions[requestId];
        if (index && typeof index === "object") delete index[requestId];
        if (decision === "allow") {
          pending.resolve({ behavior: "allow", updatedInput: pending.toolInput });
        } else {
          pending.resolve({ behavior: "deny", message: "Denied via push notification" });
        }
        sm.sendAndRecord(session, {
          type: "permission_resolved",
          requestId: requestId,
          decision: decision,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      }).catch(function () {
        res.writeHead(400);
        res.end("Bad request");
      });
      return true;
    }

    // VAPID public key
    if (req.method === "GET" && urlPath === "/api/vapid-public-key") {
      if (pushModule) {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache, no-store" });
        res.end(JSON.stringify({ publicKey: pushModule.publicKey }));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end('{"error":"push not available"}');
      }
      return true;
    }

    // File browser: serve project images
    if (req.method === "GET" && urlPath.startsWith("/api/file?")) {
      var qIdx = urlPath.indexOf("?");
      var params = new URLSearchParams(urlPath.substring(qIdx));
      var reqFilePath = params.get("path");
      if (!reqFilePath) { res.writeHead(400); res.end("Missing path"); return true; }
      if (req._aigoraUser && require("./authz-gate").checkMessage({ _aigoraUser: req._aigoraUser }, { type: "fs_read" }, ctx.usersModule || usersModule, osUsers)) {
        res.writeHead(403); res.end("Access denied"); return true;
      }
      var absFile = safePath(cwd, reqFilePath);
      if (!absFile && getOsUserInfoForReq(req)) {
        absFile = safeAbsPath(reqFilePath);
      }
      if (!absFile) { res.writeHead(403); res.end("Access denied"); return true; }
      var fileExt = path.extname(absFile).toLowerCase();
      if (!IMAGE_EXTS.has(fileExt)) { res.writeHead(403); res.end("Only image files"); return true; }
      try {
        var fileServeUserInfo = getOsUserInfoForReq(req);
        var fileContent;
        if (fileServeUserInfo) {
          var binResult = fsAsUser("read_binary", { file: absFile }, fileServeUserInfo);
          fileContent = binResult.buffer;
        } else {
          fileContent = fs.readFileSync(absFile);
        }
        var fileMime = MIME_TYPES[fileExt] || "application/octet-stream";
        // Project files are untrusted: an SVG opened directly must not run script in this origin.
        res.writeHead(200, { "Content-Type": fileMime, "Cache-Control": "private, no-cache", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'" });
        res.end(fileContent);
      } catch (e) {
        res.writeHead(404); res.end("Not found");
      }
      return true;
    }

    // Skills permission gate
    if (urlPath === "/api/install-skill" || urlPath === "/api/uninstall-skill" || urlPath === "/api/installed-skills") {
      if (req._aigoraUser) {
        var skPerms = usersModule.getEffectivePermissions(req._aigoraUser, osUsers);
        if (!skPerms.skills) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end('{"error":"Skills access is not permitted"}');
          return true;
        }
      }
    }

    // Install a skill (background spawn)
    if (req.method === "POST" && urlPath === "/api/install-skill") {
      parseJsonBody(req).then(function (body) {
        var url = body.url;
        var skill = body.skill;
        var scope = body.scope; // "global" or "project"
        if (!url || !skill || !scope) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"missing url, skill, or scope"}');
          return;
        }
        // Validate skill name: alphanumeric, hyphens, underscores only
        if (!/^[a-zA-Z0-9_-]+$/.test(skill)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"invalid skill name"}');
          return;
        }
        // Validate URL: must be https://
        if (!/^https:\/\//i.test(url)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"only https:// URLs are allowed"}');
          return;
        }
        var skillUserInfo = getOsUserInfoForReq(req);
        var spawnCwd = scope === "global" ? (skillUserInfo ? skillUserInfo.home : require("./config").REAL_HOME) : cwd;
        var scopeFlag = scope === "global" ? "--global" : "--project";
        var skillSpawnOpts = {
          cwd: spawnCwd,
          stdio: ["ignore", "pipe", "pipe"],
          detached: false,
          env: require("./agent-env").stripRoutingSecrets(process.env),
        };
        if (skillUserInfo) {
          skillSpawnOpts.uid = skillUserInfo.uid;
          skillSpawnOpts.gid = skillUserInfo.gid;
          skillSpawnOpts.env = require("./agent-env").stripRoutingSecrets(Object.assign({}, process.env, {
            HOME: skillUserInfo.home,
            npm_config_cache: require("path").join(skillUserInfo.home, ".npm"),
          }));
        }
        console.log("[skill-install] spawning: npx skills add " + url + " --skill " + skill + " --yes " + scopeFlag + " (cwd: " + spawnCwd + ")");
        var child = spawn("npx", ["skills", "add", url, "--skill", skill, "--yes", scopeFlag], skillSpawnOpts);
        var stdoutBuf = "";
        var stderrBuf = "";
        child.stdout.on("data", function (chunk) {
          stdoutBuf += chunk.toString();
          console.log("[skill-install] " + skill + " stdout chunk: " + chunk.toString().trim().slice(0, 500));
        });
        child.stderr.on("data", function (chunk) {
          stderrBuf += chunk.toString();
          console.log("[skill-install] " + skill + " stderr chunk: " + chunk.toString().trim().slice(0, 500));
        });
        // Timeout after 60 seconds
        var installTimeout = setTimeout(function () {
          console.error("[skill-install] " + skill + " timed out after 60s, killing process");
          try { child.kill("SIGTERM"); } catch (e) {}
          try {
            send({ type: "skill_installed", skill: skill, scope: scope, success: false, error: "Installation timed out after 60 seconds" });
          } catch (e) {}
        }, 60000);
        child.on("close", function (code) {
          clearTimeout(installTimeout);
          console.log("[skill-install] " + skill + " exited with code " + code + " (stdout=" + stdoutBuf.length + "b, stderr=" + stderrBuf.length + "b)");
          if (stdoutBuf) console.log("[skill-install] stdout: " + stdoutBuf.slice(0, 2000));
          if (stderrBuf) console.log("[skill-install] stderr: " + stderrBuf.slice(0, 2000));
          try {
            var success = code === 0;
            send({
              type: "skill_installed",
              skill: skill,
              scope: scope,
              success: success,
              error: success ? null : "Process exited with code " + code,
            });
          } catch (e) {
            console.error("[project] skill_installed send failed:", e.message || e);
          }
        });
        child.on("error", function (err) {
          clearTimeout(installTimeout);
          console.error("[skill-install] " + skill + " spawn error:", err.message || err);
          try {
            send({
              type: "skill_installed",
              skill: skill,
              scope: scope,
              success: false,
              error: err.message,
            });
          } catch (e) {
            console.error("[skill-install] " + skill + " send failed:", e.message || e);
          }
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      }).catch(function () {
        res.writeHead(400);
        res.end("Bad request");
      });
      return true;
    }

    // Uninstall a skill (remove directory)
    if (req.method === "POST" && urlPath === "/api/uninstall-skill") {
      parseJsonBody(req).then(function (body) {
        var skill = body.skill;
        var scope = body.scope; // "global" or "project"
        if (!skill || !scope) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"missing skill or scope"}');
          return;
        }
        // Validate skill name
        if (!/^[a-zA-Z0-9_-]+$/.test(skill)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"invalid skill name"}');
          return;
        }
        var uninstallUserInfo = getOsUserInfoForReq(req);
        var baseDir = scope === "global" ? (uninstallUserInfo ? uninstallUserInfo.home : require("./config").REAL_HOME) : cwd;
        var skillDir = path.join(baseDir, ".claude", "skills", skill);
        // Safety: ensure skillDir is inside the expected .claude/skills directory
        var expectedParent = path.join(baseDir, ".claude", "skills");
        var resolved = path.resolve(skillDir);
        if (!resolved.startsWith(expectedParent + path.sep)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end('{"error":"invalid skill path"}');
          return;
        }
        try {
          if (uninstallUserInfo) {
            // Run rm as target user to respect permissions
            var rmScript = "var fs = require('fs'); fs.rmSync(" + JSON.stringify(resolved) + ", { recursive: true, force: true });";
            execFileSync(process.execPath, ["-e", rmScript], {
              uid: uninstallUserInfo.uid,
              gid: uninstallUserInfo.gid,
              timeout: 10000,
            });
          } else {
            fs.rmSync(resolved, { recursive: true, force: true });
          }
          send({
            type: "skill_uninstalled",
            skill: skill,
            scope: scope,
            success: true,
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"ok":true}');
        } catch (err) {
          send({
            type: "skill_uninstalled",
            skill: skill,
            scope: scope,
            success: false,
            error: err.message,
          });
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      }).catch(function () {
        res.writeHead(400);
        res.end("Bad request");
      });
      return true;
    }

    // Installed skills (global + project)
    if (req.method === "GET" && urlPath === "/api/installed-skills") {
      var installed = {};
      var globalDir = path.join(require("./config").REAL_HOME, ".claude", "skills");
      var projectDir = path.join(cwd, ".claude", "skills");
      var scanDirs = [
        { dir: globalDir, scope: "global" },
        { dir: projectDir, scope: "project" },
      ];
      for (var sd = 0; sd < scanDirs.length; sd++) {
        var entries;
        try { entries = fs.readdirSync(scanDirs[sd].dir, { withFileTypes: true }); } catch (e) { continue; }
        for (var si = 0; si < entries.length; si++) {
          var ent = entries[si];
          if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
          var mdPath = path.join(scanDirs[sd].dir, ent.name, "SKILL.md");
          try {
            var mdContent = fs.readFileSync(mdPath, "utf8");
            var desc = "";
            // Parse YAML frontmatter for description
            var version = "";
            if (mdContent.startsWith("---")) {
              var endIdx = mdContent.indexOf("---", 3);
              if (endIdx !== -1) {
                var frontmatter = mdContent.substring(3, endIdx);
                var descMatch = frontmatter.match(/^description:\s*(.+)/m);
                if (descMatch) desc = descMatch[1].trim();
                var verMatch = frontmatter.match(/version:\s*"?([^"\n]+)"?/m);
                if (verMatch) version = verMatch[1].trim();
              }
            }
            if (!installed[ent.name]) {
              installed[ent.name] = { scope: scanDirs[sd].scope, description: desc, version: version, path: path.join(scanDirs[sd].dir, ent.name) };
            } else {
              // project-level adds to existing global entry
              installed[ent.name].scope = "both";
              if (desc && !installed[ent.name].description) installed[ent.name].description = desc;
              if (version && !installed[ent.name].version) installed[ent.name].version = version;
            }
          } catch (e) {}
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ installed: installed }));
      return true;
    }

    // Skill update check cache (avoid redundant GitHub fetches)
    if (!ctx._skillCheckCache) ctx._skillCheckCache = {};
    var SKILL_CHECK_TTL = 5 * 60 * 1000; // 5 minutes

    // Check skill updates (compare installed vs remote versions)
    if (req.method === "POST" && urlPath === "/api/check-skill-updates") {
      parseJsonBody(req).then(function (body) {
        var skills = body.skills; // [{ name, url, scope }]
        if (!Array.isArray(skills) || skills.length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"missing skills array"}');
          return;
        }
        // Read installed versions (use requesting user's home in multi-user setups)
        var skillUserHome = (function () {
          var sui = getOsUserInfoForReq(req);
          return sui ? sui.home : require("./config").REAL_HOME;
        })();
        var globalSkillsDir = path.join(skillUserHome, ".claude", "skills");
        var projectSkillsDir = path.join(cwd, ".claude", "skills");
        var results = [];
        var pending = skills.length;

        function parseVersionFromSkillMd(content) {
          if (!content || !content.startsWith("---")) return "";
          var endIdx = content.indexOf("---", 3);
          if (endIdx === -1) return "";
          var fm = content.substring(3, endIdx);
          var m = fm.match(/version:\s*"?([^"\n]+)"?/m);
          return m ? m[1].trim() : "";
        }

        function getInstalledVersion(name) {
          var dirs = [path.join(globalSkillsDir, name, "SKILL.md"), path.join(projectSkillsDir, name, "SKILL.md")];
          for (var d = 0; d < dirs.length; d++) {
            try {
              var c = fs.readFileSync(dirs[d], "utf8");
              var v = parseVersionFromSkillMd(c);
              if (v) return v;
            } catch (e) {}
          }
          return "";
        }

        function compareVersions(a, b) {
          // returns -1 if a < b, 0 if equal, 1 if a > b
          if (!a && !b) return 0;
          if (!a) return -1;
          if (!b) return 1;
          var pa = a.split(".").map(Number);
          var pb = b.split(".").map(Number);
          for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
            var va = pa[i] || 0;
            var vb = pb[i] || 0;
            if (va < vb) return -1;
            if (va > vb) return 1;
          }
          return 0;
        }

        function finishOne() {
          pending--;
          if (pending === 0) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ results: results }));
          }
        }

        for (var si = 0; si < skills.length; si++) {
          (function (skill) {
            var installedVer = getInstalledVersion(skill.name);
            var installed = !!installedVer;

            // Return cached result if fresh
            var cacheKey = skill.name + ":" + (installedVer || "");
            var cached = ctx._skillCheckCache[cacheKey];
            if (cached && (Date.now() - cached.ts) < SKILL_CHECK_TTL) {
              results.push(cached.result);
              finishOne();
              return;
            }

            // Convert GitHub repo URL to raw SKILL.md URL
            var rawUrl = "";
            var ghMatch = skill.url.match(/github\.com\/([^/]+)\/([^/]+)/);
            if (ghMatch) {
              rawUrl = "https://raw.githubusercontent.com/" + ghMatch[1] + "/" + ghMatch[2] + "/main/SKILL.md";
            }
            if (!rawUrl) {
              var r0 = { name: skill.name, installed: installed, installedVersion: installedVer, remoteVersion: "", status: installed ? "ok" : "missing" };
              ctx._skillCheckCache[cacheKey] = { ts: Date.now(), result: r0 };
              results.push(r0);
              finishOne();
              return;
            }
            // Fetch remote SKILL.md
            var https = require("https");
            https.get(rawUrl, function (resp) {
                var data = "";
              resp.on("data", function (chunk) { data += chunk; });
              resp.on("end", function () {
                try {
                  var remoteVer = parseVersionFromSkillMd(data);
                  var status = "ok";
                  if (!installed) {
                    status = "missing";
                  } else if (remoteVer && compareVersions(installedVer, remoteVer) < 0) {
                    status = "outdated";
                  }
                  var r1 = { name: skill.name, installed: installed, installedVersion: installedVer, remoteVersion: remoteVer, status: status };
                  ctx._skillCheckCache[cacheKey] = { ts: Date.now(), result: r1 };
                  results.push(r1);
                  finishOne();
                } catch (e) {
                  console.error("[skill-check] " + skill.name + " version parse failed:", e.message || e);
                  results.push({ name: skill.name, installed: installed, installedVersion: installedVer, remoteVersion: "", status: installed ? "ok" : "error" });
                  finishOne();
                }
              });
            }).on("error", function (err) {
              console.error("[skill-check] " + skill.name + " fetch error:", err.message || err);
              results.push({ name: skill.name, installed: installed, installedVersion: installedVer, remoteVersion: "", status: installed ? "ok" : "missing" });
              finishOne();
            });
          })(skills[si]);
        }
      }).catch(function () {
        res.writeHead(400);
        res.end("Bad request");
      });
      return true;
    }

    // Git dirty check
    if (req.method === "GET" && urlPath === "/api/git-dirty") {
      try {
        var out = execFileSync("git", ["status", "--porcelain"], { cwd: cwd, encoding: "utf8", timeout: 5000 });
        var lines = out.trim().split("\n").filter(function (line) {
          return line.trim().length > 0 && !line.startsWith("??");
        });
        var dirty = lines.length > 0;
        var files = lines.map(function (line) { return line.trim(); });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ dirty: dirty, files: files }));
      } catch (e) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ dirty: false }));
      }
      return true;
    }

    // List branches for worktree modal
    if (req.method === "GET" && urlPath === "/api/branches") {
      try {
        var brRaw = execFileSync("git", ["branch", "-a", "--format=%(refname:short)"], {
          cwd: cwd, timeout: 5000, encoding: "utf8"
        });
        var brList = brRaw.trim().split("\n").filter(Boolean);
        var defBr = "main";
        try {
          var hrRef = execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"], {
            cwd: cwd, timeout: 3000, encoding: "utf8"
          }).trim();
          defBr = hrRef.replace(/^origin\//, "");
        } catch (e) {}
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ branches: brList, defaultBranch: defBr }));
      } catch (e) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ branches: ["main"], defaultBranch: "main" }));
      }
      return true;
    }

    // MCP bridge endpoint: allows Codex's mcp-bridge-server.js to list/call
    // in-app and remote MCP tools via HTTP (localhost only).
    if (req.method === "POST" && urlPath === "/api/mcp-bridge") {
      // Only the local bridge child holds the capability token; it must also be backed by a live authorized host execution.
      var bridgeCap = require("./mcp-bridge-capability");
      var bridgeOk = bridgeCap.verify(slug, req.headers[bridgeCap.HEADER]);
      if (bridgeOk) { try { bridgeOk = typeof ctx.authorizeMcpBridge === "function" && ctx.authorizeMcpBridge() === true; } catch (_) { bridgeOk = false; } }  // iron-laws: ignore[IL-301] fail-closed security check; an authorize failure denies the bridge request (403)
      if (!bridgeOk) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":"forbidden"}');
        return true;
      }
      parseJsonBody(req).then(function (body) {
        var action = body.action;
        var getMcpBridgeHandler = ctx.getMcpBridgeHandler;
        if (!getMcpBridgeHandler) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end('{"error":"MCP bridge not configured"}');
          return;
        }
        var handler = getMcpBridgeHandler();
        if (!handler) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end('{"error":"MCP bridge handler unavailable"}');
          return;
        }

        if (action === "list_tools") {
          handler.listTools().then(function (tools) {
            var serverCounts = {};
            for (var ti = 0; ti < tools.length; ti++) {
              serverCounts[tools[ti].server] = (serverCounts[tools[ti].server] || 0) + 1;
            }
            console.log("[mcp-bridge-http] list_tools:", tools.length, "tools -", Object.keys(serverCounts).map(function(s) { return s + "(" + serverCounts[s] + ")"; }).join(", ") || "(none)");
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ tools: tools }));
          }).catch(function (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message || "Failed to list tools" }));
          });
        } else if (action === "call_tool") {
          var server = body.server;
          var tool = body.tool;
          var args = body.args || {};
          console.log("[mcp-bridge-http] call_tool:", server + "/" + tool);
          handler.callTool(server, tool, args).then(function (result) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ result: result }));
          }).catch(function (err) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message || "Tool call failed" }));
          });
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"Unknown action: ' + (action || '') + '"}');
        }
      }).catch(function () {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end('{"error":"Invalid JSON body"}');
      });
      return true;
    }

    // Info endpoint
    if (req.method === "GET" && urlPath === "/info") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify({ cwd: cwd, project: project, slug: slug }));
      return true;
    }

    return false; // not handled
  }

  return {
    handleHTTP: handleHTTP,
  };
}

module.exports = { attachHTTP: attachHTTP, parseJsonBody: parseJsonBody };

return module.exports;
});

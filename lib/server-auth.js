var crypto = require("crypto");
var fs = require("fs");
var path = require("path");
var { safeEqual } = require("./safe-equal");
var { CONFIG_DIR } = require("./config");
var _isDevMode = require("./config").isDevMode;
var store = require("./store");
var audit = require("./audit");
var { readCappedBody } = require("./utils");
var { clientIp: resolveClientIp } = require("./client-ip");
var { resolveEffectiveProtocol } = require("./effective-protocol");

// Default token TTL: 30 days. Tokens issued before expiry support was added are
// treated as valid for one additional TTL cycle to avoid forced logouts on upgrade.
var TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// --- Cookie helpers ---

function parseCookies(req) {
  var cookies = {};
  var header = req.headers.cookie || "";
  header.split(";").forEach(function (part) {
    var pair = part.trim().split("=");
    if (pair.length === 2) cookies[pair[0]] = pair[1];
  });
  return cookies;
}

// --- PIN rate limiting ---

var PIN_MAX_ATTEMPTS = 5;
var PIN_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

function attachAuth(ctx) {
  var users = ctx.users;
  var smtp = ctx.smtp;
  var pages = ctx.pages;
  var tlsOptions = ctx.tlsOptions;
  var osUsers = ctx.osUsers;
  var provisionLinuxUser = ctx.provisionLinuxUser;
  var onUserProvisioned = ctx.onUserProvisioned;
  function clientIp(req) { return resolveClientIp(req, { trustLoopbackProxy: ctx.trustLoopbackProxy, trustedProxies: ctx.trustedProxies }); }

  // --- Multi-user auth tokens (persisted to disk) ---
  var TOKENS_NAME = _isDevMode ? "auth-tokens-dev.json" : "auth-tokens.json";
  var MULTI_USER_COOKIE = _isDevMode ? "relay_auth_user_dev" : "relay_auth_user";
  var multiUserTokens = {};

  function loadTokens() {
    // Synchronous at startup: read directly so the server is ready before accepting
    // connections. store.js is used for all subsequent writes.
    try {
      var raw = fs.readFileSync(path.join(CONFIG_DIR, TOKENS_NAME), "utf8");
      var data = JSON.parse(raw);
      if (data && typeof data === "object") {
        // Migration: tokens stored as plain userId strings (legacy format) or as
        // objects with {userId, issuedAt, expiresAt}. Upgrade legacy entries in
        // place so they are valid for one TTL cycle, then require the field.
        var now = Date.now();
        var migrated = false;
        for (var tok in data) {
          var entry = data[tok];
          if (typeof entry === "string") {
            data[tok] = { userId: entry, issuedAt: now, expiresAt: now + TOKEN_TTL_MS };
            migrated = true;
          } else if (entry && typeof entry === "object" && !entry.expiresAt) {
            entry.expiresAt = (entry.issuedAt || now) + TOKEN_TTL_MS;
            migrated = true;
          }
        }
        multiUserTokens = data;
        if (migrated) saveTokens();
      }
    } catch (e) {
      multiUserTokens = {};
    }
  }

  function saveTokens() {
    // Async atomic write through store.js (queued per file, 0o600).
    store.writeJson(TOKENS_NAME, multiUserTokens).catch(function (err) {
      process.stderr.write("[server-auth] saveTokens failed: " + (err && err.message ? err.message : err) + "\n");
    });
  }

  loadTokens();

  // Secure whenever the browser reached us over https: the daemon terminates TLS itself, or a declared trusted proxy
  // (config.trustedProxy) reports a single "https" X-Forwarded-Proto. Plain http (localhost) stays cookie-compatible.
  function secureAttr(req) {
    var proto = resolveEffectiveProtocol({
      tlsOptions: tlsOptions,
      trustedProxy: ctx.trustedProxy,
      forwardedProtoHeader: req && req.headers ? req.headers["x-forwarded-proto"] : undefined,
    }).protocol;
    return proto === "https" ? "; Secure" : "";
  }

  function createMultiUserSession(userId, req) {
    var token = users.generateUserAuthToken(userId);
    var now = Date.now();
    multiUserTokens[token] = { userId: userId, issuedAt: now, expiresAt: now + TOKEN_TTL_MS };
    saveTokens();
    var cookie = MULTI_USER_COOKIE + "=" + token + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000" + secureAttr(req);
    return { token: token, cookie: cookie };
  }

  function getMultiUserFromReq(req) {
    var cookies = parseCookies(req);
    var token = cookies[MULTI_USER_COOKIE];
    if (!token) return null;
    var entry = multiUserTokens[token];
    if (!entry) return null;
    var userId = typeof entry === "object" ? entry.userId : entry;
    if (!userId) return null;
    // Reject expired tokens
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      delete multiUserTokens[token];
      saveTokens();
      return null;
    }
    var user = users.findUserById(userId);
    return user || null;
  }

  function isMultiUserAuthed(req) {
    return !!getMultiUserFromReq(req);
  }

  // --- WS upgrade ticket (lr-de5fcb) ---
  // The relay_auth_user session cookie is HttpOnly (unreadable by JS) and,
  // per MILLER's diagnosis (lr-de5fcb comment #1), a mobile browser does not
  // reliably attach a SameSite=Lax cookie to a script-initiated WebSocket
  // upgrade. A short-TTL, single-use ticket gives the client a non-cookie
  // credential it CAN read (returned as a JSON body from an authenticated
  // HTTP request, which mobile does attach the cookie to) and pass on the
  // upgrade via Sec-WebSocket-Protocol instead. The ticket is never the
  // session token itself — it is a fresh opaque value bound to a userId,
  // consumed on first use, so a leaked ticket has a small blast radius.
  var WS_TICKET_TTL_MS = 30 * 1000;
  var wsTickets = {}; // ticket -> { userId, expiresAt }

  function mintWsTicket(userId) {
    var ticket = crypto.randomBytes(24).toString("hex");
    wsTickets[ticket] = { userId: userId, expiresAt: Date.now() + WS_TICKET_TTL_MS };
    return ticket;
  }

  // Validates and consumes a ticket. Returns the bound user on success, or
  // null on missing/expired/already-used/unknown-user. Single-use: the
  // ticket is deleted unconditionally on first lookup, so a second call
  // with the same ticket always returns null — this bounds replay even
  // within the TTL window, not just after it.
  function consumeWsTicket(ticket) {
    if (!ticket) return null;
    var entry = wsTickets[ticket];
    if (!entry) return null;
    delete wsTickets[ticket]; // single-use regardless of outcome below
    if (Date.now() > entry.expiresAt) return null;
    var user = users.findUserById(entry.userId);
    return user || null;
  }

  // Periodic sweep so an unused, expired ticket doesn't linger in memory
  // forever for a client that fetched one and never opened the socket.
  var wsTicketSweepInterval = setInterval(function () {
    var now = Date.now();
    for (var t in wsTickets) {
      if (wsTickets[t].expiresAt < now) delete wsTickets[t];
    }
  }, WS_TICKET_TTL_MS);
  if (wsTicketSweepInterval.unref) wsTicketSweepInterval.unref();

  function revokeUserTokens(userId) {
    require("./private-session-revocation").notifyAccessChanged({ userId: userId, tokensRevoked: true });
    for (var ticket in wsTickets) {
      if (wsTickets[ticket].userId === userId) delete wsTickets[ticket];
    }
    var changed = false;
    for (var token in multiUserTokens) {
      var entry = multiUserTokens[token];
      var entryUserId = typeof entry === "object" ? entry.userId : entry;
      if (entryUserId === userId) {
        delete multiUserTokens[token];
        changed = true;
      }
    }
    if (changed) {
      saveTokens();
      audit.log("auth.token.revoke_all", {
        actorId: "system",
        target: userId,
      });
    }
  }

  // Log a user out everywhere: every stored session token and outstanding WS ticket is deleted,
  // a pending e-mail login code is dropped, then every live socket of the user is closed (the
  // access-change fan-out, see server.js). Sessions are server-side records, so deleting them is
  // the revocation; the returned promise settles once the token file on disk no longer holds them,
  // so callers answer only after the revocation survives a restart. In memory it is already final
  // when this returns (fail closed even if the write then rejects).
  // who = { actorId, actorName } - the audit line names who revoked whom; tokens are never logged.
  function revokeAllUserSessions(userId, who) {
    who = who || {};
    var removed = 0;
    for (var token in multiUserTokens) {
      var entry = multiUserTokens[token];
      var entryUserId = entry && typeof entry === "object" ? entry.userId : entry;
      if (entryUserId === userId) { delete multiUserTokens[token]; removed++; }
    }
    for (var ticket in wsTickets) {
      if (wsTickets[ticket].userId === userId) delete wsTickets[ticket];
    }
    var target = users.findUserById(userId);
    if (target && target.email && smtp && typeof smtp.discardOtp === "function") smtp.discardOtp(target.email);
    audit.log("auth.sessions.revoke", {
      actorId: who.actorId || "system",
      actorName: who.actorName || null,
      target: userId,
      metadata: { sessionsRemoved: removed, self: !!who.actorId && who.actorId === userId },
    });
    require("./private-session-revocation").notifyAccessChanged({ userId: userId, tokensRevoked: true });
    return store.writeJson(TOKENS_NAME, multiUserTokens);
  }

  // --- PIN rate limiting (per-instance state) ---
  var pinAttempts = {};

  // Per-username failure tracking with progressive backoff.
  // Backoff thresholds (cumulative failures): 1s, 5s, 30s, 5min, permanent lockout.
  var PIN_USER_BACKOFF_MS = [1000, 5000, 30000, 5 * 60 * 1000];
  var PIN_USER_PERMANENT_THRESHOLD = PIN_USER_BACKOFF_MS.length + 1;
  var pinAttemptsUser = {};
  var lockedUsers = new Set();

  function isUserLockedOut(username) {
    return lockedUsers.has(username);
  }

  function unlockUser(username) {
    lockedUsers.delete(username);
    delete pinAttemptsUser[username];
  }

  function getUserBackoffMs(username) {
    var entry = pinAttemptsUser[username];
    if (!entry) return 0;
    var idx = Math.min(entry.count - 1, PIN_USER_BACKOFF_MS.length - 1);
    return idx >= 0 ? PIN_USER_BACKOFF_MS[idx] : 0;
  }

  function checkPinRateLimit(ip) {
    var entry = pinAttempts[ip];
    if (!entry) return null;
    if (entry.count >= PIN_MAX_ATTEMPTS) {
      var elapsed = Date.now() - entry.lastAttempt;
      if (elapsed < PIN_LOCKOUT_MS) {
        return Math.ceil((PIN_LOCKOUT_MS - elapsed) / 1000);
      }
      delete pinAttempts[ip];
    }
    return null;
  }

  // Check both IP and username lockouts. Returns seconds to wait, or null if clear.
  function checkPinRateLimitWithUser(ip, username) {
    var ipResult = checkPinRateLimit(ip);
    if (ipResult !== null) return ipResult;
    if (username && isUserLockedOut(username)) {
      // Permanent lockout — signal with a large sentinel value (admin must unlock)
      return -1;
    }
    if (username) {
      var entry = pinAttemptsUser[username];
      if (entry && entry.count > 0) {
        var backoff = getUserBackoffMs(username);
        if (backoff > 0) {
          var elapsed = Date.now() - entry.lastAttempt;
          if (elapsed < backoff) return Math.ceil((backoff - elapsed) / 1000);
        }
      }
    }
    return null;
  }

  function recordPinFailure(ip) {
    if (!pinAttempts[ip]) pinAttempts[ip] = { count: 0, lastAttempt: 0 };
    pinAttempts[ip].count++;
    pinAttempts[ip].lastAttempt = Date.now();
  }

  function recordPinFailureWithUser(ip, username) {
    recordPinFailure(ip);
    if (username) {
      if (!pinAttemptsUser[username]) pinAttemptsUser[username] = { count: 0, lastAttempt: 0 };
      pinAttemptsUser[username].count++;
      pinAttemptsUser[username].lastAttempt = Date.now();
      if (pinAttemptsUser[username].count >= PIN_USER_PERMANENT_THRESHOLD) {
        lockedUsers.add(username);
      }
    }
  }

  function clearPinFailures(ip) {
    delete pinAttempts[ip];
  }

  function clearPinFailuresWithUser(ip, username) {
    clearPinFailures(ip);
    if (username) delete pinAttemptsUser[username];
  }

  // --- Admin password recovery (in-memory, one-time) ---
  var recovery = null;

  function setRecovery(urlPath, password) {
    recovery = { urlPath: urlPath, password: password };
  }

  function clearRecovery() {
    recovery = null;
  }

  function recoveryPageHtml() {
    return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<title>Admin Password Recovery</title>'
      + '<style>'
      + '*{margin:0;padding:0;box-sizing:border-box}'
      + 'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0a0a0a;color:#e5e5e5;display:flex;align-items:center;justify-content:center;min-height:100vh}'
      + '.card{background:#171717;border:1px solid #262626;border-radius:12px;padding:32px;width:100%;max-width:380px}'
      + 'h1{font-size:18px;font-weight:600;margin-bottom:4px}'
      + '.sub{font-size:13px;color:#737373;margin-bottom:24px}'
      + 'label{display:block;font-size:13px;color:#a3a3a3;margin-bottom:6px}'
      + 'input{width:100%;padding:10px 12px;background:#0a0a0a;border:1px solid #333;border-radius:8px;color:#e5e5e5;font-size:14px;outline:none;margin-bottom:16px}'
      + 'input:focus{border-color:#7c3aed}'
      + 'button{width:100%;padding:10px;background:#7c3aed;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer}'
      + 'button:hover{background:#6d28d9}'
      + 'button:disabled{opacity:.5;cursor:not-allowed}'
      + '.error{color:#ef4444;font-size:13px;margin-bottom:12px;display:none}'
      + '.success{text-align:center;color:#22c55e;font-size:15px}'
      + '.hidden{display:none}'
      + '</style></head><body>'
      + '<div class="card">'
      + '<div id="step-verify">'
      + '<h1>Admin Recovery</h1>'
      + '<p class="sub">Enter the recovery password shown in your terminal.</p>'
      + '<div id="err-verify" class="error"></div>'
      + '<label for="recovery-pw">Recovery password</label>'
      + '<input id="recovery-pw" type="text" autocomplete="off" spellcheck="false" autofocus>'
      + '<button id="btn-verify">Verify</button>'
      + '</div>'
      + '<div id="step-reset" class="hidden">'
      + '<h1>Reset Admin PIN</h1>'
      + '<p class="sub">Enter a new 6-digit PIN for the admin account.</p>'
      + '<div id="err-reset" class="error"></div>'
      + '<label for="new-pin">New PIN</label>'
      + '<input id="new-pin" type="password" maxlength="6" pattern="\\d{6}" inputmode="numeric" placeholder="6 digits">'
      + '<label for="confirm-pin">Confirm PIN</label>'
      + '<input id="confirm-pin" type="password" maxlength="6" pattern="\\d{6}" inputmode="numeric" placeholder="6 digits">'
      + '<button id="btn-reset">Reset PIN</button>'
      + '</div>'
      + '<div id="step-done" class="hidden">'
      + '<p class="success">PIN has been reset successfully. You can now log in with your new PIN.</p>'
      + '</div>'
      + '</div>'
      + '<script>'
      + 'var pw="";\n'
      + 'document.getElementById("btn-verify").onclick=function(){\n'
      + '  var el=document.getElementById("recovery-pw");\n'
      + '  pw=el.value.trim();\n'
      + '  if(!pw)return;\n'
      + '  this.disabled=true;\n'
      + '  fetch(location.pathname,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({step:"verify",password:pw})})\n'
      + '  .then(function(r){return r.json()}).then(function(d){\n'
      + '    if(d.ok){document.getElementById("step-verify").classList.add("hidden");document.getElementById("step-reset").classList.remove("hidden");document.getElementById("new-pin").focus()}\n'
      + '    else{var e=document.getElementById("err-verify");e.textContent=d.error||"Invalid password";e.style.display="block";document.getElementById("btn-verify").disabled=false}\n'
      + '  }).catch(function(){document.getElementById("btn-verify").disabled=false})\n'
      + '};\n'
      + 'document.getElementById("recovery-pw").addEventListener("keydown",function(e){if(e.key==="Enter")document.getElementById("btn-verify").click()});\n'
      + 'document.getElementById("btn-reset").onclick=function(){\n'
      + '  var pin=document.getElementById("new-pin").value;\n'
      + '  var confirm=document.getElementById("confirm-pin").value;\n'
      + '  var errEl=document.getElementById("err-reset");\n'
      + '  if(!/^\\d{6}$/.test(pin)){errEl.textContent="PIN must be exactly 6 digits";errEl.style.display="block";return}\n'
      + '  if(pin!==confirm){errEl.textContent="PINs do not match";errEl.style.display="block";return}\n'
      + '  this.disabled=true;errEl.style.display="none";\n'
      + '  fetch(location.pathname,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({step:"reset",password:pw,pin:pin})})\n'
      + '  .then(function(r){return r.json()}).then(function(d){\n'
      + '    if(d.ok){document.getElementById("step-reset").classList.add("hidden");document.getElementById("step-done").classList.remove("hidden")}\n'
      + '    else{errEl.textContent=d.error||"Failed";errEl.style.display="block";document.getElementById("btn-reset").disabled=false}\n'
      + '  }).catch(function(){document.getElementById("btn-reset").disabled=false})\n'
      + '};\n'
      + 'document.getElementById("confirm-pin").addEventListener("keydown",function(e){if(e.key==="Enter")document.getElementById("btn-reset").click()});\n'
      + '</script></body></html>';
  }

  // --- Auth page selection ---
  var adminSetupPage = pages.adminSetupPageHtml();
  var loginPage = pages.multiUserLoginPageHtml();
  var smtpLoginPage = pages.smtpLoginPageHtml();

  function getAuthPage() {
    if (!users.hasAdmin()) return adminSetupPage;
    if (smtp.isEmailLoginEnabled()) return smtpLoginPage;
    return loginPage;
  }

  function isRequestAuthed(req) {
    return isMultiUserAuthed(req);
  }

  // --- Route handler ---

  function handleRequest(req, res, fullUrl) {
    // Admin password recovery
    if (recovery && fullUrl === "/recover/" + recovery.urlPath) {
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(recoveryPageHtml());
        return true;
      }
      if (req.method === "POST") {
        var ip = clientIp(req);
        var remaining = checkPinRateLimit(ip);
        if (remaining !== null) {
          res.writeHead(429, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, locked: true, retryAfter: remaining }));
          return true;
        }
        readCappedBody(req).then(function (body) {
          try {
            var data = JSON.parse(body);
            if (data.step === "verify") {
              if (!data.password || !safeEqual(data.password, recovery.password)) {
                recordPinFailure(ip);
                res.writeHead(401, { "Content-Type": "application/json" });
                res.end('{"error":"Invalid recovery password"}');
                return;
              }
              clearPinFailures(ip);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end('{"ok":true}');
            } else if (data.step === "reset") {
              if (!data.password || !safeEqual(data.password, recovery.password)) {
                res.writeHead(401, { "Content-Type": "application/json" });
                res.end('{"error":"Invalid recovery password"}');
                return;
              }
              if (!data.pin || !/^\d{6}$/.test(data.pin)) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end('{"error":"PIN must be exactly 6 digits"}');
                return;
              }
              var admin = users.findAdmin();
              if (!admin) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end('{"error":"No admin account found"}');
                return;
              }
              users.updateUserPin(admin.id, data.pin);
              recovery = null;
              // The PIN was lost or compromised: every session, WS ticket and live socket of the admin ends, and the
              // answer waits until the revocation is on disk.
              revokeAllUserSessions(admin.id, { actorId: "system", actorName: "pin-recovery" }).then(function () {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end('{"ok":true}');
              }, function () {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end('{"error":"Sessions could not be revoked"}');
              });
            } else {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end('{"error":"Invalid step"}');
            }
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end('{"error":"Invalid request"}');
          }
        }).catch(function () {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end('{"error":"Request body too large"}');
        });
        return true;
      }
    }

    // Admin setup (first-time multi-user setup)
    if (req.method === "POST" && fullUrl === "/auth/setup") {
      if (users.hasAdmin()) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end('{"error":"Admin already exists"}');
        return true;
      }
      readCappedBody(req).then(function (body) {
        try {
          var data = JSON.parse(body);
          if (!users.validateSetupCode(data.setupCode)) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end('{"error":"Invalid setup code"}');
            return;
          }
          if (!data.username || data.username.trim().length < 1 || data.username.length > 100) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end('{"error":"Username is required"}');
            return;
          }
          if (!data.pin || !/^\d{6}$/.test(data.pin)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end('{"error":"PIN must be exactly 6 digits"}');
            return;
          }
          // Migrate existing profile.json to admin profile
          var adminProfile = undefined;
          try {
            var existingProfile = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, "profile.json"), "utf8"));
            adminProfile = {
              name: data.displayName || data.username,
              lang: existingProfile.lang || "en-US",
              avatarColor: existingProfile.avatarColor || "#7c3aed",
              avatarStyle: existingProfile.avatarStyle || "thumbs",
              avatarSeed: existingProfile.avatarSeed || crypto.randomBytes(4).toString("hex"),
            };
          } catch (e) {}
          var result = users.createAdmin({
            username: data.username.trim(),
            displayName: data.displayName || data.username.trim(),
            pin: data.pin,
            profile: adminProfile,
          });
          if (result.error) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: result.error }));
            return;
          }
          // Auto-provision Linux account if OS users mode is enabled
          if (osUsers && !result.user.linuxUser) {
            var provision = provisionLinuxUser(result.user.username);
            if (provision.ok) {
              users.updateLinuxUser(result.user.id, provision.linuxUser);
              if (onUserProvisioned) onUserProvisioned(result.user.id, provision.linuxUser);
            }
          }
          users.clearSetupCode();
          var session = createMultiUserSession(result.user.id, req);
          res.writeHead(200, {
            "Set-Cookie": session.cookie,
            "Content-Type": "application/json",
          });
          res.end(JSON.stringify({ ok: true, user: { id: result.user.id, username: result.user.username, role: result.user.role } }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"Invalid request"}');
        }
      }).catch(function () {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end('{"error":"Request body too large"}');
      });
      return true;
    }

    // Multi-user login
    if (req.method === "POST" && fullUrl === "/auth/login") {
      var ip = clientIp(req);
      // IP-only pre-check (username not yet known — body not read)
      var remaining = checkPinRateLimit(ip);
      if (remaining !== null) {
        audit.log("auth.lockout", {
          metadata: { ip: ip, retryAfterSeconds: remaining },
        });
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, locked: true, retryAfter: remaining }));
        return true;
      }
      readCappedBody(req).then(function (body) {
        try {
          var data = JSON.parse(body);
          var username = data.username || null;
          // Per-username lockout check (after body is available)
          var userRemaining = checkPinRateLimitWithUser(ip, username);
          if (userRemaining !== null) {
            res.writeHead(429, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, locked: true, retryAfter: userRemaining }));
            return;
          }
          var user = users.authenticateUser(username, data.pin);
          if (!user) {
            recordPinFailureWithUser(ip, username);
            var attemptsLeft = PIN_MAX_ATTEMPTS - (pinAttempts[ip] ? pinAttempts[ip].count : 0);
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Invalid username or PIN", attemptsLeft: Math.max(attemptsLeft, 0) }));
            return;
          }
          clearPinFailuresWithUser(ip, user.username);
          var session = createMultiUserSession(user.id, req);
          var loginResp = { ok: true, user: { id: user.id, username: user.username, role: user.role } };
          if (user.mustChangePin) loginResp.mustChangePin = true;
          res.writeHead(200, {
            "Set-Cookie": session.cookie,
            "Content-Type": "application/json",
          });
          res.end(JSON.stringify(loginResp));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"Invalid request"}');
        }
      }).catch(function () {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end('{"error":"Request body too large"}');
      });
      return true;
    }

    // Request OTP code (SMTP login)
    if (req.method === "POST" && fullUrl === "/auth/request-otp") {
      if (!smtp.isEmailLoginEnabled()) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end('{"error":"OTP login not available"}');
        return true;
      }
      var ip = clientIp(req);
      var remaining = checkPinRateLimit(ip);
      if (remaining !== null) {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, locked: true, retryAfter: remaining }));
        return true;
      }
      readCappedBody(req).then(function (body) {
        try {
          var data = JSON.parse(body);
          if (!data.email) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end('{"error":"Email is required"}');
            return;
          }
          var user = users.findUserByEmail(data.email);
          if (!user) {
            // Don't reveal whether user exists
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end('{"ok":true}');
            return;
          }
          var result = smtp.requestOtp(data.email);
          if (result.error) {
            res.writeHead(429, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: result.error }));
            return;
          }
          smtp.sendOtpEmail(data.email, result.code).then(function () {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end('{"ok":true}');
          }).catch(function () {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end('{"error":"Failed to send email"}');
          });
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"Invalid request"}');
        }
      }).catch(function () {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end('{"error":"Request body too large"}');
      });
      return true;
    }

    // Verify OTP code (SMTP login)
    if (req.method === "POST" && fullUrl === "/auth/verify-otp") {
      if (!smtp.isEmailLoginEnabled()) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end('{"error":"OTP login not available"}');
        return true;
      }
      var ip = clientIp(req);
      var remaining = checkPinRateLimit(ip);
      if (remaining !== null) {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, locked: true, retryAfter: remaining }));
        return true;
      }
      readCappedBody(req).then(function (body) {
        try {
          var data = JSON.parse(body);
          if (!data.email || !data.code) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end('{"error":"Email and code are required"}');
            return;
          }
          var otpResult = smtp.verifyOtp(data.email, data.code);
          if (!otpResult.valid) {
            recordPinFailure(ip);
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: otpResult.error, attemptsLeft: otpResult.attemptsLeft }));
            return;
          }
          var user = users.findUserByEmail(data.email);
          if (!user) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end('{"ok":false,"error":"Account not found"}');
            return;
          }
          clearPinFailures(ip);
          var session = createMultiUserSession(user.id, req);
          res.writeHead(200, {
            "Set-Cookie": session.cookie,
            "Content-Type": "application/json",
          });
          res.end(JSON.stringify({ ok: true, user: { id: user.id, username: user.username, role: user.role } }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"Invalid request"}');
        }
      }).catch(function () {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end('{"error":"Request body too large"}');
      });
      return true;
    }

    // Invite sign-up. The invitee picks a nickname, a login ID and a 6-digit PIN; the
    // invite is single-use and the resulting HttpOnly cookie is the device login.
    // Invalid-invite attempts share the login IP lockout so codes cannot be guessed.
    if (req.method === "POST" && fullUrl === "/auth/register") {
      var regKey = "invite:" + clientIp(req);
      var regRemaining = checkPinRateLimit(regKey);
      if (regRemaining !== null) {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, locked: true, retryAfter: regRemaining, error: "시도 횟수를 초과했습니다. 잠시 후 다시 시도하세요." }));
        return true;
      }
      readCappedBody(req).then(function (body) {
        try {
          var data = JSON.parse(body);
          var result = users.redeemInvite(data.inviteCode, data.displayName, { username: data.username, pin: data.pin });
          if (result.error) {
            if (result.invalidInvite) recordPinFailure(regKey);
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: result.invalidInvite ? "사용할 수 없는 초대 링크입니다" : result.error }));
            return;
          }
          clearPinFailures(regKey);
          var session = createMultiUserSession(result.user.id, req);
          audit.log("auth.invite.redeem", {
            actorId: result.user.id,
            actorName: result.user.displayName,
            target: result.roomId || "workspace",
          });
          res.writeHead(200, {
            "Set-Cookie": session.cookie,
            "Content-Type": "application/json",
          });
          res.end(JSON.stringify({ ok: true, user: { id: result.user.id, displayName: result.user.displayName, role: result.user.role }, roomId: result.roomId }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"Invalid request"}');
        }
      }).catch(function () {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end('{"error":"Request body too large"}');
      });
      return true;
    }

    // Logout
    if (req.method === "POST" && fullUrl === "/auth/logout") {
      var cookies = parseCookies(req);
      var token = cookies[MULTI_USER_COOKIE];
      if (token && multiUserTokens[token]) {
        delete multiUserTokens[token];
        saveTokens();
      }
      res.writeHead(200, {
        "Set-Cookie": MULTI_USER_COOKIE + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" + secureAttr(req),
        "Content-Type": "application/json",
      });
      res.end('{"ok":true}');
      return true;
    }

    // Log out of every device: the caller's own sessions, tokens and sockets, this one included.
    if (req.method === "POST" && fullUrl === "/auth/logout-all") {
      var laUser = getMultiUserFromReq(req);
      if (!laUser) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end('{"error":"unauthorized"}');
        return true;
      }
      if (!req.headers["x-requested-with"]) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":"forbidden"}');
        return true;
      }
      revokeAllUserSessions(laUser.id, { actorId: laUser.id, actorName: laUser.username }).then(function () {
        res.writeHead(200, {
          "Set-Cookie": MULTI_USER_COOKIE + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" + secureAttr(req),
          "Content-Type": "application/json",
        });
        res.end('{"ok":true}');
      }, function () {
        // Revoked in memory but not yet on disk: say so, so the caller retries until it is.
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end('{"error":"persist_failed"}');
      });
      return true;
    }

    // Invite page (magic link)
    if (req.method === "GET" && fullUrl.indexOf("/invite/") === 0) {
      var inviteCode = fullUrl.substring("/invite/".length);
      var validation = users.validateInvite(inviteCode);
      if (!validation.valid) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(pages.inviteInvalidPageHtml(validation.error));
        return true;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(pages.invitePageHtml(inviteCode));
      return true;
    }

    return false;
  }

  return {
    handleRequest: handleRequest,
    getMultiUserFromReq: getMultiUserFromReq,
    isRequestAuthed: isRequestAuthed,
    parseCookies: parseCookies,
    revokeUserTokens: revokeUserTokens,
    revokeAllUserSessions: revokeAllUserSessions,
    setRecovery: setRecovery,
    clearRecovery: clearRecovery,
    getAuthPage: getAuthPage,
    createMultiUserSession: createMultiUserSession,
    isUserLockedOut: isUserLockedOut,
    checkPinRateLimit: checkPinRateLimit,
    recordPinFailure: recordPinFailure,
    clearPinFailures: clearPinFailures,
    unlockUser: unlockUser,
    mintWsTicket: mintWsTicket,
    consumeWsTicket: consumeWsTicket,
  };
}

module.exports = { attachAuth: attachAuth };

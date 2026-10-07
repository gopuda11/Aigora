module.exports = require("./extensions").select("server-admin", function () {
var module = { exports: {} };
// Admin API endpoints (multi-user mode only)
// Extracted from server.js

var audit = require("./audit");

function attachAdmin(ctx) {
  var users = ctx.users;
  var smtp = ctx.smtp;
  var getMultiUserFromReq = ctx.getMultiUserFromReq;
  var projects = ctx.projects;
  var osUsers = ctx.osUsers;
  var tlsOptions = ctx.tlsOptions;
  var portNum = ctx.portNum;
  var provisionLinuxUser = ctx.provisionLinuxUser;
  var onUserProvisioned = ctx.onUserProvisioned;
  var onUserDeleted = ctx.onUserDeleted;
  var revokeUserTokens = ctx.revokeUserTokens;
  var revokeAllUserSessions = ctx.revokeAllUserSessions;
  var onSetProjectVisibility = ctx.onSetProjectVisibility;
  var onSetProjectAllowedUsers = ctx.onSetProjectAllowedUsers;
  var onGetProjectAccess = ctx.onGetProjectAccess;
  var onProjectOwnerChanged = ctx.onProjectOwnerChanged;

  function handleRequest(req, res, fullUrl) {

    // --- Admin API endpoints (multi-user mode only) ---

    // List all users (admin only)
    if (req.method === "GET" && fullUrl === "/api/admin/users") {
      var mu = getMultiUserFromReq(req);
      if (!mu) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end('{"error":"Authentication required"}');
        return true;
      }
      // Admins get the full user list; everyone else only people sharing a room with them,
      // by id and display name (the username is a login credential).
      if (mu.role === "admin") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ users: users.getAllUsers() }));
      } else {
        var visible = users.getVisibleUserIds(mu.id) || {};
        var safeUsers = users.getAllUsers().filter(function (u) { return visible[u.id]; }).map(function (u) {
          return { id: u.id, displayName: (u.profile && u.profile.name) || u.displayName || "Member" };
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ users: safeUsers }));
      }
      return true;
    }

    // Remove user (admin only)
    if (req.method === "DELETE" && fullUrl.indexOf("/api/admin/users/") === 0) {
      var mu = getMultiUserFromReq(req);
      if (!mu || mu.role !== "admin") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":"Admin access required"}');
        return true;
      }
      var targetUserId = fullUrl.substring("/api/admin/users/".length);
      if (targetUserId === mu.id) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end('{"error":"Cannot remove yourself"}');
        return true;
      }
      // Look up the user before deletion to get linuxUser for deactivation
      var targetUser = users.findUserById(targetUserId);
      var targetLinuxUser = targetUser ? targetUser.linuxUser : null;
      var result = users.removeUser(targetUserId);
      if (result.error) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: result.error }));
        return true;
      }
      // Remove auth tokens for deleted user
      revokeUserTokens(targetUserId);
      // Deactivate the Linux account if applicable
      if (onUserDeleted && targetLinuxUser) {
        onUserDeleted(targetUserId, targetLinuxUser);
      }
      audit.log("user.delete", {
        actorId: mu.id,
        actorName: mu.username,
        target: targetUserId,
        metadata: targetUser ? { username: targetUser.username, role: targetUser.role } : null,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
      return true;
    }

    // Create user (admin only) — generates a temporary PIN that must be changed on first login
    if (req.method === "POST" && fullUrl === "/api/admin/users") {
      var mu = getMultiUserFromReq(req);
      if (!mu || mu.role !== "admin") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":"Admin access required"}');
        return true;
      }
      var body = "";
      req.on("data", function (chunk) { body += chunk; });
      req.on("end", function () {
        try {
          var data = JSON.parse(body);
          if (!data.username || typeof data.username !== "string" || data.username.trim().length < 1) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end('{"error":"Username is required"}');
            return;
          }
          var result = users.createUserByAdmin({
            username: data.username.trim(),
            displayName: data.displayName ? data.displayName.trim() : data.username.trim(),
            email: data.email ? data.email.trim() : null,
            role: data.role === "admin" ? "admin" : "user",
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
          audit.log("user.create", {
            actorId: mu.id,
            actorName: mu.username,
            target: result.user.id,
            metadata: { username: result.user.username, role: result.user.role },
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            ok: true,
            user: {
              id: result.user.id,
              username: result.user.username,
              displayName: result.user.displayName,
              role: result.user.role,
            },
            tempPin: result.tempPin,
          }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"Invalid request"}');
        }
      });
      return true;
    }

    // Force a user to log out everywhere (admin only; an admin uses POST /auth/logout-all for themselves)
    if (req.method === "POST" && fullUrl.match(/^\/api\/admin\/users\/[^/]+\/force-logout$/)) {
      var mu = getMultiUserFromReq(req);
      if (!mu) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end('{"error":"Authentication required"}');
        return true;
      }
      if (mu.role !== "admin") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":"Admin access required"}');
        return true;
      }
      if (!req.headers["x-requested-with"]) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":"forbidden"}');
        return true;
      }
      var forceTargetId;
      try { forceTargetId = decodeURIComponent(fullUrl.split("/")[4]); } catch (e) { forceTargetId = ""; }
      if (forceTargetId === mu.id) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end('{"error":"Cannot force log out yourself"}');
        return true;
      }
      if (!forceTargetId || !users.findUserById(forceTargetId)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end('{"error":"User not found"}');
        return true;
      }
      revokeAllUserSessions(forceTargetId, { actorId: mu.id, actorName: mu.username }).then(function () {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      }, function () {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end('{"error":"persist_failed"}');
      });
      return true;
    }

    // Reset user PIN (admin only) — generates a new temp PIN
    if (req.method === "POST" && fullUrl.match(/^\/api\/admin\/users\/[^/]+\/reset-pin$/)) {
      var mu = getMultiUserFromReq(req);
      if (!mu || mu.role !== "admin") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":"Admin access required"}');
        return true;
      }
      var urlParts = fullUrl.split("/");
      var targetUserId = urlParts[4]; // /api/admin/users/{userId}/reset-pin
      var targetUser = users.findUserById(targetUserId);
      if (!targetUser) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end('{"error":"User not found"}');
        return true;
      }
      var newPin = users.generatePin();
      var pinResult = users.updateUserPin(targetUserId, newPin);
      if (pinResult.error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: pinResult.error }));
        return true;
      }
      // Mark as must change on next login
      var data = users.loadUsers();
      for (var i = 0; i < data.users.length; i++) {
        if (data.users[i].id === targetUserId) {
          data.users[i].mustChangePin = true;
          users.saveUsers(data);
          break;
        }
      }
      audit.log("user.pin.reset", {
        actorId: mu.id,
        actorName: mu.username,
        target: targetUserId,
        metadata: { username: targetUser.username },
      });
      // The old PIN may be the compromise: end every session, WS ticket and live socket of the user, and answer
      // (with the temporary PIN) only once the revocation is persisted.
      revokeAllUserSessions(targetUserId, { actorId: mu.id, actorName: mu.username }).then(function () {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, tempPin: newPin }));
      }, function () {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end('{"error":"Sessions could not be revoked"}');
      });
      return true;
    }

    // Set Linux user mapping (admin only, OS-level multi-user)
    if (req.method === "PUT" && fullUrl.match(/^\/api\/admin\/users\/[^/]+\/linux-user$/)) {
      var mu = getMultiUserFromReq(req);
      if (!mu || mu.role !== "admin") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":"Admin access required"}');
        return true;
      }
      var urlParts = fullUrl.split("/");
      var targetUserId = urlParts[4]; // /api/admin/users/{userId}/linux-user
      var body = "";
      req.on("data", function(chunk) { body += chunk; });
      req.on("end", function() {
        try {
          var parsed = JSON.parse(body);
          var result = users.updateLinuxUser(targetUserId, parsed.linuxUser || null);
          if (result.error) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: result.error }));
          } else {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end('{"ok":true}');
          }
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"Invalid request body"}');
        }
      });
      return true;
    }

    // Update user permissions (admin only)
    if (req.method === "PUT" && fullUrl.match(/^\/api\/admin\/users\/[^/]+\/permissions$/)) {
      var mu = getMultiUserFromReq(req);
      if (!mu || mu.role !== "admin") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":"Admin access required"}');
        return true;
      }
      var urlParts = fullUrl.split("/");
      var targetUserId = urlParts[4]; // /api/admin/users/{userId}/permissions
      var body = "";
      req.on("data", function(chunk) { body += chunk; });
      req.on("end", function() {
        try {
          var parsed = JSON.parse(body);
          var result = users.updateUserPermissions(targetUserId, parsed.permissions || {});
          if (result.error) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: result.error }));
          } else {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, permissions: result.permissions }));
          }
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"Invalid request body"}');
        }
      });
      return true;
    }

    // List rooms visible to the current member.
    if (req.method === "GET" && fullUrl === "/api/rooms") {
      var mu = getMultiUserFromReq(req);
      if (!mu) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end('{"error":"Authentication required"}');
        return true;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ rooms: users.getRoomsForUser(mu.id) }));
      return true;
    }

    // Create a room (workspace owner only).
    if (req.method === "POST" && fullUrl === "/api/admin/rooms") {
      var mu = getMultiUserFromReq(req);
      if (!mu || mu.role !== "admin") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":"Admin access required"}');
        return true;
      }
      var body = "";
      req.on("data", function (chunk) { body += chunk; });
      req.on("end", function () {
        try {
          var parsed = JSON.parse(body || "{}");
          var result = users.createRoom(mu.id, parsed.name, parsed.description);
          if (!result.error) audit.log("room.create", { actorId: mu.id, actorName: mu.username, target: result.room.id });
          res.writeHead(result.error ? 400 : 200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"Invalid request"}');
        }
      });
      return true;
    }

    // List archived rooms (admin only); they never appear in /api/rooms.
    if (req.method === "GET" && fullUrl === "/api/admin/rooms/archived") {
      var mu = getMultiUserFromReq(req);
      if (!mu || mu.role !== "admin") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":"Admin access required"}');
        return true;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(users.getArchivedRooms(mu.id)));
      return true;
    }

    // Archive or restore a room (admin only).
    if (req.method === "POST" && /^\/api\/admin\/rooms\/[^/]+\/(archive|restore)$/.test(fullUrl)) {
      var mu = getMultiUserFromReq(req);
      if (!mu || mu.role !== "admin") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":"Admin access required"}');
        return true;
      }
      var archiveParts = fullUrl.split("/");
      var archiveRoomId = decodeURIComponent(archiveParts[4]);
      var archiving = archiveParts[5] === "archive";
      var result = users.setRoomArchived(mu.id, archiveRoomId, archiving);
      if (!result.error) audit.log(archiving ? "room.archive" : "room.restore", { actorId: mu.id, actorName: mu.username, target: archiveRoomId });
      res.writeHead(result.error ? (result.error === "Room not found" ? 404 : 400) : 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return true;
    }

    // Permanently delete an archived room (admin only). Body: { confirmName }.
    if (req.method === "DELETE" && /^\/api\/admin\/rooms\/[^/]+$/.test(fullUrl)) {
      var mu = getMultiUserFromReq(req);
      if (!mu || mu.role !== "admin") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":"Admin access required"}');
        return true;
      }
      var deleteRoomId = decodeURIComponent(fullUrl.split("/")[4]);
      var deleteBody = "";
      req.on("data", function (chunk) { deleteBody += chunk; });
      req.on("end", function () {
        var parsed;
        try { parsed = JSON.parse(deleteBody || "{}"); }
        catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"Invalid request"}');
          return;
        }
        require("./room-deletion").deleteRoomPermanently({
          users: users, actorId: mu.id, roomId: deleteRoomId, confirmName: parsed && parsed.confirmName, projects: projects,
        }).then(function (result) {
          if (result.ok || result.failures) {
            audit.log("room.purge", { actorId: mu.id, actorName: mu.username, target: deleteRoomId, counts: result.counts, backup: result.backup, partial: !result.ok, failures: result.failures });
          }
          res.writeHead(result.ok ? 200 : result.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result.ok ? { ok: true, counts: result.counts, backup: result.backup } : { error: result.error, failures: result.failures, backup: result.backup }));
        }, function () {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end('{"error":"Room deletion failed"}');
        });
      });
      return true;
    }

    // Room details and member list (owner only).
    if (req.method === "GET" && /^\/api\/admin\/rooms\/[^/]+\/members$/.test(fullUrl)) {
      var mu = getMultiUserFromReq(req);
      if (!mu || mu.role !== "admin") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":"Admin access required"}');
        return true;
      }
      var memberRoomId = decodeURIComponent(fullUrl.split("/")[4]);
      var memberResult = users.getRoomMembers(mu.id, memberRoomId);
      res.writeHead(memberResult.error ? 403 : 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(memberResult));
      return true;
    }

    // Tool-approval level of a room's contained AI turns (admin only). PUT body: { level, requesterCanApprove, askPatterns }.
    if ((req.method === "GET" || req.method === "PUT") && /^\/api\/admin\/rooms\/[^/]+\/approval$/.test(fullUrl)) {
      var mu = getMultiUserFromReq(req);
      if (!mu || mu.role !== "admin") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":"Admin access required"}');
        return true;
      }
      var approvalRoomId = decodeURIComponent(fullUrl.split("/")[4]);
      if (!users.findRoomById(approvalRoomId)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end('{"error":"Room not found"}');
        return true;
      }
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, approval: users.roomApproval(approvalRoomId) }));
        return true;
      }
      var approvalBody = "";
      req.on("data", function (chunk) { approvalBody += chunk; });
      req.on("end", function () {
        try {
          var result = users.setRoomApproval(mu.id, approvalRoomId, JSON.parse(approvalBody || "{}"));
          if (!result.error) audit.log("room.approval.set", { actorId: mu.id, actorName: mu.username, target: approvalRoomId, metadata: result.approval });
          res.writeHead(result.error ? 400 : 200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"Invalid request"}');
        }
      });
      return true;
    }

    // Who may manage a room's skills (admin only). PUT body: { skillManagers: "admins" | "members" }.
    if ((req.method === "GET" || req.method === "PUT") && /^\/api\/admin\/rooms\/[^/]+\/skill-managers$/.test(fullUrl)) {
      var smu = getMultiUserFromReq(req);
      if (!smu || smu.role !== "admin") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":"Admin access required"}');
        return true;
      }
      var smRoomId = decodeURIComponent(fullUrl.split("/")[4]);
      if (!users.findRoomById(smRoomId)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end('{"error":"Room not found"}');
        return true;
      }
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, skillManagers: users.roomSkillManagers(smRoomId) }));
        return true;
      }
      var smBody = "";
      req.on("data", function (chunk) { smBody += chunk; });
      req.on("end", function () {
        try {
          var smResult = users.setRoomSkillManagers(smu.id, smRoomId, (JSON.parse(smBody || "{}") || {}).skillManagers);
          if (!smResult.error) audit.log("room.skill_managers.set", { actorId: smu.id, actorName: smu.username, target: smRoomId, metadata: { skillManagers: smResult.skillManagers } });
          res.writeHead(smResult.error ? 400 : 200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(smResult));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"Invalid request"}');
        }
      });
      return true;
    }

    // Create a single-use invitation bound to one room.
    if (req.method === "POST" && /^\/api\/admin\/rooms\/[^/]+\/invites$/.test(fullUrl)) {
      var mu = getMultiUserFromReq(req);
      if (!mu || mu.role !== "admin") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":"Admin access required"}');
        return true;
      }
      var roomId = decodeURIComponent(fullUrl.split("/")[4]);
      var invite = users.createInvite(mu.id, null, { roomId: roomId });
      if (invite.error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: invite.error }));
        return true;
      }
      var proto = tlsOptions ? "https" : "http";
      var host = req.headers.host || ("localhost:" + portNum);
      audit.log("room.invite.create", { actorId: mu.id, actorName: mu.username, target: roomId, metadata: { inviteId: invite.id } });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, invite: invite, url: proto + "://" + host + "/invite/" + invite.code }));
      return true;
    }

    // Remove a member from exactly one room. Their other room memberships and
    // identity stay intact; session authorization changes immediately.
    if (req.method === "DELETE" && /^\/api\/admin\/rooms\/[^/]+\/members\/[^/]+$/.test(fullUrl)) {
      var mu = getMultiUserFromReq(req);
      if (!mu || mu.role !== "admin") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":"Admin access required"}');
        return true;
      }
      var parts = fullUrl.split("/");
      var result = users.removeRoomMember(mu.id, decodeURIComponent(parts[4]), decodeURIComponent(parts[6]));
      if (!result.error) audit.log("room.member.remove", { actorId: mu.id, actorName: mu.username, target: decodeURIComponent(parts[6]), metadata: { roomId: decodeURIComponent(parts[4]) } });
      res.writeHead(result.error ? 400 : 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return true;
    }

    // Change one member's role in exactly one room (member <-> viewer). The
    // owner is immutable; users.updateRoomMemberRole re-checks ownership.
    if (req.method === "PATCH" && /^\/api\/admin\/rooms\/[^/]+\/members\/[^/]+$/.test(fullUrl)) {
      var mu = getMultiUserFromReq(req);
      if (!mu || mu.role !== "admin") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":"Admin access required"}');
        return true;
      }
      var roleParts = fullUrl.split("/");
      var roleRoomId = decodeURIComponent(roleParts[4]);
      var roleUserId = decodeURIComponent(roleParts[6]);
      var roleBody = "";
      req.on("data", function (chunk) { roleBody += chunk; });
      req.on("end", function () {
        var parsed;
        try { parsed = JSON.parse(roleBody || "{}"); }
        catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"Invalid request"}');
          return;
        }
        var result = users.updateRoomMemberRole(mu.id, roleRoomId, roleUserId, parsed && parsed.role);
        if (!result.error) audit.log("room.member.role", { actorId: mu.id, actorName: mu.username, target: roleUserId, metadata: { roomId: roleRoomId, role: parsed.role } });
        res.writeHead(result.error ? 400 : 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      });
      return true;
    }

    // Create invite (admin only)
    if (req.method === "POST" && fullUrl === "/api/admin/invites") {
      var mu = getMultiUserFromReq(req);
      if (!mu || mu.role !== "admin") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":"Admin access required"}');
        return true;
      }
      var invite = users.createInvite(mu.id);
      if (invite.error) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: invite.error }));
        return true;
      }
      var proto = tlsOptions ? "https" : "http";
      var host = req.headers.host || ("localhost:" + portNum);
      var inviteUrl = proto + "://" + host + "/invite/" + invite.code;
      audit.log("auth.invite.create", {
        actorId: mu.id,
        actorName: mu.username,
        target: invite.id,
        metadata: { expiresAt: invite.expiresAt },
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, invite: invite, url: inviteUrl }));
      return true;
    }

    // List invites (admin only)
    if (req.method === "GET" && fullUrl === "/api/admin/invites") {
      var mu = getMultiUserFromReq(req);
      if (!mu || mu.role !== "admin") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":"Admin access required"}');
        return true;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ invites: users.getInvites() }));
      return true;
    }

    // Delete an invite record (admin only); a live code is revoked first
    if (req.method === "DELETE" && /^\/api\/admin\/invites\/[^/]+\/record$/.test(fullUrl)) {
      var mu = getMultiUserFromReq(req);
      if (!mu || mu.role !== "admin") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":"Admin access required"}');
        return true;
      }
      var delId = decodeURIComponent(fullUrl.split("/")[4]);
      var delResult = users.deleteInvite(delId);
      if (delResult.error) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: delResult.error }));
        return true;
      }
      audit.log("auth.invite.delete", {
        actorId: mu.id,
        actorName: mu.username,
        target: delId,
        metadata: { revokedFirst: delResult.wasLive },
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
      return true;
    }

    // Revoke invite (admin only)
    if (req.method === "DELETE" && fullUrl.indexOf("/api/admin/invites/") === 0) {
      var mu = getMultiUserFromReq(req);
      if (!mu || mu.role !== "admin") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":"Admin access required"}');
        return true;
      }
      var inviteCode = decodeURIComponent(fullUrl.replace("/api/admin/invites/", ""));
      if (!inviteCode) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end('{"error":"Invite code is required"}');
        return true;
      }
      var result = users.revokeInvite(inviteCode);
      if (result.error) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: result.error }));
        return true;
      }
      audit.log("auth.invite.revoke", {
        actorId: mu.id,
        actorName: mu.username,
        target: inviteCode,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
      return true;
    }

    // Send invite via email (admin only)
    if (req.method === "POST" && fullUrl === "/api/admin/invites/email") {
      if (!smtp.isSmtpConfigured()) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end('{"error":"SMTP not configured"}');
        return true;
      }
      var mu = getMultiUserFromReq(req);
      if (!mu || mu.role !== "admin") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":"Admin access required"}');
        return true;
      }
      var body = "";
      req.on("data", function (chunk) { body += chunk; });
      req.on("end", function () {
        try {
          var data = JSON.parse(body);
          if (!data.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end('{"error":"Valid email is required"}');
            return;
          }
          var invite = users.createInvite(mu.id, data.email);
          if (invite.error) {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: invite.error }));
            return;
          }
          var proto = tlsOptions ? "https" : "http";
          var host = req.headers.host || ("localhost:" + portNum);
          var inviteUrl = proto + "://" + host + "/invite/" + invite.code;
          smtp.sendInviteEmail(data.email, inviteUrl, mu.displayName || mu.username).then(function () {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, invite: invite, url: inviteUrl }));
          }).catch(function (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Failed to send email: " + (err.message || "unknown error") }));
          });
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"Invalid request"}');
        }
      });
      return true;
    }



    // Get SMTP config (admin only)
    if (req.method === "GET" && fullUrl === "/api/admin/smtp") {
      var mu = getMultiUserFromReq(req);
      if (!mu || mu.role !== "admin") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":"Admin access required"}');
        return true;
      }
      var cfg = smtp.getSmtpConfig();
      if (cfg) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ smtp: { host: cfg.host, port: cfg.port, secure: cfg.secure, user: cfg.user, pass: "••••••••", from: cfg.from, emailLoginEnabled: !!cfg.emailLoginEnabled } }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"smtp":null}');
      }
      return true;
    }

    // Save SMTP config (admin only)
    if (req.method === "POST" && fullUrl === "/api/admin/smtp") {
      var mu = getMultiUserFromReq(req);
      if (!mu || mu.role !== "admin") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":"Admin access required"}');
        return true;
      }
      var body = "";
      req.on("data", function (chunk) { body += chunk; });
      req.on("end", function () {
        try {
          var data = JSON.parse(body);
          // Allow clearing SMTP config by sending empty fields
          if (!data.host && !data.user && !data.pass && !data.from) {
            smtp.saveSmtpConfig(null);
            audit.log("settings.smtp.update", {
              actorId: mu.id,
              actorName: mu.username,
              metadata: { cleared: true },
            });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end('{"ok":true}');
            return;
          }
          if (!data.host || !data.user || !data.pass || !data.from) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end('{"error":"Host, user, password, and from address are required"}');
            return;
          }
          // If password is masked, keep existing
          var existingCfg = smtp.getSmtpConfig();
          var pass = data.pass;
          if (pass === "••••••••" && existingCfg) {
            pass = existingCfg.pass;
          }
          smtp.saveSmtpConfig({
            host: data.host,
            port: parseInt(data.port, 10) || 587,
            secure: !!data.secure,
            user: data.user,
            pass: pass,
            from: data.from,
            emailLoginEnabled: !!data.emailLoginEnabled,
          });
          audit.log("settings.smtp.update", {
            actorId: mu.id,
            actorName: mu.username,
            // Log field names only — never log host credentials, passwords, or secrets.
            metadata: { fieldsUpdated: ["host", "port", "secure", "user", "from", "emailLoginEnabled"] },
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"ok":true}');
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"Invalid request"}');
        }
      });
      return true;
    }

    // Semantic routing (Clef) settings (admin only). Write-only secrets: GET reports presence flags, never values.
    if ((req.method === "GET" || req.method === "POST") && fullUrl === "/api/admin/clef") {
      var mu = getMultiUserFromReq(req);
      if (!mu || mu.role !== "admin") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":"Admin access required"}');
        return true;
      }
      var clefStore = require("./orchestration/clef").createClef();
      // State change: a custom header (forces a CORS preflight, like attachments/office) plus a JSON content type.
      if (req.method === "POST" && (!req.headers["x-requested-with"] || !/^application\/json\b/i.test(req.headers["content-type"] || ""))) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":"forbidden"}');
        return true;
      }
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ clef: clefStore.status() }));
        return true;
      }
      var clefBody = "";
      req.on("data", function (chunk) { if (clefBody.length < 4096) clefBody += chunk; });
      req.on("end", function () {
        try {
          var data = JSON.parse(clefBody);
          // Automatic model selection settings are validated as a whole before anything is written.
          var valid = !!data && typeof data === "object" && !Array.isArray(data) &&
            ["enabled", "autoSelect", "storeText"].every(function (k) { return data[k] === undefined || typeof data[k] === "boolean"; }) &&
            (data.abstainMin === undefined || (typeof data.abstainMin === "number" && isFinite(data.abstainMin) && data.abstainMin >= 0.3 && data.abstainMin <= 0.95)) &&
            (data.backend === undefined || require("./orchestration/clef").DECISION_BACKENDS.indexOf(data.backend) !== -1) &&
            (data.jevKey === undefined || (typeof data.jevKey === "string" && data.jevKey.length <= 300));
          if (!valid) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end('{"error":"Invalid request"}');
            return;
          }
          if (data.clear === true) clefStore.clear();
          else clefStore.save({ token: data.token, accountId: data.accountId, jevKey: data.jevKey, backend: data.backend, enabled: typeof data.enabled === "boolean" ? data.enabled : undefined, autoSelect: data.autoSelect, abstainMin: data.abstainMin, storeText: data.storeText });
          audit.log("settings.clef.update", { actorId: mu.id, actorName: mu.username, metadata: Object.assign({ cleared: data.clear === true, tokenChanged: typeof data.token === "string", enabled: data.enabled, autoSelect: data.autoSelect, abstainMin: data.abstainMin, storeText: data.storeText }, typeof data.jevKey === "string" ? { jevKeyChanged: true } : {}, data.backend !== undefined ? { backend: data.backend } : {}) });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ clef: clefStore.status() }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"Invalid request"}');
        }
      });
      return true;
    }

    // Local model extras (admin only): extra OpenAI-compatible endpoints + session title model, in their own store
    // (not daemon.json). API keys are write-only: GET reports presence flags and the probed model list, never keys.
    if ((req.method === "GET" || req.method === "POST") && fullUrl === "/api/admin/local-model") {
      var mu = getMultiUserFromReq(req);
      if (!mu || mu.role !== "admin") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":"Admin access required"}');
        return true;
      }
      var lmStore = require("./providers/local/overrides");
      var lmState = require("./providers/local/state");
      var lmView = function (force) {
        return lmState.getLocalState().refresh(force).then(function (snap) {
          return Object.assign(lmStore.status(), { enabled: !!snap.enabled, models: (snap.models || []).map(function (m) { return { value: m.value, label: m.displayName }; }) });
        }, function () { return Object.assign(lmStore.status(), { enabled: false, models: [] }); });
      };
      if (req.method === "POST" && (!req.headers["x-requested-with"] || !/^application\/json\b/i.test(req.headers["content-type"] || ""))) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":"forbidden"}');
        return true;
      }
      if (req.method === "GET") {
        lmView(false).then(function (v) {
          res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          res.end(JSON.stringify({ localModel: v }));
        });
        return true;
      }
      var lmBody = "", lmTooBig = false;
      req.on("data", function (chunk) { if (lmTooBig) return; lmBody += chunk; if (lmBody.length > 16384) { lmTooBig = true; lmBody = ""; } });
      req.on("end", function () {
        var data, saved;
        try {
          if (lmTooBig) throw new Error("too large");
          data = JSON.parse(lmBody);
          saved = lmStore.save({ endpoints: data.endpoints, titleModel: data.titleModel, verifiers: data.verifiers, verifyMode: data.verifyMode, researchModel: data.researchModel });
        } catch (e) {
          if (e && e.code === "alias_conflict") { res.writeHead(409, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); return; }
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"Invalid request"}');
          return;
        }
        audit.log("settings.localModel.update", { actorId: mu.id, actorName: mu.username, metadata: {
          endpointsChanged: data.endpoints !== undefined, endpointCount: saved.endpoints.length,
          keysChanged: Array.isArray(data.endpoints) ? data.endpoints.filter(function (x) { return x && (x.clearKey === true || (typeof x.apiKey === "string" && x.apiKey.trim())); }).length : 0,
          titleModelChanged: data.titleModel !== undefined, titleModelSet: !!saved.titleModel,
          routableEndpoints: saved.endpoints.filter(function (x) { return x.routable; }).length,
          workEndpoints: saved.endpoints.filter(function (x) { return x.canWork; }).length,
          privateEndpoints: saved.endpoints.filter(function (x) { return x.privateAllowed; }).length,
          verifiersChanged: data.verifiers !== undefined, verifierCount: saved.verifiers.length,
          verifyModeChanged: data.verifyMode !== undefined, verifyMode: saved.verifyMode,
          researchModelChanged: data.researchModel !== undefined, researchModelSet: !!saved.researchModel } });
        // Re-probe now so the picker and the model policy see the new endpoints without a restart.
        lmState.getLocalState().reset();
        lmView(true).then(function (v) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ localModel: v }));
        });
      });
      return true;
    }
    // Audio transcription endpoint settings (admin only). Write-only key: GET reports a flag. Stored in
    // <config dir>/transcription.json, overlaid on daemon.json "transcription" (lib/transcription.js).
    if ((req.method === "GET" || req.method === "POST") && fullUrl === "/api/admin/transcription") {
      var mu = getMultiUserFromReq(req);
      if (!mu || mu.role !== "admin") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":"Admin access required"}');
        return true;
      }
      var trMod = require("./transcription");
      if (req.method === "POST" && (!req.headers["x-requested-with"] || !/^application\/json\b/i.test(req.headers["content-type"] || ""))) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":"forbidden"}');
        return true;
      }
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ transcription: trMod.status() }));
        return true;
      }
      var trBody = "", trTooBig = false;
      req.on("data", function (chunk) { if (trBody.length < 8192) trBody += chunk; else trTooBig = true; });
      req.on("end", function () {
        try {
          if (trTooBig) throw new Error("too big");
          var data = JSON.parse(trBody);
          if (!data || typeof data !== "object" || !trMod.saveSettings(data)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end('{"error":"invalid_config"}');
            return;
          }
          audit.log("settings.transcription.update", { actorId: mu.id, actorName: mu.username, metadata: { enabled: data.enabled === true, keyChanged: typeof data.apiKey === "string" && !!data.apiKey.trim(), keyCleared: data.clearApiKey === true } });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ transcription: trMod.status() }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"Invalid request"}');
        }
      });
      return true;
    }

    // Test SMTP connection (admin only)
    if (req.method === "POST" && fullUrl === "/api/admin/smtp/test") {
      var mu = getMultiUserFromReq(req);
      if (!mu || mu.role !== "admin") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":"Admin access required"}');
        return true;
      }
      var body = "";
      req.on("data", function (chunk) { body += chunk; });
      req.on("end", function () {
        try {
          var data = JSON.parse(body);
          // Use provided config or fall back to saved
          var existingCfg = smtp.getSmtpConfig();
          var pass = data.pass;
          if (pass === "••••••••" && existingCfg) {
            pass = existingCfg.pass;
          }
          var cfg = {
            host: data.host || (existingCfg && existingCfg.host),
            port: parseInt(data.port, 10) || (existingCfg && existingCfg.port) || 587,
            secure: data.secure !== undefined ? !!data.secure : (existingCfg && !!existingCfg.secure),
            user: data.user || (existingCfg && existingCfg.user),
            pass: pass || (existingCfg && existingCfg.pass),
            from: data.from || (existingCfg && existingCfg.from),
          };
          if (!cfg.host || !cfg.user || !cfg.pass || !cfg.from) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end('{"error":"SMTP configuration is incomplete"}');
            return;
          }
          var testTo = mu.email || cfg.from;
          smtp.sendTestEmail(cfg, testTo).then(function (result) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, message: "Test email sent to " + testTo }));
          }).catch(function (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: err.message || "Connection failed" }));
          });
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"Invalid request"}');
        }
      });
      return true;
    }

    // --- Project access control (admin only, multi-user) ---

    // Set project visibility (admin only)
    if (req.method === "PUT" && /^\/api\/admin\/projects\/[a-z0-9_-]+\/visibility$/.test(fullUrl)) {
      var mu = getMultiUserFromReq(req);
      var _visSlug = fullUrl.split("/")[4];
      var _visAccess = onGetProjectAccess ? onGetProjectAccess(_visSlug) : null;
      var _isOwner = mu && _visAccess && _visAccess.ownerId && mu.id === _visAccess.ownerId;
      if (!mu || (mu.role !== "admin" && !_isOwner)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":"Admin or project owner access required"}');
        return true;
      }
      var projSlug = fullUrl.split("/")[4];
      if (projSlug.indexOf("--") !== -1) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end('{"error":"Worktree projects inherit parent visibility"}');
        return true;
      }
      var body = "";
      req.on("data", function (chunk) { body += chunk; });
      req.on("end", function () {
        try {
          var data = JSON.parse(body);
          if (data.visibility !== "public" && data.visibility !== "private") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end('{"error":"Visibility must be public or private"}');
            return;
          }
          if (!onSetProjectVisibility) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end('{"error":"Visibility handler not configured"}');
            return;
          }
          var result = onSetProjectVisibility(projSlug, data.visibility);
          if (result && result.error) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: result.error }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"ok":true}');
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"Invalid request"}');
        }
      });
      return true;
    }

    // Set project owner (admin only)
    if (req.method === "PUT" && /^\/api\/admin\/projects\/[a-z0-9_-]+\/owner$/.test(fullUrl)) {
      var mu = getMultiUserFromReq(req);
      if (!mu || mu.role !== "admin") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":"Admin access required"}');
        return true;
      }
      var projSlug = fullUrl.split("/")[4];
      if (projSlug.indexOf("--") !== -1) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end('{"error":"Worktree projects inherit parent settings"}');
        return true;
      }
      var body = "";
      req.on("data", function (chunk) { body += chunk; });
      req.on("end", function () {
        try {
          var data = JSON.parse(body);
          var targetCtx = projects.get(projSlug);
          if (!targetCtx) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end('{"error":"Project not found"}');
            return;
          }
          var ownerId = data.userId || null;
          targetCtx.setProjectOwner(ownerId);
          if (onProjectOwnerChanged) {
            onProjectOwnerChanged(projSlug, ownerId);
          }
          // Broadcast to project clients
          var ownerName = null;
          if (ownerId) {
            var ownerUser = users.findUserById(ownerId);
            ownerName = ownerUser ? (ownerUser.displayName || ownerUser.username) : ownerId;
          }
          targetCtx.send({ type: "project_owner_changed", ownerId: ownerId, ownerName: ownerName });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"ok":true}');
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"Invalid request"}');
        }
      });
      return true;
    }

    // Set project allowed users (admin only)
    if (req.method === "PUT" && /^\/api\/admin\/projects\/[a-z0-9_-]+\/users$/.test(fullUrl)) {
      var mu = getMultiUserFromReq(req);
      var _usrSlug = fullUrl.split("/")[4];
      var _usrAccess = onGetProjectAccess ? onGetProjectAccess(_usrSlug) : null;
      var _isOwnerU = mu && _usrAccess && _usrAccess.ownerId && mu.id === _usrAccess.ownerId;
      if (!mu || (mu.role !== "admin" && !_isOwnerU)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":"Admin or project owner access required"}');
        return true;
      }
      var projSlug = fullUrl.split("/")[4];
      if (projSlug.indexOf("--") !== -1) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end('{"error":"Worktree projects inherit parent settings"}');
        return true;
      }
      var body = "";
      req.on("data", function (chunk) { body += chunk; });
      req.on("end", function () {
        try {
          var data = JSON.parse(body);
          if (!Array.isArray(data.allowedUsers)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end('{"error":"allowedUsers must be an array"}');
            return;
          }
          if (!onSetProjectAllowedUsers) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end('{"error":"AllowedUsers handler not configured"}');
            return;
          }
          var result = onSetProjectAllowedUsers(projSlug, data.allowedUsers);
          if (result && result.error) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: result.error }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"ok":true}');
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"Invalid request"}');
        }
      });
      return true;
    }

    // Get project access info (admin or project owner)
    if (req.method === "GET" && /^\/api\/admin\/projects\/[a-z0-9_-]+\/access$/.test(fullUrl)) {
      var mu = getMultiUserFromReq(req);
      var _accSlug = fullUrl.split("/")[4];
      var _accAccess = onGetProjectAccess ? onGetProjectAccess(_accSlug) : null;
      var _isOwnerA = mu && _accAccess && _accAccess.ownerId && mu.id === _accAccess.ownerId;
      if (!mu || (mu.role !== "admin" && !_isOwnerA)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":"Admin or project owner access required"}');
        return true;
      }
      var projSlug = fullUrl.split("/")[4];
      if (!onGetProjectAccess) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end('{"error":"Access handler not configured"}');
        return true;
      }
      var access = onGetProjectAccess(projSlug);
      if (access && access.error) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: access.error }));
        return true;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(access));
      return true;
    }

    // GET /api/admin/audit — tail the audit log (admin only, read-only)
    if (req.method === "GET" && fullUrl.indexOf("/api/admin/audit") === 0) {
      var mu = getMultiUserFromReq(req);
      if (!mu || mu.role !== "admin") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":"Admin access required"}');
        return true;
      }
      var auditPath = require("./audit").auditLogPath();
      var fs = require("fs");
      try {
        var raw = fs.readFileSync(auditPath, "utf8");
        var allLines = raw.split("\n").filter(function (l) { return l.trim().length > 0; });
        var N = 200;
        var tail = allLines.slice(-N);
        var entries = [];
        for (var li = 0; li < tail.length; li++) {
          try { entries.push(JSON.parse(tail[li])); } catch (_) {}
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ entries: entries, total_lines: allLines.length }));
      } catch (e) {
        if (e.code === "ENOENT") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"entries":[],"total_lines":0}');
        } else {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Failed to read audit log" }));
        }
      }
      return true;
    }

    return false;
  }

  return {
    handleRequest: handleRequest,
  };
}

module.exports = { attachAdmin: attachAdmin };

return module.exports;
});

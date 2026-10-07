"use strict";
// project-skills.js - WebSocket glue for room skills v1 (docs/superpowers/specs/2026-10-03-room-skills-plugins.md).
// Authority lives here, never in the client:
//   host picker / host install / update check / update apply   admin only (authz-gate ADMIN_ONLY, re-checked here)
//   install (zip, GitHub link) / approve / discard / remove     admin (global skills), or, while the room's skillManagers is "members", a
//                                                          room owner or member: their skill is scoped to that room, and only its installer
//                                                          or an admin can remove it. Never from a private channel.
//   toggle in a room                                      admin or room owner always; a member while skillManagers is "members"; viewers read only
//   toggle in a private channel                           the user's own set (room owner or member role), whatever skillManagers says
// The whole feature answers "disabled" while the roomSkills.enabled flag is off.
var os = require("os");
var path = require("path");
var audit = require("./audit");
var authzGate = require("./authz-gate");
var validator = require("./skills-validator");
var catalogs = require("./skills-catalog");
var skillsFlags = require("./skills-flags");
var { createRoomMainThread } = require("./room-main-thread");
var { isChannelBound } = require("./private-session-access");

var TYPES = { skills_list: 1, skill_detail: 1, skill_toggle: 1, skill_host_list: 1, skill_install_zip: 1, skill_install_host: 1,
  skill_draft_get: 1, skill_approve: 1, skill_discard: 1, skill_remove: 1, skill_git_fetch: 1, skill_git_pick: 1, skill_update_check: 1, skill_update_apply: 1 };
var GIT_ERRORS = ["git_bad_url", "git_host_not_allowed", "git_repo_not_found", "git_ref_not_found", "git_path_not_found", "git_no_skill", "git_rate_limited", "git_timeout",
  "git_too_large", "git_network", "git_bad_archive", "git_failed", "git_busy", "not_git_source", "name_changed"];
// Install-side operations a room member may do (scoped to their room) while the room lets members manage skills.
var MEMBER_OPS = { skill_install_zip: 1, skill_git_fetch: 1, skill_git_pick: 1, skill_draft_get: 1, skill_approve: 1, skill_discard: 1, skill_remove: 1 };
var FETCH_TTL_MS = 20 * 60000, MAX_FETCHES = 8, MAX_GIT_RUNNING = 2;
var ZIP_B64_MAX = Math.ceil(validator.LIMITS.zipBytes * 4 / 3) + 8;

function attachSkills(ctx) {
  var sm = ctx.sm, users = ctx.usersModule;
  var roomMain = createRoomMainThread({ sm: sm });
  var enabled = ctx.isSkillsEnabled || skillsFlags.isSkillsEnabled;
  var gitMod = ctx.skillsGit || require("./skills-git"), gitOpts = ctx.skillsGitOpts || {};
  var fetches = new Map(), gitRunning = 0;   // fetchId -> { userId, at, result, kind, id } (validated skills waiting for the admin's pick)
  function catalog() { return ctx.catalog || catalogs.getDefault(); }
  function hostDir() { return ctx.hostSkillsDir || path.join(require("./config").REAL_HOME || os.homedir(), ".claude", "skills"); }

  function actorOf(ws) { return ws && ws._aigoraUser && !ws._aigoraAccessRevoked ? ws._aigoraUser : null; }
  function isAdmin(u) { return !!u && u.role === "admin"; }
  function roomRole(u, roomId) { try { return u && typeof roomId === "string" ? users.getRoomRole(u.id, roomId) : null; } catch (_) { return null; } }
  function nameOf(u) {
    var p = (u && u.profile) || {};
    return p.name || (u && (u.displayName || u.username)) || "관리자";
  }
  function managersOf(roomId) { try { return typeof users.roomSkillManagers === "function" && users.roomSkillManagers(roomId) === "admins" ? "admins" : "members"; } catch (_) { return "members"; } }
  // Admins always; otherwise the room owner or a member (never a viewer) while the room lets members manage skills.
  function canInstallIn(u, roomId) {
    if (isAdmin(u)) return true;
    var role = roomRole(u, roomId);
    return (role === "owner" || role === "member") && managersOf(roomId) === "members";
  }
  // Where an install lands: { ok, roomId } (roomId set = scoped to that room; admins install globally; private channels are admin-only).
  function installCtx(u, msg) {
    if (isAdmin(u)) return { ok: true, roomId: undefined };
    var roomId = String(msg.roomId || "");
    return msg.scope === "private" || !canInstallIn(u, roomId) ? { ok: false } : { ok: true, roomId: roomId };
  }
  function scopeOf(u, msg) {
    var roomId = String(msg.roomId || "");
    var role = roomRole(u, roomId);
    if (!role) return null;
    if (msg.scope === "private") return role === "owner" || role === "member" ? { kind: "private", scope: { roomId: roomId, userId: u.id }, canToggle: true } : { kind: "private", scope: null, canToggle: false };
    return { kind: "room", scope: { roomId: roomId }, canToggle: role === "owner" || (role === "member" && managersOf(roomId) === "members") };
  }
  function fail(ws, op, code, errors) { ctx.sendTo(ws, { type: "skill_error", op: op, code: code, errors: errors || [] }); return true; }
  function publicMeta(m) {
    return { id: m.id, name: m.name, description: m.description, version: m.version, sha256: m.sha256, size: m.size,
      files: m.files, source: m.source, approvedAt: m.approvedAt || null, installedAt: m.installedAt || null, lint: m.lint || [] };
  }
  function userNameById(id) { var u = null; try { u = users.findUserById(id); } catch (_) {} return u ? nameOf(u) : "관리자"; }

  function stateFor(ws, msg) {
    var u = actorOf(ws), sc = scopeOf(u, msg), c = catalog();
    var roomId = String(msg.roomId || "");
    var out = { type: "skills_state", enabled: true, roomId: roomId, scope: msg.scope === "private" ? "private" : "room", canToggle: false,
      isAdmin: isAdmin(u), epoch: c.epoch(), skills: [], enabledCount: 0 };
    if (!sc) return Object.assign(out, { enabled: false, error: "forbidden" });
    out.canToggle = sc.canToggle;
    out.skillManagers = managersOf(roomId);
    out.canInstall = installCtx(u, msg).ok;
    var on = {};
    if (sc.scope) c.enabled(sc.scope).forEach(function (e) { on[e.id] = e; });
    out.skills = c.list(roomId).map(function (m) {
      var e = on[m.id];
      return Object.assign(publicMeta(m), { enabled: !!e, updateAvailable: !!(e && e.updateAvailable), approvedByName: userNameById(m.approvedBy),
        roomScoped: !!m.roomId, installedByName: m.roomId ? userNameById(m.installedBy) : "", canRemove: canRemoveSkill(u, msg, m) });
    });
    out.enabledCount = out.skills.filter(function (s) { return s.enabled; }).length;
    if (isAdmin(u) || out.canInstall) out.drafts = c.listDrafts().filter(function (d) { return draftAllowed(u, msg, d); }).map(function (d) { return { id: d.id, name: d.name, version: d.version, description: d.description, source: d.source, replaces: !!d.replaces }; });
    return out;
  }
  // A skill may be removed by an admin, or by the member who installed it into this room while members may manage skills.
  function canRemoveSkill(u, msg, m) {
    if (isAdmin(u)) return true;
    return !!m && !!m.roomId && m.roomId === String(msg.roomId || "") && m.installedBy === (u && u.id) && installCtx(u, msg).ok;
  }
  function draftAllowed(u, msg, d) {
    return isAdmin(u) || (!!d.roomId && d.roomId === String(msg.roomId || "") && d.installedBy === u.id && installCtx(u, msg).ok);
  }
  function roomNotice(u, roomId, text) { if (roomRole(u, roomId)) notice(null, u, { kind: "room", scope: { roomId: roomId } }, text); }
  function changed(roomId) {
    ctx.clients.forEach(function (c) { if (c._aigoraUser) { try { ctx.sendTo(c, { type: "skills_changed", roomId: roomId || null }); } catch (_) {} } });
  }
  function notice(ws, u, sc, text) {
    var entry = { type: "skill_notice", noticeId: require("crypto").randomBytes(6).toString("hex"), text: text, _ts: Date.now() };
    try {
      if (sc.kind === "room") roomMain.append(users, sc.scope.roomId, entry);
      else {
        var s = sm.sessions.get(ws._aigoraActiveSession);
        if (s && isChannelBound(s) && s.ownerId === u.id && s.roomId === sc.scope.roomId) sm.sendAndRecord(s, entry);
      }
    } catch (_) { /* the toggle stands without its feed line */ }
  }
  function auditLog(u, event, target, meta) { try { audit.log(event, { actorId: u.id, actorName: u.username, target: target, metadata: meta || {} }); } catch (_) {} }

  function draftReply(ws, draft) {
    ctx.sendTo(ws, { type: "skill_draft", draft: Object.assign(publicMeta(draft), { id: draft.id, replaces: !!draft.replaces,
      texts: draft.texts, lint: draft.lint || [] }) });
  }
  function installFrom(ws, u, op, msg, check, source, roomId) {
    if (!check.ok) return fail(ws, op, "rejected", check.errors);
    try {
      var d = catalog().createDraft(check.skill, source, u.id, roomId);
      auditLog(u, "skill.draft", check.skill.name, { sha256: check.skill.sha256, source: source.kind });
      draftReply(ws, catalog().readDraft(d.id));
      ctx.sendTo(ws, stateFor(ws, msg));
    } catch (e) { return fail(ws, op, e && e.code ? e.code : "failed"); }
    return true;
  }

  // ---- GitHub link installs and updates (lib/skills-git.js). Network work is async and only ever starts from an admin message.
  function keepFetch(u, entry) {
    var now = Date.now();
    fetches.forEach(function (v, k) { if (now - v.at > FETCH_TTL_MS) fetches.delete(k); });
    while (fetches.size >= MAX_FETCHES) fetches.delete(fetches.keys().next().value);
    var id = require("crypto").randomBytes(8).toString("hex");
    fetches.set(id, Object.assign({ userId: u.id, at: now }, entry));
    return id;
  }
  function takeFetch(u, id, kind) {
    var e = fetches.get(String(id || ""));
    return e && e.userId === u.id && e.kind === kind && Date.now() - e.at <= FETCH_TTL_MS ? e : null;
  }
  function skillSource(src, dir, plugins) {
    var o = Object.assign({}, src, { path: dir, plugins: plugins || [] });
    o.url = "https://github.com/" + src.repo + "/tree/" + src.commit + (dir ? "/" + dir : "");
    return o;
  }
  function runGit(ws, u, op, msg, work) {
    if (ws._skillGitBusy || gitRunning >= MAX_GIT_RUNNING) return fail(ws, op, "git_busy");
    ws._skillGitBusy = true; gitRunning++;
    function progress(step) { try { ctx.sendTo(ws, { type: "skill_git_progress", op: op, step: step }); } catch (_) {} }
    Promise.resolve().then(function () { return work(progress); }).catch(function (e) {
      var code = e && e.code;
      fail(ws, op, GIT_ERRORS.indexOf(code) !== -1 || code === "already_installed" || code === "too_many_drafts" || code === "catalog_full" ? code : "git_failed");
    }).then(function () { ws._skillGitBusy = false; gitRunning--; });
    return true;
  }
  // Drafts for the picked dirs. One draft opens straight in review; several land in the pending list.
  function draftsFrom(ws, u, op, msg, r, dirs, roomId) {
    var made = [], skipped = [], firstErr = null;
    dirs.forEach(function (dir) {
      var sk = r.skills[dir];
      if (!sk) { skipped.push({ path: dir, code: "rejected" }); return; }
      try {
        var d = catalog().createDraft(sk, skillSource(r.source, dir, r.plugins), u.id, roomId);
        made.push(d);
        auditLog(u, "skill.draft", sk.name, { sha256: sk.sha256, source: "git", repo: r.source.repo, commit: r.source.commit, path: dir });
      } catch (e) { firstErr = firstErr || (e && e.code) || "failed"; skipped.push({ path: dir, name: sk.name, code: (e && e.code) || "failed" }); }
    });
    if (!made.length) return fail(ws, op, firstErr || "rejected");
    if (made.length === 1) draftReply(ws, catalog().readDraft(made[0].id));
    else ctx.sendTo(ws, { type: "skill_git_picked", count: made.length, skipped: skipped });
    ctx.sendTo(ws, stateFor(ws, msg));
    return true;
  }
  function gitFetch(ws, u, op, msg, roomId) {
    return runGit(ws, u, op, msg, async function (progress) {
      var r = await gitMod.fetchLink(String(msg.url || ""), gitOpts, progress);
      auditLog(u, "skill.git_fetch", r.source.repo, { commit: r.source.commit, path: r.source.path, method: r.source.method, candidates: r.candidates.length });
      if (r.candidates.length === 1) {
        if (!r.candidates[0].ok) return fail(ws, op, "rejected", r.candidates[0].errors);
        return draftsFrom(ws, u, op, msg, r, [r.candidates[0].path], roomId);
      }
      var id = keepFetch(u, { kind: "install", result: r });
      ctx.sendTo(ws, { type: "skill_git_candidates", fetchId: id, source: r.source, plugins: r.plugins, truncated: !!r.truncated, candidates: r.candidates });
    });
  }
  function gitPick(ws, u, op, msg, roomId) {
    var e = takeFetch(u, msg.fetchId, "install");
    if (!e) return fail(ws, op, "not_found");
    var dirs = (Array.isArray(msg.paths) ? msg.paths : []).filter(function (p) { return typeof p === "string"; }).slice(0, 50)
      .filter(function (p, i, a) { return a.indexOf(p) === i && Object.prototype.hasOwnProperty.call(e.result.skills, p); });
    if (!dirs.length) return fail(ws, op, "not_found");
    fetches.delete(String(msg.fetchId));
    return draftsFrom(ws, u, op, msg, e.result, dirs, roomId);
  }
  function updateCheck(ws, u, op, msg) {
    var cur = catalog().get(String(msg.id || ""));
    if (!cur) return fail(ws, op, "not_found");
    if (!cur.source || cur.source.kind !== "git") return fail(ws, op, "not_git_source");
    return runGit(ws, u, op, msg, async function (progress) {
      var res = await gitMod.checkUpdate(cur.source, gitOpts, progress);
      if (res.upToDate) { ctx.sendTo(ws, { type: "skill_update_info", id: cur.id, upToDate: true, commit: res.commit }); return; }
      if (!res.skill) return fail(ws, op, "rejected", res.candidate.errors);
      if (res.skill.name !== cur.id) return fail(ws, op, "name_changed");
      var fetchId = keepFetch(u, { kind: "update", id: cur.id, result: { source: res.source, skills: { [res.source.path]: res.skill }, plugins: cur.source.plugins || [] } });
      ctx.sendTo(ws, { type: "skill_update_info", id: cur.id, upToDate: false, fetchId: fetchId, commit: res.commit, ref: res.source.ref, identical: res.skill.sha256 === cur.sha256,
        diff: gitMod.diffSummary(cur.texts, res.skill.files, cur.files), lint: res.skill.lint });
    });
  }
  function updateApply(ws, u, op, msg) {
    var e = takeFetch(u, msg.fetchId, "update");
    if (!e) return fail(ws, op, "not_found");
    fetches.delete(String(msg.fetchId));
    return draftsFrom(ws, u, op, msg, e.result, Object.keys(e.result.skills));
  }

  function handleMessage(ws, msg) {
    if (!msg || !TYPES[msg.type]) return false;
    var u = actorOf(ws), op = msg.type;
    if (authzGate.ADMIN_ONLY[op] && authzGate.deny(ws, msg, ctx.sendTo)) return true;
    if (u && !authzGate.ADMIN_ONLY[op] && MEMBER_OPS[op] && !isAdmin(u) && !installCtx(u, msg).ok) return fail(ws, op, "forbidden");
    if (!u) return fail(ws, op, "forbidden");
    if (!enabled()) { if (msg.type === "skills_list") ctx.sendTo(ws, { type: "skills_state", enabled: false, roomId: String(msg.roomId || ""), scope: "room", skills: [], enabledCount: 0 }); else fail(ws, op, "disabled"); return true; }
    try {
      if (msg.type === "skills_list") { ctx.sendTo(ws, stateFor(ws, msg)); return true; }
      if (msg.type === "skill_detail") {
        if (!scopeOf(u, msg)) return fail(ws, op, "forbidden");
        var d = catalog().get(String(msg.id || ""), String(msg.roomId || ""));
        if (!d) return fail(ws, op, "not_found");
        ctx.sendTo(ws, { type: "skill_detail", skill: Object.assign(publicMeta(d), { texts: d.texts, approvedByName: userNameById(d.approvedBy) }) });
        return true;
      }
      if (msg.type === "skill_toggle") {
        var sc = scopeOf(u, msg);
        if (!sc || !sc.scope || !sc.canToggle) return fail(ws, op, "forbidden");
        var r = catalog().setEnabled(sc.scope, String(msg.id || ""), msg.on === true, { upgrade: msg.upgrade === true });
        if (r.changed) {
          var verb = r.on === false ? "껐어요" : r.upgraded ? "새 버전으로 바꿨어요" : "켰어요";
          notice(ws, u, sc, nameOf(u) + "님이 '" + r.name + "' 스킬을 " + verb + ".");
          auditLog(u, "skill.toggle", r.name, { roomId: sc.scope.roomId, scope: sc.kind, on: r.on !== false });
          if (sc.kind === "room") changed(sc.scope.roomId);
        }
        ctx.sendTo(ws, stateFor(ws, msg));
        return true;
      }
      // ---- install side: admin (global) or an allowed room member (room-scoped); everything else below is admin only
      var inst = installCtx(u, msg);
      if (MEMBER_OPS[op] && inst.ok) {
        if (msg.type === "skill_install_zip") {
          if (typeof msg.data !== "string" || msg.data.length > ZIP_B64_MAX) return fail(ws, op, "zip_too_large");
          return installFrom(ws, u, op, msg, validator.validateZip(Buffer.from(msg.data, "base64")), { kind: "zip", ref: String(msg.fileName || "").replace(/[^\w.\- ]/g, "").slice(0, 80) }, inst.roomId);
        }
        if (msg.type === "skill_git_fetch") return gitFetch(ws, u, op, msg, inst.roomId);
        if (msg.type === "skill_git_pick") return gitPick(ws, u, op, msg, inst.roomId);
        if (msg.type === "skill_remove") {
          var rn = String(msg.id || ""), target = catalog().get(rn);
          if (!target) return fail(ws, op, "not_found");
          if (!canRemoveSkill(u, msg, target)) return fail(ws, op, "forbidden");
          catalog().remove(rn);
          auditLog(u, "skill.remove", rn, { roomId: target.roomId || null });
          roomNotice(u, String(msg.roomId || ""), nameOf(u) + "님이 '" + rn + "' 스킬을 지웠어요.");
          changed(null);
          ctx.sendTo(ws, stateFor(ws, msg));
          return true;
        }
        var dm = catalog().readDraft(String(msg.id || ""));
        if (!draftAllowed(u, msg, dm)) return fail(ws, op, "forbidden");
        if (msg.type === "skill_draft_get") { draftReply(ws, dm); return true; }
        if (msg.type === "skill_discard") { catalog().discardDraft(dm.id); ctx.sendTo(ws, stateFor(ws, msg)); return true; }
        if (msg.type === "skill_approve") {
          // A draft with scripts needs the installer's explicit "I read the scripts" confirmation (the review screen's checkbox).
          if (dm.files.some(function (f) { return f.kind === "script"; }) && msg.confirmScripts !== true) return fail(ws, op, "scripts_unconfirmed");
          var am = catalog().approve(dm.id, u.id);
          auditLog(u, "skill.approve", am.name, { sha256: am.sha256, version: am.version, roomId: dm.roomId || null });
          roomNotice(u, String(msg.roomId || ""), nameOf(u) + "님이 '" + am.name + "' 스킬을 추가했어요.");
          changed(dm.roomId || null);
          ctx.sendTo(ws, stateFor(ws, msg));
          return true;
        }
      }
      if (!isAdmin(u)) return fail(ws, op, "forbidden");
      if (msg.type === "skill_host_list") { ctx.sendTo(ws, { type: "skill_host_names", names: validator.listHostSkills(hostDir()) }); return true; }
      if (msg.type === "skill_install_host") {
        var pick = String(msg.name || "");
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(pick) || validator.listHostSkills(hostDir()).indexOf(pick) === -1) return fail(ws, op, "not_found");
        return installFrom(ws, u, op, msg, validator.validateHostDir(path.join(hostDir(), pick)), { kind: "host", ref: pick });
      }
      if (msg.type === "skill_update_check") return updateCheck(ws, u, op, msg);
      if (msg.type === "skill_update_apply") return updateApply(ws, u, op, msg);
    } catch (e) { return fail(ws, op, e && e.code ? e.code : "failed"); }
    return true;
  }
  return { handleMessage: handleMessage };
}

module.exports = { attachSkills: attachSkills, TYPES: TYPES };

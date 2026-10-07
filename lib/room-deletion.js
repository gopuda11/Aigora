module.exports = require("./extensions").select("room-deletion", function () {
var module = { exports: {} };
// room-deletion.js - permanent deletion of an archived room.
//
// After the admin checks (admin only, room archived, confirmName = room name) the purge is a cascade that
// removes ALL data of the room: sessions (every vendor, room main threads, hidden orchestration sessions,
// private-channel sessions) and their persisted files and images, private channels and their agent
// workspaces, attachments (room + channel scopes), shared posts, room social (comments, pins, notifications),
// entries, and last the room record (settings, approval, invites).
//
// Before anything is removed one compressed backup of it all is written to <configDir>/../aigora-room-trash
// (0600, kept 7 days, swept at daemon start and after each purge). A turn or run still active in the room
// refuses the purge. A failing item never stops the others: failures are collected and reported, and then the
// room record is KEPT (archived) so a retry can finish; nothing is ever half-deleted silently.

var fs = require("fs");
var os = require("os");
var path = require("path");
var zlib = require("zlib");
var childProcess = require("child_process");
var stream = require("stream");

var ROOM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
var TRASH_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
var BACKUP_RE = /^[A-Za-z0-9_-]{1,64}-\d{4}-\d\d-\d\dT[\w.-]+\.tar\.gz$/;
var ACTIVE_MSG = "AI 작업이 진행 중이라 지금은 삭제할 수 없어요.";

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return null; }
}
function listDir(dir) {
  try { return fs.readdirSync(dir); } catch (_) { return []; }
}
function exists(p) { try { fs.lstatSync(p); return true; } catch (_) { return false; } }
function arr(v) { return Array.isArray(v) ? v : []; }
function mine(roomId) { return function (x) { return !!x && x.roomId === roomId; }; }
function writeJsonAtomic(file, data) {
  var tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, typeof data === "string" ? data : JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function rmTree(p) { fs.rmSync(p, { recursive: true, force: true }); }
// lstat-based checks: a symlink is never a directory/file here, so symlinked scope dirs are refused.
function isRealDir(p) { try { return fs.lstatSync(p).isDirectory(); } catch (_) { return false; } }
function isRealFile(p) { try { return fs.lstatSync(p).isFile(); } catch (_) { return false; } }
// True when no existing component of p below root is a symlink (and p stays under root).
function chainClean(root, p) {
  var r = path.relative(root, p);
  if (r === "" || r.split(path.sep)[0] === ".." || path.isAbsolute(r)) return false;
  var cur = root;
  var parts = r.split(path.sep);
  for (var i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]);
    try { if (fs.lstatSync(cur).isSymbolicLink()) return false; } catch (e) { if (e.code === "ENOENT") return true; return false; }
  }
  return true;
}
// Destructive removal that refuses (throws) an existing path with a symlinked component below root.
function safeRm(root, p) {
  if (!exists(p)) return;
  if (!chainClean(root, p)) throw new Error("unsafe path (symlink component): " + path.relative(root, p));
  rmTree(p);
}
// be removed stays, with the room's tasks, so a retry rediscovers it. The state file is rewritten only after that.


// Raw text of a file, null when it does not exist; throws when it exists but cannot be read (or is a symlink).
function readRawIfExists(file) {
  var st;
  try { st = fs.lstatSync(file); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
  if (!st.isFile()) throw new Error("not a regular file: " + path.basename(file));
  return fs.readFileSync(file, "utf8");
}
function parseOrNull(raw) { try { return JSON.parse(raw); } catch (_) { return null; } }

function roomSessionManagers(projects) {
  var out = [];
  if (projects) projects.forEach(function (ctx) {
    var sm = ctx && typeof ctx.getSessionManager === "function" ? ctx.getSessionManager() : null;
    if (sm && sm.sessions) out.push(sm);
  });
  return out;
}
function roomSessions(sm, roomId) {
  var out = [];
  sm.sessions.forEach(function (s) { if (s && s.roomId === roomId) out.push(s); });
  return out;
}

function firstLineMeta(file) {
  try {
    var fd = fs.openSync(file, "r");
    try {
      var buf = Buffer.alloc(65536);
      var head = buf.slice(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString("utf8");
      return JSON.parse(head.split("\n")[0]);
    } finally { fs.closeSync(fd); }
  } catch (_) { return null; }
}

// Image file names a session file references; null when the file could not be read ("unknown", not "none").
function imageFilesOf(file) {
  var out = [];
  var raw = "";
  try { raw = fs.readFileSync(file, "utf8"); } catch (_) { return null; }
  raw.split("\n").forEach(function (line) {
    if (line.indexOf("imageRefs") === -1) return;
    try {
      arr(JSON.parse(line).imageRefs).forEach(function (r) {
        if (r && typeof r.file === "string" && /^[\w.-]+$/.test(r.file) && r.file !== "." && r.file !== "..") out.push(r.file);
      });
    } catch (_) {}
  });
  return out;
}

// The default trash directory sits next to the config directory, never under a served path.
function trashDirFor(configDir, opts) {
  return (opts && opts.trashDir) || process.env.AIGORA_ROOM_TRASH_DIR || path.join(path.dirname(path.resolve(configDir)), "aigora-room-trash");
}

var STAGE_RE = /^\.stage-[A-Za-z0-9]{1,16}$/;
var TMP_RE = /^[A-Za-z0-9_-]{1,64}-\d{4}-\d\d-\d\dT[\w.-]+\.tar\.gz\.tmp$/;
var ABANDON_MS = 60 * 60 * 1000;
var inProgress = new Set();          // staging dirs and tmp files of purges running in this process

// Removes backups older than 7 days, and abandoned staging dirs / .tar.gz.tmp files older than 1 hour (ours, regular,
// not symlinks, not part of a running purge). Never throws; returns the removed file names.
function sweepTrash(trashDir, now) {
  var removed = [];
  var t = typeof now === "number" ? now : Date.now();
  try { var rootSt = fs.lstatSync(trashDir); if (!rootSt.isDirectory()) return removed; } catch (_) { return removed; }
  var uid = typeof process.getuid === "function" ? process.getuid() : null;
  listDir(trashDir).forEach(function (f) {
    var full = path.join(trashDir, f);
    if (STAGE_RE.test(f) || TMP_RE.test(f)) {
      try {
        var sst = fs.lstatSync(full);
        var okType = STAGE_RE.test(f) ? sst.isDirectory() : sst.isFile();
        if (okType && !inProgress.has(full) && (uid === null || sst.uid === uid) && t - sst.mtimeMs > ABANDON_MS) { rmTree(full); removed.push(f); }
      } catch (_) {}
      return;
    }
    if (!BACKUP_RE.test(f)) return;
    try {
      var st = fs.lstatSync(path.join(trashDir, f));
      if (st.isFile() && t - st.mtimeMs > TRASH_KEEP_MS) { fs.unlinkSync(path.join(trashDir, f)); removed.push(f); }
    } catch (_) {}
  });
  return removed;
}

function backupTimeoutMs() {
  var n = Number(process.env.AIGORA_ROOM_BACKUP_TIMEOUT_MS);
  return n > 0 ? n : 5 * 60 * 1000;
}
// The callback fires after the child has exited; on timeout the child is SIGKILLed first.
function runTar(args, timeoutMs) {
  return new Promise(function (resolve, reject) {
    childProcess.execFile("tar", args, { maxBuffer: 1 << 20, timeout: Math.max(1, timeoutMs), killSignal: "SIGKILL" }, function (err, _o, stderr) {
      if (err && err.killed) return reject(new Error("tar timed out"));
      // GNU tar exits 1 when a file changed while it was read: still a usable archive.
      if (err && err.code !== 1) return reject(new Error("tar failed: " + String(stderr || err.message).slice(0, 200)));
      resolve();
    });
  });
}

// items: { records: [{name, data}], files: { config: [rel...], attachments: [rel...] } }; roots: { config, attachments }.
// Archive layout: manifest.json, records/<name>.json, files/<group>/<relative path>.
async function writeBackup(trashDir, roomId, items, roots, manifest) {
  fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
  // Fail closed: the trash root must be a real directory (not a symlink), ours, and exactly 0700.
  var tst = fs.lstatSync(trashDir);
  if (!tst.isDirectory()) throw new Error("trash dir is not a real directory");
  if (typeof process.getuid === "function" && tst.uid !== process.getuid()) throw new Error("trash dir is not owned by this user");
  fs.chmodSync(trashDir, 0o700);
  if ((fs.lstatSync(trashDir).mode & 0o777) !== 0o700) throw new Error("trash dir is not private (0700)");
  var stamp = new Date().toISOString().replace(/:/g, "-");
  var finalPath = path.join(trashDir, roomId + "-" + stamp + ".tar.gz");
  // Intermediate files live in a private 0700 staging dir inside the verified trash dir.
  var stage = fs.mkdtempSync(path.join(trashDir, ".stage-"));
  fs.chmodSync(stage, 0o700);
  var tarPath = path.join(stage, "backup.tar");
  var deadline = Date.now() + backupTimeoutMs();
  var left = function () { var r = deadline - Date.now(); if (r <= 0) throw new Error("backup timed out"); return r; };
  inProgress.add(stage); inProgress.add(finalPath + ".tmp");
  try {
    fs.writeFileSync(tarPath, "", { mode: 0o600 });
    fs.chmodSync(tarPath, 0o600);
    fs.mkdirSync(path.join(stage, "records"));
    items.records.forEach(function (r) { fs.writeFileSync(path.join(stage, "records", r.name + ".json"), JSON.stringify(r.data, null, 2), { mode: 0o600 }); });
    fs.writeFileSync(path.join(stage, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    await runTar(["-cf", tarPath, "-C", stage, "."], left());
    var groups = Object.keys(items.files);
    for (var i = 0; i < groups.length; i++) {
      var rels = items.files[groups[i]].filter(function (r, k, a) { return a.indexOf(r) === k; });
      if (!rels.length || !roots[groups[i]]) continue;
      var list = path.join(stage, "list-" + groups[i] + ".txt");
      fs.writeFileSync(list, rels.join("\n") + "\n", { mode: 0o600 });
      await runTar(["-rf", tarPath, "-C", roots[groups[i]], "--transform=s,^,files/" + groups[i] + "/,", "-T", list], left());
    }
    await stream.promises.pipeline(fs.createReadStream(tarPath), zlib.createGzip(), fs.createWriteStream(finalPath + ".tmp", { mode: 0o600 }));
    fs.renameSync(finalPath + ".tmp", finalPath);
    fs.chmodSync(finalPath, 0o600);
    return finalPath;
  } catch (e) {
    try { fs.rmSync(finalPath + ".tmp", { force: true }); } catch (_) {}
    throw e;
  } finally {
    try { rmTree(stage); } catch (_) {}
    inProgress.delete(stage); inProgress.delete(finalPath + ".tmp");
  }
}

// Orchestration runs of the room still queued or running (read from the durable state files).
function activeOrchestration(roomId, configDir) {
  var n = 0;
  listDir(path.join(configDir, "orchestration")).forEach(function (f) {
    if (!/\.json$/.test(f)) return;
    arr((readJson(path.join(configDir, "orchestration", f)) || {}).runs).filter(mine(roomId)).forEach(function (r) {
      if (r.status === "queued" || r.status === "running" || r.status === "awaiting_external") n++;
    });
  });
  return n;
}

function hasActiveWork(roomId, projects, configDir) {
  var busy = false;
  roomSessionManagers(projects).forEach(function (sm) {
    roomSessions(sm, roomId).forEach(function (s) { if (s.isProcessing || (s.loop && s.loop.active)) busy = true; });
  });
  return busy || activeOrchestration(roomId, configDir) > 0;
}

// opts: { users, actorId, roomId, confirmName, projects, configDir?, channelStore?, attachments?, trashDir?, now? }
// -> { ok: true, backup, counts } | { error, status, failures?, backup?, counts? }
async function deleteRoomPermanently(opts) {
  var users = opts.users;
  var actor = users.findUserById(opts.actorId);
  if (!actor || actor.role !== "admin") return { error: "Admin access required", status: 403 };
  var roomId = opts.roomId;
  var room = typeof roomId === "string" && ROOM_ID_RE.test(roomId) ? users.findRoomById(roomId) : null;
  if (!room) return { error: "Room not found", status: 404 };
  if (!room.archived) return { error: "Room must be archived before it can be deleted", status: 400 };
  if (typeof opts.confirmName !== "string" || opts.confirmName !== room.name) {
    return { error: "confirmName must match the room name", status: 400 };
  }

  // Room-level purge lock, taken BEFORE anything is scanned: blocks restore, turn admission and a second purge.
  if (!users.beginRoomPurge(roomId)) return { error: "이 방은 이미 삭제 중이에요.", status: 409 };
  try {
    return await purgeLocked(opts, room);
  } finally {
    users.endRoomPurge(roomId);
  }
}

async function purgeLocked(opts, room) {
  var users = opts.users;
  var roomId = room.id;
  var configDir = opts.configDir || require("./config").CONFIG_DIR;
  var projects = opts.projects;
  if (hasActiveWork(roomId, projects, configDir)) return { error: ACTIVE_MSG, status: 409 };

  var failures = [];
  var counts = {};
  function fail(kind, err) { failures.push({ kind: kind, error: String((err && err.message) || err).slice(0, 200) }); }
  function count(kind, n) { if (n > 0) counts[kind] = (counts[kind] || 0) + n; }
  function step(kind, fn) { try { fn(); } catch (e) { fail(kind, e); } }

  var records = [];                    // [{ name, data }] JSON copies of record-level data
  var files = { config: [], attachments: [] };
  var roots = { config: configDir, attachments: null };
  var cfg = function () { return path.join.apply(path, [configDir].concat(Array.prototype.slice.call(arguments))); };
  var rel = function (p) { return path.relative(configDir, p); };

  var managers = roomSessionManagers(projects);
  var attachments = opts.attachments || require("./room-attachments").createRoomAttachments({ root: require("./room-attachments").resolveAttachmentsRoot, usersModule: users });
  roots.attachments = typeof attachments.root === "function" ? attachments.root() : null;

  // ---- scan: what exists (counts and backup contents). Any unreadable item aborts before anything is removed. ----
  var SCAN_ABORT = { error: "삭제할 데이터를 읽지 못해 아무것도 삭제하지 않았어요.", status: 500 };
  var loadedCli = new Set();           // "<project dir>/<cli session id>" of the room's live sessions
  var liveCount = 0;
  managers.forEach(function (sm) {
    var proj = sm.sessionsDir ? path.basename(String(sm.sessionsDir)) : "";
    roomSessions(sm, roomId).forEach(function (s) { liveCount++; if (s.cliSessionId && proj) loadedCli.add(proj + "/" + s.cliSessionId); });
  });
  var sessionFiles = [];               // absolute paths of persisted session files of this room
  var sessionImages = [];              // { proj, name } referenced by those files
  var survivorUnreadable = new Set();  // projects holding a surviving session file that could not be read
  var survivorImages = new Set();      // "proj/name" referenced by sessions that stay
  var sessionsRoot = cfg("sessions");
  if (exists(sessionsRoot) && !isRealDir(sessionsRoot)) return SCAN_ABORT;
  listDir(sessionsRoot).forEach(function (enc) {
    var dir = cfg("sessions", enc);
    if (!isRealDir(dir)) return;       // symlinked or non-directory scope entries are never followed
    listDir(dir).forEach(function (f) {
      if (!/\.jsonl$/.test(f)) return;
      var p = cfg("sessions", enc, f);
      if (!isRealFile(p)) return;
      var meta = firstLineMeta(p);
      var hasMeta = !!(meta && meta.type === "meta" && typeof meta.roomId === "string");
      var mineFile = hasMeta ? meta.roomId === roomId : loadedCli.has(enc + "/" + f.replace(/\.jsonl$/, ""));
      var refs = imageFilesOf(p);
      if (mineFile) {
        if (!chainClean(configDir, p)) { fail("sessions", new Error("unsafe session path: " + enc)); return; }
        if (refs === null) { fail("sessions", new Error("unreadable session file kept: " + f)); return; }
        sessionFiles.push(p);
        refs.forEach(function (n) { sessionImages.push({ proj: enc, name: n }); });
      } else if (refs === null) {
        survivorUnreadable.add(enc);      // unknown references: shared-candidate images of this project stay
      } else {
        refs.forEach(function (n) { survivorImages.add(enc + "/" + n); });
      }
    });
  });
  var imagePaths = [];
  var seenImg = new Set();
  sessionImages.forEach(function (im) {
    var key = im.proj + "/" + im.name;
    if (seenImg.has(key) || survivorImages.has(key)) return;
    seenImg.add(key);
    var dir = cfg("images", im.proj), p = cfg("images", im.proj, im.name);
    if (exists(dir) && !isRealDir(dir)) { fail("sessions", new Error("unsafe image dir kept: " + im.proj)); return; }
    if (isRealDir(dir) && isRealFile(p)) {
      if (survivorUnreadable.has(im.proj)) { fail("sessions", new Error("image kept: a surviving session in " + im.proj + " could not be read")); return; }
      if (!chainClean(configDir, p)) { fail("sessions", new Error("unsafe image path: " + im.proj)); return; }
      imagePaths.push(p);
    }
  });
  count("sessions", Math.max(liveCount, sessionFiles.length));
  sessionFiles.concat(imagePaths).forEach(function (p) { files.config.push(rel(p)); });

  var store = opts.channelStore || require("./personal-channels").createPersonalChannelStore({ dir: configDir, canAccessRoom: users.canAccessRoom });
  var channels = [];
  try { channels = (await store.listChannels()).filter(mine(roomId)); } catch (e) { fail("channels", e); }
  count("channels", channels.length);
  if (channels.length) records.push({ name: "channels", data: channels });
  var agentBase = cfg("private-agent-scope");
  // Per channel workspace: missing (nothing to do), verified (backed up and removed) or rejected (exists but unsafe: failure, record kept).
  var channelDirs = [], channelRejected = {};
  channels.forEach(function (c) {
    var p = path.join(agentBase, String(c.ownerUserId), String(c.channelId));
    var nameOk = /^[\w-]+$/.test(String(c.ownerUserId)) && /^[\w-]+$/.test(String(c.channelId));
    if (nameOk && !exists(p)) return;
    if (nameOk && chainClean(configDir, p)) { channelDirs.push(p); files.config.push(rel(p)); return; }
    channelRejected[c.channelId] = true;
    fail("channel workspaces", new Error("unsafe channel workspace kept: " + String(c.channelId).slice(0, 40)));
  });
  count("channel workspaces", channelDirs.length);
  var roomScope = path.join(agentBase, "room", roomId);
  if (exists(roomScope) && !chainClean(configDir, roomScope)) return SCAN_ABORT;
  if (exists(roomScope)) { files.config.push(rel(roomScope)); count("workspace and snapshots", 1); }

  if (roots.attachments) {
    var scopes = ["room-" + roomId].concat(channels.map(function (c) { return "chan-" + c.channelId; }));
    var attDirs = 0;
    ["blobs", "meta", "versions", "pending", "transcripts", "video"].forEach(function (d) {
      scopes.forEach(function (sc) { if (exists(path.join(roots.attachments, d, sc))) { files.attachments.push(path.join(d, sc)); attDirs++; } });
    });
    var attFiles = 0;
    try { attFiles = attachments.countRoomAttachments(roomId); } catch (_) {}
    count("attachments", attFiles || attDirs);
  }

  var postsFile = cfg("shared-posts", roomId + ".json");
  var socialFile = cfg("room-social", roomId + ".json");
  var postsRaw, socialRaw;
  try {
    // A symlinked shared-posts / room-social parent is never read through; the destructive step then refuses it.
    postsRaw = chainClean(configDir, postsFile) ? readRawIfExists(postsFile) : null;
    socialRaw = chainClean(configDir, socialFile) ? readRawIfExists(socialFile) : null;
  } catch (e) {
    console.error("[room-deletion] unreadable room file:", e && e.message);
    return SCAN_ABORT;
  }
  // The raw files are archived whether or not they parse; the parsed copy is added only when it does.
  if (postsRaw !== null) {
    files.config.push(rel(postsFile));
    var posts = parseOrNull(postsRaw);
    if (posts) records.push({ name: "shared-posts", data: posts });
    count("shared posts", arr(posts && posts.posts).length || 1);
  }
  if (exists(cfg("shared-posts", "files", roomId))) {
    if (!chainClean(configDir, cfg("shared-posts", "files", roomId))) return SCAN_ABORT;
    files.config.push(rel(cfg("shared-posts", "files", roomId)));
  }
  if (socialRaw !== null) {
    files.config.push(rel(socialFile));
    var social = parseOrNull(socialRaw);
    if (social) records.push({ name: "room-social", data: social });
    count("room social", (social ? arr(social.comments).length + arr(social.pins).length + arr(social.notifs).length : 0) || 1);
  }

  var notifFile = cfg("notifications.json");
  var allNotifs = readJson(notifFile);
  var roomNotifs = arr(allNotifs).filter(function (n) { return n && n.meta && n.meta.roomId === roomId; });
  if (roomNotifs.length) { records.push({ name: "notifications", data: roomNotifs }); count("notifications", roomNotifs.length); }



  var orchFiles = [], runRecords = [];
  listDir(cfg("orchestration")).forEach(function (f) {
    if (!/\.json$/.test(f)) return;
    var rs = arr((readJson(cfg("orchestration", f)) || {}).runs).filter(mine(roomId));
    if (rs.length) { orchFiles.push(f); runRecords = runRecords.concat(rs); }
  });
  if (runRecords.length) { records.push({ name: "orchestration-runs", data: runRecords }); count("orchestration runs", runRecords.length); }

  var loopFiles = [], loopRecords = [];
  listDir(cfg("loops")).forEach(function (f) {
    if (!/\.jsonl$/.test(f)) return;
    var hit = false;
    try {
      fs.readFileSync(cfg("loops", f), "utf8").split("\n").forEach(function (line) {
        try { var rec = line.trim() ? JSON.parse(line) : null; if (rec && rec.roomId === roomId) { hit = true; loopRecords.push(rec); } } catch (_) {}
      });
    } catch (_) {}
    if (hit) loopFiles.push(f);
  });
  if (loopRecords.length) { records.push({ name: "loop-records", data: loopRecords }); count("loop records", loopRecords.length); }

  // The process-wide stores keep state in memory, so the live instance is used whenever it serves this config dir.
  var skillsMod = require("./skills-catalog");
  var catalog = opts.skillsCatalog || (function () {
    var live = skillsMod.getDefault();
    return path.resolve(live.dir || "") === path.resolve(cfg("skills")) ? live : skillsMod.createCatalog({ dir: cfg("skills") });
  })();
  var skillState = readJson(cfg("skills", "state.json")) || {};
  var skillNameOk = require("./skills-validator").isValidName;
  var skillsStore = path.resolve(cfg("skills", "store"));
  var roomSkills = Object.keys(skillState.skills || {}).filter(function (n) { return skillState.skills[n] && skillState.skills[n].roomId === roomId; });
  // Only canonical skill names whose directory stays directly under skills/store are ever backed up or deleted.
  var safeSkills = roomSkills.filter(function (n) { return skillNameOk(n) && path.dirname(path.resolve(skillsStore, n)) === skillsStore && chainClean(configDir, path.join(skillsStore, n)); });
  var skillPins = { room: (skillState.rooms || {})[roomId] || null, users: {} };
  Object.keys(skillState.users || {}).forEach(function (u) { if (skillState.users[u] && skillState.users[u][roomId]) skillPins.users[u] = skillState.users[u][roomId]; });
  if (roomSkills.length || skillPins.room || Object.keys(skillPins.users).length) {
    records.push({ name: "skills", data: { skills: roomSkills.map(function (n) { return Object.assign({ name: n }, skillState.skills[n]); }), enabled: skillPins } });
    safeSkills.forEach(function (n) { if (exists(cfg("skills", "store", n))) files.config.push(rel(cfg("skills", "store", n))); });
    count("room skills", roomSkills.length || 1);
  }

  var coachingFiles = [], coachingEntries = [];
  listDir(cfg("prompt-coaching")).forEach(function (f) {
    if (!/\.json$/.test(f)) return;
    var es = arr((readJson(cfg("prompt-coaching", f)) || {}).entries).filter(mine(roomId));
    if (es.length) { coachingFiles.push(f); coachingEntries = coachingEntries.concat(es.map(function (e) { return Object.assign({ file: f }, e); })); }
  });
  if (coachingEntries.length) { records.push({ name: "prompt-coaching", data: coachingEntries }); count("prompt coaching entries", coachingEntries.length); }

  var invites = typeof users.loadUsers === "function" ? arr((users.loadUsers() || {}).invites).filter(mine(roomId)) : [];
  count("invites", invites.length);
  records.push({ name: "room", data: { room: room, invites: invites } });

  // ---- backup (before anything is removed) ----
  var trashDir = trashDirFor(configDir, opts);
  var backup;
  try {
    backup = await writeBackup(trashDir, roomId, { records: records, files: files }, roots,
      { roomId: roomId, roomName: room.name, purgedAt: new Date().toISOString(), actorId: opts.actorId, roots: roots, counts: counts });
  } catch (e) {
    console.error("[room-deletion] backup failed:", e && e.message);
    return { error: "삭제 전 백업을 만들지 못해 아무것도 삭제하지 않았어요.", status: 500 };
  }

  // ---- remove: every item runs, failures are collected ----
  // Images first, then the live in-memory sessions, then the verified session files. A session file (the only record
  // that names its images) goes only once the images are all gone, so a failed image delete is rediscovered by a retry.
  var imageFailed = false;
  imagePaths.forEach(function (p) { step("sessions", function () { try { safeRm(configDir, p); } catch (e) { imageFailed = true; throw e; } }); });
  if (imageFailed) {
    fail("sessions", new Error("session files kept: image cleanup incomplete"));
  } else {
    // Memory state only: the CLI files are never unlinked by the session manager here.
    step("sessions", function () {
      managers.forEach(function (sm) {
        var ids = roomSessions(sm, roomId).map(function (s) { return s.localId; });
        if (ids.length) sm.purgeSessionsKeepFiles(ids);
      });
      var left = managers.reduce(function (n, sm) { return n + roomSessions(sm, roomId).length; }, 0);
      if (left) throw new Error(left + " live sessions remain");
    });
    // Only files the scan verified as this room's.
    sessionFiles.forEach(function (p) { step("sessions", function () { if (isRealFile(p) && chainClean(configDir, p)) fs.unlinkSync(p); }); });
  }

  // The attachment store is a separate module: refuse a scope dir with a symlinked component before it removes anything.
  function attScopeSafe(scope) {
    ["blobs", "meta", "versions", "pending", "transcripts", "video"].forEach(function (d) {
      var dir = path.join(roots.attachments, d, scope);
      if (exists(dir) && !chainClean(roots.attachments, dir)) throw new Error("unsafe attachment path: " + d + "/" + scope);
    });
  }
  // Per channel: workspace and attachments first, the channel record only after both are clean.
  var chanClean = {};
  channels.forEach(function (c) {
    var ok = !channelRejected[c.channelId];
    var wsDir = path.join(agentBase, String(c.ownerUserId), String(c.channelId));
    if (channelDirs.indexOf(wsDir) !== -1) {
      try { safeRm(configDir, wsDir); if (exists(wsDir)) throw new Error("workspace remains"); } catch (e) { ok = false; fail("channel workspaces", e); }
    }
    if (roots.attachments) {
      try {
        attScopeSafe("chan-" + c.channelId);
        var r = attachments.removeChannelAttachments(c.channelId);
        if (r && r.remaining) throw new Error(r.remaining + " channel attachment files remain");
      } catch (e) { ok = false; fail("attachments", e); }
    }
    chanClean[c.channelId] = ok;
  });
  if (roots.attachments) {
    step("attachments", function () {
      attScopeSafe("room-" + roomId);
      var r = attachments.removeRoomAttachments(roomId);
      if (r && r.remaining) throw new Error(r.remaining + " attachment files remain");
      var left = attachments.countRoomAttachments(roomId);
      if (left) throw new Error(left + " attachment files remain");
    });
  }
  for (var i = 0; i < channels.length; i++) {
    if (!chanClean[channels[i].channelId]) continue;
    try { await store.deleteChannel(channels[i].channelId); } catch (e) { fail("channels", e); }
  }

  step("shared posts", function () { safeRm(configDir, postsFile); safeRm(configDir, cfg("shared-posts", "files", roomId)); });
  step("room social", function () { safeRm(configDir, socialFile); });

  step("notifications", function () {
    var done = false;
    if (projects) projects.forEach(function (ctx) {
      var mod = !done && ctx && typeof ctx.getNotificationsModule === "function" ? ctx.getNotificationsModule() : null;
      if (mod && typeof mod.purgeRoom === "function") { mod.purgeRoom(roomId); done = true; }
    });
    if (!done && roomNotifs.length) writeJsonAtomic(notifFile, arr(allNotifs).filter(function (n) { return !(n && n.meta && n.meta.roomId === roomId); }));
  });



  step("orchestration runs and loop records", function () {
    if (projects) projects.forEach(function (ctx) { if (ctx && typeof ctx.purgeRoomData === "function") ctx.purgeRoomData(roomId); });
    orchFiles.forEach(function (f) {
      var file = cfg("orchestration", f), s = readJson(file);
      if (s && Array.isArray(s.runs)) { s.runs = s.runs.filter(function (r) { return !mine(roomId)(r); }); writeJsonAtomic(file, s); }
    });
    loopFiles.forEach(function (f) {
      var file = cfg("loops", f);
      var kept = fs.readFileSync(file, "utf8").split("\n").filter(function (line) {
        if (!line.trim()) return false;
        try { return JSON.parse(line).roomId !== roomId; } catch (_) { return true; }
      });
      writeJsonAtomic(file, kept.length ? kept.join("\n") + "\n" : "");
    });
  });

  step("room skills", function () {
    var r = catalog.purgeRoom(roomId);
    if (r.failed) throw new Error(r.failed + " skill directories could not be removed");
  });

  step("workspace and snapshots", function () {
    if (!exists(roomScope)) return;
    if (!require("./private-agent-scope").removeRoomScope({ roomId: roomId, baseDir: agentBase })) throw new Error("room execution state removal incomplete");
  });

  coachingFiles.forEach(function (f) {
    step("prompt coaching entries", function () {
      var file = cfg("prompt-coaching", f), d = readJson(file);
      if (d && Array.isArray(d.entries)) { d.entries = d.entries.filter(function (e) { return !mine(roomId)(e); }); writeJsonAtomic(file, d); }
    });
  });

  // The room record (settings, approval, invites, memberships) goes last, and only when nothing failed.
  if (!failures.length) {
    var result = users.removeArchivedRoomRecord(roomId);
    if (result.error) fail("room record", new Error(result.error));
  }
  sweepTrash(trashDir, opts.now);

  if (failures.length) {
    var kinds = failures.map(function (f) { return f.kind; }).filter(function (k, n, a) { return a.indexOf(k) === n; });
    return {
      error: "일부 데이터를 삭제하지 못해 방을 보관 상태로 남겨 두었어요 (" + kinds.join(", ") + "). 다시 시도해 주세요.",
      status: 409, failures: failures, counts: counts, backup: backup,
    };
  }
  return { ok: true, counts: counts, backup: backup };
}

module.exports = {  deleteRoomPermanently: deleteRoomPermanently, sweepTrash: sweepTrash, trashDirFor: trashDirFor, ACTIVE_MSG: ACTIVE_MSG };

return module.exports;
});

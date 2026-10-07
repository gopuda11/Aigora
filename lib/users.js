var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var { safeEqual } = require("./safe-equal");
var execFileSync = require("child_process").execFileSync;
var { CONFIG_DIR } = require("./config");
var { attachAuth } = require("./users-auth");
var { DEFAULT_PERMISSIONS, ALL_PERMISSIONS, attachPermissions } = require("./users-permissions");
var { attachPreferences } = require("./users-preferences");

var USERS_FILE = path.join(CONFIG_DIR, "users.json");
var MAX_USERS = 10;

// --- Default data ---

function defaultData() {
  return {
    multiUser: true,
    setupCode: null,
    users: [],
    invites: [],
    rooms: [],
    smtp: null,
  };
}

// --- Load / Save ---

function loadUsers() {
  // Synchronous shim: read from disk directly so existing sync callers keep working.
  // store.js is async-first; we fall back to synchronous fs here because the
  // entire users.js call graph is synchronous and converting all ~79 call sites
  // is a follow-up task (TODO(lr-b372): convert users.js callers to async).
  var raw;
  try {
    raw = fs.readFileSync(USERS_FILE, "utf8");
  } catch (e) {
    // ENOENT is the only case that legitimately means "no users yet" --
    // every other read failure (EACCES, transient I/O error under
    // contention, etc.) must not silently masquerade as an empty user set.
    if (e && e.code === "ENOENT") return defaultData();
    throw e;
  }
  // A parse failure on an existing file means the file is corrupt, not
  // absent. Swallowing this here previously caused findUserById() to return
  // null for every user (lr-ae85d5), surfacing downstream as a confusing
  // "ownerId is null" failure instead of a loud, diagnosable error.
  var data = JSON.parse(raw);
  // Ensure all required fields exist
  if (!data.users) data.users = [];
  if (!data.invites) data.invites = [];
  if (!data.rooms) data.rooms = [];
  if (data.multiUser === undefined) data.multiUser = true;
  if (data.setupCode === undefined) data.setupCode = null;
  if (data.smtp === undefined) data.smtp = null;
  return data;
}

function saveUsers(data) {
  // This module is deliberately synchronous: callers perform read-modify-write
  // transactions and immediately depend on the result. Queuing the same stale
  // snapshot through store.writeJson after the atomic rename creates a second,
  // delayed writer that can overwrite a newer room/member transaction.
  var tmpPath = USERS_FILE + ".tmp." + process.pid;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmpPath, USERS_FILE);
    usersParseCache = null;
    visibleIdsCache = { stamp: null, byUser: {} };
    require("./private-session-revocation").notifyAccessChanged();
  } catch (e) {
    process.stderr.write("[users] saveUsers sync write failed: " + (e && e.message ? e.message : e) + "\n");
    throw e;
  }
}

// --- User CRUD ---

function generateUserId() {
  return crypto.randomUUID();
}

function createUser(opts) {
  var data = loadUsers();
  // Check username uniqueness
  for (var i = 0; i < data.users.length; i++) {
    if (data.users[i].username.toLowerCase() === opts.username.toLowerCase()) {
      return { error: "This username is already taken" };
    }
  }
  // Check email uniqueness (when provided)
  if (opts.email) {
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].email && data.users[i].email.toLowerCase() === opts.email.toLowerCase()) {
        return { error: "This email is already registered" };
      }
    }
  }
  var user = {
    id: generateUserId(),
    username: opts.username,
    email: opts.email || null,
    displayName: opts.displayName || opts.username,
    pinHash: auth.hashPin(opts.pin),
    role: opts.role || "user",
    mustChangePin: !!opts.mustChangePin,
    createdAt: Date.now(),
    linuxUser: opts.linuxUser || null,
    profile: opts.profile || {
      name: opts.displayName || opts.username,
      lang: "en-US",
      avatarColor: "#7c3aed",
      avatarStyle: "thumbs",
      avatarSeed: crypto.randomBytes(4).toString("hex"),
    },
  };
  data.users.push(user);
  saveUsers(data);

  return { ok: true, user: user };
}

function createAdmin(opts) {
  return createUser({
    username: opts.username,
    email: opts.email || null,
    displayName: opts.displayName,
    pin: opts.pin,
    role: "admin",
    profile: opts.profile,
  });
}

function findAdmin(data) {
  if (!data) data = loadUsers();
  for (var i = 0; i < data.users.length; i++) {
    if (data.users[i].role === "admin") return data.users[i];
  }
  return null;
}

function hasAdmin() {
  return !!findAdmin();
}

// findUserById parse cache, keyed by users.json identity (inode+mtime+ctime+size) and dropped on every
// saveUsers. A file touched within the last RACY_MS is never cached (an in-place rewrite inside the
// filesystem timestamp tick could keep the same stamp), so external edits are always seen.
var usersParseCache = null;
var USERS_CACHE_RACY_MS = 2000;
function findUserById(id) {
  var st = null, users;
  try { st = fs.statSync(USERS_FILE); } catch (_) {}
  var stamp = st ? st.ino + ":" + st.mtimeMs + ":" + st.ctimeMs + ":" + st.size : null;
  if (stamp !== null && usersParseCache && usersParseCache.stamp === stamp) {
    users = usersParseCache.users;
  } else {
    users = loadUsers().users;
    usersParseCache = stamp !== null && Date.now() - st.mtimeMs > USERS_CACHE_RACY_MS ? { stamp: stamp, users: users } : null;
  }
  for (var i = 0; i < users.length; i++) {
    // Copy: the cached parse is shared, callers get a private object as when every call re-parsed.
    if (users[i].id === id) return structuredClone(users[i]);
  }
  return null;
}

function findUserByUsername(username) {
  var data = loadUsers();
  for (var i = 0; i < data.users.length; i++) {
    if (data.users[i].username.toLowerCase() === username.toLowerCase()) return data.users[i];
  }
  return null;
}

function findUserByEmail(email) {
  var data = loadUsers();
  for (var i = 0; i < data.users.length; i++) {
    if (data.users[i].email && data.users[i].email.toLowerCase() === email.toLowerCase()) return data.users[i];
  }
  return null;
}

function getAllUsers() {
  var data = loadUsers();
  return data.users.map(function (u) {
    return {
      id: u.id,
      username: u.username,
      email: u.email || null,
      displayName: u.displayName,
      role: u.role,
      createdAt: u.createdAt,
      profile: u.profile,
      linuxUser: u.linuxUser || null,
      permissions: u.permissions || null,
    };
  });
}

function getOtherUsers(excludeUserId) {
  return getAllUsers().filter(function (u) {
    return u.id !== excludeUserId;
  });
}

// --- Club Agora rooms ---

function cleanRoomName(value) {
  return typeof value === "string" ? value.trim().substring(0, 60) : "";
}

function publicRoom(room, userId) {
  var membership = (room.members || []).find(function (m) { return m.userId === userId; });
  return {
    id: room.id,
    name: room.name,
    description: room.description || "",
    role: room.ownerId === userId ? "owner" : (membership ? membership.role : "viewer"),
    ownerId: room.ownerId,
    archived: !!room.archived,
    createdAt: room.createdAt,
    memberCount: (room.members || []).length,
  };
}

function createRoom(ownerId, name, description) {
  var roomName = cleanRoomName(name);
  if (!roomName) return { error: "Room name is required" };
  var data = loadUsers();
  var owner = data.users.find(function (u) { return u.id === ownerId; });
  if (!owner || owner.role !== "admin") return { error: "Owner access required" };
  var room = {
    id: "room-" + crypto.randomBytes(9).toString("base64url"),
    name: roomName,
    description: typeof description === "string" ? description.trim().substring(0, 240) : "",
    ownerId: ownerId,
    members: [{ userId: ownerId, role: "owner", joinedAt: Date.now() }],
    createdAt: Date.now(),
    archived: false,
  };
  data.rooms.push(room);
  if (!Array.isArray(owner.roomIds)) owner.roomIds = [];
  if (owner.roomIds.indexOf(room.id) === -1) owner.roomIds.push(room.id);
  saveUsers(data);
  return { ok: true, room: publicRoom(room, ownerId) };
}

function findRoomById(roomId, data) {
  data = data || loadUsers();
  return data.rooms.find(function (room) { return room.id === roomId; }) || null;
}

// Rooms under permanent deletion (lib/room-deletion.js): no access, no restore, no second purge.
var purgingRooms = new Set();
function beginRoomPurge(roomId) { if (purgingRooms.has(roomId)) return false; purgingRooms.add(roomId); return true; }
function endRoomPurge(roomId) { purgingRooms.delete(roomId); }
function isRoomPurging(roomId) { return purgingRooms.has(roomId); }

function canAccessRoom(userId, roomId, data) {
  if (purgingRooms.has(roomId)) return false;
  data = data || loadUsers();
  var user = data.users.find(function (u) { return u.id === userId; });
  var room = findRoomById(roomId, data);
  if (!user || !room || room.archived) return false;
  if (user.role === "admin" || room.ownerId === userId) return true;
  return (room.members || []).some(function (m) { return m.userId === userId; });
}

// Effective role inside one room, or null without active access. Admins and
// the room owner are "owner"; an unknown membership role degrades to "viewer".
function getRoomRole(userId, roomId, data) {
  data = data || loadUsers();
  if (!canAccessRoom(userId, roomId, data)) return null;
  var user = data.users.find(function (u) { return u.id === userId; });
  var room = findRoomById(roomId, data);
  if (user.role === "admin" || room.ownerId === userId) return "owner";
  var membership = (room.members || []).find(function (m) { return m.userId === userId; });
  var role = membership && membership.role;
  return role === "owner" || role === "member" ? role : "viewer";
}

// A member's display name everywhere a person is named: the profile nickname, else the account name.
function nicknameOf(user) {
  return (user && user.profile && user.profile.name) || (user && user.displayName) || "Member";
}

// The room's roster as every member of it may see it (rooms_state -> the 참여자 tab): id, nickname
// and role only. Login usernames are never part of a roster. Owner first, then join order.
function roomRoster(room, data) {
  var out = [];
  (room.members || []).forEach(function (membership) {
    var user = data.users.find(function (u) { return u.id === membership.userId; });
    if (!user) return;
    var role = room.ownerId === user.id ? "owner" : (membership.role === "owner" || membership.role === "member" ? membership.role : "viewer");
    out.push({ id: user.id, name: nicknameOf(user), role: role });
  });
  return out.sort(function (a, b) { return (b.role === "owner") - (a.role === "owner"); });
}

function getRoomsForUser(userId) {
  var data = loadUsers();
  var user = data.users.find(function (u) { return u.id === userId; });
  if (!user) return [];
  return data.rooms.filter(function (room) {
    if (room.archived) return false;
    return user.role === "admin" || room.ownerId === userId ||
      (room.members || []).some(function (m) { return m.userId === userId; });
  }).map(function (room) {
    var out = publicRoom(room, userId);
    out.members = roomRoster(room, data);
    return out;
  });
}

// Ids of the users a person may see anywhere presence or a user list is shown:
// themselves plus everyone who shares a non-archived room with them (members and
// the room owner). null means unrestricted (admins). Unknown user: only themselves.
var visibleIdsCache = { stamp: null, byUser: {} };
function getVisibleUserIds(userId) {
  // Cursor events call this per recipient; memoise per users.json version (mtime+size, and
  // dropped on every saveUsers) instead of re-parsing the file each time.
  var stamp = null;
  try { var st = fs.statSync(USERS_FILE); stamp = st.mtimeMs + ":" + st.size; } catch (_) {}
  if (stamp === null || visibleIdsCache.stamp !== stamp) visibleIdsCache = { stamp: stamp, byUser: {} };
  if (Object.prototype.hasOwnProperty.call(visibleIdsCache.byUser, userId)) return visibleIdsCache.byUser[userId];
  var data = loadUsers();
  var user = data.users.find(function (u) { return u.id === userId; });
  var ids;
  if (user && user.role === "admin") {
    ids = null;
  } else {
    ids = {};
    ids[userId] = true;
    if (user) data.rooms.forEach(function (room) {
      if (room.archived) return;
      var members = room.members || [];
      var inRoom = room.ownerId === userId || members.some(function (m) { return m.userId === userId; });
      if (!inRoom) return;
      if (room.ownerId) ids[room.ownerId] = true;
      members.forEach(function (m) { ids[m.userId] = true; });
    });
  }
  if (stamp !== null) visibleIdsCache.byUser[userId] = ids;
  return ids;
}

// Tool-approval settings of a room's contained AI turns (lib/room-risk-policy.js). Missing/invalid = defaults.
var APPROVAL_LEVELS = ["always", "risky", "never"];
function roomApproval(roomId) {
  var room = findRoomById(roomId);
  var a = room && room.approval && typeof room.approval === "object" ? room.approval : {};
  return {
    level: APPROVAL_LEVELS.indexOf(a.level) >= 0 ? a.level : "risky",
    requesterCanApprove: a.requesterCanApprove === true,
    askPatterns: Array.isArray(a.askPatterns) ? a.askPatterns.filter(function (p) { return typeof p === "string" && p.trim(); }).slice(0, 50) : [],
  };
}

function setRoomApproval(actorId, roomId, input) {
  var data = loadUsers();
  var actor = data.users.find(function (u) { return u.id === actorId; });
  if (!actor || actor.role !== "admin") return { error: "Admin access required" };
  var room = findRoomById(roomId, data);
  if (!room) return { error: "Room not found" };
  input = input && typeof input === "object" ? input : {};
  var cur = roomApproval(roomId);
  if (input.level !== undefined) {
    if (APPROVAL_LEVELS.indexOf(input.level) < 0) return { error: "Invalid approval level" };
    cur.level = input.level;
  }
  if (input.requesterCanApprove !== undefined) cur.requesterCanApprove = input.requesterCanApprove === true;
  if (input.askPatterns !== undefined) {
    if (!Array.isArray(input.askPatterns)) return { error: "Invalid ask patterns" };
    cur.askPatterns = input.askPatterns.filter(function (p) { return typeof p === "string"; })
      .map(function (p) { return p.trim().replace(/\s+/g, " ").substring(0, 80); }).filter(Boolean).slice(0, 50);
  }
  room.approval = cur;
  saveUsers(data);
  return { ok: true, approval: cur };
}

// Who may manage a room's skills: "members" (role member or above, the default) or "admins" (administrators and the room owner only).
function roomSkillManagers(roomId) {
  var room = findRoomById(roomId);
  return room && room.skillManagers === "admins" ? "admins" : "members";
}

function setRoomSkillManagers(actorId, roomId, value) {
  var data = loadUsers();
  var actor = data.users.find(function (u) { return u.id === actorId; });
  if (!actor || actor.role !== "admin") return { error: "Admin access required" };
  var room = findRoomById(roomId, data);
  if (!room) return { error: "Room not found" };
  if (value !== "admins" && value !== "members") return { error: "Invalid skill managers" };
  room.skillManagers = value;
  saveUsers(data);
  return { ok: true, skillManagers: value };
}

// Archive / restore a room (admin only). canAccessRoom already denies archived
// rooms, and saveUsers() notifies private-session revocation.
function setRoomArchived(actorId, roomId, archived) {
  var data = loadUsers();
  var actor = data.users.find(function (u) { return u.id === actorId; });
  if (!actor || actor.role !== "admin") return { error: "Admin access required" };
  var room = findRoomById(roomId, data);
  if (!room) return { error: "Room not found" };
  if (purgingRooms.has(roomId)) return { error: "Room is being deleted" };
  room.archived = !!archived;
  saveUsers(data);
  return { ok: true, room: publicRoom(room, actorId) };
}

// Archived rooms are only ever listed here, for admins, so they can be restored or deleted.
function getArchivedRooms(actorId) {
  var data = loadUsers();
  var actor = data.users.find(function (u) { return u.id === actorId; });
  if (!actor || actor.role !== "admin") return { error: "Admin access required" };
  return { ok: true, rooms: data.rooms.filter(function (room) { return room.archived; }).map(function (room) { return publicRoom(room, actorId); }) };
}

// Final step of permanent deletion (lib/room-deletion.js): the room record, its
// id in every user's roomIds and its invites. Room-bound data is the caller's job.
function removeArchivedRoomRecord(roomId) {
  var data = loadUsers();
  var room = findRoomById(roomId, data);
  if (!room) return { error: "Room not found" };
  if (!room.archived) return { error: "Room must be archived before it can be deleted" };
  data.rooms = data.rooms.filter(function (r) { return r.id !== roomId; });
  data.users.forEach(function (u) {
    if (Array.isArray(u.roomIds)) u.roomIds = u.roomIds.filter(function (id) { return id !== roomId; });
  });
  data.invites = data.invites.filter(function (inv) { return inv.roomId !== roomId; });
  saveUsers(data);
  return { ok: true };
}

function getRoomMembers(actorId, roomId) {
  var data = loadUsers();
  var actor = data.users.find(function (u) { return u.id === actorId; });
  var room = findRoomById(roomId, data);
  if (!actor || !room || (actor.role !== "admin" && room.ownerId !== actorId)) {
    return { error: "Owner access required" };
  }
  if (room.archived && actor.role !== "admin") return { error: "Owner access required" };
  var memberships = room.members || [];
  var members = memberships.map(function (membership) {
    var user = data.users.find(function (u) { return u.id === membership.userId; });
    if (!user) return null;
    return {
      id: user.id,
      displayName: nicknameOf(user),
      username: user.username,
      role: membership.role || "member",
      joinedAt: membership.joinedAt || user.createdAt,
    };
  }).filter(Boolean);
  return { ok: true, room: publicRoom(room, actorId), members: members };
}

// Room roles an owner may assign. The owner's own membership is immutable.
// Room membership change feed (member added, removed, role changed, user deleted). Listeners get the affected room ids, or
// null when they cannot be named (listeners then treat every room as affected). A throwing listener never fails the change.
var membershipListeners = [];
function onRoomMembershipChange(fn) { if (typeof fn === "function") membershipListeners.push(fn); }
function emitRoomMembershipChange(roomIds) {
  membershipListeners.slice().forEach(function (fn) { try { fn(roomIds); } catch (e) { console.error("[users] membership listener failed"); } });
}

var ASSIGNABLE_ROOM_ROLES = ["member", "viewer"];

function updateRoomMemberRole(actorId, roomId, userId, role) {
  var data = loadUsers();
  var actor = data.users.find(function (u) { return u.id === actorId; });
  var room = findRoomById(roomId, data);
  if (!actor || !room || (actor.role !== "admin" && room.ownerId !== actorId)) {
    return { error: "Owner access required" };
  }
  if (ASSIGNABLE_ROOM_ROLES.indexOf(role) === -1) return { error: "Role must be member or viewer" };
  if (room.ownerId === userId) return { error: "Cannot change the room owner's role" };
  var membership = (room.members || []).find(function (m) { return m.userId === userId; });
  if (!membership) return { error: "Member not found" };
  if (membership.role === "owner") return { error: "Cannot change the room owner's role" };
  membership.role = role;
  saveUsers(data);
  emitRoomMembershipChange([roomId]);
  return { ok: true, member: { id: userId, role: role } };
}

function removeRoomMember(actorId, roomId, userId) {
  var data = loadUsers();
  var actor = data.users.find(function (u) { return u.id === actorId; });
  var room = findRoomById(roomId, data);
  if (!actor || !room || (actor.role !== "admin" && room.ownerId !== actorId)) {
    return { error: "Owner access required" };
  }
  if (room.ownerId === userId) return { error: "Cannot remove the room owner" };
  var before = (room.members || []).length;
  room.members = (room.members || []).filter(function (m) { return m.userId !== userId; });
  if (room.members.length === before) return { error: "Member not found" };
  var user = data.users.find(function (u) { return u.id === userId; });
  if (user && Array.isArray(user.roomIds)) {
    user.roomIds = user.roomIds.filter(function (id) { return id !== roomId; });
  }
  saveUsers(data);
  emitRoomMembershipChange([roomId]);
  return { ok: true };
}

function removeUser(userId) {
  var data = loadUsers();
  var before = data.users.length;
  data.users = data.users.filter(function (u) { return u.id !== userId; });
  if (data.users.length === before) return { error: "User not found" };
  var affected = [];
  data.rooms.forEach(function (room) {
    if (room.ownerId === userId || (room.members || []).some(function (m) { return m.userId === userId; })) affected.push(room.id);
    room.members = (room.members || []).filter(function (m) { return m.userId !== userId; });
  });
  saveUsers(data);
  emitRoomMembershipChange(affected);
  return { ok: true };
}

function updateUserProfile(userId, profile) {
  var data = loadUsers();
  for (var i = 0; i < data.users.length; i++) {
    if (data.users[i].id === userId) {
      data.users[i].profile = profile;
      // Member lists and chips read profile.name first, then displayName; keep them one nickname.
      if (typeof profile.name === "string" && profile.name.trim()) data.users[i].displayName = profile.name.trim();
      saveUsers(data);
      return { ok: true, profile: profile };
    }
  }
  return { error: "User not found" };
}

function updateUserPin(userId, newPin) {
  var data = loadUsers();
  for (var i = 0; i < data.users.length; i++) {
    if (data.users[i].id === userId) {
      data.users[i].pinHash = auth.hashPin(newPin);
      data.users[i].mustChangePin = false;
      saveUsers(data);
      return { ok: true };
    }
  }
  return { error: "User not found" };
}

// Login ID chosen by the member (invite sign-up, first-time setup). The admin "add user"
// path only requires a non-empty name; self-chosen IDs also get a safe shape, stay unique
// case-insensitively and never use the reserved "guest-" prefix of generated accounts.
var LOGIN_ID_RE = /^[A-Za-z0-9._-]{3,30}$/;
function checkLoginId(raw, data, exceptUserId) {
  var id = typeof raw === "string" ? raw.trim() : "";
  if (!LOGIN_ID_RE.test(id)) return { error: "아이디는 영문, 숫자, . _ - 로 3~30자여야 합니다" };
  if (id.toLowerCase().indexOf("guest-") === 0) return { error: "사용할 수 없는 아이디입니다" };
  for (var i = 0; i < data.users.length; i++) {
    if (data.users[i].id !== exceptUserId && String(data.users[i].username).toLowerCase() === id.toLowerCase()) {
      return { error: "이미 사용 중인 아이디입니다" };
    }
  }
  return { ok: true, username: id };
}

// For accounts created without a PIN (invite guests from before sign-up existed):
// set the login ID and first PIN once. Refuses when a PIN already exists.
function setInitialCredentials(userId, username, pin) {
  if (typeof pin !== "string" || !/^\d{6}$/.test(pin)) return { error: "PIN은 숫자 6자리여야 합니다" };
  var data = loadUsers();
  var user = null;
  for (var i = 0; i < data.users.length; i++) if (data.users[i].id === userId) user = data.users[i];
  if (!user) return { error: "User not found" };
  if (user.pinHash) return { error: "이미 PIN이 설정되어 있습니다" };
  var check = checkLoginId(username, data, userId);
  if (check.error) return check;
  user.username = check.username;
  user.pinHash = auth.hashPin(pin);
  user.mustChangePin = false;
  saveUsers(data);
  return { ok: true, user: user };
}

// Admin creates a user with a temporary PIN (must be changed on first login)
function createUserByAdmin(opts) {
  var tempPin = auth.generatePin();
  var result = createUser({
    username: opts.username,
    displayName: opts.displayName || opts.username,
    email: opts.email || null,
    pin: tempPin,
    role: opts.role || "user",
    mustChangePin: true,
  });
  if (result.error) return result;
  return { ok: true, user: result.user, tempPin: tempPin };
}

// --- Linux user mapping (OS-level multi-user) ---

function updateLinuxUser(userId, linuxUsername) {
  // Allow null/empty to unset
  if (!linuxUsername) {
    var data = loadUsers();
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === userId) {
        data.users[i].linuxUser = null;
        saveUsers(data);
        return { ok: true };
      }
    }
    return { error: "User not found" };
  }

  // Validate username format
  if (!/^[a-z_][a-z0-9_-]*$/.test(linuxUsername)) {
    return { error: "Invalid Linux username format" };
  }

  // Validate Linux user exists
  try {
    execFileSync("id", [linuxUsername], { encoding: "utf8", timeout: 5000, stdio: "pipe" });
  } catch (e) {
    return { error: "Linux user '" + linuxUsername + "' does not exist" };
  }

  var data = loadUsers();
  for (var i = 0; i < data.users.length; i++) {
    if (data.users[i].id === userId) {
      data.users[i].linuxUser = linuxUsername;
      saveUsers(data);
      return { ok: true };
    }
  }
  return { error: "User not found" };
}

// --- Invite links ---

function hashInviteCode(code) {
  return crypto.createHash("sha256").update("club-agora-invite:" + String(code || "")).digest("hex");
}

function inviteMatches(invite, code) {
  if (!invite || !code) return false;
  // Legacy installs stored the raw code. Accept it until it is redeemed or
  // revoked; all newly issued Club Agora invites store only a SHA-256 digest.
  if (invite.code) return safeEqual(invite.code, code);
  if (!invite.codeHash) return false;
  var actual = hashInviteCode(code);
  if (actual.length !== invite.codeHash.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(invite.codeHash, "hex"));
}

function publicInvite(invite, data) {
  // Who redeemed it: redeemedBy (recorded on redemption), else the guest account that
  // carries this invite's id (older codes). null = no record.
  var redeemer = null;
  if (invite.used && data) {
    redeemer = data.users.find(function (u) { return u.id === invite.redeemedBy; })
      || data.users.find(function (u) { return invite.id && u.inviteId === invite.id; }) || null;
  }
  return {
    redeemedBy: redeemer ? redeemer.id : null,
    redeemedByName: redeemer ? (redeemer.displayName || (redeemer.profile && redeemer.profile.name) || redeemer.username) : null,
    id: invite.id || null,
    codePrefix: invite.codePrefix || (invite.code ? invite.code.substring(0, 4) : null),
    createdBy: invite.createdBy,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    used: !!invite.used,
    usedAt: invite.usedAt || null,
    revokedAt: invite.revokedAt || null,
    roomId: invite.roomId || null,
  };
}

function createInvite(createdByUserId, targetEmail, opts) {
  var data = loadUsers();
  opts = opts || {};
  if (opts.roomId) {
    var targetRoom = findRoomById(opts.roomId, data);
    var creator = data.users.find(function (u) { return u.id === createdByUserId; });
    if (!targetRoom || !creator || (creator.role !== "admin" && targetRoom.ownerId !== createdByUserId)) {
      return { error: "Room owner access required" };
    }
  }
  var activeInvites = data.invites.filter(function (inv) {
    return !inv.used && !inv.revokedAt && inv.expiresAt > Date.now();
  }).length;
  if (data.users.length + activeInvites >= MAX_USERS) return { error: "Member limit reached" };
  // 16 characters gives materially more entropy than a human PIN while still
  // being easy to pass as a link. The plaintext exists only in this response.
  var code = crypto.randomBytes(12).toString("base64url");
  var invite = {
    id: crypto.randomUUID(),
    codeHash: hashInviteCode(code),
    codePrefix: code.substring(0, 4),
    createdBy: createdByUserId,
    createdAt: Date.now(),
    expiresAt: Date.now() + (opts.ttlMs || 7 * 24 * 60 * 60 * 1000),
    used: false,
    roomId: opts.roomId || null,
  };
  if (targetEmail) invite.email = targetEmail;
  data.invites.push(invite);
  saveUsers(data);
  var result = publicInvite(invite);
  result.code = code;
  return result;
}

function findInvite(code) {
  var data = loadUsers();
  for (var i = 0; i < data.invites.length; i++) {
    if (inviteMatches(data.invites[i], code)) return data.invites[i];
  }
  return null;
}

function validateInvite(code) {
  var invite = findInvite(code);
  if (!invite) return { valid: false, error: "Invite not found" };
  if (invite.revokedAt) return { valid: false, error: "Invite revoked" };
  if (invite.used) return { valid: false, error: "Invite already used" };
  if (Date.now() > invite.expiresAt) return { valid: false, error: "Invite expired" };
  return { valid: true, invite: invite };
}

function getInvites() {
  var data = loadUsers();
  return data.invites.map(function (inv) { return publicInvite(inv, data); });
}

function revokeInvite(identifier) {
  var data = loadUsers();
  var found = false;
  for (var i = 0; i < data.invites.length; i++) {
    var inv = data.invites[i];
    if (inv.id === identifier || inviteMatches(inv, identifier)) {
      inv.revokedAt = Date.now();
      found = true;
      break;
    }
  }
  if (!found) return { error: "Invite not found" };
  saveUsers(data);
  return { ok: true };
}

// Remove the invite record. An unused, unrevoked code is revoked first (in the same save),
// so the link can never work after this. The redeemer's account/membership is untouched.
function deleteInvite(identifier) {
  var data = loadUsers();
  for (var i = 0; i < data.invites.length; i++) {
    var inv = data.invites[i];
    if (inv.id === identifier || inviteMatches(inv, identifier)) {
      var wasLive = !inv.used && !inv.revokedAt;
      if (wasLive) inv.revokedAt = Date.now();
      data.invites.splice(i, 1);
      saveUsers(data);
      return { ok: true, wasLive: wasLive };
    }
  }
  return { error: "Invite not found" };
}

// Redeem an invite and create the minimum durable identity needed for audit,
// per-member revocation and room authorization. There is no account password,
// email or username choice. The browser receives a normal device session from
// server-auth after this succeeds.
// credentials = { username, pin }: the sign-up form of the invite page. Without it
// (internal callers only; the HTTP route always requires it) the account is a
// PIN-less "guest-<hex>" one.
function redeemInvite(code, displayName, credentials) {
  var name = typeof displayName === "string" ? displayName.trim() : "";
  if (!name || name.length > 40) return { error: "닉네임은 1~40자여야 합니다" };
  if (credentials && (typeof credentials.pin !== "string" || !/^\d{6}$/.test(credentials.pin))) {
    return { error: "PIN은 숫자 6자리여야 합니다" };
  }
  var data = loadUsers();
  var invite = null;
  for (var i = 0; i < data.invites.length; i++) {
    if (inviteMatches(data.invites[i], code)) { invite = data.invites[i]; break; }
  }
  if (!invite) return { error: "Invite not found", invalidInvite: true };
  if (invite.revokedAt) return { error: "Invite revoked", invalidInvite: true };
  if (invite.used) return { error: "Invite already used", invalidInvite: true };
  if (Date.now() > invite.expiresAt) return { error: "Invite expired", invalidInvite: true };
  if (data.users.length >= MAX_USERS) return { error: "Member limit reached" };
  var room = null;
  if (invite.roomId) {
    room = findRoomById(invite.roomId, data);
    if (!room || room.archived) return { error: "Room is unavailable" };
  }
  var loginId = null;
  if (credentials) {
    var check = checkLoginId(credentials.username, data, null);
    if (check.error) return check;
    loginId = check.username;
  }

  var id = generateUserId();
  var user = {
    id: id,
    username: loginId || "guest-" + id.replace(/-/g, "").substring(0, 12),
    email: null,
    displayName: name,
    pinHash: credentials ? auth.hashPin(credentials.pin) : null,
    role: "user",
    accountType: "invite_guest",
    inviteId: invite.id || null,
    roomIds: invite.roomId ? [invite.roomId] : [],
    createdAt: Date.now(),
    linuxUser: null,
    profile: {
      name: name,
      lang: "ko-KR",
      avatarColor: "#007aff",
      avatarStyle: "thumbs",
      avatarSeed: crypto.randomBytes(4).toString("hex"),
    },
  };
  invite.used = true;
  invite.usedAt = Date.now();
  invite.redeemedBy = id;
  data.users.push(user);
  if (room) {
    room.members = room.members || [];
    room.members.push({ userId: id, role: "member", joinedAt: Date.now() });
  }
  saveUsers(data);
  if (room) emitRoomMembershipChange([room.id]);
  return { ok: true, user: user, roomId: invite.roomId || null };
}

function removeExpiredInvites() {
  var data = loadUsers();
  var now = Date.now();
  var before = data.invites.length;
  data.invites = data.invites.filter(function (inv) {
    return !inv.used && inv.expiresAt > now;
  });
  if (data.invites.length !== before) saveUsers(data);
}

// --- Wire extracted modules ---

var auth = attachAuth({ loadUsers: loadUsers, saveUsers: saveUsers, findAdmin: findAdmin });
var permissions = attachPermissions({ loadUsers: loadUsers, saveUsers: saveUsers, findUserById: findUserById, canAccessRoom: canAccessRoom, getRoomRole: getRoomRole });
var preferences = attachPreferences({ loadUsers: loadUsers, saveUsers: saveUsers });

// Alias auth functions
var getSetupCode = auth.getSetupCode;
var clearSetupCode = auth.clearSetupCode;
var validateSetupCode = auth.validateSetupCode;
var hashPin = auth.hashPin;
var generatePin = auth.generatePin;
var authenticateUser = auth.authenticateUser;
var verifyPin = auth.verifyPin;
var generateUserAuthToken = auth.generateUserAuthToken;
var parseAuthCookie = auth.parseAuthCookie;

// Alias permissions functions
var getEffectivePermissions = permissions.getEffectivePermissions;
var updateUserPermissions = permissions.updateUserPermissions;
var canAccessProject = permissions.canAccessProject;
var getAccessibleProjects = permissions.getAccessibleProjects;
var canAccessSession = permissions.canAccessSession;
var canReadPersonalSession = permissions.canReadPersonalSession;
var canMutatePersonalSession = permissions.canMutatePersonalSession;

// Alias preferences functions
var getDmFavorites = preferences.getDmFavorites;
var addDmFavorite = preferences.addDmFavorite;
var removeDmFavorite = preferences.removeDmFavorite;
var getDmHidden = preferences.getDmHidden;
var addDmHidden = preferences.addDmHidden;
var removeDmHidden = preferences.removeDmHidden;
var getChatLayout = preferences.getChatLayout;
var setChatLayout = preferences.setChatLayout;
var getThemeMode = preferences.getThemeMode;
var setThemeMode = preferences.setThemeMode;
var getThemeBrand = preferences.getThemeBrand;
var setThemeBrand = preferences.setThemeBrand;
var getAutoContinue = preferences.getAutoContinue;
var setAutoContinue = preferences.setAutoContinue;
var setOnboardingSeen = preferences.setOnboardingSeen;
var setDisplayPrefs = preferences.setDisplayPrefs;
var displayPrefsOf = preferences.displayPrefsOf;
var getToolPalettes = preferences.getToolPalettes;
var setToolPalette = preferences.setToolPalette;

module.exports = {
  beginRoomPurge: beginRoomPurge, endRoomPurge: endRoomPurge, isRoomPurging: isRoomPurging,
  USERS_FILE: USERS_FILE,
  loadUsers: loadUsers,
  saveUsers: saveUsers,
  getSetupCode: getSetupCode,
  clearSetupCode: clearSetupCode,
  validateSetupCode: validateSetupCode,
  hashPin: hashPin,
  verifyPin: verifyPin,
  createUser: createUser,
  createAdmin: createAdmin,
  findAdmin: findAdmin,
  hasAdmin: hasAdmin,
  findUserById: findUserById,
  findUserByEmail: findUserByEmail,
  authenticateUser: authenticateUser,
  getAllUsers: getAllUsers,
  removeUser: removeUser,
  onRoomMembershipChange: onRoomMembershipChange,
  updateUserProfile: updateUserProfile,
  updateUserPin: updateUserPin,
  setInitialCredentials: setInitialCredentials,
  generateUserAuthToken: generateUserAuthToken,
  parseAuthCookie: parseAuthCookie,
  createInvite: createInvite,
  redeemInvite: redeemInvite,
  validateInvite: validateInvite,
  revokeInvite: revokeInvite,
  deleteInvite: deleteInvite,
  getInvites: getInvites,
  createRoom: createRoom,
  findRoomById: findRoomById,
  canAccessRoom: canAccessRoom,
  getRoomRole: getRoomRole,
  getRoomsForUser: getRoomsForUser,
  getVisibleUserIds: getVisibleUserIds,
  getRoomMembers: getRoomMembers,
  setRoomArchived: setRoomArchived,
  roomApproval: roomApproval,
  setRoomApproval: setRoomApproval,
  getArchivedRooms: getArchivedRooms,
  removeArchivedRoomRecord: removeArchivedRoomRecord,
  removeRoomMember: removeRoomMember,
  updateRoomMemberRole: updateRoomMemberRole,
  roomSkillManagers: roomSkillManagers,
  setRoomSkillManagers: setRoomSkillManagers,
  canAccessProject: canAccessProject,
  getAccessibleProjects: getAccessibleProjects,
  canAccessSession: canAccessSession,
  canReadPersonalSession: canReadPersonalSession,
  canMutatePersonalSession: canMutatePersonalSession,
  updateLinuxUser: updateLinuxUser,
  generatePin: generatePin,
  createUserByAdmin: createUserByAdmin,
  DEFAULT_PERMISSIONS: DEFAULT_PERMISSIONS,
  getEffectivePermissions: getEffectivePermissions,
  updateUserPermissions: updateUserPermissions,
  getDmFavorites: getDmFavorites,
  addDmFavorite: addDmFavorite,
  removeDmFavorite: removeDmFavorite,
  getDmHidden: getDmHidden,
  addDmHidden: addDmHidden,
  removeDmHidden: removeDmHidden,
  getChatLayout: getChatLayout,
  setChatLayout: setChatLayout,
  getThemeMode: getThemeMode,
  setThemeMode: setThemeMode,
  getThemeBrand: getThemeBrand,
  setThemeBrand: setThemeBrand,
  getAutoContinue: getAutoContinue,
  setAutoContinue: setAutoContinue,
  setOnboardingSeen: setOnboardingSeen,
  setDisplayPrefs: setDisplayPrefs,
  displayPrefsOf: displayPrefsOf,
  getToolPalettes: getToolPalettes,
  setToolPalette: setToolPalette,
  MAX_USERS: MAX_USERS,
};

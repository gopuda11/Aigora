"use strict";
var fs = require("node:fs");
var path = require("node:path");
var crypto = require("node:crypto");

var STORE_VERSION = 1;
var STORE_FILE = "personal-channels.json";
var LOCK_FILE = ".personal-channels.lock";
var LOCK_TIMEOUT_MS = 10000;
var LOCK_RETRY_MS = 10;
var SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
var FORBIDDEN_KEYS = new Set(["__" + "proto__", "prototype", "con" + "structor"]);

function codedError(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

function assertSafeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value) || FORBIDDEN_KEYS.has(value)) {
    throw codedError("ERR_PERSONAL_CHANNEL_ID", "Invalid " + label);
  }
  return value;
}

var MAX_NAME = 30;

// The owner's custom channel name: trimmed, 1-30 characters; "" / absent = the default label.
function cleanName(value) {
  if (value == null) return "";
  if (typeof value !== "string") throw codedError("ERR_PERSONAL_CHANNEL_NAME", "Invalid channel name");
  var name = value.trim();
  if (Array.from(name).length > MAX_NAME) throw codedError("ERR_PERSONAL_CHANNEL_NAME", "Channel name is too long");
  return name;
}

function cloneRecord(record) {
  var out = {
    channelId: record.channelId,
    roomId: record.roomId,
    ownerUserId: record.ownerUserId,
    createdAt: record.createdAt,
    state: record.state,
  };
  if (record.name) out.name = record.name;
  return out;
}

function emptyStore() {
  return { version: STORE_VERSION, channels: [] };
}

function normalizeRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw codedError("ERR_PERSONAL_CHANNEL_STORE", "Invalid personal channel record");
  }
  var record = {
    channelId: assertSafeId(value.channelId, "channelId"),
    roomId: assertSafeId(value.roomId, "roomId"),
    ownerUserId: assertSafeId(value.ownerUserId, "ownerUserId"),
    createdAt: value.createdAt,
    state: value.state,
  };
  if (!Number.isInteger(record.createdAt) || record.createdAt <= 0) {
    throw codedError("ERR_PERSONAL_CHANNEL_STORE", "Invalid personal channel createdAt");
  }
  if (record.state !== "active" && record.state !== "archived" && record.state !== "closed") {
    throw codedError("ERR_PERSONAL_CHANNEL_STORE", "Invalid personal channel state");
  }
  if (value.name !== undefined) {
    var name;
    try { name = cleanName(value.name); } catch (_) {
      throw codedError("ERR_PERSONAL_CHANNEL_STORE", "Invalid personal channel name");
    }
    if (name) record.name = name;
  }
  return record;
}

function parseStore(raw) {
  var parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    throw codedError("ERR_PERSONAL_CHANNEL_STORE", "Personal channel store contains invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || parsed.version !== STORE_VERSION || !Array.isArray(parsed.channels)) {
    throw codedError("ERR_PERSONAL_CHANNEL_STORE", "Unsupported personal channel store format");
  }
  var channels = parsed.channels.map(normalizeRecord);
  var ids = new Set();
  var activeOwners = new Set();
  for (var i = 0; i < channels.length; i++) {
    var item = channels[i];
    if (ids.has(item.channelId)) {
      throw codedError("ERR_PERSONAL_CHANNEL_STORE", "Duplicate personal channel ID");
    }
    ids.add(item.channelId);
    if (item.state === "active") {
      var key = item.roomId + "|" + item.ownerUserId;
      if (activeOwners.has(key)) {
        throw codedError("ERR_PERSONAL_CHANNEL_STORE", "Duplicate active personal channel owner");
      }
      activeOwners.add(key);
    }
  }
  return { version: STORE_VERSION, channels: channels };
}

async function readStore(filePath) {
  var raw;
  try {
    raw = await fs.promises.readFile(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return emptyStore();
    throw err;
  }
  return parseStore(raw);
}

async function writeStoreAtomic(filePath, store, verifyLock) {
  var dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  var tmp = filePath + ".tmp." + process.pid + "." + crypto.randomBytes(6).toString("hex");
  try {
    await fs.promises.writeFile(tmp, JSON.stringify(store, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (verifyLock) await verifyLock();
    await fs.promises.rename(tmp, filePath);
    if (process.platform !== "win32") await fs.promises.chmod(filePath, 0o600).catch(function () {});
  } catch (err) {
    await fs.promises.unlink(tmp).catch(function () {});
    throw err;
  }
}

function sameLockIdentity(stat, lock) {
  return Boolean(stat) && stat.dev === lock.dev && stat.ino === lock.ino;
}

function lockOwnershipError(message) {
  return codedError("ERR_PERSONAL_CHANNEL_LOCK", message || "Personal channel store lock ownership was lost");
}

async function assertLockOwned(lockPath, lock) {
  var stat;
  try {
    stat = await fs.promises.stat(lockPath);
  } catch (err) {
    if (err && err.code === "ENOENT") throw lockOwnershipError();
    throw err;
  }
  if (!sameLockIdentity(stat, lock)) throw lockOwnershipError();
  var raw;
  try {
    raw = await fs.promises.readFile(lock.ownerPath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") throw lockOwnershipError();
    throw err;
  }
  var owner;
  try {
    owner = JSON.parse(raw);
  } catch (_) {
    throw lockOwnershipError();
  }
  if (!owner || owner.version !== 1 || owner.token !== lock.token || owner.pid !== process.pid) {
    throw lockOwnershipError();
  }
}

async function acquireLock(lockPath) {
  await fs.promises.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  var started = Date.now();
  while (true) {
    try {
      await fs.promises.mkdir(lockPath, { mode: 0o700 });
      var stat = await fs.promises.stat(lockPath);
      var token = crypto.randomBytes(18).toString("hex");
      var lock = { token: token, dev: stat.dev, ino: stat.ino, ownerPath: path.join(lockPath, "owner-" + token + ".json") };
      try {
        await fs.promises.writeFile(lock.ownerPath, JSON.stringify({ version: 1, token: token, pid: process.pid }) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
        await assertLockOwned(lockPath, lock);
        return lock;
      } catch (ownerErr) {
        try {
          var current = await fs.promises.stat(lockPath);
          if (sameLockIdentity(current, lock)) {
            await fs.promises.unlink(lock.ownerPath).catch(function () {});
            await fs.promises.rmdir(lockPath).catch(function () {});
          }
        } catch (_) {}
        throw ownerErr;
      }
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err;
      if (Date.now() - started >= LOCK_TIMEOUT_MS) {
        throw codedError("ERR_PERSONAL_CHANNEL_LOCK", "Timed out waiting for personal channel store lock");
      }
      await new Promise(function (resolve) { setTimeout(resolve, LOCK_RETRY_MS); });
    }
  }
}

async function releaseLock(lockPath, lock) {
  await assertLockOwned(lockPath, lock);
  var entries = await fs.promises.readdir(lockPath);
  if (entries.length !== 1 || entries[0] !== path.basename(lock.ownerPath)) {
    throw lockOwnershipError("Personal channel store lock contents changed before release");
  }
  try {
    await fs.promises.unlink(lock.ownerPath);
  } catch (err) {
    if (err && err.code === "ENOENT") throw lockOwnershipError();
    throw err;
  }
  var stat;
  try {
    stat = await fs.promises.stat(lockPath);
  } catch (err) {
    if (err && err.code === "ENOENT") throw lockOwnershipError();
    throw err;
  }
  if (!sameLockIdentity(stat, lock)) throw lockOwnershipError();
  try {
    await fs.promises.rmdir(lockPath);
  } catch (err) {
    if (err && (err.code === "ENOENT" || err.code === "ENOTEMPTY" || err.code === "EEXIST")) {
      throw lockOwnershipError("Personal channel store lock changed before release completed");
    }
    throw err;
  }
}

async function withLock(lockPath, operation) {
  var lock = await acquireLock(lockPath);
  try {
    return await operation(lock);
  } finally {
    await releaseLock(lockPath, lock);
  }
}

function createPersonalChannelStore(options) {
  if (!options || typeof options !== "object") {
    throw new TypeError("options are required");
  }
  if (typeof options.dir !== "string" || options.dir.length === 0) {
    throw new TypeError("options.dir must be a non-empty string");
  }
  if (typeof options.canAccessRoom !== "function") {
    throw new TypeError("options.canAccessRoom must be a function");
  }
  var dir = path.resolve(options.dir);
  var filePath = path.join(dir, STORE_FILE);
  var lockPath = path.join(dir, LOCK_FILE);
  var canAccessRoom = options.canAccessRoom;

  async function ensurePersonalChannel(actor, roomId) {
    if (!actor || typeof actor !== "object") {
      throw codedError("ERR_PERSONAL_CHANNEL_ID", "Invalid actor");
    }
    var ownerUserId = assertSafeId(actor.id, "actor.id");
    roomId = assertSafeId(roomId, "roomId");
    return withLock(lockPath, async function (lock) {
      if (!await canAccessRoom(ownerUserId, roomId)) {
        throw codedError("ERR_PERSONAL_CHANNEL_ACCESS", "Current room membership is required");
      }
      await assertLockOwned(lockPath, lock);
      var store = await readStore(filePath);
      await assertLockOwned(lockPath, lock);
      for (var i = 0; i < store.channels.length; i++) {
        var existing = store.channels[i];
        if (existing.state === "active" && existing.ownerUserId === ownerUserId && existing.roomId === roomId) {
          return cloneRecord(existing);
        }
      }
      var channelId;
      do {
        channelId = "pch-" + crypto.randomBytes(18).toString("base64url");
      } while (store.channels.some(function (item) { return item.channelId === channelId; }));
      var record = {
        channelId: channelId,
        roomId: roomId,
        ownerUserId: ownerUserId,
        createdAt: Date.now(),
        state: "active",
      };
      store.channels.push(record);
      await writeStoreAtomic(filePath, store, function () {
        return assertLockOwned(lockPath, lock);
      });
      return cloneRecord(record);
    });
  }

  // Synchronous read-only accessor with the same validation and fail-closed
  // semantics as getChannel; always reads the current file (no cache).
  function getChannelSync(channelId) {
    channelId = assertSafeId(channelId, "channelId");
    var raw;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch (err) {
      if (err && err.code === "ENOENT") return null;
      throw err;
    }
    var store = parseStore(raw);
    for (var i = 0; i < store.channels.length; i++) {
      if (store.channels[i].channelId === channelId) {
        return cloneRecord(store.channels[i]);
      }
    }
    return null;
  }

  async function getChannel(channelId) {
    channelId = assertSafeId(channelId, "channelId");
    var store = await readStore(filePath);
    for (var i = 0; i < store.channels.length; i++) {
      if (store.channels[i].channelId === channelId) {
        return cloneRecord(store.channels[i]);
      }
    }
    return null;
  }

  async function listChannels() {
    return (await readStore(filePath)).channels.map(cloneRecord);
  }

  async function changeChannel(channelId, state) {
    channelId = assertSafeId(channelId, "channelId");
    if (state !== null && state !== "active" && state !== "archived" && state !== "closed") {
      throw codedError("ERR_PERSONAL_CHANNEL_STORE", "Invalid personal channel state");
    }
    return withLock(lockPath, async function (lock) {
      var store = await readStore(filePath);
      var record = store.channels.find(function (c) { return c.channelId === channelId; });
      if (!record) return false;
      if (state === null) store.channels = store.channels.filter(function (c) { return c !== record; });
      else record.state = state;
      store = parseStore(JSON.stringify(store));
      await writeStoreAtomic(filePath, store, function () { return assertLockOwned(lockPath, lock); });
      require("./private-session-revocation").notifyAccessChanged();
      if (state === null) require("./private-agent-scope").removePrivateClaudeState({ actorId: record.ownerUserId, channelId: record.channelId });
      if (state === null) require("./private-agent-scope").removePrivateCodexState({ actorId: record.ownerUserId, channelId: record.channelId });
      return true;
    });
  }

  // Set (or, with "", clear) the display name. Does not touch state or access, so no revocation sweep.
  async function renameChannel(channelId, name) {
    channelId = assertSafeId(channelId, "channelId");
    name = cleanName(name);
    return withLock(lockPath, async function (lock) {
      var store = await readStore(filePath);
      var record = store.channels.find(function (c) { return c.channelId === channelId; });
      if (!record) return false;
      if (name) record.name = name; else delete record.name;
      await writeStoreAtomic(filePath, parseStore(JSON.stringify(store)), function () { return assertLockOwned(lockPath, lock); });
      return true;
    });
  }

  return {
    ensurePersonalChannel: ensurePersonalChannel,
    renameChannel: renameChannel,
    getChannel: getChannel,
    getChannelSync: getChannelSync,
    listChannels: listChannels,
    setChannelState: changeChannel,
    deleteChannel: function (id) { return changeChannel(id, null); },
  };
}

// What a channel is called on screen: the owner's custom name, else "<닉네임>의 채널". A display
// fallback only (never stored), so a later nickname change shows up everywhere at once.
function channelDisplayName(record, nickname) {
  if (record && record.name) return record.name;
  var nick = typeof nickname === "string" ? nickname.trim() : "";
  return nick ? nick + "의 채널" : "";
}

module.exports = { createPersonalChannelStore: createPersonalChannelStore, channelDisplayName: channelDisplayName };

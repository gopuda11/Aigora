"use strict";
// Room skills v1 catalog (docs/superpowers/specs/2026-10-03-room-skills-plugins.md sections 3, 4 and 8).
// One global catalog of immutable, content-hashed skill versions plus per-scope enablement:
//   room scope: { roomId }            private scope: { roomId, userId } (the user's own set, never shared)
// Layout under `base` (mode 0700, server only; never the host ~/.claude):
//   state.json                      { epoch, skills, rooms, users }
//   store/<name>/<sha256>/...       the approved tree (SKILL.md at its root)
//   drafts/<draftId>/{skill/,meta.json}   an install waiting for the installer's review
// A skill installed by a room member carries roomId: it is listed, enabled and run in that room only (never global).
var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var validator = require("./skills-validator");
var { quarantineCorrupt } = require("./quarantine-corrupt");

var PLUGIN_NAME = "aigora";
var MAX_SKILLS = 100, MAX_DRAFTS = 20, MAX_MEMBER_DRAFTS = 3, DRAFT_TTL_MS = 24 * 3600000;
var TOKEN = /^[A-Za-z0-9_.-]{1,128}$/;
var RESERVED = ["__proto__", "constructor", "prototype"];

function fail(code) { var e = new Error(code); e.code = code; return e; }
function token(s) { return typeof s === "string" && TOKEN.test(s) && s !== "." && s !== ".." && RESERVED.indexOf(s) === -1; }
function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
function removeTree(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function mkdir(p) { fs.mkdirSync(p, { recursive: true, mode: 0o700 }); }
function atomicWrite(file, text) {
  var tmp = file + "." + crypto.randomBytes(6).toString("hex") + ".tmp";
  fs.writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
  fs.renameSync(tmp, file);
}
function writeTree(dest, files) {
  mkdir(dest);
  files.forEach(function (f) {
    var target = path.join(dest, f.path);
    if (path.relative(dest, target).indexOf("..") === 0) throw fail("unsafe_path");
    mkdir(path.dirname(target));
    fs.writeFileSync(target, f.data, { mode: 0o444, flag: "wx" }); // every skill file is read-only and never executable
  });
}
function scopeKey(scope) {
  if (!scope || !token(scope.roomId) || (scope.userId !== undefined && !token(scope.userId))) throw fail("invalid_scope");
  return scope;
}

function createCatalog(opts) {
  var base = opts.dir;
  var state = null;
  function file() { return path.join(base, "state.json"); }
  function init() { mkdir(base); mkdir(path.join(base, "store")); mkdir(path.join(base, "drafts")); try { fs.chmodSync(base, 0o700); } catch (_) {} }
  function load() {
    if (state) return state;
    init();
    var raw = null;
    try { raw = JSON.parse(fs.readFileSync(file(), "utf8")); } catch (e) { raw = null; quarantineCorrupt(file(), e); }
    state = { epoch: 0, skills: {}, rooms: {}, users: {} };
    if (raw && typeof raw === "object") {
      if (Number.isInteger(raw.epoch)) state.epoch = raw.epoch;
      ["skills", "rooms", "users"].forEach(function (k) { if (raw[k] && typeof raw[k] === "object" && !Array.isArray(raw[k])) state[k] = raw[k]; });
    }
    return state;
  }
  function save() { state.epoch++; atomicWrite(file(), JSON.stringify(state)); }
  // The scope's id -> pinned sha map; created on demand when `make`.
  function pins(scope, make) {
    scopeKey(scope);
    var s = load(), holder;
    if (scope.userId === undefined) holder = s.rooms;
    else { if (!own(s.users, scope.userId)) { if (!make) return null; s.users[scope.userId] = {}; } holder = s.users[scope.userId]; }
    if (!own(holder, scope.roomId)) { if (!make) return null; holder[scope.roomId] = {}; }
    return holder[scope.roomId];
  }
  function storeDir(name, sha) { return path.join(base, "store", name, sha); }
  function referenced(name, sha) {
    var s = load(), hit = false;
    function scan(map) { Object.keys(map).forEach(function (r) { if (own(map[r], name) && map[r][name] === sha) hit = true; }); }
    scan(s.rooms); Object.keys(s.users).forEach(function (u) { scan(s.users[u]); });
    return hit;
  }
  function gc(name) {
    var s = load(), sk = own(s.skills, name) ? s.skills[name] : null;
    if (!sk) return;
    var dropped = false;
    Object.keys(sk.versions).forEach(function (sha) {
      if (sha !== sk.current && !referenced(name, sha)) { removeTree(storeDir(name, sha)); delete sk.versions[sha]; dropped = true; }
    });
    if (dropped) atomicWrite(file(), JSON.stringify(state));
  }
  function info(name, sha) {
    var sk = load().skills[name], v = sk.versions[sha];
    return { id: name, name: name, description: v.description, version: v.version, sha256: sha, size: v.size, files: v.files.slice(),
      source: v.source, approvedBy: v.approvedBy, approvedAt: v.approvedAt, lint: v.lint || [],
      roomId: sk.roomId || null, installedBy: v.installedBy || null };
  }
  // A skill is visible to a room when it is global or scoped to exactly that room.
  function visible(sk, roomId) { return !!sk && (!sk.roomId || sk.roomId === roomId); }
  function draftDir(id) { if (!/^[0-9a-f]{16}$/.test(String(id))) throw fail("not_found"); return path.join(base, "drafts", id); }
  function readMeta(id) {
    try { return JSON.parse(fs.readFileSync(path.join(draftDir(id), "meta.json"), "utf8")); } catch (e) { throw e && e.code === "not_found" ? e : fail("not_found"); }
  }
  // Text and script files only; binary assets are listed (files[]) but never read back as text.
  function texts(dir, files) {
    return files.filter(function (f) { return validator.kindOfPath(f.path) !== "binary"; })
      .map(function (f) { return { path: f.path, text: fs.readFileSync(path.join(dir, f.path), "utf8") }; });
  }

  var api = {
    dir: base,
    base: base,
    epoch: function () { return load().epoch; },
    // Creates a draft from a validated skill (validator.validate(...).skill). Nothing is enableable before approve().
    // `roomId` marks a member install: it only ever becomes a skill scoped to that room, and never a new version of an existing skill.
    createDraft: function (skill, source, actorId, roomId) {
      var s = load();
      api.pruneDrafts();
      var drafts = fs.readdirSync(path.join(base, "drafts"));
      if (drafts.length >= MAX_DRAFTS) throw fail("too_many_drafts");
      var existing = own(s.skills, skill.name) ? s.skills[skill.name] : null;
      if (existing && own(existing.versions, skill.sha256) && (!roomId || existing.roomId === roomId)) throw fail("already_installed");
      if (existing && (roomId ? true : !!existing.roomId)) throw fail("name_taken");
      if (!existing && Object.keys(s.skills).length >= MAX_SKILLS) throw fail("catalog_full");
      if (roomId && drafts.filter(function (d) { try { return readMeta(d).installedBy === actorId; } catch (_) { return false; } }).length >= MAX_MEMBER_DRAFTS) throw fail("too_many_drafts");
      var id = crypto.randomBytes(8).toString("hex"), dir = draftDir(id);
      mkdir(dir);
      try {
        writeTree(path.join(dir, "skill"), skill.files);
        var versions = existing ? Object.keys(existing.versions).map(function (k) { return existing.versions[k].version; }) : [];
        var meta = { id: id, name: skill.name, description: skill.description, version: (versions.length ? Math.max.apply(null, versions) : 0) + 1,
          sha256: skill.sha256, size: skill.size, files: skill.files.map(function (f) { var k = validator.classify(f.path, f.data); return k.type ? { path: f.path, size: f.data.length, kind: k.kind, type: k.type } : { path: f.path, size: f.data.length, kind: k.kind }; }).sort(function (a, b) { return a.path < b.path ? -1 : 1; }),
          lint: skill.lint || [], source: source, installedBy: actorId, installedAt: Date.now(), replaces: existing ? existing.current : null };
        if (roomId) meta.roomId = roomId;
        atomicWrite(path.join(dir, "meta.json"), JSON.stringify(meta));
        return meta;
      } catch (e) { removeTree(dir); throw e; }
    },
    pruneDrafts: function () {
      var dir = path.join(base, "drafts");
      fs.readdirSync(dir).forEach(function (id) {
        try { if (Date.now() - JSON.parse(fs.readFileSync(path.join(dir, id, "meta.json"), "utf8")).installedAt > DRAFT_TTL_MS) removeTree(path.join(dir, id)); }
        catch (_) { removeTree(path.join(dir, id)); }
      });
    },
    listDrafts: function () {
      load(); api.pruneDrafts();
      return fs.readdirSync(path.join(base, "drafts")).map(function (id) { try { return readMeta(id); } catch (_) { return null; } }).filter(Boolean);
    },
    // Full text of every file: the review screen shows all of it, untruncated (the limits keep it small).
    readDraft: function (id) {
      var meta = readMeta(id);
      return Object.assign({}, meta, { texts: texts(path.join(draftDir(id), "skill"), meta.files) });
    },
    discardDraft: function (id) { readMeta(id); removeTree(draftDir(id)); return true; },
    // The only way into the catalog. Re-validates the stored draft so a file edited after upload cannot be approved.
    approve: function (id, actorId) {
      var s = load(), meta = readMeta(id), dir = path.join(draftDir(id), "skill");
      var re = validator.validateHostDir(dir);
      if (!re.ok || re.skill.sha256 !== meta.sha256 || re.skill.name !== meta.name) throw fail("hash_mismatch");
      var existing = own(s.skills, meta.name) ? s.skills[meta.name] : null;
      if (existing && (meta.roomId ? true : !!existing.roomId)) throw fail("name_taken");
      if (existing && own(existing.versions, meta.sha256)) throw fail("already_installed");
      if (!existing && Object.keys(s.skills).length >= MAX_SKILLS) throw fail("catalog_full");
      mkdir(path.join(base, "store", meta.name));
      var dest = storeDir(meta.name, meta.sha256);
      fs.renameSync(dir, dest);
      removeTree(draftDir(id));
      if (!existing) { existing = s.skills[meta.name] = { current: null, versions: {} }; if (meta.roomId) existing.roomId = meta.roomId; }
      existing.versions[meta.sha256] = { version: meta.version, description: meta.description, size: meta.size, files: meta.files, source: meta.source,
        installedBy: meta.installedBy, installedAt: meta.installedAt, approvedBy: actorId, approvedAt: Date.now(), lint: meta.lint };
      existing.current = meta.sha256;
      save(); gc(meta.name);
      return info(meta.name, meta.sha256);
    },
    // With `roomId`: global skills plus that room's own; without: every entry (admin tooling and tests).
    list: function (roomId) {
      var s = load();
      return Object.keys(s.skills).sort().filter(function (n) { return roomId === undefined || visible(s.skills[n], roomId); }).map(function (n) { return info(n, s.skills[n].current); });
    },
    get: function (name, roomId) {
      var s = load();
      if (!token(name) || !own(s.skills, name) || (roomId !== undefined && !visible(s.skills[name], roomId))) return null;
      var sk = s.skills[name], dir = storeDir(name, sk.current), i = info(name, sk.current);
      return Object.assign(i, { texts: texts(dir, i.files) });
    },
    // Removes the entry and every enablement of it (all rooms and users); the epoch bump tells queued runs to re-assemble.
    remove: function (name) {
      var s = load();
      if (!token(name) || !own(s.skills, name)) throw fail("not_found");
      delete s.skills[name];
      Object.keys(s.rooms).forEach(function (r) { delete s.rooms[r][name]; });
      Object.keys(s.users).forEach(function (u) { Object.keys(s.users[u]).forEach(function (r) { delete s.users[u][r][name]; }); });
      save(); removeTree(path.join(base, "store", name));
      return true;
    },
    // Drops a room's own skills, its enablements and every user's private enablements in it (room purge).
    purgeRoom: function (roomId) {
      var s = load(), names = Object.keys(s.skills).filter(function (n) { return s.skills[n].roomId === roomId; });
      // Files first: a record stays (so a retry finds it) until its directory is really gone. Only canonical
      // skill names contained directly under store/ are ever removed from disk; a tampered key is dropped record-only.
      // A symlink anywhere on base/store/<name> is refused inside this operation (record kept, counted failed).
      var failed = 0, storeDir = path.resolve(base, "store");
      function chainSafe(dir) {
        return [path.resolve(base, "store"), dir].every(function (c) {
          try { return !fs.lstatSync(c).isSymbolicLink(); } catch (e) { return e.code === "ENOENT"; }
        });
      }
      names.slice().forEach(function (n) {
        var dir = path.resolve(storeDir, n);
        if (validator.isValidName(n) && path.dirname(dir) === storeDir) {
          try {
            if (!chainSafe(dir)) throw new Error("unsafe path");
            fs.rmSync(dir, { recursive: true, force: true }); if (fs.existsSync(dir)) throw new Error("remains");
          } catch (_) { failed++; names.splice(names.indexOf(n), 1); }
        }
      });
      // Persist the candidate state first and commit the cache only once it is on disk (a failed write leaves memory untouched).
      var next = { epoch: s.epoch, skills: Object.assign({}, s.skills), rooms: Object.assign({}, s.rooms), users: {} };
      Object.keys(s.users).forEach(function (u) { next.users[u] = Object.assign({}, s.users[u]); });
      names.forEach(function (n) { delete next.skills[n]; });
      var had = own(next.rooms, roomId);
      delete next.rooms[roomId];
      Object.keys(next.users).forEach(function (u) { if (own(next.users[u], roomId)) { had = true; delete next.users[u][roomId]; } });
      if (names.length || had) { next.epoch = s.epoch + 1; atomicWrite(file(), JSON.stringify(next)); state = next; }
      return { skills: names.length, failed: failed };
    },
    // Enablement rows for a scope: [{ id, sha256, pinned (the version it runs), current, updateAvailable }].
    enabled: function (scope) {
      var s = load(), m = pins(scope, false) || {};
      return Object.keys(m).filter(function (n) { return own(s.skills, n); }).map(function (n) {
        return { id: n, pinned: m[n], current: s.skills[n].current, updateAvailable: m[n] !== s.skills[n].current };
      });
    },
    // Turns a skill on (pinned to the current approved version) or off. An already enabled skill stays on its pinned version
    // until `upgrade` is passed: an edit can never silently change what a room runs.
    setEnabled: function (scope, name, on, o) {
      var s = load();
      if (!token(name) || !own(s.skills, name) || !visible(s.skills[name], scope && scope.roomId)) throw fail("not_found");
      var m = pins(scope, true), was = own(m, name) ? m[name] : null;
      if (!on) { if (was === null) return { changed: false, name: name }; delete m[name]; save(); gc(name); return { changed: true, name: name, on: false }; }
      var cur = s.skills[name].current;
      if (was === cur) return { changed: false, name: name };
      if (was !== null && !(o && o.upgrade === true)) return { changed: false, name: name, updateAvailable: true };
      m[name] = cur; save(); gc(name);
      return { changed: true, name: name, on: true, upgraded: was !== null };
    },
    // [{ name, dir, sha256 }] for the run's scope; nothing outside the catalog and nothing whose pinned version is gone.
    activeFor: function (scope) {
      var s = load(), m = pins(scope, false) || {};
      return Object.keys(m).sort().filter(function (n) { return own(s.skills, n) && own(s.skills[n].versions, m[n]) && visible(s.skills[n], scope.roomId); })
        .map(function (n) { return { name: n, dir: storeDir(n, m[n]), sha256: m[n] }; });
    },
  };
  return api;
}

// Builds the per-run plugin directory (see section 4): .claude-plugin/plugin.json + skills/<name>/... copied from the immutable store.
// Every source tree is re-validated and re-hashed first; a changed, missing or unsafe tree throws and nothing is assembled.
// The result is world-readable and read-only (dirs 0755, files 0444, never executable) so the sandboxed CLI can read the read-only bind.
function assemble(dest, entries) {
  var items = (Array.isArray(entries) ? entries : []).map(function (e) {
    if (!e || !token(e.name) || !/^[0-9a-f]{64}$/.test(String(e.sha256)) || typeof e.dir !== "string") throw fail("skills_invalid");
    var r = validator.validateHostDir(e.dir);
    if (!r.ok || r.skill.sha256 !== e.sha256 || r.skill.name !== e.name) throw fail("hash_mismatch");
    return { name: e.name, files: r.skill.files };
  });
  fs.mkdirSync(dest, { mode: 0o755 });
  fs.mkdirSync(path.join(dest, ".claude-plugin"), { mode: 0o755 });
  fs.writeFileSync(path.join(dest, ".claude-plugin", "plugin.json"), JSON.stringify({ name: PLUGIN_NAME, description: "Aigora room skills", version: "1.0.0" }), { mode: 0o644 });
  items.forEach(function (it) {
    var root = path.join(dest, "skills", it.name);
    it.files.forEach(function (f) {
      var target = path.join(root, f.path);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
      fs.writeFileSync(target, f.data, { mode: 0o444, flag: "wx" }); // no exec bit, no write bit
    });
  });
  return items.map(function (it) { return PLUGIN_NAME + ":" + it.name; });
}

var defaultCatalog = null;
function getDefault() {
  if (!defaultCatalog) defaultCatalog = createCatalog({ dir: path.join(require("./config").CONFIG_DIR, "skills") });
  return defaultCatalog;
}
function setDefault(c) { defaultCatalog = c; }

module.exports = { createCatalog: createCatalog, assemble: assemble, getDefault: getDefault, setDefault: setDefault, PLUGIN_NAME: PLUGIN_NAME, token: token };

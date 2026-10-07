// prompt-coaching-store.js - Per-user store of prompt coaching results.
//
// Deliberately separate from session history and from canonical agent events: a coaching failure (or a
// corrupt file here) can never alter execution history, and no agent input path reads this directory.
// One small JSON file per user; every call reads fresh, writes are best-effort and never throw.

var fs = require("fs");
var path = require("path");

var MAX_ENTRIES = 200;
var MAX_TEXT = 4000;
var USER_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,119}$/;

function createCoachingStore(opts) {
  var dir = opts.dir;
  var now = opts.now || Date.now;

  function file(userId) { return path.join(dir, userId + ".json"); }
  function load(userId) {
    try {
      var d = JSON.parse(fs.readFileSync(file(userId), "utf8"));
      if (d && Array.isArray(d.entries)) return d.entries;
    } catch (_) { /* empty or corrupt: start over */ }
    return [];
  }
  function save(userId, entries) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      var tmp = file(userId) + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ entries: entries }), { mode: 0o600 });
      fs.renameSync(tmp, file(userId));
      return true;
    } catch (_) { return false; }
  }
  function ok(userId) { return typeof userId === "string" && USER_RE.test(userId); }

  function record(userId, entry) {
    if (!ok(userId) || !entry || typeof entry.id !== "string" || !entry.id) return null;
    var e = Object.assign({}, entry, { text: String(entry.text || "").slice(0, MAX_TEXT), shared: false });
    var entries = load(userId);
    var at = -1;
    for (var i = 0; i < entries.length; i++) if (entries[i].id === e.id) { at = i; break; }
    if (at >= 0) { e.shared = !!entries[at].shared; if (e.shared) e.sharedAt = entries[at].sharedAt; entries[at] = e; }
    else entries.push(e);
    if (entries.length > MAX_ENTRIES) entries = entries.slice(entries.length - MAX_ENTRIES);
    return save(userId, entries) ? e : null;
  }
  function list(userId) { return ok(userId) ? load(userId) : []; }
  function get(userId, id) {
    var found = list(userId).filter(function (e) { return e.id === id; })[0];
    return found || null;
  }
  function markShared(userId, id) {
    if (!ok(userId)) return null;
    var entries = load(userId);
    var e = entries.filter(function (x) { return x.id === id; })[0];
    if (!e) return null;
    e.shared = true;
    e.sharedAt = now();
    return save(userId, entries) ? e : null;
  }

  // The author's last "AI로 완성하기" result for one entry. It lives in the entry itself, so it goes wherever the
  // entry goes (room / session deletion removes the entry, and with it this text).
  function setAi(userId, id, text) {
    if (!ok(userId) || typeof text !== "string" || !text) return null;
    var entries = load(userId);
    var e = entries.filter(function (x) { return x.id === id; })[0];
    if (!e) return null;
    e.aiText = text.slice(0, MAX_TEXT);
    e.aiAt = now();
    return save(userId, entries) ? e : null;
  }

  return { record: record, list: list, get: get, markShared: markShared, setAi: setAi };
}

module.exports = { createCoachingStore: createCoachingStore };

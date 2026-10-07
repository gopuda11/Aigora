// storage-migrate.js - one-time browser storage key rename (clagentic-/clay- -> aigora-).
// Imported FIRST by app.js so it runs before any module reads storage.
// Device-level prefs are copied old -> new only when the new key is absent, then the old key
// is removed; user-scoped caches are removed without copying.
// Idempotent; guarded for unavailable storage; marker key makes it run once per browser.

var MARKER = "aigora-storage-migrated";

// Device-level UI prefs (exact keys) are COPIED to the aigora name. User-scoped caches are
// only DELETED, never carried forward, so a shared browser cannot leak one user's
// cached identity/project names/DM state to the next.
var COPY = ["theme", "theme-vars", "theme-variant", "mode", "skin", "wide-view", "brand"];
var DROP_EXACT = ["project-hint-dismissed", "active-dm", "weather", "context-view", "playbooks-done", "wt-collapsed"];
var DROP_PREFIX = ["project-name-", "project-icon-", "skill-update-dismissed:"];
var DROP_KEYS = ["clagentic_my_user", "clay_my_user"];
var COPY_RULES = [["clay_login_username", "aigora_login_username"]];
["clagentic-", "clay-"].forEach(function (old) {
  COPY.forEach(function (b) { COPY_RULES.push([old + b, "aigora-" + b]); });
  DROP_EXACT.forEach(function (b) { DROP_KEYS.push(old + b); });
});

function mapKey(key) {
  for (var i = 0; i < COPY_RULES.length; i++) {
    if (key === COPY_RULES[i][0]) return COPY_RULES[i][1];
  }
  return null;
}

function isDropKey(key) {
  if (DROP_KEYS.indexOf(key) !== -1) return true;
  for (var i = 0; i < DROP_PREFIX.length; i++) {
    if (key.indexOf("clagentic-" + DROP_PREFIX[i]) === 0 || key.indexOf("clay-" + DROP_PREFIX[i]) === 0) return true;
  }
  return false;
}

// The stored brand VALUE "clagentic" (the Aigora look) is now "aigora". Runs after the key
// rename, on every load (idempotent: it only touches the exact old value).
function migrateBrandValue(store) {
  try {
    if (store.getItem("aigora-brand") === "clagentic") store.setItem("aigora-brand", "aigora");
  } catch (e) {}
}

export function migrateStorage(store) {
  if (!store) return;
  migrateKeys(store);
  migrateBrandValue(store);
}

function migrateKeys(store) {
  try {
    if (store.getItem(MARKER)) return;
    var keys = [];
    for (var i = 0; i < store.length; i++) keys.push(store.key(i));
    keys.forEach(function (k) {
      if (isDropKey(k)) { store.removeItem(k); return; }
      var nk = mapKey(k);
      if (!nk) return;
      if (store.getItem(nk) === null) store.setItem(nk, store.getItem(k));
      store.removeItem(k);
    });
    store.setItem(MARKER, "1");
  } catch (e) {}
}

function safe(name) { try { return window[name]; } catch (e) { return null; } }

if (typeof window !== "undefined") {
  migrateStorage(safe("localStorage"));
  migrateStorage(safe("sessionStorage"));
}

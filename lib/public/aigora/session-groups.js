// session-groups.js - presentation-only grouping of the sessions of one channel (no data model change, no AI).
// Sessions whose title + first instruction share enough words are clustered; clusters of two or more become a
// collapsible group labelled by their most common shared keyword (the one in most sessions; ties: longer, then alphabetical) and a count. Pure and deterministic: the same
// sessions always give the same groups.
//
// Similarity: Jaccard over the character bigrams of the content words of "<title> <first instruction>" (stop words
// and Korean endings/particles removed first). Two sessions are linked when it reaches SIMILARITY_THRESHOLD;
// a group is a connected set of linked sessions (union-find over all pairs, in id order).

export var SIMILARITY_THRESHOLD = 0.3;

// Words that carry no topic: requests ("해줘"), fillers and the generic nouns of any task.
var STOP_WORDS = new Set([
  "해줘", "해주세요", "해줄래", "해라", "해", "줘", "주세요", "좀", "이거", "이걸", "이것", "그거", "그걸", "저거",
  "파일", "만들어", "만들어줘", "만들기", "만들어주세요", "작성", "작성해줘", "작성해주세요", "하기", "하자", "관련", "대한", "대해", "위한", "그리고",
  "그냥", "다시", "새", "새로", "세션", "제목", "없는", "한번", "먼저", "지금", "것", "수", "더", "잘", "있는", "해서", "하고", "하는",
  "the", "a", "an", "to", "of", "for", "and", "please", "file", "make", "create", "new", "session",
]);
// Request endings glued to a word ("정리해줘" -> "정리") and the commonest Korean particles ("보고서를" -> "보고서").
var ENDINGS = /(?:해주세요|해줄래|해줘요|해줘|해요|하기|하자|만들어줘|만들어|주세요|줘)$/;
var PARTICLES = /(?:으로|에서|에게|까지|부터|이랑|하고|을|를|은|는|이|가|의|에|도|로|와|과)$/;

function words(text) {
  var raw = String(text == null ? "" : text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  var out = [];
  raw.forEach(function (w) {
    var prev;
    // Endings first, then one particle; a word too short to shorten is kept as is.
    prev = w; w = w.replace(ENDINGS, ""); if (w.length < 1) w = prev;
    prev = w; if (w.length > 2) w = w.replace(PARTICLES, ""); if (w.length < 1) w = prev;
    if (w.length < 2 || STOP_WORDS.has(w) || /^\d+$/.test(w)) return;
    out.push(w);
  });
  return out;
}

function bigrams(list) {
  var set = new Set();
  list.forEach(function (w) {
    var chars = Array.from(w);
    for (var i = 0; i + 1 < chars.length; i++) set.add(chars[i] + chars[i + 1]);
  });
  return set;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  var inter = 0;
  a.forEach(function (x) { if (b.has(x)) inter++; });
  return inter / (a.size + b.size - inter);
}

// The topic features of one session: its content words and their bigrams.
export function sessionFeatures(s) {
  var list = words((s && s.title) + " " + ((s && s.preview) || ""));
  return { words: list, grams: bigrams(list) };
}

export function similarity(a, b) { return jaccard(sessionFeatures(a).grams, sessionFeatures(b).grams); }

function label(members, feats) {
  var df = new Map();
  members.forEach(function (m) {
    new Set(feats.get(m.id).words).forEach(function (w) { df.set(w, (df.get(w) || 0) + 1); });
  });
  var ranked = Array.from(df.entries()).filter(function (kv) { return kv[1] >= 2; }).sort(function (x, y) {
    return y[1] - x[1] || Array.from(y[0]).length - Array.from(x[0]).length || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0);
  });
  if (ranked.length) {
    return ranked[0][0];
  }
  // No whole word is shared (only similar spellings): the commonest shared bigram.
  var gdf = new Map();
  members.forEach(function (m) { feats.get(m.id).grams.forEach(function (g) { gdf.set(g, (gdf.get(g) || 0) + 1); }); });
  var g = Array.from(gdf.entries()).sort(function (x, y) { return y[1] - x[1] || (x[0] < y[0] ? -1 : 1); })[0];
  return g ? g[0] : "";
}

// sessions: [{ id, title, preview?, lastActivity }] -> units, most recently active first:
//   { type: "session", session } | { type: "group", key, label, count, sessions, lastActivity }
export function groupSessions(sessions, threshold) {
  var min = typeof threshold === "number" ? threshold : SIMILARITY_THRESHOLD;
  var list = (Array.isArray(sessions) ? sessions : []).filter(Boolean).slice().sort(function (a, b) {
    return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
  });
  var feats = new Map();
  list.forEach(function (s) { feats.set(s.id, sessionFeatures(s)); });
  var parent = list.map(function (_, i) { return i; });
  function find(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
  for (var i = 0; i < list.length; i++) {
    for (var j = i + 1; j < list.length; j++) {
      if (jaccard(feats.get(list[i].id).grams, feats.get(list[j].id).grams) >= min) parent[find(j)] = find(i);
    }
  }
  var clusters = new Map();
  list.forEach(function (s, idx) {
    var root = find(idx);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(s);
  });
  function act(s) { return typeof s.lastActivity === "number" && isFinite(s.lastActivity) ? s.lastActivity : 0; }
  var units = [];
  clusters.forEach(function (members) {
    if (members.length < 2) { units.push({ type: "session", session: members[0], lastActivity: act(members[0]) }); return; }
    members.sort(function (a, b) { return act(b) - act(a); });
    var text = label(members, feats);
    units.push({ type: "group", key: text, label: text, count: members.length, sessions: members, lastActivity: act(members[0]) });
  });
  units.sort(function (a, b) { return b.lastActivity - a.lastActivity; });
  // Two groups can end up with the same label: keep keys unique so each remembers its own state.
  var seen = {};
  units.forEach(function (u) {
    if (u.type !== "group") return;
    seen[u.key] = (seen[u.key] || 0) + 1;
    if (seen[u.key] > 1) u.key = u.key + "#" + seen[u.key];
  });
  return units;
}

// --- Remembered open/closed state of the groups, per channel (localStorage; may be missing or throw) ---
var STORE_KEY = "aigora.sessionGroups.v1";

function readAll(storage) {
  try {
    var raw = storage && storage.getItem(STORE_KEY);
    var all = raw ? JSON.parse(raw) : null;
    return all && typeof all === "object" && !Array.isArray(all) ? all : {};
  } catch (_) { return {}; }
}

// true / false when the user chose, null when they never did (then the default applies).
export function groupOpenState(storage, channelId, key) {
  var chan = readAll(storage)[String(channelId)];
  return chan && typeof chan[key] === "boolean" ? chan[key] : null;
}

export function setGroupOpenState(storage, channelId, key, open) {
  try {
    var all = readAll(storage), id = String(channelId);
    all[id] = Object.assign({}, all[id], {});
    all[id][key] = !!open;
    storage.setItem(STORE_KEY, JSON.stringify(all));
  } catch (_) { /* private mode or quota: the choice just is not remembered */ }
}

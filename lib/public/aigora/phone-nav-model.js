// phone-nav-model.js - DOM-free rules of the phone (<=768px) shell, laid out like a chat app:
// a top bar (☰ · "방 | 채널" pill · one action), a clean thread, one pill composer and a sidebar
// that holds everything else. Nothing here touches the DOM; aigora/phone-nav.js applies it.
//
//   tab = "room" | "private"   (the page's two threads: the room's shared feed, the person's own channel)
//
// Above 768px none of this is active.

import { t } from "./i18n.js";

export var PHONE_QUERY = "(max-width: 768px)";
// Same values as --ai-push / --ai-pop in aigora-app.css (the sidebar slides in over PUSH_MS, out over POP_MS).
export var PUSH_MS = 280;
export var POP_MS = 200;
// A channel's custom name is shown on its tab only while it fits the pill; otherwise the tab says "채널".
function defaultChannelTab() { return t("phoneNav.channel"); }
export var CHANNEL_TAB_MAX = 6;
// Swipe from the left edge opens the sidebar; a left drag on it closes it.
export var EDGE_PX = 20;
export var COMMIT_RATIO = 0.35;
export var COMMIT_VELOCITY = 0.5;   // px per ms
export var COMMIT_MIN_PX = 40;
export var LOCK_PX = 8;
export var SUGGESTION_MAX = 3;

export function normalizeTab(v) { return v === "private" ? "private" : "room"; }

// The text of the second segment: the person's own name for their channel when it is short, else "채널".
export function channelTabLabel(channelName) {
  var name = typeof channelName === "string" ? channelName.trim() : "";
  if (!name) return defaultChannelTab();
  return Array.from(name).length <= CHANNEL_TAB_MAX ? name : defaultChannelTab();
}

// What the top bar shows. `s` = { tab, channelName, canStartNew, bellCount }. The right action is the bell in 방
// and 새 세션 in 채널; nothing else lives in the bar.
export function topBar(s) {
  var tab = normalizeTab(s && s.tab);
  var full = s && typeof s.channelName === "string" && s.channelName.trim() ? s.channelName.trim() : defaultChannelTab();
  var count = Math.max(0, Number(s && s.bellCount) || 0);
  return {
    tab: tab,
    tabs: [{ id: "room", label: t("phoneNav.room"), full: t("phoneNav.room") }, { id: "private", label: channelTabLabel(s && s.channelName), full: full }],
    action: tab === "room"
      ? { id: "bell", label: count ? t("phoneNav.bellCount", { count: count }) : t("phoneNav.bell"), badge: count > 99 ? "99+" : count ? String(count) : "", disabled: false }
      : { id: "new", label: t("phoneNav.newSession"), badge: "", disabled: !(s && s.canStartNew) },
  };
}

// The composer's small mode chip (방 only): what a send does right now, and what a tap switches to.
export function modeChip(mode) {
  var member = mode === "member";
  return {
    text: (member ? t("composer.chipMember") : t("composer.chipAi")) + " ▾",
    label: member ? t("composer.chipLabelMember") : t("composer.chipLabelAi"),
    next: member ? "ai" : "member",
  };
}

// The sidebar's icon rows, in order. `c` = { hasRoom, roomName, memberCount, isAdmin, avail: { results, pins, share },
// skills: { on, count }, pending }. A row a person cannot use is left out (not greyed): every row that is
// shown works. Hide the Skills placeholder until the working pane is enabled.
export function menuRows(c) {
  c = c || {};
  var avail = c.avail || {};
  var skills = c.skills || {};
  var rows = [];
  function add(id, label, icon, extra) { rows.push(Object.assign({ id: id, label: label, icon: icon, meta: "", badge: "" }, extra || {})); }
  if (c.hasRoom) {
    add("rooms", t("phoneNav.menuRooms"), "rooms", { meta: c.roomName || "" });
    if (avail.results) add("results", t("phoneNav.menuResults"), "results");
    if (avail.share) add("share", t("phoneNav.menuShare"), "share");
    if (avail.pins) add("pins", t("phoneNav.menuPins"), "pin");
    add("panel", t("phoneNav.menuPanel"), "panel");
    add("members", t("phoneNav.menuMembers"), "people", { meta: c.memberCount ? t("phoneNav.membersMeta", { count: c.memberCount }) : "" });
    add("coaching", t("phoneNav.menuCoaching"), "coach");
    if (skills.on) add("skills", t("phoneNav.menuSkills"), "skills", { meta: skills.count ? t("phoneNav.skillsInUse", { count: skills.count }) : "", dim: false });
  }
  add("settings", t("phoneNav.menuSettings"), "settings");
  add("guide", t("phoneNav.menuGuide"), "guide");
  if (c.isAdmin) {
    if (c.hasRoom) add("approvals", t("phoneNav.menuApprovals"), "approval", { badge: c.pending ? String(c.pending > 99 ? "99+" : c.pending) : "" });
    add("manage", t("phoneNav.menuManage"), "manage");
  }
  return rows;
}

// The floating primary button: 새 세션 in 채널; 방 만들기 in 방 for an administrator; none otherwise.
export function primaryAction(tab, s) {
  s = s || {};
  if (normalizeTab(tab) === "private") return { id: "new", label: t("phoneNav.newSession"), disabled: !s.canStartNew };
  return s.isAdmin ? { id: "create-room", label: t("phoneNav.createRoom"), disabled: false } : null;
}

// Up to SUGGESTION_MAX quiet rows above the composer of an empty 방: the newest shared results first, then the
// plain hints (attach a file, write a better instruction).
export var HINTS = [
  { kind: "hint", get title() { return t("phoneNav.hintGoalTitle"); }, get sub() { return t("phoneNav.hintGoalSub"); }, get text() { return t("phoneNav.hintGoalText"); } },
  { kind: "file", get title() { return t("phoneNav.hintFileTitle"); }, get sub() { return t("phoneNav.hintFileSub"); } },
];
export function suggestions(c) {
  c = c || {};
  var rows = [];
  var posts = Array.isArray(c.posts) ? c.posts : [];
  for (var i = posts.length - 1; i >= 0 && rows.length < 2; i--) {
    var p = posts[i];
    if (p && typeof p.id === "string" && typeof p.title === "string" && p.title.trim()) rows.push({ kind: "post", id: p.id, title: p.title.trim(), sub: t("phoneNav.menuResults") });
  }
  for (var j = 0; j < HINTS.length && rows.length < SUGGESTION_MAX; j++) rows.push(HINTS[j]);
  return rows.slice(0, SUGGESTION_MAX);
}

// Sidebar search over what the person can see: rooms, their own sessions, an administrator's 조원 채널 sessions
// and this room's 이전 대화. Case-insensitive substring; an empty query matches nothing.
export function searchEntries(q, data) {
  var needle = typeof q === "string" ? q.trim().toLowerCase() : "";
  if (!needle) return { rooms: [], sessions: [] };
  data = data || {};
  function hit(text) { return String(text == null ? "" : text).toLowerCase().indexOf(needle) !== -1; }
  var rooms = (data.rooms || []).filter(function (r) { return hit(r.name); }).map(function (r) { return { kind: "room", id: r.id, title: r.name }; });
  var sessions = [];
  (data.own || []).forEach(function (s) { if (hit(s.title)) sessions.push({ kind: "session", id: s.id, title: s.title, group: t("phoneNav.groupOwn"), admin: false }); });
  (data.previous || []).forEach(function (s) { if (hit(s.title)) sessions.push({ kind: "session", id: s.id, title: s.title, group: t("phoneNav.groupPrevious"), admin: false }); });
  (data.members || []).forEach(function (c) {
    c.sessions.forEach(function (s) {
      if (hit(s.title) || hit(c.ownerName)) sessions.push({ kind: "session", id: s.id, title: s.title, group: t("phoneNav.groupReadOnly", { name: c.ownerName }), admin: true });
    });
  });
  return { rooms: rooms, sessions: sessions };
}

// The compact progress of one running turn: the five stages as dots and the name of the one in progress
// (the first stage without a record; the last one when all five have). `stages` come from summarizeStages().
export function progressView(stages) {
  var list = Array.isArray(stages) ? stages : [];
  var current = -1;
  for (var i = 0; i < list.length; i++) if (list[i].state === "empty") { current = i; break; }
  if (current === -1) current = Math.max(0, list.length - 1);
  var done = 0;
  list.forEach(function (s) { if (s.state !== "empty") done++; });
  return {
    done: done, total: list.length, label: list[current] ? list[current].label : "",
    dots: list.map(function (s, i) { return { id: s.id, label: s.label, state: i === current && s.state === "empty" ? "current" : s.state === "empty" ? "todo" : "done" }; }),
  };
}

// The on-screen keyboard (visualViewport): how much of the layout viewport it covers, and where the visible
// part starts. With the keyboard shut (or no visualViewport) nothing is applied.
export function keyboardMetrics(innerHeight, vv) {
  if (!vv || !(vv.height > 0) || !(innerHeight > 0)) return { open: false, height: 0, top: 0, inset: 0 };
  var inset = Math.max(0, Math.round(innerHeight - vv.height - (vv.offsetTop || 0)));
  var open = innerHeight - vv.height > 120;
  return { open: open, height: Math.round(vv.height), top: Math.round(vv.offsetTop || 0), inset: open ? inset : 0 };
}

// Which way a drag is going once it has moved LOCK_PX. `dir` = 1 for a right drag (open from the edge),
// -1 for a left drag (close); anything else hands the gesture back to scrolling.
export function lockAxis(dx, dy, dir) {
  if (Math.abs(dx) < LOCK_PX && Math.abs(dy) < LOCK_PX) return null;
  var d = dir === -1 ? -dx : dx;
  return d > 0 && Math.abs(dx) > 1.5 * Math.abs(dy) ? "x" : "y";
}

// Release: past a third of the width, or a quick flick of at least COMMIT_MIN_PX, commits.
// `dist` is the distance travelled in the gesture's own direction.
export function swipeCommits(dist, dtMs, width) {
  if (!(dist > 0) || !(width > 0)) return false;
  if (dist >= COMMIT_RATIO * width) return true;
  return dist >= COMMIT_MIN_PX && dtMs > 0 && dist / dtMs >= COMMIT_VELOCITY;
}

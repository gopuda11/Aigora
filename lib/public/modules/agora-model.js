// agora-model.js - Pure data model for the Club Agora room UI.
//
// Everything here is a plain data transform: no DOM, no store, no WS. The
// room UI (agora-render.js / agora-shell.js) is progressive enhancement over
// the existing project/session shell, so every normalizer is fail-closed:
// input the client cannot ground (unknown role, unknown narration source,
// missing id) is dropped rather than guessed. An empty result means "render
// nothing room-specific".
//
// Wire contract consumed here (server support is a TODO, see
// docs/roadmaps/planned/CLUB-AGORA.md steps 2-5):
//   rooms_state       { rooms: [{ id, name, role, description?, archived?,
//                                 memberCount?, unread?, members?: [...] }] }
//   session_list      items may carry `roomId`
//   session_narration { sessionId, replace?, entries: [{ id?, stage, source,
//                       text, ts?, status?, evidence?, visibility?, rubric? }] }
//
// Narration is limited to observable work (contract "Work narration"): an
// entry whose source is not on the observable list is dropped, so a server
// bug can never surface hidden reasoning through this UI.

import { sessionActivity } from "./activity-state.js";
import { normalizeCoaching } from "../aigora/coaching-model.js";
import { t } from "../aigora/i18n.js";

// The five learning-timeline stages, in contract order.
// (label/hint are getters so they follow the current language.)
export var STAGES = [
  { id: "understand", get label() { return t("agora.stageUnderstand"); }, get hint() { return t("agora.stageUnderstandHint"); } },
  { id: "next_action", get label() { return t("agora.stageNext"); }, get hint() { return t("agora.stageNextHint"); } },
  { id: "result", get label() { return t("agora.stageResult"); }, get hint() { return t("agora.stageResultHint"); } },
  { id: "verify", get label() { return t("agora.stageVerify"); }, get hint() { return t("agora.stageVerifyHint"); } },
  { id: "better_prompt", get label() { return t("agora.stageBetterPrompt"); }, get hint() { return t("agora.stageBetterPromptHint"); } },
];

var STAGE_IDS = {};
STAGES.forEach(function (s) { STAGE_IDS[s.id] = s; });

// Observable-work sources only. Anything else (for example a "reasoning" or
// "thinking" source) is rejected.
export var SOURCES = {
  get agent_message() { return t("agora.srcAgentMessage"); },
  get tool_call() { return t("agora.srcToolCall"); },
  get task_state() { return t("agora.srcTaskState"); },
  get changed_files() { return t("agora.srcChangedFiles"); },
  get test_output() { return t("agora.srcTestOutput"); },
  get approval_request() { return t("agora.srcApproval"); },
  get rationale() { return t("agora.srcRationale"); },
  get coaching() { return t("agora.srcCoaching"); },
  get provider_trace() { return t("agora.srcProviderTrace"); },
};

export var VERIFY_STATUS = {
  get pass() { return t("agora.verifyPass"); },
  get fail() { return t("agora.verifyFail"); },
  get not_run() { return t("agora.verifyNotRun"); },
};

export var ROLES = {
  get owner() { return t("agora.roleOwner"); },
  get member() { return t("agora.roleMember"); },
  get viewer() { return t("agora.roleViewer"); },
};

// First coaching rubric (contract "Work narration and prompt coaching").
export var RUBRIC = [
  { id: "outcome", get label() { return t("agora.rubricOutcome"); } },
  { id: "context", get label() { return t("agora.rubricContext"); } },
  { id: "scope", get label() { return t("agora.rubricScope"); } },
  { id: "acceptance", get label() { return t("agora.rubricAcceptance"); } },
  { id: "priority", get label() { return t("agora.rubricPriority"); } },
  { id: "approval", get label() { return t("agora.rubricApproval"); } },
];

var MAX_ENTRIES_PER_SESSION = 600;
var MAX_TEXT = 2000;

function asId(v) {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" && isFinite(v)) return String(v);
  return null;
}

function asCount(v) {
  return typeof v === "number" && isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

function asText(v, max) {
  if (typeof v !== "string") return "";
  var t = v.trim();
  return t.length > max ? t.slice(0, max) : t;
}

// --- Rooms -----------------------------------------------------------------

function normalizeMember(m) {
  if (!m || typeof m !== "object") return null;
  var id = asId(m.id);
  var name = asText(m.name || m.displayName || m.username, 80);
  if (!id || !name) return null;
  return {
    id: id,
    name: name,
    role: ROLES[m.role] ? m.role : "member",
    online: typeof m.online === "boolean" ? m.online : null,
  };
}

/**
 * Normalize a rooms_state payload. Rooms without an id or name are dropped;
 * an unknown role degrades to the least-privileged "viewer". Active rooms sort
 * before archived ones, otherwise server order is kept.
 * @param {*} raw
 * @returns {Array<object>}
 */
export function normalizeRooms(raw) {
  if (!Array.isArray(raw)) return [];
  var seen = {};
  var out = [];
  for (var i = 0; i < raw.length; i++) {
    var r = raw[i];
    if (!r || typeof r !== "object") continue;
    var id = asId(r.id);
    var name = asText(r.name, 80);
    if (!id || !name || seen[id]) continue;
    seen[id] = true;
    var members = [];
    if (Array.isArray(r.members)) {
      var memberSeen = {};
      for (var j = 0; j < r.members.length; j++) {
        var m = normalizeMember(r.members[j]);
        if (m && !memberSeen[m.id]) { memberSeen[m.id] = true; members.push(m); }
      }
    }
    out.push({
      id: id,
      name: name,
      description: asText(r.description, 200),
      role: ROLES[r.role] ? r.role : "viewer",
      archived: r.archived === true,
      memberCount: typeof r.memberCount === "number" && isFinite(r.memberCount) && r.memberCount >= 0
        ? Math.floor(r.memberCount) : members.length,
      unread: asCount(r.unread),
      members: members,
    });
  }
  var live = out.filter(function (r) { return !r.archived; });
  var archived = out.filter(function (r) { return r.archived; });
  return live.concat(archived);
}

/**
 * Which room the UI is showing. An explicit selection wins; otherwise the
 * active session's own roomId. Returns null when neither names a known room,
 * which keeps the legacy project/session view untouched.
 */
export function resolveActiveRoomId(rooms, selectedRoomId, activeSession) {
  if (!Array.isArray(rooms) || rooms.length === 0) return null;
  var has = function (id) {
    return id != null && rooms.some(function (r) { return r.id === String(id); });
  };
  if (has(selectedRoomId)) return String(selectedRoomId);
  if (activeSession && has(activeSession.roomId)) return String(activeSession.roomId);
  return null;
}

// Deterministic 0..4 index so a room keeps its seal colour across sessions.
export function sealIndex(id) {
  var s = String(id == null ? "" : id);
  var h = 0;
  for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 5;
}

// First user-perceived character (handles Hangul and surrogate pairs).
export function sealGlyph(name) {
  var chars = Array.from(String(name || "").trim());
  return chars.length ? chars[0] : "?";
}

// --- Collapsible left-rail sections -------------------------------------------

// Explicit disclosure state for the two left-rail sections. A missing key means
// "expanded", so a fresh store shows everything and only a user collapse is
// remembered.
export var SECTION_KEYS = ["rooms", "sessions"];

export function sectionExpanded(sections, key) {
  return !(sections && sections[key] === false);
}

/** Flip one section, leaving the other untouched. Unknown keys are ignored. */
export function toggleSection(sections, key) {
  var next = Object.assign({}, sections);
  if (SECTION_KEYS.indexOf(key) !== -1) next[key] = !sectionExpanded(sections, key);
  return next;
}

// --- Sessions and agents ----------------------------------------------------

var VENDOR_LABEL = { claude: "Claude", codex: "Codex",  get local() { return t("agora.vendorLocal"); } };

// Agents a room can use. Session agents stream inside a room session.
export var HARNESSES = [
  { id: "claude", label: "Claude", kind: "session" },
  { id: "codex", label: "Codex", kind: "session" },

];

export function agentLabel(sess) {
  if (!sess) return t("agora.agent");
  if (sess.agentName) return String(sess.agentName);
  if (sess.vendor && VENDOR_LABEL[sess.vendor]) return VENDOR_LABEL[sess.vendor];
  return t("agora.agent");
}

/**
 * Sessions that belong to a room, newest activity first. Sessions without a
 * roomId never match, so legacy sessions stay out of room lists.
 */
export function sessionsForRoom(sessions, roomId, currentUserId) {
  if (!Array.isArray(sessions) || roomId == null) return [];
  var out = [];
  for (var i = 0; i < sessions.length; i++) {
    var s = sessions[i];
    if (!s || s.roomId == null || String(s.roomId) !== String(roomId)) continue;
    if (Object.prototype.hasOwnProperty.call(s, "channelId") && s.channelId !== undefined && s.channelId !== null) continue;
    var act = sessionActivity(s, currentUserId == null ? null : currentUserId, { ignoreUnread: true });
    out.push({
      id: s.id,
      title: s.title || t("agora.untitledSession"),
      agent: agentLabel(s),
      running: act.active,
      mine: s.ownerId == null || currentUserId == null || s.ownerId === currentUserId,
      unread: asCount(s.unread),
      lastActivity: typeof s.lastActivity === "number" ? s.lastActivity : 0,
      active: s.active === true,
    });
  }
  out.sort(function (a, b) { return b.lastActivity - a.lastActivity; });
  return out;
}

/** Roll a room's sessions up into the numbers shown on the agent status card. */
export function summarizeAgents(roomSessions) {
  var list = Array.isArray(roomSessions) ? roomSessions : [];
  return {
    total: list.length,
    running: list.filter(function (s) { return s.running; }).length,
    unread: list.reduce(function (n, s) { return n + s.unread; }, 0),
  };
}

// --- Narration --------------------------------------------------------------

function normalizeStage(v) {
  if (typeof v !== "string") return null;
  var key = v.trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (STAGE_IDS[key]) return key;
  for (var i = 0; i < STAGES.length; i++) if (STAGES[i].label === v.trim()) return STAGES[i].id;
  return null;
}

function normalizeStatus(v) {
  if (typeof v !== "string") return null;
  var key = v.trim().toLowerCase().replace(/[-\s]+/g, "_");
  return VERIFY_STATUS[key] ? key : null;
}

var KINDS = { request: 1, call: 1, result: 1, approval: 1, error: 1, done: 1 };
var DECISIONS = { wait: 1, allow: 1, deny: 1, cancel: 1 };

/**
 * Validate narration entries. Returns { entries, dropped } where `dropped`
 * counts entries rejected as ungrounded (unknown stage or source, empty text,
 * or a verification entry without a recognised status).
 */
export function normalizeNarration(raw) {
  var entries = [];
  var dropped = 0;
  if (!Array.isArray(raw)) return { entries: entries, dropped: dropped };
  for (var i = 0; i < raw.length; i++) {
    var e = raw[i];
    var stage = e && normalizeStage(e.stage);
    var source = e && typeof e.source === "string" ? e.source.trim().toLowerCase() : "";
    var text = e ? asText(e.text, MAX_TEXT) : "";
    if (!stage || !SOURCES[source] || !text) { dropped++; continue; }
    // A thinking-shaped entry is accepted only when the provider explicitly
    // exposed it. Never accept inferred, reconstructed, or guessed reasoning.
    if (source === "provider_trace" && e.disclosure !== "provider_visible") { dropped++; continue; }
    var status = null;
    if (stage === "verify") {
      status = normalizeStatus(e.status);
      if (!status) { dropped++; continue; }
    }
    var rubric = null;
    if (stage === "better_prompt" && e.rubric && typeof e.rubric === "object") {
      rubric = {};
      RUBRIC.forEach(function (item) {
        if (typeof e.rubric[item.id] === "boolean") rubric[item.id] = e.rubric[item.id];
      });
    }
    entries.push({
      id: asId(e.id) || "n" + i,
      stage: stage,
      source: source,
      text: text,
      ts: typeof e.ts === "number" && isFinite(e.ts) ? e.ts : null,
      status: status,
      evidence: asText(e.evidence, 200),
      private: e.visibility === "private",
      rubric: rubric,
      // 지시 코칭 (aigora/coaching-model.js): the author's own rubric, or the "작성자만 볼 수 있어요" placeholder.
      coaching: stage === "better_prompt" && source === "coaching" ? normalizeCoaching(e.coaching) : null,
      locked: stage === "better_prompt" && source === "coaching" && e.locked === true,
      disclosure: source === "provider_trace" ? "provider_visible" : null,
      // Grouping facts the client narrator observed (aigora/turn-narration.js); server entries carry none.
      turn: asText(e.turn, 120) || null,
      kind: KINDS[e.kind] ? e.kind : null,
      request: asText(e.request, 160),
      tool: asText(e.tool, 60),
      target: asText(e.target, 200),
      failed: e.failed === true,
      decision: DECISIONS[e.decision] ? e.decision : null,
    });
  }
  return { entries: entries, dropped: dropped };
}

/**
 * Merge incoming (already normalized) entries into an existing list. With
 * `replace` the incoming list wins outright; otherwise entries are appended
 * and a repeated id replaces the earlier copy in place. Capped per session.
 */
export function mergeNarration(existing, incoming, replace) {
  var next = replace ? [] : (existing || []).slice();
  incoming.forEach(function (entry) {
    var at = -1;
    for (var i = 0; i < next.length; i++) if (next[i].id === entry.id) { at = i; break; }
    if (at >= 0) next[at] = entry; else next.push(entry);
  });
  return next.length > MAX_ENTRIES_PER_SESSION ? next.slice(next.length - MAX_ENTRIES_PER_SESSION) : next;
}

/**
 * Per-stage rollup for the work rail: entry count and the latest verification
 * status. `state` is "empty" until a stage has at least one entry.
 */
export function summarizeStages(entries) {
  var list = Array.isArray(entries) ? entries : [];
  return STAGES.map(function (stage) {
    var mine = list.filter(function (e) { return e.stage === stage.id; });
    var latest = mine.length ? mine[mine.length - 1] : null;
    var state = "empty";
    if (mine.length) state = stage.id === "verify" ? verifyRollup(mine) : "filled";
    return { id: stage.id, label: stage.label, hint: stage.hint, count: mine.length, state: state, latest: latest };
  });
}

// A single failure outranks passes; "not run" outranks pass because it means
// the evidence is incomplete.
function verifyRollup(verifyEntries) {
  var s = summarizeVerification(verifyEntries);
  if (s.fail > 0) return "fail";
  if (s.notRun > 0) return "not_run";
  return "pass";
}

/** Count verification entries by status; pass, fail and not-run stay separate. */
export function summarizeVerification(entries) {
  var out = { pass: 0, fail: 0, notRun: 0, total: 0 };
  (Array.isArray(entries) ? entries : []).forEach(function (e) {
    if (e.stage !== "verify") return;
    if (e.status === "pass") out.pass++;
    else if (e.status === "fail") out.fail++;
    else if (e.status === "not_run") out.notRun++;
    else return;
    out.total++;
  });
  return out;
}

/**
 * Split narration text into plain and code segments. Code spans (`...`) keep
 * their contents byte-for-byte so commands, paths, URLs, hashes and numbers are
 * shown exactly as the agent emitted them; the backticks are the only thing
 * consumed. An unmatched backtick stays plain text.
 */
export function segmentVerbatim(text) {
  var src = String(text == null ? "" : text);
  var out = [];
  var i = 0;
  while (i < src.length) {
    var open = src.indexOf("`", i);
    if (open === -1) break;
    var close = src.indexOf("`", open + 1);
    if (close === -1) break;
    if (open > i) out.push({ type: "text", value: src.slice(i, open) });
    if (close > open + 1) out.push({ type: "code", value: src.slice(open + 1, close) });
    i = close + 1;
  }
  if (i < src.length) out.push({ type: "text", value: src.slice(i) });
  return out;
}

// --- Members ----------------------------------------------------------------

/**
 * Presence for a member: an explicit `online` from the room payload wins,
 * otherwise fall back to the connection-level online id list the client
 * already tracks. Returns null when neither source knows.
 */
export function memberOnline(member, onlineIds) {
  if (member.online === true || member.online === false) return member.online;
  if (Array.isArray(onlineIds)) return onlineIds.indexOf(member.id) !== -1;
  return null;
}

// --- Turn cards ---------------------------------------------------------------
// The panel shows one card per turn instead of one row per event. Everything below only counts and groups
// entries that were observed; nothing is inferred, and 검증 is only ever as strong as its entries' status.

var EDIT_TOOLS = { Write: 1, Edit: 1, MultiEdit: 1, NotebookEdit: 1, apply_patch: 1, str_replace_editor: 1 };
var COMMAND_TOOLS = { Bash: 1, shell: 1, local_shell: 1, exec_command: 1 };

function isCoachingEntry(x) { return !!(x.coaching || x.locked); }

/**
 * Group entries into turns, keyed by the request id the narrator stamped on them. Entries with no turn (server
 * orchestration narration) join the turn they arrived in, so a replay lands them in the same card. Turn order
 * is first appearance, and entries keep their order. Coaching entries never belong to a turn card.
 * @returns {Array<{key:string, entries:Array<object>}>}
 */
export function groupTurns(entries) {
  var groups = [];
  var byKey = {};
  (Array.isArray(entries) ? entries : []).forEach(function (x) {
    if (isCoachingEntry(x)) return;
    var key = x.turn || (groups.length ? groups[groups.length - 1].key : "_");
    var g = byKey[key];
    if (!g) { g = byKey[key] = { key: key, entries: [] }; groups.push(g); }
    g.entries.push(x);
  });
  return groups;
}

/** The entries of the newest turn: what the stepper under the title reflects. */
export function latestTurnEntries(entries) {
  var groups = groupTurns(entries);
  return groups.length ? groups[groups.length - 1].entries : [];
}

function plain(text, max) {
  var t = String(text || "").replace(/`/g, "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

function countTools(calls) {
  var names = [];
  var n = {};
  calls.forEach(function (c) {
    var name = c.tool || t("agora.toolFallback");
    if (!n[name]) { n[name] = 0; names.push(name); }
    n[name]++;
  });
  return names.map(function (name) { return { name: name, count: n[name] }; });
}

function distinctCount(calls) {
  var seen = {};
  var loose = 0;
  calls.forEach(function (c) { if (c.target) seen[c.target] = 1; else loose++; });
  return Object.keys(seen).length + loose;
}

/**
 * Roll one turn up into what its card shows. `opts.running` is whether this turn may still be running (only the
 * newest turn can be). `lines` maps the four narrated stages to a short state; the fifth step (더 나은 지시)
 * lives in its own tab.
 */
export function summarizeTurn(group, opts) {
  var list = group.entries;
  var calls = list.filter(function (x) { return x.kind === "call"; });
  var results = list.filter(function (x) { return x.kind === "result"; });
  var approvals = list.filter(function (x) { return x.kind === "approval"; });
  var request = "";
  var firstTs = null;
  list.forEach(function (x) {
    if (x.kind === "request" && !request) request = x.request || plain(x.text, 160);
    if (firstTs == null && x.ts != null) firstTs = x.ts;
  });
  var resolved = {};
  results.forEach(function (x) { resolved[x.id.replace(/^t:res:/, "")] = true; });
  var pendingCalls = calls.filter(function (x) { return !resolved[x.id.replace(/^t:tool:/, "")]; }).length;
  var failed = results.filter(function (x) { return x.failed; }).length;
  var done = list.some(function (x) { return x.kind === "done"; });
  var errored = list.some(function (x) { return x.kind === "error"; });
  var verify = summarizeVerification(list);
  var running = !!(opts && opts.running) && !done && !errored;
  var edits = calls.filter(function (x) { return EDIT_TOOLS[x.tool]; });
  var commands = calls.filter(function (x) { return COMMAND_TOOLS[x.tool]; });
  var otherCalls = calls.length - edits.length - commands.length;
  var pendingApprovals = approvals.filter(function (x) { return x.decision === "wait"; }).length;

  function latestText(stage) {
    for (var i = list.length - 1; i >= 0; i--) if (list[i].stage === stage && !list[i].kind) return plain(list[i].text, 70);
    return "";
  }
  function has(stage) { return list.some(function (x) { return x.stage === stage; }); }

  var next = [];
  if (edits.length) next.push(t("agora.nextFiles", { count: distinctCount(edits) }));
  if (commands.length) next.push(t("agora.nextCommands", { count: commands.length }));
  if (otherCalls > 0) next.push(t("agora.nextTools", { count: otherCalls }));
  if (approvals.length) next.push(pendingApprovals ? t("agora.nextApprovalsPending", { count: approvals.length, pending: pendingApprovals }) : t("agora.nextApprovals", { count: approvals.length }));
  var nextLine = next.join(", ") || latestText("next_action") || (calls.length === 0 && (done || has("next_action")) ? t("agora.noToolCalls") : "");

  var resultLine = "";
  if (results.length || pendingCalls) {
    resultLine = pendingCalls ? t("agora.resultLinePending", { ok: results.length - failed, failed: failed, pending: pendingCalls }) : t("agora.resultLine", { ok: results.length - failed, failed: failed });
  } else resultLine = latestText("result") || (done ? t("agora.noToolResults") : "");

  var verifyLine = "";
  if (verify.fail > 0) verifyLine = t("agora.verifyLineFail", { count: verify.fail });
  else if (verify.notRun > 0) verifyLine = t("agora.verifyNotRun");
  else if (verify.pass > 0) verifyLine = t("agora.verifyLinePass", { count: verify.pass });

  var lines = {
    understand: { text: request ? "" : latestText("understand"), state: has("understand") ? "done" : "empty" },
    next_action: { text: nextLine, state: nextLine || has("next_action") ? "done" : "empty" },
    result: { text: resultLine, state: resultLine && !pendingCalls ? "done" : "empty" },
    verify: { text: verifyLine, state: verifyLine ? "done" : "empty" },
  };
  var live = null;
  if (running) {
    var last = list[list.length - 1];
    live = last ? last.stage : "understand";
    if (lines[live]) lines[live].state = "active";
  }
  var outcome = "idle";
  if (running) outcome = "running";
  else if (errored || verify.fail > 0) outcome = "fail";
  else if (failed > 0) outcome = "warn";
  else if (done) outcome = "ok";

  return {
    key: group.key,
    request: request,
    ts: firstTs,
    running: running,
    outcome: outcome,
    live: live,
    toolCounts: countTools(calls),
    approvals: approvals.length,
    pendingApprovals: pendingApprovals,
    failed: failed,
    lines: lines,
  };
}

// display-prefs.js - The per-person display choices of the standalone Aigora page that
// are not the 테마: 세션 표시 방식 (A 제목 메뉴 / B 사이드바 목록 / C 목록 칼럼), 동작 줄이기, and
// whether the right-hand inspector is open. The server keeps the first two per user
// (PUT /api/user/display-prefs, returned by /api/me); localStorage mirrors them so the
// first paint is right before /api/me answers, and is the only home of the inspector state.
// Root attributes: data-session-layout="A|B|C", data-reduce-motion="1" (aigora-app.css reads both).

export var LAYOUT_KEY = "aigora.sessionLayout";
export var MOTION_KEY = "aigora.reduceMotion";
export var INSPECTOR_KEY = "aigora.inspector";
export var CHANNEL_INSPECTOR_KEY = "aigora.inspector.channel";
export var COACHING_KEY = "aigora.promptCoaching";
export var DEFAULT_LAYOUT = "C";

export function normalizeLayout(value) {
  return value === "A" || value === "B" ? value : DEFAULT_LAYOUT;
}

// Storage can be missing or throw (private mode, blocked site data): both mean "default".
function read(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}
function write(key, value) {
  try { localStorage.setItem(key, value); } catch (e) { /* applies for this visit only */ }
}

export function readLayout() { return normalizeLayout(read(LAYOUT_KEY)); }
export function saveLayout(layout) { write(LAYOUT_KEY, normalizeLayout(layout)); }
export function applyLayout(layout) {
  document.documentElement.setAttribute("data-session-layout", normalizeLayout(layout));
}

export function readReduceMotion() { return read(MOTION_KEY) === "1"; }
export function saveReduceMotion(on) { write(MOTION_KEY, on ? "1" : "0"); }
export function applyReduceMotion(on) {
  var root = document.documentElement;
  if (on) root.setAttribute("data-reduce-motion", "1");
  else root.removeAttribute("data-reduce-motion");
}

// The inspector is closed until someone opens it; the choice is remembered.
export function readInspector() { return read(INSPECTOR_KEY) === "open"; }
export function saveInspector(open) { write(INSPECTOR_KEY, open ? "open" : "closed"); }

// In 나만의 채널 the inspector stays closed unless it was opened there (its own remembered choice).
export function readChannelInspector() { return read(CHANNEL_INSPECTOR_KEY) === "open"; }
export function saveChannelInspector(open) { write(CHANNEL_INSPECTOR_KEY, open ? "open" : "closed"); }

// 지시 코칭 표시 ("더 나은 지시" rubric): on unless the person switched it off.
export function readCoaching() { return read(COACHING_KEY) !== "0"; }
export function saveCoaching(on) { write(COACHING_KEY, on ? "1" : "0"); }

import { t, formatDate } from "./i18n.js";
// session-layouts-model.js - Pure rules for how 나만의 채널 sessions are shown:
// the three 세션 표시 방식 options, the date label of a session row, the B list cap
// and the "crowded" rule that folds the sidebar. No DOM, store or network.

// Display order of the options in 설정 > 일반. C is the default (display-prefs.js).
export var LAYOUT_CHOICES = [
  { id: "A", get label() { return t("sessionLayouts.aLabel"); }, get hint() { return t("sessionLayouts.aHint"); } },
  { id: "B", get label() { return t("sessionLayouts.bLabel"); }, get hint() { return t("sessionLayouts.bHint"); } },
  { id: "C", get label() { return t("sessionLayouts.cLabel"); }, get hint() { return t("sessionLayouts.cHint"); }, isDefault: true },
];

// Layout B shows this many of the most recent sessions, the rest behind "더 보기 (n)".
export var B_SESSION_CAP = 5;

// Under this viewport width the sidebar folds when the list column and the inspector would
// otherwise leave the thread too narrow. The CSS media query in aigora-app.css must match.
export var CROWD_BELOW_PX = 1440;

// Up to this width the C list column would leave the thread too narrow next to the sidebar, so the
// session list shows as the A popover instead (the saved choice stays C). The media query in
// aigora-app.css (.ai-session-col) and the one in client.js must match.
export var COLUMN_MAX_PX = 1100;
export function effectiveLayout(layout, viewportWidth) {
  return layout === "C" && typeof viewportWidth === "number" && viewportWidth <= COLUMN_MAX_PX ? "A" : layout;
}

// "오늘" / "어제" / "9월 30일" (this year) / "2025년 9월 30일". `ts` is epoch ms.
export function dateLabel(ts, now) {
  if (typeof ts !== "number" || !isFinite(ts) || ts <= 0) return "";
  var at = new Date(ts);
  var ref = new Date(typeof now === "number" && isFinite(now) ? now : Date.now());
  var day = function (d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  var diff = Math.round((day(ref) - day(at)) / 86400000);
  if (diff <= 0) return t("sessionLayouts.today");
  if (diff === 1) return t("sessionLayouts.yesterday");
  return at.getFullYear() === ref.getFullYear() ? formatDate(ts, { month: "long", day: "numeric" }) : formatDate(ts, { year: "numeric", month: "long", day: "numeric" });
}

// Layout B: the rows to draw and how many are folded behind "더 보기".
export function limitSessions(sessions, showAll) {
  var list = Array.isArray(sessions) ? sessions : [];
  if (showAll || list.length <= B_SESSION_CAP) return { shown: list, hidden: 0 };
  // The open session is never folded away, even when it is not among the newest.
  var shown = list.slice(0, B_SESSION_CAP);
  var current = list.filter(function (s) { return s.active; })[0];
  if (current && shown.indexOf(current) === -1) shown[B_SESSION_CAP - 1] = current;
  return { shown: shown, hidden: list.length - B_SESSION_CAP };
}

// The C list column and the inspector together: the sidebar folds (CSS decides at which
// width) and a header button brings it back. Only layout C has a column.
// Between 1024 and 1100px the inspector is a column next to the sidebar, so it folds the sidebar in any layout.
export function isCrowded(state) {
  if (!state || !state.inspectorOpen) return false;
  return (state.layout === "C" && !!state.privateOpen) || !!state.midWidth;
}

// The tiny looping preview inside each 세션 표시 방식 card. Markup only: the motion is CSS
// (.ai-lay-prev in aigora-app.css), and without motion (동작 줄이기 or the OS setting) it
// rests on the frame where the feature is shown.
export function layoutPreviewHtml(id) {
  var side = '<i class="p-side"><b></b><b></b></i>';
  if (id === "A") {
    return '<span class="ai-lay-prev ai-lay-prev-a" aria-hidden="true">' + side +
      '<i class="p-head"><b class="p-title"></b></i><i class="p-body"></i>' +
      '<i class="p-pop"><b></b><b></b><b></b></i></span>';
  }
  if (id === "B") {
    return '<span class="ai-lay-prev ai-lay-prev-b" aria-hidden="true">' +
      '<i class="p-side"><b></b><b class="p-on"></b><b class="p-sub p-sub1"></b><b class="p-sub p-sub2"></b><b class="p-sub p-sub3"></b></i>' +
      '<i class="p-head"><b class="p-title"></b></i><i class="p-body"></i></span>';
  }
  return '<span class="ai-lay-prev ai-lay-prev-c" aria-hidden="true">' + side +
    '<i class="p-col"><b></b><b class="p-on"></b><b></b></i>' +
    '<i class="p-head"><b class="p-title"></b></i><i class="p-body"></i></span>';
}

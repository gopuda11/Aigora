// guide-model.js - Content of the 사용설명서. Pure data, no DOM.
// Every label named here exists in the UI (private-channels.js, shared-posts*.js, decision.js,
// office.js, transcription.js, room-admin, settings-model.js, index.html).
import { t } from "./i18n.js";

export function guideTitle() { return t("guide.title"); }

// Bump when cards are added: users who saw an older version get the "새 기능" variant once.
export const GUIDE_VERSION = 2;

// `since` = the guide version that introduced the card; `admin` = only shown to admins.
var CARDS = [
  { since: 1, key: "s1", n: 2 },
  { since: 1, key: "s2", n: 2 },
  { since: 1, key: "s3", n: 2 },
  { since: 1, key: "s4", n: 3 },
  { since: 2, key: "s6", n: 3 },   // AI 자동 선택 + 👍/👎
  { since: 2, key: "s7", n: 3 },   // 검증 한 줄 + 실행 기록
  { since: 2, key: "s8", n: 3 },   // 파일 / 함께 편집 / 음성
  { since: 2, key: "a1", n: 3, admin: true },
  { since: 1, key: "s5", n: 3 },
];

// Which variant to show: "full" (never seen), "news" (seen an older version), or null.
export function guideMode(seen, version) {
  if (seen !== true && seen !== false) return null;     // viewer unknown yet
  if (seen === false) return "full";
  return (version || 1) < GUIDE_VERSION ? "news" : null;
}

// A function (not a constant) so the text follows the current language.
// mode "news": only cards newer than `fromVersion`.
export function guideSteps(opts) {
  var o = opts || {}, from = o.mode === "news" ? (o.fromVersion || 1) : 0;
  return CARDS.filter(function (c) { return (!c.admin || o.admin) && c.since > from; }).map(function (c) {
    var body = [];
    for (var i = 1; i <= c.n; i++) body.push(t("guide." + c.key + "Body" + i));
    return { title: t("guide." + c.key + "Title"), body: body };
  });
}

// prompt-coaching.js - Pure, deterministic prompt coaching ("더 나은 지시").
//
// Checks one AI-directed request against six criteria (outcome, context, scope, acceptance, priority,
// approval) with Korean-aware plus English heuristics. No I/O, no clock, no model call: the same text
// always yields the same result. The suggestion never replaces the author's text: it is the original,
// verbatim, followed by labelled scaffold lines with [bracketed] placeholders for the missing parts.
// Whatever the author typed (code, paths, URLs, hashes, numbers) is therefore kept exactly as written.

var CRITERIA = [
  { id: "outcome", label: "원하는 결과" },
  { id: "context", label: "맥락과 입력" },
  { id: "scope", label: "허용·금지 범위" },
  { id: "acceptance", label: "확인 기준" },
  { id: "priority", label: "우선순위" },
  { id: "approval", label: "승인 경계" },
];

var SCAFFOLD = {
  outcome: "원하는 결과: [무엇을 어떻게 바꾸고 싶은지]",
  context: "참고할 맥락: [관련 파일, 경로, 로그, 현재 상태]",
  scope: "범위: [수정해도 되는 곳 / 건드리면 안 되는 곳]",
  acceptance: "완료 기준: [어떤 결과가 나오면 성공인지]",
  priority: "우선순위: [속도, 품질, 비용 중 무엇을 먼저 볼지]",
  approval: "승인 경계: [삭제·배포·외부 전송 등 먼저 물어봐야 할 일]",
};

var REASONS = {
  outcome: {
    present: "무엇을 해 달라는지 분명해요.",
    weak: "해 달라는 일은 보이지만 구체적인 결과가 짧거나 모호해요.",
    missing: "원하는 결과가 드러나지 않아요.",
  },
  context: {
    present: "파일, 경로, 로그 같은 참고 맥락이 있어요.",
    weak: "맥락을 말하긴 했지만 파일·경로·로그처럼 짚을 수 있는 입력이 없어요.",
    missing: "관련 파일, 경로, 로그, 현재 상태가 없어요.",
  },
  scope: {
    present: "무엇만 바꾸고 무엇은 건드리지 말지 적혀 있어요.",
    weak: "작업 위치는 있지만 건드리면 안 되는 범위는 없어요.",
    missing: "허용·금지 범위가 없어 에이전트가 넓게 손댈 수 있어요.",
  },
  acceptance: {
    present: "끝났다고 볼 확인 기준이 있어요.",
    weak: "확인해 달라고는 했지만 무엇이 되면 성공인지가 없어요.",
    missing: "어떤 결과가 나오면 성공인지 없어요.",
  },
  priority: {
    present: "무엇을 먼저 볼지(우선순위·절충)가 있어요.",
    weak: "중요하다는 말은 있지만 무엇을 위해 무엇을 양보할지는 없어요.",
    missing: "속도·품질·비용 같은 우선순위가 없어요.",
  },
  approval: {
    present: "먼저 물어봐야 할 일(승인 경계)이 적혀 있어요.",
    weak: "위험할 수 있는 작업이 보이는데 승인받을 경계는 없어요.",
    missing: "먼저 승인받아야 할 일이 정해져 있지 않아요.",
  },
};

var TRIVIAL = new Set(("네 예 응 아니 아니요 아뇨 ㅇㅇ ㅇㅋ 좋아 좋아요 좋습니다 좋네 고마워 고마워요 감사 감사해요 감사합니다 그래 그래요 맞아 맞아요 " +
  "알겠어 알겠어요 알겠습니다 확인 확인했어 확인했어요 계속 진행 진행해 진행해줘 진행해주세요 해줘 ok okay yes no y n thanks thank you thx go continue sure yep nope").split(" "));

function has(re, s) { return re.test(s); }

// --- Heuristics. Each returns "present" | "weak" | "missing" for already-normalised text. ---

var PATH_RE = /(?:^|[\s"'(`])(?:\.{0,2}\/)?[\w.@~-]+(?:\/[\w.@~-]+)+|\b[\w-]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|md|json|css|html|sh|yml|yaml|txt|go|rs|java|sql|toml)\b/i;
var URL_RE = /https?:\/\/\S+/i;
var HASH_RE = /\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/i;
var CODE_RE = /`[^`]+`|```/;
var ERROR_RE = /에러|오류|예외|스택|로그(?!인)|stack\s*trace|exception|\berror\b|\blog\b|traceback|status \d{3}|\b\d{3} error/i;
var CONTEXT_WORDS = /현재|지금|기존|참고|파일|함수|화면|페이지|모듈|배경|상황|재현|currently|\bfile\b|function|module|\bpage\b|because|background|repro/gi;

function context(s) {
  if (has(PATH_RE, s) || has(URL_RE, s) || has(HASH_RE, s) || has(CODE_RE, s) || has(ERROR_RE, s)) return "present";
  var n = (s.match(CONTEXT_WORDS) || []).length;
  return n >= 2 ? "present" : n === 1 ? "weak" : "missing";
}

var OUTCOME_VERB = /고쳐|고치|수정|추가|만들|구현|작성|바꿔|바꾸|변경|삭제|제거|정리|분석|조사|확인해|설명|리뷰|검토|개선|리팩터|찾아|알려|보여|생성|옮겨|통합|연결|설치|배포|비교|요약|번역|\b(?:fix|add|implement|create|write|build|change|update|remove|delete|refactor|review|explain|analy[sz]e|find|investigate|summari[sz]e|compare|migrate|make|rename|set up|install|deploy)\b/i;
var VAGUE_WORDS = /뭔가|그냥|알아서|아무거나|something|stuff|anything|\bhelp\b|도와/i;

function outcome(s) {
  var words = s.split(/\s+/).filter(Boolean).length;
  if (has(OUTCOME_VERB, s)) return words >= 3 && !(words < 8 && has(VAGUE_WORDS, s)) ? "present" : "weak";
  return words >= 4 ? "weak" : "missing";
}

var SCOPE_LIMIT = /건드리지|수정하지|바꾸지|변경하지|삭제하지|지우지|손대지|하지\s*마|말고|말아|금지|제외|이외|외에는|범위|\S\s*(?:만|에서만)\s*(?:수정|변경|고치|바꾸|작업|건드|읽|해)|\bonly\b|do not|don't|dont\b|must not|\bnever\b|without (?:touching|changing|modifying)|\bexcept\b|out of scope|\bscope\b|read-only|no changes/i;
var SCOPE_PLACE = /폴더|디렉터리|디렉토리|모듈|파일|컴포넌트|함수|\bfolder\b|directory|module|component|\bfile\b/i;

function scope(s) {
  if (has(SCOPE_LIMIT, s)) return "present";
  return has(PATH_RE, s) || has(SCOPE_PLACE, s) ? "weak" : "missing";
}

var ACCEPT_STRONG = /완료\s*기준|성공\s*기준|통과|검증|증거|스크린샷|되어야|돼야|나와야|확인되면|acceptance|done when|success criteria|should (?:pass|return|show|be|work)|expected|\bpass(?:es|ed)?\b|verify|assert/i;
var ACCEPT_WEAK = /확인|잘\s*되|동작|제대로|테스트|돌려|\bworks?\b|\bcheck\b|\btests?\b|run it/i;

function acceptance(s) {
  return has(ACCEPT_STRONG, s) ? "present" : has(ACCEPT_WEAK, s) ? "weak" : "missing";
}

var PRIORITY_STRONG = /우선순위|우선|가장\s*중요|(?:속도|품질|정확성?|비용|안정성?|간결|가독성|성능)\s*(?:보다|대신)|급해|긴급|\basap\b|urgent|trade-?off|priorit|rather than|instead of|\bover (?:speed|quality|cost|performance)|most important/i;
var PRIORITY_WEAK = /중요|빨리|빠르게|신중|조심|천천히|\bquick|\bcareful|\bfast\b/i;

function priority(s) {
  return has(PRIORITY_STRONG, s) ? "present" : has(PRIORITY_WEAK, s) ? "weak" : "missing";
}

var APPROVAL_STRONG = /승인|허락|허가|확인받|물어보고|물어본\s*뒤|묻고|묻지|먼저\s*(?:알려|보여|물어|확인)|(?:커밋|푸시|배포|삭제|머지)하기\s*전|ask me|ask before|before you (?:push|commit|deploy|delete|merge|run|install)|approval|approve|confirm with me|check with me|let me (?:review|approve)|dry[- ]run/i;
var APPROVAL_RISKY = /배포|삭제|지워|제거|푸시|커밋|머지|결제|발송|덮어|초기화|\bforce\b|\bdeploy|\bdelete|\bdrop\b|\bpush\b|\bcommit\b|\bmerge\b|rm -rf|\bpublish/i;

function approval(s) {
  return has(APPROVAL_STRONG, s) ? "present" : has(APPROVAL_RISKY, s) ? "weak" : "missing";
}

var CHECKS = { outcome: outcome, context: context, scope: scope, acceptance: acceptance, priority: priority, approval: approval };

function notApplicable(reason) {
  return { applicable: false, criteria: [], score: null, level: null, hint: reason, suggestion: null };
}

function isTrivial(t) {
  if (/^\/[\w:-]+(\s|$)/.test(t)) return true; // a slash command
  var tokens = t.toLowerCase().replace(/[!?.,~…]+/g, " ").split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  return tokens.every(function (w) { return TRIVIAL.has(w); }) || t.replace(/\s+/g, "").length < 3;
}

function coachPrompt(text) {
  if (typeof text !== "string" || !text.trim()) return notApplicable("비어 있는 지시예요.");
  var original = text;
  var t = text.trim();
  if (isTrivial(t)) return notApplicable("짧은 확인이나 명령어라 점검하지 않았어요.");

  var criteria = CRITERIA.map(function (c) {
    var status = CHECKS[c.id](t);
    return { id: c.id, label: c.label, status: status, reason: REASONS[c.id][status] };
  });
  var points = criteria.reduce(function (n, c) { return n + (c.status === "present" ? 2 : c.status === "weak" ? 1 : 0); }, 0);
  var score = Math.round(points / 12 * 100);
  var level = score >= 80 ? "strong" : score >= 45 ? "ok" : "needs";

  var missing = criteria.filter(function (c) { return c.status === "missing"; });
  var weak = criteria.filter(function (c) { return c.status === "weak"; });
  var hint;
  if (!missing.length && !weak.length) hint = "여섯 가지 항목이 모두 갖춰져 있어요.";
  else {
    var names = missing.concat(weak).slice(0, 2).map(function (c) { return c.label; }).join(", ");
    hint = missing.length + weak.length > 2
      ? names + " 등을 보강하면 에이전트가 덜 헤매요."
      : names + "을(를) 보강하면 에이전트가 덜 헤매요.";
  }
  var suggestion = missing.length
    ? original.replace(/\s+$/, "") + "\n\n" + missing.map(function (c) { return SCAFFOLD[c.id]; }).join("\n")
    : null;
  return { applicable: true, criteria: criteria, score: score, level: level, hint: hint, suggestion: suggestion };
}

// HOOK (not implemented on purpose): an optional LLM explanation for ambiguous prompts, or when the author
// explicitly asks "왜 이렇게 제안했나요?". The deterministic path above handles every common case and keeps
// token use at zero; a later slice may fill this in behind an explicit user action. It must never call a
// model on its own, never rewrite the author's text, and keep code, paths, URLs, hashes and numbers verbatim.
function explainWithLlm(/* result, originalText */) {
  return Promise.resolve(null);
}

module.exports = { CRITERIA: CRITERIA, SCAFFOLD: SCAFFOLD, coachPrompt: coachPrompt, explainWithLlm: explainWithLlm };

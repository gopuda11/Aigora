"use strict";

// Ensemble rule for the Clef + JEV decision backend. The numbers are the tuned defaults of the author's decision
// policy v1 (the owner's own deployment); this public core has no labelled accuracy store, so the uncalibrated
// disagreement rule applies: abstain rather than guess which provider is more accurate.
//   - both answer and agree on the executor: equal-weight average of the probabilities; abstain below AGREE_MIN
//   - both answer and disagree: abstain (abstain_disagree)
//   - only one answers: its top choice must reach its own floor (CLEF_MIN / JEV_MIN) and lead the runner-up by MARGIN_MIN
//   - neither answers: no decision (the caller falls back like any Clef failure)
var CLEF_MIN = 0.40, JEV_MIN = 0.70, MARGIN_MIN = 0.15, AGREE_MIN = 0.40;
var CLEF_WEIGHT = 0.5, JEV_WEIGHT = 0.5;
// CLEF_MIN, JEV_MIN, MARGIN_MIN: policy v1 default thresholds. AGREE_MIN and the equal weights: policy v1 ensemble defaults.
function avg(a, b) { return Math.round((CLEF_WEIGHT * a + JEV_WEIGHT * b) * 10000) / 10000; }
function mergeChoice(a, b, prefer) {
  var p = {}, keys = Object.keys(a.probabilities);
  keys.forEach(function (k) { p[k] = avg(a.probabilities[k], b.probabilities[k]); });
  var top = keys.reduce(function (best, k) { return p[k] > p[best] ? k : best; }, keys[0]);
  if (prefer && p[prefer] >= p[top] - 1e-9) top = prefer;
  return { choice: top, probabilities: p, confidence: p[top] };
}
function abstention(a, min, margin) {
  if (!a.executor) return null;
  var ps = Object.values(a.executor.probabilities).sort(function (x, y) { return y - x; });
  if (ps[0] < min) return "abstain_low_confidence";
  if (margin && ps[0] - (ps[1] || 0) < MARGIN_MIN - 1e-9) return "abstain_small_margin";
  return null;
}
function usable(r) { return r && r.ok && r.answers && !(r.meta && r.meta.abstain); }
function combine(c, j) {
  var ca = usable(c) ? c.answers : null, ja = usable(j) ? j.answers : null;
  if (!ca && !ja) return { ok: false, reason: "no_decision", meta: { by: "ensemble" } };
  var a, by, reason;
  if (ca && ja) {
    by = "ensemble";
    a = Object.assign({}, ca, { model: [ca.model, ja.model].filter(Boolean).join("+") || null,
      task_kind: mergeChoice(ca.task_kind, ja.task_kind), needs_current_sources: avg(ca.needs_current_sources, ja.needs_current_sources),
      needs_edit: ca.needs_edit !== null && ja.needs_edit !== null ? avg(ca.needs_edit, ja.needs_edit) : (ca.needs_edit !== null ? ca.needs_edit : ja.needs_edit),
      executor: ca.executor && ja.executor ? mergeChoice(ca.executor, ja.executor, ca.executor.choice === ja.executor.choice ? ca.executor.choice : null) : ca.executor || ja.executor,
      usage: { input_tokens: ((ca.usage || {}).input_tokens || 0) + ((ja.usage || {}).input_tokens || 0), output_tokens: ((ca.usage || {}).output_tokens || 0) + ((ja.usage || {}).output_tokens || 0) },
    });
    reason = ca.executor && ja.executor && ca.executor.choice !== ja.executor.choice ? "abstain_disagree" : abstention(a, AGREE_MIN, false);
    // Missing executor on either provider is an abstention for executor selection.
    if (!!ca.executor !== !!ja.executor) reason = abstention(a, ca.executor ? CLEF_MIN : JEV_MIN, true);
  } else {
    by = ca ? "clef" : "jev"; a = ca || ja;
    reason = abstention(a, ca ? CLEF_MIN : JEV_MIN, true);
  }
  return { ok: true, answers: a, model: a.model, meta: { by: by, abstain: !!reason, reason: reason || "decided" } };
}
module.exports = { combine: combine, abstention: abstention, CLEF_MIN: CLEF_MIN, JEV_MIN: JEV_MIN, MARGIN_MIN: MARGIN_MIN, AGREE_MIN: AGREE_MIN };

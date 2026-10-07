// ask-user-model.js - the question card of Claude's AskUserQuestion tool in the Aigora chat.
// Wire format (legacy console, lib/public/modules/tools.js; server lib/project-sessions.js):
//   server -> client  tool_executing { id, name: "AskUserQuestion", input: { questions: [{ header, question, multiSelect, options: [{ label, description }] }] } }
//   server -> client  ask_user_answered { toolId, answers? }   (answers: { "<question index>": "text" }; absent = cancelled / turn ended)
//   client -> server  ask_user_response { toolId, answers: { "<question index>": "text" } }   (multi-select: labels joined with ", ")
// Pure: no DOM, no WS. Selections live on the item so a re-render keeps them.

import { escapeHtml } from "../modules/escape-html.js";
import { t } from "./i18n.js";

var MAX_Q = 8, MAX_OPT = 12, MAX_OTHER = 2000;

function str(v, max) { return typeof v === "string" ? v.slice(0, max) : ""; }

function normalizeQuestions(input) {
  if (!input || !Array.isArray(input.questions) || !input.questions.length) return null;
  return input.questions.slice(0, MAX_Q).map(function (q) {
    q = q && typeof q === "object" ? q : {};
    return {
      header: str(q.header, 80), question: str(q.question, 1000), multiSelect: q.multiSelect === true,
      options: (Array.isArray(q.options) ? q.options : []).slice(0, MAX_OPT).filter(function (o) { return o && typeof o === "object" && typeof o.label === "string"; })
        .map(function (o) { return { label: o.label.slice(0, 300), description: str(o.description, 600) }; }),
    };
  });
}

export function findAsk(th, toolId) {
  for (var i = 0; i < th.items.length; i++) if (th.items[i].role === "ask" && th.items[i].toolId === toolId) return th.items[i];
  return null;
}

function cleanAnswers(a) {
  if (!a || typeof a !== "object" || Array.isArray(a)) return null;
  var out = {}, any = false;
  Object.keys(a).forEach(function (k) { if (/^\d+$/.test(k) && a[k] != null && String(a[k]) !== "") { out[k] = String(a[k]).slice(0, MAX_OTHER * 2); any = true; } });
  return any ? out : null;
}

/** Fold one server frame. Returns true when the thread changed; undefined when the frame is not an ask frame. */
export function foldAskUser(th, msg, push) {
  if (msg.type === "tool_executing" && msg.name === "AskUserQuestion") {
    var qs = normalizeQuestions(msg.input);
    if (!qs || typeof msg.id !== "string" || !msg.id || findAsk(th, msg.id)) return false;
    var settled = th.askSettled && th.askSettled[msg.id];
    var item = { role: "ask", toolId: msg.id, questions: qs, state: settled ? "closed" : "pending", answers: settled ? settled.answers : null,
      sel: {}, otherOn: {}, other: {}, submitting: false, ts: msg._ts || 0 };
    push(th, item);
    return true;
  }
  if (msg.type === "ask_user_answered") {
    if (typeof msg.toolId !== "string" || !msg.toolId) return false;
    var answers = cleanAnswers(msg.answers);
    var it = findAsk(th, msg.toolId);
    if (!it) { th.askSettled = th.askSettled || {}; th.askSettled[msg.toolId] = { answers: answers }; return false; }
    if (it.state === "closed" && !answers) return false;
    it.state = "closed"; it.submitting = false; it.answers = answers || it.answers;
    return true;
  }
  if (msg.type === "done") {
    var changed = false;
    th.items.forEach(function (x) { if (x.role === "ask" && x.state === "pending") { x.state = "closed"; x.submitting = false; changed = true; } });
    return changed;
  }
  if (msg.type === "error") {
    var freed = false;
    th.items.forEach(function (x) { if (x.role === "ask" && x.submitting) { x.submitting = false; freed = true; } });
    return freed;
  }
  return undefined;
}

/** The answer text of one question, or "" while unanswered. */
function answerOf(it, qi) {
  var q = it.questions[qi], parts = [];
  (it.sel[qi] || []).slice().sort(function (a, b) { return a - b; }).forEach(function (oi) { if (q.options[oi]) parts.push(q.options[oi].label); });
  var other = it.otherOn[qi] ? String(it.other[qi] || "").trim() : "";
  if (other) parts.push(other);
  return parts.join(", ");
}

/** The exact ask_user_response payload, or null while any question is unanswered. */
export function buildResponse(it) {
  var answers = {};
  for (var qi = 0; qi < it.questions.length; qi++) {
    var a = answerOf(it, qi);
    if (!a) return null;
    answers[String(qi)] = a;
  }
  return { type: "ask_user_response", toolId: it.toolId, answers: answers };
}

/** Choose an option (single: replaces, also drops Other; multi: toggles). */
export function toggleOption(it, qi, oi) {
  var q = it.questions[qi];
  if (!q || !q.options[oi]) return false;
  var cur = it.sel[qi] || [];
  if (q.multiSelect) it.sel[qi] = cur.indexOf(oi) >= 0 ? cur.filter(function (x) { return x !== oi; }) : cur.concat(oi);
  else { it.sel[qi] = [oi]; it.otherOn[qi] = false; }
  return true;
}

export function toggleOther(it, qi) {
  var q = it.questions[qi];
  if (!q) return false;
  if (q.multiSelect) it.otherOn[qi] = !it.otherOn[qi];
  else { it.otherOn[qi] = !it.otherOn[qi]; if (it.otherOn[qi]) it.sel[qi] = []; }
  return true;
}

export function setOtherText(it, qi, text) {
  if (!it.questions[qi]) return false;
  it.other[qi] = String(text == null ? "" : text).slice(0, MAX_OTHER);
  return true;
}

/** Interactive only while its turn is still running, and only for someone who may answer. */
export function isLive(it, th) { return it.state === "pending" && !!th.processing; }

export function renderAsk(it, th, canAnswer) {
  var id = escapeHtml(it.toolId);
  var live = isLive(it, th);
  var state = it.state === "closed" ? (it.answers ? "answered" : "ended") : (live ? "pending" : "ended");
  var interactive = live && canAnswer && !it.submitting;
  var body = "";
  it.questions.forEach(function (q, qi) {
    var shown = state === "answered" ? (it.answers && it.answers[String(qi)]) : (state === "ended" ? answerOf(it, qi) : "");
    body += '<fieldset class="ask-q"' + (interactive ? "" : " disabled") + "><legend>" + (q.header ? '<span class="ask-header">' + escapeHtml(q.header) + "</span> " : "") + escapeHtml(q.question) + "</legend>";
    if (state !== "pending") body += '<p class="ask-answer">' + escapeHtml(shown || t("chat.askNoAnswer")) + "</p>";
    else {
      var role = q.multiSelect ? "checkbox" : "radio";
      q.options.forEach(function (o, oi) {
        var on = (it.sel[qi] || []).indexOf(oi) >= 0;
        body += '<button type="button" class="ask-opt' + (on ? " is-on" : "") + '" role="' + role + '" aria-checked="' + on + '" data-ask-opt="' + id + '" data-ask-q="' + qi + '" data-ask-o="' + oi + '"' + (interactive ? "" : " disabled") + ">" +
          "<span>" + escapeHtml(o.label) + "</span>" + (o.description ? "<small>" + escapeHtml(o.description) + "</small>" : "") + "</button>";
      });
      var oOn = !!it.otherOn[qi];
      body += '<button type="button" class="ask-opt ask-other' + (oOn ? " is-on" : "") + '" role="' + role + '" aria-checked="' + oOn + '" data-ask-other-toggle="' + id + '" data-ask-q="' + qi + '"' + (interactive ? "" : " disabled") + "><span>" + escapeHtml(t("chat.askOther")) + "</span></button>";
      if (oOn) body += '<input type="text" class="ask-other-input" data-ask-other="' + id + '" data-ask-q="' + qi + '" maxlength="' + MAX_OTHER + '" value="' + escapeHtml(it.other[qi] || "") + '" aria-label="' + escapeHtml(t("chat.askOtherLabel")) + '"' + (interactive ? "" : " disabled") + ">";
    }
    body += "</fieldset>";
  });
  var tail;
  if (state === "answered") tail = '<p class="ask-state ask-answered">' + escapeHtml(t("chat.askAnswered")) + "</p>";
  else if (state === "ended") tail = '<p class="ask-state ask-ended">' + escapeHtml(t("chat.askEnded")) + "</p>";
  else if (!canAnswer) tail = '<p class="ask-state ask-waiting">' + escapeHtml(t("chat.askWaiting")) + "</p>";
  else tail = '<button type="button" class="ask-submit" data-ask-submit="' + id + '"' + (interactive && buildResponse(it) ? "" : " disabled") + ">" + escapeHtml(t(it.submitting ? "chat.askSending" : "chat.askSubmit")) + "</button>";
  return '<article class="message ask-card is-' + state + '" role="group" aria-label="' + escapeHtml(t("chat.askAria")) + '" data-ask-card="' + id + '"><p class="message-label">' + escapeHtml(t("chat.askLabel")) + '</p><div class="bubble">' + body + tail + "</div></article>";
}

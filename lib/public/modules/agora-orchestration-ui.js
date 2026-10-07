// agora-orchestration-ui.js - DOM wiring for orchestration run cards in the
// right-side "에이전트 실행" panel.
//
// Each run is one card in #ag-orchestration-runs, created on its first
// orchestration_event and re-rendered in place on later ones. The
// membership for each of them.

import { store } from "./store.js";
import { applyEvent, renderRunCard } from "./agora-orchestration.js";
import { t, onLangChange } from "../aigora/i18n.js";

var runs = {};          // runId -> folded state (see applyEvent)
var notices = {};       // runId -> last action error
var busy = {};          // runId -> an action is in flight
// Expansion state for this session only: runs / steps the member opened or closed, and steps shown past the clamp.
var view = { latestRunId: "", runs: {}, steps: {}, more: {} };

function apiBase() {
  var slug = store.get("currentSlug");
  return slug ? "/p/" + encodeURIComponent(slug) + "/" : "/";
}

function requestJson(url, body) {
  if (typeof fetch !== "function") return Promise.reject(new Error("offline"));
  var init = { credentials: "same-origin", cache: "no-store" };
  if (body) {
    init.method = "POST";
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return fetch(url, init).then(function (res) {
    return res.json().catch(function () { return {}; }).then(function (json) {
      if (!res.ok) throw new Error(json && json.error ? String(json.error) : "HTTP " + res.status);
      return json;
    });
  });
}

// Viewers see the run but get no controls. Unknown rooms fail closed.
function canLaunchIn(roomId) {
  var rooms = store.get("rooms") || [];
  for (var i = 0; i < rooms.length; i++) {
    if (String(rooms[i].id) === String(roomId)) return rooms[i].role === "owner" || rooms[i].role === "member";
  }
  return false;
}

function cardFor(runId) {
  var root = document.getElementById("ag-orchestration-runs");
  if (!root) return null;
  var found = null;
  root.querySelectorAll("[data-orch-run]").forEach(function (el) {
    if (!found && el.getAttribute("data-orch-run") === runId) found = el;
  });
  return found;
}

function render(runId) {
  var state = runs[runId];
  if (!state || !state.run) return;
  var activeSessionId = store.get("activeSessionId");
  if (state.run.rootSessionId && String(activeSessionId) !== state.run.rootSessionId) return;
  var html = renderRunCard(state, {
    canLaunch: canLaunchIn(state.run.roomId), notice: notices[runId] || "", view: view,
  });
  var wrap = cardFor(runId);
  if (wrap) {
    var parent = wrap.parentNode;
    var tmp = document.createElement("div");
    tmp.innerHTML = html;
    var next = tmp.firstChild;
    if (!next) return;
    parent.replaceChild(next, wrap);
    wire(next);
    return;
  }
  var holder = document.createElement("div");
  holder.innerHTML = html;
  var card = holder.firstChild;
  if (!card) return;
  wire(card);
  var root = document.getElementById("ag-orchestration-runs");
  if (root) root.appendChild(card);
}

function action(runId, url, body) {
  if (busy[runId]) return Promise.resolve();
  busy[runId] = true;
  notices[runId] = "";
  return requestJson(url, body).then(function () {
    busy[runId] = false;
  }, function (err) {
    busy[runId] = false;
    notices[runId] = err && err.message ? err.message : t("agoraOrchestrationUi.requestFailed");
    render(runId);
  });
}

function onClick(ev) {
  var tr = ev.target.closest && ev.target.closest("[data-orch-toggle-run],[data-orch-toggle-step],[data-orch-more]");
  if (tr) {
    var rc = tr.closest("[data-orch-run]");
    var rid = rc ? rc.getAttribute("data-orch-run") : null;
    if (!rid || !runs[rid]) return;
    if (tr.hasAttribute("data-orch-toggle-run")) view.runs[rid] = tr.getAttribute("aria-expanded") !== "true";
    else if (tr.hasAttribute("data-orch-toggle-step")) view.steps[tr.getAttribute("data-orch-toggle-step")] = tr.getAttribute("aria-expanded") !== "true";
    else { var sid = tr.getAttribute("data-orch-more"); view.more[sid] = !view.more[sid]; }
    return render(rid);
  }
  var el = ev.target.closest && ev.target.closest("[data-orch-retry],[data-orch-cancel]");
  if (!el) return;
  var card = el.closest("[data-orch-run]");
  var runId = card ? card.getAttribute("data-orch-run") : null;
  if (!runId) return;
  var base = apiBase() + "api/orchestration/runs/" + encodeURIComponent(runId);
  if (el.hasAttribute("data-orch-retry")) return action(runId, base + "/retry", {});
  if (el.hasAttribute("data-orch-cancel")) return action(runId, base + "/cancel", {});
}

function wire(card) {
  if (card._orchWired) return;
  card._orchWired = true;
  card.addEventListener("click", onClick);
}

/** WS / history handler for `orchestration_event`. */
export function handleOrchestrationEvent(msg) {
  var state = applyEvent(runs, msg);
  if (!state) return;
  view.latestRunId = state.run.runId;
  // The previous latest run folds to its header now (unless the member chose otherwise).
  Object.keys(runs).forEach(function (id) { if (id !== view.latestRunId && runs[id].run && cardFor(id)) render(id); });
  render(state.run.runId);
}

/** Rebuild cards after agora-shell replaces the right panel markup. */
export function refreshOrchestrationPanel() {
  Object.keys(runs).forEach(render);
}

onLangChange(refreshOrchestrationPanel);

/** Open one run's step in the run log (the feed's verification line): expand it, then scroll it into view. */
export function focusRunStep(runId, stepId) {
  if (!runs[runId]) return;
  view.runs[runId] = true;
  if (stepId) view.steps[stepId] = true;
  render(runId);
  var card = cardFor(runId);
  var target = card && stepId ? card.querySelector('[data-orch-step="' + stepId.replace(/["\\]/g, "") + '"]') : card;
  if (target && typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "nearest" });
}

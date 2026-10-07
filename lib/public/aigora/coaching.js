// coaching.js - Thin DOM/WS controller for prompt coaching ("더 나은 지시"). All rules live in coaching-model.js
// and lib/prompt-coaching.js (server); this file only wires them: it keeps the author-only frames, shows them as
// an icon in the message action row (infoFor) with its detail under the message (chipFor) and in the 지시 코칭 tab (store key `coachingTab`), fills the composer on
// "제안 사용" (it never sends), owns the 내 지시 기록 dialog and the "지시 개선 공유" request.
//
//   initCoaching({ send(obj) -> bool, getMyId(), getActiveSessionId(), store, toast(text), input() -> textarea, onFilled(), rerender() })
//     -> { handle(msg) -> bool, chipFor(item) -> html, infoFor(item) -> info|null, setEnabled(on), isEnabled(), openHistory(mid, opener), decorateSend(payload) }
//
// Server frames handled here: prompt_coaching, prompt_coaching_history, coaching_shared, coaching_error,
// coaching_completed, coaching_complete_error ("AI로 완성하기": asked only by a button press, result for the author only).

import { entryFromMessage, entryFromHistory, renderHistoryHtml, renderChipBody, coachInfo, aiOf } from "./coaching-model.js";

import { t, onLangChange } from "./i18n.js";
import { copyText } from "./clipboard.js";
export function initCoaching(deps) {
  var enabled = true;
  var history = [];          // my own coached prompts (server copy), any order
  var cache = {};            // mid -> { coaching, text }: what a chip may show (mine, or shared by its author)
  var openChips = {};        // mid -> true while a chip is expanded
  var used = null;           // { mid, text }: the composer was filled from this entry's suggestion
  var target = null;         // entry to highlight in the history view
  var opener = null;
  var asked = 0;
  var aiState = {};          // mid -> { state: "loading" | "done" | "error", text, code, at }: "AI로 완성하기", mine only
  var AI_STALE_MS = 90000;   // a request the server never answered (lost socket) is shown as failed, not as loading forever

  var layer = document.createElement("div");
  layer.setAttribute("id", "ai-coaching-dialog");
  layer.setAttribute("class", "coach-layer hidden");
  layer.setAttribute("role", "dialog");
  layer.setAttribute("aria-modal", "true");
  layer.setAttribute("aria-labelledby", "ai-coaching-title");
  layer.innerHTML = '<div class="coach-scrim" data-coach-close></div><section class="coach-sheet"><header class="coach-head"><div><small>MY PROMPTS</small><h2 id="ai-coaching-title">' + t("coaching.myHistory") + '</h2></div>' +
    '<button type="button" class="coach-close" data-coach-close aria-label="' + t("coaching.close") + '">×</button></header>' +
    '<p class="coach-privacy">' + t("coaching.privacy") + '</p>' +
    '<div id="ai-coaching-body"></div></section>';
  document.body.appendChild(layer);
  var body = layer.querySelector("#ai-coaching-body");

  function byId(mid) { return history.filter(function (h) { return h.id === mid; })[0] || null; }
  function upsert(h) {
    var at = -1;
    for (var i = 0; i < history.length; i++) if (history[i].id === h.id) { at = i; break; }
    if (at >= 0) history[at] = Object.assign({}, history[at], h); else history.push(h);
  }
  function render() { body.innerHTML = renderHistoryHtml(history, { target: target }); }
  onLangChange(function () {
    layer.querySelector("#ai-coaching-title").textContent = t("coaching.myHistory");
    layer.querySelector(".coach-close").setAttribute("aria-label", t("coaching.close"));
    layer.querySelector(".coach-privacy").textContent = t("coaching.privacy");
    if (!layer.classList.contains("hidden")) render();
  });

  function remember(entry, text) {
    var mid = entry.coaching.mid;
    if (entry.coaching.mine && aiState[mid]) entry.coaching.ai = aiState[mid];
    cache[mid] = { coaching: entry.coaching, text: text || "" };
  }
  function setAi(mid, st) {
    aiState[mid] = st;
    if (cache[mid]) cache[mid].coaching.ai = st;
    var h = byId(mid);
    if (h) h.ai = st;
    publish();
    if (!layer.classList.contains("hidden")) render();
  }
  function expireStale() {
    var now = Date.now();
    Object.keys(aiState).forEach(function (mid) {
      if (aiState[mid].state === "loading" && now - aiState[mid].at > AI_STALE_MS) setAi(mid, { state: "error", code: "failed" });
    });
  }
  function askAi(mid) {
    var cur = aiState[mid];
    if (!mid || (cur && cur.state === "loading")) return;
    if (!deps.send({ type: "coaching_complete", id: mid })) { setAi(mid, { state: "error", code: "failed" }); return; }
    setAi(mid, { state: "loading", at: Date.now() });
  }
  // 입력창에 넣기: into the composer of the session the coaching belongs to, never sent. From another session it only hints.
  // What this page saw, else what the server kept for the author (restored history carries aiText, not aiState).
  function aiFor(mid) { return aiState[mid] || aiOf(byId(mid)); }
  function putAiInComposer(mid) {
    var st = aiFor(mid), input = deps.input(), h = byId(mid);
    if (!st || st.state !== "done" || !st.text || !input) return;
    var active = deps.getActiveSessionId ? deps.getActiveSessionId() : null;
    if (h && h.sessionId != null && active != null && String(h.sessionId) !== String(active)) { deps.toast(t("coaching.aiOtherSession")); return; }
    input.value = st.text;
    if (deps.onFilled) deps.onFilled();
    used = { mid: mid, text: (h && h.text) || (cache[mid] && cache[mid].text) || "" };
    if (!layer.classList.contains("hidden")) close();
    if (input.focus) input.focus();
    deps.toast(t("coaching.aiFilled"));
  }
  function copyAi(mid) {
    var st = aiFor(mid);
    if (!st || st.state !== "done" || !st.text) return;
    copyText(st.text).then(function (ok) { deps.toast(t(ok ? "coaching.aiCopied" : "coaching.aiCopyFailed")); });
  }

  // Everything the panel tab and the chips read; both are views of the same data, never of the timeline.
  function publish() {
    deps.store.set({ coachingTab: { enabled: enabled, history: history.slice() } });
    deps.rerender();
  }

  function requestHistory() {
    expireStale();
    var now = Date.now();
    if (!enabled || now - asked < 1500) return;
    if (deps.send({ type: "coaching_list" })) asked = now;
  }

  function open(mid, from) {
    opener = from || null;
    target = mid || null;
    render();
    layer.classList.remove("hidden");
    var close = layer.querySelector(".coach-close");
    if (close && close.focus) close.focus();
    var t = mid ? layer.querySelector('[data-coach-item="' + mid + '"]') : null;
    if (t && t.scrollIntoView) t.scrollIntoView({ block: "center" });
    requestHistory();
  }
  function close() {
    layer.classList.add("hidden");
    if (opener && opener.focus) opener.focus();
    opener = null;
  }

  // 제안 사용: the suggestion goes into the composer, nothing is sent. The member edits and presses send.
  function useSuggestion(mid) {
    var hit = cache[mid];
    var input = deps.input();
    if (!hit || !hit.coaching.mine || !hit.coaching.suggestion || !input) return;
    input.value = hit.coaching.suggestion;
    if (deps.onFilled) deps.onFilled();
    used = { mid: mid, text: hit.text };
    if (!layer.classList.contains("hidden")) close();
    if (input.focus) input.focus();
    deps.toast(t("coaching.filled"));
  }

  document.addEventListener("click", function (ev) {
    var t = ev.target && ev.target.closest ? ev.target : null;
    if (!t) return;
    var use = t.closest("[data-coach-use]");
    if (use) { useSuggestion(use.getAttribute("data-coach-use")); return; }
    var ask = t.closest("[data-coach-ai]");
    if (ask) { askAi(ask.getAttribute("data-coach-ai")); return; }
    var aiUse = t.closest("[data-coach-ai-use]");
    if (aiUse) { putAiInComposer(aiUse.getAttribute("data-coach-ai-use")); return; }
    var aiCopy = t.closest("[data-coach-ai-copy]");
    if (aiCopy) { copyAi(aiCopy.getAttribute("data-coach-ai-copy")); return; }
    var chip = t.closest("[data-coach-chip]");
    if (chip) {
      var cm = chip.getAttribute("data-coach-chip");
      openChips[cm] = !openChips[cm];
      deps.rerender();
      var again = document.querySelector('[data-coach-chip="' + cm + '"]');
      if (again && again.focus) again.focus();
      return;
    }
    var hist = t.closest("[data-coach-history]");
    if (hist) { open(hist.getAttribute("data-coach-history"), hist); return; }
    var share = t.closest("[data-coach-share]");
    if (share) { if (!deps.send({ type: "coaching_share", id: share.getAttribute("data-coach-share") })) deps.toast(t("coaching.shareOffline")); return; }
    if (t.closest("[data-coach-close]")) close();
  });
  layer.addEventListener("keydown", function (ev) { if (ev.key === "Escape") { ev.preventDefault(); close(); } });

  return {
    isEnabled: function () { return enabled; },
    setEnabled: function (on) {
      enabled = !!on;
      if (!enabled) close(); else requestHistory();
      publish();
    },
    openHistory: open,
    // The author-only frames. Returns true when the frame was consumed here.
    handle: function (msg) {
      if (!msg || typeof msg.type !== "string") return false;
      if (msg.type === "prompt_coaching") {
        if (!enabled || !msg.mid) return true;
        var mine = msg.authorId != null && String(msg.authorId) === String(deps.getMyId());
        if (mine && !msg.shared) upsert({ id: msg.mid, sessionId: msg.sessionId, roomId: msg.roomId || null, ts: msg.ts, text: msg.text || "", result: msg.result, shared: false, revisionOf: msg.revisionOf });
        if (mine && msg.shared && byId(msg.mid)) upsert({ id: msg.mid, shared: true });
        remember(entryFromMessage(msg, deps.getMyId()), msg.text);
        publish();
        if (!layer.classList.contains("hidden")) render();
        return true;
      }
      if (msg.type === "prompt_coaching_history") {
        if (!enabled) return true;
        (Array.isArray(msg.entries) ? msg.entries : []).forEach(function (h) {
          if (!h || !h.id) return;
          upsert(h);
          remember(entryFromHistory(h), h.text);
        });
        publish();
        if (!layer.classList.contains("hidden")) render();
        return true;
      }
      if (msg.type === "coaching_shared") {
        var h = byId(msg.mid);
        if (h) { h.shared = true; remember(entryFromHistory(h), h.text); publish(); }
        render();
        deps.toast(t("coaching.shared"));
        return true;
      }
      if (msg.type === "coaching_completed") {
        if (typeof msg.mid === "string" && typeof msg.text === "string" && msg.text) setAi(msg.mid, { state: "done", text: msg.text });
        return true;
      }
      if (msg.type === "coaching_complete_error") {
        if (typeof msg.mid === "string" && aiState[msg.mid] && aiState[msg.mid].state === "loading") setAi(msg.mid, { state: "error", code: msg.code });
        else if (typeof msg.mid !== "string" || !msg.mid) deps.toast(t("coaching.aiErr.failed"));
        return true;
      }
      if (msg.type === "coaching_error") {
        deps.toast(msg.code === "forbidden" ? t("coaching.shareForbidden") : t("coaching.shareFailed"));
        return true;
      }
      // Not coaching frames, but moments when the open session's own entries must be (re)loaded.
      if (msg.type === "session_switched" || msg.type === "history_done") requestHistory();
      return false;
    },
    // The chip under a user message: mine always, someone else's only once its author shared it. The server never
    // sends another member's unshared result, so a missing entry simply means no chip.
    chipFor: function (item) {
      if (!enabled || !item || item.role !== "user" || !item.mid || !cache[item.mid]) return "";
      return renderChipBody(cache[item.mid].coaching, !!openChips[item.mid]);
    },
    // What the message's action row needs for its coaching button (same visibility rule as chipFor), or null.
    infoFor: function (item) {
      if (!enabled || !item || item.role !== "user" || !item.mid || !cache[item.mid]) return null;
      return coachInfo(cache[item.mid].coaching, !!openChips[item.mid]);
    },
    // A message built from a suggestion remembers which entry it revised; anything else sends as before.
    decorateSend: function (payload) {
      if (used && typeof payload.text === "string" && used.text && payload.text.indexOf(used.text.trim()) === 0) payload.coachedFrom = used.mid;
      used = null;
      return payload;
    },
  };
}

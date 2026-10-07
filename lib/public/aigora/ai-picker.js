// 로컬), the "@" suggestion list, and the phone's bottom sheet (보내기 방식 + AI 선택). The choice is for the NEXT
// instruction only; the client sends it as the `agent` field of the message frame and resets it after a send.
// o: { members(), selfId(), els: { root, chip, list, at, sheet, input, modeChip }, basePath, available(), getMode(), setMode(m), localReady(), onChange?, fetch? }
// Labels are escaped: an endpoint label comes from the owner's config.

import { t } from "./i18n.js";
import { escapeHtml } from "../modules/escape-html.js";
import { setEndpoints, availableAgents, chipState, typedAgent, atQuery, suggestions, insertMention } from "./ai-picker-model.js";

import { memberOptions, draftRoutingText, createMentionDraft } from "./member-mentions-model.js";

export function initAiPicker(o) {
  var els = o.els;
  var mentionDraft = createMentionDraft();
  var usage = null;
  var pick = null;
  var scope = null;
  var listOpen = false;
  var sheetOpen = false;
  var at = { open: false, items: [], index: 0, q: null, dismissed: "" };
  var doFetch = o.fetch || (typeof fetch === "function" ? fetch : null);

  function isPrivate() { return !!(o.isPrivate && o.isPrivate()); }
  function options() { setEndpoints(o.status ? o.status() : null); return availableAgents(usage, o.localReady(), { private: isPrivate() }); }
  function aiMode() { return o.available() && o.getMode() === "ai"; }
  function members() { return o.members ? o.members() : []; }
  function state() { return chipState(pick, draftRoutingText(mentionDraft.canonical(els.input.value), members(), function (name) { return !!typedAgent("@" + name); }), isPrivate()); }
  function optHtml(a, selected) {
    return '<button type="button" role="option" class="ai-pick-opt" data-pick="' + escapeHtml(a.id) + '" aria-selected="' + (selected ? "true" : "false") + '">' +
      "<span>" + escapeHtml(a.label) + "</span><small>" + escapeHtml(a.sub) + "</small></button>";
  }
  function autoOpt(selected) {
    return '<button type="button" role="option" class="ai-pick-opt" data-pick="" aria-selected="' + (selected ? "true" : "false") + '"><span>' + t("aiPicker.auto") + '</span><small>' + t("aiPicker.autoHint") + '</small></button>';
  }
  function allOpts(selectedId) {
    return autoOpt(!selectedId) + options().map(function (a) { return optHtml(a, selectedId === a.id); }).join("");
  }

  function closeList(focusChip) {
    if (!listOpen) return;
    listOpen = false;
    els.list.classList.add("hidden");
    els.chip.setAttribute("aria-expanded", "false");
    if (focusChip) els.chip.focus();
  }
  function openList() {
    if (state().typed) return;
    listOpen = true;
    els.list.innerHTML = allOpts(pick);
    els.list.classList.remove("hidden");
    els.chip.setAttribute("aria-expanded", "true");
    var cur = els.list.querySelector('[aria-selected="true"]');
    if (cur) cur.focus();
  }

  function renderSheet() {
    var opts = options();
    var mode = o.getMode();
    els.sheet.querySelectorAll("[data-sheet-mode]").forEach(function (b) { b.setAttribute("aria-pressed", b.getAttribute("data-sheet-mode") === mode ? "true" : "false"); });
    // A private session has only the AI choice (no "조원에게 메시지" mode).
    els.sheet.querySelectorAll("#ai-pick-sheet-mode-h, .ai-pick-seg").forEach(function (n) { n.classList.toggle("hidden", isPrivate()); });
    var group = els.sheet.querySelector("[data-sheet-ai]");
    group.classList.toggle("hidden", mode !== "ai" || !opts.length);
    var st = state();
    group.querySelector("[data-sheet-ai-list]").innerHTML = allOpts(st.id);
    group.querySelector("[data-sheet-typed]").classList.toggle("hidden", !st.typed);
  }
  function openSheet() {
    sheetOpen = true;
    renderSheet();
    els.sheet.classList.remove("hidden");
    var cur = els.sheet.querySelector('[aria-pressed="true"]');
    if (cur) cur.focus();
  }
  function closeSheet() {
    if (!sheetOpen) return;
    sheetOpen = false;
    els.sheet.classList.add("hidden");
    if (els.modeChip) els.modeChip.focus();
  }

  function setPick(id) {
    pick = id && options().some(function (a) { return a.id === id; }) ? id : null;
    render();
    if (o.onChange) o.onChange();
  }

  // The chip, the "@" list and the phone sheet follow the composer's state (mode, availability, draft, room).
  function render(roomScope) {
    if (typeof roomScope === "string" && roomScope !== scope) { scope = roomScope; pick = null; }
    var opts = options();
    if (pick && !opts.some(function (a) { return a.id === pick; })) pick = null;
    var show = aiMode() && opts.length > 0;
    els.root.classList.toggle("hidden", !show);
    var st = state();
    els.chip.querySelector("[data-pick-value]").textContent = st.text;
    els.chip.setAttribute("data-agent", st.id || "");
    els.chip.setAttribute("aria-disabled", st.typed ? "true" : "false");
    els.chip.setAttribute("aria-label", st.typed ? t("aiPicker.chipLabelTyped", { name: st.text }) : t("aiPicker.chipLabel", { name: st.text }));
    els.chip.setAttribute("title", st.typed ? t("aiPicker.chipTitleTyped") : t("aiPicker.chipTitle"));
    if (!show || st.typed) closeList(false);
    if (els.modeChip) els.modeChip.setAttribute("data-pick", show && st.id ? st.id : "");
    if (sheetOpen) { if (o.available()) renderSheet(); else closeSheet(); }
    if (els.mentions) {
      var tokens = mentionDraft.canonical(els.input.value).match(/@\[[^\]\r\n]*\]\(user:[A-Za-z0-9_.:-]{1,120}\)/g) || [];
      var entries = memberOptions(members(), null);
      var chosen = entries.filter(function (p) { return tokens.some(function (token) { return token.endsWith("(user:" + p.id.slice(5) + ")"); }); });
      els.mentions.innerHTML = chosen.map(function (p) { return '<span class="ai-chip ai-member-mention">@' + escapeHtml(p.label) + '</span>'; }).join("");
      els.mentions.classList.toggle("hidden", !chosen.length);
    }
    syncAt();
  }

  // One grouped list in both composer modes; private channels receive only their authorized roster.
  function closeAt() {
    at.open = false;
    els.at.classList.add("hidden");
    els.input.setAttribute("aria-expanded", "false");
    els.input.removeAttribute("aria-activedescendant");
  }
  function syncAt() {
    var q = o.available() ? atQuery(els.input.value, els.input.selectionStart) : null;
    var items = q ? suggestions(q.query, (isPrivate() ? [] : options()).concat(memberOptions(members(), o.selfId ? o.selfId() : null))) : [];
    var key = q ? q.start + ":" + q.query : "";
    if (!q) at.dismissed = "";
    if (!q || !items.length || key === at.dismissed) { closeAt(); return; }
    var same = at.open && at.q && at.q.start === q.start && at.q.query === q.query;
    at.q = q; at.items = items; if (!same) at.index = 0;
    at.index = Math.min(at.index, items.length - 1);
    at.open = true;
    function groupHtml(member) {
      var group = items.filter(function (a) { return !!a.member === member; });
      if (!group.length) return "";
      var heading = t(member ? "aiPicker.membersGroup" : "aiPicker.aiGroup");
      return '<li role="presentation"><ul role="group" aria-label="' + escapeHtml(heading) + '"><li role="presentation" class="ai-at-heading">' + escapeHtml(heading) + '</li>' + group.map(function (a) {
        var i = items.indexOf(a);
        return '<li role="option" class="ai-pick-opt" id="ai-at-opt-' + escapeHtml(a.id) + '" data-at="' + escapeHtml(a.id) + '" aria-selected="' + (i === at.index ? "true" : "false") + '"><span>' + escapeHtml(a.member ? a.label : a.mention) + "</span><small>" + escapeHtml(a.member ? a.sub : a.label + " · " + a.sub) + "</small></li>";
      }).join("") + '</ul></li>';
    }
    els.at.innerHTML = groupHtml(false) + groupHtml(true);
    els.at.classList.remove("hidden");
    els.input.setAttribute("aria-expanded", "true");
    els.input.setAttribute("aria-activedescendant", "ai-at-opt-" + items[at.index].id);
    var active = els.at.querySelector('[aria-selected="true"]');
    if (active && active.scrollIntoView) active.scrollIntoView({ block: "nearest" });
  }
  function chooseAt(id) {
    var a = at.items.find(function (item) { return item.id === id; });
    if (!a || !at.q) return;
    // A roster may have changed between pointerdown and click.
    if (a.member && !memberOptions(members(), o.selfId ? o.selfId() : null).some(function (m) { return m.id === id; })) { closeAt(); return; }
    mentionDraft.sync(els.input.value);
    var r = a.member ? mentionDraft.insert(at.q, a) : insertMention(els.input.value, at.q, a);
    els.input.value = r.text;
    if (els.input.setSelectionRange) els.input.setSelectionRange(r.caret, r.caret);
    closeAt();
    if (o.onChange) o.onChange();
    render();
    if (els.input.focus) els.input.focus();
  }

  // Called first from the composer's keydown; true = the key was used here (so it must not also send).
  function handleKey(ev) {
    if (ev.isComposing || ev.keyCode === 229 || !at.open) return false;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      at.index = (at.index + (ev.key === "ArrowDown" ? 1 : at.items.length - 1)) % at.items.length;
      syncAt();
      return true;
    }
    if (ev.key === "Enter" || ev.key === "Tab") { ev.preventDefault(); chooseAt(at.items[at.index].id); return true; }
    if (ev.key === "Escape") { ev.preventDefault(); at.dismissed = at.q.start + ":" + at.q.query; closeAt(); return true; }
    return false;
  }

  // The chip's list: arrow keys move, Enter/Space (native button) choose, Escape and Tab close.
  function onListKey(ev) {
    var opts = els.list.querySelectorAll("[data-pick]");
    var i = opts.indexOf(ev.target);
    if (ev.key === "Escape") { ev.preventDefault(); closeList(true); }
    else if (ev.key === "Tab") closeList(false);
    else if (ev.key === "ArrowDown" || ev.key === "ArrowUp" || ev.key === "Home" || ev.key === "End") {
      ev.preventDefault();
      var n = ev.key === "Home" ? 0 : ev.key === "End" ? opts.length - 1 : (i + (ev.key === "ArrowDown" ? 1 : opts.length - 1)) % opts.length;
      opts[n].focus();
    }
  }

  els.chip.addEventListener("click", function () {
    if (els.chip.getAttribute("aria-disabled") === "true") return;
    if (listOpen) closeList(false); else openList();
  });
  els.chip.addEventListener("keydown", function (ev) {
    if ((ev.key === "ArrowDown" || ev.key === "ArrowUp") && !listOpen && els.chip.getAttribute("aria-disabled") !== "true") { ev.preventDefault(); openList(); }
  });
  els.list.addEventListener("keydown", onListKey);
  els.list.addEventListener("click", function (ev) {
    var b = ev.target.closest && ev.target.closest("[data-pick]");
    if (!b) return;
    closeList(true);
    setPick(b.getAttribute("data-pick") || null);
  });
  if (typeof document !== "undefined") document.addEventListener("click", function (ev) {
    if (listOpen && !(ev.target.closest && ev.target.closest("#ai-pick, [data-pickfail]"))) closeList(false);
  });
  els.at.addEventListener("mousedown", function (ev) { ev.preventDefault(); });
  els.at.addEventListener("click", function (ev) {
    var b = ev.target.closest && ev.target.closest("[data-at]");
    if (b) chooseAt(b.getAttribute("data-at"));
  });
  els.input.addEventListener("input", function () { render(); });
  els.input.addEventListener("click", syncAt);
  els.sheet.addEventListener("click", function (ev) {
    var t = ev.target;
    if (!t.closest) return;
    if (t.closest("[data-pick-close]")) { closeSheet(); return; }
    var m = t.closest("[data-sheet-mode]");
    if (m) { o.setMode(m.getAttribute("data-sheet-mode")); return; }
    var b = t.closest("[data-pick]");
    if (b) setPick(b.getAttribute("data-pick") || null);
  });
  els.sheet.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape") { ev.preventDefault(); closeSheet(); return; }
    if (ev.key !== "Tab") return;
    var f = els.sheet.querySelectorAll("button").filter(function (b) { return !(b.closest && b.closest(".hidden")); });
    if (!f.length) return;
    if (ev.shiftKey && ev.target === f[0]) { ev.preventDefault(); f[f.length - 1].focus(); }
    else if (!ev.shiftKey && ev.target === f[f.length - 1]) { ev.preventDefault(); f[0].focus(); }
  });

  function refresh() {
    if (!doFetch) return Promise.resolve();
    return doFetch(o.basePath + "api/ai-usage", { credentials: "same-origin", cache: "no-store" }).then(function (res) {
      return res.ok ? res.json() : null;
    }).then(function (json) { usage = json && Array.isArray(json.providers) ? json : null; render(); }, function () { usage = null; render(); });
  }
  els.input.setAttribute("role", "combobox");
  els.input.setAttribute("aria-autocomplete", "list");
  els.input.setAttribute("aria-controls", "ai-at-list");
  els.input.setAttribute("aria-expanded", "false");
  refresh();

  return {
    canonicalText: function () { return mentionDraft.canonical(els.input.value); },
    render: render, refresh: refresh, openSheet: openSheet, closeSheet: closeSheet, handleKey: handleKey,
    isSheetOpen: function () { return sheetOpen; },
    // The agent to send with the next instruction: only a picked one, and never when the draft names its own.
    outgoing: function () { return aiMode() && !state().typed ? pick : null; },
    set: function (id) { setPick(id); },
    openList: function () { if (!els.root.classList.contains("hidden")) openList(); },
    reset: function () { pick = null; render(); },
  };
}

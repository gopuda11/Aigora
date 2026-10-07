// guide.js - The first-run 사용설명서: a centered step-by-step dialog in the style of the
// settings modal. Focus trap, Escape/X/scrim close, focus returned to the opener.
// Closing it (any way) or "다시 보지 않기" reports "seen" through deps.markSeen.
//
//   initGuide({ markSeen(), isAdmin() }) -> { open(opener, mode), close, isOpen, maybeShow({ seen, version, hasRoom }) }
// mode "news" shows only the cards added since the version the viewer last saw.

import { guideSteps, guideMode } from "./guide-model.js";
import { t, onLangChange } from "./i18n.js";

var FOCUSABLE = "button";

export function initGuide(deps) {
  var $ = function (id) { return document.getElementById(id); };
  var els = { root: $("ai-guide"), title: $("ai-guide-title"), step: $("ai-guide-step"), body: $("ai-guide-body"), dots: $("ai-guide-dots"), kicker: $("ai-guide-kicker"),
    prev: $("ai-guide-prev"), next: $("ai-guide-next"), never: $("ai-guide-never"), close: $("ai-guide-close") };
  var state = { open: false, index: 0, opener: null, autoShown: false, mode: "full", from: 0 };
  function steps() { return guideSteps({ admin: !!(deps.isAdmin && deps.isAdmin()), mode: state.mode, fromVersion: state.from }); }

  function render() {
    var list = steps(), s = list[state.index], last = state.index === list.length - 1;
    els.kicker.textContent = t(state.mode === "news" ? "guide.newsTitle" : "guide.title");
    els.step.textContent = (state.index + 1) + " / " + list.length;
    els.title.textContent = s.title;
    els.body.textContent = "";
    s.body.forEach(function (line) {
      var p = document.createElement("p");
      p.textContent = line;
      els.body.appendChild(p);
    });
    els.dots.textContent = "";
    list.forEach(function (_, i) {
      var dot = document.createElement("span");
      dot.className = "ai-guide-dot" + (i === state.index ? " is-on" : "");
      els.dots.appendChild(dot);
    });
    var hadFocus = document.activeElement === els.prev;
    els.prev.disabled = state.index === 0;
    if (hadFocus && els.prev.disabled) els.next.focus();   // the focused button just went disabled: keep focus inside the dialog
    els.next.textContent = last ? t("guide.start") : t("guide.next");
  }

  function open(opener, mode, from) {
    if (opener) state.opener = opener;
    state.mode = mode === "news" ? "news" : "full";
    state.from = from || 0;
    state.index = 0;
    state.open = true;
    render();
    els.root.classList.remove("hidden");
    els.next.focus();
  }

  function close() {
    if (!state.open) return;
    state.open = false;
    els.root.classList.add("hidden");
    deps.markSeen();
    var opener = state.opener;
    state.opener = null;
    if (opener && opener.focus) opener.focus();
  }

  function trapTab(ev) {
    var items = Array.prototype.slice.call(els.root.querySelectorAll(FOCUSABLE)).filter(function (el) { return !el.disabled; });
    if (!items.length) { ev.preventDefault(); return; }
    var active = document.activeElement, at = items.indexOf(active);
    var first = items[0], last = items[items.length - 1];
    if (at === -1 || (ev.shiftKey && active === first) || (!ev.shiftKey && active === last)) {
      ev.preventDefault();
      (ev.shiftKey ? last : first).focus();
    }
  }

  onLangChange(function () { if (state.open) render(); });
  els.next.addEventListener("click", function () {
    if (state.index >= steps().length - 1) { close(); return; }
    state.index++;
    render();
  });
  els.prev.addEventListener("click", function () { if (state.index > 0) { state.index--; render(); } });
  els.never.addEventListener("click", close);
  els.close.addEventListener("click", close);
  els.root.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape") { ev.preventDefault(); close(); }
    else if (ev.key === "Tab") trapTab(ev);
  });
  els.root.addEventListener("click", function (ev) {
    if (ev.target && ev.target.closest && ev.target.closest("[data-guide-close]")) close();
  });

  return {
    open: open,
    close: close,
    isOpen: function () { return state.open; },
    // Once per page load, with a room open: the full guide for a new user, "what's new" for one who saw an older version.
    maybeShow: function (info) {
      var mode = info ? guideMode(info.seen, info.version) : null;
      if (state.autoShown || state.open || !mode || !info.hasRoom) return;
      state.autoShown = true;
      open(null, mode, info.version);
    },
  };
}

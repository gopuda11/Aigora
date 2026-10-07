// settings.js - The Claude-style settings modal of the standalone Aigora page:
// centered dialog, section list on the left (a segmented control on phones),
// one pane per section, focus trap, Escape/X/scrim to close, focus returned to
// the opener, and the open section mirrored in the URL hash (#settings/<id>) so
// it can be deep-linked and survives a reload.
//
// The modal owns the shell, the 일반 pane (테마, 세션 표시 방식, 동작 줄이기) and the 계정 pane. A feature module (room-admin.js)
// owns the panes of its sections and plugs in through the hooks below:
//   setAvailable(id, bool)  show/hide a section in the nav (일반 and 계정 are always available)
//   onShow(id, fn)          fn() each time that section becomes the visible one
//   onOpen(fn) / onClose(fn)
//
//   initSettings({ logout, logoutAll(opener), onUserChange(user), onLayoutChange(layout), onReduceMotionChange(on), onLanguageChange(lang) }) -> { open, close, isOpen, setUser, setAvailable, onShow, onOpen, onClose, restoreFromHash }

import { SECTIONS, THEME_CHOICES, LANG_CHOICES, hashFor, parseHash, roleLabel, displayNameOf, nicknameError, pinChangeError, credentialsError } from "./settings-model.js";
import { readTheme, saveTheme, applyTheme } from "./theme.js";
import { readLayout, readReduceMotion, readCoaching } from "./display-prefs.js";
import { t, getLang, onLangChange } from "./i18n.js";
import { LAYOUT_CHOICES, layoutPreviewHtml } from "./session-layouts-model.js";

var FOCUSABLE = "button, input, select, textarea";

export function initSettings(deps) {
  var $ = function (id) { return document.getElementById(id); };
  var els = {
    root: $("ai-settings"), nav: $("ai-settings-nav"), close: $("ai-admin-close"), logout: $("ai-settings-logout"), logoutAll: $("ai-settings-logout-all"),
    theme: $("ai-theme-choices"), lang: $("ai-lang-choices"), layout: $("ai-layout-choices"), motion: $("ai-reduce-motion"), coaching: $("ai-prompt-coaching"), name: $("ai-settings-name"), username: $("ai-settings-username"), role: $("ai-settings-role"),
  };
  var panes = els.root.querySelectorAll("[data-settings-pane]");
  var state = { open: false, section: SECTIONS[0].id, opener: null, available: { general: true, account: true }, theme: readTheme(), lang: getLang(), layout: readLayout(), reduceMotion: readReduceMotion(), coaching: readCoaching() };
  var showHooks = {}, openHooks = [], closeHooks = [];

  function writeHash(hash) {
    if (typeof history !== "undefined" && history && typeof history.replaceState === "function") {
      history.replaceState(null, "", location.pathname + (location.search || "") + hash);
    } else {
      location.hash = hash;
    }
  }

  // The first section the viewer can see ("일반" always is): where an open without a section lands.
  function firstAvailable() {
    for (var i = 0; i < SECTIONS.length; i++) if (state.available[SECTIONS[i].id]) return SECTIONS[i].id;
    return SECTIONS[0].id;
  }

  function renderNav() {
    els.nav.textContent = "";
    SECTIONS.forEach(function (s) {
      if (!state.available[s.id]) return;
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ai-settings-nav-item";
      btn.setAttribute("data-settings-section", s.id);
      btn.textContent = s.label;
      els.nav.appendChild(btn);
    });
    markCurrent();
  }

  // Only the marker moves on a section switch, so a focused nav item keeps focus.
  function markCurrent() {
    els.nav.querySelectorAll("button").forEach(function (btn) {
      if (btn.getAttribute("data-settings-section") === state.section) {
        btn.setAttribute("aria-current", "page");
        if (btn.scrollIntoView) btn.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
      else btn.removeAttribute("aria-current");
    });
  }

  // 테마: a segmented control that is a radio group (roving tabindex, arrow keys move and select).
  function renderTheme() {
    els.theme.textContent = "";
    THEME_CHOICES.forEach(function (c) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ai-seg-item";
      btn.setAttribute("role", "radio");
      btn.setAttribute("data-theme-choice", c.id);
      btn.textContent = c.label;
      els.theme.appendChild(btn);
    });
    markTheme();
  }

  function markTheme() {
    els.root.querySelectorAll("[data-theme-choice]").forEach(function (btn) {
      var on = btn.getAttribute("data-theme-choice") === state.theme;
      btn.setAttribute("aria-checked", on ? "true" : "false");
      btn.setAttribute("tabindex", on ? "0" : "-1");
    });
  }

  // 언어: the same radio-group segmented control; the caller applies and persists the choice.
  // A language switch redraws the radios, so focus goes to the live node, not the replaced one.
  function focusLang(id) {
    var live = els.lang.querySelector('[data-lang-choice="' + id + '"]');
    if (live && live.focus) live.focus();
  }

  function renderLang() {
    var hadFocus = els.lang.contains && els.lang.contains(document.activeElement);
    els.lang.textContent = "";
    LANG_CHOICES.forEach(function (c) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ai-seg-item";
      btn.setAttribute("role", "radio");
      btn.setAttribute("data-lang-choice", c.id);
      btn.textContent = c.label;
      els.lang.appendChild(btn);
    });
    markLang();
    if (hadFocus) focusLang(state.lang);
  }

  function markLang() {
    els.root.querySelectorAll("[data-lang-choice]").forEach(function (btn) {
      var on = btn.getAttribute("data-lang-choice") === state.lang;
      btn.setAttribute("aria-checked", on ? "true" : "false");
      btn.setAttribute("tabindex", on ? "0" : "-1");
    });
  }

  function chooseLang(id) {
    if (id === state.lang) return;
    state.lang = id;
    markLang();
    if (deps.onLanguageChange) deps.onLanguageChange(id);
  }

  function chooseTheme(id) {
    state.theme = id;
    applyTheme(id);
    saveTheme(id);
    markTheme();
  }

  // 세션 표시 방식: three cards (each with a small looping motion preview) that form a radio
  // group like the 테마 control. Choosing one applies at once; the caller persists it.
  function renderLayouts() {
    els.layout.textContent = "";
    LAYOUT_CHOICES.forEach(function (c) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ai-lay-card";
      btn.setAttribute("role", "radio");
      btn.setAttribute("data-layout-choice", c.id);
      btn.innerHTML = layoutPreviewHtml(c.id) + '<span class="ai-lay-name"><strong>' + c.id + " " + c.label + (c.isDefault ? " " + t("settings.layoutDefault") : "") + "</strong><small>" + c.hint + "</small></span>";
      els.layout.appendChild(btn);
    });
    markLayout();
  }

  function markLayout() {
    els.root.querySelectorAll("[data-layout-choice]").forEach(function (btn) {
      var on = btn.getAttribute("data-layout-choice") === state.layout;
      btn.setAttribute("aria-checked", on ? "true" : "false");
      btn.setAttribute("tabindex", on ? "0" : "-1");
    });
  }

  function chooseLayout(id) {
    if (id === state.layout) return;
    state.layout = id;
    markLayout();
    if (deps.onLayoutChange) deps.onLayoutChange(id);
  }

  function markMotion() { els.motion.setAttribute("aria-checked", state.reduceMotion ? "true" : "false"); }

  function toggleMotion() {
    state.reduceMotion = !state.reduceMotion;
    markMotion();
    if (deps.onReduceMotionChange) deps.onReduceMotionChange(state.reduceMotion);
  }

  function markCoaching() { if (els.coaching) els.coaching.setAttribute("aria-checked", state.coaching ? "true" : "false"); }

  function toggleCoaching() {
    state.coaching = !state.coaching;
    markCoaching();
    if (deps.onCoachingChange) deps.onCoachingChange(state.coaching);
  }

  var ARROWS = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
  els.layout.addEventListener("keydown", function (ev) {
    var step = ARROWS[ev.key];
    if (!step) return;
    var radios = Array.prototype.slice.call(els.layout.querySelectorAll("button"));
    var at = radios.indexOf(document.activeElement);
    if (at === -1) return;
    ev.preventDefault();
    var next = radios[(at + step + radios.length) % radios.length];
    chooseLayout(next.getAttribute("data-layout-choice"));
    next.focus();
  });
  els.lang.addEventListener("keydown", function (ev) {
    var step = ARROWS[ev.key];
    if (!step) return;
    var radios = Array.prototype.slice.call(els.lang.querySelectorAll("button"));
    var at = radios.indexOf(document.activeElement);
    if (at === -1) return;
    ev.preventDefault();
    var next = radios[(at + step + radios.length) % radios.length];
    var id = next.getAttribute("data-lang-choice");
    chooseLang(id);
    focusLang(id);
  });
  els.theme.addEventListener("keydown", function (ev) {
    var step = ARROWS[ev.key];
    if (!step) return;
    var radios = Array.prototype.slice.call(els.theme.querySelectorAll("button"));
    var at = radios.indexOf(document.activeElement);
    if (at === -1) return;
    ev.preventDefault();
    var next = radios[(at + step + radios.length) % radios.length];
    chooseTheme(next.getAttribute("data-theme-choice"));
    next.focus();
  });

  function show(id) {
    if (id === "archived") id = "rooms"; // legacy callers
    if (!state.available[id]) id = firstAvailable();
    var changed = state.section !== id;
    state.section = id;
    panes.forEach(function (pane) { pane.hidden = pane.getAttribute("data-settings-pane") !== id; });
    if (changed) els.root.querySelector(".ai-settings-scroll").scrollTop = 0;
    markCurrent();
    writeHash(hashFor(id));
    (showHooks[id] || []).forEach(function (fn) { fn(); });
  }

  // open("rooms", { opener, focus }): opener gets focus back on close; focus is the
  // control to focus first (default: the close button).
  function open(id, options) {
    var opts = options || {};
    if (opts.opener) state.opener = opts.opener;
    if (!state.open) {
      state.open = true;
      els.root.classList.remove("hidden");
      openHooks.forEach(function (fn) { fn(); });
    }
    show(id || firstAvailable());
    (opts.focus || els.close).focus();
  }

  function close() {
    if (!state.open) return;
    state.open = false;
    els.root.classList.add("hidden");
    closeHooks.forEach(function (fn) { fn(); });
    writeHash("");
    var opener = state.opener;
    state.opener = null;
    if (opener && opener.focus) opener.focus();
  }

  function trapTab(ev) {
    // One compound selector keeps document order, so "last" is the DOM-last control.
    var items = Array.prototype.slice.call(els.root.querySelectorAll(FOCUSABLE)).filter(function (el) { return el.offsetParent !== null && !el.disabled && el.getAttribute("tabindex") !== "-1"; });
    if (!items.length) { ev.preventDefault(); return; }
    var active = document.activeElement, at = items.indexOf(active);
    var first = items[0], last = items[items.length - 1];
    if (at === -1 || (ev.shiftKey && active === first) || (!ev.shiftKey && active === last)) {
      ev.preventDefault();
      (ev.shiftKey ? last : first).focus();
    }
  }

  els.root.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape") { ev.preventDefault(); close(); }
    else if (ev.key === "Tab") trapTab(ev);
  });
  els.root.addEventListener("click", function (ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    if (t.closest("[data-settings-close]")) { close(); return; }
    var item = t.closest("[data-settings-section]");
    if (item) { show(item.getAttribute("data-settings-section")); return; }
    var choice = t.closest("[data-theme-choice]");
    if (choice) chooseTheme(choice.getAttribute("data-theme-choice"));
    var langChoice = t.closest("[data-lang-choice]");
    if (langChoice) chooseLang(langChoice.getAttribute("data-lang-choice"));
    var layoutChoice = t.closest("[data-layout-choice]");
    if (layoutChoice) chooseLayout(layoutChoice.getAttribute("data-layout-choice"));
    if (t.closest("#ai-reduce-motion")) toggleMotion();
    if (t.closest("#ai-prompt-coaching")) toggleCoaching();
  });
  els.close.addEventListener("click", close);
  els.logout.addEventListener("click", function () { deps.logout(); });
  if (els.logoutAll) els.logoutAll.addEventListener("click", function () { deps.logoutAll(els.logoutAll); });

  function scrollLegacyArchive(legacy) {
    if (!legacy || !state.available.rooms) return;
    var archive = $("ai-admin-archived-section");
    if (archive && !archive.classList.contains("hidden") && archive.scrollIntoView) archive.scrollIntoView({ block: "start" });
  }

  function fromHash() {
    var legacy = location.hash === "#settings/archived";
    var id = parseHash(location.hash);
    if (id) { open(id, { opener: state.opener }); scrollLegacyArchive(legacy); }
    else if (state.open) close();
  }
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("hashchange", function () {
      if (state.open && location.hash !== "#settings/archived" && parseHash(location.hash) === state.section) return;
      fromHash();
    });
  }

  // 계정: nickname, PIN change (has a PIN) or 아이디 + first PIN (no PIN yet).
  var acct = {
    nickForm: $("ai-set-nick-form"), nick: $("ai-set-nick"), nickMsg: $("ai-set-nick-msg"),
    pinTitle: $("ai-set-pin-title"), pinForm: $("ai-set-pin-form"), pinCur: $("ai-set-pin-cur"), pinNew: $("ai-set-pin-new"), pinNew2: $("ai-set-pin-new2"), pinMsg: $("ai-set-pin-msg"),
    credForm: $("ai-set-cred-form"), credId: $("ai-set-cred-id"), credPin: $("ai-set-cred-pin"), credPin2: $("ai-set-cred-pin2"), credMsg: $("ai-set-cred-msg"),
  };
  var me = null;

  function say(el, text, isError) {
    el.textContent = text || "";
    el.classList.toggle("is-error", !!isError);
    el.setAttribute("role", isError ? "alert" : "status");   // an error interrupts a screen reader, a confirmation does not
  }

  // Sends JSON; resolves { ok, body } and never rejects (a network error is a Korean message).
  function send(method, url, payload) {
    return fetch(url, { method: method, credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) { return { ok: res.ok, body: body || {} }; });
    }, function () { return { ok: false, body: { error: t("settings.errNoServer") } }; });
  }

  function renderAccount() {
    var hasPin = !!me && me.pinEnabled !== false;
    acct.nick.value = me ? displayNameOf(me) : "";
    acct.pinTitle.textContent = hasPin ? t("settings.pinTitleChange") : t("settings.pinTitleSet");
    acct.pinForm.hidden = !hasPin;
    acct.credForm.hidden = hasPin;
  }

  function clearFields(list) { list.forEach(function (el) { el.value = ""; }); }

  acct.nickForm.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var name = acct.nick.value.trim();
    var bad = nicknameError(name);
    if (bad) { say(acct.nickMsg, bad, true); return; }
    say(acct.nickMsg, "");
    send("PUT", "/api/profile", { name: name }).then(function (r) {
      if (!r.ok) { say(acct.nickMsg, r.body.error || t("settings.nickFailed"), true); return; }
      me = Object.assign({}, me, { displayName: name });
      api.setUser(me);
      if (deps.onUserChange) deps.onUserChange(me);
      say(acct.nickMsg, t("settings.nickChanged"));
    });
  });

  acct.pinForm.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var bad = pinChangeError(acct.pinCur.value, acct.pinNew.value, acct.pinNew2.value);
    if (bad) { say(acct.pinMsg, bad, true); return; }
    say(acct.pinMsg, "");
    send("PUT", "/api/user/pin", { currentPin: acct.pinCur.value, newPin: acct.pinNew.value }).then(function (r) {
      if (!r.ok) {
        var msg = r.body.locked ? (r.body.error || t("settings.pinLocked")) : r.body.error === "Current PIN is incorrect" ? t("settings.pinWrong") : (/[가-힣]/.test(r.body.error || "") ? r.body.error : t("settings.pinFailed"));
        say(acct.pinMsg, msg, true);
        acct.pinCur.value = "";
        return;
      }
      clearFields([acct.pinCur, acct.pinNew, acct.pinNew2]);
      say(acct.pinMsg, t("settings.pinChanged"));
    });
  });

  acct.credForm.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var bad = credentialsError(acct.credId.value, acct.credPin.value, acct.credPin2.value);
    if (bad) { say(acct.credMsg, bad, true); return; }
    say(acct.credMsg, "");
    send("PUT", "/api/user/credentials", { username: acct.credId.value.trim(), pin: acct.credPin.value }).then(function (r) {
      if (!r.ok) { say(acct.credMsg, /[가-힣]/.test(r.body.error || "") ? r.body.error : t("settings.credFailed"), true); return; }
      clearFields([acct.credId, acct.credPin, acct.credPin2]);
      me = Object.assign({}, me, { username: r.body.username, pinEnabled: true });
      api.setUser(me);
      say(acct.pinMsg, t("settings.credSet"));
    });
  });

  applyTheme(state.theme);
  renderTheme();
  renderLang();
  renderLayouts();
  markMotion();
  markCoaching();
  renderNav();
  // A language switch: redraw what this module built from words (the static markup is the client's applyDom).
  onLangChange(function (lang) {
    state.lang = lang;
    renderNav();
    renderTheme();
    renderLang();
    renderLayouts();
    markMotion();
    markCoaching();
    renderAccount();
    els.role.textContent = roleLabel(me && me.role);
  });
  var api = {
    open: open,
    close: close,
    isOpen: function () { return state.open; },
    section: function () { return state.section; },
    setUser: function (user) {
      me = user && user.id != null ? user : null;
      renderAccount();
      els.name.textContent = displayNameOf(user);
      els.username.textContent = (user && user.username) || "";
      els.role.textContent = roleLabel(user && user.role);
    },
    setAvailable: function (id, on) {
      state.available[id] = !!on;
      renderNav();
      if (state.open && !state.available[state.section]) show(firstAvailable());
    },
    // The server's copy of the display choices arrived (/api/me): show them without calling back.
    setDisplayPrefs: function (prefs) {
      state.layout = prefs.layout;
      state.reduceMotion = !!prefs.reduceMotion;
      if (prefs.promptCoaching != null) state.coaching = !!prefs.promptCoaching;
      markLayout();
      markMotion();
      markCoaching();
    },
    onShow: function (id, fn) { (showHooks[id] = showHooks[id] || []).push(fn); },
    onOpen: function (fn) { openHooks.push(fn); },
    onClose: function (fn) { closeHooks.push(fn); },
    // After the viewer (and so the available sections) is known: reopen what the URL names.
    restoreFromHash: function () {
      var legacy = location.hash === "#settings/archived";
      var id = parseHash(location.hash);
      if (id) { open(id); scrollLegacyArchive(legacy); }
    },
  };
  return api;
}

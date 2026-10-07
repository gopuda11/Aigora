import { t, onLangChange } from "./i18n.js";
// office.js - Controller for Office co-editing: the card's "함께 편집" button and presence badge,
// the full-screen editor overlay (back, title, who is editing, version history), the "새 문서"
// sheet of the composer "+" menu, and the editor-unavailable state. The editor itself runs in an
// iframe on the same origin (/p/<slug>/office/editor/...) whose proxy and permissions are the
// server's: this file only hides what would be refused, the server decides every permission.

import {
  unavailableText, NEW_TYPES, modeButton, statusUrl, editorUrl, versionsUrl, restoreUrl, versionDownloadUrl, presenceText, cardActionsHtml, cardVersion, overlayHtml, stateHtml,
  errorMessage, versionsHtml, restoreMessage, newDocSheetHtml, newDocError,
} from "./office-model.js";

var POLL_MS = 15000, WHO_MS = 6000;
// Split view: from this viewport width up the editor sits beside the chat (chat >= 300px, editor >= 420px next to the
// left sidebar); narrower (phones, portrait tablets) keeps the full-screen overlay.
var SPLIT_MIN_WIDTH = 1024, CHAT_MIN = 300, DOC_MIN = 420, SPLIT_KEY = "aigora.office.docWidth", RELAYOUT_MS = 150;

export function initOffice(deps) {
  var els = deps.els;
  var doc = deps.document || document;
  var win = deps.window || window;
  var timers = deps.timers || globalThis;
  // Unref-ed where the host supports it (Node): a pending UI timer must never keep a test process alive.
  function every(fn, ms) { var t = timers.setInterval(fn, ms); if (t && typeof t.unref === "function") t.unref(); return t; }
  function later(fn, ms) { var t = timers.setTimeout(fn, ms); if (t && typeof t.unref === "function") t.unref(); return t; }
  var http = deps.fetch || function (u, o) { return globalThis.fetch(u, o); };
  var state = { enabled: false, available: false, editing: {}, scopeKey: "" };
  var lastFetch = 0, inflight = null;
  var overlay = null, sheet = null, pollTimer = null, whoTimer = null, armed = null;

  function base() { return "/p/" + deps.slug() + "/office/"; }
  function json(url, init) {
    return http(url, Object.assign({ credentials: "same-origin", cache: "no-store" }, init || {})).then(function (res) {
      return res.json().then(function (b) { return { ok: res.ok, status: res.status, body: b || {} }; }, function () { return { ok: res.ok, status: res.status, body: {} }; });
    });
  }
  function post(url, body) {
    return json(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "aigora" }, body: JSON.stringify(body || {}) });
  }

  // --- Status (availability, who is editing, version numbers) ----------------------------
  function scopeKey(s) { return s ? s.kind + ":" + (s.roomId || s.channelId) : ""; }
  function applyMenu() {
    if (!els.menuItem) return;
    var tg = deps.getTarget();
    els.menuItem.classList.toggle("hidden", !state.enabled);
    var small = els.menuItem.querySelector("small");
    if (small) small.textContent = !state.enabled ? "" : tg.kind ? (state.available ? t("office.menuHint") : unavailableText()) : tg.reason;
  }
  function refreshStatus(force) {
    var scope = deps.getScope();
    var key = scopeKey(scope);
    if (!scope) { var was = state.enabled; state = { enabled: false, available: false, editing: {}, scopeKey: "" }; applyMenu(); return Promise.resolve(was); }
    if (inflight && !force) return inflight;
    if (!force && key === state.scopeKey && deps.now() - lastFetch < 4000) return Promise.resolve(false);
    lastFetch = deps.now();
    inflight = json(statusUrl(base(), scope)).then(function (r) {
      inflight = null;
      var next = r.ok ? { enabled: !!r.body.enabled, available: !!r.body.available, editing: r.body.editing || {}, scopeKey: key } : { enabled: false, available: false, editing: {}, scopeKey: key };
      var changed = JSON.stringify(next) !== JSON.stringify(state);
      state = next;
      applyMenu();
      if (changed && deps.rerender) deps.rerender();
      return changed;
    }, function () { inflight = null; return false; });
    return inflight;
  }
  function hasOfficeCards() {
    var items = deps.getThread().items;
    for (var i = 0; i < items.length; i++) if (items[i].role === "attachment" && /^(docx|xlsx|pptx)$/.test(items[i].ext)) return true;
    return false;
  }
  function poll() {
    if (doc.hidden || (!overlay && !hasOfficeCards())) return;
    refreshStatus(true);
  }
  pollTimer = every(poll, POLL_MS);

  // --- Card ---------------------------------------------------------------------------
  function itemFor(id) {
    var items = deps.getThread().items;
    for (var i = 0; i < items.length; i++) if (items[i].role === "attachment" && items[i].attachmentId === id) return items[i];
    return null;
  }
  function canEdit(it) {
    if (it.scope === "channel") { var a = deps.getAccess(); return !!(a && a.owner && !a.readOnly); }
    var room = deps.getRoom();
    return !room || room.role !== "viewer";
  }
  function cardVersionOf(it) { return cardVersion(it, state); }
  function cardActions(it) { return cardActionsHtml(it, state, { canEdit: canEdit(it), myId: deps.getMyId() }); }

  // --- Overlay ------------------------------------------------------------------------
  function q(sel) { return overlay && overlay.root.querySelector(sel); }
  function whoText() {
    var e = overlay && state.editing[overlay.it.attachmentId];
    return e ? presenceText(e.editors, deps.getMyId()) : "";
  }
  function paintWho() { var el = q(".of-who"); if (el) el.textContent = whoText(); if (overlay && overlay.split) paintAttach(); }
  function setState(kind, text, down) {
    var el = q("[data-of-state]");
    if (!el) return;
    el.classList.toggle("hidden", kind === "ready");
    el.classList.toggle("is-error", kind === "error");
    if (kind !== "ready") el.innerHTML = stateHtml(kind, text, down);
  }
  function loadFrame() {
    var frame = q("[data-of-frame]");
    if (!frame) return;
    setState("loading", t("office.opening"));
    overlay.ready = false;
    paintLocate();
    frame.src = editorUrl(base(), overlay.it, overlay.split ? "0" : overlay.phone ? (overlay.mobile ? "1" : "0") : undefined);
  }
  // Phone: the layer follows the visual viewport (the on-screen keyboard shrinks it, the layout viewport stays), so the
  // frame, and with it DS, is re-laid out above the keyboard instead of leaving the caret line under it.
  function fitViewport() {
    if (!overlay || !overlay.phone) return;
    var vv = win.visualViewport;
    if (!vv || !(vv.height > 0)) return;
    var prev = overlay.vvHeight;
    overlay.root.style.setProperty("--of-vv-h", vv.height + "px");
    overlay.root.style.setProperty("--of-vv-top", (vv.offsetTop || 0) + "px");
    overlay.root.classList.add("is-vv");
    overlay.vvHeight = vv.height;
    if (prev && vv.height < prev - 80 && !overlay.mobile) locate(); // the keyboard came up: keep the caret in view
  }
  // "내 위치로": the editor frame takes the focus back and scrolls its page so the caret is in view (office-host.js).
  function locate() {
    var frame = q("[data-of-frame]");
    if (!frame || !frame.contentWindow || overlay.mobile) return;
    try { frame.contentWindow.postMessage({ aigoraOffice: true, type: "locate" }, win.location.origin); } catch (_) { /* frame gone */ }
  }
  function paintLocate() {
    var btn = q("[data-of-locate]");
    if (btn) btn.hidden = !(overlay.ready && !overlay.mobile);
  }
  function onMessage(ev) {
    if (!overlay || !win.location || ev.origin !== win.location.origin) return;
    var frame = q("[data-of-frame]");
    var d = ev.data;
    if (!frame || ev.source !== frame.contentWindow || !d || d.aigoraOffice !== true) return;
    if (d.type === "ready") { overlay.ready = true; paintLocate(); setState("ready"); if (deps.announce) deps.announce(t("office.announceOpened")); }
    else if (d.type === "error" && d.code !== "editor_error") {
      var dl = d.code === "office_unavailable" || d.code === "unsupported" ? downloadHref(overlay.it) : "";
      setState("error", errorMessage(d.code, d.message), dl);
      refreshStatus(true);
    }
  }
  function downloadHref(it) {
    return "/p/" + deps.slug() + "/api/" + (it.scope === "channel" ? "channel-attachments/" + encodeURIComponent(it.channelId) : "room-attachments/" + encodeURIComponent(it.roomId)) + "/" + it.attachmentId;
  }
  function onPop() { if (overlay) closeNow(); }

  // --- Split view ---------------------------------------------------------------------
  // The area right of the left sidebar (the main column), where chat and editor share the width.
  function area() {
    var col = doc.getElementById && doc.getElementById("main-column");
    var left = col && col.getBoundingClientRect ? Math.max(0, col.getBoundingClientRect().left || 0) : 0;
    return { left: left, width: (win.innerWidth || 0) - left };
  }
  function splitFits() {
    var w = win.innerWidth || 0;
    return w >= SPLIT_MIN_WIDTH && area().width >= CHAT_MIN + DOC_MIN;
  }
  function docBounds() { var a = area().width; return { min: DOC_MIN, max: Math.max(DOC_MIN, a - CHAT_MIN), avail: a }; }
  function readDocWidth() {
    try { var n = Number(win.localStorage && win.localStorage.getItem(SPLIT_KEY)); if (n > 0) return n; } catch (_) { /* storage blocked */ }
    return 0;
  }
  function applyDocWidth(px, save) {
    if (!overlay || !overlay.split) return;
    var b = docBounds();
    var w = Math.round(Math.min(b.max, Math.max(b.min, px)));
    overlay.docW = w;
    doc.documentElement.style.setProperty("--of-doc-w", w + "px");
    doc.documentElement.style.setProperty("--of-avail", b.avail + "px");
    var d = q("[data-of-divider]");
    if (d) {
      d.setAttribute("aria-valuemin", String(b.min)); d.setAttribute("aria-valuemax", String(b.max)); d.setAttribute("aria-valuenow", String(w));
      d.setAttribute("aria-valuetext", t("office.widthValue", { pct: Math.round(w / b.avail * 100) }));
    }
    if (save) { try { win.localStorage && win.localStorage.setItem(SPLIT_KEY, String(w)); } catch (_) { /* storage blocked */ } }
  }
  // A resize or a turn of the tablet: the pane is clamped to the new width, or the document moves between the split view
  // and the overlay. The frame is a new editor session then (the old one is blanked first, so DS saves as on any close).
  function onResize() {
    if (!overlay) return;
    if (overlay.split) applyDocWidth(overlay.docW, false);
    if (overlay.relayout) timers.clearTimeout(overlay.relayout);
    overlay.relayout = later(relayout, RELAYOUT_MS);
  }
  function relayout() {
    if (!overlay) return;
    overlay.relayout = null;
    var want = splitFits() && !(win.innerWidth <= 768);
    if (want === overlay.split) return;
    var o = overlay;
    teardown(true);
    if (o.pushed) { try { win.history.back(); } catch (_) { /* no history API */ } }
    open(o.it, o.opener, o.panelWas);
  }
  function onDividerKey(ev) {
    var step = ev.shiftKey ? 96 : 24, b = docBounds(), w = overlay.docW;
    if (ev.key === "ArrowLeft") w += step; else if (ev.key === "ArrowRight") w -= step;
    else if (ev.key === "Home") w = b.min; else if (ev.key === "End") w = b.max; else return;
    ev.preventDefault();
    applyDocWidth(w, true);
  }
  function onDividerDown(ev) {
    if (ev.button) return;
    ev.preventDefault();
    var d = ev.target, id = ev.pointerId;
    try { d.setPointerCapture(id); } catch (_) { /* no capture */ }
    overlay.root.classList.add("is-dragging");
    function move(e) { applyDocWidth((win.innerWidth || 0) - e.clientX, false); }
    function up() {
      d.removeEventListener("pointermove", move); d.removeEventListener("pointerup", up); d.removeEventListener("pointercancel", up);
      if (!overlay) return;
      overlay.root.classList.remove("is-dragging");
      applyDocWidth(overlay.docW, true);
    }
    d.addEventListener("pointermove", move); d.addEventListener("pointerup", up); d.addEventListener("pointercancel", up);
  }
  function toggleFull() {
    if (!overlay || !overlay.split) return;
    var on = !overlay.root.classList.contains("is-full");
    overlay.root.classList.toggle("is-full", on);
    var btn = q("[data-of-full]");
    if (btn) { btn.setAttribute("aria-pressed", on ? "true" : "false"); btn.setAttribute("aria-label", on ? t("office.sideBySide") : t("office.fullscreen")); var l = btn.querySelector("span"); if (l) l.textContent = on ? t("office.sideBySide") : t("office.fullscreen"); }
    applyDocWidth(overlay.docW, false);
  }
  function paintAttach() {
    var btn = q("[data-of-attach]");
    if (!btn || !deps.attachments) return;
    var on = deps.attachments.picked().some(function (f) { return f.id === overlay.it.attachmentId; });
    btn.disabled = on;
    var l = btn.querySelector("span");
    if (l) l.textContent = on ? t("office.attached") : t("office.attach");
  }
  function attach() {
    if (!overlay || !deps.attachments) return;
    deps.attachments.pickFromCard(overlay.it.attachmentId);
    paintAttach();
  }

  function open(it, opener, carried) {
    if (overlay && overlay.split && overlay.it.attachmentId !== it.attachmentId) { carried = overlay.panelWas; opener = opener || overlay.opener; teardown(true); } // another document replaces this one in the pane
    if (overlay) return;
    var root = doc.createElement("div");
    var phone = !!win.innerWidth && win.innerWidth <= 768;
    var split = !phone && splitFits();
    root.className = split ? "of-layer is-split" : "of-layer";
    root.innerHTML = overlayHtml(it, { who: "", phone: phone, canEdit: canEdit(it), split: split });
    doc.body.appendChild(root);
    overlay = { root: root, it: it, opener: opener || null, pushed: false, history: false, phone: phone, mobile: phone, split: split, scopeKey: scopeKey(deps.getScope()), panelWas: carried };
    if (split) {
      doc.documentElement.classList.add("of-split");
      if (deps.setPanelOpen) { overlay.panelWas = carried !== undefined ? carried : !!(deps.getPanelOpen && deps.getPanelOpen()); if (overlay.panelWas) deps.setPanelOpen(false); } // the inspector gives its place; not saved
      var b = docBounds();
      applyDocWidth(readDocWidth() || b.avail / 2, false);
      var dv = q("[data-of-divider]");
      dv.addEventListener("pointerdown", onDividerDown);
      dv.addEventListener("keydown", onDividerKey);

      paintAttach();
    } else {
      doc.documentElement.classList.add("of-open");
      try { win.history.pushState({ aigoraOffice: 1 }, ""); overlay.pushed = true; } catch (_) { /* no history API */ }
    }
    win.addEventListener("message", onMessage);
    win.addEventListener("resize", onResize);
    win.addEventListener("orientationchange", onResize);
    if (!split) win.addEventListener("popstate", onPop);
    root.addEventListener("click", onOverlayClick);
    root.addEventListener("keydown", onOverlayKey);
    if (phone && win.visualViewport && win.visualViewport.addEventListener) {
      win.visualViewport.addEventListener("resize", fitViewport);
      win.visualViewport.addEventListener("scroll", fitViewport);
      fitViewport();
    }
    loadFrame();
    var back = root.querySelector("[data-of-back]");
    if (back && back.focus && !split) back.focus(); // in the split view the focus stays in the chat
    whoTimer = every(function () { refreshStatus(true).then(paintWho); }, WHO_MS);
    refreshStatus(true).then(paintWho);
  }
  function closeNow() { teardown(false); }
  function teardown(replacing) {
    if (!overlay) return;
    var o = overlay;
    overlay = null;
    timers.clearInterval(whoTimer);
    win.removeEventListener("message", onMessage);
    win.removeEventListener("popstate", onPop);
    win.removeEventListener("resize", onResize);
    win.removeEventListener("orientationchange", onResize);
    if (o.relayout) timers.clearTimeout(o.relayout);
    if (o.phone && win.visualViewport && win.visualViewport.removeEventListener) {
      win.visualViewport.removeEventListener("resize", fitViewport);
      win.visualViewport.removeEventListener("scroll", fitViewport);
    }
    var frame = o.root.querySelector("[data-of-frame]");
    if (frame) frame.src = "about:blank"; // closing the editor ends the session; DS saves and calls back
    if (o.root.parentNode) o.root.parentNode.removeChild(o.root);
    doc.documentElement.classList.remove("of-open");
    if (o.split) {
      doc.documentElement.classList.remove("of-split");
      doc.documentElement.style.removeProperty("--of-doc-w");
      doc.documentElement.style.removeProperty("--of-avail");
      // The inspector comes back as it was, unless a replacement document is about to take the place again.
      if (!replacing && o.panelWas && deps.setPanelOpen && (win.innerWidth || 0) >= 1024) deps.setPanelOpen(true);
    }
    if (o.opener && o.opener.focus) o.opener.focus();
    if (deps.announce) deps.announce(t("office.announceClosed"));
    later(function () { refreshStatus(true); }, 2500);
    later(function () { refreshStatus(true); }, 12000);
  }
  function back() {
    if (!overlay) return;
    if (overlay.pushed) { overlay.pushed = false; try { win.history.back(); return; } catch (_) { /* fall through */ } }
    closeNow();
  }

  // --- History ------------------------------------------------------------------------
  function historyPanel() { return q("[data-of-history-panel]"); }
  function paintHistory(list, message) {
    var panel = historyPanel();
    if (!panel) return;
    var it = overlay.it;
    panel.innerHTML = versionsHtml(list, { now: deps.now(), canRestore: canEdit(it), message: message, downloadHref: function (n) { return versionDownloadUrl(base(), it, n); } });
    overlay.versions = list;
  }
  function toggleHistory(force) {
    var panel = historyPanel(), btn = q("[data-of-history]");
    if (!panel) return;
    var show = force === undefined ? panel.hidden : force;
    panel.hidden = !show;
    if (btn) btn.setAttribute("aria-expanded", show ? "true" : "false");
    if (!show) return;
    panel.innerHTML = '<p class="of-history-note">' + t("office.loading") + '</p>';
    json(versionsUrl(base(), overlay.it)).then(function (r) {
      if (!overlay || panel.hidden) return;
      if (!r.ok) { panel.innerHTML = '<p class="of-history-note">' + t("office.historyLoadFailed") + '</p>'; return; }
      paintHistory(r.body.versions || []);
      var first = panel.querySelector("button, a");
      if (first && first.focus) first.focus();
    }, function () { if (overlay) panel.innerHTML = '<p class="of-history-note">' + t("office.historyLoadFailed") + '</p>'; });
  }
  function sleep(ms) { return new Promise(function (r) { later(r, ms); }); }
  // The editor holds the document open (and DS still has to save), so it is closed first; the server
  // answers 409 until the save has landed, and this retries for a while.
  function restore(n) {
    var it = overlay.it;
    var frame = q("[data-of-frame]");
    if (frame) frame.src = "about:blank";
    setState("loading", t("office.finishing"));
    var tries = 0;
    function attempt() {
      if (!overlay) return;
      post(restoreUrl(base(), it, n)).then(function (r) {
        if (!overlay) return;
        if (r.status === 409 && ++tries < 20) return sleep(3000).then(attempt);
        if (r.ok) {
          deps.toast(t("office.restoredToast", { n: n }));
          loadFrame();
          toggleHistory(true);
          refreshStatus(true);
          return;
        }
        loadFrame();
        paintHistory(overlay.versions || [], restoreMessage(r.status, r.body));
      }, function () { if (overlay) { loadFrame(); paintHistory(overlay.versions || [], t("office.restoreOffline")); } });
    }
    attempt();
  }
  function armRestore(btn, n) {
    if (armed && armed.n === n) {
      timers.clearTimeout(armed.timer); armed = null;
      return restore(n);
    }
    if (armed) { timers.clearTimeout(armed.timer); armed.reset(); }
    btn.textContent = t("office.restoreConfirm");
    btn.classList.add("is-armed");
    armed = { n: n, reset: function () { btn.textContent = t("office.restoreVersion"); btn.classList.remove("is-armed"); }, timer: later(function () { if (armed && armed.n === n) { armed.reset(); armed = null; } }, 4000) };
  }

  // Phone: ONLYOFFICE's mobile layout (view only in the Community build) <-> the desktop layout with editing.
  // The frame is reloaded: it is a new session with the other mode.
  function toggleMode() {
    if (!overlay || !overlay.phone) return;
    overlay.mobile = !overlay.mobile;
    var btn = q("[data-of-mode]"), m = modeButton(overlay.mobile);
    if (btn) {
      btn.innerHTML = m.html;
      btn.setAttribute("aria-label", m.aria);
      btn.classList.toggle("is-edit", m.edit);
    }
    loadFrame();
    if (!overlay.mobile) deps.toast(t("office.desktopToast"));
  }
  function onOverlayClick(ev) {
    var t = ev.target;
    var hit = function (sel) { return t && t.closest && t.closest(sel); };
    if (hit("[data-of-back]")) back();
    else if (hit("[data-of-history-close]")) toggleHistory(false);
    else if (hit("[data-of-locate]")) locate();
    else if (hit("[data-of-attach]")) attach();
    else if (hit("[data-of-full]")) toggleFull();
    else if (hit("[data-of-mode]")) toggleMode();
    else if (hit("[data-of-history]")) toggleHistory();
    else if (hit("[data-of-restore]")) armRestore(hit("[data-of-restore]"), Number(hit("[data-of-restore]").getAttribute("data-of-restore")));
  }
  function onOverlayKey(ev) {
    if (ev.key === "Escape" && historyPanel() && !historyPanel().hidden) { ev.stopPropagation(); toggleHistory(false); }
  }

  // --- 새 문서 ---------------------------------------------------------------------------
  function closeSheet() {
    if (!sheet) return;
    var opener = sheet.opener;
    if (sheet.root.parentNode) sheet.root.parentNode.removeChild(sheet.root);
    sheet = null;
    if (opener && opener.focus) opener.focus();
  }
  function paintSheet(error) {
    var name = sheet.root.querySelector("#of-new-name");
    if (name) sheet.name = String(name.value || "");
    sheet.root.innerHTML = newDocSheetHtml(sheet.type, sheet.name, error);
    var input = sheet.root.querySelector("#of-new-name");
    if (input && input.focus) input.focus();
  }
  function openNew(opener) {
    var t = deps.getTarget();
    if (!t.kind) { deps.toast(t.reason); return false; }
    closeSheet();
    var root = doc.createElement("div");
    root.className = "att-sheet-layer of-sheet-layer";
    els.root.appendChild(root);
    sheet = { root: root, opener: opener || null, type: NEW_TYPES[0].type, name: "", target: t, busy: false };
    paintSheet("");
    root.addEventListener("click", onSheetClick);
    root.addEventListener("change", function (ev) { if (ev.target && ev.target.getAttribute && ev.target.getAttribute("name") === "of-new-type") { sheet.type = ev.target.getAttribute("value"); paintSheet(""); } });
    root.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") closeSheet();
      else if (ev.key === "Enter" && ev.target && ev.target.id === "of-new-name") { ev.preventDefault(); create(); }
    });
    return true;
  }
  function createUrl(t) {
    var api = "/p/" + deps.slug() + "/api/";
    return t.kind === "channel" ? api + "channel-attachments/" + encodeURIComponent(t.channelId) + "/blank?session=" + encodeURIComponent(t.sessionId) : api + "room-attachments/" + encodeURIComponent(t.roomId) + "/blank";
  }
  function create() {
    if (!sheet || sheet.busy) return;
    var input = sheet.root.querySelector("#of-new-name");
    var btn = sheet.root.querySelector("[data-of-new-create]");
    sheet.name = String((input && input.value) || "");
    sheet.busy = true;
    if (btn) btn.disabled = true;
    post(createUrl(sheet.target), { type: sheet.type, name: sheet.name.trim() }).then(function (r) {
      if (!sheet) return;
      sheet.busy = false;
      if (!r.ok || !r.body.attachment) { paintSheet(newDocError(r.status, r.body && r.body.error)); return; }
      var a = r.body.attachment;
      closeSheet();
      var it = { attachmentId: a.id, name: a.name, ext: a.ext, scope: a.kind === "channel" ? "channel" : "room", roomId: a.roomId, channelId: a.channelId, authorId: a.uploaderId };
      refreshStatus(true).then(function () {
        if (state.available) { deps.toast(t("office.created")); open(it); }
        else deps.toast(t("office.created") + " " + (state.enabled ? unavailableText() : ""));
      });
    }, function () { if (sheet) { sheet.busy = false; paintSheet(t("office.createOffline")); } });
  }
  function onSheetClick(ev) {
    var t = ev.target;
    if (t && t.closest && t.closest("[data-of-sheet-close]")) closeSheet();
    else if (t && t.closest && t.closest("[data-of-new-create]")) create();
  }

  // --- Events --------------------------------------------------------------------------
  els.chat.addEventListener("click", function (ev) {
    var btn = ev.target && ev.target.closest && ev.target.closest("[data-office-open]");
    if (!btn) return;
    var it = itemFor(btn.getAttribute("data-office-open"));
    if (!it) return;
    if (!state.available) { deps.toast(unavailableText()); refreshStatus(true); return; }
    open(it, btn);
  });
  applyMenu();
  onLangChange(applyMenu);

  return {
    cardActions: cardActions, cardVersion: cardVersionOf, onContext: function () {
      if (overlay && overlay.split && scopeKey(deps.getScope()) !== overlay.scopeKey) closeNow(); // another room or channel: the document pane closes (the frame is blanked, DS saves)
      refreshStatus(false); applyMenu();
    }, refresh: function () { return refreshStatus(true); },
    openNew: openNew, open: open, close: back, isOpen: function () { return !!overlay; }, state: function () { return state; },
    dispose: function () { timers.clearInterval(pollTimer); timers.clearInterval(whoTimer); },
  };
}

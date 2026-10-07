import { t, onLangChange } from "./i18n.js";
// phone-nav.js - DOM controller of the phone (<=768px) shell, built like a chat app: the top bar (☰ · the
// "방 | 채널" pill · the bell or 새 세션), a clean thread, and a sidebar that holds every other feature. The
// rules (what each row is, who sees it, how a swipe commits, how the keyboard is measured) live in
// phone-nav-model.js; every feature the sidebar reaches is a function handed in through `deps.actions`, so
// this file never duplicates the modules behind them (settings, guide, coaching, skills, room-admin, ...).
//
// The sidebar is the page's own <aside class="ai-sidebar">, an off-canvas drawer at phone width: Escape,
// the scrim, a left swipe and the browser's back all close it (it owns one history entry while it is open).
// Motion is a CSS transition on transform, so 동작 줄이기 and prefers-reduced-motion (which switch every
// transition off) make it land at once. Above 768px none of this is active.
import {
  PHONE_QUERY, normalizeTab, topBar, menuRows, primaryAction, suggestions, searchEntries, progressView,
  keyboardMetrics, lockAxis, swipeCommits,
} from "./phone-nav-model.js";

function e(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

var SVG = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
var ICONS = {
  menu: '<path d="M4 8h16M4 16h10"/>',
  bell: '<path d="M6 8a6 6 0 0112 0c0 7 3 8 3 8H3s3-1 3-8M10 21a2 2 0 004 0"/>',
  compose: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  rooms: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  results: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  share: '<path d="M12 15V3M7 8l5-5 5 5"/><path d="M5 14v6h14v-6"/>',
  pin: '<path d="M12 17v5M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6z"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0113 0M16 4.5a3.5 3.5 0 010 7M18 14a6 6 0 013.5 6"/>',
  coach: '<path d="M12 3a6 6 0 00-3 11.2V17h6v-2.8A6 6 0 0012 3z"/><path d="M9 21h6"/>',
  skills: '<path d="M12 3l2.4 5.6L20 9.4l-4.3 3.8L17 19l-5-3-5 3 1.3-5.8L4 9.4l5.6-.8z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  guide: '<path d="M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2z"/><path d="M8 7h7"/>',
  approval: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  manage: '<path d="M4 20V10l8-6 8 6v10z"/><path d="M10 20v-6h4v6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  file: '<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18"/>',
};
function icon(name, size) {
  var s = size ? SVG.replace(/="22"/g, '="' + size + '"') : SVG;
  return s + (ICONS[name] || "") + "</svg>";
}

export function initPhoneNav(deps) {
  var els = deps.els;
  var win = deps.win || (typeof window !== "undefined" ? window : null);
  var mq = win && win.matchMedia ? win.matchMedia(PHONE_QUERY) : null;
  var hist = win && win.history && typeof win.history.pushState === "function" ? win.history : null;
  var phone = !!(mq && mq.matches);
  var open = false, histOpen = false;
  var pendingRoom = null;
  var pendingTab = null, pendingTimer = null, afterClose = null, closeTimer = null;
  var query = "";
  var searching = false;
  var drag = null;
  var kb = { open: false };
  var lastHtml = {};
  var opener = null;
  var vpTimer = null;

  function room() { return deps.getRoom ? deps.getRoom() : null; }
  function on() { return phone; }
  function hasRoom() { return !!room(); }
  function tab() {
    if (pendingTab) return pendingTab;
    var a = deps.getAccess ? deps.getAccess() : null;
    return a && a.isPrivate ? "private" : "room";
  }
  function viewer() { return deps.getViewer ? deps.getViewer() : { isAdmin: false }; }
  function channel() { var v = deps.getView ? deps.getView() : null; return v || { channelName: "", ownSessions: [], adminChannels: [] }; }
  function setHtml(el, key, html) {
    if (!el || lastHtml[key] === html) return;
    lastHtml[key] = html;
    el.innerHTML = html;
  }

  // --- Top bar ------------------------------------------------------------------------------
  function renderBar() {
    var t = tab(), v = channel(), bell = deps.getBell ? deps.getBell() : { count: 0 };
    var spec = topBar({ tab: t, channelName: v.channelName, canStartNew: deps.canStartNew ? deps.canStartNew() : false, bellCount: bell.count });
    var showTabs = hasRoom();
    els.seg.classList.toggle("hidden", !showTabs);
    els.seg.setAttribute("data-tab", spec.tab);
    spec.tabs.forEach(function (x) {
      var b = els.segBtns[x.id];
      b.textContent = x.label;
      b.setAttribute("aria-selected", spec.tab === x.id ? "true" : "false");
      b.setAttribute("tabindex", spec.tab === x.id ? "0" : "-1");
      b.setAttribute("title", x.full);
    });
    els.action.classList.toggle("hidden", !showTabs);
    els.action.setAttribute("data-action", spec.action.id);
    els.action.setAttribute("aria-label", spec.action.label);
    if (spec.action.disabled) els.action.setAttribute("aria-disabled", "true"); else els.action.removeAttribute("aria-disabled");
    setHtml(els.actionIcon, "action", icon(spec.action.id === "bell" ? "bell" : "compose"));
    els.badge.textContent = spec.action.badge;
    els.badge.classList.toggle("hidden", !spec.action.badge);
    // The room's name: a quiet line under the bar. The phone has no desktop header, so it always says which room this is.
    var r = room();
    els.caption.textContent = r ? r.name : "";
    els.caption.classList.toggle("hidden", !r);
  }

  // --- Sidebar ------------------------------------------------------------------------------
  function menuContext() {
    var r = room(), a = deps.getAvail ? deps.getAvail() : {}, bell = deps.getBell ? deps.getBell() : { pending: 0 };
    return {
      hasRoom: !!r, roomName: r ? r.name : "", memberCount: r ? r.memberCount : 0, isAdmin: !!viewer().isAdmin, avail: a,
      skills: deps.getSkills ? deps.getSkills() : { on: false, count: 0 }, pending: bell.pending || 0,
    };
  }
  function renderMenu() {
    var rows = menuRows(menuContext());
    setHtml(els.menu, "menu", rows.map(function (r) {
      return '<button type="button" class="ai-ps-row' + (r.dim ? " is-dim" : "") + '" data-ps="' + e(r.id) + '">' + icon(r.icon) +
        '<span class="ai-ps-label">' + e(r.label) + "</span>" +
        (r.meta ? '<span class="ai-ps-meta">' + e(r.meta) + "</span>" : "") +
        (r.badge ? '<span class="ai-ps-badge">' + e(r.badge) + "</span>" : "") + "</button>";
    }).join(""));
  }
  function renderPrimary() {
    var p = primaryAction(tab(), { isAdmin: viewer().isAdmin, canStartNew: deps.canStartNew ? deps.canStartNew() : false });
    els.primary.classList.toggle("hidden", !p);
    if (!p) return;
    els.primary.setAttribute("data-ps-primary", p.id);
    if (p.disabled) els.primary.setAttribute("aria-disabled", "true"); else els.primary.removeAttribute("aria-disabled");
    setHtml(els.primary, "primary", icon(p.id === "new" ? "compose" : "plus", 20) + "<span>" + e(p.label) + "</span>");
    els.primary.setAttribute("aria-label", p.id === "new" ? t("phoneNav.newSession") : t("phoneNav.createRoom"));
  }
  // 방: this room's 이전 대화 (sessions that predate the single shared feed). 채널: private-channels.js draws its own list.
  function renderContext() {
    var tb = tab();
    els.side.setAttribute("data-tab", tb);
    var prev = tb === "room" && hasRoom() && deps.getPrevious ? deps.getPrevious() : [];
    var html = prev.length
      ? '<h3 class="ai-ps-sub">' + t("phoneNav.groupPrevious") + '</h3><ul class="ai-pl-list">' + prev.map(function (s) {
        var more = deps.rowMenu ? deps.rowMenu("session", s.id) : "";
        return "<li" + (more ? ' class="ag-has-menu"' : "") + '><button type="button" class="ai-pl-row" data-ps-session="' + e(s.id) + '"' + (s.active ? ' aria-current="true"' : "") +
          '><span class="ai-pl-main"><span class="ai-pl-title">' + e(s.title) + '</span><span class="ai-pl-date">' + e(s.agent || "") + "</span></span></button>" + more + "</li>";
      }).join("") + "</ul>" : "";
    setHtml(els.prev, "prev", html);
    var hasList = tb === "private" || prev.length > 0;
    els.divider.classList.toggle("hidden", !hasList);
  }
  function renderSearchResults() {
    var show = searching && query.trim() !== "";
    els.results.classList.toggle("hidden", !show);
    els.body.classList.toggle("hidden", show);
    if (!show) return;
    var v = channel();
    var found = searchEntries(query, {
      rooms: deps.getRooms ? deps.getRooms() : [], own: v.ownSessions || [], previous: deps.getPrevious ? deps.getPrevious() : [],
      members: v.adminChannels || [],
    });
    var html = "";
    if (found.rooms.length) {
      html += '<h3 class="ai-ps-sub">' + t("phoneNav.room") + '</h3><ul class="ai-pl-list">' + found.rooms.map(function (r) {
        return '<li><button type="button" class="ai-pl-row" data-ps-room="' + e(r.id) + '"><span class="ai-pl-main"><span class="ai-pl-title">' + e(r.title) + "</span></span></button></li>";
      }).join("") + "</ul>";
    }
    if (found.sessions.length) {
      html += '<h3 class="ai-ps-sub">' + t("phoneNav.sessions") + '</h3><ul class="ai-pl-list">' + found.sessions.map(function (s) {
        return '<li><button type="button" class="ai-pl-row" data-ps-session="' + e(s.id) + '"><span class="ai-pl-main"><span class="ai-pl-title">' + e(s.title) +
          '</span><span class="ai-pl-date">' + e(s.group) + "</span></span></button></li>";
      }).join("") + "</ul>";
    }
    if (!html) html = '<p class="ai-private-empty">' + t("phoneNav.noResults") + '</p>';
    setHtml(els.results, "results", html);
  }

  function inertMain(on_) {
    [els.main].forEach(function (n) {
      if (!n) return;
      if (on_) n.setAttribute("inert", ""); else n.removeAttribute("inert");
    });
  }
  function syncSide() {
    var show = open && phone;
    els.side.classList.toggle("is-open", show);
    els.scrim.classList.toggle("is-on", show);
    els.layout.classList.toggle("is-side-open", show);
    els.menuBtn.setAttribute("aria-expanded", show ? "true" : "false");
    if (phone) els.side.setAttribute("aria-hidden", show ? "false" : "true");
    else els.side.removeAttribute("aria-hidden");
    if (phone && !show) els.side.setAttribute("inert", ""); else els.side.removeAttribute("inert");
    inertMain(show);
    els.edge.classList.toggle("hidden", !phone || open);
  }
  function openSide(from) {
    if (!phone || open) return;
    opener = from || els.menuBtn;
    open = true;
    if (hist) { hist.pushState({ agSide: 1 }, ""); histOpen = true; }
    refresh();
    syncSide();
    var first = els.menu.querySelector("button");
    if (first && first.focus) first.focus();
  }
  function finishClose(returnFocus) {
    var then = afterClose;
    afterClose = null;
    clearTimeout(closeTimer);
    open = false;
    histOpen = false;
    searching = false;
    query = "";
    if (els.q) els.q.value = "";
    els.searchForm.classList.add("hidden");
    els.searchBtn.setAttribute("aria-expanded", "false");
    renderSearchResults();
    syncSide();
    if (then) then();
    else if (returnFocus !== false && opener && opener.focus) opener.focus();
  }
  // Close the sidebar, then run `then` (a feature opening its own sheet or dialog). The history entry the open
  // sidebar owns is popped first; popstate completes the close. A browser that never answers is covered by a timer.
  function closeSide(then) {
    if (!open) { if (then) then(); return; }
    afterClose = then || null;
    if (histOpen && hist && typeof hist.back === "function") {
      hist.back();
      if (open) {
        clearTimeout(closeTimer);
        closeTimer = setTimeout(function () { if (open) finishClose(); }, 350);
        if (closeTimer && typeof closeTimer.unref === "function") closeTimer.unref();
      }
    } else finishClose();
  }
  if (win && win.addEventListener) {
    win.addEventListener("popstate", function (ev) {
      if (!phone) return;
      var s = ev && ev.state;
      if (open && !(s && s.agSide)) finishClose();
    });
  }
  // A reload restores the history state of an old sidebar entry: that entry is just the page again.
  if (hist && hist.state && hist.state.agSide && typeof hist.replaceState === "function") hist.replaceState(null, "");

  // --- Gestures -----------------------------------------------------------------------------
  function sideWidth() { return (els.side.offsetWidth || 0) || Math.min(340, Math.round(((win && win.innerWidth) || 390) * 0.86)); }
  function dragStyle(progress) {
    var w = sideWidth();
    els.side.style.transition = "none";
    els.side.style.transform = "translateX(" + Math.round(-w * (1 - progress)) + "px)";
    els.side.style.visibility = "visible";
    els.scrim.style.transition = "none";
    els.scrim.style.opacity = String(Math.max(0, Math.min(1, progress)));
    els.scrim.style.pointerEvents = "none";
  }
  function clearDrag() {
    els.layout.removeAttribute("data-dragging");
    ["transition", "transform", "visibility"].forEach(function (k) { els.side.style[k] = ""; });
    ["transition", "opacity", "pointerEvents"].forEach(function (k) { els.scrim.style[k] = ""; });
    drag = null;
  }
  // dir = 1: a right drag from the edge strip opens; dir = -1: a left drag on the open sidebar or scrim closes.
  function bindDrag(target, dir) {
    target.addEventListener("pointerdown", function (ev) {
      if (!phone || drag || (dir === 1 ? open : !open)) return;
      drag = { id: ev.pointerId, x0: ev.clientX, y0: ev.clientY, t0: ev.timeStamp || 0, dist: 0, locked: false, dir: dir };
      if (dir === 1) { try { if (target.setPointerCapture) target.setPointerCapture(ev.pointerId); } catch (x) { /* not capturable */ } }
    });
    target.addEventListener("pointermove", function (ev) {
      if (!drag || drag.dir !== dir || ev.pointerId !== drag.id) return;
      var dx = ev.clientX - drag.x0, dy = ev.clientY - drag.y0;
      if (!drag.locked) {
        var axis = lockAxis(dx, dy, dir);
        if (!axis) return;
        if (axis === "y") { drag = null; return; }
        drag.locked = true;
        els.layout.setAttribute("data-dragging", "1");
        if (dir === -1) { try { if (target.setPointerCapture) target.setPointerCapture(ev.pointerId); } catch (x) { /* not capturable */ } }
      }
      drag.dist = Math.max(0, dir * dx);
      var w = sideWidth();
      dragStyle(dir === 1 ? Math.min(1, drag.dist / w) : Math.max(0, 1 - drag.dist / w));
      if (ev.preventDefault) ev.preventDefault();
    });
    function release(ev, cancelled) {
      if (!drag || drag.dir !== dir || ev.pointerId !== drag.id) return;
      var d = drag, w = sideWidth();
      clearDrag();
      if (!d.locked) return;
      // Clearing the inline styles lets the stylesheet's transition carry the drawer from where the finger
      // left it to its resting place; with motion reduced it simply lands.
      if (!cancelled && swipeCommits(d.dist, (ev.timeStamp || 0) - d.t0, w)) {
        if (dir === 1) openSide(els.menuBtn); else closeSide();
      }
    }
    target.addEventListener("pointerup", function (ev) { release(ev, false); });
    target.addEventListener("pointercancel", function (ev) { release(ev, true); });
  }
  bindDrag(els.edge, 1);
  bindDrag(els.side, -1);
  bindDrag(els.scrim, -1);

  // --- Tabs and clicks ----------------------------------------------------------------------
  function setTab(next) {
    next = normalizeTab(next);
    var r = room();
    if (!phone || !r || next === tab()) return;
    pendingRoom = r.id;
    pendingTab = next;
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(function () { pendingTab = null; refresh(); }, 2500);
    if (pendingTimer && typeof pendingTimer.unref === "function") pendingTimer.unref();
    if (next === "room") {
      if (deps.cancelOpenOwn) deps.cancelOpenOwn();
      deps.openRoomMain(r.id);
    } else deps.openOwn();
    refresh();
  }
  function settled() { pendingTab = null; clearTimeout(pendingTimer); }

  els.menuBtn.addEventListener("click", function () { if (open) closeSide(); else openSide(els.menuBtn); });
  els.seg.addEventListener("click", function (ev) {
    var b = ev.target && ev.target.closest && ev.target.closest("[data-pb-tab]");
    if (b) setTab(b.getAttribute("data-pb-tab"));
  });
  els.seg.addEventListener("keydown", function (ev) {
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
    ev.preventDefault();
    setTab(tab() === "room" ? "private" : "room");
    var landed = els.seg.querySelector('[aria-selected="true"]');
    if (landed && landed.focus) landed.focus();
  });
  els.action.addEventListener("click", function (ev) {
    // The bell's panel closes on any click outside it: this click is the one that opens it.
    if (ev.stopPropagation) ev.stopPropagation();
    if (!phone || els.action.getAttribute("aria-disabled") === "true") return;
    if (els.action.getAttribute("data-action") === "bell") deps.actions.bell(els.action);
    else deps.startNew();
  });
  els.searchBtn.addEventListener("click", function () {
    searching = !searching;
    els.searchForm.classList.toggle("hidden", !searching);
    els.searchBtn.setAttribute("aria-expanded", searching ? "true" : "false");
    if (searching) { if (els.q.focus) els.q.focus(); }
    else { query = ""; els.q.value = ""; renderSearchResults(); }
  });
  els.searchForm.addEventListener("submit", function (ev) { if (ev.preventDefault) ev.preventDefault(); });
  els.q.addEventListener("input", function () { query = els.q.value; renderSearchResults(); });
  els.menu.addEventListener("click", function (ev) {
    var row = ev.target && ev.target.closest && ev.target.closest("[data-ps]");
    if (!row) return;
    var id = row.getAttribute("data-ps"), act = deps.actions[id];
    // The row is consumed here: a document-level "click outside" handler (the bell and pin panels close on one)
    // must not see the click that opens a panel from the sidebar.
    if (ev.stopPropagation) ev.stopPropagation();
    if (act) closeSide(function () { act(opener || els.menuBtn); });
  });
  els.primary.addEventListener("click", function () {
    if (els.primary.getAttribute("aria-disabled") === "true") return;
    var id = els.primary.getAttribute("data-ps-primary");
    if (id === "new") closeSide(function () { deps.startNew(); });
    else if (id === "create-room") closeSide(function () { deps.actions["create-room"](els.menuBtn); });
  });
  // Rows drawn by the sidebar itself (이전 대화, search results) and the rows private-channels.js draws in the list.
  [els.prev, els.results].forEach(function (area) {
    area.addEventListener("click", function (ev) {
      var t = ev.target && ev.target.closest && ev.target.closest("[data-ps-session],[data-ps-room]");
      if (!t) return;
      if (t.hasAttribute("data-ps-room")) { var rid = t.getAttribute("data-ps-room"); closeSide(function () { deps.openRoom(rid); }); return; }
      var raw = t.getAttribute("data-ps-session"), n = Number(raw);
      closeSide(function () { deps.switchSession(String(n) === raw ? n : raw); });
    });
  });
  els.list.addEventListener("click", function (ev) {
    var t = ev.target && ev.target.closest && ev.target.closest("[data-private-session],[data-private-admin-session]");
    if (t) closeSide();
  });
  els.scrim.addEventListener("click", function () { if (open) closeSide(); });
  if (typeof document !== "undefined") {
    // A menu or dialog above the sidebar takes the Escape first (it calls preventDefault).
    document.addEventListener("keydown", function (ev) { if (ev.key === "Escape" && open && !ev.defaultPrevented) closeSide(); });
  }

  // --- Empty-room suggestions and the running turn's progress -------------------------------
  var sugg = [];
  function renderSuggest() {
    var show = phone && tab() === "room" && hasRoom() && deps.isEmptyRoom && deps.isEmptyRoom();
    sugg = show ? suggestions({ posts: deps.getPosts ? deps.getPosts() : [] }) : [];
    els.suggest.classList.toggle("hidden", !sugg.length);
    setHtml(els.suggest, "suggest", sugg.map(function (s, i) {
      return '<button type="button" class="ai-sg-row" data-sg="' + i + '">' + icon(s.kind === "post" ? "results" : s.kind === "file" ? "file" : "spark", 20) +
        '<span class="ai-sg-text"><span class="ai-sg-title">' + e(s.title) + '</span><span class="ai-sg-sub">' + e(s.sub) + "</span></span></button>";
    }).join(""));
  }
  els.suggest.addEventListener("click", function (ev) {
    var b = ev.target && ev.target.closest && ev.target.closest("[data-sg]");
    var s = b ? sugg[Number(b.getAttribute("data-sg"))] : null;
    if (!s) return;
    if (s.kind === "post") deps.openPost(s.id);
    else if (s.kind === "file") deps.pickFile();
    else deps.fillInput(s.text);
  });
  function renderProgress() {
    var running = phone && deps.isRunning && deps.isRunning();
    els.progress.classList.toggle("hidden", !running);
    if (!running) { setHtml(els.progress, "progress", ""); return; }
    var p = progressView(deps.getStages ? deps.getStages() : []);
    setHtml(els.progress, "progress",
      '<span class="ai-pg-dots" aria-hidden="true">' + p.dots.map(function (d) { return '<i class="ai-pg-dot is-' + d.state + '"></i>'; }).join("") + "</span>" +
      '<span class="ai-pg-text">' + e(p.label) + '<small>' + p.done + " / " + p.total + "</small></span>");
    els.progress.setAttribute("aria-label", t("phoneNav.progressLabel", { done: p.done, total: p.total, label: p.label }));
  }

  // --- Keyboard (visualViewport) ------------------------------------------------------------
  function composerHeight() {
    var h = els.form && els.form.offsetHeight;
    els.layout.style.setProperty("--ai-composer-h", (h || 0) + "px");
  }
  function applyKeyboard() {
    var vv = win && win.visualViewport;
    var m = phone ? keyboardMetrics(win.innerHeight, vv) : { open: false };
    kb = m;
    els.layout.classList.toggle("is-kb-open", !!m.open);
    if (m.open) {
      els.layout.style.setProperty("--ai-vv-h", m.height + "px");
      els.layout.style.setProperty("--ai-vv-top", m.top + "px");
    } else {
      els.layout.style.removeProperty("--ai-vv-h");
      els.layout.style.removeProperty("--ai-vv-top");
    }
    composerHeight();
    if (m.open) {
      // The page itself must not be pushed up by the browser; the thread keeps its end in view above the composer.
      if (win.scrollTo) { try { win.scrollTo(0, 0); } catch (x) { /* not scrollable */ } }
      if (els.chat) els.chat.scrollTop = els.chat.scrollHeight;
    }
  }
  if (win && win.visualViewport && win.visualViewport.addEventListener) {
    win.visualViewport.addEventListener("resize", applyKeyboard);
    win.visualViewport.addEventListener("scroll", applyKeyboard);
  }

  // --- Phone width on or off ----------------------------------------------------------------
  function setPhone(next) {
    next = !!next;
    if (next === phone) return;
    phone = next;
    // Crossing the breakpoint live (a window resize, a tablet turned): the sidebar changes from a column to an off-canvas
    // drawer at once, with no slide, so a transition is never caught half way (a half-visible rail).
    els.layout.classList.add("is-vp-switch");
    clearTimeout(vpTimer);
    vpTimer = setTimeout(function () { els.layout.classList.remove("is-vp-switch"); }, 400);
    if (vpTimer && typeof vpTimer.unref === "function") vpTimer.unref();
    if (!phone && open) {
      if (histOpen && hist && typeof hist.back === "function") hist.back();   // popstate is ignored above 768px
      finishClose(false);
    }
    pendingTab = null;
    refresh();
    applyKeyboard();
  }
  if (mq && mq.addEventListener) mq.addEventListener("change", function (ev) { setPhone(ev.matches); });

  function refresh() {
    els.layout.classList.toggle("is-phone-nav", phone);
    renderBar();
    renderMenu();
    renderPrimary();
    renderContext();
    renderSearchResults();
    renderSuggest();
    renderProgress();
    syncSide();
    composerHeight();
  }
  refresh();
  onLangChange(refresh);

  return {
    isPhone: function () { return phone; },
    refresh: refresh,
    setTab: setTab,
    openSide: function () { openSide(els.menuBtn); },
    closeSide: function () { closeSide(); },
    getPhone: function () { return { active: phone, tab: tab() }; },
    getState: function () { return { phone: phone, open: open, tab: tab(), keyboard: kb.open === true, search: query }; },
    onSessionChanged: function () {
      var a = deps.getAccess ? deps.getAccess() : null;
      if (!pendingTab || pendingTab === (a && a.isPrivate ? "private" : "room")) settled();
      refresh();
    },
    onContextChanged: function () {
      var r = room();
      if (!r || pendingTab && String(r.id) !== String(pendingRoom)) settled();
      refresh();
    },
    applyKeyboard: applyKeyboard,
  };
}

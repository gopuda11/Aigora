// row-menus.js - DOM layer for the "⋯" menu on room and session rows: the
// trigger markup the rail renderers embed, one shared role="menu" popover, and
// a confirmation dialog. Who sees what lives in row-menus-model.js.
import { escapeHtml } from "../modules/escape-html.js";
import { t } from "./i18n.js";
import { archiveRoom } from "./room-admin-api.js";
import { ACTION_LABELS, roomMenuActions, sessionMenuActions, channelMenuActions, confirmCopy, menuKey, parseMenuKey } from "./row-menus-model.js";

export function initRowMenus(deps) {
  var els = deps.els;
  var openKey = null, openBtn = null, pending = null, dialogOpener = null;

  function find(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i] && String(list[i].id) === String(id)) return list[i];
    return null;
  }
  function roomOf(roomId) { return roomId == null ? null : find(deps.getRooms() || [], roomId); }

  // Resolve a "kind:id" key against live state; null when the row is gone or
  // the viewer may no longer act on it.
  function resolve(key) {
    var k = parseMenuKey(key), viewer = deps.getViewer();
    if (!k) return null;
    if (k.kind === "room") {
      var room = roomOf(k.id);
      var actions = roomMenuActions(room, viewer);
      return actions.length ? { kind: "room", id: room.id, name: room.name, actions: actions } : null;
    }
    if (k.kind === "channel") {
      var channel = deps.getChannel ? deps.getChannel(k.id) : null;
      var cActions = channel ? channelMenuActions(channel, roomOf(channel.roomId)) : [];
      return cActions.length ? { kind: "channel", id: channel.id, roomId: channel.roomId, name: channel.name || channel.label || t("rowMenus.privateChannel"), current: channel.name || "", actions: cActions } : null;
    }
    var session = find(deps.getSessions() || [], k.id);
    var sActions = session ? sessionMenuActions(session, viewer, roomOf(session.roomId)) : [];
    return sActions.length ? { kind: "session", id: session.id, name: session.title || "", current: session.title || "", actions: sActions } : null;
  }

  // Trigger markup for one row, "" when the viewer has no action on it.
  function html(kind, id) {
    var target = resolve(menuKey(kind, id));
    if (!target) return "";
    var key = menuKey(kind, id);
    return '<button type="button" class="ai-row-more" data-row-menu="' + escapeHtml(key) + '" aria-haspopup="menu" aria-expanded="' +
      (openKey === key ? "true" : "false") + '" aria-label="' + escapeHtml(t("rowMenus.menuOf", { name: target.name || t("rowMenus.untitledItem") })) + '" title="' + escapeHtml(t("rowMenus.more")) + '">⋯</button>';
  }

  function triggers(key) {
    var v = String(key);
    var esc = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(v) : v.replace(/["\\]/g, "\\$&");
    return els.root.querySelectorAll('[data-row-menu="' + esc + '"]');
  }
  function focusTrigger(key, preferred) {
    var cands = preferred && els.root.contains(preferred) ? [preferred] : [];
    triggers(key).forEach(function (b) { cands.push(b); });
    for (var i = 0; i < cands.length; i++) {
      cands[i].focus();
      if (els.root.ownerDocument.activeElement === cands[i]) return true;
    }
    return false;
  }

  // Focus the row's trigger if it is still there, else the rail container, so
  // focus never rests on a node that was removed or hidden.
  function restoreFocus(key, preferred) {
    if (focusTrigger(key, preferred)) return;
    var fb = els.fallback;
    if (!fb) return;
    if (!fb.hasAttribute("tabindex")) fb.setAttribute("tabindex", "-1");
    fb.focus();
  }

  function closeMenu(returnFocus) {
    if (openKey == null) return;
    var key = openKey, btn = openBtn;
    openKey = null;
    openBtn = null;
    els.menu.classList.add("hidden");
    els.menu.innerHTML = "";
    triggers(key).forEach(function (b) { b.setAttribute("aria-expanded", "false"); });
    if (returnFocus) restoreFocus(key, btn);
  }

  function place(btn) {
    if (!btn.getBoundingClientRect) return;
    var r = btn.getBoundingClientRect(), w = els.menu.offsetWidth || 0, h = els.menu.offsetHeight || 0;
    var vw = (typeof window !== "undefined" && window.innerWidth) || 0, vh = (typeof window !== "undefined" && window.innerHeight) || 0;
    var left = r.right - w, top = r.bottom + 4;
    if (vh && top + h > vh - 8) top = Math.max(8, r.top - h - 4);
    if (vw) left = Math.min(left, vw - w - 8);
    els.menu.style.left = Math.max(8, left) + "px";
    els.menu.style.top = top + "px";
  }

  function openMenu(btn) {
    var key = btn.getAttribute("data-row-menu"), target = resolve(key);
    if (!target) return;
    closeMenu(false);
    openKey = key;
    openBtn = btn;
    els.menu.setAttribute("aria-label", t("rowMenus.menuOf", { name: target.name || t("rowMenus.untitledItem") }));
    els.menu.innerHTML = target.actions.map(function (a) {
      return '<button type="button" role="menuitem" class="ai-row-menu-item is-' + a + '" data-row-action="' + a + '">' + escapeHtml(ACTION_LABELS[a]) + "</button>";
    }).join("");
    els.menu.classList.remove("hidden");
    triggers(key).forEach(function (b) { b.setAttribute("aria-expanded", "true"); });
    place(btn);
    var first = els.menu.querySelector("[role=menuitem]");
    if (first) first.focus();
  }

  function openDialog(action, target, opener) {
    var copy = confirmCopy(action, target.name);
    pending = { action: action, kind: target.kind, id: target.id, key: menuKey(target.kind, target.id) };
    dialogOpener = opener || null;
    els.dialogTitle.textContent = copy.title;
    els.dialogText.textContent = copy.text;
    els.confirm.textContent = copy.confirm;
    els.confirm.setAttribute("aria-label", copy.title + " " + copy.confirm);
    els.dialog.classList.remove("hidden");
    els.cancel.focus();
  }

  function closeDialog(returnFocus) {
    if (!pending) return;
    var key = pending.key, opener = dialogOpener;
    pending = null;
    dialogOpener = null;
    els.dialog.classList.add("hidden");
    if (returnFocus) restoreFocus(key, opener);
  }

  function runPending() {
    var job = pending;
    if (!job) return;
    var target = resolve(job.key), opener = dialogOpener;
    closeDialog(false);
    restoreFocus(job.key, opener);
    if (!target) return;
    if (job.action === "archive") {
      // The room list is re-read afterwards; settle focus again once it has
      // re-rendered, since an archived room's trigger is gone by then.
      archiveRoom(job.id).then(function (res) {
        if (res && res.ok === true) {
          deps.toast(t("rowMenus.archived"));
          return Promise.resolve(deps.onRoomsChanged && deps.onRoomsChanged()).then(function () { settleFocus(job.key); });
        }
        deps.toast(t("rowMenus.archiveFailed"));
      }, function () { deps.toast(t("rowMenus.archiveFailed")); });
      return;
    }
    if (deps.send({ type: "delete_session", id: job.id })) {
      // The row disappears when the server's session list arrives.
      var fb = els.fallback;
      if (fb) { if (!fb.hasAttribute("tabindex")) fb.setAttribute("tabindex", "-1"); fb.focus(); }
    } else deps.toast(t("rowMenus.deleteOffline"));
  }

  // Only act if focus was left on a node that no longer exists or is hidden.
  function settleFocus(key) {
    var doc = els.root.ownerDocument, a = doc.activeElement;
    if (a && a !== doc.body && a.offsetParent !== null && els.root.contains(a)) return;
    restoreFocus(key, null);
  }

  function onDocClick(ev) {
    var t = ev.target;
    var trigger = t && t.closest ? t.closest("[data-row-menu]") : null;
    if (trigger) {
      var again = openBtn === trigger;
      if (again) closeMenu(false); else openMenu(trigger);
      return;
    }
    var item = t && t.closest ? t.closest("[data-row-action]") : null;
    if (item && els.menu.contains(item)) {
      var key = openKey, btn = openBtn, target = key ? resolve(key) : null;
      var action = item.getAttribute("data-row-action");
      closeMenu(false);
      if (!target || target.actions.indexOf(action) === -1) return;
      if (action === "invite") { if (deps.onInvite) deps.onInvite(target.id, btn); return; }
      if (action === "rename") { if (deps.onRename) deps.onRename(target, btn, function () { restoreFocus(key, btn); }); return; }
      if (action === "close") { if (deps.onCloseChannel) deps.onCloseChannel(target, btn); return; }
      openDialog(action, target, btn);
      return;
    }
    if (els.dialog.contains(t) || t === els.dialog) {
      if (t === els.dialog || (t.closest && t.closest("[data-row-cancel]"))) closeDialog(true);
      else if (t.closest && t.closest("[data-row-confirm]")) runPending();
      return;
    }
    if (openKey != null && !els.menu.contains(t)) closeMenu(false);
  }

  function onDocKeydown(ev) {
    if (pending) {
      if (ev.key === "Escape") { ev.preventDefault(); closeDialog(true); return; }
      if (ev.key === "Tab") {
        ev.preventDefault();
        var doc = els.dialog.ownerDocument;
        (doc.activeElement === els.cancel ? els.confirm : els.cancel).focus();
      }
      return;
    }
    if (openKey == null) return;
    if (ev.key === "Escape") { ev.preventDefault(); closeMenu(true); return; }
    if (ev.key === "Tab") { ev.preventDefault(); closeMenu(true); return; }
    var move = ev.key === "ArrowDown" ? 1 : ev.key === "ArrowUp" ? -1 : ev.key === "Home" ? "first" : ev.key === "End" ? "last" : 0;
    if (!move) return;
    ev.preventDefault();
    var items = Array.prototype.slice.call(els.menu.querySelectorAll("[role=menuitem]"));
    if (!items.length) return;
    var at = items.indexOf(els.menu.ownerDocument.activeElement);
    var next = move === "first" ? 0 : move === "last" ? items.length - 1 : (at + move + items.length) % items.length;
    items[next].focus();
  }

  // The popover and dialog are siblings of the rails, so one pair of listeners
  // on their common root (the document body) serves all four rail containers.
  els.root.addEventListener("click", onDocClick);
  els.root.addEventListener("keydown", onDocKeydown);
  return { html: html, close: function () { closeMenu(false); closeDialog(false); } };
}

// account-menu.js - The account chip at the bottom of the sidebar and the
// role="menu" popover above it. Keyboard like the row menus: arrows / Home / End
// move, Escape and Tab close and return focus to the chip, a click outside
// closes without moving focus. What each item does is decided by the caller.
//
//   initAccountMenu({ actions: { settings(opener), rooms(opener), logout() } }) -> { setUser(user) }
// Two triggers share one menu: the sidebar chip (menu opens above it) and, on phones, an
// avatar button in the main column (menu opens below it, data-below="true").

import { accountMenuItems, displayNameOf, initialOf, roleLabel } from "./settings-model.js";

function h(tag, attrs, text) {
  var node = document.createElement(tag);
  Object.keys(attrs || {}).forEach(function (k) { node.setAttribute(k, attrs[k]); });
  if (text != null) node.textContent = text;
  return node;
}

export function initAccountMenu(deps) {
  var $ = function (id) { return document.getElementById(id); };
  var els = { wrap: $("ai-account"), btn: $("ai-account-btn"), mobile: $("ai-account-mobile"), menu: $("ai-account-menu"), avatar: $("ai-account-avatar"), name: $("ai-account-name"), role: $("ai-account-role") };
  var user = null, isOpen = false, openBtn = null;

  function items() { return Array.prototype.slice.call(els.menu.querySelectorAll("[role=menuitem]")); }

  function render() {
    els.menu.textContent = "";
    var head = h("div", { class: "ai-account-menu-head", role: "presentation" });
    head.appendChild(h("strong", {}, displayNameOf(user)));
    head.appendChild(h("small", {}, user.username || ""));
    els.menu.appendChild(head);
    accountMenuItems(user).forEach(function (it) {
      if (it.id === "separator") { els.menu.appendChild(h("div", { class: "ai-account-menu-sep", role: "separator" })); return; }
      els.menu.appendChild(h("button", { type: "button", role: "menuitem", class: "ai-account-menu-item" + (it.danger ? " is-danger" : ""), "data-account-action": it.id }, it.label));
    });
  }

  // Anchored to the trigger that opened it: above the sidebar chip, below the phone button.
  function place(btn) {
    if (!btn.getBoundingClientRect) return;
    var r = btn.getBoundingClientRect(), vw = window.innerWidth || 0, vh = window.innerHeight || 0, st = els.menu.style;
    if (btn === els.mobile) {
      st.top = r.bottom + 6 + "px"; st.right = Math.max(8, vw - r.right) + "px"; st.left = "auto"; st.bottom = "auto"; st.width = "224px";
    } else if (r.width < 160) {
      // The phone sidebar's avatar-only button: the menu opens above it, aligned to its right edge.
      st.right = Math.max(8, vw - r.right) + "px"; st.width = "224px"; st.bottom = Math.max(8, vh - r.top + 6) + "px"; st.top = "auto"; st.left = "auto";
    } else {
      st.left = r.left + "px"; st.width = r.width + "px"; st.bottom = Math.max(8, vh - r.top + 6) + "px"; st.top = "auto"; st.right = "auto";
    }
  }

  function setOpen(open, returnFocus, trigger) {
    if (open === isOpen) return;
    var btn = open ? trigger : openBtn;
    isOpen = open;
    openBtn = open ? trigger : null;
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    els.menu.classList.toggle("hidden", !open);
    if (open) {
      if (btn === els.mobile) els.menu.setAttribute("data-below", "true"); else els.menu.removeAttribute("data-below");
      render();
      place(btn);
      var first = items()[0];
      if (first) first.focus();
    } else {
      els.menu.textContent = "";
      if (returnFocus) btn.focus();
    }
  }

  function toggle(btn) { if (user) setOpen(!isOpen, true, btn); }
  [els.btn, els.mobile].forEach(function (btn) {
    btn.addEventListener("click", function () {
      if (isOpen && openBtn !== btn) setOpen(false, false);
      toggle(btn);
    });
    btn.addEventListener("keydown", function (ev) {
      if (!user || isOpen || (ev.key !== "ArrowUp" && ev.key !== "ArrowDown")) return;
      ev.preventDefault();
      setOpen(true, false, btn);
    });
  });

  els.menu.addEventListener("click", function (ev) {
    var item = ev.target && ev.target.closest ? ev.target.closest("[data-account-action]") : null;
    if (!item) return;
    var action = item.getAttribute("data-account-action");
    var opener = openBtn;
    setOpen(false, false);
    if (deps.actions[action]) deps.actions[action](opener);
  });

  els.menu.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape" || ev.key === "Tab") { ev.preventDefault(); setOpen(false, true); return; }
    var move = ev.key === "ArrowDown" ? 1 : ev.key === "ArrowUp" ? -1 : ev.key === "Home" ? "first" : ev.key === "End" ? "last" : 0;
    if (!move) return;
    ev.preventDefault();
    var list = items();
    if (!list.length) return;
    var at = list.indexOf(document.activeElement);
    list[move === "first" ? 0 : move === "last" ? list.length - 1 : (at + move + list.length) % list.length].focus();
  });

  document.addEventListener("click", function (ev) {
    if (isOpen && !els.wrap.contains(ev.target) && !els.mobile.contains(ev.target) && !els.menu.contains(ev.target)) setOpen(false, false);
  });

  return {
    setUser: function (next) {
      user = next && next.id != null ? next : null;
      els.wrap.classList.toggle("hidden", !user);
      els.mobile.classList.toggle("hidden", !user);
      if (!user) { setOpen(false, false); return; }
      els.avatar.textContent = initialOf(user);
      els.mobile.textContent = initialOf(user);
      els.name.textContent = displayNameOf(user);
      els.role.textContent = roleLabel(user.role);
    },
  };
}

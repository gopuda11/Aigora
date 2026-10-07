// menu-button.js - Disclosure behaviour for a button that opens a role="menu"
// popup (the composer "+" menu). Keeps aria-expanded in step with the popup's
// visibility on every path that opens or closes it, and gives keyboard users
// Escape, arrow-key roving and focus return.
//
//   initMenuButton({ button, menu, onSelect })
//     button   - the trigger (carries aria-haspopup / aria-controls)
//     menu     - the popup; hidden through the "hidden" class
//     onSelect - called with each chosen menuitem's element after the menu closes

export function initMenuButton(opts) {
  var btn = opts.button;
  var menu = opts.menu;
  var onSelect = opts.onSelect;

  function isOpen() { return !menu.classList.contains("hidden"); }

  function items() {
    return Array.prototype.slice.call(menu.querySelectorAll('[role="menuitem"]'));
  }

  function focusWithin() {
    var a = document.activeElement;
    return !!a && (a === btn || menu.contains(a));
  }

  function setOpen(open, o) {
    var restore = !open && !!(o && o.restoreFocus) && focusWithin();
    menu.classList.toggle("hidden", !open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    if (open && o && o.focusFirst) {
      var first = items()[0];
      if (first) first.focus();
    }
    if (restore) btn.focus();
  }

  function move(step) {
    var list = items();
    if (!list.length) return;
    var at = list.indexOf(document.activeElement);
    var next = step === "first" ? 0 : step === "last" ? list.length - 1
      : (at + step + list.length) % list.length;
    list[next].focus();
  }

  menu.addEventListener("click", function (e) {
    var item = e.target.closest && e.target.closest('[role="menuitem"]');
    if (!item) return;
    setOpen(false, { restoreFocus: true });
    if (onSelect) onSelect(item);
  });

  menu.addEventListener("keydown", function (e) {
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Home") { e.preventDefault(); move("first"); }
    else if (e.key === "End") { e.preventDefault(); move("last"); }
    else if (e.key === "Tab") setOpen(false);
  });

  btn.addEventListener("keydown", function (e) {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true, { focusFirst: true }); }
  });

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape" || !isOpen()) return;
    e.stopPropagation();
    setOpen(false, { restoreFocus: true });
  }, true);

  document.addEventListener("click", function (e) {
    if (isOpen() && !menu.contains(e.target) && !btn.contains(e.target)) setOpen(false);
  });

  return {
    isOpen: isOpen,
    close: function (o) { setOpen(false, o); },
    // A click with detail 0 came from the keyboard (Enter/Space): move focus
    // into the menu so it is usable without a pointer.
    toggle: function (e) { setOpen(!isOpen(), { focusFirst: !!e && e.detail === 0 }); },
  };
}

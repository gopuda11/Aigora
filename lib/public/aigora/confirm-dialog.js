// confirm-dialog.js - the one small in-page confirmation (not the browser prompt): a title, a sentence,
// 취소 and a danger button. Esc and the scrim cancel, Tab stays inside, focus starts on 취소 and
// returns to the opener. The caller owns the wording and what confirming does.
//
//   open({ title, text, confirmLabel, cancelLabel, restore, onConfirm() -> Promise<true | "message"> | true | "message" })
//
// onConfirm resolving true closes; a string is shown as the error and keeps the dialog open.

export function initConfirmDialog(els) {
  var job = null;

  function say(text) { els.msg.textContent = text || ""; els.msg.classList.toggle("is-error", !!text); els.msg.setAttribute("role", text ? "alert" : "status"); }
  function busy(on) { els.ok.disabled = on; els.cancel.disabled = on; }
  function close(returnFocus) {
    if (!job) return;
    var restore = job.restore;
    job = null;
    busy(false);
    els.root.classList.add("hidden");
    if (returnFocus && restore) restore();
  }
  function open(opts) {
    close(false);
    job = { onConfirm: opts.onConfirm, restore: opts.restore || null, pending: false };
    els.title.textContent = opts.title;
    els.text.textContent = opts.text || "";
    els.ok.textContent = opts.confirmLabel;
    els.cancel.textContent = opts.cancelLabel;
    say("");
    busy(false);
    els.root.classList.remove("hidden");
    els.cancel.focus();
  }
  function accept() {
    if (!job || job.pending) return;
    var mine = job;
    mine.pending = true;
    busy(true);
    Promise.resolve().then(function () { return mine.onConfirm(); }).then(function (result) {
      if (job !== mine) return;
      mine.pending = false;
      if (result === true) return close(true);
      busy(false);
      say(typeof result === "string" ? result : "");
    }, function () {
      if (job !== mine) return;
      mine.pending = false;
      busy(false);
    });
  }

  els.root.addEventListener("click", function (ev) {
    var t = ev.target;
    if (job && job.pending) return;
    if (t === els.root || (t.closest && t.closest("[data-confirm-cancel]"))) close(true);
    else if (t.closest && t.closest("[data-confirm-ok]")) accept();
  });
  els.root.addEventListener("keydown", function (ev) {
    if (!job) return;
    if (ev.key === "Escape") { ev.preventDefault(); if (!job.pending) close(true); return; }
    if (ev.key === "Tab") {
      var ring = [els.cancel, els.ok], at = ring.indexOf(els.root.ownerDocument.activeElement);
      ev.preventDefault();
      ring[(at + (ev.shiftKey ? ring.length - 1 : 1) + ring.length) % ring.length].focus();
    }
  });

  return { open: open, close: function () { close(false); }, isOpen: function () { return !!job; } };
}

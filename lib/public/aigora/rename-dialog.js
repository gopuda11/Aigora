// rename-dialog.js - the one small dialog that renames a session (row menu 이름 변경) or the
// viewer's 나만의 채널 (desktop row menu, phone list header). Prefilled name, Enter saves,
// Esc cancels, Tab stays inside, focus returns to the opener. Who may rename and the server
// message are the callers' business; this only collects a valid name.
//
//   open({ title, value, min, max, hint, onSave(name) -> true | false | "message", restore })
//
// onSave returning true closes; a string is shown as the error and keeps the dialog open;
// false means the socket was gone.

import { t } from "./i18n.js";

function size(text) { return Array.from(text).length; }

export function initRenameDialog(els) {
  var job = null;

  function say(text, isError) {
    els.msg.textContent = text || "";
    els.msg.classList.toggle("is-error", !!isError);
    els.msg.setAttribute("role", isError ? "alert" : "status");
    if (els.input) { if (isError) els.input.setAttribute("aria-invalid", "true"); else els.input.removeAttribute("aria-invalid"); }
  }
  function close(returnFocus) {
    if (!job) return;
    var restore = job.restore;
    job = null;
    els.root.classList.add("hidden");
    if (returnFocus && restore) restore();
  }
  function open(opts) {
    close(false);
    job = { onSave: opts.onSave, restore: opts.restore || null, min: opts.min == null ? 1 : opts.min, max: opts.max || 60, value: String(opts.value == null ? "" : opts.value), hint: opts.hint || "" };
    els.title.textContent = opts.title;
    els.input.value = job.value;
    els.input.setAttribute("maxlength", String(job.max));
    els.input.setAttribute("aria-label", opts.title);
    say(job.hint, false);
    els.root.classList.remove("hidden");
    els.input.focus();
    if (els.input.select) els.input.select();
  }
  function save() {
    if (!job) return;
    var name = els.input.value.trim();
    if (size(name) < job.min) return say(t("renameDialog.nameRequired"), true);
    if (size(name) > job.max) return say(t("renameDialog.nameTooLong", { max: job.max }), true);
    if (name === job.value.trim()) return close(true);
    var result = job.onSave(name);
    if (result === true) return close(true);
    say(typeof result === "string" ? result : t("renameDialog.saveLost"), true);
  }

  els.root.addEventListener("click", function (ev) {
    var t = ev.target;
    if (t === els.root || (t.closest && t.closest("[data-rename-cancel]"))) close(true);
    else if (t.closest && t.closest("[data-rename-save]")) save();
  });
  els.root.addEventListener("keydown", function (ev) {
    if (!job) return;
    if (ev.key === "Escape") { ev.preventDefault(); close(true); return; }
    if (ev.key === "Enter" && ev.target === els.input && !ev.isComposing && ev.keyCode !== 229) { ev.preventDefault(); save(); return; }
    if (ev.key === "Tab") {
      var ring = [els.input, els.cancel, els.save], at = ring.indexOf(els.root.ownerDocument.activeElement);
      ev.preventDefault();
      ring[(at + (ev.shiftKey ? ring.length - 1 : 1) + ring.length) % ring.length].focus();
    }
  });
  els.input.addEventListener("input", function () { if (job) say(job.hint, false); });

  return { open: open, close: function () { close(false); }, isOpen: function () { return !!job; } };
}

// clipboard.js - Copy plain text: the async Clipboard API where the page may use it (https, a user gesture),
// else a hidden textarea and document.execCommand("copy") (non-secure contexts, older WebViews).
// Resolves true when the text was handed to the clipboard, false when neither route worked.

export function copyText(text) {
  var value = String(text == null ? "" : text);
  var nav = typeof navigator !== "undefined" ? navigator : null;

  function viaTextarea() {
    var ok = false;
    var ta = null;
    var prev = document.activeElement;
    try {
      ta = document.createElement("textarea");
      ta.value = value;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
      document.body.appendChild(ta);
      if (ta.focus) ta.focus();
      if (ta.select) ta.select();
      if (ta.setSelectionRange) ta.setSelectionRange(0, value.length);
      ok = !!document.execCommand("copy");
    } catch (_) { ok = false; }
    if (ta && ta.parentNode) ta.parentNode.removeChild(ta);
    if (prev && prev.focus) prev.focus();
    return ok;
  }

  if (nav && nav.clipboard && typeof nav.clipboard.writeText === "function") {
    try {
      return Promise.resolve(nav.clipboard.writeText(value)).then(function () { return true; }, viaTextarea);
    } catch (_) { /* fall through to the textarea route */ }
  }
  return Promise.resolve(viaTextarea());
}

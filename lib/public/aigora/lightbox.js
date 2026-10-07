// lightbox.js - full-size view of a message thumbnail. Any element carrying
// data-lightbox="<src>" (and data-alt) opens it. Esc, the close button, a tap on
// the backdrop and a swipe all close it; focus moves into the dialog and goes
// back to the thumbnail. The src was already vetted by thumbsHtml (our own image
// routes or data: URLs); nothing here fetches or trusts anything else.

import { t } from "./i18n.js";

var SWIPE_PX = 60;

export function initLightbox(doc) {
  var overlay = null, opener = null, startX = 0, startY = 0;

  function close() {
    if (!overlay) return;
    var o = overlay;
    overlay = null;
    if (o.parentNode) o.parentNode.removeChild(o);
    if (opener && typeof opener.focus === "function") opener.focus();
    opener = null;
  }

  function open(src, alt, from) {
    close();
    opener = from || null;
    overlay = doc.createElement("div");
    overlay.className = "lightbox";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", alt || t("lightbox.viewImage"));
    var img = doc.createElement("img");
    img.className = "lightbox-img";
    img.setAttribute("src", src);
    img.setAttribute("alt", alt || t("lightbox.attachedImage"));
    var btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "lightbox-close";
    btn.setAttribute("aria-label", t("lightbox.close"));
    btn.textContent = "×";
    btn.addEventListener("click", function (ev) { if (ev.stopPropagation) ev.stopPropagation(); close(); });
    overlay.appendChild(img);
    overlay.appendChild(btn);
    overlay.addEventListener("click", function (ev) { if (ev.target !== img) close(); });
    overlay.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") { if (ev.preventDefault) ev.preventDefault(); close(); }
      else if (ev.key === "Tab") { if (ev.preventDefault) ev.preventDefault(); btn.focus(); }   // the close button is the only stop
    });
    overlay.addEventListener("touchstart", function (ev) {
      var t = ev.touches && ev.touches[0];
      if (t) { startX = t.clientX; startY = t.clientY; }
    });
    overlay.addEventListener("touchend", function (ev) {
      var t = ev.changedTouches && ev.changedTouches[0];
      if (t && (Math.abs(t.clientX - startX) > SWIPE_PX || Math.abs(t.clientY - startY) > SWIPE_PX)) close();
    });
    doc.body.appendChild(overlay);
    btn.focus();
  }

  doc.addEventListener("click", function (ev) {
    var el = ev.target;
    while (el && !(el.getAttribute && el.getAttribute("data-lightbox"))) el = el.parentNode;
    if (!el) return;
    if (ev.preventDefault) ev.preventDefault();
    open(el.getAttribute("data-lightbox"), el.getAttribute("data-alt") || "", el);
  });

  return { open: open, close: close, isOpen: function () { return !!overlay; } };
}

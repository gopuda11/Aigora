// office-host.js - runs inside the editor frame (the host page served by lib/project-office.js).
// Fetches this user's signed editor config, starts ONLYOFFICE's DocsAPI in it (mobile layout on
// phones) and reports state to the Aigora overlay via postMessage. A classic script, no imports:
// the host page's CSP allows only same-origin scripts.
(function () {
  var body = document.body;
  var msg = document.getElementById("msg");
  // A classic script (no imports, CSP), so it carries its own ko/en pair and follows the overlay's <html lang>.
  var TEXT = {
    unavailable: { ko: "문서 편집기를 사용할 수 없어요. 관리자에게 문의하세요", en: "The document editor isn't available. Please contact an administrator." },
    unsupported: { ko: "이 형식은 함께 편집할 수 없어요. 다운로드해서 열어 주세요.", en: "This format can't be edited together. Please download it and open it." },
    notFound: { ko: "문서를 찾을 수 없어요.", en: "The document wasn't found." },
    cannotOpen: { ko: "문서를 열 수 없어요.", en: "The document can't be opened." },
    offline: { ko: "연결이 끊겼어요. 다시 시도해 주세요.", en: "The connection was lost. Please try again." },
  };
  function tr(key) {
    var en = false;
    try { en = window.parent.document.documentElement.getAttribute("lang") === "en"; } catch (_) { /* standalone */ }
    return TEXT[key][en ? "en" : "ko"];
  }

  function say(text) { msg.textContent = text; msg.hidden = false; }
  function tell(type, extra) {
    window.officeState = type; // read by the integration test's headless browser
    try { window.parent.postMessage(Object.assign({ aigoraOffice: true, type: type }, extra || {}), window.location.origin); } catch (_) { /* standalone */ }
  }
  function fail(code, text) { say(text); tell("error", { code: code, message: text }); }

  // ONLYOFFICE's mobile layout (?m=1, or a narrow window without ?m) is view-only in the free Community build
  // ("무료 커뮤니티 버전을 사용하는 경우 열린 파일만 볼 수 있습니다"), so it is requested as a view session; ?m=0 is the
  // desktop layout with editing, which the overlay offers on phones as "편집".
  var m = /[?&]m=([01])\b/.exec(window.location.search);
  var mobile = m ? m[1] === "1" : window.innerWidth <= 768;
  // A phone in the desktop layout (editing): the server adds the phone customization, with the Aigora theme.
  var phone = !mobile && window.innerWidth <= 768;
  function darkTheme() {
    try {
      var t = window.parent.document.documentElement.getAttribute("data-theme"); // same origin as the overlay
      if (t === "dark" || t === "light") return t === "dark";
    } catch (_) { /* standalone */ }
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }
  fetch(body.getAttribute("data-config"), {
    method: "POST", credentials: "same-origin", headers: { "X-Requested-With": "aigora", "Content-Type": "application/json" }, body: JSON.stringify(phone ? { view: mobile, phone: true, dark: darkTheme() } : { view: mobile }),
  }).then(function (res) {
    return res.json().then(function (b) { return { ok: res.ok, status: res.status, body: b || {} }; }, function () { return { ok: res.ok, status: res.status, body: {} }; });
  }).then(function (r) {
    if (!r.ok) {
      var text = r.body.message || (r.status === 415 ? tr("unsupported") : r.status === 404 ? tr("notFound") : tr("cannotOpen"));
      return fail(r.body.error || "failed", text);
    }
    if (typeof window.DocsAPI === "undefined") return fail("office_unavailable", tr("unavailable"));
    var cfg = r.body.config;
    cfg.width = "100%";
    cfg.height = "100%";
    cfg.type = mobile ? "mobile" : "desktop";
    // DS lets a zoom it stored earlier (a pinch, or the view settings) win over customization.zoom. The editor frame is
    // same origin with this page (proxied), so on a phone that stored zoom is dropped and the config's zoom applies.
    if (phone) {
      try { ["de", "pe", "sse"].forEach(function (a) { ["settings", "last"].forEach(function (k) { window.localStorage.removeItem(a + "-" + k + "-zoom"); }); }); } catch (_) { /* storage blocked */ }
    }
    cfg.events = {
      onAppReady: function () { tell("app"); },
      onDocumentReady: function () { msg.hidden = true; tell("ready", { mode: r.body.mode }); },
      onError: function (e) { tell("error", { code: "editor_error", message: e && e.data && e.data.errorDescription || "" }); },
    };
    try { window.editor = new window.DocsAPI.DocEditor("ed", cfg); } catch (_) { fail("office_unavailable", tr("unavailable")); }
  }, function () { fail("network", tr("offline")); });

  // "내 위치로": bring the caret into view. DS 9.3 has no scroll-to-caret call and its resize does not scroll (verified):
  // grabFocus only focuses the editor's text input. The editor frame is same origin (served through the proxy), so the
  // caret element (#id_target_cursor) is measured against the page view (#id_main_view) and DS's own wheel handler is
  // driven with legacy "mousewheel" events (about 45px each), which scrolls without touching the caret or selection.
  var WHEEL_PX = 45, CARET_PAD = 24;
  function editorDoc() {
    try { var f = document.querySelector("iframe[name=frameEditor]"); return f && f.contentDocument; } catch (_) { return null; }
  }
  function wheel(d, target, dx, dy) {
    var ev = new d.defaultView.Event("mousewheel", { bubbles: true, cancelable: true });
    var props = { wheelDelta: dy ? (dy > 0 ? -120 : 120) : (dx > 0 ? -120 : 120), wheelDeltaX: dx ? (dx > 0 ? -120 : 120) : 0, wheelDeltaY: dy ? (dy > 0 ? -120 : 120) : 0, deltaX: dx ? Math.sign(dx) * 100 : 0, deltaY: dy ? Math.sign(dy) * 100 : 0, axis: dx && !dy ? 1 : 2, HORIZONTAL_AXIS: 1 };
    Object.keys(props).forEach(function (k) { Object.defineProperty(ev, k, { value: props[k] }); });
    target.dispatchEvent(ev);
  }
  function keepCaretVisible(tries) {
    var d = editorDoc();
    var cur = d && d.getElementById("id_target_cursor"), view = d && d.getElementById("id_main_view"), target = d && d.getElementById("id_viewer_overlay");
    if (!cur || !view || !target || cur.style.display === "none") return; // no caret (a selection, or still loading)
    var c = cur.getBoundingClientRect(), v = view.getBoundingClientRect();
    if (!c.height || !v.height) return;
    var dy = c.bottom > v.bottom - CARET_PAD ? c.bottom - (v.bottom - CARET_PAD) : c.top < v.top + CARET_PAD ? c.top - (v.top + CARET_PAD) : 0;
    var dx = c.right > v.right - CARET_PAD ? c.right - (v.right - CARET_PAD) : c.left < v.left + CARET_PAD ? c.left - (v.left + CARET_PAD) : 0;
    if (!dx && !dy) return;
    var n = Math.min(12, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / WHEEL_PX));
    for (var i = 0; i < n; i++) { if (dy) wheel(d, target, 0, dy); if (dx) wheel(d, target, dx, 0); }
    if (tries > 0) setTimeout(function () { keepCaretVisible(tries - 1); }, 40);
  }
  window.addEventListener("message", function (ev) {
    var d = ev.data;
    if (ev.origin !== window.location.origin || ev.source !== window.parent || !d || d.aigoraOffice !== true || d.type !== "locate") return;
    try { if (window.editor && window.editor.grabFocus) window.editor.grabFocus(); } catch (_) { /* editor not ready */ }
    setTimeout(function () { keepCaretVisible(30); }, 250); // after DS has laid itself out in the resized frame
  });
})();

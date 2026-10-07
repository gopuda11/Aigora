// social.js - DOM controller for Aigora room comments, pins and comment
// notifications. State and markup live in social-model.js; this file only
// wires clicks and forms to WebSocket messages and keeps typing focus stable
// across chat re-renders.

import { copyText } from "./clipboard.js";
import { t, onLangChange } from "./i18n.js";
import {
  createSocialState, resetForSession, applySocialMessage, markNotifRead, badgeCount, pendingApprovals, metaHtml, actionSheetHtml, pinPopHtml, notifPopHtml, anchorKey,
} from "./social-model.js";

/**
 * deps: { send(obj)->bool, getRoomRole()->role|null, getMyId(), getSessionId(),
 *         switchSession(id), rerender(), toast(text),
 *         els: { chat, pinBtn, notifBtn, dot, popPin, popNotif, tools } }
 */
export function initSocial(deps) {
  var st = createSocialState();
  var els = deps.els;
  var pendingGoto = null;

  function view() {
    var role = deps.getRoomRole();
    return { canWrite: role === "owner" || role === "member", isOwner: role === "owner", isAdmin: !!(deps.isAdmin && deps.isAdmin()), myId: deps.getMyId(), now: Date.now(), coach: deps.coachInfo };
  }

  var texts = {};   // message id -> the text its 복사 button copies (plain text; the markdown source for an AI answer)

  function extra(item) {
    if (item && item.mid && typeof item.text === "string") texts[item.mid] = item.text;
    return metaHtml(st, item, view());
  }

  // Copy, then say so in the button, in the live region and (on failure) in a toast.
  function copyWithFeedback(btn, text) {
    if (!text) return;
    copyText(text).then(function (ok) {
      if (deps.announce) deps.announce(ok ? t("social.copied") : t("social.copyFailed"));
      if (!ok) { deps.toast(t("social.copyFailedHint")); return; }
      var label = btn.querySelector ? btn.querySelector("span") : null;
      var before = label ? label.textContent : "";   // icon-only buttons just take the is-copied colour
      if (label) label.textContent = t("social.copied");
      btn.classList.add("is-copied");
      var timer = setTimeout(function () { if (label) label.textContent = before; btn.classList.remove("is-copied"); }, 1500);
      if (timer && typeof timer.unref === "function") timer.unref();
    });
  }

  function request() {
    if (deps.getSessionId() != null) deps.send({ type: "social_get" });
  }

  function popOpen(pop) { return !pop.classList.contains("hidden"); }

  function renderTools() {
    var pending = pendingApprovals(st).length, badge = badgeCount(st);
    var show = (deps.getRoomRole() != null && deps.getSessionId() != null) || st.approvals.length > 0;
    els.tools.classList.toggle("hidden", !show);
    els.dot.textContent = badge > 99 ? "99+" : String(badge);
    els.dot.classList.toggle("hidden", !badge);
    els.notifBtn.setAttribute("aria-label", badge ? (pending ? t("social.notifBtnPending", { count: badge, pending: pending }) : t("social.notifBtnUnread", { count: badge })) : t("social.notifHeading"));
    if (popOpen(els.popNotif)) els.popNotif.innerHTML = notifPopHtml(st, view());
    if (popOpen(els.popPin)) els.popPin.innerHTML = pinPopHtml(st, view());
    if (deps.onTools) deps.onTools({ badge: badge, pending: pending });
  }

  function closePops(except) {
    [[els.notifBtn, els.popNotif], [els.pinBtn, els.popPin]].forEach(function (p) {
      if (p[1] === except) return;
      p[1].classList.add("hidden");
      p[0].setAttribute("aria-expanded", "false");
    });
  }

  function togglePop(btn, pop, html) {
    var open = !popOpen(pop);
    closePops(open ? pop : null);
    pop.classList.toggle("hidden", !open);
    btn.setAttribute("aria-expanded", String(open));
    if (open) pop.innerHTML = html();
  }

  // Keep the comment box focused (and its caret) when the chat is re-rendered.
  function captureFocus() {
    var a = document.activeElement;
    var box = a && els.chat.contains(a) && a.closest ? a.closest("[data-thread-key]") : null;
    if (!box) return function () {};
    var key = box.getAttribute("data-thread-key");
    var start = a.selectionStart;
    var end = a.selectionEnd;
    return function () {
      var boxes = els.chat.querySelectorAll("[data-thread-key]");
      for (var i = 0; i < boxes.length; i++) {
        if (boxes[i].getAttribute("data-thread-key") === key) {
          var input = boxes[i].querySelector("input");
          if (input) {
            input.focus();
            if (typeof start === "number" && input.setSelectionRange) input.setSelectionRange(start, end);
          }
          return;
        }
      }
    };
  }

  function findAnchor(mid, att) {
    var nodes = els.chat.querySelectorAll("[data-social-comment]");
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.getAttribute("data-social-comment") === mid && (n.getAttribute("data-att") == null ? att == null : String(att) === n.getAttribute("data-att"))) return n;
    }
    return null;
  }

  function goto(mid, sessionId, opts) {
    if (!mid) return;
    var att = opts && opts.att != null ? opts.att : null;
    if (sessionId && String(sessionId) !== String(deps.getSessionId())) {
      pendingGoto = { mid: mid, open: !!(opts && opts.open), att: att };
      deps.switchSession(isNaN(Number(sessionId)) ? sessionId : Number(sessionId));
      return;
    }
    revealMessage(mid, opts && opts.open, att);
  }

  function revealMessage(mid, openThread, att) {
    var node = findAnchor(mid, att);
    if (!node) { deps.toast(t("social.messageNotFound")); return; }
    if (openThread) { st.open[anchorKey(mid, att)] = true; deps.rerender(); node = findAnchor(mid, att) || node; }
    var article = node.closest ? node.closest(".message") : null;
    (article || node).scrollIntoView({ block: "center", behavior: "smooth" });
    if (article) {
      article.classList.add("is-flash");
      setTimeout(function () { article.classList.remove("is-flash"); }, 1600);
    }
  }

  function handle(msg) {
    if (!msg || typeof msg.type !== "string") return false;
    switch (msg.type) {
      case "social_error":
        deps.toast(msg.text || t("social.requestFailed"));
        return true;
      case "social_state":
      case "comment_event":
      case "pin_event":
      case "social_notif":
      case "notif_state":
        if (applySocialMessage(st, msg)) {
          deps.rerender();
          renderTools();
        }
        if (msg.type === "social_state" && pendingGoto) {
          var g = pendingGoto; pendingGoto = null;
          revealMessage(g.mid, g.open, g.att);
        }
        if (msg.type === "social_notif" && msg.notif && msg.notif.actorId !== deps.getMyId() && st.prefs.inApp) {
          deps.toast(t(msg.notif.kind === "mention" ? "social.toastMentioned" : "social.toastCommented", { name: msg.notif.actorName || t("social.someone") }));
        }
        return true;
      case "notifications_state":
      case "notification_created":
      case "notification_updated":
      case "notification_dismissed": {
        var before = st.approvals.length;
        if (applySocialMessage(st, msg)) {
          renderTools();
          if (msg.type === "notification_created" && st.approvals.length > before && deps.announce) {
            var m = msg.notification.meta;
            deps.announce(t("social.announceApproval", { requester: m.requesterName || "", room: m.roomName || "", tool: m.toolName || "" }) + (deps.isAdmin && deps.isAdmin() ? t("social.announceChoose") : t("social.announceWait")));
          }
        }
        return true; // the console's other notification kinds are not shown here, and nobody else needs these frames
      }
      default:
        return false;
    }
  }

  // The push click and "?approvals=1" land here: show the bell panel.
  function openApprovals() {
    renderTools();
    closePops(els.popNotif);
    els.popNotif.classList.remove("hidden");
    els.notifBtn.setAttribute("aria-expanded", "true");
    els.popNotif.innerHTML = notifPopHtml(st, view());
  }

  function onSessionChanged(sessionId) {
    resetForSession(st, sessionId);
    deps.rerender();
    renderTools();
    request();
  }

  function attrAtt(el) {
    var v = el.getAttribute("data-att");
    return v == null ? null : Number(v);
  }

  els.chat.addEventListener("click", function (ev) {
    var t = ev.target && ev.target.closest ? ev.target : null;
    if (!t) return;
    var btn;
    if ((btn = t.closest("[data-social-comment]"))) {
      var key = anchorKey(btn.getAttribute("data-social-comment"), attrAtt(btn));
      st.open[key] = !st.open[key];
      deps.rerender();
      if (st.open[key]) {
        var thread = els.chat.querySelector('[data-thread-key="' + key + '"]');
        var box = thread ? thread.querySelector("input") : null;
        if (box) box.focus();
      }
    } else if ((btn = t.closest("[data-social-copy]"))) {
      copyWithFeedback(btn, texts[btn.getAttribute("data-social-copy")]);
    } else if ((btn = t.closest("[data-copy-code]"))) {
      var block = btn.closest(".ai-code");
      var codeEl = block ? block.querySelector("code") : null;
      copyWithFeedback(btn, codeEl ? codeEl.textContent : "");
    } else if ((btn = t.closest("[data-social-pin]"))) {
      if (btn.disabled) return;
      var pinId = btn.getAttribute("data-pin-id");
      if (pinId) deps.send({ type: "pin_remove", id: pinId });
      else deps.send({ type: "pin_add", mid: btn.getAttribute("data-social-pin"), attachment: attrAtt(btn), kind: btn.getAttribute("data-kind"), title: btn.getAttribute("data-title") });
    } else if ((btn = t.closest("[data-social-delete]"))) {
      deps.send({ type: "comment_delete", id: btn.getAttribute("data-social-delete") });
    } else if ((btn = t.closest("[data-social-edit]"))) {
      st.editing = btn.getAttribute("data-social-edit");
      st.editDraft = null;
      deps.rerender();
      var ei = els.chat.querySelector("[data-social-edit-form] input");
      if (ei) ei.focus();
    } else if (t.closest("[data-social-edit-cancel]")) {
      st.editing = null;
      st.editDraft = null;
      deps.rerender();
    }
  });

  els.chat.addEventListener("submit", function (ev) {
    var form = ev.target;
    if (!form || !form.getAttribute) return;
    var input = form.querySelector ? form.querySelector("input") : null;
    if (form.getAttribute("data-social-form") != null) {
      ev.preventDefault();
      var text = input ? input.value.trim() : "";
      if (!text) return;
      var mid = form.getAttribute("data-social-form");
      var a = attrAtt(form);
      if (deps.send({ type: "comment_add", mid: mid, attachment: a, text: text })) {
        delete st.drafts[anchorKey(mid, a)];
        input.value = "";
        var sb = form.querySelector(".ai-reply-send");
        if (sb) sb.disabled = true;
      } else {
        deps.toast(t("social.toastCommentLost"));
      }
    } else if (form.getAttribute("data-social-edit-form") != null) {
      ev.preventDefault();
      var edited = input ? input.value.trim() : "";
      if (edited) deps.send({ type: "comment_edit", id: form.getAttribute("data-social-edit-form"), text: edited });
      st.editing = null;
      st.editDraft = null;
      deps.rerender();
    }
  });

  els.chat.addEventListener("input", function (ev) {
    var editForm = ev.target && ev.target.closest ? ev.target.closest("[data-social-edit-form]") : null;
    if (editForm) { st.editDraft = ev.target.value; return; }
    var form = ev.target && ev.target.closest ? ev.target.closest("[data-social-form]") : null;
    if (!form) return;
    var key = anchorKey(form.getAttribute("data-social-form"), attrAtt(form));
    st.drafts[key] = ev.target.value;
    var sb = form.querySelector(".ai-reply-send");
    if (sb) sb.disabled = !ev.target.value.trim();
  });

  els.notifBtn.addEventListener("click", function (ev) { ev.stopPropagation(); togglePop(els.notifBtn, els.popNotif, function () { return notifPopHtml(st, view()); }); });
  els.pinBtn.addEventListener("click", function (ev) { ev.stopPropagation(); togglePop(els.pinBtn, els.popPin, function () { return pinPopHtml(st, view()); }); });
  document.addEventListener("click", function (ev) {
    if (ev.target && ev.target.closest && ev.target.closest(".ai-pop, #ai-social-tools")) return;
    closePops(null);
  });
  document.addEventListener("keydown", function (ev) { if (ev.key === "Escape") closePops(null); });

  els.popNotif.addEventListener("click", function (ev) {
    var tg = ev.target && ev.target.closest ? ev.target : null;
    if (!tg) return;
    var b;
    if ((b = tg.closest("[data-approval-decision]"))) {
      // Same frame as the in-thread card; the server re-checks that the sender is an admin and updates every client.
      if (!b.disabled && (!deps.isAdmin || deps.isAdmin())) {
        if (!deps.send({ type: "permission_response", requestId: b.getAttribute("data-approval-id"), decision: b.getAttribute("data-approval-decision") })) deps.toast(t("social.toastDecisionLost"));
      }
    } else if ((b = tg.closest("[data-approval-open]"))) {
      var sid = b.getAttribute("data-session");
      closePops(null);
      if (sid && String(sid) !== String(deps.getSessionId())) deps.switchSession(isNaN(Number(sid)) ? sid : Number(sid));
    } else if ((b = tg.closest("[data-pref]"))) {
      var key = b.getAttribute("data-pref");
      var next = !st.prefs[key];
      st.prefs[key] = next;
      var patch = {}; patch[key] = next;
      deps.send(Object.assign({ type: "notif_prefs" }, patch));
      renderTools();
    } else if (tg.closest("[data-social-readall]")) {
      markNotifRead(st, "all");
      deps.send({ type: "notif_read", ids: "all" });
      renderTools();
    } else if ((b = tg.closest("[data-social-notif]"))) {
      var nid = b.getAttribute("data-social-notif");
      markNotifRead(st, [nid]);
      deps.send({ type: "notif_read", ids: [nid] });
      closePops(null);
      renderTools();
      goto(b.getAttribute("data-mid"), b.getAttribute("data-session"), { open: !!(st.notifs.find(function (n) { return n.id === nid; }) || {}).commentId, att: attrAtt(b) });
    }
  });

  els.popPin.addEventListener("click", function (ev) {
    var t = ev.target && ev.target.closest ? ev.target : null;
    if (!t) return;
    var b;
    if ((b = t.closest("[data-social-unpin]"))) {
      deps.send({ type: "pin_remove", id: b.getAttribute("data-social-unpin") });
    } else if ((b = t.closest("[data-social-goto]"))) {
      closePops(null);
      goto(b.getAttribute("data-social-goto"), b.getAttribute("data-session"), { open: false, att: attrAtt(b) });
    }
  });

  // Pin rows are role="button": Enter and Space activate them like a click.
  els.popPin.addEventListener("keydown", function (ev) {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    var row = ev.target && ev.target.closest ? ev.target.closest("[data-social-goto]") : null;
    if (!row || ev.target !== row) return;
    ev.preventDefault();
    row.click();
  });

  // Touch: the icon row is hidden, a long press (~450 ms, cancelled by moving >10 px or scrolling) on a message opens a bottom sheet
  // with the same actions. Nothing is prevented, so text selection and taps on links/buttons keep working.
  var LONG_PRESS_MS = 450, MOVE_PX = 10;
  // The message-level buttons of one .ai-meta (image rows are separate elements), in sheet order.
  var SHEET_PICKS = [
    { key: "copy", sel: "[data-social-copy]", get label() { return t("social.copy"); } },
    { key: "pin", sel: "[data-social-pin]", label: null },
    { key: "comment", sel: "[data-social-comment]", get label() { return t("social.comment"); } },
    { key: "coach", sel: "[data-coach-chip]", get label() { return t("social.coach"); } },
  ];
  function sheetButton(meta, pick) {
    var b = meta.querySelector(pick.sel);
    return b && !b.disabled ? b : null;
  }
  var press = null, sheetLayer = null, sheetMid = null, sheetAt = 0;

  function cancelPress() {
    if (press) { clearTimeout(press.timer); press = null; }
  }
  function closeSheet() {
    if (!sheetLayer) return;
    if (sheetLayer.parentNode) sheetLayer.parentNode.removeChild(sheetLayer);
    sheetLayer = null;
  }
  function metaOf(mid) { return els.chat.querySelector('.ai-meta[data-meta="' + mid + '"]'); }
  function openSheet(mid) {
    var meta = metaOf(mid);
    if (!meta) return;
    var actions = [];
    SHEET_PICKS.forEach(function (p) {
      var b = sheetButton(meta, p);
      if (b) actions.push({ key: p.key, label: p.label || b.getAttribute("aria-label") || t("social.pin") });
    });
    if (!actions.length) return;
    closeSheet();
    sheetLayer = document.createElement("div");
    sheetLayer.className = "att-sheet-layer msg-sheet-layer";
    sheetLayer.innerHTML = actionSheetHtml(actions);
    document.body.appendChild(sheetLayer);
    sheetMid = mid;
    sheetAt = Date.now();
    var first = sheetLayer.querySelector("button");
    if (first && first.focus) first.focus();
  }
  function runSheet(key) {
    var mid = sheetMid;
    closeSheet();
    if (key === "copy") {
      copyText(texts[mid] || "").then(function (ok) { deps.toast(ok ? t("social.copiedToast") : t("social.copyFailedHint")); });
      return;
    }
    var pick = SHEET_PICKS.filter(function (p) { return p.key === key; })[0];
    var meta = metaOf(mid);
    var btn = meta && pick ? sheetButton(meta, pick) : null;
    if (btn) btn.click();
  }

  els.chat.addEventListener("pointerdown", function (ev) {
    cancelPress();
    if (ev.pointerType !== "touch" || ev.isPrimary === false || !ev.target || !ev.target.closest) return;
    if (ev.target.closest("a, button, input, textarea, select, .ai-thread, .ai-meta")) return;
    var article = ev.target.closest(".message");
    var meta = article && article.querySelector(".ai-meta[data-meta]");
    if (!meta) return;
    var mid = meta.getAttribute("data-meta");
    press = { x: ev.clientX, y: ev.clientY, timer: setTimeout(function () { press = null; openSheet(mid); }, LONG_PRESS_MS) };
  });
  els.chat.addEventListener("pointermove", function (ev) {
    if (press && Math.hypot(ev.clientX - press.x, ev.clientY - press.y) > MOVE_PX) cancelPress();
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach(function (name) { els.chat.addEventListener(name, cancelPress); });
  els.chat.addEventListener("scroll", cancelPress);
  document.addEventListener("click", function (ev) {
    if (!sheetLayer || !ev.target || !ev.target.closest) return;
    var item = ev.target.closest("[data-msg-sheet-do]");
    if (item) runSheet(item.getAttribute("data-msg-sheet-do"));
    else if (ev.target.closest("[data-msg-sheet-close]") && Date.now() - sheetAt > 400) closeSheet();
  });
  document.addEventListener("keydown", function (ev) { if (ev.key === "Escape") closeSheet(); });

  onLangChange(renderTools);
  return { handle: handle, extra: extra, captureFocus: captureFocus, onSessionChanged: onSessionChanged, request: request, refresh: renderTools, openApprovals: openApprovals };
}

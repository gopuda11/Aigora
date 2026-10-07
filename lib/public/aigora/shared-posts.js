// shared-posts.js - Thin DOM/WS controller for explicit sharing and room-visible shared posts.
import { t, onLangChange, applyDom } from "./i18n.js";
import { escapeHtml } from "../modules/escape-html.js";
import { createShareDraft, setDraftField, toggleDraftMessage, toggleDraftAttachment, canUseVerification, buildSharePayload, createSharedPostsState, applyPostMessage, refusalText, renderPostsHtml, renderShareHtml, canDeletePost } from "./shared-posts-model.js";

var POST_TYPES = { post_shared:1, post_list:1, post_event:1, post_comment_added:1, post_pinned:1, post_error:1 };

function makeKey() {
  return "share-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
}
function node(tag, id, cls) {
  var n = document.createElement(tag);
  if (id) n.setAttribute("id", id);
  if (cls) n.setAttribute("class", cls);
  return n;
}
function isRoomMember(room) {
  return !!room && (room.role === "owner" || room.role === "member");
}

export function initSharedPosts(deps) {
  var st = createSharedPostsState();
  var keyFn = deps.makeKey || makeKey;
  var tools = document.getElementById("ai-social-tools");

  var shareBtn = node("button", "ai-share-private", "ai-tool-btn ai-share-tool hidden");
  shareBtn.type = "button";
  shareBtn.setAttribute("aria-label", t("sharedPosts.shareAria"));
  shareBtn.setAttribute("title", t("sharedPosts.shareToRoom"));
  shareBtn.setAttribute("aria-haspopup", "dialog");
  shareBtn.textContent = t("sharedPosts.share");

  var postsBtn = node("button", "ai-shared-posts-btn", "ai-tool-btn ai-posts-tool hidden");
  postsBtn.type = "button";
  postsBtn.setAttribute("aria-label", t("sharedPosts.postsAria"));
  postsBtn.setAttribute("title", t("sharedPosts.results"));
  postsBtn.setAttribute("aria-haspopup", "dialog");
  postsBtn.textContent = t("sharedPosts.resultsShort");
  if (tools) {
    tools.insertBefore(postsBtn, tools.firstChild || null);
    tools.insertBefore(shareBtn, postsBtn);
  }

  var panel = node("div", "ai-shared-posts-panel", "sp-layer hidden");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "ai-shared-posts-title");
  panel.innerHTML = '<div class="sp-scrim" data-posts-close></div><section class="sp-sheet"><header class="sp-head"><div><small>ROOM RESULTS</small><h2 id="ai-shared-posts-title" data-i18n="sharedPosts.results">공유 결과</h2></div><button type="button" class="sp-close" data-posts-close aria-label="닫기" data-i18n-attr="aria-label:sharedPosts.close">×</button></header><div id="ai-shared-posts-body"></div></section>';
  applyDom(panel);
  document.body.appendChild(panel);

  var dialog = node("div", "ai-share-dialog", "sp-layer hidden");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", t("sharedPosts.shareToRoom"));
  dialog.innerHTML = '<div class="sp-scrim" data-share-close></div><section class="sp-sheet sp-share-sheet"><div id="ai-share-body"></div></section>';
  document.body.appendChild(dialog);

  var body = document.getElementById("ai-shared-posts-body");
  var shareBody = document.getElementById("ai-share-body");
  var lastRoomId = null;
  var targetPostId = null;
  var connected = !!deps.isConnected();

  function room() { return deps.getRoom ? deps.getRoom() : null; }
  function session() { return deps.getSession ? deps.getSession() : null; }
  function view() {
    var r = room();
    return { myId: deps.getMyId ? deps.getMyId() : null, roomRole: r && r.role, connected: connected };
  }
  function mayShare() {
    var r = room();
    var s = session();
    var myId = deps.getMyId ? deps.getMyId() : null;
    return isRoomMember(r) && !!s && s.channelId != null &&
      String(s.roomId) === String(r.id) && s.ownerId != null && String(s.ownerId) === String(myId);
  }
  function renderPanel() {
    if (!body) return;
    body.innerHTML = renderPostsHtml(st, view());
    if (st.deleteConfirmId) {
      var p = st.posts.filter(function (x) { return x.id === st.deleteConfirmId; })[0];
      if (p && canDeletePost(p, view())) {
        body.innerHTML += '<div class="sp-confirm" role="alertdialog" aria-label="' + escapeHtml(t("sharedPosts.deleteConfirmAria")) + '"><p>' + escapeHtml(t("sharedPosts.deleteConfirm")) + '</p><div><button type="button" class="sp-secondary" data-post-delete-cancel>' + escapeHtml(t("sharedPosts.cancel")) + '</button><button type="button" class="sp-danger-button" data-post-delete-confirm>' + escapeHtml(t("sharedPosts.delete")) + '</button></div></div>';
      }
    }
    applyTarget();
  }
  function renderShare() {
    if (shareBody) shareBody.innerHTML = renderShareHtml(st.share);
  }
  function focusFirst(root) {
    var f = root && root.querySelector("input,textarea,button");
    if (f && f.focus) f.focus();
  }
  function closePanel() {
    panel.classList.add("hidden");
    postsBtn.setAttribute("aria-expanded", "false");
    st.deleteConfirmId = null;
    targetPostId = null;
  }
  function closeShare() {
    if (st.share && st.share.pending) return;
    dialog.classList.add("hidden");
    shareBtn.setAttribute("aria-expanded", "false");
  }
  function requestPosts(force) {
    var r = room();
    if (!isRoomMember(r)) return false;
    if (!connected) { renderPanel(); return false; }
    if (!force && st.roomId === r.id && st.status !== "error") return true;
    st.roomId = r.id;
    st.status = "loading";
    st.error = "";
    st.posts = [];
    st.comments = {};
    st.pins = {};
    renderPanel();
    if (!deps.send({ type: "post_list", roomId: r.id })) {
      st.status = "error";
      st.error = t("sharedPosts.disconnected");
      renderPanel();
      return false;
    }
    return true;
  }
  function refresh(force) {
    var r = room();
    var member = isRoomMember(r);
    postsBtn.classList.toggle("hidden", !member);
    shareBtn.classList.toggle("hidden", !mayShare());
    shareBtn.disabled = !connected;
    shareBtn.title = connected ? t("sharedPosts.shareToRoom") : t("sharedPosts.offlineShareTitle");
    if (deps.onChange) deps.onChange();
    if (!r || !member) {
      lastRoomId = null;
      st.roomId = null;
      st.status = "empty";
      st.posts = [];
      closePanel();
      if (!mayShare()) closeShare();
      return;
    }
    if (force || lastRoomId !== r.id) {
      lastRoomId = r.id;
      requestPosts(true);
    }
    if (!panel.classList.contains("hidden")) renderPanel();
  }
  function openPanel() {
    if (!isRoomMember(room())) return false;
    panel.classList.remove("hidden");
    postsBtn.setAttribute("aria-expanded", "true");
    requestPosts(true);
    renderPanel();
    focusFirst(panel);
    return true;
  }
  // The 공유 결과 view, scrolled to one post (from its card in the room feed).
  // The posts load after the panel opens, so the target is applied on each render.
  function openPost(postId) {
    targetPostId = String(postId);
    var opened = openPanel();
    if (!opened) targetPostId = null;
    return opened;
  }
  function applyTarget() {
    if (!targetPostId || !body) return;
    var cards = body.querySelectorAll("[data-post-id]");
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].getAttribute("data-post-id") !== targetPostId) continue;
      cards[i].classList.add("sp-card-target");
      if (typeof cards[i].scrollIntoView === "function") cards[i].scrollIntoView({ block: "center" });
      targetPostId = null;
      return;
    }
  }
  function openShare() {
    if (!mayShare()) {
      deps.toast(t("sharedPosts.ownOnly"));
      return false;
    }
    if (!connected) {
      deps.toast(t("sharedPosts.offlineShare"));
      return false;
    }
    st.share = createShareDraft(session(), deps.getThread ? deps.getThread() : null, keyFn());
    dialog.classList.remove("hidden");
    shareBtn.setAttribute("aria-expanded", "true");
    renderShare();
    focusFirst(dialog);
    return true;
  }
  function preview() {
    var d = st.share;
    if (!d || d.pending) return false;
    if (!d.title.trim()) {
      d.error = t("sharedPosts.titleRequired");
      renderShare();
      return false;
    }
    if (!canUseVerification(d, d.verification)) {
      d.error = t("sharedPosts.evidenceRequired");
      renderShare();
      return false;
    }
    d.error = "";
    d.step = "preview";
    renderShare();
    focusFirst(dialog);
    return true;
  }
  function confirm() {
    var d = st.share;
    if (!d || d.pending || d.step !== "preview") return false;
    if (!connected) {
      d.error = t("sharedPosts.offlineShare");
      renderShare();
      return false;
    }
    d.pending = true;
    d.error = "";
    renderShare();
    if (!deps.send(buildSharePayload(d))) {
      d.pending = false;
      d.error = t("sharedPosts.shareOffline");
      renderShare();
      return false;
    }
    return true;
  }
  function handle(msg) {
    if (!msg || !POST_TYPES[msg.type]) return false;
    var hadPending = !!(st.share && st.share.pending);
    var changed = applyPostMessage(st, msg);
    if (!changed) return true;
    if (msg.type === "post_error") {
      deps.toast(refusalText(msg.code));
      if (st.share) renderShare();
      else { st.status = "error"; renderPanel(); }
      return true;
    }
    if (msg.type === "post_shared" && hadPending) {
      dialog.classList.add("hidden");
      shareBtn.setAttribute("aria-expanded", "false");
      deps.toast(t("sharedPosts.shared"));
    }
    if (!panel.classList.contains("hidden")) renderPanel();
    if (deps.onChange) deps.onChange();
    return true;
  }

  shareBtn.addEventListener("click", openShare);
  postsBtn.addEventListener("click", openPanel);

  dialog.addEventListener("click", function (ev) {
    var t = ev.target && ev.target.closest ? ev.target : null;
    if (!t) return;
    var hit;
    if (t.closest("[data-share-close]")) closeShare();
    else if ((hit = t.closest("[data-share-message-index]"))) {
      toggleDraftMessage(st.share, Number(hit.getAttribute("data-share-message-index")));
      renderShare();
    } else if ((hit = t.closest("[data-share-attachment-index]"))) {
      toggleDraftAttachment(st.share, Number(hit.getAttribute("data-share-attachment-index")));
      renderShare();
    } else if (t.closest("[data-share-preview]")) preview();
    else if (t.closest("[data-share-back]")) {
      if (st.share && !st.share.pending) { st.share.step = "edit"; renderShare(); }
    } else if (t.closest("[data-share-confirm]")) confirm();
  });
  dialog.addEventListener("input", function (ev) {
    var el = ev.target && ev.target.closest ? ev.target.closest("[data-share-field]") : null;
    if (!el || !st.share) return;
    setDraftField(st.share, el.getAttribute("data-share-field"), el.value);
    if (el.getAttribute("data-share-field") === "evidence") renderShare();
  });
  dialog.addEventListener("change", function (ev) {
    var el = ev.target && ev.target.closest ? ev.target.closest("[data-share-field]") : null;
    if (el && st.share) {
      setDraftField(st.share, el.getAttribute("data-share-field"), el.value);
      renderShare();
    }
  });

  panel.addEventListener("click", function (ev) {
    var t = ev.target && ev.target.closest ? ev.target : null;
    if (!t) return;
    var hit;
    if (t.closest("[data-posts-close]")) closePanel();
    else if ((hit = t.closest("[data-post-pin]"))) {
      if (!connected) { deps.toast(t("sharedPosts.offlinePin")); return; }
      deps.send({ type: "post_pin", roomId: st.roomId, id: hit.getAttribute("data-post-pin"), title: hit.getAttribute("data-post-title") || t("sharedPosts.results") });
    } else if ((hit = t.closest("[data-post-delete]"))) {
      var p = st.posts.filter(function (x) { return x.id === hit.getAttribute("data-post-delete"); })[0];
      if (p && canDeletePost(p, view())) { st.deleteConfirmId = p.id; renderPanel(); }
    } else if (t.closest("[data-post-delete-cancel]")) {
      st.deleteConfirmId = null;
      renderPanel();
    } else if (t.closest("[data-post-delete-confirm]")) {
      if (st.deleteConfirmId && connected) {
        deps.send({ type: "post_delete", roomId: st.roomId, id: st.deleteConfirmId });
        st.deleteConfirmId = null;
        renderPanel();
      }
    }
  });
  panel.addEventListener("submit", function (ev) {
    var form = ev.target && ev.target.closest ? ev.target.closest("[data-post-comment]") : null;
    if (!form) return;
    ev.preventDefault();
    var input = form.querySelector("input");
    var value = input ? input.value.trim() : "";
    if (!value || !connected) return;
    if (deps.send({ type: "post_comment", roomId: st.roomId, id: form.getAttribute("data-post-comment"), text: value })) input.value = "";
  });
  document.addEventListener("keydown", function (ev) {
    if (ev.key !== "Escape") return;
    if (!dialog.classList.contains("hidden")) closeShare();
    else if (!panel.classList.contains("hidden")) closePanel();
  });

  refresh(false);
  onLangChange(function () {
    shareBtn.setAttribute("aria-label", t("sharedPosts.shareAria"));
    shareBtn.title = connected ? t("sharedPosts.shareToRoom") : t("sharedPosts.offlineShareTitle");
    shareBtn.textContent = t("sharedPosts.share");
    postsBtn.setAttribute("aria-label", t("sharedPosts.postsAria"));
    postsBtn.setAttribute("title", t("sharedPosts.results"));
    postsBtn.textContent = t("sharedPosts.resultsShort");
    dialog.setAttribute("aria-label", t("sharedPosts.shareToRoom"));
    applyDom(panel);
    renderPanel();
    renderShare();
  });
  return {
    state: st,
    openShare: openShare,
    openPanel: openPanel,
    openPost: openPost,
    preview: preview,
    confirm: confirm,
    handle: handle,
    refresh: refresh,
    setConnected: function (v) {
      connected = !!v;
      if (connected) refresh(true);
      else {
        if (st.status === "loading") st.status = "error";
        refresh(false);
      }
    },
  };
}

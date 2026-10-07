// shared-posts-model.js - Pure state, validation and escaped markup for Aigora
// explicit private-session sharing and room-visible shared posts. No DOM/WS.

import { escapeHtml } from "../modules/escape-html.js";
import { thumbsHtml } from "./chat-model.js";
import { t } from "./i18n.js";

var VERIFY = {
  get unverified() { return t("sharedPosts.verifyUnverified"); },
  get author_checked() { return t("sharedPosts.verifyAuthor"); },
  get tests_passed() { return t("sharedPosts.verifyTests"); },
};
var SOURCE_MID = /^[A-Za-z0-9_.:-]{1,120}$/;
var SOURCE_IMAGE = /^\d+-[a-f0-9]+\.(?:png|jpe?g|gif|webp)$/;
var IMAGE_MIME = { "image/png": 1, "image/jpeg": 1, "image/gif": 1, "image/webp": 1 };
var ERROR_TEXT = {
  get forbidden() { return t("sharedPosts.errForbidden"); },
  get invalid() { return t("sharedPosts.errInvalid"); },
  get failed() { return t("sharedPosts.errFailed"); },
  get not_found() { return t("sharedPosts.errNotFound"); },
};

function text(v) { return typeof v === "string" ? v : ""; }
function sourceName(url) {
  var clean = text(url).split(/[?#]/)[0];
  var name = clean.slice(clean.lastIndexOf("/") + 1);
  return SOURCE_IMAGE.test(name) ? name : "";
}
function selected(list, id) { return list.indexOf(id) >= 0; }
function toggle(list, id) {
  var i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1); else list.push(id);
}

export function createShareDraft(session, thread, idempotencyKey) {
  var messages = [];
  var attachments = [];
  (thread && Array.isArray(thread.items) ? thread.items : []).forEach(function (item) {
    if (item && typeof item.mid === "string" && item.mid && (item.role === "user" || item.role === "assistant") && typeof item.text === "string") {
      messages.push({ sourceId: item.mid, role: item.role, text: item.text });
    }
    (item && Array.isArray(item.attachments) ? item.attachments : []).forEach(function (a, index) {
      var name = a && IMAGE_MIME[a.mediaType] ? sourceName(a.url) : "";
      if (!name && a && IMAGE_MIME[a.mediaType] && !a.url && item.role === "user" && SOURCE_MID.test(item.mid || "")) name = item.mid + "#a" + index;
      if (!name || attachments.some(function (x) { return x.sourceId === name; })) return;
      attachments.push({ sourceId: name, mediaType: a.mediaType, label: t("sharedPosts.imageN", { n: attachments.length + 1 }) });
    });
  });
  return {
    sourceSessionId: session && session.id != null ? String(session.id) : "",
    idempotencyKey: String(idempotencyKey || ""),
    messages: messages, attachments: attachments,
    selectedMessageIds: [], selectedAttachmentIds: [],
    title: "", body: "", evidence: "", verification: "unverified", limitations: "",
    step: "edit", pending: false, error: "",
  };
}

export function canUseVerification(draft, value) {
  if (!Object.prototype.hasOwnProperty.call(VERIFY, value)) return false;
  return value !== "tests_passed" || !!text(draft && draft.evidence).trim();
}

export function setDraftField(draft, field, value) {
  if (!draft || ["title", "body", "evidence", "verification", "limitations"].indexOf(field) < 0) return false;
  value = text(value);
  if (field === "verification" && !canUseVerification(draft, value)) return false;
  draft[field] = value;
  if (field === "evidence" && !value.trim() && draft.verification === "tests_passed") draft.verification = "unverified";
  draft.error = "";
  return true;
}

export function toggleDraftMessage(draft, index) {
  var m = draft && draft.messages && draft.messages[index];
  if (!m) return false;
  toggle(draft.selectedMessageIds, m.sourceId);
  return true;
}
export function toggleDraftAttachment(draft, index) {
  var a = draft && draft.attachments && draft.attachments[index];
  if (!a) return false;
  toggle(draft.selectedAttachmentIds, a.sourceId);
  return true;
}

export function previewDraft(draft) {
  if (!draft) return null;
  return {
    title: draft.title, body: draft.body, evidence: draft.evidence,
    verification: draft.verification, limitations: draft.limitations,
    messages: draft.messages.filter(function (m) { return selected(draft.selectedMessageIds, m.sourceId); }).map(function (m) { return { role: m.role, text: m.text }; }),
    attachments: draft.attachments.filter(function (a) { return selected(draft.selectedAttachmentIds, a.sourceId); }).map(function (a) { return { mediaType: a.mediaType, label: a.label }; }),
  };
}

export function buildSharePayload(draft) {
  return {
    type: "post_share", sourceSessionId: draft.sourceSessionId,
    selectedMessageIds: draft.selectedMessageIds.slice(), selectedAttachmentIds: draft.selectedAttachmentIds.slice(),
    title: draft.title, body: draft.body, evidence: draft.evidence,
    verification: draft.verification, limitations: draft.limitations, idempotencyKey: draft.idempotencyKey,
  };
}

export function refusalText(code) { return ERROR_TEXT[code] || ERROR_TEXT.failed; }

export function createSharedPostsState() {
  return { roomId: null, status: "empty", posts: [], comments: {}, pins: {}, share: null, error: "", deleteConfirmId: null };
}

function upsertPost(st, p) {
  if (!p || typeof p.id !== "string") return false;
  var i = st.posts.findIndex(function (x) { return x.id === p.id; });
  if (i >= 0) st.posts[i] = p; else st.posts.unshift(p);
  st.status = "ready";
  return true;
}

export function applyPostMessage(st, msg) {
  if (!st || !msg || typeof msg.type !== "string") return false;
  if (msg.roomId && st.roomId && msg.roomId !== st.roomId) return false;
  if (msg.roomId) st.roomId = msg.roomId;
  if (msg.type === "post_list") {
    st.posts = Array.isArray(msg.posts) ? msg.posts.slice() : [];
    st.comments = {}; st.pins = {};
    st.posts.forEach(function (p) {
      if (!p || typeof p.id !== "string") return;
      st.comments[p.id] = Array.isArray(p.comments) ? p.comments.slice() : [];
      st.pins[p.id] = Array.isArray(p.pins) ? p.pins.slice() : [];
    });
    st.status = st.posts.length ? "ready" : "empty";
    st.error = "";
    return true;
  }
  if (msg.type === "post_shared") {
    if (st.share) { st.share.pending = false; st.share.step = "done"; st.share.error = ""; }
    return upsertPost(st, msg.post);
  }
  if (msg.type === "post_event") {
    if (msg.action === "add") return upsertPost(st, msg.post);
    if (msg.action === "delete" && msg.post && msg.post.id) {
      st.posts = st.posts.filter(function (p) { return p.id !== msg.post.id; });
      delete st.comments[msg.post.id]; delete st.pins[msg.post.id];
      st.status = st.posts.length ? "ready" : "empty";
      return true;
    }
    return false;
  }
  if (msg.type === "post_comment_added" && msg.comment && msg.comment.mid) {
    var cs = st.comments[msg.comment.mid] || (st.comments[msg.comment.mid] = []);
    if (!cs.some(function (c) { return c.id === msg.comment.id; })) cs.push(msg.comment);
    return true;
  }
  if (msg.type === "post_pinned" && msg.pin && msg.pin.mid) {
    var ps = st.pins[msg.pin.mid] || (st.pins[msg.pin.mid] = []);
    if (!ps.some(function (p) { return p.id === msg.pin.id; })) ps.push(msg.pin);
    return true;
  }
  if (msg.type === "post_error") {
    st.error = refusalText(msg.code);
    if (st.share) { st.share.pending = false; st.share.error = st.error; }
    return true;
  }
  return false;
}

export function canDeletePost(post, view) {
  return !!post && !!view && (String(post.authorId) === String(view.myId) || view.roomRole === "owner");
}

function verificationBadge(v) {
  return '<span class="sp-verify sp-verify-' + escapeHtml(v || "unverified") + '">' + escapeHtml(VERIFY[v] || VERIFY.unverified) + "</span>";
}
function prose(s) { return escapeHtml(text(s)); }

function publicCard(p, view, preview) {
  var out = '<article class="sp-card"' + (p.id ? ' data-post-id="' + escapeHtml(p.id) + '"' : "") + ">";
  out += '<header class="sp-card-head"><div><h3>' + prose(p.title || t("sharedPosts.noTitle")) + '</h3>' + verificationBadge(p.verification) + "</div>";
  if (!preview && canDeletePost(p, view)) out += '<button type="button" class="sp-plain sp-danger" data-post-delete="' + escapeHtml(p.id) + '">' + escapeHtml(t("sharedPosts.delete")) + "</button>";
  out += "</header>";
  if (p.body) out += '<p class="sp-body">' + prose(p.body) + "</p>";
  (Array.isArray(p.messages) ? p.messages : []).forEach(function (m) {
    out += '<div class="sp-message"><small>' + escapeHtml(m.role === "user" ? t("sharedPosts.pickedQuestion") : t("sharedPosts.pickedResult")) + '</small><p>' + prose(m.text) + "</p></div>";
  });
  if (p.evidence) out += '<section class="sp-meta"><b>' + escapeHtml(t("sharedPosts.evidence")) + '</b><p>' + prose(p.evidence) + "</p></section>";
  if (p.limitations) out += '<section class="sp-meta"><b>' + escapeHtml(t("sharedPosts.limitations")) + '</b><p>' + prose(p.limitations) + "</p></section>";
  var atts = Array.isArray(p.attachments) ? p.attachments : [];
  if (atts.length) {
    out += '<div class="sp-files" aria-label="' + escapeHtml(t("sharedPosts.attachmentsAria")) + '">';
    atts.forEach(function (a, i) {
      if (preview) out += '<span class="sp-file">' + prose(a.label || t("sharedPosts.imageN", { n: i + 1 })) + "</span>";
      else out += '<a class="sp-file" href="' + escapeHtml(a.url || "") + '" target="_blank" rel="noopener">' + escapeHtml(t("sharedPosts.imageN", { n: i + 1 })) + "</a>";
    });
    out += "</div>";
    if (!preview) out += thumbsHtml(atts.map(function (a) { return { url: a.url }; }), t("sharedPosts.sharedImages"));
  }
  if (!preview) {
    var pins = view && view.pins && view.pins[p.id] || [];
    var comments = view && view.comments && view.comments[p.id] || [];
    out += '<div class="sp-human"><p>' + escapeHtml(t("sharedPosts.humanComments")) + "</p>";
    out += '<div class="sp-actions"><button type="button" class="sp-plain" data-post-pin="' + escapeHtml(p.id) + '" data-post-title="' + escapeHtml(p.title || t("sharedPosts.results")) + '">' + escapeHtml(pins.length ? t("sharedPosts.pinned") : t("sharedPosts.pin")) + "</button></div>";
    comments.forEach(function (c) { out += '<div class="sp-comment"><b>' + prose(c.authorName || t("sharedPosts.memberDefault")) + '</b><p>' + prose(c.deleted ? t("sharedPosts.commentDeleted") : c.text) + "</p></div>"; });
    out += '<form class="sp-comment-form" data-post-comment="' + escapeHtml(p.id) + '"><input type="text" maxlength="2000" aria-label="' + escapeHtml(t("sharedPosts.commentAria")) + '" placeholder="' + escapeHtml(t("sharedPosts.commentPlaceholder")) + '"><button type="submit">' + escapeHtml(t("sharedPosts.send")) + '</button></form></div>';
  }
  out += "</article>";
  return out;
}

export function renderPostsHtml(st, view) {
  view = view || {};
  if (view.connected === false) return '<div class="sp-state" role="status"><b>' + escapeHtml(t("sharedPosts.offline")) + '</b><p>' + escapeHtml(t("sharedPosts.offlineHint")) + '</p></div>';
  if (!st || st.status === "loading") return '<div class="sp-state" role="status">' + escapeHtml(t("sharedPosts.loading")) + '</div>';
  if (st.status === "error") return '<div class="sp-state" role="alert"><b>' + escapeHtml(t("sharedPosts.loadFailed")) + '</b><p>' + prose(st.error) + "</p></div>";
  if (!st.posts.length) return '<div class="sp-state"><b>' + escapeHtml(t("sharedPosts.emptyTitle")) + '</b><p>' + escapeHtml(t("sharedPosts.emptyHint")) + '</p></div>';
  var detailView = { myId: view.myId, roomRole: view.roomRole, comments: st.comments, pins: st.pins };
  return st.posts.map(function (p) { return publicCard(p, detailView, false); }).join("");
}

export function renderPreviewHtml(draft) {
  var p = previewDraft(draft);
  return '<div class="sp-preview-note">' + escapeHtml(t("sharedPosts.previewNote")) + '</div>' + publicCard(p || {}, {}, true);
}

export function renderShareHtml(draft) {
  if (!draft) return "";
  if (draft.step === "preview" || draft.step === "done") {
    return '<header class="sp-head"><div><small>' + escapeHtml(t("sharedPosts.shareToRoom")) + '</small><h2>' + escapeHtml(t("sharedPosts.publicPreview")) + '</h2></div><button type="button" class="sp-close" data-share-close aria-label="' + escapeHtml(t("sharedPosts.close")) + '">×</button></header>' +
      renderPreviewHtml(draft) + (draft.error ? '<p class="sp-error" role="alert">' + prose(draft.error) + "</p>" : "") +
      '<footer class="sp-footer"><button type="button" class="sp-secondary" data-share-back' + (draft.pending ? " disabled" : "") + '>' + escapeHtml(t("sharedPosts.edit")) + '</button><button type="button" class="sp-primary" data-share-confirm' + (draft.pending ? " disabled" : "") + '>' + escapeHtml(draft.pending ? t("sharedPosts.posting") : t("sharedPosts.shareThis")) + "</button></footer>";
  }
  var out = '<header class="sp-head"><div><small>' + escapeHtml(t("sharedPosts.shareToRoom")) + '</small><h2>' + escapeHtml(t("sharedPosts.chooseContent")) + '</h2></div><button type="button" class="sp-close" data-share-close aria-label="' + escapeHtml(t("sharedPosts.close")) + '">×</button></header>';
  out += '<p class="sp-help">' + escapeHtml(t("sharedPosts.help")) + '</p>';
  out += '<label class="sp-field">' + escapeHtml(t("sharedPosts.fieldTitle")) + '<input data-share-field="title" maxlength="200" value="' + escapeHtml(draft.title) + '" required></label>';
  out += '<label class="sp-field">' + escapeHtml(t("sharedPosts.fieldBody")) + '<textarea data-share-field="body" maxlength="20000">' + escapeHtml(draft.body) + "</textarea></label>";
  out += '<fieldset class="sp-picks"><legend>' + escapeHtml(t("sharedPosts.messages")) + '</legend>';
  if (!draft.messages.length) out += '<p class="sp-muted">' + escapeHtml(t("sharedPosts.noMessages")) + '</p>';
  draft.messages.forEach(function (m, i) {
    out += '<label class="sp-pick"><input type="checkbox" data-share-message-index="' + i + '"' + (selected(draft.selectedMessageIds, m.sourceId) ? " checked" : "") + '><span><b>' + escapeHtml(m.role === "user" ? t("sharedPosts.question") : t("sharedPosts.result")) + '</b><small>' + prose(m.text).slice(0, 240) + "</small></span></label>";
  });
  out += "</fieldset><fieldset class=\"sp-picks\"><legend>" + escapeHtml(t("sharedPosts.supportedAttachments")) + "</legend>";
  if (!draft.attachments.length) out += '<p class="sp-muted">' + escapeHtml(t("sharedPosts.noAttachments")) + '</p>';
  draft.attachments.forEach(function (a, i) {
    out += '<label class="sp-pick"><input type="checkbox" data-share-attachment-index="' + i + '"' + (selected(draft.selectedAttachmentIds, a.sourceId) ? " checked" : "") + '><span><b>' + prose(a.label) + '</b><small>' + prose(a.mediaType) + "</small></span></label>";
  });
  out += "</fieldset>";
  out += '<label class="sp-field">' + escapeHtml(t("sharedPosts.fieldVerification")) + '<select data-share-field="verification"><option value="unverified"' + (draft.verification === "unverified" ? " selected" : "") + '>' + escapeHtml(t("sharedPosts.verifyUnverified")) + '</option><option value="author_checked"' + (draft.verification === "author_checked" ? " selected" : "") + '>' + escapeHtml(t("sharedPosts.verifyAuthor")) + '</option><option value="tests_passed"' + (draft.verification === "tests_passed" ? " selected" : "") + (!draft.evidence.trim() ? " disabled" : "") + '>' + escapeHtml(t("sharedPosts.verifyTests")) + '</option></select></label>';
  out += '<label class="sp-field">' + escapeHtml(t("sharedPosts.evidence")) + '<textarea data-share-field="evidence" maxlength="10000" placeholder="' + escapeHtml(t("sharedPosts.evidencePlaceholder")) + '">' + escapeHtml(draft.evidence) + "</textarea></label>";
  out += '<label class="sp-field">' + escapeHtml(t("sharedPosts.limitations")) + '<textarea data-share-field="limitations" maxlength="4000">' + escapeHtml(draft.limitations) + "</textarea></label>";
  if (draft.error) out += '<p class="sp-error" role="alert">' + prose(draft.error) + "</p>";
  out += '<footer class="sp-footer"><button type="button" class="sp-primary" data-share-preview>' + escapeHtml(t("sharedPosts.publicPreview")) + '</button></footer>';
  return out;
}

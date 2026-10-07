// attachments-model.js - Pure model and markup for room/private-channel file
// attachments: the feed card, the upload chips, the client-side file gate and
// the Korean reasons. No DOM, no network. Every dynamic value goes through
// escapeHtml; a file name is never trusted as markup.

import { escapeHtml } from "../modules/escape-html.js";
import { timeAgo } from "./social-model.js";
import { t } from "./i18n.js";

export var MAX_FILE_BYTES = 25 * 1024 * 1024;
export var MAX_IMAGE_FILE_BYTES = 15 * 1024 * 1024;
export var MAX_AUDIO_FILE_BYTES = 500 * 1024 * 1024; // the server's cap is the configured one (default 100 MB)
export var PREVIEW_CHARS = 20000;
export var TRANSCRIPT_PREVIEW_CHARS = 200000;

// Mirrors the server allowlist (lib/room-attachments.js); the server stays the judge.
var KINDS = {
  image: "png jpg jpeg gif webp", text: "txt csv md json log", pdf: "pdf", office: "docx xlsx pptx",
  legacy: "doc xls ppt odt ods odp rtf", hwp: "hwp hwpx", archive: "zip tar gz 7z",
  audio: "m4a mp3 wav ogg oga opus webm flac aac mp4", // accepted by the server only while transcription is enabled
  video: "mov mkv avi", // likewise, and only while video analysis is on
};
var KIND_OF = {};
Object.keys(KINDS).forEach(function (k) { KINDS[k].split(" ").forEach(function (e) { KIND_OF[e] = k; }); });
// The MIME of each extension, as the server serves it (the picker filters by either).
var MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  txt: "text/plain", csv: "text/csv", md: "text/markdown", json: "application/json", log: "text/plain", pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  doc: "application/msword", xls: "application/vnd.ms-excel", ppt: "application/vnd.ms-powerpoint",
  odt: "application/vnd.oasis.opendocument.text", ods: "application/vnd.oasis.opendocument.spreadsheet", odp: "application/vnd.oasis.opendocument.presentation",
  rtf: "application/rtf", hwp: "application/x-hwp", hwpx: "application/vnd.hancom.hwpx",
  zip: "application/zip", tar: "application/x-tar", gz: "application/gzip", "7z": "application/x-7z-compressed",
  m4a: "audio/mp4", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", webm: "audio/webm", flac: "audio/flac", aac: "audio/aac", mp4: "audio/mp4",
  mov: "video/quicktime", mkv: "video/x-matroska", avi: "video/x-msvideo",
};
var ACCEPT_PARTS = Object.keys(KIND_OF).map(function (e) { return "." + e; });
Object.keys(MIME).forEach(function (e) { if (ACCEPT_PARTS.indexOf(MIME[e]) < 0) ACCEPT_PARTS.push(MIME[e]); });
export var ACCEPT = ACCEPT_PARTS.join(",");

export function extOf(name) {
  var m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ""));
  return m ? m[1].toLowerCase() : "";
}
export function kindOf(ext) { return KIND_OF[ext] || "other"; }

export function formatSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

// Client-side gate: a hint so people are told at once; the server enforces it again.
export function fileProblem(file) {
  var name = file && file.name || "";
  var ext = extOf(name);
  if (!ext || !KIND_OF[ext]) return t(ext ? "attachments.badTypeExt" : "attachments.badType", { ext: ext });
  if (!file.size) return t("attachments.emptyFile");
  var cap = KIND_OF[ext] === "image" ? MAX_IMAGE_FILE_BYTES : KIND_OF[ext] === "audio" || KIND_OF[ext] === "video" ? MAX_AUDIO_FILE_BYTES : MAX_FILE_BYTES;
  if (file.size > cap) return t("attachments.tooBigCap", { size: formatSize(cap) });
  return "";
}

var REASONS = {
  get too_large() { return t("attachments.reasonTooLarge"); },
  get disabled() { return t("transcription.reasonDisabled"); },
  get unreachable() { return t("transcription.reasonUnreachable"); },
  get timeout() { return t("transcription.reasonTimeout"); },
  get auth() { return t("transcription.reasonAuth"); },
  get http_error() { return t("transcription.reasonServer"); },
  get bad_response() { return t("transcription.reasonServer"); },
  get empty() { return t("transcription.reasonEmpty"); },
  get interrupted() { return t("transcription.reasonInterrupted"); },
  get too_long() { return t("transcription.reasonTooLong"); },
  get tool_failed() { return t("transcription.reasonToolFailed"); },
  get busy_queue() { return t("transcription.reasonBusy"); },
  get unsupported() { return t("attachments.reasonUnsupported"); },
  get quota() { return t("attachments.reasonQuota"); },
  get storage_full() { return t("attachments.reasonStorageFull"); },
  get rate_limited() { return t("attachments.reasonRateLimited"); },
  get busy() { return t("attachments.reasonBusy"); },
  get expired() { return t("attachments.reasonExpired"); },
  get not_found() { return t("attachments.reasonNotFound"); },
  get unauthorized() { return t("attachments.reasonUnauthorized"); },
  get invalid() { return t("attachments.uploadFailed"); },
};
export function reasonFor(code) { return REASONS[code] || t("attachments.uploadFailed"); }

// --- Feed ---------------------------------------------------------------------------

// attachment_card / attachment_card_removed -> thread items (an old attachment_ai entry is ignored). Folds by attachment id, so live
// delivery and replayed history show each card once; a removal hides it for good.
export function foldAttachment(t, msg) {
  if (!msg || typeof msg.attachmentId !== "string" || !/^[a-f0-9]{32}$/.test(msg.attachmentId)) return false;
  var i;
  if (msg.type === "attachment_card_removed") {
    for (i = t.items.length - 1; i >= 0; i--) {
      if (t.items[i].role === "attachment" && t.items[i].attachmentId === msg.attachmentId) { t.items.splice(i, 1); return true; }
    }
    return false;
  }
  if (msg.type === "attachment_transcript") {
    // The audio's transcription state (never the text): the latest entry wins, so live delivery and replay agree.
    var st = msg.status === "done" || msg.status === "failed" || msg.status === "running" ? msg.status : "";
    if (!st) return false;
    for (i = t.items.length - 1; i >= 0; i--) {
      if (t.items[i].role === "attachment" && t.items[i].attachmentId === msg.attachmentId) {
        t.items[i].transcript = { status: st, reason: typeof msg.reason === "string" ? msg.reason : "", expiresAt: Number(msg.expiresAt) || 0 };
        // A video's analysis: the running stage, and the counts when done (numbers only, never text).
        if (typeof msg.stage === "string" && /^(probe|transcribe|emphasis|frames)$/.test(msg.stage)) t.items[i].transcript.stage = msg.stage;
        if (st === "done" && msg.summary && typeof msg.summary === "object") {
          t.items[i].transcript.summary = { durationSec: Math.max(0, Number(msg.summary.durationSec) || 0), moments: Math.max(0, Number(msg.summary.moments) || 0), frames: Math.max(0, Number(msg.summary.frames) || 0) };
        }
        return true;
      }
    }
    return false;
  }
  if (msg.type !== "attachment_card" || typeof msg.name !== "string") return false;
  for (i = 0; i < t.items.length; i++) if (t.items[i].role === "attachment" && t.items[i].attachmentId === msg.attachmentId) return false;
  t.items.push({
    role: "attachment", attachmentId: msg.attachmentId, mid: "att-" + msg.attachmentId, scope: msg.scope === "channel" ? "channel" : "room",
    roomId: msg.roomId, channelId: msg.channelId, name: msg.name, text: msg.name, ext: extOf(msg.name), size: Number(msg.size) || 0,
    author: typeof msg.authorName === "string" ? msg.authorName : "", authorId: msg.authorId, ts: msg._ts || 0,
    aiMade: msg.aiMade === true, agentName: typeof msg.agentName === "string" ? msg.agentName : "",
  });
  return true;
}

// ai_result_files / ai_result_published -> one "AI가 만든 파일" item per turn. Folds by result id, so live delivery and
// replayed history show it once; a published entry marks that file of the card (and nothing else).
export function foldAiResult(t, msg) {
  var i;
  if (typeof msg.resultId !== "string" || !msg.resultId) return false;
  if (msg.type === "ai_result_published") {
    for (i = 0; i < t.items.length; i++) {
      var it = t.items[i];
      if (it.role === "airesult" && it.resultId === msg.resultId && it.files[msg.index] && !it.files[msg.index].published) {
        it.files[msg.index].published = true; it.files[msg.index].busy = false; it.files[msg.index].error = "";
        return true;
      }
    }
    return false;
  }
  if (msg.type !== "ai_result_files" || !Array.isArray(msg.files)) return false;
  for (i = 0; i < t.items.length; i++) if (t.items[i].role === "airesult" && t.items[i].resultId === msg.resultId) return false;
  t.items.push({
    role: "airesult", resultId: msg.resultId, mid: "airesult-" + msg.resultId, scope: msg.scope === "channel" ? "channel" : "room",
    roomId: msg.roomId, channelId: msg.channelId, ts: msg._ts || 0,
    files: msg.files.filter(function (f) { return f && typeof f.name === "string"; }).map(function (f) {
      return { name: f.name, ext: f.ext || extOf(f.name), size: Number(f.size) || 0, pendingId: f.pendingId, published: false };
    }),
    skipped: (Array.isArray(msg.skipped) ? msg.skipped : []).filter(function (f) { return f && typeof f.name === "string"; }).map(function (f) { return { name: f.name, reason: typeof f.reason === "string" ? f.reason : "" }; }),
  });
  return true;
}

// The "AI가 만든 파일" note card. New turns post their files as normal file cards (labelled in cardHtml) and only use this
// card for a small line naming files that could not be posted. An older card still lists its file names (read-only).
export function resultCardHtml(it) {
  var id = escapeHtml(it.resultId);
  var rows = it.files.map(function (f) {
    return '<li class="ai-result-row"><span class="att-badge att-k-' + kindOf(f.ext) + '" aria-hidden="true">' + escapeHtml((f.ext || "file").slice(0, 4).toUpperCase()) + "</span>" +
      '<span class="att-info"><strong class="att-name">' + escapeHtml(f.name) + "</strong><small>" + escapeHtml(formatSize(f.size)) + "</small></span>" +
      (f.published ? '<span class="att-done">' + escapeHtml(t("attachments.published")) + ' \u2713</span>' : "") + "</li>";
  }).join("");
  var skipped = it.skipped.length ? '<ul class="ai-result-skipped">' + it.skipped.map(function (s) { return "<li>" + escapeHtml(s.name) + " · " + escapeHtml(s.reason) + "</li>"; }).join("") + "</ul>" : "";
  var label = escapeHtml(rows ? t("attachments.aiMadeFile") : t("attachments.unpostedFiles"));
  var hint = rows ? '<small class="ai-result-legacy">' + escapeHtml(t("attachments.legacyList")) + "</small>" : "";
  return '<article class="message attach-card ai-result-card" data-ai-result="' + id + '"><p class="message-label">' + label + "</p>" +
    '<div class="msg-box"><div class="att-body">' + (rows ? '<ul class="ai-result-list">' + rows + "</ul>" : "") + skipped + hint + "</div></div></article>";
}

// Path of an attachment under the project's api base ("/p/<slug>/api/").
export function attachmentUrl(base, it) {
  var scope = it.scope === "channel" ? "channel-attachments/" + encodeURIComponent(it.channelId) : "room-attachments/" + encodeURIComponent(it.roomId);
  return base + scope + "/" + it.attachmentId;
}

var ICON_DL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11m0 0l-4-4m4 4l4-4M5 20h14"/></svg>';

var ICON_MORE = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';

// view: { base, canDelete(it), canShare(it), preview: { id: text } , now }
// The live state of an audio card's transcription: "running" past its deadline reads as interrupted (the daemon restarted).
export function transcriptState(it, now) {
  var tr = it && it.transcript;
  if (!tr) return null;
  if (tr.status === "running" && tr.expiresAt && (now || Date.now()) > tr.expiresAt) return { status: "failed", reason: "interrupted" };
  return tr;
}

function clock(sec) {
  var s = Math.max(0, Math.round(Number(sec) || 0)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  function p(n) { return (n < 10 ? "0" : "") + n; }
  return (h ? h + ":" + p(m) : String(m)) + ":" + p(r);
}

export function cardHtml(it, view, extra) {
  var url = escapeHtml(attachmentUrl(view.base, it));
  var kind = kindOf(it.ext);
  var id = escapeHtml(it.attachmentId);
  var name = escapeHtml(it.name);
  var shown = view.preview && view.preview[it.attachmentId];
  var media = kind === "audio" || kind === "video";
  var tstate = media ? transcriptState(it, view.now) : null;
  var thumb = kind === "image"
    ? '<a class="att-thumb" href="' + url + '?disposition=inline" target="_blank" rel="noopener"><img src="' + url + '?disposition=inline" alt="' + name + '" loading="lazy" decoding="async"></a>'
    : "";
  var office = view.officeActions ? view.officeActions(it) || "" : "";
  var dlAttrs = ' href="' + url + '" download="' + name + '" rel="noopener">' + ICON_DL + "<span>" + escapeHtml(t("attachments.download")) + "</span></a>";
  // One primary button: 함께 편집 for office documents, 미리보기 for text, else 다운로드. The rest goes in the 더 보기 menu.
  var primary = office;
  var menu = "";
  if (/\bof-open\b/.test(office)) menu += '<a role="menuitem" class="att-menu-item att-btn"' + dlAttrs;
  else if (media) {
    // 전사 보기 (expandable transcript) once it is ready; the audio itself stays one tap away in the menu.
    if (tstate && tstate.status === "done") primary += '<button type="button" class="att-btn att-primary" data-att-preview="' + id + '" aria-expanded="' + (shown != null ? "true" : "false") + '">' + escapeHtml(shown != null ? t("transcription.hide") : t("transcription.show")) + "</button>";
    else primary += '<a class="att-btn att-primary"' + dlAttrs;
    if (tstate && tstate.status === "done") menu += '<a role="menuitem" class="att-menu-item att-btn"' + dlAttrs;
  } else if (kind === "text") {
    primary += '<button type="button" class="att-btn att-primary" data-att-preview="' + id + '" aria-expanded="' + (shown != null ? "true" : "false") + '">' + escapeHtml(shown != null ? t("attachments.collapse") : t("attachments.preview")) + "</button>";
    menu += '<a role="menuitem" class="att-menu-item att-btn"' + dlAttrs;
  } else primary += '<a class="att-btn att-primary"' + dlAttrs;
  if (view.canGive && view.canGive(it)) {
    var on = view.picked && view.picked(it);
    menu += '<button type="button" role="menuitem" class="att-menu-item att-btn att-ai" data-att-ai="' + id + '"' + (on ? " disabled" : "") + ">" + escapeHtml(on ? t("attachments.attached") : t("attachments.attachToInstruction")) + "</button>";
  }
  if (view.canShare && view.canShare(it)) menu += '<button type="button" role="menuitem" class="att-menu-item att-btn" data-att-share="' + id + '">' + escapeHtml(t("attachments.shareToRoom")) + "</button>";
  if (view.canDelete && view.canDelete(it)) menu += '<button type="button" role="menuitem" class="att-menu-item att-btn att-danger" data-att-delete="' + id + '">' + escapeHtml(t("attachments.delete")) + "</button>";
  var tline = "";
  if (tstate) {
    var sm = tstate.summary;
    var stageNames = ["probe", "transcribe", "emphasis", "frames"];
    // Done with nothing found in a part (0 highlights, 0 frames): that part is left out instead of saying "0".
    var doneKey = "transcription.videoDone";
    if (sm) doneKey = sm.moments > 0 && sm.frames > 0 ? "transcription.videoDone" : sm.moments > 0 ? "transcription.videoDoneNoFrames" : sm.frames > 0 ? "transcription.videoDoneNoMoments" : "transcription.videoDoneBare";
    var doneText = !sm ? t("transcription.done") : doneKey === "transcription.videoDoneNoFrames" ? t("transcription.videoDoneNoFrames", { duration: clock(sm.durationSec), moments: sm.moments })
      : doneKey === "transcription.videoDoneNoMoments" ? t("transcription.videoDoneNoMoments", { duration: clock(sm.durationSec), frames: sm.frames })
      : doneKey === "transcription.videoDoneBare" ? t("transcription.videoDoneBare", { duration: clock(sm.durationSec) })
      : t("transcription.videoDone", { duration: clock(sm.durationSec), moments: sm.moments, frames: sm.frames });
    var stageAt = tstate.stage ? stageNames.indexOf(tstate.stage) : -1;
    var tmsg = tstate.status === "running" ? (tstate.stage ? t("transcription.videoRunning", { stage: t("transcription.videoStage" + tstate.stage.charAt(0).toUpperCase() + tstate.stage.slice(1)) }) : t("transcription.running"))
      : tstate.status === "done" ? doneText : t("transcription.failed", { reason: reasonFor(tstate.reason) });
    // Progress you can see: a spinner while it runs (plus a four-step bar for a video), a check when done, a cross when failed.
    var ico = tstate.status === "running" ? '<span class="att-ts-ico att-spin" aria-hidden="true"></span>' : '<span class="att-ts-ico" aria-hidden="true">' + (tstate.status === "done" ? "\u2713" : "\u2715") + "</span>";
    var bar = tstate.status === "running" && stageAt >= 0
      ? '<span class="att-steps" role="progressbar" aria-valuemin="0" aria-valuemax="4" aria-valuenow="' + stageAt + '" aria-label="' + escapeHtml(t("transcription.progressLabel")) + '">' + stageNames.map(function (_, i) { return '<i class="' + (i < stageAt ? "is-done" : i === stageAt ? "is-now" : "") + '"></i>'; }).join("") + "</span>"
      : "";
    tline = '<p class="att-transcript-state is-' + escapeHtml(tstate.status) + '" role="status">' + ico + "<span>" + escapeHtml(tmsg) + "</span>" + bar + "</p>";
  }
  var scopeNote = it.scope === "channel" ? '<span class="att-scope">' + escapeHtml(t("attachments.scopeChannel")) + "</span>" : "";
  var version = view.officeVersion ? view.officeVersion(it) : "";
  var meta = escapeHtml(formatSize(it.size)) + " · " + escapeHtml(timeAgo(it.ts, view.now)) + (version ? " · " + escapeHtml(version) : "");
  return '<article class="message attach-card" data-attach-card="' + id + '"><p class="message-label">' + (it.aiMade ? escapeHtml(t("attachments.aiMadeFile")) + (it.agentName ? " · " + escapeHtml(it.agentName) : "") : escapeHtml(t("attachments.fileLabel", { name: it.author || t("attachments.memberDefault") }))) + "</p>" +
    '<div class="msg-box"><div class="att-body">' + thumb +
    '<div class="att-row"><span class="att-badge att-k-' + kind + '" aria-hidden="true">' + escapeHtml((it.ext || "file").slice(0, 4).toUpperCase()) + "</span>" +
    '<span class="att-info"><strong class="att-name">' + name + "</strong><small>" + meta + "</small>" + scopeNote + "</span></div>" +
    tline + '<div class="att-actions">' + primary +
    (menu ? '<span class="att-more-wrap"><button type="button" class="att-more" data-att-more="' + id + '" aria-label="' + escapeHtml(t("attachments.more")) + '" title="' + escapeHtml(t("attachments.more")) + '" aria-haspopup="menu" aria-expanded="false">' + ICON_MORE + "</button>" +
      '<span class="att-menu-scrim" data-att-more-close></span><span class="att-menu" role="menu" aria-label="' + escapeHtml(t("attachments.fileActions")) + '" hidden>' + menu + "</span></span>" : "") + "</div>" +
    (shown != null ? '<pre class="att-text' + (media ? " is-transcript" : "") + '" tabindex="0" aria-label="' + escapeHtml(t(media ? "transcription.of" : "attachments.previewOf", { name: it.name })) + '">' + (media ? escapeHtml(shown).replace(/^(\[\d{1,2}:\d{2}(?::\d{2})?\])/gm, '<span class="att-ts">$1</span>') : escapeHtml(shown)) + "</pre>" : "") +
    "</div>" + (extra || "") + "</div></article>";
}

// --- Upload chips -------------------------------------------------------------------

// upload: { id, name, size, state: "queued" | "uploading" | "failed", percent, reason }
export function uploadsHtml(list, opts) {
  var hint = opts && opts.adminVisible ? ' <span class="up-vis">' + escapeHtml(t("attachments.adminCanSee")) + "</span>" : "";
  return list.map(function (u) {
    var status = u.state === "failed" ? escapeHtml(u.reason || t("attachments.uploadFailed"))
      : u.state === "queued" ? escapeHtml(t("attachments.queued")) : (u.percent >= 100 ? escapeHtml(t("attachments.processing")) : Math.round(u.percent || 0) + "%");
    var action = u.state === "failed"
      ? '<button type="button" class="up-x" data-up-dismiss="' + escapeHtml(u.id) + '" aria-label="' + escapeHtml(t("attachments.closeNamed", { name: u.name })) + '">' + escapeHtml(t("attachments.close")) + "</button>"
      : '<button type="button" class="up-x" data-up-cancel="' + escapeHtml(u.id) + '" aria-label="' + escapeHtml(t("attachments.cancelUploadNamed", { name: u.name })) + '">' + escapeHtml(t("attachments.cancel")) + "</button>";
    return '<div class="up-chip is-' + escapeHtml(u.state) + '" role="group" aria-label="' + escapeHtml(u.name) + '"><div class="up-main"><span class="up-name">' + escapeHtml(u.name) + "</span>" +
      '<span class="up-state' + (u.state === "failed" ? " is-error" : "") + '">' + status + "</span></div>" +
      (u.state === "failed" ? "" : '<div class="up-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round(u.percent || 0) + '"><i style="width:' + Math.max(0, Math.min(100, u.percent || 0)) + '%"></i></div>' + hint) +
      action + "</div>";
  }).join("");
}

// --- Share sheet --------------------------------------------------------------------

// rooms: [{ id, name, role }]; only member or above may receive a copy.
export function shareTargets(rooms) {
  return (rooms || []).filter(function (r) { return r && r.id != null && r.role !== "viewer"; });
}

export function shareSheetHtml(it, rooms, selectedId) {
  var rows = shareTargets(rooms).map(function (r) {
    var on = String(r.id) === String(selectedId);
    return '<label class="att-room' + (on ? " is-on" : "") + '"><input type="radio" name="att-share-room" value="' + escapeHtml(String(r.id)) + '"' + (on ? " checked" : "") + "><span>" + escapeHtml(r.name || t("attachments.roomDefault")) + "</span></label>";
  }).join("");
  return '<div class="att-sheet-scrim" data-att-sheet-close></div><div class="att-sheet" role="dialog" aria-modal="true" aria-labelledby="att-sheet-title">' +
    '<h2 id="att-sheet-title">' + escapeHtml(t("attachments.shareToRoom")) + "</h2>" +
    '<p class="att-sheet-file">' + escapeHtml(it.name) + " · " + escapeHtml(formatSize(it.size)) + "</p>" +
    '<p class="att-sheet-note">' + t("attachments.shareNote") + "</p>" +
    (rows ? '<div class="att-rooms" role="radiogroup" aria-label="' + escapeHtml(t("attachments.shareRoomsLabel")) + '">' + rows + "</div>" : '<p class="att-sheet-note">' + escapeHtml(t("attachments.noShareRooms")) + "</p>") +
    '<p class="att-sheet-error" role="alert" hidden></p>' +
    '<div class="att-sheet-actions"><button type="button" class="att-btn" data-att-sheet-close>' + escapeHtml(t("attachments.cancel")) + '</button>' +
    '<button type="button" class="att-btn att-primary" data-att-sheet-send' + (rows ? "" : " disabled") + ">" + escapeHtml(t("attachments.share")) + "</button></div></div>";
}

// --- Per-instruction files: "방 파일 첨부" ------------------------------------------------------

export var PICK_SEARCH_MIN = 8; // the picker shows a search box above this many files

// Label of the composer + menu entry that opens the picker.
export function pickEntryText(scope) { return scope === "channel" ? t("attachments.pickChannel") : t("attachments.pickRoom"); }

// The chip above the composer for one picked file (same look as an image chip: icon, name, x).
export function fileChipHtml(f) {
  return '<span class="ai-chip ai-chip-file" data-file-chip="' + escapeHtml(f.id) + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>' +
    '<span class="ai-chip-name">' + escapeHtml(f.name) + '</span><button type="button" data-remove-file="' + escapeHtml(f.id) + '" aria-label="' + escapeHtml(t("attachments.removeAttachNamed", { name: f.name })) + '">\u00d7</button></span>';
}

// state: { scope, files: [{ id, name, size, uploaderId, authorName, createdAt }], selected: { id: true }, query, now,
//          canOutbox, outbox: null | { busy, files, error } }. Newest first.
export function pickerSheetHtml(state) {
  var files = state.files.slice().sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
  var rows = files.map(function (f) {
    var q = String(state.query || "").trim().toLowerCase();
    var hide = q && String(f.name).toLowerCase().indexOf(q) < 0;
    return '<li class="ai-inbox-row" data-pick-name="' + escapeHtml(String(f.name).toLowerCase()) + '"' + (hide ? " hidden" : "") + '><label class="att-pick"><input type="checkbox" data-att-pick="' + escapeHtml(f.id) + '"' + (state.selected && state.selected[f.id] ? " checked" : "") + '>' +
      '<span class="att-info"><strong class="att-name">' + escapeHtml(f.name) + "</strong><small>" +
      escapeHtml(formatSize(f.size)) + (f.authorName ? " · " + escapeHtml(f.authorName) : "") + (f.createdAt ? " · " + escapeHtml(timeAgo(f.createdAt, state.now)) : "") + "</small></span></label></li>";
  }).join("");
  var channel = state.scope === "channel";
  var out = "";
  if (state.canOutbox) {
    var o = state.outbox, body = "";
    if (o && o.error) body = '<p class="att-sheet-error" role="alert">' + escapeHtml(o.error) + "</p>";
    else if (o && o.busy) body = '<p class="att-out-hint">' + escapeHtml(t("attachments.aiBusy")) + "</p>";
    else if (o && !o.files.length) body = '<p class="att-out-hint">' + escapeHtml(t("attachments.outboxEmpty")) + "</p>";
    else if (o) body = '<ul class="ai-inbox-list att-out-list">' + o.files.map(function (f) {
      return '<li class="ai-inbox-row"><span class="att-info"><strong class="att-name">' + escapeHtml(f.name) + "</strong><small>" + escapeHtml(formatSize(f.size)) +
        '</small></span><button type="button" class="att-btn" data-ai-outbox-publish="' + escapeHtml(f.name) + '">' + escapeHtml(t("attachments.postToRoom")) + '</button></li>';
    }).join("") + "</ul>";
    out = '<div class="att-out">' + body + '<button type="button" class="att-out-row" data-ai-outbox-load><span>' + escapeHtml(t("attachments.fetchAiResults")) + '</span><i aria-hidden="true">\u203a</i></button>' +
      (o ? "" : '<p class="att-out-hint">' + escapeHtml(t("attachments.outboxHint")) + "</p>") + "</div>";
  }
  var count = Object.keys(state.selected || {}).length;
  return '<div class="att-sheet-scrim" data-att-sheet-close></div><div class="att-sheet att-pick-sheet" role="dialog" aria-modal="true" aria-labelledby="att-sheet-title">' +
    '<h2 id="att-sheet-title">' + escapeHtml(channel ? t("attachments.pickChannel") : t("attachments.pickRoom")) + '</h2>' +
    '<p class="att-sheet-note">' + escapeHtml(t("attachments.pickNote")) + "</p>" +
    (files.length > PICK_SEARCH_MIN ? '<input type="search" class="att-pick-q" data-att-pick-q placeholder="' + escapeHtml(t("attachments.searchFiles")) + '" aria-label="' + escapeHtml(t("attachments.searchFiles")) + '" value="' + escapeHtml(state.query || "") + '">' : "") +
    (rows ? '<ul class="ai-inbox-list att-pick-list">' + rows + "</ul>" : '<p class="att-sheet-note">' + escapeHtml(channel ? t("attachments.noFilesChannel") : t("attachments.noFilesRoom")) + "</p>") +
    out + '<p class="att-sheet-error" role="alert" hidden></p>' +
    '<div class="att-sheet-actions"><button type="button" class="att-btn" data-att-sheet-close>' + escapeHtml(t("attachments.close")) + '</button>' +
    '<button type="button" class="att-btn att-primary" data-att-pick-apply' + (count === 0 && !state.hadPicked ? " disabled" : "") + ">" + escapeHtml(count ? t("attachments.attachCount", { count: count }) : t("attachments.attach")) + "</button></div></div>";
}

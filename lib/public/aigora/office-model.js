// office-model.js - Pure model and markup for Office co-editing: the card buttons and badges, the
// full-screen editor overlay (Apple-style header), the version history sheet and the "새 문서" sheet.
// No DOM, no network. Every dynamic value goes through escapeHtml; a file name is never markup.

import { escapeHtml } from "../modules/escape-html.js";
import { timeAgo } from "./social-model.js";
import { formatSize } from "./attachments-model.js";

import { t } from "./i18n.js";
export function unavailableText() { return t("office.unavailable"); }
export function hwpNote() { return t("office.hwpNote"); }
// Mirrors the server (lib/room-attachments.js CO_EDIT / DOWNLOAD_ONLY); the server stays the judge.
export var CO_EDIT = ["docx", "xlsx", "pptx"];
export var DOWNLOAD_ONLY = ["hwp", "hwpx", "hml"];
export var NEW_TYPES = [
  { type: "docx", get label() { return t("office.typeDocx"); }, sub: "Word · .docx", get defaultName() { return t("office.newDocx"); } },
  { type: "xlsx", get label() { return t("office.typeXlsx"); }, sub: "Excel · .xlsx", get defaultName() { return t("office.newXlsx"); } },
  { type: "pptx", get label() { return t("office.typePptx"); }, sub: "PowerPoint · .pptx", get defaultName() { return t("office.newPptx"); } },
];

export function canCoEdit(ext) { return CO_EDIT.indexOf(ext) >= 0; }
export function isDownloadOnly(ext) { return DOWNLOAD_ONLY.indexOf(ext) >= 0; }

// --- URLs ---------------------------------------------------------------------------

// base: "/p/<slug>/office/". An item's scope is "room" (roomId) or "channel" (channelId).
function scopePath(it) {
  return it.scope === "channel" ? "channel/" + encodeURIComponent(it.channelId) : "room/" + encodeURIComponent(it.roomId);
}
export function statusUrl(base, target) {
  return base + "api/status/" + (target.kind === "channel" ? "channel/" + encodeURIComponent(target.channelId) : "room/" + encodeURIComponent(target.roomId));
}
// m: "1" = ONLYOFFICE's mobile layout (a view session), "0" = the desktop layout with editing; omitted = the frame decides by width.
export function editorUrl(base, it, m) { return base + "editor/" + scopePath(it) + "/" + it.attachmentId + (m === "1" || m === "0" ? "?m=" + m : ""); }
export function versionsUrl(base, it) { return base + "api/" + scopePath(it) + "/" + it.attachmentId + "/versions"; }
export function restoreUrl(base, it, n) { return versionsUrl(base, it) + "/" + Number(n) + "/restore"; }
export function versionDownloadUrl(base, it, n) { return versionsUrl(base, it) + "/" + Number(n) + "/download"; }

// --- Presence -----------------------------------------------------------------------

function names(list, myId) {
  var me = list.filter(function (e) { return e.id === myId; }), others = list.filter(function (e) { return e.id !== myId; });
  var out = others.map(function (e) { return e.name || t("office.memberFallback"); });
  if (me.length) out.push(t("office.me"));
  if (out.length > 3) return t("office.andOthers", { names: out.slice(0, 2).join(", "), count: out.length - 2 });
  return out.join(", ");
}
// "민아, 나 편집 중" / "보라 보는 중" / "" for an empty document.
export function presenceText(editors, myId) {
  var list = editors || [];
  var editing = list.filter(function (e) { return e.mode === "edit"; }), viewing = list.filter(function (e) { return e.mode !== "edit"; });
  if (editing.length && viewing.length) return t("office.editingBy", { names: names(editing, myId) }) + " · " + t("office.viewingBy", { names: names(viewing, myId) });
  if (editing.length) return t("office.editingBy", { names: names(editing, myId) });
  if (viewing.length) return t("office.viewingBy", { names: names(viewing, myId) });
  return "";
}

// --- Card ---------------------------------------------------------------------------

var ICON_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9a2.1 2.1 0 0 0-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>';

// A private-channel file is edited by its owner alone, so it is "편집", not "함께 편집".
function isPrivate(it) { return it.scope === "channel" || !!it.channelId; }

// The office part of an attachment card. st: { enabled, available, editing: { id: { v, editors, saving, lastSaveFailed } } }.
// opts: { canEdit, myId }. HWP/HWPX/HML always say they are download-only; nothing else about them is offered.
export function cardActionsHtml(it, st, opts) {
  var ext = it.ext;
  if (isDownloadOnly(ext)) return '<span class="of-note of-hwp">' + escapeHtml(hwpNote()) + "</span>";
  if (!canCoEdit(ext) || !st || !st.enabled) return "";
  var id = escapeHtml(it.attachmentId);
  var entry = st.editing && st.editing[it.attachmentId];
  var label = opts && opts.canEdit === false ? t("office.viewDoc") : t(isPrivate(it) ? "office.edit" : "office.coEdit");
  var out;
  if (st.available) {
    out = '<button type="button" class="att-btn of-open" data-office-open="' + id + '">' + ICON_EDIT + "<span>" + label + "</span></button>";
  } else {
    out = '<button type="button" class="att-btn of-open is-off" data-office-open="' + id + '" aria-disabled="true">' + ICON_EDIT + "<span>" + label + "</span></button>" +
      '<span class="of-note of-down" role="status">' + escapeHtml(unavailableText()) + "</span>";
  }
  var bits = [];
  if (entry && entry.editors && entry.editors.length) bits.push(escapeHtml(presenceText(entry.editors, opts && opts.myId)));
  if (entry && entry.saving) bits.push(t("office.saving"));
  if (bits.length) out += '<span class="of-badge" role="status">' + bits.join(" · ") + "</span>";
  if (entry && entry.lastSaveFailed) out += '<span class="of-note of-fail" role="status">' + escapeHtml(t("office.lastSaveFailed")) + "</span>";
  return out;
}

// The version tag ("v4") of a co-edited document; the card shows it in its meta line. "" until it has been saved once.
export function cardVersion(it, st) {
  var entry = st && st.enabled && st.editing && st.editing[it.attachmentId];
  return entry && entry.v > 1 ? "v" + Number(entry.v) : "";
}

// --- Overlay ------------------------------------------------------------------------

var ICON_BACK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';
var ICON_PEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9a2.1 2.1 0 0 0-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>';
var ICON_LOCATE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="1.8"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/></svg>';
var ICON_EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/></svg>';
var ICON_CLOCK ='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>';

// The full-screen layer: header (back, title + who is editing, version history), the editor frame, a state line.
// On a phone ONLYOFFICE's mobile layout only views (free Community build), so people who may edit get a
// mode button: 편집 (desktop layout with editing) / 보기 (back to the mobile layout).
export function modeButton(mobile) {
  return mobile
    ? { label: t("office.modeEdit"), aria: t("office.modeEditAria"), html: ICON_PEN + "<span>" + escapeHtml(t("office.modeEdit")) + "</span>", edit: false }
    : { label: t("office.modeView"), aria: t("office.modeViewAria"), html: ICON_EYE + "<span>" + escapeHtml(t("office.modeView")) + "</span>", edit: true };
}
var ICON_EXPAND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
var ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
var ICON_CLIP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11.5l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.7 17.2a1.7 1.7 0 0 1-2.4-2.4L14.5 7.6"/></svg>';

// Wide screens: the editor takes the right half of the workspace (the chat stays usable beside it), with a
// draggable divider; its header has 지시에 첨부, 전체 화면 and a close button instead of back.
export function splitHtml(it, o) {
  o = o || {};
  var name = escapeHtml(it.name);
  return '<div class="of-divider" data-of-divider role="separator" aria-orientation="vertical" tabindex="0" aria-label="' + t("office.dividerLabel") + '"></div>' +
    '<div class="of-overlay" role="region" aria-label="' + t("office.docAria", { name: name }) + '" data-office-overlay>' +
    '<header class="of-header of-split-header">' +
    '<div class="of-title"><strong class="of-name">' + name + '</strong><small class="of-who" role="status" aria-live="polite">' + escapeHtml(o.who || "") + "</small></div>" +
    '<div class="of-actions">' + (o.canEdit ? '<button type="button" class="of-locate" data-of-locate aria-label="' + t("office.locate") + '" title="' + t("office.locate") + '" hidden>' + ICON_LOCATE + "</button>" : "") +
    '<button type="button" class="of-hist" data-of-attach>' + ICON_CLIP + "<span>" + t("office.attach") + "</span></button>" +
    '<button type="button" class="of-hist" data-of-history aria-label="' + t("office.history") + '" aria-expanded="false">' + ICON_CLOCK + "<span>" + t("office.historyShort") + "</span></button>" +
    '<button type="button" class="of-hist" data-of-full aria-pressed="false" aria-label="' + t("office.fullscreen") + '" title="' + t("office.fullscreen") + '">' + ICON_EXPAND + "<span>" + t("office.fullscreen") + "</span></button>" +
    '<button type="button" class="of-locate" data-of-back aria-label="' + t("office.closeDoc") + '" title="' + t("office.close") + '">' + ICON_X + "</button></div>" +
    "</header>" + stageHtml() + '<div class="of-history" data-of-history-panel hidden></div></div>';
}
function stageHtml() {
  return '<div class="of-stage"><iframe class="of-frame" data-of-frame title="' + t("office.editorFrame") + '" allow="clipboard-read; clipboard-write; fullscreen"></iframe>' +
    '<div class="of-state" data-of-state role="status"><span class="of-spin" aria-hidden="true"></span><span class="of-state-text">' + t("office.opening") + '</span></div></div>';
}

export function overlayHtml(it, o) {
  if (o && o.split) return splitHtml(it, o);
  var name = escapeHtml(it.name);
  var mode = modeButton(true);
  return '<div class="of-overlay" role="dialog" aria-modal="true" aria-label="' + t("office.editAria", { name: name }) + '" data-office-overlay>' +
    '<header class="of-header">' +
    '<button type="button" class="of-back" data-of-back aria-label="' + t("office.back") + '">' + ICON_BACK + "<span>" + t("office.back") + "</span></button>" +
    '<div class="of-title"><strong class="of-name">' + name + '</strong><small class="of-who" role="status" aria-live="polite">' + escapeHtml(o && o.who || "") + "</small></div>" +
    '<div class="of-actions">' + (o && o.phone && o.canEdit ? '<button type="button" class="of-locate" data-of-locate aria-label="' + t("office.locate") + '" title="' + t("office.locate") + '" hidden>' + ICON_LOCATE + "</button>" : "") + (o && o.phone && o.canEdit ? '<button type="button" class="of-mode" data-of-mode aria-label="' + escapeHtml(mode.aria) + '">' + mode.html + "</button>" : "") +
    '<button type="button" class="of-hist" data-of-history aria-label="' + t("office.history") + '" aria-expanded="false">' + ICON_CLOCK + "<span>" + t("office.historyShort") + "</span></button></div>" +
    "</header>" +
    '<div class="of-stage"><iframe class="of-frame" data-of-frame title="' + t("office.editorFrame") + '" allow="clipboard-read; clipboard-write; fullscreen"></iframe>' +
    '<div class="of-state" data-of-state role="status"><span class="of-spin" aria-hidden="true"></span><span class="of-state-text">' + t("office.opening") + '</span></div></div>' +
    '<div class="of-history" data-of-history-panel hidden></div></div>';
}

// state line shown over the frame while loading, and when something went wrong.
export function stateHtml(kind, text, downloadHref) {
  if (kind === "loading") return '<span class="of-spin" aria-hidden="true"></span><span class="of-state-text">' + escapeHtml(text || t("office.opening")) + "</span>";
  var dl = downloadHref ? '<a class="att-btn att-primary" href="' + escapeHtml(downloadHref) + '" rel="noopener">' + t("office.download") + '</a>' : "";
  return '<div class="of-error"><p>' + escapeHtml(text) + '</p><div class="of-error-actions">' + dl + '<button type="button" class="att-btn" data-of-back>' + t("office.close") + '</button></div></div>';
}

export function errorMessage(code, serverMessage) {
  if (code === "office_unavailable" || code === "office_disabled") return serverMessage || unavailableText();
  if (code === "unsupported") return t("office.errUnsupported");
  if (code === "not_found") return t("office.errNotFound");
  if (code === "network") return t("office.errNetwork");
  return serverMessage || t("office.errOpen");
}

// --- Version history ----------------------------------------------------------------

// list: [{ n, size, savedBy, savedByName, savedAt, restoredFrom, current }] newest first.
export function versionsHtml(list, o) {
  o = o || {};
  var rows = (list || []).map(function (v) {
    var who = escapeHtml(v.savedByName || "");
    var meta = [who, escapeHtml(timeAgo(v.savedAt, o.now)), escapeHtml(formatSize(v.size))].filter(Boolean).join(" · ");
    var tag = v.current ? '<span class="of-ver-now">' + t("office.current") + '</span>' : "";
    var from = v.restoredFrom ? '<small class="of-ver-from">' + escapeHtml(t("office.restoredFrom", { n: Number(v.restoredFrom) })) + "</small>" : "";
    var actions = '<a class="att-btn" href="' + escapeHtml(o.downloadHref ? o.downloadHref(v.n) : "#") + '" download rel="noopener">' + t("office.downloadVersion") + '</a>';
    if (!v.current && o.canRestore) actions += '<button type="button" class="att-btn" data-of-restore="' + Number(v.n) + '">' + t("office.restoreVersion") + '</button>';
    return '<li class="of-ver"><div class="of-ver-main"><strong>v' + Number(v.n) + "</strong>" + tag + "<span>" + meta + "</span>" + from + '</div><div class="of-ver-actions">' + actions + "</div></li>";
  }).join("");
  return '<div class="of-history-head"><h2>' + t("office.history") + '</h2><button type="button" class="of-close" data-of-history-close aria-label="' + t("office.close") + '">' + t("office.close") + '</button></div>' +
    '<p class="of-history-note">' + escapeHtml(t("office.historyNote")) + (o.canRestore ? "" : " " + escapeHtml(t("office.historyViewOnly"))) + "</p>" +
    (o.message ? '<p class="of-history-msg" role="status">' + escapeHtml(o.message) + "</p>" : "") +
    (rows ? '<ol class="of-vers">' + rows + "</ol>" : '<p class="of-history-note">' + t("office.noVersions") + '</p>');
}

export function restoreMessage(status, body) {
  if (status === 409) return body && body.message || t("office.restoreBusy");
  if (status === 404) return t("office.restoreForbidden");
  return t("office.restoreFailed");
}

// --- New document sheet ---------------------------------------------------------------

export function newDocSheetHtml(sel, name, error) {
  var tiles = NEW_TYPES.map(function (t) {
    var on = t.type === sel;
    return '<label class="of-tile' + (on ? " is-on" : "") + '"><input type="radio" name="of-new-type" value="' + t.type + '"' + (on ? " checked" : "") + '><span class="of-tile-ext">' + t.type.toUpperCase() +
      '</span><span class="of-tile-text"><strong>' + escapeHtml(t.label) + "</strong><small>" + escapeHtml(t.sub) + "</small></span></label>";
  }).join("");
  var chosen = NEW_TYPES.filter(function (t) { return t.type === sel; })[0] || NEW_TYPES[0];
  return '<div class="att-sheet-scrim" data-of-sheet-close></div><div class="att-sheet of-sheet" role="dialog" aria-modal="true" aria-labelledby="of-new-title">' +
    '<h2 id="of-new-title">' + t("office.newDoc") + '</h2><p class="att-sheet-note">' + t("office.newDocNote") + '</p>' +
    '<div class="of-tiles" role="radiogroup" aria-label="' + t("office.docKind") + '">' + tiles + "</div>" +
    '<label class="of-name-label" for="of-new-name">' + t("office.name") + '</label><input id="of-new-name" class="of-name-input" type="text" maxlength="80" autocomplete="off" placeholder="' + escapeHtml(chosen.defaultName) + '" value="' + escapeHtml(name || "") + '">' +
    '<p class="att-sheet-error" role="alert"' + (error ? "" : " hidden") + ">" + escapeHtml(error || "") + "</p>" +
    '<div class="att-sheet-actions"><button type="button" class="att-btn" data-of-sheet-close>' + t("office.cancel") + '</button><button type="button" class="att-btn att-primary" data-of-new-create>' + t("office.createOpen") + '</button></div></div>';
}

export function newDocError(status, code) {
  if (code === "quota") return t("office.errQuota");
  if (code === "rate_limited") return t("office.errRate");
  if (status === 404) return t("office.errNoCreate");
  return t("office.errCreate");
}

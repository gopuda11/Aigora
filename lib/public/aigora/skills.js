// skills.js - the 스킬 sheet (room skills v1): catalog list with switches, detail with full text, and the admin's
// install (ZIP or host picker) and review-before-approve flow. It also drives the quiet "스킬 N" indicator and
// unlocks the composer "+" menu item once the server says the feature is on. The server is authoritative for every
// permission; this module only shows what the server's skills_state allows.
//
// initSkills({ els: { root, bar, chip, menuItem, plus, live }, send, getContext, isConnected, toast })
//   getContext() -> { roomId, scope: "room" | "private" } | null; onChange() after the outside indicators changed
// Returns { open(opener), close(), handle(msg), onContextChanged(), setConnected(bool), isOpen() }.

import { escapeHtml as esc } from "../modules/escape-html.js";
import { t, onLangChange } from "./i18n.js";
import { visibleRows, showSearch, scopeCopy, footerNote, indicatorText, sizeLabel, dateLabel, sourceLabel, zipProblem, rejectLines, lintLines, failureText,
  rejectHelp, scriptBadge, scriptConfirm, scriptFiles, binaryFiles, hasScripts, approveEnabled, extractGithubLink, commitLabel, sourceHref, gitStepText, pluginNote, updateLines } from "./skills-model.js";

function toBase64(buf) {
  var bytes = new Uint8Array(buf), out = "";
  for (var i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

export function initSkills(opts) {
  var els = opts.els;
  var state = null;            // last skills_state for `key`
  var key = null;              // "<roomId>|<scope>" the state belongs to
  var view = { name: "list" };
  var query = "";
  var busy = "";               // text while a request is in flight
  var opener = null;
  var openNow = false;
  var toggledThisSession = false;
  var detail = null, hostNames = null, draft = null, confirmedScripts = false;
  var gitUrl = "", gitProblem = "", cands = null, picked = {}, updateInfo = null;

  function sig(st) { return (st.skills || []).filter(function (x) { return x.enabled; }).map(function (x) { return x.id + (x.updateAvailable ? "+" : ""); }).join(); }
  function ctx() { return opts.getContext ? opts.getContext() : null; }
  function ctxKey(c) { return c ? c.roomId + "|" + c.scope : null; }
  function say(text) { if (els.live) els.live.textContent = text || ""; }
  function request(type, extra) {
    var c = ctx();
    if (!c) return false;
    return opts.send(Object.assign({ type: type, roomId: c.roomId, scope: c.scope }, extra || {}));
  }
  function refresh() { if (opts.isConnected() && ctx()) request("skills_list"); }

  // ---- outside the sheet: menu item, indicator, plus dot -----------------------------------------------------------
  function syncOutside() {
    var on = !!(state && state.enabled && ctxKey(ctx()) === key);
    if (els.menuItem) {
      var small = els.menuItem.querySelector("small");
      if (on) {
        els.menuItem.removeAttribute("aria-disabled");
        if (small) small.textContent = state.isAdmin || state.canInstall ? t("skills.menuAdmin") : t("skills.menuReady");
      } else {
        els.menuItem.setAttribute("aria-disabled", "true");
        if (small) small.textContent = t("skills.menuOff");
      }
    }
    var count = on ? state.enabledCount || 0 : 0;
    if (els.bar && els.chip) {
      els.chip.textContent = indicatorText(count);
      els.chip.setAttribute("aria-label", count > 0 ? t("skills.chipAria", { count: count }) : t("skills.title"));
      els.bar.classList.toggle("hidden", !(count > 0));
    }
    if (els.plus) els.plus.classList.toggle("has-skill-dot", toggledThisSession && on);
    if (opts.onChange) opts.onChange();
  }

  // ---- rendering ----------------------------------------------------------------------------------------------------
  function head(title, back) {
    return '<div class="ai-skills-head">' +
      (back ? '<button type="button" class="ai-skills-back" data-skills-back aria-label="' + esc(t("skills.back")) + '">‹</button>' : "") +
      '<h2 id="ai-skills-title">' + esc(title) + "</h2>" +
      '<button type="button" class="ai-skills-x" data-skills-close aria-label="' + esc(t("skills.close")) + '">×</button></div>';
  }
  function row(s) {
    var canToggle = !!state.canToggle;
    return '<li class="ai-skill-row' + (s.enabled ? " is-on" : "") + '" data-skill-row="' + esc(s.id) + '">' +
      '<button type="button" class="ai-skill-open" data-skill-open="' + esc(s.id) + '"><strong>' + esc(s.name) + "</strong>" +
      '<span class="ai-skill-desc">' + esc(s.description) + "</span>" +
      '<span class="ai-skill-meta"><span class="ai-skill-chip">v' + esc(s.version) + "</span>" +
      (s.roomScoped ? '<span class="ai-skill-chip">' + esc(t("skills.roomOnly")) + '</span>' : "") + (s.updateAvailable ? '<span class="ai-skill-chip is-update">' + esc(t("skills.updateAvailable")) + '</span>' : "") + "</span></button>" +
      '<button type="button" class="ai-skill-toggle" role="switch" aria-checked="' + (s.enabled ? "true" : "false") + '" aria-label="' + esc(t("skills.useSkill", { name: s.name })) + '"' +
      (canToggle ? "" : ' aria-disabled="true"') + ' data-skill-toggle="' + esc(s.id) + '"><span class="ai-skill-track" aria-hidden="true"></span></button></li>';
  }
  function listView() {
    if (!state) return head(t("skills.title")) + '<p class="ai-skills-empty" role="status">' + esc(busy || t("skills.loading")) + "</p>";
    if (state.error) return head(t("skills.title")) + '<p class="ai-skills-empty">' + esc(t("skills.loadError")) + '</p>';
    var copy = scopeCopy(state), rows = visibleRows(state, query);
    var out = head(t("skills.title")) + '<p class="ai-skills-sub">' + esc(copy.sub) + "</p>";
    if (copy.who) out += '<p class="ai-skills-who" role="note">' + esc(copy.who) + "</p>";
    if (showSearch(state)) out += '<input type="search" class="ai-skills-search" data-skills-search placeholder="' + esc(t("skills.searchLabel")) + '" aria-label="' + esc(t("skills.searchLabel")) + '" value="' + esc(query) + '" autocomplete="off">';
    if (!state.skills.length) out += '<p class="ai-skills-empty">' + esc(t("skills.emptyNone") + " " + (state.canInstall ? t("skills.emptyCanInstall") : t("skills.emptyCannotInstall"))) + "</p>";
    else if (!rows.length) out += '<p class="ai-skills-empty">' + esc(t("skills.noResults")) + '</p>';
    else out += '<ul class="ai-skills-list">' + rows.map(row).join("") + "</ul>";
    if (state.drafts && state.drafts.length) {
      out += '<h3 class="ai-skills-h">' + esc(t("skills.pendingReview")) + '</h3><ul class="ai-skills-list">' + state.drafts.map(function (d) {
        return '<li class="ai-skill-row"><button type="button" class="ai-skill-open" data-skill-review="' + esc(d.id) + '"><strong>' + esc(d.name) + "</strong>" +
          '<span class="ai-skill-desc">' + esc(d.description) + '</span><span class="ai-skill-meta"><span class="ai-skill-chip is-update">' + esc(t("skills.reviewDraft", { version: d.version })) + "</span></span></button></li>";
      }).join("") + "</ul>";
    }
    out += '<p class="ai-skills-note">' + esc(footerNote()) + "</p>";
    if (state.canInstall) out += '<div class="ai-skills-actions"><button type="button" class="ai-skills-btn is-primary" data-skills-install>' + esc(t("skills.addSkill")) + '</button></div>';
    return out;
  }
  function pre(f) { return '<section class="ai-skill-file"><h4>' + esc(f.path) + '</h4><pre tabindex="0" aria-label="' + esc(t("skills.fullContentOf", { path: f.path })) + '">' + esc(f.text) + "</pre></section>"; }
  // Badge, script list and binary list for a skill's files (empty when the skill is plain text).
  function assetBlock(files) {
    var sc = scriptFiles(files), bin = binaryFiles(files), out = "";
    if (sc.length) out += '<p class="ai-skill-badge is-script" role="note">' + esc(scriptBadge()) + '</p><h3 class="ai-skills-h">' + esc(t("skills.scriptsHeading", { count: sc.length })) + "</h3>" +
      '<ul class="ai-skill-files">' + sc.map(function (f) { return "<li><code>" + esc(f.path) + "</code><span>" + esc(sizeLabel(f.size)) + "</span></li>"; }).join("") + "</ul>";
    if (bin.length) out += '<h3 class="ai-skills-h">' + esc(t("skills.binariesHeading", { count: bin.length })) + "</h3>" +
      '<ul class="ai-skill-files">' + bin.map(function (f) { return "<li><code>" + esc(f.path) + "</code><span>" + esc(f.label + " · " + sizeLabel(f.size)) + "</span></li>"; }).join("") + "</ul>";
    return out;
  }
  function fileList(files) {
    return '<ul class="ai-skill-files">' + (files || []).map(function (f) { return "<li><code>" + esc(f.path) + "</code><span>" + esc(sizeLabel(f.size)) + "</span></li>"; }).join("") + "</ul>";
  }
  function sourceLink(src) {
    var href = sourceHref(src);
    return href ? '<a data-skill-source-link href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + esc(src.repo) + "</a>" : esc(sourceLabel(src));
  }
  // Where a git skill came from: the link and the exact commit it is pinned to.
  function gitFacts(src) {
    if (!src || src.kind !== "git") return "";
    return '<p class="ai-skill-hash" data-skill-source>' + esc(t("skills.sourceHeading")) + ' ' + sourceLink(src) + " · " + t("skills.pinnedTo", { commit: "<code>" + esc(commitLabel(src.commit)) + "</code>" }) +
      (src.ref ? " · " + esc(src.ref) : "") + (src.path ? " · <code>" + esc(src.path) + "</code>" : "") + (src.fetched_at ? " · " + t("skills.fetchedOn", { date: esc(dateLabel(src.fetched_at)) }) : "") + "</p>" +
      (pluginNote(src.plugins) ? '<p class="ai-skill-hash">' + esc(pluginNote(src.plugins)) + "</p>" : "");
  }
  function updateBlock(s) {
    if (!state.isAdmin || !s.source || s.source.kind !== "git") return "";
    var out = '<h3 class="ai-skills-h">' + esc(t("skills.updateHeading")) + '</h3>';
    var lines = updateInfo && updateInfo.id === s.id ? updateLines(updateInfo) : [];
    if (lines.length) {
      out += '<ul class="ai-skill-updates" role="status">' + lines.map(function (l) { return "<li>" + esc(l) + "</li>"; }).join("") + "</ul>";
      if (!updateInfo.upToDate && !updateInfo.identical) out += '<div class="ai-skills-actions"><button type="button" class="ai-skills-btn is-primary" data-skill-update-apply="' + esc(updateInfo.fetchId) + '">' + esc(t("skills.updateReview")) + '</button></div>';
    }
    out += '<div class="ai-skills-actions"><button type="button" class="ai-skills-btn" data-skill-update-check="' + esc(s.id) + '"' + (busy ? " disabled" : "") + ">" + esc(t("skills.updateCheck")) + "</button></div>";
    return out + (busy ? '<p class="ai-skills-busy" role="status">' + esc(busy) + "</p>" : "");
  }
  function detailView() {
    var s = null;
    ((state && state.skills) || []).forEach(function (x) { if (x.id === view.id) s = x; });
    if (!s) return head(t("skills.title"), true) + '<p class="ai-skills-empty">' + esc(t("skills.skillGone")) + '</p>';
    var out = head(s.name, true) + '<p class="ai-skills-sub">' + esc(s.description) + "</p>" +
      '<p class="ai-skill-meta"><span class="ai-skill-chip">v' + esc(s.version) + "</span>" + (s.enabled ? '<span class="ai-skill-chip is-on">' + esc(t("skills.inUse")) + '</span>' : "") + "</p>" +
      '<dl class="ai-skill-facts"><div><dt>' + esc(t("skills.approvedLabel")) + '</dt><dd>' + esc((s.approvedByName || "") + " · " + dateLabel(s.approvedAt)) + "</dd></div><div><dt>" + esc(t("skills.sourceDt")) + "</dt><dd>" + sourceLink(s.source) + "</dd></div></dl>" + gitFacts(s.source) +
      '<h3 class="ai-skills-h">' + esc(t("skills.filesHeading")) + '</h3>' + fileList(s.files) + assetBlock(s.files);
    if (state.canToggle && s.updateAvailable) out += '<div class="ai-skills-actions"><button type="button" class="ai-skills-btn" data-skill-upgrade="' + esc(s.id) + '">' + esc(t("skills.switchVersion")) + '</button></div>';
    if (detail && detail.id === s.id) out += '<h3 class="ai-skills-h">' + esc(t("skills.fullContent")) + '</h3>' + detail.texts.map(pre).join("");
    else out += '<div class="ai-skills-actions"><button type="button" class="ai-skills-btn" data-skill-fulltext="' + esc(s.id) + '">' + esc(t("skills.showFull")) + '</button></div>';
    out += updateBlock(s);
    if (s.canRemove) {
      out += view.confirmRemove === s.id
        ? '<p class="ai-skills-warn" role="alert">' + esc(s.roomScoped ? t("skills.removeConfirmRoom") : t("skills.removeConfirmAll")) + '</p><div class="ai-skills-actions"><button type="button" class="ai-skills-btn" data-skills-back>' + esc(t("skills.cancel")) + '</button><button type="button" class="ai-skills-btn is-danger" data-skill-remove-confirm="' + esc(s.id) + '">' + esc(t("skills.delete")) + '</button></div>'
        : '<div class="ai-skills-actions"><button type="button" class="ai-skills-btn is-danger-ghost" data-skill-remove="' + esc(s.id) + '">' + (s.roomScoped ? esc(t("skills.removeRoom")) : esc(t("skills.removeCatalog"))) + "</button></div>";
    }
    return out;
  }
  function installView() {
    return head(t("skills.addTitle"), true) +
      '<p class="ai-skills-sub">' + esc(t("skills.addSub")) + '</p>' +
      '<div class="ai-skills-git">' +
      '<label class="ai-skills-git-label" for="ai-skills-git-url">' + esc(t("skills.gitLabel")) + '</label>' +
      '<p class="ai-skills-git-sub">' + esc(t("skills.gitSub")) + '</p>' +
      '<div class="ai-skills-git-row"><input id="ai-skills-git-url" class="ai-skills-git-input" type="text" inputmode="url" enterkeyhint="go" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="https://github.com/…" value="' + esc(gitUrl) + '"' + (busy ? " disabled" : "") + '>' +
      '<button type="button" class="ai-skills-btn is-primary" data-skills-git-go' + (busy ? " disabled" : "") + ">" + esc(t("skills.fetch")) + "</button></div>" +
      (gitProblem ? '<p class="ai-skills-warn" role="alert">' + esc(gitProblem) + "</p>" : "") +
      '<p class="ai-skills-note">' + esc(t("skills.gitNote")) + '</p></div>' +
      (busy ? '<p class="ai-skills-busy" role="status">' + esc(busy) + "</p>" : "") +
      '<h3 class="ai-skills-h">' + esc(t("skills.otherWays")) + '</h3>' +
      '<div class="ai-skills-choices">' +
      '<button type="button" class="ai-skills-choice" data-skills-pick-zip><strong>' + esc(t("skills.uploadFile")) + '</strong><small>' + esc(t("skills.uploadFileHint")) + '</small></button>' +
      (state && state.isAdmin ? '<button type="button" class="ai-skills-choice" data-skills-host><strong>' + esc(t("skills.fromHost")) + '</strong><small>' + esc(t("skills.fromHostHint")) + '</small></button>' : "") + "</div>" +
      '<input id="ai-skills-file" type="file" accept=".zip,application/zip" hidden>' +
      '<p class="ai-skills-note">' + esc(t("skills.noExtras")) + '</p>';
  }
  function pickView() {
    var c = cands;
    if (!c) return head(t("skills.pickTitle"), true) + '<p class="ai-skills-empty">' + esc(t("skills.pickGone")) + '</p>';
    var okCount = c.candidates.filter(function (x) { return x.ok; }).length, n = Object.keys(picked).filter(function (k) { return picked[k]; }).length;
    var out = head(t("skills.pickTitle"), true) + '<p class="ai-skills-sub">' + esc(t("skills.pickSub")) + '</p>' + gitFacts(Object.assign({ url: c.source.url, repo: c.source.repo }, c.source, { plugins: c.plugins, path: "" }));
    out += '<ul class="ai-skills-list">' + c.candidates.map(function (x) {
      var where = x.path || t("skills.repoRoot");
      if (!x.ok) {
        return '<li class="ai-skill-row is-rejected"><div class="ai-skill-pick"><span><strong>' + esc(x.name) + '</strong> <span class="ai-skill-chip is-update">' + esc(t("skills.cannotAdd")) + '</span><span class="ai-skill-desc"><code>' + esc(where) + "</code></span>" +
          '<ul class="ai-skills-rejects">' + rejectLines(x.errors).map(function (l) { return "<li>" + esc(l.text) + (l.path ? " <code>" + esc(l.path) + "</code>" : "") + "</li>"; }).join("") + "</ul></span></div></li>";
      }
      return '<li class="ai-skill-row"><label class="ai-skill-pick"><input type="checkbox" data-skill-git-pick="' + esc(x.path) + '"' + (picked[x.path] ? " checked" : "") + (busy ? " disabled" : "") + ">" +
        "<span><strong>" + esc(x.name) + '</strong><span class="ai-skill-desc">' + esc(x.description) + '</span><span class="ai-skill-desc"><code>' + esc(where) + "</code> · " + esc(t("skills.fileCountSize", { count: Number(x.files) || 0, size: sizeLabel(x.size) })) + "</span></span></label></li>";
    }).join("") + "</ul>";
    if (c.truncated) out += '<p class="ai-skills-note">' + esc(t("skills.truncated")) + '</p>';
    if (c.candidates.some(function (x) { return !x.ok; })) out += '<p class="ai-skills-note">' + esc(rejectHelp()) + "</p>";
    out += '<div class="ai-skills-actions is-sticky">' + (okCount > 1 ? '<button type="button" class="ai-skills-btn" data-skills-git-all>' + (n === okCount ? esc(t("skills.deselectAll")) : esc(t("skills.selectAll"))) + "</button>" : "") +
      '<button type="button" class="ai-skills-btn is-primary" data-skills-git-pickgo' + (n && !busy ? "" : " disabled") + ">" + (n ? esc(t("skills.reviewSelected", { count: n })) : esc(t("skills.pickSome"))) + "</button></div>";
    return out + (busy ? '<p class="ai-skills-busy" role="status">' + esc(busy) + "</p>" : "");
  }
  function hostView() {
    var out = head(t("skills.hostTitle"), true) + '<p class="ai-skills-sub">' + esc(t("skills.hostSub")) + '</p>';
    if (!hostNames) return out + '<p class="ai-skills-empty" role="status">' + esc(t("skills.loading")) + '</p>';
    if (!hostNames.length) return out + '<p class="ai-skills-empty">' + esc(t("skills.hostNone")) + '</p>';
    return out + '<ul class="ai-skills-list">' + hostNames.map(function (n) {
      return '<li class="ai-skill-row"><button type="button" class="ai-skill-open" data-skill-host-pick="' + esc(n) + '"><strong>' + esc(n) + "</strong></button></li>";
    }).join("") + "</ul>" + (busy ? '<p class="ai-skills-busy" role="status">' + esc(busy) + "</p>" : "");
  }
  function rejectedView() {
    return head(t("skills.rejectedTitle"), true) + '<p class="ai-skills-sub">' + esc(t("skills.rejectedSub")) + '</p><ul class="ai-skills-rejects">' +
      rejectLines(view.errors).map(function (l) { return "<li>" + esc(l.text) + (l.path ? " <code>" + esc(l.path) + "</code>" : "") + "</li>"; }).join("") + "</ul>" +
      '<p class="ai-skills-note">' + esc(rejectHelp()) + "</p>" +
      '<div class="ai-skills-actions"><button type="button" class="ai-skills-btn is-primary" data-skills-install>' + esc(t("skills.addAnother")) + '</button></div>';
  }
  function reviewView() {
    if (!draft) return head(t("skills.reviewTitle"), true) + '<p class="ai-skills-empty" role="status">' + esc(t("skills.loading")) + '</p>';
    var d = draft, lint = lintLines(d.lint);
    return head(t("skills.reviewTitle"), true) +
      '<p class="ai-skills-sub">' + esc(t("skills.reviewSub")) + '</p>' +
      '<div class="ai-skill-review-head"><strong>' + esc(d.name) + '</strong> <span class="ai-skill-chip">v' + esc(d.version) + "</span> <span class=\"ai-skill-chip\">" + esc(sourceLabel(d.source)) + "</span></div>" +
      '<p class="ai-skills-sub">' + esc(d.description) + "</p>" + gitFacts(d.source) +
      '<p class="ai-skill-hash">sha256 <code>' + esc(String(d.sha256).slice(0, 16)) + "…</code> · " + esc(sizeLabel(d.size)) + (d.replaces ? " · " + esc(t("skills.replaces")) : "") + "</p>" +
      (lint.length ? '<div class="ai-skills-warn" role="note"><strong>' + esc(t("skills.lintHeading")) + '</strong><ul>' + lint.map(function (l) { return "<li>" + esc(l) + "</li>"; }).join("") + "</ul></div>" : "") +
      '<h3 class="ai-skills-h">' + esc(t("skills.filesCount", { count: d.files.length })) + "</h3>" + fileList(d.files) + assetBlock(d.files) +
      '<h3 class="ai-skills-h">' + esc(t("skills.fullContent")) + '</h3>' + d.texts.map(pre).join("") +
      (hasScripts(d.files) ? '<label class="ai-skill-confirm"><input type="checkbox" data-skill-confirm-scripts' + (confirmedScripts ? " checked" : "") + "> " + esc(scriptConfirm()) + "</label>" : "") +
      '<div class="ai-skills-actions is-sticky"><button type="button" class="ai-skills-btn" data-skill-discard="' + esc(d.id) + '">' + esc(t("skills.discard")) + '</button>' +
      '<button type="button" class="ai-skills-btn is-primary" data-skill-approve="' + esc(d.id) + '"' + (busy || !approveEnabled(d.files, confirmedScripts) ? " disabled" : "") + ">" + esc(t("skills.approveAdd")) + "</button></div>";
  }
  function render() {
    if (!els.root) return;
    var views = { list: listView, detail: detailView, install: installView, host: hostView, rejected: rejectedView, review: reviewView, pick: pickView };
    var scroller = els.root.querySelector(".ai-skills-card"), top = scroller ? scroller.scrollTop : 0;
    var focusKey = null, a = els.root.ownerDocument.activeElement;
    if (a && els.root.contains(a)) focusKey = ["data-skill-toggle", "data-skill-open", "data-skills-search", "data-skill-git-pick"].map(function (k) { return a.hasAttribute && a.hasAttribute(k) ? [k, a.getAttribute(k)] : null; }).filter(Boolean)[0] || null;
    els.root.innerHTML = '<div class="ai-skills-scrim" data-skills-close></div><div class="ai-skills-card">' + (views[view.name] || listView)() + "</div>";
    var card = els.root.querySelector(".ai-skills-card");
    if (card && top) card.scrollTop = top;
    if (focusKey) {
      var again = els.root.querySelectorAll("[" + focusKey[0] + "]").filter(function (n) { return n.getAttribute(focusKey[0]) === focusKey[1]; })[0];
      if (again) again.focus();
    }
  }
  function go(name, extra) { view = Object.assign({ name: name }, extra || {}); busy = ""; render(); focusFirst(); }
  function focusFirst() {
    var f = els.root.querySelector("[data-skills-back]") || els.root.querySelector(".ai-skills-x");
    if (f) f.focus();
  }

  // ---- open / close ----------------------------------------------------------------------------------------------------
  function open(from) {
    var c = ctx();
    if (!c) { opts.toast(t("skills.pickRoomFirst")); return false; }
    if (state && state.enabled === false && ctxKey(c) === key) { opts.toast(t("skills.failDisabled")); return false; }
    opener = from === els.menuItem ? els.plus || null : from || null;   // the menu closes on select: focus returns to its button
    openNow = true;
    toggledThisSession = false;
    syncOutside();
    view = { name: "list" }; query = ""; detail = null; draft = null; hostNames = null; busy = ""; cands = null; updateInfo = null; gitProblem = "";
    els.root.classList.remove("hidden");
    render();
    refresh();
    var f = els.root.querySelector(".ai-skills-x");
    if (f) f.focus();
    return true;
  }
  function close() {
    if (!openNow) return;
    openNow = false;
    els.root.classList.add("hidden");
    els.root.innerHTML = "";
    if (opener && opener.focus) opener.focus();
  }
  function back() {
    if (view.name === "list") return close();
    if (view.name === "review" && draft) { /* leaving a draft keeps it in 검토 대기 */ }
    if (view.name === "host" || view.name === "rejected" || view.name === "pick") return go("install");
    detail = null; draft = null;
    go("list");
  }

  // ---- actions ---------------------------------------------------------------------------------------------------------
  function onClick(ev) {
    var el = ev.target && ev.target.closest ? ev.target : null;
    if (!el) return;
    var hit = function (attr) { return el.closest("[" + attr + "]"); };
    var b;
    if (hit("data-skills-close")) return close();
    if (hit("data-skills-back")) return back();
    if ((b = hit("data-skill-toggle"))) {
      if (b.getAttribute("aria-disabled") === "true") { opts.toast(t("skills.managersOnlyToast")); say(t("skills.managersOnlyToast")); return; }
      var id = b.getAttribute("data-skill-toggle"), on = b.getAttribute("aria-checked") !== "true";
      if (!request("skill_toggle", { id: id, on: on })) opts.toast(t("skills.offChange"));
      else b.setAttribute("aria-busy", "true");
      return;
    }
    if (hit("data-skills-git-go")) return submitGit();
    if ((b = hit("data-skill-update-check"))) {
      if (!request("skill_update_check", { id: b.getAttribute("data-skill-update-check") })) { opts.toast(t("skills.offCheck")); return; }
      updateInfo = null; busy = gitStepText("resolve", "skill_update_check"); render(); return;
    }
    if ((b = hit("data-skill-update-apply"))) { busy = t("skills.preparingNew"); render(); request("skill_update_apply", { fetchId: b.getAttribute("data-skill-update-apply") }); return; }
    if (hit("data-skills-git-all")) {
      var all = cands.candidates.filter(function (x) { return x.ok; }), every = all.every(function (x) { return picked[x.path]; });
      all.forEach(function (x) { picked[x.path] = !every; }); render(); return;
    }
    if (hit("data-skills-git-pickgo")) {
      var paths = Object.keys(picked).filter(function (k) { return picked[k]; });
      if (!paths.length || !cands) return;
      busy = t("skills.preparingContent"); render();
      if (!request("skill_git_pick", { fetchId: cands.fetchId, paths: paths })) { busy = ""; render(); opts.toast(t("skills.offProceed")); }
      return;
    }
    if ((b = hit("data-skill-open"))) { detail = null; updateInfo = null; return go("detail", { id: b.getAttribute("data-skill-open") }); }
    if ((b = hit("data-skill-upgrade"))) { request("skill_toggle", { id: b.getAttribute("data-skill-upgrade"), on: true, upgrade: true }); return; }
    if ((b = hit("data-skill-fulltext"))) { request("skill_detail", { id: b.getAttribute("data-skill-fulltext") }); return; }
    if (hit("data-skills-install")) return go("install");
    if (hit("data-skills-pick-zip")) { var inp = els.root.querySelector("#ai-skills-file"); if (inp) inp.click(); return; }
    if (hit("data-skills-host")) { hostNames = null; go("host"); request("skill_host_list"); return; }
    if ((b = hit("data-skill-host-pick"))) { busy = t("skills.checkingContent"); render(); request("skill_install_host", { name: b.getAttribute("data-skill-host-pick") }); return; }
    if ((b = hit("data-skill-review"))) { draft = null; go("review"); request("skill_draft_get", { id: b.getAttribute("data-skill-review") }); return; }
    if ((b = hit("data-skill-approve"))) {
      if (!draft || !approveEnabled(draft.files, confirmedScripts)) return;
      busy = t("skills.approving"); view.approving = true; render(); request("skill_approve", hasScripts(draft.files) ? { id: b.getAttribute("data-skill-approve"), confirmScripts: true } : { id: b.getAttribute("data-skill-approve") }); return;
    }
    if ((b = hit("data-skill-discard"))) { request("skill_discard", { id: b.getAttribute("data-skill-discard") }); draft = null; go("list"); return; }
    if ((b = hit("data-skill-remove"))) { view.confirmRemove = b.getAttribute("data-skill-remove"); render(); return; }
    if ((b = hit("data-skill-remove-confirm"))) { request("skill_remove", { id: b.getAttribute("data-skill-remove-confirm") }); detail = null; go("list"); return; }
  }
  function submitGit() {
    var link = extractGithubLink(gitUrl);
    if (!link) { gitProblem = t("skills.needLink"); render(); return; }
    gitProblem = ""; gitUrl = link;
    busy = gitStepText("resolve"); render();
    if (!request("skill_git_fetch", { url: link })) { busy = ""; gitProblem = t("skills.offFetch"); render(); }
  }
  // A link pasted anywhere in the sheet (even inside a sentence, or with the field not focused) lands in the field; 가져오기 stays a deliberate press.
  function onPaste(ev) {
    if (!openNow || view.name !== "install" || busy) return;
    var cd = ev.clipboardData, link = extractGithubLink(cd && cd.getData ? cd.getData("text") : "");
    if (!link) return;
    ev.preventDefault();
    gitUrl = link; gitProblem = "";
    var inp = els.root.querySelector("#ai-skills-git-url");
    if (inp) inp.value = link;
    say(t("skills.pasted"));
  }
  function onChange(ev) {
    var el = ev.target;
    if (el && el.getAttribute && el.getAttribute("data-skill-confirm-scripts") !== null) { confirmedScripts = !!el.checked; render(); return; }
    if (el && el.getAttribute && el.getAttribute("data-skill-git-pick") !== null) { picked[el.getAttribute("data-skill-git-pick")] = !!el.checked; render(); return; }
    if (!el || el.id !== "ai-skills-file") return;
    var file = el.files && el.files[0];
    el.value = "";
    if (!file) return;
    var problem = zipProblem(file);
    if (problem) { opts.toast(problem); say(problem); return; }
    busy = t("skills.checkingContent"); render();
    file.arrayBuffer().then(function (buf) {
      if (!request("skill_install_zip", { fileName: file.name, data: toBase64(buf) })) { busy = ""; render(); opts.toast(t("skills.offUpload")); }
    }, function () { busy = ""; render(); opts.toast(t("skills.readFail")); });
  }
  function onInput(ev) {
    var t = ev.target;
    if (t && t.id === "ai-skills-git-url") { gitUrl = t.value; return; }
    if (t && t.getAttribute && t.getAttribute("data-skills-search") !== null) { query = t.value; render(); var s = els.root.querySelector("[data-skills-search]"); if (s) { s.focus(); if (s.setSelectionRange) s.setSelectionRange(query.length, query.length); } }
  }
  function onKey(ev) {
    if (!openNow) return;
    if (ev.key === "Escape") { ev.preventDefault(); back(); return; }
    if (ev.key === "Enter" && ev.target && ev.target.id === "ai-skills-git-url") { ev.preventDefault(); gitUrl = ev.target.value; submitGit(); return; }
    if (ev.key !== "Tab") return;
    var ring = els.root.querySelectorAll("button,input,[tabindex]").filter(function (n) { return !n.hasAttribute("disabled") && !n.hasAttribute("hidden") && n.getAttribute("type") !== "file"; });
    if (!ring.length) return;
    var at = ring.indexOf(els.root.ownerDocument.activeElement);
    ev.preventDefault();
    ring[(at + (ev.shiftKey ? ring.length - 1 : 1) + ring.length) % ring.length].focus();
  }
  els.root.addEventListener("click", onClick);
  els.root.addEventListener("change", onChange);
  els.root.addEventListener("input", onInput);
  els.root.addEventListener("keydown", onKey);
  els.root.addEventListener("paste", onPaste);
  if (els.chip) els.chip.addEventListener("click", function () { open(els.chip); });

  // ---- server messages ---------------------------------------------------------------------------------------------------
  function handle(msg) {
    switch (msg.type) {
      case "skills_state": {
        var c = ctx();
        if (!c || String(msg.roomId) !== String(c.roomId) || msg.scope !== c.scope) return true;   // a stale answer for another context
        var before = state && key === ctxKey(c) ? sig(state) : null;
        state = msg; key = ctxKey(c);
        if (msg.enabled !== false && before !== null && before !== sig(msg)) {
          toggledThisSession = toggledThisSession || openNow;
          say(t("skills.changedLive"));
        }
        syncOutside();
        if (openNow) {
          if (view.name === "review" && view.approving) { draft = null; go("list"); say(t("skills.addedLive")); }
          else { if (view.name === "list") busy = ""; render(); }
        }
        return true;
      }
      case "skills_changed": refresh(); return true;
      case "skill_detail": detail = { id: msg.skill.id, texts: msg.skill.texts || [] }; if (openNow) render(); return true;
      case "skill_host_names": hostNames = Array.isArray(msg.names) ? msg.names : []; if (openNow && view.name === "host") render(); return true;
      case "skill_draft": draft = msg.draft; confirmedScripts = false; busy = ""; if (openNow) { if (view.name !== "review") go("review"); else { render(); focusFirst(); } } return true;
      case "skill_git_progress":
        if (busy) { busy = gitStepText(msg.step, msg.op); if (openNow) render(); }
        return true;
      case "skill_git_candidates": cands = msg; picked = {}; busy = ""; if (openNow) go("pick"); return true;
      case "skill_git_picked": {
        busy = ""; cands = null;
        var note = t("skills.pickedNote", { count: msg.count });
        opts.toast(note); say(note);
        if (openNow) go("list");
        return true;
      }
      case "skill_update_info": updateInfo = msg; busy = ""; if (openNow) render(); return true;
      case "skill_error": {
        busy = "";
        if (msg.code === "rejected" && openNow) { go("rejected", { errors: msg.errors }); return true; }
        var text = failureText(msg.code);
        opts.toast(text); say(text);
        if (openNow) render();
        return true;
      }
      default: return false;
    }
  }

  onLangChange(function () { syncOutside(); if (openNow) render(); });

  return {
    open: open, close: close, handle: handle, isOpen: function () { return openNow; },
    // For the phone sidebar's 스킬 row: is the feature on for this context, and how many skills are in use.
    status: function () {
      var on = !!(state && state.enabled && ctxKey(ctx()) === key);
      return { on: on, count: on ? state.enabledCount || 0 : 0 };
    },
    onContextChanged: function () { if (ctxKey(ctx()) !== key) { state = null; key = null; syncOutside(); if (openNow) { render(); } } refresh(); },
    setConnected: function (on) { if (on) refresh(); },
  };
}

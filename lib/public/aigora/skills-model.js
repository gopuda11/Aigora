// skills-model.js - Pure rules and Korean copy for the 스킬 sheet (room skills v1). No DOM, store or WS.
// The server decides every permission and validates every file; this only shapes what the sheet shows.

import { t, formatBytes, formatDate } from "./i18n.js";

export var ZIP_MAX_BYTES = 20 * 1024 * 1024;
export var SEARCH_THRESHOLD = 8;   // search appears only when there are more entries than this

// Server reject codes (lib/skills-validator.js) in plain Korean.
var REJECT = {
  zip_invalid: function () { return t("skills.rejectZipInvalid"); },
  zip_too_large: function () { return t("skills.rejectZipTooLarge"); },
  zip_encrypted: function () { return t("skills.rejectZipEncrypted"); },
  zip_unsupported: function () { return t("skills.rejectZipUnsupported"); },
  zip_bomb: function () { return t("skills.rejectZipBomb"); },
  unsafe_path: function () { return t("skills.rejectUnsafePath"); },
  symlink: function () { return t("skills.rejectSymlink"); },
  hardlink: function () { return t("skills.rejectHardlink"); },
  special_file: function () { return t("skills.rejectSpecialFile"); },
  duplicate_path: function () { return t("skills.rejectDuplicatePath"); },
  too_many_files: function () { return t("skills.rejectTooManyFiles"); },
  too_deep: function () { return t("skills.rejectTooDeep"); },
  file_too_large: function () { return t("skills.rejectFileTooLarge"); },
  total_too_large: function () { return t("skills.rejectTotalTooLarge"); },
  bad_extension: function () { return t("skills.rejectBadExtension"); },
  native_binary: function () { return t("skills.rejectNativeBinary"); },
  archive_file: function () { return t("skills.rejectArchiveFile"); },
  type_mismatch: function () { return t("skills.rejectTypeMismatch"); },
    forbidden_path: function () { return t("skills.rejectForbiddenPath"); },
  hidden_path: function () { return t("skills.rejectHiddenPath"); },
  nested_skill: function () { return t("skills.rejectNestedSkill"); },
  nul_byte: function () { return t("skills.rejectNulByte"); },
  not_utf8: function () { return t("skills.rejectNotUtf8"); },
  no_skill_md: function () { return t("skills.rejectNoSkillMd"); },
  multiple_roots: function () { return t("skills.rejectMultipleRoots"); },
  bad_frontmatter: function () { return t("skills.rejectBadFrontmatter"); },
  bad_name: function () { return t("skills.rejectBadName"); },
  bad_description: function () { return t("skills.rejectBadDescription"); },
  description_too_long: function () { return t("skills.rejectDescriptionTooLong"); },
  forbidden_frontmatter_key: function () { return t("skills.rejectForbiddenFrontmatterKey"); },
  not_found: function () { return t("skills.rejectNotFound"); },
};
// Request-level failures (skill_error.code).
var FAILURE = {
  forbidden: function () { return t("skills.failForbidden"); },
  disabled: function () { return t("skills.failDisabled"); },
  not_found: function () { return t("skills.failNotFound"); },
  already_installed: function () { return t("skills.failAlreadyInstalled"); },
  too_many_drafts: function () { return t("skills.failTooManyDrafts"); },
  catalog_full: function () { return t("skills.failCatalogFull"); },
  scripts_unconfirmed: function () { return t("skills.failScriptsUnconfirmed"); },
  hash_mismatch: function () { return t("skills.failHashMismatch"); },
  zip_too_large: function () { return t("skills.failZipTooLarge"); },
  rejected: function () { return t("skills.failRejected"); },
  git_bad_url: function () { return t("skills.failGitBadUrl"); },
  git_host_not_allowed: function () { return t("skills.failGitHostNotAllowed"); },
  git_repo_not_found: function () { return t("skills.failGitRepoNotFound"); },
  git_ref_not_found: function () { return t("skills.failGitRefNotFound"); },
  git_path_not_found: function () { return t("skills.failGitPathNotFound"); },
  git_no_skill: function () { return t("skills.failGitNoSkill"); },
  git_rate_limited: function () { return t("skills.failGitRateLimited"); },
  git_timeout: function () { return t("skills.failGitTimeout"); },
  git_too_large: function () { return t("skills.failGitTooLarge"); },
  git_network: function () { return t("skills.failGitNetwork"); },
  git_bad_archive: function () { return t("skills.failGitBadArchive"); },
  git_failed: function () { return t("skills.failGitFailed"); },
  git_busy: function () { return t("skills.failGitBusy"); },
  not_git_source: function () { return t("skills.failNotGitSource"); },
  name_changed: function () { return t("skills.failNameChanged"); },
  name_taken: function () { return t("skills.failNameTaken"); },
  failed: function () { return t("skills.failFailed"); },
};
var LINT = { runs_commands: function () { return t("skills.lintRunsCommands"); }, fetches_urls: function () { return t("skills.lintFetchesUrls"); },
  network_access: function () { return t("skills.lintNetworkAccess"); }, credential_path: function () { return t("skills.lintCredentialPath"); } };

export function rejectText(code) { return REJECT[code] ? REJECT[code]() : t("skills.rejectFallback"); }
export function failureText(code) { return (FAILURE[code] || FAILURE.failed)(); }
export function rejectLines(errors) {
  return (Array.isArray(errors) ? errors : []).slice(0, 12).map(function (e) {
    return { text: rejectText(e && e.code), path: e && typeof e.path === "string" && e.path ? e.path : "" };
  });
}
export function lintLines(notes) {
  return (Array.isArray(notes) ? notes : []).slice(0, 12).map(function (n) {
    return (LINT[n && n.code] ? LINT[n && n.code]() : t("skills.lintFallback")) + " · " + (n && n.path ? n.path : "") + (n && n.line ? ":" + n.line : "");
  });
}

export function indicatorText(count) { return count > 0 ? t("skills.indicator", { count: count }) : ""; }

/** Rows for the list: enabled first, then by name; filtered by `query` (name or description). */
export function visibleRows(state, query) {
  var q = String(query || "").trim().toLowerCase();
  var rows = (state && Array.isArray(state.skills) ? state.skills : []).filter(function (s) {
    return !q || String(s.name).toLowerCase().indexOf(q) !== -1 || String(s.description || "").toLowerCase().indexOf(q) !== -1;
  });
  return rows.slice().sort(function (a, b) {
    if (!!a.enabled !== !!b.enabled) return a.enabled ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}
export function showSearch(state) { return !!state && Array.isArray(state.skills) && state.skills.length > SEARCH_THRESHOLD; }

/** What the sheet says about who is changing the set. */
export function scopeCopy(state) {
  if (state && state.scope === "private") return { sub: t("skills.scopePrivateSub"), who: t("skills.scopePrivateWho") };
  return { sub: t("skills.scopeRoomSub"), who: state && state.canToggle ? "" : state && state.skillManagers === "members" ? t("skills.scopeMembersOnly") : t("skills.scopeManagersOnly") };
}
export function footerNote() { return t("skills.footerNote"); }

export function sizeLabel(bytes) {
  var n = Number(bytes) || 0;
  return formatBytes(n);
}
export function dateLabel(ts) {
  var d = new Date(Number(ts) || 0);
  return isNaN(d.getTime()) || !ts ? "" : formatDate(d.getTime());
}
export function sourceLabel(src) {
  if (!src) return "";
  return src.kind === "git" ? "GitHub" : src.kind === "host" ? t("skills.sourceHost") : t("skills.sourceZip");
}
export function rejectHelp() { return t("skills.rejectHelp"); }

// First GitHub link inside whatever was pasted (a sentence, a chat message, a git@ remote). "" when there is none.
export function extractGithubLink(text) {
  var m = /(?:https?:\/\/(?:www\.)?(?:github\.com|raw\.githubusercontent\.com)\/|git@github\.com:|(?:^|[\s(<"'])(?=github\.com\/))[^\s<>"'`]*/i.exec(String(text || ""));
  if (!m) return "";
  var link = m[0].replace(/^[\s(<"']+/, "").replace(/[)\].,;:!?'"]+$/, "");
  return /^github\.com\//i.test(link) || /^(https?:\/\/|git@)/i.test(link) ? link : "";
}
export function commitLabel(sha) { return String(sha || "").slice(0, 7); }
/** Safe link target for a git source: only https://github.com/ ever becomes an href. */
export function sourceHref(src) {
  return src && src.kind === "git" && typeof src.url === "string" && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\/|$)/.test(src.url) ? src.url : "";
}
var GIT_STEP = { resolve: function () { return t("skills.gitStepResolve"); }, fetch: function () { return t("skills.gitStepFetch"); }, scan: function () { return t("skills.scanning"); } };
var UPDATE_STEP = { resolve: function () { return t("skills.updStepResolve"); }, fetch: function () { return t("skills.updStepFetch"); }, scan: function () { return t("skills.scanning"); } };
export function gitStepText(step, op) { return ((op === "skill_update_check" ? UPDATE_STEP : GIT_STEP)[step] || GIT_STEP.resolve)(); }
var IGNORED = { hooks: function () { return t("skills.ignoredHooks"); }, commands: function () { return t("skills.ignoredCommands"); }, agents: function () { return t("skills.ignoredAgents"); }, mcp: function () { return "MCP"; } };
/** Plain-Korean note about plugin parts that were not taken. "" when the repo is not a plugin or nothing was skipped. */
export function pluginNote(plugins) {
  var parts = [];
  (Array.isArray(plugins) ? plugins : []).forEach(function (p) {
    (p && Array.isArray(p.ignored) ? p.ignored : []).forEach(function (k) { if (IGNORED[k] && parts.indexOf(IGNORED[k]()) === -1) parts.push(IGNORED[k]()); });
  });
  var any = Array.isArray(plugins) && plugins.length > 0;
  if (!any) return "";
  return t("skills.pluginNote") + (parts.length ? " " + t("skills.pluginIgnored", { parts: parts.join(", ") }) : "");
}
/** Lines for the update check result. */
export function updateLines(info) {
  var out = [];
  if (!info) return out;
  if (info.upToDate) return [t("skills.upToDate", { commit: commitLabel(info.commit) })];
  out.push(info.ref ? t("skills.newCommitRef", { commit: commitLabel(info.commit), ref: info.ref }) : t("skills.newCommit", { commit: commitLabel(info.commit) }));
  if (info.identical) { out.push(t("skills.identical")); return out; }
  var d = info.diff || {};
  (d.added || []).slice(0, 20).forEach(function (p) { out.push(t("skills.diffAdded", { path: p })); });
  (d.removed || []).slice(0, 20).forEach(function (p) { out.push(t("skills.diffRemoved", { path: p })); });
  (d.changed || []).slice(0, 20).forEach(function (c) { out.push(t("skills.diffChanged", { path: c.path, plus: c.plus, minus: c.minus })); });
  return out;
}
export function zipProblem(file) {
  if (!file || !/\.zip$/i.test(String(file.name || ""))) return t("skills.zipOnly");
  if (file.size > ZIP_MAX_BYTES) return t("skills.failZipTooLarge");
  if (!file.size) return t("skills.zipEmpty");
  return "";
}
/** The scope the sheet acts on, from what the client knows. Private-channel owners edit their own set. */
export function contextScope(access) {
  return access && access.isPrivate && access.owner && !access.readOnly ? "private" : "room";
}

// ---- scripts and binary assets (review and detail) --------------------------------------------------------------------
export function scriptBadge() { return t("skills.scriptBadge"); }
export function scriptConfirm() { return t("skills.scriptConfirm"); }
var BINARY_TYPE = { font: function () { return t("skills.typeFont"); }, image: function () { return t("skills.typeImage"); }, pdf: function () { return t("skills.typePdf"); }, office: function () { return t("skills.typeOffice"); } };
/** Files the server classed as scripts: [{ path, size }]. */
export function scriptFiles(files) { return (Array.isArray(files) ? files : []).filter(function (f) { return f && f.kind === "script"; }); }
/** Binary assets: [{ path, size, label }] (listed by name, size and type; never dumped). */
export function binaryFiles(files) {
  return (Array.isArray(files) ? files : []).filter(function (f) { return f && f.kind === "binary"; })
    .map(function (f) { return { path: f.path, size: f.size, label: BINARY_TYPE[f.type] ? BINARY_TYPE[f.type]() : t("skills.typeFile") }; });
}
export function hasScripts(files) { return scriptFiles(files).length > 0; }
/** The approve button is enabled unless scripts are present and the admin has not ticked the confirmation. */
export function approveEnabled(files, confirmed) { return !hasScripts(files) || confirmed === true; }

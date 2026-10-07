// i18n.js - Korean/English UI text for the standalone Aigora page (and the legacy modules it shares).
//
//   t(key, params)        text for the current language; "{name}" is replaced from params
//   plural forms          a dictionary value may be { one: "{count} file", other: "{count} files" };
//                         t("files.n", { count: 3 }) picks the form by Intl.PluralRules (Korean only has "other")
//   getLang() / setLang(lang, { persist }) / onLangChange(fn) -> unsubscribe
//   applyDom(root)        translates static markup: data-i18n="key" (textContent) and
//                         data-i18n-attr="placeholder:key; aria-label:key; title:key"
//   formatRelativeTime(ts) formatDate(ts) formatTime(ts) formatNumber(n) formatBytes(n)   (Intl, current language)
//
// "ko" is the default and the fallback: a key missing in "en" shows the Korean text (and warns once on the
// console, except in production). A key missing in both shows the key itself.
//
// ---- Converting a module (conversion guide) ----------------------------------------------------------------
// 1. Pick the namespace = the module file name without "-model" (chat-model.js + chat.js -> "chat"). Keys are
//    "<namespace>.<camelCaseName>", e.g. "composer.send", "settings.themeHint". The same namespace may be used
//    from several files. Never use another module's namespace.
// 2. Fill the namespace files i18n/ko/<ns>.js and i18n/en/<ns>.js (they already exist, empty, for every module that
//    had Korean text). Each exports `export default { "ns.key": "text", ... }`, same keys in both languages,
//    same {placeholders} in both. The ko text is the original string, unchanged.
// 3. In code: `import { t } from "./i18n.js";` (from modules/: "../aigora/i18n.js") and write t("ns.key") with a
//    string LITERAL key (the coverage test greps literals; a computed key is invisible to it). Dynamic choices:
//    write one literal per branch, e.g. mode === "member" ? t("composer.toMember") : t("composer.toAi").
//    Parameters: t("room.members", { count: n }); never concatenate translated fragments - one sentence, one key.
// 4. Static HTML (aigora/index.html): data-i18n="ns.key" / data-i18n-attr="placeholder:ns.key". Keep the Korean text
//    in the markup as the no-JS default; applyDom() replaces it at boot and on every language change.
// 5. Text drawn once (a list, a popover) must be redrawn on a switch: call onLangChange(render) where the module
//    wires itself up (see settings.js, client.js renderSendMode). Text that is built on demand (menus opened
//    later, toasts) needs nothing.
// 6. Do NOT translate: user content (messages, nicknames, room and session names, file names), AI output, ids and
//    protocol values, server error strings you only pass through, code/log text. Product names (Claude, Codex,
// 7. Run `node --test test/i18n-coverage.test.js` (or npm test): it fails when a t("...")/data-i18n key is not in
//    both languages, when ko and en differ in keys or {placeholders}, or when i18n/index.js is stale.
// 8. Adding a NEW namespace (rare): create i18n/ko/<ns>.js and i18n/en/<ns>.js, then `node scripts/gen-i18n-index.js`
//    (i18n/index.js is generated, one import per file; if it conflicts in a merge, just regenerate it).
// ------------------------------------------------------------------------------------------------------------

import { DICTS } from "./i18n/index.js";

export var LANG_KEY = "aigora.lang";
export var LANGS = ["ko", "en"];
export var DEFAULT_LANG = "ko";

var lang = DEFAULT_LANG;
var listeners = [];
var warned = {};

export function normalizeLang(value) {
  return value === "en" || value === "ko" ? value : null;
}

// ko* -> ko, anything else -> en. The default of a first visit.
export function langFromNavigator(nav) {
  var n = nav === undefined ? (typeof navigator !== "undefined" ? navigator : null) : nav;
  var tag = (n && (n.language || (n.languages && n.languages[0]))) || "";
  return /^ko($|[-_])/i.test(tag) || tag === "" ? "ko" : "en";
}

// Storage can be missing or throw (private mode): both mean "no saved choice".
export function readLang() {
  try { return normalizeLang(localStorage.getItem(LANG_KEY)); } catch (e) { return null; }
}
function saveLang(value) {
  try { localStorage.setItem(LANG_KEY, value); } catch (e) { /* applies for this visit only */ }
}

export function getLang() { return lang; }

// persist:false = apply without writing localStorage. Notifies listeners on a change.
export function setLang(value, options) {
  var next = normalizeLang(value);
  if (!next) return lang;
  if (!options || options.persist !== false) saveLang(next);
  var changed = next !== lang;
  lang = next;
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.setAttribute("lang", lang);
    // Containers that pin lang="ko" (CSS :lang(ko) word-breaking) follow the language too.
    if (document.querySelectorAll) document.querySelectorAll("[lang]").forEach(function (el) { if (el !== document.documentElement && normalizeLang(el.getAttribute("lang"))) el.setAttribute("lang", lang); });
  }
  if (changed) listeners.slice().forEach(function (entry) { try { entry.fn(lang); } catch (e) { /* a broken view must not stop the others */ } });
  return lang;
}

export function onLangChange(fn) {
  var entry = { fn: fn };
  listeners.push(entry);
  return function () { var i = listeners.indexOf(entry); if (i !== -1) listeners.splice(i, 1); };
}

function lookup(code, key) {
  var d = DICTS[code];
  return d && Object.prototype.hasOwnProperty.call(d, key) ? d[key] : undefined;
}

function isDev() {
  return !(typeof process !== "undefined" && process.env && process.env.NODE_ENV === "production");
}

function warnOnce(id, message) {
  if (warned[id] || !isDev() || typeof console === "undefined") return;
  warned[id] = true;
  console.warn("[i18n] " + message);
}

function interpolate(text, params) {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, function (m, name) { return Object.prototype.hasOwnProperty.call(params, name) && params[name] != null ? String(params[name]) : m; });
}

function pick(value, params, code) {
  if (value !== null && typeof value === "object") {
    var count = params && typeof params.count === "number" ? params.count : 0;
    var rule = "other";
    try { rule = new Intl.PluralRules(code).select(count); } catch (e) { /* keep "other" */ }
    return value[rule] != null ? value[rule] : value.other;
  }
  return value;
}

export function t(key, params) {
  var value = lookup(lang, key);
  var used = lang;
  if (value === undefined && lang !== DEFAULT_LANG) {
    value = lookup(DEFAULT_LANG, key);
    used = DEFAULT_LANG;
    if (value !== undefined) warnOnce(lang + ":" + key, 'missing "' + lang + '" text for "' + key + '", using ko');
  }
  if (value === undefined) {
    warnOnce("none:" + key, 'unknown key "' + key + '"');
    return key;
  }
  return interpolate(String(pick(value, params, used)), params);
}

var I18N_ATTRS = { "placeholder": true, "title": true, "alt": true, "aria-label": true, "aria-description": true, "aria-placeholder": true, "aria-roledescription": true, "aria-valuetext": true };

// Translate static markup under root (default: the whole document).
export function applyDom(root) {
  var scope = root || (typeof document !== "undefined" ? document : null);
  if (!scope || !scope.querySelectorAll) return;
  scope.querySelectorAll("[data-i18n]").forEach(function (el) { el.textContent = t(el.getAttribute("data-i18n")); });
  scope.querySelectorAll("[data-i18n-attr]").forEach(function (el) {
    String(el.getAttribute("data-i18n-attr")).split(";").forEach(function (pair) {
      var at = pair.indexOf(":");
      if (at <= 0) return;
      var name = pair.slice(0, at).trim();
      if (!I18N_ATTRS[name]) { warnOnce("attr:" + name, 'data-i18n-attr "' + name + '" is not allowed (plain-text attributes only)'); return; }
      el.setAttribute(name, t(pair.slice(at + 1).trim()));
    });
  });
}

// --- Formatting (Intl, current language) ---------------------------------------------------------------

function toMs(ts) { return typeof ts === "number" ? ts : new Date(ts).getTime(); }

export function formatNumber(n, options) {
  return new Intl.NumberFormat(lang, options).format(n);
}

export function formatDate(ts, options) {
  var ms = toMs(ts);
  if (!isFinite(ms)) return "";
  return new Intl.DateTimeFormat(lang, options || { year: "numeric", month: "short", day: "numeric" }).format(new Date(ms));
}

export function formatTime(ts, options) {
  var ms = toMs(ts);
  if (!isFinite(ms)) return "";
  return new Intl.DateTimeFormat(lang, options || { hour: "numeric", minute: "2-digit" }).format(new Date(ms));
}

// "방금" / "1시간 전" / "3일 전" / "2주 전"; a month or older -> the date. `now` is for tests.
export function formatRelativeTime(ts, now) {
  if (!ts) return "";
  var diff = (now === undefined ? Date.now() : now) - toMs(ts);
  if (!isFinite(diff)) return "";
  if (diff < 0) diff = 0;
  var sec = Math.floor(diff / 1000);
  if (sec < 60) return t("format.justNow");
  var rtf = new Intl.RelativeTimeFormat(lang, { numeric: "always", style: "long" });
  var min = Math.floor(sec / 60);
  if (min < 60) return rtf.format(-min, "minute");
  var hr = Math.floor(min / 60);
  if (hr < 24) return rtf.format(-hr, "hour");
  var days = Math.floor(hr / 24);
  if (days < 7) return rtf.format(-days, "day");
  if (days < 30) return rtf.format(-Math.floor(days / 7), "week");
  return formatDate(ts);
}

// 1536 -> "1.5 KB" (the unit letters are the same in both languages; the number follows the language).
export function formatBytes(n) {
  var v = Number(n);
  if (!isFinite(v) || v < 0) return "";
  var units = ["B", "KB", "MB", "GB", "TB"], i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return formatNumber(v, { maximumFractionDigits: i === 0 ? 0 : v < 10 ? 1 : 0 }) + " " + units[i];
}

// First boot: the saved choice, else the browser's language. (The server's copy arrives later via setLang.)
// Outside a browser (Node tests) there is no browser language: stay ko.
setLang(readLang() || (typeof window !== "undefined" ? langFromNavigator() : DEFAULT_LANG), { persist: false });

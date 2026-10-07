// settings-model.js - Pure rules for the account chip, its menu and the settings
// modal: section list, URL hash, labels. No DOM, store or network.

// Section order and labels. A feature module decides at runtime whether a
// section is available (settings.setAvailable); "일반" and "계정" always are.
// "일반" (theme today; language later) is first, with its pane in index.html
// (data-settings-pane="general") and its controls wired in settings.js.
// `label` is a getter: it follows the interface language (i18n.js).
import { t } from "./i18n.js";

export var SECTIONS = [
  { id: "general", get label() { return t("settings.sectionGeneral"); } },
  { id: "account", get label() { return t("settings.sectionAccount"); } },
  { id: "rooms", get label() { return t("roomAdmin.sectionRooms"); } },
  { id: "server", get label() { return t("roomAdmin.sectionServer"); } },
  { id: "routing", get label() { return t("roomAdmin.sectionRouting"); } },
  { id: "transcription", get label() { return t("roomAdmin.sectionTranscription"); } },
];

var HASH_PREFIX = "#settings";

// 테마 choices of the 일반 pane, in display order. "system" follows the device.
export var THEME_CHOICES = [
  { id: "system", get label() { return t("settings.themeSystem"); } },
  { id: "light", get label() { return t("settings.themeLight"); } },
  { id: "dark", get label() { return t("settings.themeDark"); } },
];

// 언어 choices of the 일반 pane. The names stay in their own language in both UIs.
export var LANG_CHOICES = [
  { id: "ko", get label() { return t("settings.langKo"); } },
  { id: "en", get label() { return t("settings.langEn"); } },
];

export function sectionIds() {
  return SECTIONS.map(function (s) { return s.id; });
}

export function hashFor(sectionId) {
  return sectionId ? HASH_PREFIX + "/" + sectionId : "";
}

// "#settings/rooms" -> "rooms"; "#settings" -> the first section; anything else -> null.
export function parseHash(hash) {
  var m = /^#settings(?:\/([a-z-]+))?$/.exec(String(hash || ""));
  if (!m) return null;
  if (!m[1]) return SECTIONS[0].id;
  if (m[1] === "archived") return "rooms"; // legacy link: archive now lives in Room
  return sectionIds().indexOf(m[1]) === -1 ? null : m[1];
}

export function roleLabel(role) {
  return role === "admin" ? t("settings.roleAdmin") : t("settings.roleMember");
}

export function displayNameOf(user) {
  return (user && (user.displayName || user.username)) || "";
}

export function initialOf(user) {
  var first = Array.from(displayNameOf(user).trim())[0];
  return first ? first.toUpperCase() : "?";
}

// Entries of the account menu for this person, in order. "separator" is a divider.
// AI usage is not repeated here: its own button sits right above the account chip.
export function accountMenuItems(user) {
  var items = [{ id: "settings", label: t("settings.menuSettings") }, { id: "guide", label: t("settings.menuGuide") }, { id: "coaching", label: t("settings.menuCoaching") }];
  if (user && user.role === "admin") items.push({ id: "rooms", label: t("settings.menuRooms") });
  items.push({ id: "separator" });
  items.push({ id: "logout", label: t("settings.menuLogout"), danger: true });
  return items;
}

// --- 계정 forms: Korean validation shared by the nickname, PIN and 아이디 forms.
// Returns an error sentence, or "" when the input may be sent. The server checks again.
var PIN_RE = /^\d{6}$/;
var LOGIN_ID_RE = /^[A-Za-z0-9._-]{3,30}$/;

export function nicknameError(value) {
  var v = String(value || "").trim();
  if (!v) return t("settings.nickRequired");
  if (v.length > 40) return t("settings.nickTooLong");
  return "";
}

export function pinChangeError(current, next, confirm) {
  if (!PIN_RE.test(String(current || ""))) return t("settings.pinCurrentRequired");
  if (!PIN_RE.test(String(next || ""))) return t("settings.pinNewInvalid");
  if (next !== confirm) return t("settings.pinNewMismatch");
  return "";
}

export function credentialsError(loginId, pin, confirm) {
  var id = String(loginId || "").trim();
  if (!LOGIN_ID_RE.test(id)) return t("settings.idInvalid");
  if (id.toLowerCase().indexOf("guest-") === 0) return t("settings.idReserved");
  if (!PIN_RE.test(String(pin || ""))) return t("settings.pinInvalid");
  if (pin !== confirm) return t("settings.pinMismatch");
  return "";
}

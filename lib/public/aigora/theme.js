// theme.js - The 테마 choice of the standalone Aigora page: "system" (default),
// "light" or "dark", kept in localStorage and mirrored as <html data-theme>.
// "system" leaves the attribute off so the prefers-color-scheme media query in
// aigora-app.css decides. index.html carries a tiny inline copy of the read side
// so the right palette is there before first paint; lib/pages.js does the same
// for the sign-in and invite pages (same key, same origin).

export var THEME_KEY = "aigora.theme";

export function normalizeTheme(value) {
  return value === "light" || value === "dark" ? value : "system";
}

// Storage can be missing or throw (private mode, blocked site data): both mean "system".
export function readTheme() {
  try { return normalizeTheme(localStorage.getItem(THEME_KEY)); } catch (e) { return "system"; }
}

export function saveTheme(theme) {
  try { localStorage.setItem(THEME_KEY, normalizeTheme(theme)); } catch (e) { /* applies for this visit only */ }
}

export function applyTheme(theme) {
  var root = document.documentElement;
  var value = normalizeTheme(theme);
  if (value === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", value);
}

// Shared relative-time formatter for the legacy modules (filebrowser, app-home-hub, command-palette,
// sidebar-sessions) via utils.js. Now language-aware: "방금" / "1시간 전" in ko, "just now" / "1 hour ago" in en.
// The implementation lives in aigora/i18n.js (Intl); this keeps the old name and import path.
export { formatRelativeTime as relativeTime } from "../aigora/i18n.js";

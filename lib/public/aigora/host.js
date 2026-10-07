// host.js - Aigora's own stand-in for the three legacy modules the shared
// Agora renderers import (sidebar-sessions.js, utils.js, app-rendering.js).
// index.html's import map points those specifiers here, so the standalone page
// never loads the legacy app graph.

import { t } from "./i18n.js";

var sessions = [];
var toastHandler = null;

export function setSessions(list) {
  sessions = Array.isArray(list) ? list : [];
}

export function getCachedSessions() {
  return sessions;
}

export function onHostNotice(fn) {
  toastHandler = fn;
}

export function copyToClipboard(text) {
  var attempt = typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText
    ? navigator.clipboard.writeText(text)
    : Promise.reject(new Error("no clipboard"));
  return attempt.then(function () {
    if (toastHandler) toastHandler(t("host.copied"));
  }, function () {
    if (toastHandler) toastHandler(t("host.copyFailed"));
  });
}

// Orchestration cards live in the right panel; this stays for import parity.
export function addToMessages(el) {
  var root = document.getElementById("messages");
  if (root) root.appendChild(el);
}

export function scrollToBottom() {}

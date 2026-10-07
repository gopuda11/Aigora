// row-menus-model.js - Pure who-sees-what rules and copy for the "⋯" menus on
// room and session rows. No DOM, store or WS. The server re-checks every one of
// these actions; this only decides which entries are worth offering.

import { t } from "./i18n.js";

// Getters, so the label follows the current language each time it is read.
export var ACTION_LABELS = {
  get invite() { return t("rowMenus.invite"); },
  get archive() { return t("rowMenus.archive"); },
  get rename() { return t("rowMenus.rename"); },
  get delete() { return t("rowMenus.delete"); },
  get close() { return t("rowMenus.close"); },
};

function sameId(a, b) {
  return a != null && b != null && String(a) === String(b);
}

function isPersonal(session) {
  return Object.prototype.hasOwnProperty.call(session, "channelId") &&
    session.channelId !== undefined && session.channelId !== null;
}

/**
 * Actions offered on a room row. `viewer` = { isAdmin }. Only an administrator
 * may archive, and only a room that is not archived already.
 */
export function roomMenuActions(room, viewer) {
  if (!room || !viewer || viewer.isAdmin !== true || room.archived === true) return [];
  return ["invite", "archive"];
}

/**
 * Actions offered on a session row. `viewer` = { myUserId, isAdmin,
 * canDeleteSessions }; `room` is the session's room ({ role, archived }) or null.
 * - The session owner may delete it whatever `canDeleteSessions` says (that
 *   permission only covers other people's sessions), except a view-only member
 *   without the permission.
 * - An administrator or the room owner may delete someone else's session, but
 *   never a personal (private-channel) one: only its owner mutates it.
 * - An unknown permission counts as allowed (the server decides); an explicit
 *   `canDeleteSessions: false` offers nothing on other people's sessions, and
 *   an archived room offers nothing.
 */
export function sessionMenuActions(session, viewer, room) {
  if (!session || !viewer) return [];
  if (room && room.archived === true) return [];
  if (room && room.role === "viewer") return [];
  var owner = sameId(session.ownerId, viewer.myUserId);
  // 이름 변경: the owner (a private session: its channel owner) or an administrator, never on a
  // room's main thread (a room is one shared feed) and never on someone else's private session.
  var rename = session.roomMain !== true && (owner || (viewer.isAdmin === true && !isPersonal(session)));
  var del = owner ? true
    : viewer.canDeleteSessions === false || isPersonal(session) ? false
    : session.ownerId == null ? viewer.isAdmin === true
    : viewer.isAdmin === true || !!(room && room.role === "owner");
  return (rename ? ["rename"] : []).concat(del ? ["delete"] : []);
}

/**
 * Actions offered on the viewer's own 나만의 채널 row. `channel` = { owner, active }; only its owner
 * renames it, and not in a room they may only read.
 */
export function channelMenuActions(channel, room) {
  if (!channel || channel.owner !== true || channel.active !== true) return [];
  if (room && (room.archived === true || room.role === "viewer")) return [];
  // 채널 닫기 is offered while the channel can be closed (connected, active); the dialog still asks first.
  return channel.canClose === false ? ["rename"] : ["rename", "close"];
}

/** Confirmation dialog copy for one action on one named row. */
export function confirmCopy(action, name) {
  var label = String(name == null ? "" : name).trim() || (action === "archive" ? t("rowMenus.thisRoom") : t("rowMenus.untitledSession"));
  if (action === "close") {
    return { title: t("privateChannels.closeDialogTitle"), text: t("privateChannels.closeDialogText"), confirm: t("privateChannels.closeChannel") };
  }
  if (action === "archive") {
    return {
      title: t("rowMenus.archiveTitle"),
      text: t("rowMenus.archiveText", { name: label }),
      confirm: t("rowMenus.archive"),
    };
  }
  return {
    title: t("rowMenus.deleteTitle"),
    text: t("rowMenus.deleteText", { name: label }),
    confirm: t("rowMenus.delete"),
  };
}

export function menuKey(kind, id) {
  return kind + ":" + String(id);
}

export function parseMenuKey(key) {
  var s = String(key == null ? "" : key);
  var at = s.indexOf(":");
  if (at < 1) return null;
  var kind = s.slice(0, at);
  if (kind !== "room" && kind !== "session" && kind !== "channel") return null;
  return { kind: kind, id: s.slice(at + 1) };
}

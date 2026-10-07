// room-admin-api.js - Thin client for the owner-only room admin HTTP API.
// The server is authoritative (every route re-checks the owner); this module
// only shapes requests and turns errors into short messages in the interface language.

import { t } from "./i18n.js";

// Getters, so the text follows the interface language.
var MESSAGES = {
  get "Cannot remove the room owner"() { return t("roomAdminApi.cannotRemoveOwner"); },
  get "Cannot change the room owner's role"() { return t("roomAdminApi.cannotChangeOwnerRole"); },
  get "Role must be member or viewer"() { return t("roomAdminApi.roleInvalid"); },
  get "Member not found"() { return t("roomAdminApi.memberNotFound"); },
  get "Member limit reached"() { return t("roomAdminApi.memberLimit"); },
  get "Room name is required"() { return t("roomAdminApi.roomNameRequired"); },
  get "Room not found"() { return t("roomAdminApi.roomNotFound"); },
  get "Room must be archived before it can be deleted"() { return t("roomAdminApi.mustArchive"); },
  get "confirmName must match the room name"() { return t("roomAdminApi.nameMismatch"); },
};

function request(method, url, body, csrf) {
  var init = { method: method, credentials: "same-origin", cache: "no-store" };
  if (csrf) init.headers = { "X-Requested-With": "aigora" };
  if (body !== undefined) {
    init.headers = Object.assign(init.headers || {}, { "Content-Type": "application/json" });
    init.body = JSON.stringify(body);
  }
  return fetch(url, init).then(function (res) {
    return res.json().then(function (data) { return data || {}; }, function () { return {}; }).then(function (data) {
      if (res.ok) return data;
      var err = new Error(data.error || "HTTP " + res.status);
      err.status = res.status;
      throw err;
    });
  });
}

export function errorText(err) {
  if (err && err.status === 409 && /[가-힣]/.test(err.message)) return err.message;
  if (err && err.message === "busy") return t("roomAdminApi.busy");
  if (err && err.message === "backup_failed") return t("roomAdminApi.backupFailed");
  if (err && err.status === 403) return t("roomAdminApi.adminOnly");
  return (err && MESSAGES[err.message]) || t("roomAdminApi.requestFailed");
}

function room(roomId) { return "/api/admin/rooms/" + encodeURIComponent(roomId); }

export function createRoom(name, description) { return request("POST", "/api/admin/rooms", { name: name, description: description }); }
export function listMembers(roomId) { return request("GET", room(roomId) + "/members"); }
export function setMemberRole(roomId, userId, role) { return request("PATCH", room(roomId) + "/members/" + encodeURIComponent(userId), { role: role }); }
export function forceLogout(userId) { return request("POST", "/api/admin/users/" + encodeURIComponent(userId) + "/force-logout", undefined, true); }
export function removeMember(roomId, userId) { return request("DELETE", room(roomId) + "/members/" + encodeURIComponent(userId)); }
export function createInvite(roomId) { return request("POST", room(roomId) + "/invites"); }
export function listInvites() { return request("GET", "/api/admin/invites"); }
export function revokeInvite(inviteId) { return request("DELETE", "/api/admin/invites/" + encodeURIComponent(inviteId)); }
export function listRooms() { return request("GET", "/api/rooms"); }
export function archiveRoom(roomId) { return request("POST", room(roomId) + "/archive"); }
export function restoreRoom(roomId) { return request("POST", room(roomId) + "/restore"); }
export function listArchivedRooms() { return request("GET", "/api/admin/rooms/archived"); }
export function deleteRoomPermanently(roomId, confirmName) { return request("DELETE", room(roomId), { confirmName: confirmName }); }
export function listSnapshots(roomId) { return request("GET", "/api/room-snapshots/" + encodeURIComponent(roomId)); }
export function restoreSnapshot(roomId, id) { return request("POST", "/api/room-snapshots/" + encodeURIComponent(roomId) + "/restore", { id: id }, true); }
export function getApproval(roomId) { return request("GET", room(roomId) + "/approval"); }
export function getSkillManagers(roomId) { return request("GET", room(roomId) + "/skill-managers"); }
export function setSkillManagers(roomId, skillManagers) { return request("PUT", room(roomId) + "/skill-managers", { skillManagers: skillManagers }); }
export function setApproval(roomId, approval) { return request("PUT", room(roomId) + "/approval", approval); }
export function deleteInvite(inviteId) { return request("DELETE", "/api/admin/invites/" + encodeURIComponent(inviteId) + "/record"); }
export function getClef() { return request("GET", "/api/admin/clef"); }
export function saveClef(body) { return request("POST", "/api/admin/clef", body, true); }
export function getLocalModel() { return request("GET", "/api/admin/local-model"); }
export function saveLocalModel(body) { return request("POST", "/api/admin/local-model", body, true); }
export function getTranscription() { return request("GET", "/api/admin/transcription"); }
export function saveTranscription(body) { return request("POST", "/api/admin/transcription", body, true); }

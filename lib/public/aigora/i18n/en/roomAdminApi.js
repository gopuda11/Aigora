// Messages for room-admin API errors (room-admin-api.js).
export default {
  "roomAdminApi.cannotRemoveOwner": "The room owner cannot be removed.",
  "roomAdminApi.cannotChangeOwnerRole": "The room owner's role cannot be changed.",
  "roomAdminApi.roleInvalid": "Only member or view-only can be assigned.",
  "roomAdminApi.memberNotFound": "That member is no longer in the room.",
  "roomAdminApi.memberLimit": "The member limit has been reached.",
  "roomAdminApi.roomNameRequired": "Enter a room name.",
  "roomAdminApi.roomNotFound": "That room no longer exists.",
  "roomAdminApi.mustArchive": "Only archived rooms can be deleted permanently.",
  "roomAdminApi.nameMismatch": "The room name does not match.",
  "roomAdminApi.busy": "The AI is working in this room. Try again once it is done.",
  "roomAdminApi.backupFailed": "Could not make the automatic backup first, so nothing was restored.",
  "roomAdminApi.adminOnly": "Only room admins can use this.",
  "roomAdminApi.requestFailed": "The request could not be processed. Please try again in a moment.",
};

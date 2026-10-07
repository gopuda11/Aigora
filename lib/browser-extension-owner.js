"use strict";
// The project keeps one browser-extension socket. Its tabs belong to the account that socket authenticated as:
// only that account may collect them as agent context. Identity is read live from the socket on every call.
// Single-user mode (no accounts on either side) keeps working.
function mayUseExtension(extWs, actorUser) {
  if (!extWs || extWs.readyState !== 1) return false;
  var owner = extWs._aigoraUser || null;
  if (!owner && !actorUser) return true;
  return !!owner && !!actorUser && typeof owner.id === "string" && owner.id === actorUser.id;
}
module.exports = { mayUseExtension: mayUseExtension };

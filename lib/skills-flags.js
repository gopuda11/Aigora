"use strict";
// Room skills feature flag (config key roomSkills.enabled), default OFF. Anything malformed means off.
function isSkillsEnabled() {
  try {
    var s = require("./config").loadConfig();
    s = s && s.roomSkills;
    return !!s && typeof s === "object" && !Array.isArray(s) && Object.prototype.hasOwnProperty.call(s, "enabled") && s.enabled === true;
  } catch (_) { return false; }
}
module.exports = { isSkillsEnabled: isSkillsEnabled };

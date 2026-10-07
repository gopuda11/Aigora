module.exports = require("./extensions").select("private-execution-flags", function () {
var module = { exports: {} };
"use strict";
function isPrivateExecutionEnabled(agent) {
  try {
    if (agent !== "claude" && agent !== "codex") return false;
    var config = require("./config").loadConfig();
    var flags = config && config.privateExecution;
    return !!flags && typeof flags === "object" && !Array.isArray(flags) &&
      Object.prototype.hasOwnProperty.call(flags, agent) && flags[agent] === true;
  } catch (_) { return false; }
}
// Hard safety cap on concurrently running private scopes (privateExecution.maxConcurrent, default 32, 1..32). The run
// scheduler (scheduler.* config) is the effective limiter and queues; this only refuses when it is lowered on purpose.
function maxPrivateConcurrent() {
  try {
    var flags = require("./config").loadConfig().privateExecution, v = flags && flags.maxConcurrent;
    return Number.isInteger(v) && v >= 1 && v <= 32 ? v : 32;
  } catch (_) { return 32; }
}
module.exports = { isPrivateExecutionEnabled: isPrivateExecutionEnabled, maxPrivateConcurrent: maxPrivateConcurrent };

return module.exports;
});

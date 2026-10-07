"use strict";
// A single metadata operation in the environment selected by the daemon's
// credential lease. The SDK's filesystem helpers ignore options.env.
var env = require("../../agent-env").stripRoutingSecrets(process.env);
for (var name of Object.keys(process.env)) if (!(name in env)) delete process.env[name];
// A daemon exit must not leave a metadata process holding a run credential.
process.once("disconnect", function () { process.exit(0); });
process.once("message", async function (message) {
  try {
    var sdk = await import("@anthropic-ai/claude-agent-sdk");
    var options = message.options || {};
    var result;
    switch (message.method) {
      case "getSessionInfo": result = await sdk.getSessionInfo(message.args[0], options); break;
      case "listSessions": result = await sdk.listSessions(options); break;
      case "renameSession": result = await sdk.renameSession(message.args[0], message.args[1], options); break;
      case "forkSession": result = await sdk.forkSession(message.args[0], options); break;
      default: throw new Error("Unknown session operation");
    }
    process.send({ result: result }, function () { process.disconnect(); });
  } catch (e) {
    process.send({ error: e.message || "Session operation failed" }, function () { process.disconnect(); });
  }
});

#!/usr/bin/env node
// aigora-mcp-bridge: installs/removes the Aigora native-messaging host manifest
// (native-host/install.sh). Usage: aigora-mcp-bridge install <extension-id> | uninstall
var path = require("path");
var spawnSync = require("child_process").spawnSync;

var cmd = process.argv[2];
var script = path.join(__dirname, "..", "native-host", "install.sh");
var args;
if (cmd === "install" && process.argv[3] && /^[a-p]{32}$/.test(process.argv[3])) {
  args = [script, process.argv[3]];
} else if (cmd === "uninstall") {
  args = [script, "--uninstall"];
} else {
  console.error("Usage: aigora-mcp-bridge install <extension-id> | uninstall");
  process.exit(2);
}
var r = spawnSync("bash", args, { stdio: "inherit" });
process.exit(r.status === null ? 1 : r.status);

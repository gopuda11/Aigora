"use strict";
// Test-safety guard: the test runner sets AIGORA_TEST_NO_REAL_CLI=1 so no test
// Tests that inject a fake spawn/execFile never reach this check.
function assertRealCliAllowed(name) {
  if (process.env.AIGORA_TEST_NO_REAL_CLI === "1" && process.env.AIGORA_ALLOW_REAL_CLI !== "1") {
    throw new Error("[test-guard] refusing to spawn real " + name + " CLI under AIGORA_TEST_NO_REAL_CLI=1 (inject a fake spawn, or set AIGORA_ALLOW_REAL_CLI=1 with an isolated CODEX_HOME)");
  }
}
module.exports = { assertRealCliAllowed };

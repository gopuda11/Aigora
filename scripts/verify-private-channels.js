#!/usr/bin/env node
"use strict";
// Offline private-channel verification (Task 6a). Read-only.
// Usage: node scripts/verify-private-channels.js [--data-dir DIR] [--json] [--supported-version N]
// Exit: 1 any FAIL; 2 no FAIL but BLOCKED/NOT_RUN evidence remains; 0 only if all PASS.
// Offline it can never exit 0: live isolation and domain E2E are NOT_RUN.
// Output is counts and fixed labels only (no titles, prompts, ids, secrets).
var fs = require("fs");
var path = require("path");
var compat = require("../lib/private-channels-compat");

function parseArgs(argv) {
  var o = { json: false, dataDir: null, supported: undefined };
  for (var i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") o.json = true;
    else if (argv[i] === "--data-dir") o.dataDir = argv[++i];
    else if (argv[i] === "--supported-version") o.supported = Number(argv[++i]);
  }
  return o;
}

function sum(v, re) {
  return Object.keys(v).filter(function (k) { return re.test(k); }).reduce(function (n, k) { return n + v[k]; }, 0);
}

function verify(dataDir, supported) {
  var rows = [];
  function row(check, status, detail) { rows.push({ check: check, status: status, detail: detail }); }
  var exists = false;
  try { exists = fs.statSync(dataDir).isDirectory(); } catch (e) {}
  if (!exists) {
    row("data-dir", "FAIL", "data directory missing");
    ["compat", "session-acl", "registry-provenance", "old-build-exposure"].forEach(function (c) { row(c, "NOT_RUN", "no data"); });
  } else {
    var r = compat.check(dataDir, typeof supported === "number" && !isNaN(supported) ? { supportedVersion: supported } : undefined);
    var v = r.scan.violations, c = r.scan.counts;
    row("data-dir", "PASS", "present");
    row("compat", r.ok ? "PASS" : "FAIL", r.ok ? "schema compatible" : r.reason);
    var sv = sum(v, /^(session_|channel_store_)/), rv = sum(v, /^registry_/);
    row("session-acl", sv ? "FAIL" : "PASS", c.privateSessions + " private of " + c.sessions + " sessions, " + sv + " violations");
    row("registry-provenance", rv ? "FAIL" : "PASS", c.privateRegistryRecords + " provenance of " + c.registryRecords + " records, " + rv + " violations");
    var stamped = r.scan.stampedVersion === compat.SCHEMA_VERSION;
    if (!r.scan.usesPrivate) row("old-build-exposure", "PASS", "no private fields on disk");
    else row("old-build-exposure", "BLOCKED", stamped ? "schema stamped; historical build enforcement unverified" : "private fields present, schema not stamped");
  }
  row("live-isolation-probe", "NOT_RUN", "requires live probe evidence");
  row("domain-e2e", "NOT_RUN", "requires public-domain E2E evidence");
  var code = rows.some(function (x) { return x.status === "FAIL"; }) ? 1
    : rows.every(function (x) { return x.status === "PASS"; }) ? 0 : 2;
  return { rows: rows, exitCode: code };
}

function main() {
  var o = parseArgs(process.argv.slice(2));
  var dir = o.dataDir || require("../lib/config").CONFIG_DIR;
  var res = verify(path.resolve(dir), o.supported);
  if (o.json) process.stdout.write(JSON.stringify(res) + "\n");
  else {
    res.rows.forEach(function (x) { console.log((x.status + "        ").slice(0, 9) + (x.check + "                       ").slice(0, 24) + x.detail); });
    console.log("exit " + res.exitCode + (res.exitCode === 0 ? "" : " (not a pass)"));
  }
  process.exit(res.exitCode);
}

if (require.main === module) main();
module.exports = { verify: verify };

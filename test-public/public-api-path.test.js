"use strict";
// Load the isolated-home bootstrap before node:test or application modules.
const registerPublicApiPathTests = require("./public-api-path.cases.js");
const test = require("node:test");
// Register here so the per-file completion reporter sees this entry point.
registerPublicApiPathTests(function define(...args) { return test(...args); });

"use strict";
// The running build's id, computed once at startup. A release dir carries a RELEASE_COMMIT file at its root
// (lib/ sits directly under it); anything else (a dev checkout) falls back to package version + process start time.

var fs = require("fs");
var path = require("path");

function compute(root, version, startedAt) {
  try {
    var c = fs.readFileSync(path.join(root, "RELEASE_COMMIT"), "utf8").trim();
    if (c) return c;
  } catch (e) { /* not a release dir */ }
  return version + "-" + startedAt;
}

module.exports = {
  compute: compute,
  BUILD_ID: compute(path.join(__dirname, ".."), require("../package.json").version, Date.now()),
};

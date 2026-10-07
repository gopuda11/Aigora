#!/usr/bin/env node
// Fails (exit 1) when tracked files contain a deny-listed personal identifier or a generic secret.
// Usage: node scripts/check-public-safety.js [--root <dir>] [--config <file>]
// Scans `git ls-files` (falls back to a directory walk outside a git repo). Never prints matched text.
"use strict";
var fs = require("fs");
var path = require("path");
var cp = require("child_process");

var SECRET_PATTERNS = [
  ["private-key", /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?-----/],
  ["anthropic-key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["openai-key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["github-token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}/],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/]
];

function parseArgs(argv) {
  var o = { root: process.cwd(), config: null, exported: undefined };
  for (var i = 0; i < argv.length; i++) {
    if (argv[i] === "--exported") o.exported = true;
    else if (argv[i] === "--source") o.exported = false;
    else if (argv[i] === "--root") o.root = path.resolve(argv[++i]);
    else if (argv[i] === "--config") o.config = path.resolve(argv[++i]);
  }
  if (!o.config) o.config = path.join(o.root, "scripts", "public-safety-denylist.json");
  return o;
}

function listFiles(root, exported) {
  try {
    if (exported) throw new Error("walk materialized export");
    var out = cp.execFileSync("git", ["ls-files", "-z"], { cwd: root, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 });
    return out.toString("utf8").split("\0").filter(Boolean);
  } catch (e) {
    var res = [];
    (function walk(dir) {
      fs.readdirSync(dir, { withFileTypes: true }).forEach(function (d) {
        if (d.name === ".git" || (!exported && d.name === "node_modules")) return;
        var p = path.join(dir, d.name);
        if (d.isDirectory()) walk(p); else res.push(path.relative(root, p));
      });
    })(root);
    return res;
  }
}

// Paths marked `export-ignore` in .gitattributes never reach the public export, so they are not scanned.
function exportIgnored(root) {
  var out = [];
  try {
    fs.readFileSync(path.join(root, ".gitattributes"), "utf8").split("\n").forEach(function (l) {
      l = l.trim();
      if (!l || l[0] === "#") return;
      var parts = l.split(/\s+/);
      if (parts.slice(1).indexOf("export-ignore") !== -1) out.push(parts[0].replace(/^\//, ""));
    });
  } catch (e) { /* no .gitattributes */ }
  return out;
}

function scan(root, cfg, options) {
  var exported = options && options.exported !== undefined ? options.exported : !fs.existsSync(path.join(root, ".git"));
  var ignored = exported ? [] : exportIgnored(root);
  var deny = (cfg.denyPatterns || []).map(function (s) { return [s, new RegExp(s, "i")]; });
  var allowLine = (cfg.allowLinePatterns || []).map(function (s) { return new RegExp(s); });
  // allowFileLines: { "<file>": ["<regex>", ...] } exempts matching lines of that one file from the deny patterns
  // (never from the secret patterns). Used for the intended owner/attribution lines.
  var allowIn = {};
  Object.keys(cfg.allowFileLines || {}).forEach(function (f) { allowIn[f] = cfg.allowFileLines[f].map(function (s) { return new RegExp(s); }); });
  var allow = {};
  (cfg.allowFiles || []).forEach(function (f) { allow[f] = true; });
  var findings = [];
  listFiles(root, exported).forEach(function (rel) {
    var relPosix = rel.split(path.sep).join("/");
    // Path checks run before any text/allow exemptions, including binaries.
    if (exported && (cfg.denyPaths || []).some(function (p) { return relPosix === p || relPosix.startsWith(p + "/"); })) {
      findings.push({ file: rel, line: 0, rule: "path:private-extension-or-dependency" }); return;
    }
    if (exported && fs.lstatSync(path.join(root, rel)).isSymbolicLink()) {
      findings.push({ file: rel, line: 0, rule: "path:symlink" }); return;
    }
    if (allow[relPosix]) return;
    if (ignored.some(function (p) { return p.slice(-1) === "/" ? relPosix.indexOf(p) === 0 : relPosix === p; })) return;
    var buf;
    try { buf = fs.readFileSync(path.join(root, rel)); } catch (e) { return; }
    if (buf.indexOf(0) !== -1) return; // binary
    var relKey = rel.split(path.sep).join("/");
    buf.toString("utf8").split("\n").forEach(function (line, i) {
      if (allowLine.some(function (r) { return r.test(line); })) return; // known dummy fixtures
      var identityOk = (allowIn[relKey] || []).some(function (r) { return r.test(line); });
      if (!identityOk) deny.forEach(function (d) { if (d[1].test(line)) findings.push({ file: rel, line: i + 1, rule: "deny:" + d[0] }); });
      SECRET_PATTERNS.forEach(function (s) { if (s[1].test(line)) findings.push({ file: rel, line: i + 1, rule: "secret:" + s[0] }); });
    });
  });
  return findings;
}

function main() {
  var a = parseArgs(process.argv.slice(2));
  var cfg = { denyPatterns: [], allowFiles: [] };
  if (fs.existsSync(a.config)) cfg = JSON.parse(fs.readFileSync(a.config, "utf8"));
  else console.error("[check-public-safety] NOTICE: repo deny-list not found at " + a.config + " (no repo-level deny patterns applied)");
  // Owner-specific identifiers (hostnames, home paths, nicknames) live outside the repo so the deny-list itself
  // never publishes them: $AIGORA_PUBLIC_DENYLIST or ~/.config/aigora/public-denylist.json, merged when present.
  var local = process.env.AIGORA_PUBLIC_DENYLIST || path.join(require("os").homedir(), ".config", "aigora", "public-denylist.json");
  if (!fs.existsSync(local)) {
    console.error("[check-public-safety] NOTICE: no local deny-list at " + local + "; owner-specific identifiers are NOT checked on this machine" +
      " (create it or set $AIGORA_PUBLIC_DENYLIST)");
  } else {
    var extra = JSON.parse(fs.readFileSync(local, "utf8"));
    cfg.denyPatterns = (cfg.denyPatterns || []).concat(extra.denyPatterns || []);
    cfg.allowLinePatterns = (cfg.allowLinePatterns || []).concat(extra.allowLinePatterns || []);
    cfg.allowFileLines = Object.assign({}, cfg.allowFileLines, extra.allowFileLines);
  }
  var findings = scan(a.root, cfg, { exported: a.exported });
  if (!findings.length) { console.log("[check-public-safety] OK"); return 0; }
  findings.forEach(function (f) { console.error("[check-public-safety] " + f.file + ":" + f.line + "  " + f.rule); });
  console.error("[check-public-safety] FAIL: " + findings.length + " finding(s)");
  return 1;
}

if (require.main === module) process.exit(main());
module.exports = { scan: scan, SECRET_PATTERNS: SECRET_PATTERNS };

#!/usr/bin/env node
"use strict";

// Rebrand inventory: finds every remaining "clagentic" / product "clay" token
// in tracked (and untracked, non-ignored) text files, groups it by category and
// prints a Markdown report (default), JSON (--json) or a one-line summary (--summary).
//
//   node scripts/rebrand-inventory.js > docs/rebrand-inventory.md
//   node scripts/rebrand-inventory.js --check   # exit 1 if anything outside the allow-list and docs remains
//
// scripts/rebrand-codemod.js reuses protectedSpans() and BRAND_RE so that the
// inventory and the rename always agree on what is a persisted/external name.

var fs = require("fs");
var path = require("path");
var cp = require("child_process");

// "clay" counts only as a whole token or identifier part: clay, Clay, CLAY, clayPort, loadClayrc, CLAY_HOME.
// Not display/clayton/claymore.
var BRAND_RE = /[Cc][Ll][Aa][Gg][Ee][Nn][Tt][Ii][Cc]|(?<![A-Za-z])clay(?=rc(?![a-z])|(?![a-z]))|(?<![A-Z])Clay(?=rc(?![a-z])|(?![a-z]))|(?<![A-Z])CLAY(?![a-z])/g;

// Tokens that keep their name for now. kind decides the report category.
//   env        legacy env var names (R3)
//   persisted  names that exist on disk / in browsers / on the wire (R4)
//   interface  names shared with external programs (Chrome extension, MCP clients, native messaging)
//   external   third-party names (URLs, binaries, packages) that never change
var RULES = [
  { kind: "env", name: "env var", re: /[A-Z0-9_]*(?:CLAGENTIC|CLAY)_[A-Z0-9_]*/g },
  { kind: "persisted", name: "legacy path constant", re: /OLD_CLAY[A-Z_]*/g },
  { kind: "persisted", name: "dot dir/file (~/.clagentic, ~/.clay, .clayrc, .clagentic-rc)", re: /(?<![A-Za-z0-9_])\.(?:clagentic-rc|clagentic|clayrc|clay)(?![A-Za-z0-9_])/g },
  { kind: "persisted", name: "localStorage / cookie key", re: /(?:clagentic|clay)[-_](?:theme-vars|theme|mode|skin|wide-view|brand|project-hint-dismissed|project-name-|project-icon-|my_user|active-dm|weather|context-view|playbooks-done|wt-collapsed|last_project|login_username|skill-update-dismissed)/g },
  { kind: "persisted", name: "websocket auth subprotocol", re: /clagentic\\?\.auth\\?\./g },
  { kind: "persisted", name: "socket / pipe name", re: /clagentic-(?:daemon(?:-dev)?|worker-)/g },
  { kind: "persisted", name: "home / system dir", re: /(?:clagentic|clay)-projects|\/var\/clagentic/g },
  { kind: "persisted", name: "legacy systemd unit", re: /clagentic(?:-console)?\.service/g },
  { kind: "persisted", name: "legacy theme id", re: /clagentic-(?:dark|light)/g },
  { kind: "persisted", name: "stored value (brand / loop author)", re: /(?<=["'])(?:clagentic|clay)(?=["'])/g, skipLine: /clientInfo/ },
  { kind: "persisted", name: "password-hash salt / OS account prefix", re: /clay-user:|(?<=["'])clay-(?=["'])|clay-(?:username|xxx)/g },
  { kind: "interface", name: "extension / MCP / native-host interface", re: /clay_ext_[a-z_]+|clay_mcp_tool_call|clay-(?:chrome(?:-extension)?|page|mcp-bridge|tools|browser|datastore)|com\.clagentic/g },
  { kind: "external", name: "third-party name or URL", re: /github\.com\/[\w-]+\/[\w.-]*(?:clagentic|clay)[\w.-]*|chadbyte\/clay-chrome|clagentic\/clagentic-console|ko-fi\.com\/clagentic|clagentic\.ai|clagentic-lite|clagentic[-:]triage|clagentic-release-bot|clay-server/g },
];

// Files that are inspected but never rewritten by the codemod (other phases own them).
var CODEMOD_EXCLUDE = [
  /^node_modules\//, /^third_party\//, /^docs\//, /^README(\.[a-z]+)?\.md$/, /^CHANGELOG\.md$/, /^LICENSE$/,
  /^CONTRIBUTING\.md$/, /^CREDITS\.md$/, /^FORK_NOTICE\.md$/, /^\.clagentic\//, /^\.crew\//, /^\.github\//,
  /^deploy\//, /^package(-lock)?\.json$/, /^release\.config\.js$/, /^lib\/public\/emoji-data\.json$/,
  /^scripts\/rebrand-/, /^test\/rebrand-aigora\.test\.js$/, /^test\/aigora-cli-names\.test\.js$/, /^test\/no-deadname-identifiers\.test\.js$/,
];

var BINARY_EXT = /\.(png|jpe?g|gif|ico|webp|svgz|woff2?|ttf|otf|zip|tgz|gz|mp3|mp4|wav|pdf|wasm|node)$/i;

function protectedSpans(line) {
  var spans = [];
  RULES.forEach(function (rule) {
    if (rule.skipLine && rule.skipLine.test(line)) return;
    rule.re.lastIndex = 0;
    var m;
    while ((m = rule.re.exec(line))) {
      if (m[0] === "") { rule.re.lastIndex++; continue; }
      spans.push({ start: m.index, end: m.index + m[0].length, kind: rule.kind, name: rule.name, text: m[0] });
    }
  });
  return spans;
}

function listFiles(root) {
  var out = cp.execFileSync("git", ["ls-files", "-z", "-c", "-o", "--exclude-standard"], { cwd: root, maxBuffer: 256 * 1024 * 1024 });
  return out.toString("utf8").split("\0").filter(Boolean);
}

function isAllowlisted(file, line) {
  if (/^node_modules\//.test(file) || /^third_party\//.test(file)) return "vendored / node_modules";
  if (file === "test/no-deadname-identifiers.test.js") return "deadname guard test (must name the old brand)";
  if (/^scripts\/rebrand-/.test(file)) return "rebrand tooling";
  if (file === "CHANGELOG.md") return "CHANGELOG history";
  if (file === "LICENSE" && /Copyright/.test(line)) return "LICENSE upstream copyright";
  if (/^README(\.[a-z]+)?\.md$/.test(file) && /fork of|forked from|began as|포크/i.test(line)) return "README provenance line";
  return null;
}

function scopeOf(file) {
  if (/^test\//.test(file)) return "tests";
  if (/^docs\//.test(file) || /\.md$/.test(file)) return "docs";
  return "code";
}

// Is index (char position) inside a quoted string on this line? Returns the string text or null.
function enclosingString(line, idx) {
  var quote = null, start = -1;
  for (var i = 0; i < line.length; i++) {
    var c = line[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) {
        if (idx > start && idx < i) return line.slice(start + 1, i);
        quote = null;
      }
    } else if (c === '"' || c === "'" || c === "`") { quote = c; start = i; }
  }
  return null;
}

function categoryFor(file, line, idx) {
  var scope = scopeOf(file);
  if (/^(package\.json|release\.config\.js|LICENSE|FORK_NOTICE\.md|CREDITS\.md)$/.test(file) || /^\.github\//.test(file) && /FUNDING/.test(file)) return "package-metadata";
  if (scope === "docs") return "docs";
  var before = line.slice(0, idx);
  var trimmed = line.trim();
  if (/^(\/\/|\/\*|\*|#|<!--)/.test(trimmed) || /(^|[^:])\/\/ /.test(before) && !enclosingString(line, idx)) return "comment";
  if (scope === "tests") return "tests";
  if (/\.html$/.test(file) && !enclosingString(line, idx)) return "user-visible text";
  var s = enclosingString(line, idx);
  if (s && /[A-Za-z]+\s+[A-Za-z]+/.test(s)) return "user-visible text";
  return "identifier";
}

var KIND_CATEGORY = { env: "env-var", persisted: "persisted-name", interface: "interface-name", external: "external-name" };

function scan(root) {
  var hits = [];
  listFiles(root).forEach(function (file) {
    if (BINARY_EXT.test(file) || file === "docs/rebrand-inventory.md") return;
    var text;
    try {
      var st = fs.statSync(path.join(root, file));
      if (!st.isFile() || st.size > 8 * 1024 * 1024) return;
      text = fs.readFileSync(path.join(root, file), "utf8");
    } catch (e) { return; }
    if (text.indexOf("\0") !== -1) return;
    var lines = text.split("\n");
    for (var n = 0; n < lines.length; n++) {
      var line = lines[n];
      if (!/clagentic|clay/i.test(line)) continue;
      var spans = protectedSpans(line);
      BRAND_RE.lastIndex = 0;
      var m;
      while ((m = BRAND_RE.exec(line))) {
        var span = null;
        for (var i = 0; i < spans.length; i++) {
          if (m.index >= spans[i].start && m.index < spans[i].end) { span = spans[i]; break; }
        }
        var allow = isAllowlisted(file, line);
        var cat = allow ? "allow-listed" : span ? KIND_CATEGORY[span.kind] : categoryFor(file, line, m.index);
        hits.push({
          file: file, line: n + 1, col: m.index + 1, category: cat, scope: scopeOf(file),
          token: span ? span.text : m[0], rule: span ? span.name : null, allow: allow,
          excluded: CODEMOD_EXCLUDE.some(function (re) { return re.test(file); }),
        });
        // Report a protected span once, not once per brand match inside it.
        if (span) BRAND_RE.lastIndex = Math.max(BRAND_RE.lastIndex, span.end);
      }
    }
  });
  return hits;
}

var CATEGORIES = ["allow-listed", "identifier", "env-var", "persisted-name", "interface-name", "external-name", "user-visible text", "comment", "tests", "package-metadata", "docs"];

function tally(hits, keyFn) {
  var t = {};
  hits.forEach(function (h) { var k = keyFn(h); t[k] = (t[k] || 0) + 1; });
  return t;
}

function toMarkdown(hits) {
  var out = [];
  out.push("# Rebrand inventory");
  out.push("");
  out.push("Generated by `node scripts/rebrand-inventory.js`. Counts are occurrences of `clagentic` (any case) and product uses of `clay` (word-bounded).");
  out.push("");
  out.push("Total: **" + hits.length + "** occurrences in **" + new Set(hits.map(function (h) { return h.file; })).size + "** files.");
  out.push("");
  out.push("## Counts per category");
  out.push("");
  out.push("| Category | code | tests | docs/md | total |");
  out.push("|---|---:|---:|---:|---:|");
  var byCat = tally(hits, function (h) { return h.category; });
  CATEGORIES.forEach(function (c) {
    if (!byCat[c]) return;
    var sub = hits.filter(function (h) { return h.category === c; });
    var s = tally(sub, function (h) { return h.scope; });
    out.push("| " + c + " | " + (s.code || 0) + " | " + (s.tests || 0) + " | " + (s.docs || 0) + " | " + sub.length + " |");
  });
  out.push("");
  CATEGORIES.forEach(function (c) {
    var sub = hits.filter(function (h) { return h.category === c; });
    if (!sub.length) return;
    out.push("## " + c + " (" + sub.length + ")");
    out.push("");
    if (c === "env-var" || c === "persisted-name" || c === "interface-name" || c === "external-name") {
      var tokens = {};
      sub.forEach(function (h) {
        var key = h.token + (h.rule ? "  [" + h.rule + "]" : "");
        (tokens[key] = tokens[key] || []).push(h);
      });
      Object.keys(tokens).sort().forEach(function (k) {
        var hs = tokens[k];
        var sites = {};
        hs.forEach(function (h) { (sites[h.file] = sites[h.file] || []).push(h.line); });
        var files = Object.keys(sites).sort();
        out.push("- `" + k + "` x" + hs.length + ": " + files.map(function (f) {
          var ls = sites[f];
          return f + ":" + (ls.length > 4 ? ls.slice(0, 4).join(",") + ",+" + (ls.length - 4) : ls.join(","));
        }).join("; "));
      });
    } else {
      var perFile = tally(sub, function (h) { return h.file; });
      Object.keys(perFile).sort().forEach(function (f) { out.push("- " + f + " (" + perFile[f] + ")"); });
    }
    out.push("");
  });
  return out.join("\n");
}

function remaining(hits) {
  // Outside the allow-list, README/docs (R6) and files other phases own are still reported but only these fail --check.
  return hits.filter(function (h) { return h.category !== "allow-listed" && h.scope !== "docs"; });
}

if (require.main === module) {
  var args = process.argv.slice(2);
  var root = path.resolve(__dirname, "..");
  var hits = scan(root);
  if (args.indexOf("--json") !== -1) {
    console.log(JSON.stringify(hits, null, 1));
  } else if (args.indexOf("--summary") !== -1 || args.indexOf("--check") !== -1) {
    var t = tally(hits, function (h) { return h.scope + "/" + h.category; });
    console.log(JSON.stringify(t, null, 1));
    if (args.indexOf("--check") !== -1) {
      var left = remaining(hits);
      console.log("remaining outside allow-list and docs: " + left.length);
      process.exit(left.length ? 1 : 0);
    }
  } else {
    console.log(toMarkdown(hits));
  }
}

module.exports = { BRAND_RE: BRAND_RE, RULES: RULES, CODEMOD_EXCLUDE: CODEMOD_EXCLUDE, protectedSpans: protectedSpans, scan: scan, listFiles: listFiles, toMarkdown: toMarkdown, remaining: remaining };

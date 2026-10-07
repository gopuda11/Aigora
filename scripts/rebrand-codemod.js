#!/usr/bin/env node
"use strict";

// Mechanical rename clagentic/Clagentic/CLAGENTIC and product "clay" -> aigora/Aigora/AIGORA.
// Skips protected names (env vars, persisted names, external/interface names) and files owned by other phases;
// see scripts/rebrand-inventory.js for the rules. Prints collisions: a new identifier that already existed in the file.
//
//   node scripts/rebrand-codemod.js [--dry]

var fs = require("fs");
var path = require("path");
var inv = require("./rebrand-inventory");

var root = path.resolve(__dirname, "..");
var dry = process.argv.indexOf("--dry") !== -1;

function convert(word, next) {
  // loadClayrc -> loadAigoraRc
  if (/^rc(?![a-z])/.test(next || "") && /^clay$/i.test(word)) return convert(word) + "Rc";
  var low = word.toLowerCase().replace("clagentic", "aigora").replace(/^clay/, "aigora");
  if (word === word.toUpperCase()) return low.toUpperCase();
  if (word[0] === word[0].toUpperCase()) return low[0].toUpperCase() + low.slice(1);
  return low;
}

function rewriteLine(line, changes) {
  if (!/clagentic|clay/i.test(line)) return line;
  var spans = inv.protectedSpans(line);
  var re = new RegExp(inv.BRAND_RE.source, "g");
  var out = "", last = 0, m;
  while ((m = re.exec(line))) {
    var inSpan = spans.some(function (s) { return m.index >= s.start && m.index < s.end; });
    if (inSpan) continue;
    var end = m.index + m[0].length;
    var repl = convert(m[0], line.slice(end));
    if (/^rc(?![a-z])/.test(line.slice(end)) && /^clay$/i.test(m[0])) end += 2;
    // Product prose: "Clagentic: Console" / "Clagentic Console" -> "Aigora"
    var prose = /^(:\s*|\s+)Console\b/.exec(line.slice(end));
    if (prose && m[0] === "Clagentic") end += prose[0].length;
    changes.push([line.slice(m.index, end), repl]);
    out += line.slice(last, m.index) + repl;
    last = end;
    re.lastIndex = end;
  }
  return out + line.slice(last);
}

var files = inv.listFiles(root).filter(function (f) {
  return !inv.CODEMOD_EXCLUDE.some(function (re) { return re.test(f); }) && !/\.(png|jpe?g|gif|ico|webp|woff2?|zip|tgz|gz|pdf)$/i.test(f);
});

var touched = 0, total = 0, collisions = [];
files.forEach(function (f) {
  var p = path.join(root, f);
  var st = fs.statSync(p);
  if (!st.isFile()) return;
  var text = fs.readFileSync(p, "utf8");
  if (!/clagentic|clay/i.test(text)) return;
  var changes = [];
  var lines = text.split("\n").map(function (l) { return rewriteLine(l, changes); });
  if (!changes.length) return;
  var next = lines.join("\n");
  // Collision detection on identifier tokens: for each changed identifier, did its new spelling exist before?
  var oldIds = {};
  (text.match(/[A-Za-z0-9_$]*(?:aigora|Aigora|AIGORA)[A-Za-z0-9_$]*/g) || []).forEach(function (t) { oldIds[t] = true; });
  var origTokens = {};
  (text.match(/[A-Za-z0-9_$.-]*(?:[Cc][Ll][Aa][Gg][Ee][Nn][Tt][Ii][Cc]|[Cc][Ll][Aa][Yy])[A-Za-z0-9_$-]*/g) || []).forEach(function (t) { origTokens[t] = true; });
  Object.keys(origTokens).forEach(function (t) {
    var n = rewriteLine(t, []);
    if (n !== t && !/^(aigora|Aigora|AIGORA)$/.test(n) && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n) && oldIds[n]) collisions.push(f + ": " + t + " -> " + n);
  });
  total += changes.length;
  touched++;
  if (!dry) fs.writeFileSync(p, next);
});

console.log((dry ? "[dry] " : "") + "files changed: " + touched + ", replacements: " + total);
if (collisions.length) { console.log("COLLISIONS:"); collisions.forEach(function (c) { console.log("  " + c); }); }

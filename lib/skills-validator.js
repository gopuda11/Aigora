"use strict";
// Room skills v1 validator (docs/superpowers/specs/2026-10-03-room-skills-plugins.md section 3).
// Every source (zip upload, host ~/.claude/skills copy) is reduced to a list of raw entries and passes through
// validate(), which fails closed: a skill is SKILL.md plus text, script and asset files (fonts, images, pdf, office templates),
// carries no hooks, MCP, plugin parts, native executables, archives or tool grants, and is identified by a sha256 over its
// file tree. Scripts are data: they run only when the agent calls Bash, which needs admin approval inside the sandbox.
var fs = require("fs");
var path = require("path");
var zlib = require("zlib");
var crypto = require("crypto");

var LIMITS = { files: 500, fileBytes: 5 * 1024 * 1024, totalBytes: 20 * 1024 * 1024, zipBytes: 20 * 1024 * 1024, zipEntries: 1000,
  ratio: 100, ratioFloor: 64 * 1024, description: 1024, depth: 8 };
var TEXT_EXT = [".md", ".markdown", ".txt", ".rst", ".json", ".yaml", ".yml", ".csv", ".tsv", ".toml", ".xml", ".xsd", ".xsl", ".xslt", ".html", ".htm",
  ".css", ".svg", ".ini", ".cfg", ".conf", ".tex", ".sql", ".j2", ".tmpl"];
var SCRIPT_EXT = [".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".sh", ".bash", ".zsh", ".fish", ".rb", ".pl", ".pm", ".ps1", ".php", ".lua", ".r"];
// Binary assets and the magic bytes each must start with (a mismatch is rejected: the extension is never trusted alone).
var PK = [[0x50, 0x4b, 0x03, 0x04]];
var BINARY_TYPES = {
  ".ttf": { type: "font", magic: [[0, 1, 0, 0], [0x74, 0x72, 0x75, 0x65]] }, ".otf": { type: "font", magic: [[0x4f, 0x54, 0x54, 0x4f]] },
  ".woff": { type: "font", magic: [[0x77, 0x4f, 0x46, 0x46]] }, ".woff2": { type: "font", magic: [[0x77, 0x4f, 0x46, 0x32]] },
  ".png": { type: "image", magic: [[0x89, 0x50, 0x4e, 0x47]] }, ".jpg": { type: "image", magic: [[0xff, 0xd8, 0xff]] }, ".jpeg": { type: "image", magic: [[0xff, 0xd8, 0xff]] },
  ".gif": { type: "image", magic: [[0x47, 0x49, 0x46, 0x38]] }, ".webp": { type: "image", magic: [[0x52, 0x49, 0x46, 0x46]] },
  ".pdf": { type: "pdf", magic: [[0x25, 0x50, 0x44, 0x46]] },
  ".docx": { type: "office", magic: PK }, ".xlsx": { type: "office", magic: PK }, ".pptx": { type: "office", magic: PK },
};
// Never allowed, by extension (and below, by magic bytes): native code and archives.
var NATIVE_EXT = [".exe", ".dll", ".so", ".dylib", ".bin", ".o", ".a", ".node", ".class", ".msi", ".com", ".sys"];
var ARCHIVE_EXT = [".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".jar", ".whl", ".egg", ".war", ".apk"];
var BANNED_DIRS = ["hooks", "commands", "agents", ".claude-plugin"];
// Hidden entries allowed at the skill root only.
var HIDDEN_OK_ROOT = [".gitignore", ".gitattributes", ".github"];
var NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
// Frontmatter keys that grant tools or change execution (compared lowercased, "_" folded to "-").
var FORBIDDEN_KEYS = ["allowed-tools", "disallowed-tools", "tools", "hooks", "model", "context", "agent", "mcp-servers", "mcp",
  "permission-mode", "permissions", "shell", "effort", "env"];

function err(code, file) { var e = { code: code }; if (file !== undefined) e.path = file; return e; }

// ---- raw entry sources ------------------------------------------------------------------------------------------

var CRC_TABLE = (function () {
  var t = [];
  for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  var c = 0xFFFFFFFF;
  for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// Minimal zip reader: stored and deflate entries only; no zip64, no encryption. Returns { entries } or { errors }.
// Entry: { path, type: "file"|"dir"|"symlink"|"special", mode, data? }.
function readZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) return { errors: [err("zip_invalid")] };
  if (buf.length > LIMITS.zipBytes) return { errors: [err("zip_too_large")] };
  var eocd = -1;
  for (var i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return { errors: [err("zip_invalid")] };
  var count = buf.readUInt16LE(eocd + 10), cdSize = buf.readUInt32LE(eocd + 12), cdOff = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0) return { errors: [err("zip_unsupported")] };
  if (count === 0xFFFF || cdOff === 0xFFFFFFFF || cdSize === 0xFFFFFFFF) return { errors: [err("zip_unsupported")] };
  if (count > LIMITS.zipEntries) return { errors: [err("too_many_files")] };
  if (cdOff + cdSize > eocd) return { errors: [err("zip_invalid")] };
  var entries = [], spans = [], total = 0, p = cdOff;
  for (var n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return { errors: [err("zip_invalid")] };
    var madeBy = buf.readUInt16LE(p + 4), flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10);
    var crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    var nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    var ext = buf.readUInt32LE(p + 38), loff = buf.readUInt32LE(p + 42);
    if (p + 46 + nlen > buf.length) return { errors: [err("zip_invalid")] };
    var name = buf.slice(p + 46, p + 46 + nlen).toString("utf8");
    p += 46 + nlen + xlen + clen;
    if (csize === 0xFFFFFFFF || usize === 0xFFFFFFFF || loff === 0xFFFFFFFF) return { errors: [err("zip_unsupported", name)] };
    if (flags & 1) return { errors: [err("zip_encrypted", name)] };
    var unixMode = (madeBy >> 8) === 3 ? (ext >>> 16) & 0xFFFF : 0;
    var fmt = unixMode & 0o170000;
    var isDir = name.endsWith("/") || fmt === 0o040000;
    var e = { path: name, mode: unixMode & 0o777 };
    if (isDir) { e.type = "dir"; entries.push(e); continue; }
    if (fmt === 0o120000) { e.type = "symlink"; entries.push(e); continue; }
    if (fmt !== 0 && fmt !== 0o100000) { e.type = "special"; entries.push(e); continue; }
    if (method !== 0 && method !== 8) return { errors: [err("zip_unsupported", name)] };
    total += usize;
    if (usize > LIMITS.fileBytes) return { errors: [err("file_too_large", name)] };
    if (total > LIMITS.totalBytes) return { errors: [err("total_too_large")] };
    if (usize > LIMITS.ratioFloor && usize / Math.max(csize, 1) > LIMITS.ratio) return { errors: [err("zip_bomb", name)] };
    if (loff + 30 > buf.length || buf.readUInt32LE(loff) !== 0x04034b50) return { errors: [err("zip_invalid", name)] };
    var start = loff + 30 + buf.readUInt16LE(loff + 26) + buf.readUInt16LE(loff + 28);
    if (start + csize > cdOff) return { errors: [err("zip_invalid", name)] };
    spans.push([loff, start + csize]);
    var raw = buf.slice(start, start + csize), data;
    try { data = method === 0 ? raw : zlib.inflateRawSync(raw, { maxOutputLength: usize + 1 }); }
    catch (_) { return { errors: [err("zip_invalid", name)] }; }
    if (data.length !== usize || crc32(data) !== crc) return { errors: [err("zip_invalid", name)] };
    e.type = "file"; e.data = data; entries.push(e);
  }
  spans.sort(function (a, b) { return a[0] - b[0]; });
  for (var s = 1; s < spans.length; s++) if (spans[s][0] < spans[s - 1][1]) return { errors: [err("zip_bomb")] }; // overlapping members
  return { entries: entries };
}

// Reads a host skill directory without following a single link. Returns { entries } or { errors }.
function readDir(dir) {
  var entries = [], errors = [], stack = [{ abs: dir, rel: "", depth: 0 }];
  try {
    var top = fs.lstatSync(dir);
    if (top.isSymbolicLink()) return { errors: [err("symlink", "")] };
    if (!top.isDirectory()) return { errors: [err("not_found")] };
  } catch (_) { return { errors: [err("not_found")] }; }
  var total = 0;
  while (stack.length) {
    var cur = stack.pop(), names;
    if (cur.depth > LIMITS.depth) return { errors: [err("too_deep", cur.rel)] };
    try { names = fs.readdirSync(cur.abs); } catch (_) { return { errors: [err("not_found")] }; }
    for (var i = 0; i < names.length; i++) {
      var abs = path.join(cur.abs, names[i]), rel = cur.rel ? cur.rel + "/" + names[i] : names[i], st;
      try { st = fs.lstatSync(abs); } catch (_) { return { errors: [err("not_found", rel)] }; }
      if (entries.length > LIMITS.files + 50) return { errors: [err("too_many_files")] };
      if (st.isSymbolicLink()) { entries.push({ path: rel, type: "symlink", mode: st.mode & 0o777 }); continue; }
      if (st.isDirectory()) { entries.push({ path: rel + "/", type: "dir", mode: st.mode & 0o777 }); stack.push({ abs: abs, rel: rel, depth: cur.depth + 1 }); continue; }
      if (!st.isFile()) { entries.push({ path: rel, type: "special", mode: st.mode & 0o777 }); continue; }
      if (st.nlink > 1) { entries.push({ path: rel, type: "hardlink", mode: st.mode & 0o777 }); continue; }
      if (st.size > LIMITS.fileBytes) return { errors: [err("file_too_large", rel)] };
      total += st.size;
      if (total > LIMITS.totalBytes) return { errors: [err("total_too_large")] };
      var fd = null, data;
      try {
        fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        var fst = fs.fstatSync(fd);
        if (fst.ino !== st.ino || fst.dev !== st.dev || !fst.isFile()) return { errors: [err("symlink", rel)] };
        data = Buffer.alloc(fst.size);
        var got = 0; while (got < data.length) { var r = fs.readSync(fd, data, got, data.length - got, got); if (!r) break; got += r; }
        if (got !== data.length) return { errors: [err("not_found", rel)] };
      } catch (_) { return { errors: [err("symlink", rel)] }; }
      finally { if (fd !== null) try { fs.closeSync(fd); } catch (_) {} }
      entries.push({ path: rel, type: "file", mode: st.mode & 0o777, data: data });
    }
  }
  return { entries: entries, errors: errors };
}

// ---- validation -------------------------------------------------------------------------------------------------

function unsafePath(p) {
  if (typeof p !== "string" || !p || p.indexOf("\0") !== -1 || p.indexOf("\\") !== -1 || p.charAt(0) === "/" || /^[A-Za-z]:/.test(p)) return true;
  var parts = p.replace(/\/$/, "").split("/");
  return parts.some(function (s) { return s === "" || s === "." || s === ".."; });
}

function parseFrontmatter(text) {
  var m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return null;
  var lines = m[1].split(/\r?\n/), out = {}, keys = [];
  for (var i = 0; i < lines.length; i++) {
    var km = /^([A-Za-z0-9_-]+)[ \t]*:(.*)$/.exec(lines[i]);
    if (!km) { if (/^\S/.test(lines[i]) && lines[i].trim() && lines[i].charAt(0) !== "#") return null; continue; }
    var key = km[1], val = km[2].trim();
    keys.push(key);
    if (/^[|>][+-]?$/.test(val)) {
      var parts = [];
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || lines[i + 1] === "")) parts.push(lines[++i].trim());
      val = parts.join(" ").trim();
    } else if (val === "") {
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]) && !/^\s+[A-Za-z0-9_-]+\s*:/.test(lines[i + 1])) val += (val ? " " : "") + lines[++i].trim();
    }
    if (/^(".*"|'.*')$/.test(val)) val = val.slice(1, -1);
    if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = val;
  }
  return { values: out, keys: keys };
}

function startsWith(data, sig, at) {
  at = at || 0;
  if (data.length < at + sig.length) return false;
  for (var i = 0; i < sig.length; i++) if (data[at + i] !== sig[i]) return false;
  return true;
}
// "elf" | "macho" | "pe" for native executable or shared library bytes, "" otherwise.
function nativeMagic(d) {
  if (startsWith(d, [0x7f, 0x45, 0x4c, 0x46])) return "elf";
  if ([[0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf], [0xce, 0xfa, 0xed, 0xfe], [0xcf, 0xfa, 0xed, 0xfe], [0xca, 0xfe, 0xba, 0xbe], [0xbe, 0xba, 0xfe, 0xca]]
    .some(function (m) { return startsWith(d, m); })) return "macho";
  if (startsWith(d, [0x4d, 0x5a]) && d.length >= 64) {
    var off = d.readUInt32LE(0x3c);
    if (off + 4 <= d.length && startsWith(d, [0x50, 0x45, 0, 0], off)) return "pe";
  }
  return "";
}
function archiveMagic(d) {
  return startsWith(d, [0x50, 0x4b, 0x03, 0x04]) || startsWith(d, [0x50, 0x4b, 0x05, 0x06]) || startsWith(d, [0x1f, 0x8b]) || startsWith(d, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) ||
    startsWith(d, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]) || startsWith(d, [0x42, 0x5a, 0x68]) || startsWith(d, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]) || startsWith(d, [0x75, 0x73, 0x74, 0x61, 0x72], 257);
}
// Extension-only class of a path: "binary" | "script" | "text".
function kindOfPath(p) {
  var ext = path.extname(String(p).toLowerCase());
  return BINARY_TYPES[ext] ? "binary" : SCRIPT_EXT.indexOf(ext) !== -1 ? "script" : "text";
}
// { kind: "text"|"script"|"binary", type? } for a file; a text file that begins with #! counts as a script.
function classify(p, data) {
  var ext = path.extname(String(p).toLowerCase());
  if (BINARY_TYPES[ext]) return { kind: "binary", type: BINARY_TYPES[ext].type };
  if (SCRIPT_EXT.indexOf(ext) !== -1 || (data && data.length > 1 && data[0] === 0x23 && data[1] === 0x21)) return { kind: "script" };
  return { kind: "text" };
}

var NET_RE = /\b(curl|wget|requests|urllib|urlopen|fetch|socket|httpx|aiohttp|XMLHttpRequest|axios)\b/i;
var CRED_RE = /(\.ssh\b|\.codex\b|\.claude\b|auth\.json|credentials)/i;
function settingsHaveHooks(data) {
  var text = data.toString("utf8");
  try { var o = JSON.parse(text); return !!o && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, "hooks"); }
  catch (_) { return /"hooks"/.test(text); }
}
function lint(files) {
  var notes = [];
  files.forEach(function (f) {
    if (classify(f.path, f.data).kind === "binary") return;
    var script = classify(f.path, f.data).kind === "script", per = {};
    f.data.toString("utf8").split(/\r?\n/).forEach(function (line, i) {
      var code = null;
      if (script) code = NET_RE.test(line) ? "network_access" : CRED_RE.test(line) ? "credential_path" : null;
      else if (/\b(curl|wget|ssh|scp|sudo|chmod|eval|npx|npm|pip3?|bash|sh -c|rm -rf)\b/i.test(line)) code = "runs_commands";
      else if (/https?:\/\//i.test(line)) code = "fetches_urls";
      if (!code || notes.length >= 40 || (per[code] = (per[code] || 0) + 1) > 3) return;
      notes.push({ code: code, path: f.path, line: i + 1 });
      if (script && code === "network_access" && CRED_RE.test(line) && (per.credential_path = (per.credential_path || 0) + 1) <= 3) notes.push({ code: "credential_path", path: f.path, line: i + 1 });
    });
  });
  return notes;
}

function hashFiles(files) {
  var h = crypto.createHash("sha256");
  files.slice().sort(function (a, b) { return a.path < b.path ? -1 : a.path > b.path ? 1 : 0; }).forEach(function (f) {
    h.update(crypto.createHash("sha256").update(f.data).digest("hex") + " " + f.data.length + " " + f.path + "\n");
  });
  return h.digest("hex");
}

// entries -> { ok, errors, skill? }. skill = { name, description, files: [{path, data}], sha256, size, lint }.
function validate(entries) {
  var errors = [];
  function fail(code, p) { if (errors.length < 30) errors.push(err(code, p)); }
  entries = (entries || []).filter(function (e) { return !(typeof e.path === "string" && /^__MACOSX\//.test(e.path)); });
  var files = [], seen = Object.create(null);
  entries.forEach(function (e) {
    if (unsafePath(e.path)) { fail("unsafe_path", String(e.path).slice(0, 120)); return; }
    var p = e.path.replace(/\/$/, "");
    var fold = p.normalize("NFC").toLowerCase();
    if (seen[fold]) fail("duplicate_path", p); else seen[fold] = true;
    if (e.type === "symlink") { fail("symlink", p); return; }
    if (e.type === "hardlink") { fail("hardlink", p); return; }
    if (e.type === "special") { fail("special_file", p); return; }
    if (e.type === "dir") { if (p.split("/").some(function (s) { return BANNED_DIRS.indexOf(s.toLowerCase()) !== -1; })) fail("forbidden_path", p); return; }
    if (e.type === "file") files.push({ path: p, data: e.data, mode: e.mode || 0 });
  });
  if (errors.length) return { ok: false, errors: errors };
  if (files.length === 0) return { ok: false, errors: [err("no_skill_md")] };
  if (files.length > LIMITS.files) return { ok: false, errors: [err("too_many_files")] };
  // Skill root: top level, or the single directory that holds SKILL.md.
  var rootDir = "";
  if (!files.some(function (f) { return f.path === "SKILL.md"; })) {
    var tops = Object.keys(files.reduce(function (a, f) { a[f.path.split("/")[0]] = 1; return a; }, {}));
    if (tops.length === 1 && files.some(function (f) { return f.path === tops[0] + "/SKILL.md"; })) rootDir = tops[0] + "/";
    else if (tops.length > 1 && tops.some(function (t) { return files.some(function (f) { return f.path === t + "/SKILL.md"; }); })) return { ok: false, errors: [err("multiple_roots")] };
    else return { ok: false, errors: [err("no_skill_md")] };
  }
  files = files.map(function (f) { return { path: rootDir ? f.path.slice(rootDir.length) : f.path, data: f.data, mode: f.mode }; });
  var total = 0;
  files.forEach(function (f) {
    var parts = f.path.split("/"), base = parts[parts.length - 1], lower = base.toLowerCase(), ext = path.extname(lower);
    total += f.data.length;
    if (f.data.length > LIMITS.fileBytes) fail("file_too_large", f.path);
    if (parts.slice(0, -1).some(function (s) { return BANNED_DIRS.indexOf(s.toLowerCase()) !== -1; })) { fail("forbidden_path", f.path); return; }
    if (lower === ".mcp.json" || lower === "mcp.json" || lower === "hooks.json") { fail("forbidden_path", f.path); return; }
    if (parts.some(function (s, i) { return s.charAt(0) === "." && !(i === 0 && HIDDEN_OK_ROOT.indexOf(s) !== -1); })) { fail("hidden_path", f.path); return; }
    if (lower === "skill.md" && f.path !== "SKILL.md") { fail("nested_skill", f.path); return; }
    var nat = nativeMagic(f.data);
    if (nat || NATIVE_EXT.indexOf(ext) !== -1 || /\.so\.\d/.test(lower)) { fail("native_binary", f.path); return; }
    var bin = BINARY_TYPES[ext];
    if (ARCHIVE_EXT.indexOf(ext) !== -1 || (!bin || bin.type !== "office") && archiveMagic(f.data)) { fail("archive_file", f.path); return; }
    if (bin) {
      if (!bin.magic.some(function (m) { return startsWith(f.data, m); }) || (ext === ".webp" && !startsWith(f.data, [0x57, 0x45, 0x42, 0x50], 8))) fail("type_mismatch", f.path);
      return;
    }
    if (f.data.indexOf(0) !== -1) { fail("nul_byte", f.path); return; }
    if (ext && TEXT_EXT.indexOf(ext) === -1 && SCRIPT_EXT.indexOf(ext) === -1) { fail("bad_extension", f.path); return; }
    try { new TextDecoder("utf-8", { fatal: true }).decode(f.data); } catch (_) { fail("not_utf8", f.path); return; }
    if ((lower === "settings.json" || lower === "settings.local.json") && settingsHaveHooks(f.data)) fail("forbidden_path", f.path);
  });
  if (total > LIMITS.totalBytes) fail("total_too_large");
  if (errors.length) return { ok: false, errors: errors };
  var md = files.filter(function (f) { return f.path === "SKILL.md"; })[0];
  var fm = parseFrontmatter(md.data.toString("utf8"));
  if (!fm) return { ok: false, errors: [err("bad_frontmatter", "SKILL.md")] };
  fm.keys.forEach(function (k) { if (FORBIDDEN_KEYS.indexOf(k.toLowerCase().replace(/_/g, "-")) !== -1) fail("forbidden_frontmatter_key", k); });
  var name = fm.values.name, description = fm.values.description;
  if (typeof name !== "string" || !NAME_RE.test(name)) fail("bad_name", "SKILL.md");
  if (typeof description !== "string" || !description.trim()) fail("bad_description", "SKILL.md");
  else if (description.length > LIMITS.description) fail("description_too_long", "SKILL.md");
  if (errors.length) return { ok: false, errors: errors };
  return { ok: true, errors: [], skill: { name: name, description: description.trim(), files: files.map(function (f) { return { path: f.path, data: f.data }; }),
    sha256: hashFiles(files), size: total, lint: lint(files) } };
}

function validateZip(buf) {
  var r = readZip(buf);
  return r.errors ? { ok: false, errors: r.errors } : validate(r.entries);
}
function validateHostDir(dir) {
  var r = readDir(dir);
  return r.errors && r.errors.length ? { ok: false, errors: r.errors } : validate(r.entries);
}
// Names (only) in the host skills directory. Contents are never read until the admin picks one.
function listHostSkills(hostDir) {
  var names;
  try { names = fs.readdirSync(hostDir); } catch (_) { return []; }
  return names.filter(function (n) { return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(n); }).filter(function (n) {
    try { var st = fs.lstatSync(path.join(hostDir, n)); return st.isDirectory() || st.isSymbolicLink(); } catch (_) { return false; }
  }).sort();
}

module.exports = { LIMITS: LIMITS, classify: classify, kindOfPath: kindOfPath, readDir: readDir, validate: validate, validateZip: validateZip,
  validateHostDir: validateHostDir, listHostSkills: listHostSkills, crc32: crc32,
  isValidName: function (n) { return typeof n === "string" && NAME_RE.test(n); } };

"use strict";
// room-bash-policy.js - classifier for Bash commands of a contained room/private turn.
// readOnlyInWorkspace(command, workspace, opts) -> { allow, reason }. allow=true only when the command is
// provably read-only (allow-listed programs with dangerous options denied) and every path it names resolves
// inside the turn's workspace. Fail-closed: anything not fully understood returns allow=false (=> admin approval).
// Deliberately NOT supported: redirections to files, $ / backtick / process substitution, background &, env
// prefixes, newlines, "..", "~", brace expansion, awk, interpreters, anything that executes or writes.
var fs = require("fs");
var path = require("path");

var BAD_CHARS = /[\u0000-\u0008\u000a-\u001f\u007f-\u00a0\u00ad\u061c\u180e\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3000\ufeff\ufff0-\uffff]/;
var NULL_REDIR = /^(2>\/dev\/null|>\/dev\/null|2>&1)(?=[\s;|&)]|$)/;

function fail(reason) { return { ok: false, reason: reason }; }

// Words: {v, glob, tilde, plain}; operators: {op}; harmless fd redirects: {redir}.
function tokenize(s) {
  if (typeof s !== "string" || !s.trim() || s.length > 8000) return fail("empty or too long");
  if (BAD_CHARS.test(s)) return fail("control or unusual unicode character");
  var out = [], i = 0, n = s.length;
  while (i < n) {
    var c = s[i];
    if (c === " " || c === "\t") { i++; continue; }
    var m = NULL_REDIR.exec(s.slice(i));
    if (m) { out.push({ redir: true }); i += m[0].length; continue; }
    if (c === "|") { if (s[i + 1] === "|") { out.push({ op: "||" }); i += 2; } else { out.push({ op: "|" }); i++; } continue; }
    if (c === "&") { if (s[i + 1] === "&") { out.push({ op: "&&" }); i += 2; continue; } return fail("background or &"); }
    if (c === ";") { if (s[i + 1] === ";") return fail(";;"); out.push({ op: ";" }); i++; continue; }
    if (c === "(" || c === ")") { out.push({ op: c }); i++; continue; }
    if (c === "<" || c === ">") return fail("redirection");
    var w = { v: "", glob: false, tilde: false, plain: true };
    if (c === "~") w.tilde = true;
    if (c === "#") return fail("comment");
    while (i < n) {
      c = s[i];
      if (c === " " || c === "\t" || "|&;()<>".indexOf(c) !== -1) break;
      if (c === "'") {
        var e = s.indexOf("'", i + 1);
        if (e < 0) return fail("unterminated quote");
        w.v += s.slice(i + 1, e); w.plain = false; i = e + 1;
      } else if (c === "\"") {
        w.plain = false; i++;
        for (;;) {
          if (i >= n) return fail("unterminated quote");
          c = s[i];
          if (c === "\"") { i++; break; }
          if (c === "$" || c === "`") return fail("expansion in double quotes");
          if (c === "\\") { if (s[i + 1] === "\"" || s[i + 1] === "\\") { w.v += s[i + 1]; i += 2; continue; } return fail("escape in double quotes"); }
          w.v += c; i++;
        }
      } else if (c === "\\") {
        if (i + 1 >= n) return fail("trailing backslash");
        w.v += s[i + 1]; w.plain = false; i += 2;
      } else if (c === "$" || c === "`") return fail("expansion");
      else if (c === "{" || c === "}") return fail("brace");
      else if (c === "[") return fail("bracket glob");     // bash bracket expressions (POSIX classes, leading ]) are not modelled
      else { if (c === "*" || c === "?") w.glob = true; w.v += c; i++; }
    }
    out.push(w);
  }
  return { ok: true, tokens: out };
}

// Command tree flattened to events: {cmd:[words], prev, next}, {push}, {pop}.
function parse(tokens) {
  var ev = [], cur = [], expectCmd = true, afterParen = false, depth = 0, lastOp = null;
  function endCmd(next) {
    if (!cur.length) return false;
    ev.push({ cmd: cur, prev: lastOp, next: next });
    cur = []; return true;
  }
  for (var k = 0; k < tokens.length; k++) {
    var t = tokens[k];
    if (t.op === undefined) {
      if (afterParen) return fail("word after )");
      if (t.redir) { if (!cur.length) return fail("redirect without command"); continue; }
      cur.push(t); expectCmd = false; continue;
    }
    var op = t.op;
    if (op === "(") {
      if (cur.length || !expectCmd) return fail("misplaced (");
      ev.push({ push: true }); depth++; lastOp = "("; continue;
    }
    if (op === ")") {
      if (depth < 1) return fail("unbalanced )");
      if (!afterParen && !endCmd(")")) return fail("empty group");
      ev.push({ pop: true }); depth--; afterParen = true; expectCmd = false; lastOp = ")"; continue;
    }
    if (afterParen) { afterParen = false; ev[ev.length - 1].next = op; }
    else if (!endCmd(op)) return fail("empty command");
    lastOp = op; expectCmd = true;
  }
  if (depth) return fail("unbalanced (");
  if (!afterParen && cur.length) endCmd(null);
  else if (expectCmd && lastOp !== ";") return fail("dangling operator");
  if (!ev.some(function (e) { return e.cmd; })) return fail("no command");
  return { ok: true, events: ev };
}

function resolveReal(target) {
  var rest = [], cur = target;
  for (;;) {
    try { return path.join.apply(null, [fs.realpathSync(cur)].concat(rest)); }
    catch (e) {
      var st = null;
      try { st = fs.lstatSync(cur); } catch (_) {}
      if (st && st.isSymbolicLink()) return null;
      var parent = path.dirname(cur);
      if (parent === cur) return null;
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}
function inside(root, p) { return p === root || p.indexOf(root.endsWith(path.sep) ? root : root + path.sep) === 0; }

var GLOB_CAP = 500;

function segRegex(seg) {
  var re = "^";
  for (var i = 0; i < seg.length; i++) {
    var c = seg[i];
    if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|\\\/\-\[\]]/g, "\\$&");
  }
  return new RegExp(re + "$");
}

// Expand a glob like bash would (no dotfiles unless the pattern says so). null on error or more than GLOB_CAP hits.
// No match: the literal word is passed through, as bash does.
function expandGlob(segs, start) {
  var seen = 0, out = [];
  function walk(base, i) {
    if (i === segs.length) { out.push(base); return true; }
    var seg = segs[i];
    if (seg === "" || seg === ".") return walk(base, i + 1);
    if (!/[*?[]/.test(seg)) return walk(path.join(base, seg), i + 1);
    var re;
    try { re = segRegex(seg); } catch (_) { return false; }
    var names;
    try { names = fs.readdirSync(base); } catch (_) { return true; }
    for (var k = 0; k < names.length; k++) {
      if (++seen > GLOB_CAP) return false;
      if (names[k][0] === "." && seg[0] !== ".") continue;
      if (!re.test(names[k])) continue;
      if (!walk(path.join(base, names[k]), i + 1)) return false;
      if (out.length > GLOB_CAP) return false;
    }
    return true;
  }
  if (!walk(start, 0)) return null;
  if (!out.length) out.push(path.join(start, segs.join("/").replace(/^\/+/, "")));
  return out;
}

// One path-like string, relative to cwd. Rejects "..", "~", empty; for globs only the literal prefix is resolved.
// FIFOs, devices and sockets can block or have side effects: only regular files and directories pass.
function plainFile(real) {
  try { var st = fs.statSync(real); return st.isFile() || st.isDirectory(); } catch (_) { return true; }
}

function pathOk(p, cwd, root, glob, tilde) {
  if (tilde || p === "" || p.indexOf("~") === 0) return false;
  if (p === "-") return true;
  var segs = p.split("/");
  if (segs.indexOf("..") !== -1) return false;
  if (glob) {
    var matches = expandGlob(segs, p[0] === "/" ? "/" : cwd);
    if (!matches) return false;
    return matches.every(function (m) { var r = resolveReal(m); return !!r && inside(root, r) && plainFile(r); });
  }
  var real = resolveReal(path.resolve(cwd, p));
  return !!real && inside(root, real) && plainFile(real);
}

// ---- per-program option tables (ALLOW-list: anything not listed asks) -----------------------------------------------
// sf/st/sp: short letters that are flags / take a text value / take a path value. lf/lt/lp/lo: long names that are
// flags / take a text value / take a path value / take an optional "=text" value. num: "-5" style count is accepted.
// so: short letters with an OPTIONAL value that counts only when attached (od -w8; "-w" alone is a flag).
// exact: option words are exactly "-X" or "-X<digits>" for value letters (xxd only reads the first 2 chars of a word).
// Not listed on purpose (symlink following, writing, exec, reading a list of file names): ls -L -H, du -L -H -D,
// find -L -H -follow -files0-from, grep -R, tree -l, stat -L, file -L/-f/-C/-m, wc --files0-from, sha*sum -c,
// sort -o -T, tail -f, rg --pre -z -L, diff --paginate, xxd -r, hexdump -f ...
var TABLES = {
  ls: { sf: "aAbBcCdfFgGhiklmnNopqQrRsStuUvxX1", st: "IwT", lf: "all almost-all escape ignore-backups directory classify file-type human-readable si inode kibibytes numeric-uid-gid literal hide-control-chars quote-name reverse recursive size group-directories-first no-group author full-time zero",
    lt: "sort time format ignore hide width tabsize indicator-style quoting-style time-style block-size", lo: "color hyperlink" },
  cat: { sf: "AbeEnstTuv", lf: "show-all number-nonblank show-ends number squeeze-blank show-tabs show-nonprinting" },
  head: { sf: "qvz", st: "cn", lf: "quiet silent verbose zero-terminated", lt: "bytes lines", num: true },
  tail: { sf: "qvz", st: "cn", lf: "quiet silent verbose zero-terminated", lt: "bytes lines", num: true },
  wc: { sf: "cmlLw", lf: "bytes chars lines max-line-length words" },
  file: { sf: "bikNz", lf: "brief mime mime-type mime-encoding keep-going no-pad uncompress" },
  stat: { sf: "ft", st: "c", lf: "file-system terse", lt: "format printf" },
  du: { sf: "abchkmsSx", st: "dB", lf: "all apparent-size bytes total human-readable si summarize separate-dirs one-file-system inodes",
    lt: "max-depth block-size exclude threshold", lo: "time" },
  nl: { st: "bdfhilnsvw", sf: "p" },
  column: { sf: "tx", st: "sOoc" },
  cmp: { sf: "lsb", st: "ni", lf: "print-bytes verbose silent quiet", lt: "bytes ignore-initial" },
  diff: { sf: "qucyiwbBEZaspdtT", st: "UCxW", lf: "brief unified context side-by-side ignore-case ignore-all-space ignore-space-change ignore-blank-lines text report-identical-files ignore-trailing-space strip-trailing-cr show-c-function minimal expand-tabs initial-tab" },
  md5sum: { sf: "btz", lf: "binary text zero tag" },
  xxd: { sf: "abEeipu", st: "cglos", exact: true },
  od: { sf: "abcdfhilosxv", st: "AjNt", so: "w" },
  hexdump: { sf: "CcdoxvbU", st: "ns" },
  strings: { sf: "afow", st: "net", lf: "all print-file-name include-all-whitespace", lt: "bytes radix encoding" },
  zipinfo: { sf: "12hlmstTvzMC" },
  realpath: { sf: "emsqz", lf: "canonicalize-existing canonicalize-missing no-symlinks strip quiet zero", lp: "relative-to relative-base" },
  sort: { sf: "bdfghiMnRrVcCsuzm", st: "ktS", lf: "ignore-leading-blanks dictionary-order ignore-case general-numeric-sort human-numeric-sort ignore-nonprinting month-sort numeric-sort random-sort reverse version-sort stable unique zero-terminated merge debug",
    lt: "key field-separator buffer-size parallel", lo: "check" },
  uniq: { sf: "cdDiuz", st: "fsw", lf: "count repeated ignore-case unique zero-terminated", lt: "skip-fields skip-chars check-chars", lo: "all-repeated group" },
  cut: { sf: "nsz", st: "bcdf", lf: "only-delimited zero-terminated complement", lt: "bytes characters delimiter fields output-delimiter" },
  tr: { sf: "cCdst", lf: "complement delete squeeze-repeats truncate-set1" },
  tree: { sf: "adfipsugDFQNtrnCxvcU", st: "LPI", lf: "noreport dirsfirst du si prune", lt: "filelimit charset" },
  basename: { sf: "az", st: "s", lf: "multiple zero", lt: "suffix" },
  dirname: { sf: "z", lf: "zero" },
  pwd: { sf: "LP" },
  grep: { sf: "EFGPiyvwxcLlnoqsbHhZzaITUr", st: "emABCdD", sp: "f", num: true,
    lf: "extended-regexp fixed-strings basic-regexp perl-regexp ignore-case no-ignore-case invert-match word-regexp line-regexp count files-without-match files-with-matches only-matching quiet silent no-messages byte-offset with-filename no-filename line-number initial-tab null-data text recursive null line-buffered no-group-separator",
    lt: "regexp max-count label binary-files after-context before-context context directories devices include exclude exclude-dir group-separator", lp: "file exclude-from", lo: "color colour" },
  rg: { sf: "isSvwxclnNoquUhHaI0", st: "egABCmtTj", sp: "f", num: true,
    lf: "ignore-case case-sensitive smart-case invert-match word-regexp line-regexp fixed-strings count count-matches files files-with-matches files-without-match line-number no-line-number only-matching quiet hidden no-ignore heading no-heading with-filename no-filename null column no-messages trim multiline pcre2 text binary type-list no-config",
    lt: "regexp glob iglob type type-not max-count max-depth after-context before-context context sort sortr threads color", lp: "file" },
};
TABLES.egrep = TABLES.fgrep = TABLES.grep;
["sha1sum", "sha224sum", "sha256sum", "sha384sum", "sha512sum", "b2sum"].forEach(function (k) { TABLES[k] = TABLES.md5sum; });
var TEXT_ONLY = { tr: 1, basename: 1, dirname: 1, echo: 1, printf: 1, "true": 1, "false": 1 };   // plain-text operands are not paths
var GREPS = { grep: 1, egrep: 1, fgrep: 1, rg: 1 };
var MAXOPERANDS = { uniq: 2, xxd: 2 };                                                             // 2nd operand is an OUTPUT file

function split(s) { return s ? s.split(" ") : []; }
function tableFor(name) {
  var t = TABLES[name];
  if (!t || t._k) return t;
  t._k = { s: {}, l: {} };
  (t.sf || "").split("").forEach(function (c) { t._k.s[c] = "f"; });
  (t.st || "").split("").forEach(function (c) { t._k.s[c] = "t"; });
  (t.sp || "").split("").forEach(function (c) { t._k.s[c] = "p"; });
  (t.so || "").split("").forEach(function (c) { t._k.s[c] = "o"; });
  split(t.lf).forEach(function (n) { t._k.l[n] = "f"; });
  split(t.lt).forEach(function (n) { t._k.l[n] = "t"; });
  split(t.lp).forEach(function (n) { t._k.l[n] = "p"; });
  split(t.lo).forEach(function (n) { t._k.l[n] = "o"; });
  return t;
}
// GNU long option, exact or unique prefix of this program's table (a prefix is a prefix of the real table too, so the
// real program resolves it to the same option or refuses it as ambiguous).
function resolveLong(table, o) {
  if (table._k.l[o]) return o;
  var hits = Object.keys(table._k.l).filter(function (n) { return n.indexOf(o) === 0; });
  return hits.length === 1 ? hits[0] : null;
}

// Generic argv walk. Returns { checks: [{v, glob, tilde}], operands: [word], patOpt } or null (ask).
// GNU permutation: options are recognized anywhere until a literal "--".
function walk(name, words) {
  var t = tableFor(name);
  if (!t) return null;
  var a = words.slice(1), checks = [], operands = [], patOpt = false, i, w, v;
  function value(kind, val, word) {
    if (kind === "p") checks.push({ v: val, glob: word.glob, tilde: word.tilde && val === word.v });
    else if (word.glob) checks.push({ v: word.v, glob: true, tilde: false });
  }
  for (i = 0; i < a.length; i++) {
    w = a[i]; v = w.v;
    if (v === "--") { for (i++; i < a.length; i++) operands.push(a[i]); break; }
    if (v.length > 1 && v[0] === "-" && v[1] === "-") {
      var eq = v.indexOf("="), nm = resolveLong(t, eq < 0 ? v.slice(2) : v.slice(2, eq));
      if (!nm) return null;
      var kind = t._k.l[nm], val = eq < 0 ? null : v.slice(eq + 1);
      if (kind === "f") { if (val !== null) return null; if (GREPS[name] && (nm === "files" || nm === "type-list")) patOpt = true; continue; }
      if (kind === "o") { if (val !== null) value("t", val, w); continue; }
      if (val === null) { if (i + 1 >= a.length) return null; val = a[++i].v; w = a[i]; }
      value(kind, val, w);
      if (GREPS[name] && (nm === "regexp" || nm === "file")) patOpt = true;
      continue;
    }
    if (v.length > 1 && v[0] === "-") {
      if (t.num && /^-\d+$/.test(v)) continue;
      if (t.exact && !/^-[a-zA-Z]$/.test(v)) {      // real xxd reads only the first 2 chars of an option word: accept just "-X" or "-c16"
        if (!/^-[cglos]\d+$/.test(v)) return null;
        value("t", v.slice(2), w);
        continue;
      }
      for (var c = 1; c < v.length; c++) {
        var k = t._k.s[v[c]];
        if (!k) return null;
        if (k === "f") continue;
        var rest = v.slice(c + 1);
        if (k === "o") { if (rest !== "") value("t", rest, w); break; }   // optional value: only when attached (od -w8)
        if (rest === "") { if (i + 1 >= a.length) return null; rest = a[++i].v; w = a[i]; }
        value(k, rest, w);
        if (GREPS[name] && (v[c] === "e" || v[c] === "f")) patOpt = true;
        break;
      }
      continue;
    }
    operands.push(w);
  }
  return { checks: checks, operands: operands, patOpt: patOpt };
}

function operandChecks(name, r) {
  if (MAXOPERANDS[name] && r.operands.length >= MAXOPERANDS[name]) return null;
  var out = r.checks.slice(), ops = r.operands;
  ops.forEach(function (w, idx) {
    var text = (GREPS[name] && !r.patOpt && idx === 0) || TEXT_ONLY[name];
    if (text && !w.glob) return;
    out.push({ v: w.v, glob: w.glob, tilde: w.tilde, file: name === "diff" });   // diff on directories dereferences symlinks inside
  });
  return out;
}

// find: starting points, then an expression made only of the primaries below.
var FIND_FLAG = "-depth -empty -readable -writable -executable -prune -print -print0 -true -false -mount -xdev -daystart -a -o -and -or -not ! ( ) -ls".split(" ");
var FIND_TEXT = "-name -iname -path -ipath -wholename -iwholename -regex -iregex -type -size -mtime -atime -ctime -mmin -amin -cmin -user -group -perm -maxdepth -mindepth -links -inum -printf -regextype -lname -ilname".split(" ");
var FIND_PATH = "-newer -samefile".split(" ");
function findChecks(words) {
  var a = words.slice(1), i = 0, out = [];
  var isExpr = function (v) { return v[0] === "-" || v === "!" || v === "(" || v === ")"; };
  for (; i < a.length && !isExpr(a[i].v); i++) out.push({ v: a[i].v, glob: a[i].glob, tilde: a[i].tilde });
  for (; i < a.length; i++) {
    var v = a[i].v;
    if (FIND_FLAG.indexOf(v) !== -1) continue;
    var isT = FIND_TEXT.indexOf(v) !== -1, isP = FIND_PATH.indexOf(v) !== -1;
    if (!isT && !isP) return null;
    if (i + 1 >= a.length) return null;
    var x = a[++i];
    if (isP) out.push({ v: x.v, glob: x.glob, tilde: x.tilde });
    else if (x.glob) out.push({ v: x.v, glob: true, tilde: false });
  }
  return out;
}

// sed script parser (conservative). Commands: p d = l q Q n N P D h H g G x, y///, s/// with flags [gpiImM0-9], each with an
// optional address (N, $, /re/ or \cREc with optional I/M, addr,addr, addr!). Rejected: w W r R e F v z a i c { } : b t T #,
// the s flags e and w, newlines, and anything not understood. Regex/replacement parts are delimiter-aware with backslash escapes.
function sedScriptOk(src) {
  var i = 0, n = src.length;
  if (/[\n\r\0]/.test(src)) return false;
  function skipWs() { while (i < n && (src[i] === " " || src[i] === "\t")) i++; }
  function section(d) {                      // reads up to the unescaped delimiter d, consuming it; false if unterminated
    for (; i < n; i++) {
      if (src[i] === "\\") { if (i + 1 >= n) return false; i++; continue; }
      if (src[i] === d) { i++; return true; }
    }
    return false;
  }
  function delim() { var d = src[i]; if (d === undefined || d === "\\" || d === " " || d === "\t") return null; i++; return d; }
  function addr() {
    if (src[i] === "$") { i++; return true; }
    if (/\d/.test(src[i] || "")) { while (/\d/.test(src[i] || "")) i++; return true; }
    var d = null;
    if (src[i] === "/") { d = "/"; i++; }
    else if (src[i] === "\\") { i++; d = delim(); if (d === null) return false; }
    else return null;                        // no address here
    if (!section(d)) return false;
    while (src[i] === "I" || src[i] === "M") i++;
    return true;
  }
  var cmds = 0;
  for (;;) {
    while (i < n && (src[i] === " " || src[i] === "\t" || src[i] === ";")) i++;
    if (i >= n) return cmds > 0;
    var r = addr();
    if (r === false) return false;
    if (r === true) {
      skipWs();
      if (src[i] === ",") { i++; skipWs(); if (addr() !== true) return false; }
      skipWs();
      while (src[i] === "!") { i++; skipWs(); }
    }
    var c = src[i++];
    if (c === undefined) return false;
    if ("pd=PDNnhHgGx".indexOf(c) !== -1) { /* no argument */ }
    else if (c === "l" || c === "q" || c === "Q") { skipWs(); while (/\d/.test(src[i] || "")) i++; }
    else if (c === "y") {
      var d = delim();
      if (d === null || !section(d) || !section(d)) return false;
    } else if (c === "s") {
      var sd = delim();
      if (sd === null || !section(sd) || !section(sd)) return false;
      while (i < n && /[gpiImM0-9]/.test(src[i])) i++;
    } else return false;
    skipWs();
    if (i < n && src[i] !== ";") return false;
    cmds++;
  }
}

// sed: options -n -E -r -s -u -z --posix --quiet --silent --regexp-extended --separate --unbuffered --null-data, and
// -e SCRIPT / --expression=SCRIPT (repeatable) or exactly one bare script; then file operands. No -i/-f/--follow-symlinks.
function sedChecks(a) {
  var j = 0, scripts = [], plainLong = { "--posix": 1, "--quiet": 1, "--silent": 1, "--regexp-extended": 1, "--separate": 1, "--unbuffered": 1, "--null-data": 1 };
  for (; j < a.length; j++) {
    var v = a[j].v, m;
    if (v === "--") { j++; break; }
    if (v === "-" || v[0] !== "-") break;
    if (plainLong[v] || /^-[nErsuz]+$/.test(v)) continue;
    if (v === "--expression") { if (j + 1 >= a.length) return null; scripts.push(a[++j].v); continue; }
    if (v.indexOf("--expression=") === 0) { scripts.push(v.slice(13)); continue; }
    if ((m = /^-[nErsuz]*e(.*)$/.exec(v))) {
      if (m[1] === "") { if (j + 1 >= a.length) return null; scripts.push(a[++j].v); } else scripts.push(m[1]);
      continue;
    }
    return null;
  }
  if (!scripts.length) { if (j >= a.length) return null; scripts.push(a[j++].v); }
  if (!scripts.every(sedScriptOk)) return null;
  return trailing(a.slice(j));
}
// Remaining words are operands; a dash-word (other than "-") is an option we do not model, so ask.
function trailing(list) {
  return list.some(function (x) { return x.v[0] === "-" && x.v !== "-"; }) ? null : list.map(function (x) { return { v: x.v, glob: x.glob, tilde: x.tilde }; });
}

function jqChecks(a) {
  var flags = { "-r": 1, "-c": 1, "-s": 1, "-S": 1, "-M": 1, "-R": 1, "-a": 1, "-e": 1, "-j": 1, "-C": 1 }, j = 0;
  while (j < a.length && a[j].v[0] === "-" && a[j].v.length > 1) { if (!flags[a[j].v]) return null; j++; }
  if (j >= a.length) return null;
  if (/\benv\b|\$ENV|\binput|\binclude\b|\bimport\b|\$__|\bdebug\b|\bstderr\b/.test(a[j].v)) return null;
  return trailing(a.slice(j + 1));
}

function unzipChecks(a) {
  var seen = false, j = 0;
  for (; j < a.length && a[j].v[0] === "-" && a[j].v.length > 1; j++) {
    var v = a[j].v;
    if (v === "-l" || v === "-p" || v === "-v" || /^-Z1?$/.test(v)) seen = true;
    else if (v !== "-q" && v !== "-qq") return null;
  }
  return seen ? trailing(a.slice(j)) : null;
}

function tarChecks(a) {
  if (!a.length || !/^-?[txOfvzjJa]+$/.test(a[0].v)) return null;
  var l = a[0].v.replace(/^-/, ""), cnt = function (ch) { return l.split(ch).length - 1; };
  if (cnt("t") + cnt("x") !== 1 || cnt("f") !== 1 || (cnt("x") && !cnt("O")) || (cnt("t") && cnt("O"))) return null;
  if (a.slice(1).some(function (x) { return x.v.indexOf(":") !== -1; })) return null;   // host:archive = remote (rsh)
  return trailing(a.slice(1));
}

function pdfChecks(name, a) {
  var rest = [];
  for (var j = 0; j < a.length; j++) {
    var v = a[j].v;
    if (v === "-layout" || v === "-raw" || v === "-nopgbrk" || v === "-q") continue;
    if ((v === "-f" || v === "-l") && j + 1 < a.length && /^\d+$/.test(a[j + 1].v)) { j++; continue; }
    if (v[0] === "-" && v !== "-") return null;
    rest.push(a[j]);
  }
  if (name === "pdfinfo") return rest.length === 1 ? trailing(rest) : null;
  return rest.length === 2 && rest[1].v === "-" ? trailing(rest.slice(0, 1)) : null;
}

var ALLOWED = { echo: 1, printf: 1, "true": 1, "false": 1, cd: 1, sed: 1, jq: 1, unzip: 1, tar: 1, pdftotext: 1, pdfinfo: 1, find: 1 };
Object.keys(TABLES).forEach(function (k) { ALLOWED[k] = 1; });

// Path-checks to run for one command, or null when the command/options are not allowed.
function commandChecks(name, words) {
  var a = words.slice(1);
  if (a.some(function (x) { return x.v[0] === "@"; })) return null;            // response files (binutils @FILE)
  if (name === "printf" && a.length && a[0].v[0] === "-") return null;          // builtin: printf -v VAR would set PATH etc.
  if (name === "sed") return sedChecks(a);
  if (name === "jq") return jqChecks(a);
  if (name === "unzip") return unzipChecks(a);
  if (name === "tar") return tarChecks(a);
  if (name === "pdftotext" || name === "pdfinfo") return pdfChecks(name, a);
  if (name === "find") return findChecks(words);
  if (name === "echo" || name === "printf" || name === "true" || name === "false") return a.filter(function (x) { return x.glob; }).map(function (x) { return { v: x.v, glob: true, tilde: false }; });
  var r = walk(name, words);
  return r ? operandChecks(name, r) : null;
}

// Codex hands the command as `bash -lc '<script>'`: classify the script when asked to.
// Inside the contained Codex sandbox HOME is an empty tmpfs (bwrap --tmpfs HOME) and the env is cleared (--clearenv:
// no BASH_ENV/ENV), so the login shell finds no ~/.bash_profile|.bash_login|.profile unless an approved command made
// one; auto-allowed tools only write inside the workspace.
function innerScript(tokens) {
  if (tokens.length !== 3 || tokens.some(function (t) { return t.op !== undefined || t.redir; })) return null;
  return /^(\/usr)?(\/bin\/)?(ba)?sh$/.test(tokens[0].v) && /^-l?c$/.test(tokens[1].v) ? tokens[2].v : null;
}

function readOnlyInWorkspace(command, workspace, opts) {
  var deny = function (r) { return { allow: false, reason: r }; };
  if (typeof workspace !== "string" || !path.isAbsolute(workspace)) return deny("no workspace");
  var root;
  try { root = fs.realpathSync(workspace); } catch (_) { return deny("workspace unavailable"); }
  var tk = tokenize(command);
  if (!tk.ok) return deny(tk.reason);
  var inner = opts && opts.unwrapShell ? innerScript(tk.tokens) : null;
  if (inner != null) { tk = tokenize(inner); if (!tk.ok) return deny(tk.reason); }
  var ps = parse(tk.tokens);
  if (!ps.ok) return deny(ps.reason);
  var cwd = root, stack = [], first = [true];       // first[depth]: no command seen yet in this group
  for (var i = 0; i < ps.events.length; i++) {
    var e = ps.events[i];
    if (e.push) { stack.push(cwd); first.push(true); continue; }
    if (e.pop) { cwd = stack.pop(); first.pop(); continue; }
    var isFirst = first[first.length - 1];
    first[first.length - 1] = false;
    var head = e.cmd[0], name = head.v;
    if (!head.plain || !/^[a-z0-9]+$/.test(name) || !ALLOWED[name]) return deny("program not allowed: " + name.slice(0, 40));
    if (name === "cd") {
      var d = e.cmd[1];
      if (!isFirst || e.cmd.length !== 2 || (e.next !== "&&" && e.next !== ";") || d.glob || d.v[0] === "-" || d.v[0] === "@" ||
          !pathOk(d.v, cwd, root, false, d.tilde)) return deny("cd form or target not allowed");
      var depth = 0, later = false;                 // a later || in this group could run after a failed cd
      for (var j = i + 1; j < ps.events.length && depth >= 0; j++) {
        var f = ps.events[j];
        if (f.push) depth++;
        else if (f.pop) { depth--; if (depth < 0) break; if (depth === 0 && f.next === "||") later = true; }
        else if (depth === 0 && f.next === "||") later = true;
      }
      if (later) return deny("cd before ||");
      var target;
      try { target = fs.realpathSync(path.resolve(cwd, d.v)); if (!fs.statSync(target).isDirectory()) return deny("cd target"); } catch (_) { return deny("cd target"); }
      if (!inside(root, target)) return deny("cd outside workspace");
      cwd = target; continue;
    }
    var checks = commandChecks(name, e.cmd);
    if (!checks) return deny("option or form not allowed: " + name);
    for (var k = 0; k < checks.length; k++) {
      var x = checks[k];
      if (x.file) {
        var fr = x.glob ? null : resolveReal(path.resolve(cwd, x.v));
        var isDir = true;
        try { isDir = !fr || fs.statSync(fr).isDirectory(); } catch (_) { isDir = false; }
        if (isDir && x.v !== "-") return deny("directory or glob operand: " + name);
      }
      if (!pathOk(x.v, cwd, root, x.glob, x.tilde)) return deny("path outside workspace: " + String(x.v).slice(0, 80));
    }
  }
  return { allow: true, reason: "read-only in workspace" };
}

module.exports = { readOnlyInWorkspace: readOnlyInWorkspace, TABLES: TABLES };

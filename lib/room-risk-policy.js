"use strict";
// room-risk-policy.js - risk classifier for contained room turns whose room approvalLevel is "risky" or "never".
// The sandbox boundary (bubblewrap empty root, per-room workspace, snapshots) substitutes for per-call prompts; only
// what can leave the sandbox, touch the provider credential or wipe the workspace still asks an admin.
//
//   classify(toolName, input, { workspace, askPatterns, level }) -> { risky: false } | { risky: true, reason, text }
//   reason: outbound | credential | bulk_delete | host_tool | ask_pattern
// Level "never" only honours host_tool. Anything this module cannot parse is NOT risky (the sandbox still holds);
// python/node code is not parsed deeply.
var fs = require("fs");
var os = require("os");
var path = require("path");

var TEXT = {
  outbound: "외부로 데이터를 보내는 명령이라 확인이 필요해요.",
  credential: "AI 계정 인증 정보에 접근하는 요청이라 확인이 필요해요.",
  bulk_delete: "작업 폴더 전체를 지우는 명령이라 확인이 필요해요.",
  host_tool: "샌드박스 밖에서 실행되는 도구라 확인이 필요해요.",
  ask_pattern: "방 설정의 '항상 묻기' 목록에 있는 명령이라 확인이 필요해요.",
};

var SANDBOX_TOOLS = { Bash: 1, BashOutput: 1, KillShell: 1, Read: 1, Write: 1, Edit: 1, MultiEdit: 1, NotebookEdit: 1, Glob: 1, Grep: 1, LS: 1, WebFetch: 1, WebSearch: 1, TodoWrite: 1,
  // Subagents and skills run in the same sandbox (their own calls are classified too); plan/todo tools are non-interactive.
  TodoRead: 1, Task: 1, Agent: 1, Skill: 1, TaskOutput: 1, KillBash: 1, ExitPlanMode: 1, EnterPlanMode: 1 };
var PATH_FIELDS = ["file_path", "path", "notebook_path", "paths"];
var ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY"];
var CRED_FILES = [".claude/.credentials.json", ".codex/auth.json"];
var CRED_SUBSTR = [".credentials.json", "auth.json"];
var NET_TOOLS = { scp: 1, sftp: 1, ftp: 1, ssh: 1, nc: 1, ncat: 1, netcat: 1, socat: 1, telnet: 1 };
var SHELLS = { sh: 1, bash: 1, dash: 1, zsh: 1 };
var WRAPPERS = { sudo: 1, env: 1, command: 1, nohup: 1, time: 1, exec: 1, nice: 1, timeout: 1, stdbuf: 1, setsid: 1, xargs: 1 };

// Splits a shell line into command segments of unquoted tokens. Heredoc bodies are skipped; sub-shell/backtick/pipe
// boundaries start a new segment. Never throws.
function segments(src) {
  var segs = [], cur = [], tok = "", has = false, i = 0, n = src.length, heredocs = [];
  function endTok() { if (has) { cur.push(tok); tok = ""; has = false; } }
  function endSeg() { endTok(); if (cur.length) { segs.push(cur); cur = []; } }
  while (i < n) {
    var c = src[i];
    if (c === "\\" && i + 1 < n) { tok += src[i + 1]; has = true; i += 2; continue; }
    if (c === "'") { var j = src.indexOf("'", i + 1); if (j < 0) j = n; tok += src.slice(i + 1, j); has = true; i = j + 1; continue; }
    if (c === '"') {
      i++; has = true;
      while (i < n && src[i] !== '"') { if (src[i] === "\\" && i + 1 < n) i++; tok += src[i++]; }
      i++; continue;
    }
    if (c === "<" && src[i + 1] === "<" && src[i + 2] !== "<") {
      var m = /^<<-?\s*(['"]?)([A-Za-z0-9_]+)\1/.exec(src.slice(i));
      if (m) { heredocs.push(m[2]); i += m[0].length; endTok(); continue; }
    }
    if (c === "\n") {
      endSeg(); i++;
      while (heredocs.length) {
        var delim = heredocs.shift(), found = false;
        while (i < n) {
          var e = src.indexOf("\n", i); if (e < 0) e = n;
          var line = src.slice(i, e).replace(/^\t+/, "").trim();
          i = e + 1;
          if (line === delim) { found = true; break; }
        }
        if (!found) break;
      }
      continue;
    }
    if (c === ";" || c === "&" || c === "|" || c === "(" || c === ")" || c === "`" || c === "{" && /\s/.test(src[i + 1] || " ") || c === "}" && !has) { endSeg(); i++; continue; }
    if (c === "$" && src[i + 1] === "(") { endSeg(); i += 2; continue; }
    if (/\s/.test(c)) { endTok(); i++; continue; }
    tok += c; has = true; i++;
  }
  endSeg();
  return segs;
}

function base(t) { return String(t).replace(/^.*\//, ""); }

// Peels env assignments and wrapper programs; returns the command tokens (name first) or [].
function peel(tokens) {
  var t = tokens.slice();
  for (;;) {
    while (t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0])) t.shift();
    if (t.length && WRAPPERS[base(t[0])]) {
      t.shift();
      while (t.length && (t[0][0] === "-" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0]) || /^\d+[smhd]?$/.test(t[0]))) t.shift();
      continue;
    }
    break;
  }
  return t;
}

// All command token lists of a line, descending into sh -c / bash -lc strings.
function commands(src, depth) {
  var out = [];
  if (depth > 4 || typeof src !== "string") return out;
  segments(src).forEach(function (seg) {
    var t = peel(seg);
    if (!t.length) return;
    out.push(t);
    var nm = base(t[0]);
    if (SHELLS[nm] || nm === "eval") {
      for (var k = 1; k < t.length; k++) {
        if (nm === "eval") { out = out.concat(commands(t.slice(1).join(" "), depth + 1)); break; }
        if (/^-[a-z]*c[a-z]*$/.test(t[k]) && t[k + 1] != null) { out = out.concat(commands(t[k + 1], depth + 1)); break; }
      }
    }
  });
  return out;
}

// git with its global options (-C dir, -c k=v, --git-dir=..) removed: { sub, args, dir }.
function gitParts(t) {
  var i = 1, dir = null;
  while (i < t.length && t[i][0] === "-") {
    if (t[i] === "-C" && t[i + 1] != null) { dir = t[i + 1]; i += 2; }
    else if ((t[i] === "-c" || t[i] === "--git-dir" || t[i] === "--work-tree" || t[i] === "--namespace") && t[i + 1] != null) i += 2;
    else i++;
  }
  return { sub: t[i] || "", args: t.slice(i + 1), dir: dir, rest: t.slice(i) };
}

var DATA_LONG = /^--(data(-[a-z]+)?|form(-string)?|upload-file|json|post-data|post-file|body-data|body-file|method)(=|$)/;
function outboundCurlWget(nm, t) {
  for (var i = 1; i < t.length; i++) {
    var a = t[i];
    if (a.slice(0, 2) === "--") {
      if (DATA_LONG.test(a) && (nm === "curl" ? !/^--method/.test(a) : true)) return true;
      if (nm === "curl" && /^--request(=|$)/.test(a)) { var v = a.indexOf("=") > 0 ? a.slice(a.indexOf("=") + 1) : t[i + 1]; if (/^(POST|PUT|PATCH|DELETE)$/i.test(v || "")) return true; }
    } else if (a[0] === "-" && a.length > 1 && nm === "curl") {
      if (/^-[A-Za-z]*[dFT]/.test(a)) return true;
      var x = /^-[A-Za-z]*X(.*)$/.exec(a);
      if (x && /^(POST|PUT|PATCH|DELETE)$/i.test(x[1] || t[i + 1] || "")) return true;
    }
  }
  return false;
}
function remoteArg(a) { return /^rsync:\/\//.test(a) || (/^([\w.-]+@)?[\w.-]+:[^/]?/.test(a) && a[0] !== "-" && a[0] !== "/" && a[0] !== ".") || /^[\w.-]+@[\w.-]+:/.test(a); }

function outbound(cmds) {
  for (var c = 0; c < cmds.length; c++) {
    var t = cmds[c], nm = base(t[0]);
    for (var k = 0; k < t.length; k++) if (NET_TOOLS[base(t[k])]) return true;       // anywhere on the line
    if (nm === "curl" || nm === "wget") { if (outboundCurlWget(nm, t)) return true; }
    else if (nm === "git") { var g = gitParts(t); if (g.sub === "push" || g.sub === "send-email") return true; }
    else if (nm === "git-send-email" || nm === "git-push") return true;
    else if (nm === "rsync" && t.slice(1).some(remoteArg)) return true;
  }
  return false;
}

function deleteTarget(arg, root) {
  if (!arg || arg.indexOf("\0") !== -1) return false;
  var abs = path.resolve(root, arg.replace(/^~(?=\/|$)/, os.homedir()));
  if (abs === root || root.indexOf(abs.endsWith(path.sep) ? abs : abs + path.sep) === 0) return true; // root or an ancestor
  var b = path.basename(abs);
  return path.dirname(abs) === root && /^(\.?\*|\.\[!\.\]\*|\.\*)$/.test(b);                        // *, .*, ./*
}
function bulkDelete(cmds, workspace) {
  var root = workspace;
  if (typeof root !== "string" || !path.isAbsolute(root)) return false;
  try { root = fs.realpathSync(root); } catch (_) { return false; }
  for (var c = 0; c < cmds.length; c++) {
    var t = cmds[c], nm = base(t[0]);
    if (nm === "rm") {
      var recursive = t.some(function (a) { return a === "--recursive" || /^-[A-Za-z]*[rR]/.test(a) && a.slice(0, 2) !== "--"; });
      if (recursive && t.slice(1).some(function (a) { return a[0] !== "-" && deleteTarget(a, root); })) return true;
    } else if (nm === "find" && t.indexOf("-delete") > 0) {
      var starts = [];
      for (var i = 1; i < t.length && t[i][0] !== "-" && t[i][0] !== "(" && t[i][0] !== "!"; i++) starts.push(t[i]);
      if (!starts.length) starts.push(".");
      if (starts.some(function (a) { return deleteTarget(a, root); })) return true;
    } else if (nm === "git") {
      var g = gitParts(t);
      var at = g.dir ? path.resolve(root, g.dir) : root;
      if (at !== root) continue;
      if (g.sub === "reset" && g.args.indexOf("--hard") >= 0) return true;
      if (g.sub === "clean" && g.args.some(function (a) { return /^-[A-Za-z]*f/.test(a) && /^-[A-Za-z]*[dx]/.test(a) || a === "--force"; }) &&
        g.args.some(function (a) { return /^-[A-Za-z]*[dx]/.test(a); })) return true;
    }
  }
  return false;
}

function strings(v, out, depth) {
  if (depth > 4) return out;
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach(function (x) { strings(x, out, depth + 1); });
  else if (v && typeof v === "object") Object.keys(v).forEach(function (k) { strings(v[k], out, depth + 1); });
  return out;
}
function envNames() {
  var names = ENV_KEYS.slice();
  try {
    var f = require("./room-execution-flags");
    ["claude", "codex"].forEach(function (a) { names = names.concat(f.cliKeyNames(a)); });
  } catch (_) {}
  return names;
}
function realOrNull(p) { try { return fs.realpathSync(p); } catch (_) { return null; } }
function credential(input, workspace) {
  var texts = [];
  if (input && typeof input === "object") ["command", "file_path", "path", "notebook_path", "paths", "pattern", "glob", "changes"].forEach(function (k) { strings(input[k], texts, 0); });
  var home = os.homedir();
  var lower = texts.map(function (s) { return s.toLowerCase(); });
  var names = envNames();
  for (var i = 0; i < texts.length; i++) {
    var s = texts[i];
    if (CRED_SUBSTR.some(function (x) { return lower[i].indexOf(x) >= 0; })) return true;
    if (names.some(function (n) { return s.indexOf(n) >= 0; })) return true;
    if (/(~|\$\{?HOME\}?)\/\.(codex|claude)(\/|\b)/.test(s) || s.indexOf(home + "/.codex") >= 0 || s.indexOf(home + "/.claude/.cred") >= 0) return true;
  }
  var creds = CRED_FILES.map(function (f) { return realOrNull(path.join(home, f)) || path.join(home, f); });
  var root = typeof workspace === "string" && path.isAbsolute(workspace) ? workspace : home;
  var hit = false;
  PATH_FIELDS.forEach(function (f) {
    [].concat(input && typeof input === "object" ? input[f] : []).forEach(function (p) {
      if (typeof p !== "string" || !p || hit) return;
      var abs = path.resolve(root, p.replace(/^~(?=\/|$)/, home));
      var real = realOrNull(abs) || abs;
      if (creds.indexOf(real) >= 0 || creds.indexOf(abs) >= 0) hit = true;
    });
  });
  return hit;
}

function askPattern(cmds, patterns) {
  var pats = (Array.isArray(patterns) ? patterns : []).map(function (p) { return String(p).trim().split(/\s+/).filter(Boolean); }).filter(function (p) { return p.length; });
  if (!pats.length) return false;
  return cmds.some(function (t) {
    var norm = [base(t[0])].concat(t.slice(1));
    if (norm[0] === "git") { var g = gitParts(t); norm = ["git"].concat(g.rest); }
    return pats.some(function (p) { return p.length <= norm.length && p.every(function (w, i) { return norm[i] === w; }); });
  });
}

function classify(toolName, input, ctx) {
  ctx = ctx || {};
  var risky = function (reason) { return { risky: true, reason: reason, text: TEXT[reason] }; };
  var name = String(toolName || "");
  if (name.indexOf("mcp__") === 0 || !SANDBOX_TOOLS[name]) return risky("host_tool");
  if (ctx.level === "never") return { risky: false };
  var cmds = name === "Bash" && input && typeof input.command === "string" ? commands(input.command, 0) : [];
  if (cmds.length && outbound(cmds)) return risky("outbound");
  if (credential(input, ctx.workspace)) return risky("credential");
  if (cmds.length && bulkDelete(cmds, ctx.workspace)) return risky("bulk_delete");
  if (cmds.length && askPattern(cmds, ctx.askPatterns)) return risky("ask_pattern");
  return { risky: false };
}

module.exports = { classify: classify, TEXT: TEXT };

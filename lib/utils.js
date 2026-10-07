/**
 * Shared utility functions.
 */

var fs = require("fs");

/**
 * Encode a cwd path into a filesystem-safe directory/file name.
 * Replaces all non-alphanumeric characters with hyphens, matching
 * Claude CLI's encoding logic exactly (/[^a-zA-Z0-9]/g -> "-").
 *
 * Example: "/Users/jon.doe_42/my project" -> "-Users-jon-doe-42-my-project"
 */
function encodeCwd(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Legacy encoding (pre-#182 fix). Only slashes and dots were replaced.
 * Used for fallback resolution of on-disk data written before the fix.
 */
function legacyEncodeCwd(cwd) {
  return cwd.replace(/[\/\.]/g, "-");
}

/**
 * Try candidate encoded names against a base directory.
 * Returns the first match that exists on disk, or the first candidate
 * (newest encoding) if none exist yet.
 */
function resolveEncoded(baseDir, cwd, ext, checkFn) {
  var newEncoded = encodeCwd(cwd);
  var legacyEncoded = legacyEncodeCwd(cwd);
  if (newEncoded === legacyEncoded) return newEncoded;
  var full = baseDir + "/" + newEncoded + (ext || "");
  try { if (checkFn(full)) return newEncoded; } catch (e) {}
  var legacyFull = baseDir + "/" + legacyEncoded + (ext || "");
  try { if (checkFn(legacyFull)) return legacyEncoded; } catch (e) {}
  return newEncoded;
}

/**
 * Resolve an encoded directory path with legacy fallback.
 */
function resolveEncodedDir(baseDir, cwd) {
  return resolveEncoded(baseDir, cwd, "", function(p) {
    return fs.statSync(p).isDirectory();
  });
}

/**
 * Resolve an encoded file path with legacy fallback.
 */
function resolveEncodedFile(baseDir, cwd, ext) {
  return resolveEncoded(baseDir, cwd, ext, function(p) {
    return fs.statSync(p).isFile();
  });
}

/**
 * Sanitize a persisted `allowedTools` map before hydrating it into a live
 * session (lr-8b2e). The value originates from a durable .jsonl meta record
 * that shares its trust boundary with other session-file fields, but an
 * un-validated shape would let a crafted record (e.g. {"Bash": "yes"} or a
 * non-object) auto-approve a tool with no operator click at the
 * handleCanUseTool check (lib/sdk-bridge.js:691).
 *
 * Keeps only entries whose key is a string and whose value is strictly
 * boolean `true`; drops everything else. A non-object input (including
 * null/undefined/arrays) yields {} rather than throwing.
 */
function sanitizeAllowedTools(value) {
  var out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (var key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (typeof key === "string" && value[key] === true) out[key] = true;
  }
  return out;
}

/**
 * Compute the key used to index a session's "allow for session" grant map
 * (session.allowedTools) for a given tool call (lr-f969dc).
 *
 * Most tools are correctly discriminated by bare tool name alone — MCP tools
 * already fold server + tool identity into the name itself (e.g.
 * "mcp__browser__navigate" vs "mcp__browser__screenshot" are already
 * distinct keys), so approving one MCP tool must not silently approve a
 * different one, and bare-name keying already gives that.
 *
 * The Claude `Skill` tool is the one exception found so far: every distinct
 * skill invocation arrives as the SAME toolName "Skill" with a different
 * `input.skill` discriminator. Keying on bare "Skill" means granting one
 * skill silently authorizes every other skill for the rest of the session —
 * a security regression, not the "doesn't stick" fix the grant was meant to
 * provide. Fold the discriminator into the key so a grant is scoped to the
 * specific skill that was actually approved.
 *
 * This repo is vendor-agnostic via the YOKE adapter layer (lib/yoke/), so a
 * bare "Skill" literal here is a deliberate, checked exception, not a
 * default pattern for future tools. Verified (lr-f969dc): Codex's approval
 * RPCs (exec/file/MCP, lib/yoke/adapters/codex.js) route through this same
 * function via the identical vendor-neutral canUseTool wiring, and all of
 * them already send correctly-flat tool names — Codex has no tool today
 * whose identity fans out under one shared name the way Skill does, so no
 * generalization is needed for vendor parity right now. If a second vendor
 * or a renamed/restructured tool introduces another input-discriminated
 * tool, extend this with another explicit branch (or a small declarative
 * toolName -> discriminator-field table if a third case appears) rather
 * than reaching for a config knob nobody would otherwise set.
 *
 * Falls back to the bare tool name when the expected discriminator is
 * missing or not a string (fails closed to the pre-existing per-tool grant
 * rather than throwing or producing an unstable key). Never hardcodes an
 * individual skill name — only the shared "Skill" tool identifier.
 */
function permissionGrantKey(toolName, input) {
  if (toolName === "Skill" && input && typeof input.skill === "string" && input.skill) {
    return "Skill:" + input.skill;
  }
  return toolName;
}

/**
 * Default hard cap for readCappedBody() call sites that don't pass their own
 * maxBytes: these are small JSON-only pre-auth endpoints (login, PIN
 * recovery, OTP, invite registration, push-subscribe) — legitimate bodies are
 * well under a few KB, but the accumulator has no cap at all today (lr-f940
 * N2), so an unauthenticated client can stream an arbitrarily large body into
 * a growing string, and N parallel requests multiply the cost.
 */
var DEFAULT_BODY_CAP_BYTES = 1 * 1024 * 1024; // 1 MB

/**
 * Accumulate an HTTP request body with a hard byte cap, destroying the
 * connection and rejecting once the cap is exceeded instead of buffering an
 * unbounded string (lr-f940 N2). Mirrors the existing hardCap + req.destroy()
 * pattern in lib/project-http.js's parseJsonBody(), generalized so the
 * pre-auth endpoints in lib/server-auth.js and lib/server.js (which have no
 * upload-sized payloads and were accumulating via a bare `body += chunk`
 * with no limit at all) can reuse the same defense instead of each
 * hand-rolling it.
 *
 * @param {http.IncomingMessage} req
 * @param {number} [maxBytes] - hard cap in bytes; defaults to DEFAULT_BODY_CAP_BYTES.
 * @returns {Promise<string>} resolves with the accumulated body (utf8), or
 *   rejects with an Error if the cap is exceeded or the request errors.
 */
function readCappedBody(req, maxBytes) {
  var cap = typeof maxBytes === "number" && maxBytes > 0 ? maxBytes : DEFAULT_BODY_CAP_BYTES;
  return new Promise(function (resolve, reject) {
    var chunks = [];
    var bodyBytes = 0;
    var rejected = false;
    req.on("data", function (chunk) {
      if (rejected) return;
      bodyBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
      if (bodyBytes > cap) {
        rejected = true;
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", function () {
      if (rejected) return;
      resolve(Buffer.concat(chunks.map(function (c) { return Buffer.isBuffer(c) ? c : Buffer.from(c); })).toString("utf8"));
    });
    req.on("error", function (err) {
      if (rejected) return;
      rejected = true;
      reject(err);
    });
  });
}

/**
 * Read the first line of a file without loading the whole file. Reads in
 * chunks until a newline or maxBytes is reached (a line longer than maxBytes
 * is returned truncated). Returns null when the file cannot be read.
 */
function readFirstLine(filePath, maxBytes) {
  var fd;
  try {
    fd = fs.openSync(filePath, "r");
    var buf = Buffer.alloc(4096), parts = [], total = 0, pos = 0;
    while (total < maxBytes) {
      var n = fs.readSync(fd, buf, 0, Math.min(buf.length, maxBytes - total), pos);
      if (n <= 0) break;
      var nl = buf.subarray(0, n).indexOf(10);
      if (nl !== -1) { parts.push(Buffer.from(buf.subarray(0, nl))); break; }
      parts.push(Buffer.from(buf.subarray(0, n)));
      total += n; pos += n;
    }
    return Buffer.concat(parts).toString("utf8");
  } catch (e) {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (e) {}
  }
}

// In-app MCP server names. The pre-rename names (clay-*) may still appear in saved session
// histories and stored "allow for session" grants, so they are mapped to the current names.
// TODO: drop the legacy side once no pre-rename session history is expected.
var LEGACY_MCP_SERVERS = {
  "clay-browser": "aigora-browser",
  "clay-tools": "aigora-tools",
  "clay-datastore": "aigora-datastore",
};

function hasOwn(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }

// The legacy<->new mapping applies ONLY to the built-in servers' identities. `external` (optional
// { serverName: ... } map of externally registered MCP servers) vetoes the alias: an external
// server that happens to be named clay-* is never treated as the internal aigora-* one.
function normalizeMcpServerName(name, external) {
  if (hasOwn(external, name)) return name;
  return hasOwn(LEGACY_MCP_SERVERS, name) ? LEGACY_MCP_SERVERS[name] : name;
}

// True for the three built-in (internal) server names. External servers must not use them.
function isInternalMcpServerName(name) {
  for (var k in LEGACY_MCP_SERVERS) if (hasOwn(LEGACY_MCP_SERVERS, k) && LEGACY_MCP_SERVERS[k] === name) return true;
  return false;
}

// "mcp__clay-browser__x" -> "mcp__aigora-browser__x"; every other name is returned unchanged.
function normalizeMcpToolName(toolName, external) {
  if (typeof toolName !== "string" || toolName.indexOf("mcp__") !== 0) return toolName;
  var rest = toolName.substring(5);
  var i = rest.indexOf("__");
  if (i === -1) return toolName;
  return "mcp__" + normalizeMcpServerName(rest.substring(0, i), external) + rest.substring(i);
}

// Inverse of normalizeMcpToolName for the three renamed servers (used to find old stored grants).
// A grant stored under the legacy name belongs to the internal server only: when an external
// server owns the legacy name, the name is returned unchanged (no cross-over).
function legacyMcpToolName(toolName, external) {
  if (typeof toolName !== "string" || toolName.indexOf("mcp__") !== 0) return toolName;
  var rest = toolName.substring(5);
  var i = rest.indexOf("__");
  if (i === -1) return toolName;
  var server = rest.substring(0, i);
  var keys = Object.keys(LEGACY_MCP_SERVERS);
  for (var k = 0; k < keys.length; k++) {
    if (LEGACY_MCP_SERVERS[keys[k]] === server) {
      if (hasOwn(external, keys[k])) return toolName;
      return "mcp__" + keys[k] + rest.substring(i);
    }
  }
  return toolName;
}

module.exports = {
  normalizeMcpServerName: normalizeMcpServerName,
  isInternalMcpServerName: isInternalMcpServerName,
  normalizeMcpToolName: normalizeMcpToolName,
  legacyMcpToolName: legacyMcpToolName,
  encodeCwd: encodeCwd,
  resolveEncodedDir: resolveEncodedDir,
  resolveEncodedFile: resolveEncodedFile,
  sanitizeAllowedTools: sanitizeAllowedTools,
  permissionGrantKey: permissionGrantKey,
  readCappedBody: readCappedBody,
  readFirstLine: readFirstLine,
  DEFAULT_BODY_CAP_BYTES: DEFAULT_BODY_CAP_BYTES,
};

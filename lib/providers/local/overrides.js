"use strict";
// Admin-settings overrides for the local provider: extra endpoints (with write-only API keys) and the title model.
// Stored in the config dir's "local-model" subdirectory (0700) as overrides.json (0600, atomic write), like clef.json.
// daemon.json stays authoritative for enabled/baseUrl/models; a key present here (even an empty list or "") replaces
// the daemon.json value for that key only. The file is never read by contained agents (config dir is masked).
var fs = require("fs");
var { quarantineCorrupt } = require("../../quarantine-corrupt");
var path = require("path");
var crypto = require("crypto");
var cfgMod = require("./config");

var CACHE_TTL_MS = 1000;
var generation = 0;
var cache = null;

function file(dir) { return path.join(dir || require("../../config").CONFIG_DIR, "local-model", "overrides.json"); }

function read(dir) {
  var f = file(dir), now = Date.now();
  if (cache && cache.gen === generation && cache.file === f && now - cache.at < CACHE_TTL_MS) return cache.value;
  var v;
  try { var o = JSON.parse(fs.readFileSync(f, "utf8")); v = o && typeof o === "object" && !Array.isArray(o) ? o : {}; } catch (e) { v = {}; quarantineCorrupt(f, e); }
  cache = { gen: generation, file: f, at: now, value: v };
  return v;
}

function write(o, dir) {
  generation++;
  var f = file(dir);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  var tmp = f + "." + process.pid + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  var fd = null;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(o));
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = null;
    fs.renameSync(tmp, f);
    generation++;
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
}

// raw daemon.json providers.local (may be null) -> raw with the overrides applied.
function overlay(raw, dir) {
  var o = read(dir);
  var hasEp = Array.isArray(o.endpoints), hasTitle = typeof o.titleModel === "string";
  var hasVer = Array.isArray(o.verifiers), hasMode = typeof o.verifyMode === "string";
  var hasRes = typeof o.researchModel === "string";
  if (!hasEp && !hasTitle && !hasVer && !hasMode && !hasRes) return raw;
  var out = Object.assign({}, raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {});
  if (hasEp) out.endpoints = o.endpoints;
  if (hasTitle) out.titleModel = o.titleModel;
  if (hasVer) out.verifiers = o.verifiers;
  if (hasMode) out.verifyMode = o.verifyMode;
  if (hasRes) out.researchModel = o.researchModel;
  return out;
}

function slug(label) {
  var s = String(label || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 16);
  return /^[a-z0-9]/.test(s) ? s : "ep";
}

// Admin view: never the keys, only presence.
function status(dir) {
  var o = read(dir);
  var eps = cfgMod.resolveEndpoints(o.endpoints);
  return {
    endpoints: eps.map(function (e) {
      return { id: e.id, label: e.label, baseUrl: e.baseUrl, hasKey: !!e.apiKey, routable: e.routable === true,
        pickable: e.pickable, pickModel: e.pickModel, aliases: e.aliases, canWork: e.canWork, privateAllowed: e.privateAllowed === true, workRounds: e.workRounds, idleTimeoutMs: e.idleTimeoutMs, timeoutMs: e.timeoutMs };
    }),
    titleModel: cfgMod.modelName(o.titleModel, ""),
    verifiers: cfgMod.resolveVerifiers(o.verifiers),
    verifyMode: cfgMod.resolveVerifyMode(o.verifyMode),
    researchModel: cfgMod.resolveResearchModel(o.researchModel),
  };
}

// patch: { endpoints?: [{ id?, label, baseUrl, apiKey?, clearKey?, server?, routable? }], titleModel?: string, verifiers?: string[] ("<endpoint id>/<model>"),
// verifyMode?: "single" | "cross", researchModel?: "" | "<endpoint id>/<model>" }. Verifiers and the research model must name an endpoint that exists after the patch; removing an endpoint drops its verifiers and research model.
// Existing endpoints (matched by id) keep their stored key unless apiKey is a non-empty string or clearKey is true.
// Throws an Error with .code "invalid" on any bad entry: nothing is written in that case.
function save(patch, dir) {
  patch = patch && typeof patch === "object" ? patch : {};
  var cur = read(dir);
  var next = { endpoints: cur.endpoints, titleModel: cur.titleModel, verifiers: cur.verifiers, verifyMode: cur.verifyMode, researchModel: cur.researchModel };
  function bad(m) { var e = new Error(m); e.code = "invalid"; throw e; }
  if (patch.endpoints !== undefined) {
    if (!Array.isArray(patch.endpoints) || patch.endpoints.length > cfgMod.MAX_ENDPOINTS) bad("endpoints must be a list of at most " + cfgMod.MAX_ENDPOINTS);
    var old = {};
    (Array.isArray(cur.endpoints) ? cur.endpoints : []).forEach(function (e) { if (e && typeof e.id === "string") old[e.id] = e; });
    var used = {};
    var list = patch.endpoints.map(function (e) {
      if (!e || typeof e !== "object" || Array.isArray(e)) bad("invalid endpoint");
      var id = typeof e.id === "string" && e.id ? e.id : "";
      if (!id) { var base = slug(e.label), n = 1; id = base; while (used[id] || old[id]) id = base.slice(0, 14) + "-" + (++n); }
      if (used[id]) bad("duplicate endpoint id");
      used[id] = true;
      var key = old[id] && typeof old[id].apiKey === "string" ? old[id].apiKey : "";
      if (e.clearKey === true) key = "";
      else if (typeof e.apiKey === "string" && e.apiKey.trim()) key = e.apiKey.trim().slice(0, 500);
      if (e.routable !== undefined && typeof e.routable !== "boolean") bad("routable must be a boolean");
      var routable = e.routable === undefined ? !!(old[id] && old[id].routable === true) : e.routable; // omitted keeps the stored choice
      var o = old[id] || {};
      function flag(name, dflt) {
        if (e[name] !== undefined && typeof e[name] !== "boolean") bad(name + " must be a boolean");
        return e[name] === undefined ? (typeof o[name] === "boolean" ? o[name] : dflt) : e[name];
      }
      function ms(name) {
        if (e[name] === undefined) return o[name];
        if (e[name] === null) return null;
        if (!Number.isInteger(e[name]) || e[name] < 1000 || e[name] > 3600000) bad(name + " must be 1000-3600000");
        return e[name];
      }
      if (e.pickModel !== undefined && (typeof e.pickModel !== "string" || (e.pickModel !== "" && !cfgMod.MODEL_RE.test(e.pickModel)))) bad("invalid pick model");
      if (e.workRounds !== undefined && (!Number.isInteger(e.workRounds) || e.workRounds < 1 || e.workRounds > 12)) bad("workRounds must be 1-12");
      return {
        id: id, label: e.label, baseUrl: e.baseUrl, apiKey: key, server: typeof e.server === "string" ? e.server : o.server || "", routable: routable,
        pickable: flag("pickable", true), canWork: flag("canWork", false), privateAllowed: flag("privateAllowed", false),
        pickModel: e.pickModel === undefined ? o.pickModel : e.pickModel,
        aliases: e.aliases === undefined ? o.aliases : e.aliases,
        workRounds: e.workRounds === undefined ? o.workRounds : e.workRounds,
        idleTimeoutMs: ms("idleTimeoutMs"), timeoutMs: ms("timeoutMs"),
      };
    });
    var ap = cfgMod.aliasProblem(list.map(function (x) { return { id: x.id, aliases: x.aliases }; }));
    if (ap) { var ae = new Error(ap); ae.code = "alias_conflict"; throw ae; }
    var ok = cfgMod.resolveEndpoints(list);
    if (ok.length !== list.length) bad("invalid endpoint (id, label or URL)");
    next.endpoints = ok;
  }
  if (patch.titleModel !== undefined) {
    if (typeof patch.titleModel !== "string" || (patch.titleModel !== "" && !cfgMod.MODEL_RE.test(patch.titleModel))) bad("invalid title model");
    next.titleModel = patch.titleModel;
  }
  if (patch.verifiers !== undefined) {
    if (!Array.isArray(patch.verifiers) || patch.verifiers.length > cfgMod.MAX_VERIFIERS) bad("verifiers must be a list of at most " + cfgMod.MAX_VERIFIERS);
    var clean = cfgMod.resolveVerifiers(patch.verifiers);
    if (clean.length !== patch.verifiers.length) bad("invalid verifier model");
    next.verifiers = clean;
  }
  if (patch.verifyMode !== undefined) {
    if (patch.verifyMode !== "single" && patch.verifyMode !== "cross") bad("invalid verify mode");
    next.verifyMode = patch.verifyMode;
  }
  if (patch.researchModel !== undefined) {
    if (typeof patch.researchModel !== "string" || (patch.researchModel !== "" && cfgMod.resolveResearchModel(patch.researchModel) !== patch.researchModel)) bad("invalid research model");
    next.researchModel = patch.researchModel;
  }
  if (next.verifiers !== undefined || next.researchModel) {
    var live = {};
    var effective = next.endpoints;
    if (!Array.isArray(effective)) { // no override yet: the endpoints daemon.json defines are the ones in force
      try { var all = require("../../config").loadConfig(); effective = all && all.providers && all.providers.local && all.providers.local.endpoints; } catch (_) { effective = []; }
    }
    cfgMod.resolveEndpoints(effective).forEach(function (e) { live[e.id] = true; });
    if (next.verifiers !== undefined) {
      var kept = cfgMod.resolveVerifiers(next.verifiers).filter(function (v) { return live[v.slice(0, v.indexOf("/"))]; });
      if (patch.verifiers !== undefined && kept.length !== next.verifiers.length) bad("verifier names an unknown endpoint");
      next.verifiers = kept;
    }
    if (next.researchModel) {
      if (!live[next.researchModel.slice(0, next.researchModel.indexOf("/"))]) {
        if (patch.researchModel !== undefined) bad("research model names an unknown endpoint");
        next.researchModel = "";
      }
    }
  }
  var out = {};
  if (next.endpoints !== undefined) out.endpoints = next.endpoints;
  if (next.titleModel !== undefined) out.titleModel = next.titleModel;
  if (next.verifiers !== undefined) out.verifiers = next.verifiers;
  if (next.verifyMode !== undefined) out.verifyMode = next.verifyMode;
  if (next.researchModel !== undefined) out.researchModel = next.researchModel;
  write(out, dir);
  return status(dir);
}

function invalidate() { generation++; }

module.exports = { invalidate: invalidate, overlay: overlay, status: status, save: save, file: file };

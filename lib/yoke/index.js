module.exports = require("../extensions").select("yoke/index", function () {
var module = { exports: {} };
var credentials = require("../credential-leases");
// YOKE - Yoke Overrides Known Engines
// Public entry point.

var iface = require("./interface");
var instructions = require("./instructions");
var registry = require("../providers/registry");

/**
 * Wrap adapter.createQuery to inject cross-vendor project instructions.
 *
 * Scans the project directory for instruction files (CLAUDE.md, AGENTS.md,
 * .cursorrules, etc.) that the current vendor does NOT natively read,
 * and merges them into queryOpts.systemPrompt before calling the real
 * createQuery. This way every adapter gets project context regardless
 * of which vendor wrote the instruction file.
 */
function wrapCreateQuery(adapter, defaultCwd) {
  var originalCreateQuery = adapter.createQuery.bind(adapter);

  adapter.createQuery = function(queryOpts) {
    queryOpts = queryOpts || {};
    var projectDir = (queryOpts && queryOpts.cwd) || defaultCwd;
    var merged = instructions.scanAndMerge(projectDir, adapter.vendor);

    if (merged) {
      var parts = [];
      if (queryOpts.systemPrompt) parts.push(queryOpts.systemPrompt);
      parts.push(merged);
      queryOpts.systemPrompt = parts.join("\n\n");
    }

    return originalCreateQuery(queryOpts);
  };
}

/**
 * Create a YOKE adapter.
 *
 * @param {object} opts
 * @param {string} [opts.vendor="claude"] - Adapter vendor name
 * @param {string} opts.cwd              - Project working directory
 * @param {object} [opts.adapterOpts]    - Vendor-specific adapter construction options
 * @returns {Adapter}
 */
function createAdapter(opts) {
  var vendor = (opts && opts.vendor) || "claude";
  var provider = registry.get(vendor);
  if (!provider) throw new Error("[YOKE] Unknown adapter vendor: " + vendor);
  var adapter = provider.createAdapter(opts);
  iface.validateAdapter(adapter);
  if (provider.projectInstructions !== false) wrapCreateQuery(adapter, opts && opts.cwd);
  return adapter;
}

/**
 * Check which vendors have valid auth credentials.
 * Result is cached after first call (auth state doesn't change during runtime).
 * Call invalidateAuthCache() to force re-check (e.g. after a key change).
 */
var _authCache = null;
var _lastAuthLogKey = null;
var _lastAuthLogAt = 0;

function logAuthCheck(auth) {
  var key = JSON.stringify(auth || {});
  var now = Date.now();
  if (_lastAuthLogKey === key && now - _lastAuthLogAt < 30000) return;
  _lastAuthLogKey = key;
  _lastAuthLogAt = now;
  console.log("[yoke] Auth check: claude=" + auth.claude + " codex=" + auth.codex);
}

function checkAuth() {
 if (_authCache) return _authCache;
 _authCache = { claude: credentials.credentialAvailable("claude"), codex: credentials.credentialAvailable("codex") };
 logAuthCheck(_authCache); return _authCache;
}

/**
 * Check which vendor binaries are installed (regardless of auth status).
 *
 * Result is cached at module scope because the check runs two execFileSync
 * calls per invocation and is triggered once per project context on daemon
 * startup. With N projects this used to cost ~2N synchronous subprocesses;
 * caching collapses it to two total. The cache is invalidated alongside
 * the auth cache (via invalidateAuthCache) since "just installed" is the
 * same situation as "API key configured" from the daemon's perspective.
 */
var _installedCache = null;

function checkInstalled() {
  if (_installedCache) return _installedCache;

  var fs = require("fs");
  var execFileSync = require("child_process").execFileSync;
  var result = { claude: false, codex: false };
  try {
    if (process.platform === "win32") execFileSync("where", ["claude"], { timeout: 3000, env: require("../agent-env").stripRoutingSecrets(process.env), stdio: ["pipe", "pipe", "pipe"] });
    else execFileSync("which", ["claude"], { timeout: 3000, env: require("../agent-env").stripRoutingSecrets(process.env), stdio: ["pipe", "pipe", "pipe"] });
    result.claude = true;
  } catch (e) {}
  try {
    var codexBin = null;
    try {
      var findCodexPath = require("./codex-app-server").findCodexPath;
      codexBin = findCodexPath();
      if (codexBin && fs.existsSync(codexBin)) {
        result.codex = true;
        _installedCache = result;
        return result;
      }
    } catch (e) {}

    var whichOut = process.platform === "win32"
      ? execFileSync("where", ["codex"], { timeout: 3000, encoding: "utf8", env: require("../agent-env").stripRoutingSecrets(process.env), stdio: ["pipe", "pipe", "pipe"] })
      : execFileSync("which", ["codex"], { timeout: 3000, encoding: "utf8", env: require("../agent-env").stripRoutingSecrets(process.env), stdio: ["pipe", "pipe", "pipe"] });
    if (whichOut.trim()) result.codex = true;
  } catch (e) {}
  _installedCache = result;
  return result;
}

function invalidateAuthCache() {
  _authCache = null;
  _installedCache = null;
}

/**
 * Create adapters for all authenticated vendors.
 * Claude may be shared across projects, but Codex is instantiated per project
 * so its app-server and bridge stay scoped to a single project slug.
 * Returns { adapters: { vendor: Adapter }, auth: { vendor: boolean } }
 */
var _sharedClaudeAdapter = null;

function createAdapters(opts) {
  opts = opts || {};
  // Installation plus an explicitly selected credential source. Adapter
  // launches re-resolve a lease, so cached availability is never authority.
  var installed = checkInstalled();
  var auth = { claude: false, codex: false };
  var adapters = {};

  if (installed.claude && credentials.credentialAvailable("claude")) {
    try {
      if (!_sharedClaudeAdapter) {
        _sharedClaudeAdapter = createAdapter({ vendor: "claude", cwd: opts.cwd });
      }
      adapters.claude = _sharedClaudeAdapter;
      auth.claude = true;
      console.log("[yoke] Adapter created: claude");
    } catch (e) {
      console.error("[yoke] Failed to create adapter for claude:", e.message);
    }
  }

  if (installed.codex && credentials.credentialAvailable("codex")) {
    try {
      adapters.codex = createAdapter({ vendor: "codex", cwd: opts.cwd, slug: opts.slug });
      auth.codex = true;
      console.log("[yoke] Adapter created: codex");
    } catch (e) {
      console.error("[yoke] Failed to create adapter for codex:", e.message);
    }
  }

  // Local models are opt-in (providers.local.enabled in daemon.json); the adapter is only created when enabled.
  if (registry.isEnabled(registry.get("local"))) {
    try {
      adapters.local = createAdapter({ vendor: "local", cwd: opts.cwd });
      console.log("[yoke] Adapter created: local");
    } catch (e) {
      console.error("[yoke] Failed to create adapter for local:", e.message);
    }
  }

  return { adapters: adapters, auth: auth };
}

/**
 * Lazy-create an adapter for a vendor that wasn't available at startup.
 * Re-checks auth, creates adapter if an API key is available.
 * Returns the adapter or null.
 */
async function lazyCreateAdapter(adapters, vendor, opts) {
  opts = opts || {};

  // Local has no login or binary: it exists only while enabled in daemon.json.
  if (vendor === "local") {
    if (!registry.isEnabled(registry.get("local"))) return null;
    try {
      var local = createAdapter({ vendor: "local", cwd: opts.cwd });
      adapters.local = local;
      return local;
    } catch (e) {
      console.error("[yoke] Failed to lazy-create adapter for local:", e.message);
      return null;
    }
  }

  // Force re-check since the administrator may have configured an API key
  invalidateAuthCache();
  var installed = checkInstalled();
  if (!installed[vendor] || !credentials.credentialAvailable(vendor)) return null;

  try {
    var ad = createAdapter({ vendor: vendor, cwd: opts.cwd, slug: opts.slug });
    if (typeof ad.init === "function") {
      await ad.init(opts || {});
    }
    console.log("[yoke] Lazy adapter created: " + vendor);
    adapters[vendor] = ad;
    return ad;
  } catch (e) {
    console.error("[yoke] Failed to lazy-create adapter for " + vendor + ":", e.message);
    return null;
  }
}

module.exports = {
  createAdapter: createAdapter,
  createAdapters: createAdapters,
  lazyCreateAdapter: lazyCreateAdapter,
  checkAuth: checkAuth,
  checkInstalled: checkInstalled,
  invalidateAuthCache: invalidateAuthCache,
  INTERFACE_VERSION: iface.INTERFACE_VERSION,
  TOOL_POLICIES: iface.TOOL_POLICIES,
  DIAGNOSTIC_SEVERITIES: iface.DIAGNOSTIC_SEVERITIES,
  DIAGNOSTIC_SOURCES: iface.DIAGNOSTIC_SOURCES,
  validateAdapter: iface.validateAdapter,
  validateQueryHandle: iface.validateQueryHandle,
  validateDiagnosticEvent: iface.validateDiagnosticEvent,
};

return module.exports;
});

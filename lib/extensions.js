"use strict";
// Administrator-supplied code, loaded only from explicit configuration paths.
// Contributions are selected before a module factory runs; core has no vendor
// knowledge about extension implementations. Restart after changing extensions.
const fs = require("fs"), path = require("path");
const modules = new Map(), assets = new Map(), providers = [];
let initialized = false, loading = false, loadedPaths = [];
function load(paths, baseDir) {
  if (initialized) throw new Error("Extensions already initialized; restart the daemon to change extensions");
  if (paths === undefined) paths = [];
  if (!Array.isArray(paths) || paths.some(p => typeof p !== "string" || !p || p.includes("\0"))) throw new Error("extensions must be an array of trusted module paths");
  loading = true;
  const nextModules = new Map(), nextAssets = new Map(), nextProviders = [];
  const api = Object.freeze({
    coreRoot: __dirname,
    module(id, factory) {
      if (!/^[a-z0-9][a-z0-9/-]*$/.test(id) || typeof factory !== "function" || nextModules.has(id)) throw new Error("Invalid or duplicate extension module: " + id);
      nextModules.set(id, factory);
    },
    asset(url, file) {
      if (typeof url !== "string" || !url.startsWith("/") || url.includes("..") || nextAssets.has(url)) throw new Error("Invalid or duplicate extension asset");
      const real = fs.realpathSync(file);
      if (!fs.statSync(real).isFile()) throw new Error("Extension asset must be a file");
      nextAssets.set(url, real);
    },
    provider(descriptor) { if (!descriptor || typeof descriptor.id !== "string" || typeof descriptor.createAdapter !== "function") throw new Error("Invalid extension provider"); nextProviders.push(descriptor); },
  });
  try {
    const resolved = paths.map(p => fs.realpathSync(path.resolve(baseDir || process.cwd(), p)));
    if (new Set(resolved).size !== resolved.length) throw new Error("Duplicate extension path");
    for (const file of resolved) {
      const extension = require(file);
      if (!extension || typeof extension.register !== "function") throw new Error("Extension must export register(api)");
      extension.register(api);
    }
    nextModules.forEach((v,k) => modules.set(k,v)); nextAssets.forEach((v,k) => assets.set(k,v));
    providers.push(...nextProviders); loadedPaths = resolved; initialized = true;
  } finally { loading = false; }
}
function ensure() {
  if (initialized || loading) return;
  const config = require("./config"), cfg = config.loadConfig() || {};
  load(cfg.extensions, path.dirname(config.configPath ? config.configPath() : path.join(config.CONFIG_DIR || process.cwd(), "daemon.json")));
}
function select(id, core) { ensure(); return modules.has(id) ? modules.get(id)() : core(); }
function asset(file) { ensure(); return assets.get("/" + file.replace(/^\/+/, "")) || null; }
function assetRoots() { ensure(); return Array.from(new Set(Array.from(assets.values(), file => path.dirname(file)))); }
function registerProviders(registry) { ensure(); providers.forEach(p => registry.register(p)); }
function paths() { ensure(); return loadedPaths.slice(); }
function loadWorker() {
  if (initialized) return;
  load(JSON.parse(process.env.AIGORA_EXTENSION_PATHS || "[]"));
}
module.exports = { load, loadWorker, select, asset, assetRoots, registerProviders, paths };

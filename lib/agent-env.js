// The daemon's own routing credentials (Clef token/account id, JEV key and their settings) must never reach an agent:
// agents inherit process.env by default, and an uncontained same-UID agent could otherwise print them.

var SECRET_ENV_RE = /^AIGORA_(?:CLEF|JEV)_/;

// Returns a copy of `env` without the daemon's routing secrets.
function stripRoutingSecrets(env) {
  var out = {};
  Object.keys(env || {}).forEach(function (k) { if (!SECRET_ENV_RE.test(k)) out[k] = env[k]; });
  return out;
}

// Deletes the secrets from `env` in place (default process.env): for processes that are themselves agent-side.
function scrubRoutingEnv(env) {
  env = env || process.env;
  Object.keys(env).forEach(function (k) { if (SECRET_ENV_RE.test(k)) delete env[k]; });
  return env;
}

module.exports = { stripRoutingSecrets: stripRoutingSecrets, scrubRoutingEnv: scrubRoutingEnv, SECRET_ENV_RE: SECRET_ENV_RE };

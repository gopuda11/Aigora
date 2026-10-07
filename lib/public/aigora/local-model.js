// local-model.js - the local-model status the AI picker reads (GET api/local-model): whether the provider is enabled and
// its last probe succeeded, and the endpoint list used for labels. There is no composer entry of its own: the model is
// chosen in the AI picker, and the endpoints are managed in the admin settings.

import { usable } from "./local-model-model.js";

// o: { basePath, fetch?, onStatus? }
export function initLocalModel(o) {
  var status = null;
  var doFetch = o.fetch || (typeof fetch === "function" ? fetch : null);

  function apply(next) {
    status = next;
    if (o.onStatus) o.onStatus();
  }

  function refresh() {
    if (!doFetch) return Promise.resolve();
    return doFetch(o.basePath + "api/local-model", { credentials: "same-origin" }).then(function (res) {
      return res.ok ? res.json() : null;
    }).then(function (json) { apply(json); }, function () { apply(null); });
  }

  refresh();
  return { refresh: refresh, status: function () { return status; }, isOffered: function () { return usable(status); } };
}

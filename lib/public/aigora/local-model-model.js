// local-model-model.js - pure helper for the local-model status (GET api/local-model). No DOM, no network.

// Offered only when enabled and the probe succeeded.
export function usable(status) {
  return !!(status && status.enabled === true && status.ready === true);
}

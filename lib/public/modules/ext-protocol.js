// ext-protocol.js - names used on the page <-> Chrome extension postMessage channel.
// Pure (no DOM) so it can be unit-tested.
//
// Names: source "aigora-chrome-extension" / "aigora-page", types aigora_ext_*,
// aigora_mcp_tool_call. No other dialect is accepted.

var EXT_SOURCE = "aigora-chrome-extension";
var PAGE_SOURCE = "aigora-page";

export function isExtensionSource(source) {
  return source === EXT_SOURCE;
}

// Build a window.postMessage envelope for the extension.
export function pageEnvelope(payload) {
  return { source: PAGE_SOURCE, payload: payload };
}

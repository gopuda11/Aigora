// dom-morph.js - Update a container to new markup while keeping the nodes that did not
// change. The Aigora sidebar tree re-renders on every store change; replacing its nodes
// would cut a running disclosure animation short and drop keyboard focus, so a browser
// patches the existing nodes instead. Anything that cannot do that (no <template>
// content, no getAttributeNames: the fake DOM of the tests) falls back to innerHTML, so
// the resulting markup is identical either way.

function canMorph(el) {
  if (!el || typeof el.getAttributeNames !== "function" || typeof document === "undefined") return false;
  var t = document.createElement("template");
  return !!(t && t.content && typeof t.content.childNodes !== "undefined");
}

// A node and its replacement stand for the same thing: same kind of node and, for
// elements, the same key (id, data-room-id, data-disc, ...) so a list that gained a row
// does not hand one row's node to another.
var KEYS = ["id", "data-room-id", "data-session-id", "data-private-session", "data-private-admin-session", "data-disc", "data-chev", "data-ag-section"];
function keyOf(node) {
  if (node.nodeType !== 1) return "";
  for (var i = 0; i < KEYS.length; i++) {
    var v = node.getAttribute(KEYS[i]);
    if (v != null) return KEYS[i] + "=" + v;
  }
  return "";
}

// <i data-lucide="x"> becomes <svg class="lucide lucide-x"> after an icon pass; the same icon.
function sameIcon(live, next) {
  return next.nodeName === "I" && next.hasAttribute("data-lucide") && live.nodeName.toLowerCase() === "svg" &&
    String(live.getAttribute("class") || "").indexOf("lucide-" + next.getAttribute("data-lucide")) !== -1;
}

function same(live, next) {
  if (live.nodeType !== next.nodeType) return false;
  if (live.nodeType !== 1) return true;
  if (live.nodeName !== next.nodeName) return sameIcon(live, next);
  return keyOf(live) === keyOf(next);
}

function patchAttributes(live, next) {
  live.getAttributeNames().forEach(function (name) { if (!next.hasAttribute(name)) live.removeAttribute(name); });
  next.getAttributeNames().forEach(function (name) {
    var value = next.getAttribute(name);
    if (live.getAttribute(name) !== value) live.setAttribute(name, value);
  });
}

function patch(live, next) {
  if (live.nodeType !== 1) {
    if (live.nodeValue !== next.nodeValue) live.nodeValue = next.nodeValue;
    return;
  }
  if (live.nodeName.toLowerCase() === "svg" && next.nodeName === "I") return;
  patchAttributes(live, next);
  patchChildren(live, next);
}

function patchChildren(live, next) {
  var want = Array.prototype.slice.call(next.childNodes);
  var have = Array.prototype.slice.call(live.childNodes);
  for (var i = 0; i < want.length; i++) {
    var node = want[i];
    var cur = have[i];
    if (cur && same(cur, node)) { patch(cur, node); continue; }
    // A keyed node further along (a row was inserted or removed before it): reuse it.
    var key = keyOf(node);
    var found = null;
    if (key) {
      for (var j = i + 1; j < have.length; j++) if (keyOf(have[j]) === key && same(have[j], node)) { found = have[j]; have.splice(j, 1); break; }
    }
    if (found) {
      live.insertBefore(found, cur || null);
      have.splice(i, 0, found);
      patch(found, node);
    } else {
      live.insertBefore(node, cur || null);
      have.splice(i, 0, node);
    }
  }
  for (var k = have.length - 1; k >= want.length; k--) live.removeChild(have[k]);
}

export function setHtmlKeepingNodes(el, html) {
  if (!canMorph(el)) { el.innerHTML = html; return; }
  var t = document.createElement("template");
  t.innerHTML = html;
  patchChildren(el, t.content);
}

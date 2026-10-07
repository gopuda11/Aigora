// Synchronous access-change fanout; listeners own only their project's live state.
var listeners = new Set();
function onAccessChanged(fn) {
  listeners.add(fn);
  return function () { listeners.delete(fn); };
}
function notifyAccessChanged(change) {
  listeners.forEach(function (fn) {
    try { fn(change || {}); } catch (_) {}
  });
}
module.exports = { onAccessChanged: onAccessChanged, notifyAccessChanged: notifyAccessChanged };

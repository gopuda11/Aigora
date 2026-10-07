// deadline.js - one timer that covers preparation AND the run of a model call.
//
// Start it before any credential / scope / query preparation. When it fires it aborts the controller and closes
// every handle it knows about. A handle whose preparation finishes after the deadline is closed on arrival, so a
// slow start can neither run nor leak.

function createDeadline(ms, controller, onTimeout) {
  var timer, fired = false, handles = [];
  var expiry = new Promise(function (_, reject) {
    timer = setTimeout(function () {
      fired = true;
      try { controller.abort(); } catch (_) {}
      handles.forEach(closeQuietly);
      reject(onTimeout());
    }, ms);
  });
  expiry.catch(function () {}); // never an unhandled rejection when nobody is racing it any more
  return {
    fired: function () { return fired; },
    clear: function () { clearTimeout(timer); },
    // Await `prep` (resolving to a handle or null) against the deadline.
    prepare: function (prep) {
      var p = Promise.resolve(prep);
      p.then(function (h) { if (fired) closeQuietly(h); }, function () {});
      return Promise.race([p, expiry]).then(function (h) { if (fired) { closeQuietly(h); throw onTimeout(); } return h; });
    },
    track: function (h) { if (h) { if (fired) closeQuietly(h); else handles.push(h); } return h; },
    race: function (p) { return Promise.race([p, expiry]); },
  };
}
function closeQuietly(h) { try { if (h && typeof h.close === "function") h.close(); } catch (_) {} }

module.exports = { createDeadline: createDeadline };

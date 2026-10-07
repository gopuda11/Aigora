// Long-press to synthesize contextmenu events on touch devices.
// All existing contextmenu listeners automatically work with this.

var LONG_PRESS_MS = 500;
var MOVE_THRESHOLD = 10;

var _timer = null;
var _startX = 0;
var _startY = 0;
var _fired = false;
var _targetEl = null;

function cancelTimer() {
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
  }
}

export function initLongPress() {
  if (!("ontouchstart" in window)) return;

  document.addEventListener("touchstart", function (e) {
    if (e.touches.length !== 1) {
      cancelTimer();
      return;
    }
    var touch = e.touches[0];
    _startX = touch.clientX;
    _startY = touch.clientY;
    _fired = false;
    _targetEl = e.target;

    _timer = setTimeout(function () {
      _timer = null;
      _fired = true;

      // Haptic feedback if available
      if (navigator.vibrate) navigator.vibrate(30);

      var evt = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: _startX,
        clientY: _startY
      });
      _targetEl.dispatchEvent(evt);
    }, LONG_PRESS_MS);
  }, { passive: true });

  document.addEventListener("touchmove", function (e) {
    if (!_timer) return;
    var touch = e.touches[0];
    var dx = touch.clientX - _startX;
    var dy = touch.clientY - _startY;
    if (dx * dx + dy * dy > MOVE_THRESHOLD * MOVE_THRESHOLD) {
      cancelTimer();
    }
  }, { passive: true });

  document.addEventListener("touchend", function (e) {
    cancelTimer();
    // Suppress tap/click after a long-press fired
    if (_fired) {
      _fired = false;
      e.preventDefault();
    }
  }, { passive: false });

  document.addEventListener("touchcancel", function () {
    cancelTimer();
    _fired = false;
  }, { passive: true });
}

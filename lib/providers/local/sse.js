"use strict";
// Incremental Server-Sent Events parser for OpenAI-style streams. push() takes text in any chunking (a chunk may end
// mid-line or between the CR and LF of a line break). onData(data) gets the data payload of each complete event
// (multi-line data joined with \n). Comment lines (":...") and non-data fields are ignored. end() flushes a final
// event that was not terminated by a blank line.
function createSseParser(onData) {
  var buf = "", data = [], skipLf = false;
  function dispatch() {
    if (data.length) { var d = data.join("\n"); data = []; onData(d); }
  }
  function line(l) {
    if (l === "") return dispatch();
    if (l.charAt(0) === ":") return;
    var i = l.indexOf(":");
    var field = i === -1 ? l : l.slice(0, i);
    var value = i === -1 ? "" : l.slice(i + 1);
    if (value.charAt(0) === " ") value = value.slice(1);
    if (field === "data") data.push(value);
  }
  return {
    push: function (text) {
      buf += text;
      var start = 0;
      for (var i = 0; i < buf.length; i++) {
        var ch = buf.charAt(i);
        if (skipLf) { skipLf = false; if (ch === "\n") { start = i + 1; continue; } }
        if (ch === "\n" || ch === "\r") {
          line(buf.slice(start, i));
          start = i + 1;
          if (ch === "\r") { if (start < buf.length) { if (buf.charAt(start) === "\n") { start++; i++; } } else skipLf = true; }
        }
      }
      buf = buf.slice(start);
    },
    end: function () {
      if (buf) { line(buf); buf = ""; }
      dispatch();
    },
  };
}

module.exports = { createSseParser: createSseParser };

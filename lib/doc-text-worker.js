"use strict";
// doc-text-worker.js - runs one doc-text extraction off the main thread (see bundleAsync in doc-text.js).
var wt = require("worker_threads");
var doc = require("./doc-text");
wt.parentPort.on("message", function (m) {
  wt.parentPort.postMessage(doc.extractText(m.name, Buffer.from(m.buf.buffer, m.buf.byteOffset, m.buf.byteLength), { maxChars: m.maxChars }));
});

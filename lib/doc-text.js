"use strict";
// doc-text.js - plain text out of the few file kinds a verifier may read, with hard caps. Pure functions over a Buffer:
// no file system, no network, nothing executed. Plain text kinds are decoded as UTF-8; .docx/.xlsx/.pptx are zip
// containers whose XML parts are stripped to text (a small zip reader on Node's zlib; zip64, encryption and
// multi-disk archives are refused as "binary"). Every inflate is size-capped, so a zip bomb cannot grow memory.
// Anything else (including .pdf, which has no trivially extractable text layer) is reported as binary.
var zlib = require("zlib");

var TEXT_EXTS = ["md", "txt", "csv", "tsv", "json"];
var ZIP_EXTS = ["docx", "xlsx", "pptx"];
var MAX_PART_BYTES = 8 * 1024 * 1024;   // one inflated XML part
var MAX_ENTRIES = 5000;                 // central directory entries read
var MAX_PARTS = 400;                    // XML parts one document may contribute (slides, sheets)
var MAX_FILE_INFLATED = 16 * 1024 * 1024; // all inflated parts of one document together
var MAX_SST_ENTRIES = 50000;            // xlsx shared-string table entries kept
var MAX_SST_CHARS = 1024 * 1024;        // xlsx shared-string table characters kept
var DEFAULT_MAX_CHARS = 64 * 1024;      // text budget of extractText when the caller names none
var DEADLINE_MS = 3000;                 // one document's extraction in the worker thread

function extOf(name) { var m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || "")); return m ? m[1].toLowerCase() : ""; }

// --- zip ------------------------------------------------------------------------------

// -> Map name -> { method, csize, usize, offset } or null when this is not a plain zip we can read.
function readCentralDirectory(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) return null;
  var eocd = -1;
  for (var i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  var disk = buf.readUInt16LE(eocd + 4), total = buf.readUInt16LE(eocd + 10);
  var cdSize = buf.readUInt32LE(eocd + 12), cdOff = buf.readUInt32LE(eocd + 16);
  if (disk !== 0 || total === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) return null; // multi-disk / zip64
  if (total > MAX_ENTRIES || cdOff + cdSize > buf.length) return null;
  var entries = new Map(), p = cdOff;
  for (var n = 0; n < total; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return null;
    var flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10);
    var csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    var nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    var offset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen > buf.length) return null;
    var name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (!(flags & 1) && csize !== 0xffffffff && usize !== 0xffffffff && offset !== 0xffffffff) entries.set(name, { method: method, csize: csize, usize: usize, offset: offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// -> Buffer of the entry's bytes, or null (missing, unsupported method, corrupt, larger than the part cap or than what is
// left of the per-file inflate budget `budget.left`).
function readEntry(buf, entry, budget) {
  var cap = Math.min(MAX_PART_BYTES, budget ? budget.left : MAX_PART_BYTES);
  if (!entry || entry.usize > cap || entry.offset + 30 > buf.length || buf.readUInt32LE(entry.offset) !== 0x04034b50) return null;
  var start = entry.offset + 30 + buf.readUInt16LE(entry.offset + 26) + buf.readUInt16LE(entry.offset + 28);
  if (start + entry.csize > buf.length) return null;
  var raw = buf.subarray(start, start + entry.csize), out = null;
  try {
    if (entry.method === 0) out = raw.length <= cap ? raw : null;
    else if (entry.method === 8) out = zlib.inflateRawSync(raw, { maxOutputLength: cap });
  } catch (_) { /* corrupt or over the cap */ }
  if (out && budget) budget.left -= out.length;
  return out;
}

// --- XML to text ----------------------------------------------------------------------
// Single-pass, indexOf-based scanning: every byte of the XML is looked at a bounded number of times, so malformed input
// (thousands of opens without closes, unterminated tags) cannot cause quadratic work. No regex runs over a whole part.

var ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-z]{2,4});/g, function (m, e) {
    if (e[0] === "#") {
      var cp = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : "";
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, e) ? ENTITIES[e] : m;
  });
}
function xmlOf(buf) { return buf ? buf.toString("utf8") : ""; }

// Text budget of one extraction: add() clips at `max` chars, after which the sink is full and callers stop.
function makeSink(max) {
  var parts = [], len = 0, sink = { full: false };
  sink.room = function () { return max - len; };
  sink.add = function (str) {
    if (sink.full || !str) return;
    if (str.length >= max - len) { str = str.slice(0, max - len); sink.full = true; }
    parts.push(str); len += str.length;
  };
  sink.text = function () { return parts.join(""); };
  if (max <= 0) sink.full = true;
  return sink;
}

// Tag cursor over `xml`: next() -> { name, closing, selfClosing, attrs, end } for the next tag, or null.
// `end` is the index just after its '>'. Only the first MAX_TAG chars of a tag are kept as name + attributes.
// The next '>' is remembered, so a run of '<' before one distant '>' is one tag, not N scans.
var MAX_TAG = 2048;
function cursor(xml) {
  var pos = 0, gt = -1, noClose = {};
  return {
    next: function () {
      var lt = xml.indexOf("<", pos);
      while (lt !== -1 && (xml.charCodeAt(lt + 1) === 33 || xml.charCodeAt(lt + 1) === 63)) { // comment, <?xml ?>, doctype
        var skip = xml.indexOf(">", lt);
        if (skip === -1) { pos = xml.length; return null; }
        lt = xml.indexOf("<", skip + 1);
      }
      if (lt === -1) { pos = xml.length; return null; }
      if (gt < lt) { gt = xml.indexOf(">", lt); if (gt === -1) { pos = xml.length; return null; } }
      pos = gt + 1;
      var closing = xml.charCodeAt(lt + 1) === 47, i = lt + (closing ? 2 : 1), n = Math.min(gt, lt + MAX_TAG), j = i;
      while (j < n && " \t\r\n/>".indexOf(xml[j]) === -1) j++;
      return { name: xml.slice(i, j), closing: closing, selfClosing: xml.charCodeAt(gt - 1) === 47, attrs: xml.slice(j, n), start: lt, end: gt + 1 };
    },
    // Index of "</name>" at or after the current position; -1 (remembered, so asked again it costs nothing) when none.
    close: function (name) {
      if (noClose[name]) return -1;
      var at = xml.indexOf("</" + name + ">", pos);
      if (at === -1) noClose[name] = true;
      return at;
    },
    skipTo: function (p) { pos = p; },
  };
}

// fn(inner, attrs) for each <name>..</name> (inner "" for <name/>); fn returns false to stop.
function eachElement(xml, name, fn) {
  var cur = cursor(xml), tag;
  while ((tag = cur.next())) {
    if (tag.closing || tag.name !== name) continue;
    if (tag.selfClosing) { if (fn("", tag.attrs) === false) return; continue; }
    var at = cur.close(name);
    if (at === -1) continue;
    var inner = xml.slice(tag.end, at);
    cur.skipTo(at + name.length + 3);
    if (fn(inner, tag.attrs) === false) return;
  }
}
function attr(attrs, name) {
  var m = new RegExp("\\s" + name + "=\"([^\"]*)\"").exec(attrs);
  return m ? m[1] : null;
}
// Decoded text of the <name> elements of `xml`, at most `max` chars.
function textsOf(xml, name, max) {
  var out = "";
  eachElement(xml, name, function (inner) {
    out += decodeEntities(inner.length > max - out.length ? inner.slice(0, max - out.length) : inner);
    return out.length < max;
  });
  return out.slice(0, Math.max(0, max));
}
// Raw inner text of the first <name>, or null.
function firstText(xml, name) {
  var r = null;
  eachElement(xml, name, function (inner) { r = inner; return false; });
  return r;
}

// Runs of <t> text; paragraph ends and <br/> become newlines, <w:tab/> a tab.
function paragraphsText(xml, tText, pEnd, br, sink) {
  var cur = cursor(xml), tag;
  while (!sink.full && (tag = cur.next())) {
    if (tag.closing) { if (tag.name === pEnd) sink.add("\n"); continue; }
    if (tag.selfClosing) {
      if (tag.name === br) sink.add("\n");
      else if (tag.name === "w:tab") sink.add("\t");
    } else if (tag.name === tText) {
      var at = cur.close(tText);
      if (at === -1) continue;
      sink.add(decodeEntities(xml.slice(tag.end, Math.min(at, tag.end + sink.room() * 8 + 16)))); // entities shrink; never decode far past the budget
      cur.skipTo(at + tText.length + 3);
    }
  }
}
function tidy(s) { return s.replace(/\n{3,}/g, "\n\n").trim(); }

function docxText(buf, zip, budget, sink) {
  paragraphsText(xmlOf(readEntry(buf, zip.get("word/document.xml"), budget)), "w:t", "w:p", "w:br", sink);
  return tidy(sink.text());
}

function pptxText(buf, zip, budget, sink) {
  var slides = Array.from(zip.keys()).filter(function (n) { return /^ppt\/slides\/slide\d+\.xml$/.test(n); })
    .sort(function (a, b) { return parseInt(a.replace(/\D/g, ""), 10) - parseInt(b.replace(/\D/g, ""), 10); }).slice(0, MAX_PARTS);
  for (var i = 0; i < slides.length && !sink.full; i++) {
    var sub = makeSink(sink.room());
    paragraphsText(xmlOf(readEntry(buf, zip.get(slides[i]), budget)), "a:t", "a:p", "a:br", sub);
    var t = tidy(sub.text());
    sink.add((i ? "\n\n" : "") + "## Slide " + (i + 1) + (t ? "\n" + t : ""));
  }
  return sink.text();
}

function colIndex(ref) {
  var m = /^([A-Z]{1,3})/.exec(ref || "");
  if (!m) return -1;
  var n = 0;
  for (var i = 0; i < m[1].length; i++) n = n * 26 + (m[1].charCodeAt(i) - 64);
  return n - 1;
}

function xlsxText(buf, zip, budget, sink) {
  // Shared strings: bounded entry count and total chars, each clipped to the text budget, so a cell that references one
  // can never add more than the budget however often it is referenced.
  var shared = [], sstChars = 0, per = sink.room();
  eachElement(xmlOf(readEntry(buf, zip.get("xl/sharedStrings.xml"), budget)), "si", function (inner) {
    var t = textsOf(inner, "t", Math.min(per, MAX_SST_CHARS - sstChars));
    shared.push(t); sstChars += t.length;
    return shared.length < MAX_SST_ENTRIES && sstChars < MAX_SST_CHARS;
  });
  // Sheet order and names from the workbook; its relationships map r:id to the part.
  var wb = xmlOf(readEntry(buf, zip.get("xl/workbook.xml"), budget));
  var rels = xmlOf(readEntry(buf, zip.get("xl/_rels/workbook.xml.rels"), budget));
  var target = {};
  eachElement(rels, "Relationship", function (_, attrs) {
    var id = attr(attrs, "Id"), tg = attr(attrs, "Target");
    if (id !== null && tg !== null) target[id] = tg.replace(/^\/?(?:xl\/)?/, "xl/");
  });
  var sheets = [];
  eachElement(wb, "sheet", function (_, attrs) {
    var nm = attr(attrs, "name"), rid = attr(attrs, "r:id");
    if (nm !== null && rid !== null && Object.prototype.hasOwnProperty.call(target, rid)) sheets.push({ name: decodeEntities(nm).slice(0, 200), part: target[rid] });
    return sheets.length < MAX_PARTS;
  });
  for (var si = 0; si < sheets.length && !sink.full; si++) {
    var sh = sheets[si];
    sink.add((si ? "\n\n" : "") + "## " + sh.name);
    eachElement(xmlOf(readEntry(buf, zip.get(sh.part), budget)), "row", function (rowInner) {
      var cells = [], chars = 0;
      eachElement(rowInner, "c", function (body, attrs) {
        var ref = attr(attrs, "r"), type = attr(attrs, "t"), val = "";
        if (type === "s") { var v = firstText(body, "v"); val = v ? shared[parseInt(v, 10)] || "" : ""; }
        else if (type === "inlineStr") val = textsOf(body, "t", sink.room());
        else { var v2 = firstText(body, "v"); val = v2 ? decodeEntities(v2.slice(0, sink.room())) : ""; }
        var f = firstText(body, "f");
        if (f && val) val += " [=" + decodeEntities(f.slice(0, sink.room())) + "]";
        var ci = ref ? colIndex(ref) : cells.length;
        while (ci > cells.length && cells.length < 200) cells.push("");
        cells.push(val.replace(/[\t\r\n]+/g, " "));
        chars += val.length + 1;
        return chars <= sink.room();
      });
      while (cells.length && cells[cells.length - 1] === "") cells.pop();
      if (cells.length) sink.add("\n" + cells.join("\t"));
      return !sink.full;
    });
  }
  return sink.text();
}

// -> { text, capped? } | { binary: true }. Never throws. opts.maxChars bounds the decoded text DURING extraction
// (capped: true when extraction stopped because of it); inflated bytes are bounded per part and per file.
function extractText(name, buf, opts) {
  try {
    var ext = extOf(name), max = (opts && opts.maxChars > 0 && opts.maxChars) || DEFAULT_MAX_CHARS;
    if (!Buffer.isBuffer(buf)) return { binary: true };
    if (TEXT_EXTS.indexOf(ext) !== -1) {
      if (buf.indexOf(0) !== -1) return { binary: true };
      var cut = buf.length > max * 4, text = buf.subarray(0, max * 4).toString("utf8").replace(/^\ufeff/, "");
      if (cut) text = text.replace(/\ufffd$/, "");
      return text.length > max ? { text: text.slice(0, max), capped: true } : cut ? { text: text, capped: true } : { text: text };
    }
    if (ZIP_EXTS.indexOf(ext) !== -1) {
      var zip = readCentralDirectory(buf);
      if (!zip) return { binary: true };
      var budget = { left: MAX_FILE_INFLATED }, sink = makeSink(max);
      var out = ext === "docx" ? docxText(buf, zip, budget, sink) : ext === "pptx" ? pptxText(buf, zip, budget, sink) : xlsxText(buf, zip, budget, sink);
      return sink.full ? { text: out, capped: true } : { text: out };
    }
  } catch (_) { /* fall through */ }
  return { binary: true };
}

// Largest prefix of `s` that fits `max` UTF-8 bytes, cut on a character boundary.
function clipBytes(s, max) {
  if (Buffer.byteLength(s, "utf8") <= max) return s;
  var cut = Buffer.from(s, "utf8").subarray(0, max).toString("utf8");
  return cut.replace(/�$/, "");
}

// One bundled entry from an extraction result; `left` is the total bytes still available.
function shape(f, r, perFile, left) {
  if (!r) return { name: f.name, note: "unreadable" };
  if (r.binary) return { name: f.name, note: "binary" };
  var text = String(r.text || "").trim();
  if (!text) return { name: f.name, note: "empty" };
  if (left < 200) return { name: f.name, note: "over_cap" }; // not worth a crumb
  var kept = clipBytes(text, Math.min(perFile, left));
  return { name: f.name, text: kept, truncated: kept.length < text.length || r.capped === true };
}
function limitsOf(limits) { return { perFile: (limits && limits.perFile) || 20 * 1024, total: (limits && limits.total) || 40 * 1024 }; }

/**
 * bundle(files, { perFile, total }) -> [{ name, text?, truncated?, note? }] in input order.
 * files: [{ name, buf }] (buf null = not readable). note is a fixed code: "binary" | "too_large" | "unreadable" | "empty" |
 * "over_cap" (named only because the total cap was used up). Text is clipped to perFile bytes and to what is left of total.
 * Extraction itself stops once perFile (+ a little, to know it was cut) characters exist. Runs on the calling thread:
 * use bundleAsync for untrusted files.
 */
function bundle(files, limits) {
  var lim = limitsOf(limits), left = lim.total;
  return (files || []).map(function (f) {
    if (!f.buf) return { name: f.name, note: f.note || "unreadable" };
    var out = shape(f, extractText(f.name, f.buf, { maxChars: lim.perFile + 1024 }), lim.perFile, left);
    if (out.text) left -= Buffer.byteLength(out.text, "utf8");
    return out;
  });
}

// Extraction of one zip document in a worker thread with a hard deadline: -> Promise of an extractText result, or null
// (deadline, crash, out of memory). Never rejects.
function extractInWorker(name, buf, maxChars, deadlineMs) {
  return new Promise(function (resolve) {
    var done = false, w, timer;
    function end(r) { if (done) return; done = true; clearTimeout(timer); try { if (w) w.terminate(); } catch (_) {} resolve(r); }
    try {
      w = new (require("worker_threads").Worker)(require("path").join(__dirname, "doc-text-worker.js"), { resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 } });
      timer = setTimeout(function () { end(null); }, deadlineMs);
      w.on("message", function (m) { end(m && typeof m === "object" ? m : null); });
      w.on("error", function () { end(null); });
      w.on("exit", function () { end(null); });
      var copy = new Uint8Array(buf.length); copy.set(buf);
      w.postMessage({ name: name, buf: copy, maxChars: maxChars }, [copy.buffer]);
    } catch (_) { end(null); }
  });
}

/**
 * bundleAsync(files, limits, { deadlineMs }) -> Promise of what bundle returns, except that zip documents are extracted
 * in a worker thread (the event loop never runs the parser) with a hard per-file deadline; a file that exceeds it, crashes
 * or runs out of memory is "unreadable". Never rejects.
 */
function bundleAsync(files, limits, opts) {
  var lim = limitsOf(limits), left = lim.total, deadline = (opts && opts.deadlineMs) || DEADLINE_MS, maxChars = lim.perFile + 1024;
  return (files || []).reduce(function (acc, f) {
    return acc.then(function (list) {
      if (!f.buf) return list.concat([{ name: f.name, note: f.note || "unreadable" }]);
      var isZip = ZIP_EXTS.indexOf(extOf(f.name)) !== -1 && Buffer.isBuffer(f.buf);
      return (isZip ? extractInWorker(f.name, f.buf, maxChars, deadline) : Promise.resolve(extractText(f.name, f.buf, { maxChars: maxChars }))).then(function (r) {
        var out = shape(f, r, lim.perFile, left);
        if (out.text) left -= Buffer.byteLength(out.text, "utf8");
        return list.concat([out]);
      });
    });
  }, Promise.resolve([]));
}

module.exports = { extractText: extractText, bundle: bundle, bundleAsync: bundleAsync, clipBytes: clipBytes, readCentralDirectory: readCentralDirectory, readEntry: readEntry, TEXT_EXTS: TEXT_EXTS, ZIP_EXTS: ZIP_EXTS };

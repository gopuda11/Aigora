"use strict";
// Canonical tokens are a transport format only. History/prompts keep plain names
// plus UTF-16 ranges, so a name never becomes an AI routing directive.
function key(s) { return String(s || "").normalize("NFC").toLowerCase(); }
function resolveMentions(text, people, opts) {
  text = typeof text === "string" ? text.normalize("NFC") : "";
  people = Array.isArray(people) ? people : [];
  var byId = new Map(), aliases = new Map();
  people.forEach(function (p) {
    byId.set(p.id, p);
    [p.name].forEach(function (name) {
      if (!name) return;
      var k = key(name), ids = aliases.get(k) || new Set();
      ids.add(p.id); aliases.set(k, ids);
    });
  });
  var names = [...aliases.keys()].sort(function (a, b) { return b.length - a.length; });
  var out = "", mentions = [], mentionRanges = [], ids = new Set();
  function add(p, label) {
    var start = out.length;
    out += "@" + (p ? p.name : label);
    mentionRanges.push({ start: start, end: out.length });
    if (p) { mentions.push({ userId: p.id, name: p.name, start: start, end: out.length }); ids.add(p.id); }
  }
  for (var i = 0; i < text.length;) {
    var token = text[i] === "@" && /^@\[([^\]\r\n]*)\]\(user:([A-Za-z0-9_.:-]{1,120})\)/.exec(text.slice(i));
    if (token) {
      var label = token[1];
      try { label = decodeURIComponent(label); } catch (_) { /* legacy unencoded name */ }
      add(byId.get(token[2]), label); i += token[0].length; continue;
    }
    if (text[i] === "@" && (i === 0 || /[\s(\[{,.;:!?"']/.test(text[i - 1]))) {
      var found = null;
      for (var n of names) {
        var candidate = text.slice(i + 1, i + 1 + n.length);
        if (key(candidate) === n && !/[\p{L}\p{N}_-]/u.test(text[i + 1 + n.length] || "")) { found = n; break; }
      }
      if (found && aliases.get(found).size === 1 && !(opts && opts.isAiAlias && opts.isAiAlias(found))) {
        add(byId.get([...aliases.get(found)][0])); i += 1 + found.length; continue;
      }
    }
    out += text[i++];
  }
  return { text: out, mentions: mentions, mentionIds: [...ids], mentionRanges: mentionRanges };
}
function withoutMemberMentions(text, ranges) {
  var chars = String(text || "").split("");
  (Array.isArray(ranges) ? ranges : []).forEach(function (r) {
    if (!r || !Number.isInteger(r.start) || !Number.isInteger(r.end) || r.start < 0 || r.end > chars.length || r.end <= r.start) return;
    for (var i = r.start; i < r.end; i++) chars[i] = " ";
  });
  return chars.join("");
}
module.exports = { resolveMentions: resolveMentions, withoutMemberMentions: withoutMemberMentions };

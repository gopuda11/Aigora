// Room roster only; identity and permissions are revalidated on the server.
import { escapeHtml } from "../modules/escape-html.js";

export function memberOptions(members, selfId) {
  return (Array.isArray(members) ? members : []).filter(function (p) { return p && p.id && p.id !== selfId; }).map(function (p) {
    var name = String(p.name || p.displayName || "");
    // Encode only characters that would break the token grammar, keeping names readable in the textarea.
    var label = name.replace(/[%\]\r\n]/g, function (c) { return encodeURIComponent(c); });
    return { id: "user:" + p.id, member: true, label: name, sub: "", names: [name].map(function (n) { return n.normalize("NFC").toLowerCase(); }), mention: "@[" + label + "](user:" + p.id + ")" };
  });
}

// Canonical member tokens must not activate a provider chip, even when the
// selected display name happens to be an AI alias. Plain exact names use the
// same unique-member rule; the server remains authoritative.
export function draftRoutingText(text, members, isAiAlias) {
  var s = String(text || "").normalize("NFC").replace(/@\[[^\]\r\n]*\]\(user:[A-Za-z0-9_.:-]{1,120}\)/g, " ");
  var names = new Map();
  (members || []).forEach(function (p) {
    [p.name].forEach(function (n) {
      if (!n) return;
      n = String(n).normalize("NFC").toLowerCase();
      var ids = names.get(n) || new Set(); ids.add(p.id); names.set(n, ids);
    });
  });
  [...names.keys()].sort(function (a, b) { return b.length - a.length; }).forEach(function (name) {
    if (names.get(name).size !== 1 || isAiAlias && isAiAlias(name)) return;
    var escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    s = s.replace(new RegExp("(^|[\\s(\\[{,.;:!?\"'])@" + escaped + "(?![\\p{L}\\p{N}_-])", "giu"), "$1 ");
  });
  return s;
}

export function mentionTextHtml(text, mentions, myId, formatInline) {
  formatInline = formatInline || escapeHtml;
  text = String(text || "");
  var ranges = (Array.isArray(mentions) ? mentions : []).filter(function (m) { return m && typeof m === "object"; }).sort(function (a, b) { return a.start - b.start; });
  var out = "", at = 0;
  ranges.forEach(function (m) {
    if (!m || !m.userId || !Number.isInteger(m.start) || !Number.isInteger(m.end) || m.start < at || m.end > text.length || m.end <= m.start) return;
    out += formatInline(text.slice(at, m.start));
    out += '<span class="ai-member-mention' + (String(myId) === String(m.userId) ? ' is-me' : '') + '">' + escapeHtml(text.slice(m.start, m.end)) + '</span>';
    at = m.end;
  });
  return out + formatInline(text.slice(at));
}

// Keep identity outside the textarea. Only untouched picked ranges become tokens
// at dispatch; ordinary edits keep normal text and invalidate a changed identity.
export function createMentionDraft() {
  var text = "", ranges = [];
  function sync(next) {
    next = String(next || "");
    if (next === text) return;
    var start = 0, end = text.length, nextEnd = next.length;
    while (start < end && start < nextEnd && text[start] === next[start]) start++;
    while (end > start && nextEnd > start && text[end - 1] === next[nextEnd - 1]) { end--; nextEnd--; }
    var delta = nextEnd - end;
    ranges = ranges.filter(function (r) {
      if (r.end <= start) return true;
      if (r.start >= end) { r.start += delta; r.end += delta; return true; }
      return false;
    });
    text = next;
  }
  return {
    sync: sync,
    insert: function (q, member) {
      var label = "@" + member.label;
      var next = text.slice(0, q.start) + label + " " + text.slice(q.end);
      sync(next);
      ranges.push({ start: q.start, end: q.start + label.length, token: member.mention });
      ranges.sort(function (a, b) { return a.start - b.start; });
      return { text: next, caret: q.start + label.length + 1 };
    },
    canonical: function (next) {
      sync(next);
      var out = "", at = 0;
      ranges.forEach(function (r) { out += text.slice(at, r.start) + r.token; at = r.end; });
      return out + text.slice(at);
    },
  };
}

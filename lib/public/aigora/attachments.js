// attachments.js - Controller for room and private-channel file attachments:
// the "파일" item of the composer "+" menu, drag and drop, upload progress
// chips, the feed card actions (download, text preview, delete), "이번 지시에 첨부"
// and the "방 파일 첨부" picker (files for the NEXT AI instruction only, with 결과 파일
// 가져오기), and the private -> room share sheet.
// Bytes go over HTTP (XMLHttpRequest for progress), never the websocket; the
// server decides every permission, this file only hides what would be refused.

import { ACCEPT, fileProblem, reasonFor, cardHtml, uploadsHtml, shareSheetHtml, shareTargets, pickEntryText, pickerSheetHtml, resultCardHtml, PREVIEW_CHARS, TRANSCRIPT_PREVIEW_CHARS, kindOf } from "./attachments-model.js";
import { t, onLangChange } from "./i18n.js";

export function initAttachments(deps) {
  var els = deps.els;
  var uploads = [];
  var current = null;
  var seq = 0;
  var previews = {};
  var sheet = null;
  var deleteArmed = null;
  var MAX_PICKED = 10; // the server's per-instruction cap
  var picked = [];     // [{ id, name, size }] attached to the next AI instruction
  var list = { key: null, files: [], sig: "" };
  var listTick = 0;  // orders listings against uploads: a listing issued before an upload finished cannot prune its chip
  var fresh = {};    // attachment id -> listTick when an upload auto-attached it
  var pickSheet = null;

  function base() { return deps.base(); }

  // Where a file picked now would go, or why it cannot.
  function target() {
    var s = deps.getSession();
    var room = deps.getRoom();
    var a = deps.getAccess();
    if (!s) return { reason: t("attachments.pickSessionFirst") };
    if (a && a.isPrivate) {
      if (!a.owner || a.readOnly) return { reason: a.adminReadOnly ? t("attachments.adminReadOnly") : t("attachments.channelReadOnly") };
      if (!s.channelId) return { reason: t("attachments.channelNoUpload") };
      return { kind: "channel", channelId: s.channelId, sessionId: s.id };
    }
    if (!room) return { reason: t("attachments.pickRoomFirst") };
    if (room.role === "viewer") return { reason: t("attachments.roomReadOnly") };
    if (!deps.isRoomMain()) return { reason: t("attachments.openRoomChat") };
    return { kind: "room", roomId: room.id };
  }
  function privateOwner() { var a = deps.getAccess(); return !!(a && a.isPrivate && a.owner && !a.readOnly); }
  function endpoint(t) {
    return base() + (t.kind === "channel" ? "channel-attachments/" + encodeURIComponent(t.channelId) + "?session=" + encodeURIComponent(t.sessionId) : "room-attachments/" + encodeURIComponent(t.roomId));
  }

  // --- Upload chips ---------------------------------------------------------------
  function renderUploads() {
    if (!els.uploads) return;
    els.uploads.classList.toggle("hidden", uploads.length === 0);
    els.uploads.innerHTML = uploadsHtml(uploads, { adminVisible: uploads.some(function (u) { return u.target && u.target.kind === "channel"; }) });
  }
  function find(id) { for (var i = 0; i < uploads.length; i++) if (uploads[i].id === id) return uploads[i]; return null; }
  function drop(u) { uploads = uploads.filter(function (x) { return x !== u; }); renderUploads(); }
  function fail(u, reason) { u.state = "failed"; u.reason = reason; u.xhr = null; renderUploads(); if (deps.announce) deps.announce(u.name + ": " + reason); }

  // In AI-instruction mode an uploaded file also becomes a chip for the next instruction (same scope only).
  function autoAttach(u, rec) {
    if (!u.ai || !rec || !rec.id) return;
    var sc = pickScope();
    if (!sc || !sc.canManage || sc.kind !== u.target.kind || sc.id !== (u.target.kind === "channel" ? u.target.channelId : u.target.roomId)) return;
    if (sc.kind === "channel" && sc.sessionId !== u.target.sessionId) return; // switched to another session of the channel meanwhile
    if (isPicked(rec.id)) return;
    if (picked.length >= MAX_PICKED) { deps.toast(t("attachments.maxPicked", { max: MAX_PICKED })); return; }
    addPicked({ id: rec.id, name: rec.name || u.name, size: rec.size || u.size });
    fresh[rec.id] = ++listTick;
    pickedChanged();
  }

  function pump() {
    if (current) return;
    var next = null;
    for (var i = 0; i < uploads.length; i++) if (uploads[i].state === "queued") { next = uploads[i]; break; }
    if (!next) return;
    current = next;
    next.state = "uploading";
    next.percent = 0;
    renderUploads();
    var xhr = deps.newXhr ? deps.newXhr() : new XMLHttpRequest();
    next.xhr = xhr;
    xhr.open("POST", endpoint(next.target));
    xhr.withCredentials = true;
    xhr.setRequestHeader("X-Requested-With", "aigora");
    xhr.upload.onprogress = function (ev) {
      if (ev && ev.lengthComputable) { next.percent = ev.loaded / ev.total * 100; renderUploads(); }
    };
    function done() { current = null; pump(); }
    xhr.onload = function () {
      var body = null;
      try { body = JSON.parse(xhr.responseText || "{}"); } catch (_) { body = null; }
      if (xhr.status >= 200 && xhr.status < 300 && body && body.attachments && body.attachments.length) {
        drop(next);
        if (deps.announce) deps.announce(t("attachments.uploadedNamed", { name: next.name }));
        autoAttach(next, body.attachments[0]);
      } else {
        var code = body && (body.error || (body.rejected && body.rejected[0] && body.rejected[0].code));
        fail(next, reasonFor(code));
      }
      done();
    };
    xhr.onerror = function () { fail(next, t("attachments.uploadOffline")); done(); };
    xhr.onabort = function () { drop(next); done(); };
    var form = new FormData();
    form.append("file", next.file, next.name);
    xhr.send(form);
  }

  function enqueue(files) {
    var t = target();
    if (!t.kind) { deps.toast(t.reason); return false; }
    files.forEach(function (file) {
      var problem = fileProblem(file);
      var u = { id: "u" + (++seq), file: file, name: file.name, size: file.size, state: problem ? "failed" : "queued", percent: 0, reason: problem, target: t, ai: !deps.getMode || deps.getMode() === "ai" };
      uploads.push(u);
      if (problem && deps.toast) deps.toast(file.name + ": " + problem);
    });
    renderUploads();
    pump();
    return true;
  }

  function pick() {
    var t = target();
    if (!t.kind) { deps.toast(t.reason); return false; }
    els.fileInput.click();
    return true;
  }

  // --- Composer hints ---------------------------------------------------------------
  function refresh() {
    renderInbox();
    var priv = privateOwner();
    if (els.hint) { els.hint.textContent = priv ? t("attachments.hintPrivate") : ""; els.hint.classList.toggle("hidden", !priv); }
    if (els.menuHint) els.menuHint.textContent = priv ? t("attachments.menuHintPrivate") : t("attachments.menuHintRoom");
  }
  onLangChange(function () { refresh(); drawPicker(); });

  // --- Card actions ---------------------------------------------------------------
  function itemFor(id) {
    var items = deps.getThread().items;
    for (var i = 0; i < items.length; i++) if (items[i].role === "attachment" && items[i].attachmentId === id) return items[i];
    return null;
  }
  function urlFor(it) { return base() + (it.scope === "channel" ? "channel-attachments/" + encodeURIComponent(it.channelId) : "room-attachments/" + encodeURIComponent(it.roomId)) + "/" + it.attachmentId; }

  function view() {
    var room = deps.getRoom();
    var a = deps.getAccess();
    var me = deps.getMyId();
    return {
      base: base(), preview: previews, now: Date.now(), officeActions: deps.officeActions, officeVersion: deps.officeVersion,
      canDelete: function (it) {
        if (it.scope === "channel") return privateOwner() && it.authorId === me;
        return !!room && room.role !== "viewer" && (it.authorId === me || room.role === "owner");
      },
      canShare: function (it) { return it.scope === "channel" && privateOwner() && it.authorId === me && !(a && a.readOnly); },
      canGive: function (it) { return it.scope === "channel" ? privateOwner() : !!room && room.role !== "viewer"; },
      picked: function (it) { return isPicked(it.attachmentId); }
    };
  }
  function renderCard(it, extra) { return it.role === "airesult" ? resultCardHtml(it) : cardHtml(it, view(), extra); }

  function togglePreview(id) {
    var it = itemFor(id);
    if (!it) return;
    if (previews[id] != null) { delete previews[id]; deps.rerender(); return; }
    var audio = kindOf(it.ext) === "audio" || kindOf(it.ext) === "video"; // an audio card previews its transcript, read through the same authorization
    fetch(audio ? urlFor(it) + "/transcript" : urlFor(it) + "?disposition=inline", { credentials: "same-origin" }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return audio ? res.json().then(function (d) { if (d.status !== "done") throw new Error("none"); return d.text || ""; }) : res.text();
    }).then(function (text) {
      var cap = audio ? TRANSCRIPT_PREVIEW_CHARS : PREVIEW_CHARS;
      previews[id] = text.length > cap ? text.slice(0, cap) + "\n" + t("attachments.previewTruncated") : text;
      deps.rerender();
    }, function () { deps.toast(t("attachments.previewFailed")); });
  }

  function armDelete(btn, id) {
    if (deleteArmed && deleteArmed.id === id) {
      clearTimeout(deleteArmed.timer);
      deleteArmed = null;
      var it = itemFor(id);
      if (!it) return;
      fetch(urlFor(it), { method: "DELETE", credentials: "same-origin", headers: { "X-Requested-With": "aigora" } }).then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        delete previews[id];
        deps.toast(t("attachments.deleted"));
      }, function () { throw new Error("net"); }).catch(function () { deps.toast(t("attachments.deleteFailed")); });
      return;
    }
    if (deleteArmed) { clearTimeout(deleteArmed.timer); deleteArmed.reset(); }
    btn.textContent = t("attachments.confirmDelete");
    btn.classList.add("is-armed");
    deleteArmed = {
      id: id, reset: function () { btn.textContent = t("attachments.delete"); btn.classList.remove("is-armed"); },
      timer: setTimeout(function () { if (deleteArmed && deleteArmed.id === id) { deleteArmed.reset(); deleteArmed = null; } }, 4000),
    };
  }

  // --- Per-instruction files ---------------------------------------------------------
  // `picked` is the selection for the NEXT AI instruction only: chips above the composer, cleared once it is sent.
  // The list (for the picker) comes from attachment metadata, never the sandbox.
  function pickScope() {
    var s = deps.getSession(), room = deps.getRoom(), a = deps.getAccess();
    if (!s) return null;
    if (a && a.isPrivate) return s.channelId ? { kind: "channel", id: s.channelId, sessionId: s.id, canManage: privateOwner(), canOutbox: false } : null;
    if (!room || !deps.isRoomMain()) return null;
    var member = room.role !== "viewer";
    return { kind: "room", id: room.id, canManage: member, canOutbox: member };
  }
  function scopeUrl(sc) { return base() + (sc.kind === "channel" ? "channel-attachments/" : "room-attachments/") + encodeURIComponent(sc.id); }
  function scopeSubUrl(sc, sub) { return base() + (sc.kind === "channel" ? "channel-attachments/" : "room-attachments/") + encodeURIComponent(sc.id) + "/" + sub; }
  function threadSig() {
    return deps.getThread().items.filter(function (i) { return i.role === "attachment"; }).map(function (i) { return i.attachmentId; }).join(",");
  }
  function pickedChanged() { markPicked(); if (deps.onPickedChange) deps.onPickedChange(); }
  function isPicked(id) { return picked.some(function (f) { return f.id === id; }); }
  function addPicked(f) {
    if (isPicked(f.id)) return;
    picked.push({ id: f.id, name: f.name, size: f.size });
  }
  function removePicked(id) { picked = picked.filter(function (f) { return f.id !== id; }); pickedChanged(); }
  function setPicked(list) { picked = list.slice(0, MAX_PICKED); pickedChanged(); }
  function clearPicked() { if (!picked.length) return; picked = []; pickedChanged(); }
  // The card menu entries show 첨부됨 for what is already a chip.
  function markPicked() {
    Array.prototype.forEach.call(els.chat.querySelectorAll("[data-att-ai]"), function (b) {
      var on = isPicked(b.getAttribute("data-att-ai"));
      b.disabled = on;
      b.textContent = on ? t("attachments.attached") : t("attachments.attachToInstruction");
    });
  }
  function isChecked(c) { return c.checked === true || (c.checked === undefined && c.hasAttribute("checked")); }
  function pickState() {
    var sc = pickScope(), selected = {};
    var layer = pickSheet && pickSheet.layer;
    if (layer && layer.querySelector && layer.querySelector("[data-att-pick]")) {
      Array.prototype.forEach.call(layer.querySelectorAll("[data-att-pick]"), function (c) { if (isChecked(c)) selected[c.getAttribute("data-att-pick")] = true; });
    } else picked.forEach(function (f) { selected[f.id] = true; });
    var q = layer && layer.querySelector && layer.querySelector("[data-att-pick-q]");
    return { scope: sc ? sc.kind : "room", files: list.files, selected: selected, query: q ? q.value : "", now: Date.now(), canOutbox: !!(sc && sc.canOutbox), outbox: pickSheet ? pickSheet.outbox : null, hadPicked: pickSheet ? pickSheet.hadPicked : false };
  }
  function drawPicker() {
    var el = els.pickItem;
    var sc = pickScope();
    if (el) {
      var label = el.querySelector("strong");
      el.classList.toggle("hidden", !(sc && sc.canManage));
      if (label) label.textContent = pickEntryText(sc && sc.kind);
    }
    if (pickSheet) {
      var state = pickState();
      var html = pickerSheetHtml(state);
      if (pickSheet.html !== html) {
        var active = document.activeElement, inSearch = !!(active && active.hasAttribute && active.hasAttribute("data-att-pick-q"));
        var had = pickSheet.layer.contains && pickSheet.layer.contains(active);
        pickSheet.html = html;
        pickSheet.layer.innerHTML = html;
        var target = had && (inSearch ? pickSheet.layer.querySelector("[data-att-pick-q]") : pickSheet.layer.querySelector("button"));
        if (target) { target.focus(); if (inSearch && target.setSelectionRange) target.setSelectionRange(target.value.length, target.value.length); }
      }
    }
  }
  function syncList() {
    var sc = pickScope();
    if (!sc) return;
    var key = sc.kind + ":" + sc.id;
    var issued = ++listTick;
    fetch(scopeUrl(sc), { credentials: "same-origin" }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    }).then(function (body) {
      if (list.key !== key) return;
      list.files = (body.attachments || []).map(function (a) { return { id: a.id, name: a.name, size: a.size, authorName: a.authorName, createdAt: a.createdAt }; });
      var ids = {};
      list.files.forEach(function (f) { ids[f.id] = true; });
      var kept = picked.filter(function (f) { return ids[f.id] || fresh[f.id] > issued; });
      Object.keys(fresh).forEach(function (id) { if (fresh[id] <= issued) delete fresh[id]; });
      var pruned = kept.length !== picked.length;
      picked = kept;
      if (pruned) pickedChanged();
      drawPicker();
    }, function () { /* the picker keeps its last known list */ });
  }
  function renderInbox() {
    var sc = pickScope();
    var key = sc ? sc.kind + ":" + sc.id : null;
    if (list.key !== key) {
      list = { key: key, files: [], sig: threadSig() };
      if (pickSheet) closePicker();
      if (picked.length) { picked = []; pickedChanged(); }
      if (sc) syncList();
    } else if (threadSig() !== list.sig) { list.sig = threadSig(); syncList(); }
    drawPicker();
    markPicked();
  }
  function pickFromCard(id) {
    var it = itemFor(id);
    if (!it || isPicked(id)) return;
    if (picked.length >= MAX_PICKED) { deps.toast(t("attachments.maxPicked", { max: MAX_PICKED })); return; }
    addPicked({ id: id, name: it.name, size: it.size });
    pickedChanged();
    deps.toast(t("attachments.attachedToast"));
  }

  function closePicker() {
    if (!pickSheet) return;
    var opener = pickSheet.opener;
    if (pickSheet.layer.parentNode) pickSheet.layer.parentNode.removeChild(pickSheet.layer);
    pickSheet = null;
    if (opener && opener.focus) opener.focus();
  }
  function openPicker(opener) {
    closePicker();
    var layer = document.createElement("div");
    layer.className = "att-sheet-layer";
    pickSheet = { layer: layer, opener: opener, outbox: null, html: "", hadPicked: picked.length > 0 };
    pickSheet.html = pickerSheetHtml(pickState());
    layer.innerHTML = pickSheet.html;
    els.root.appendChild(layer);
    syncList();
    var first = layer.querySelector("input,button");
    if (first) first.focus();
  }
  function applyPicker() {
    if (!pickSheet) return;
    var ids = {};
    Array.prototype.forEach.call(pickSheet.layer.querySelectorAll("[data-att-pick]"), function (c) { if (isChecked(c)) ids[c.getAttribute("data-att-pick")] = true; });
    var next = [];
    list.files.forEach(function (f) { if (ids[f.id]) next.push({ id: f.id, name: f.name, size: f.size }); });
    if (next.length > MAX_PICKED) { sheetError(t("attachments.maxPicked", { max: MAX_PICKED })); return; }
    picked = next;
    closePicker();
    pickedChanged();
  }
  function filterPicker(q) {
    q = String(q || "").trim().toLowerCase();
    Array.prototype.forEach.call(pickSheet.layer.querySelectorAll("[data-pick-name]"), function (row) {
      row.hidden = !!q && row.getAttribute("data-pick-name").indexOf(q) < 0;
    });
    pickSheet.html = null; // the typed query is part of the next render
  }
  function sheetError(text) { var e = pickSheet && pickSheet.layer.querySelector(".att-sheet-error[hidden]"); if (e) { e.textContent = text; e.hidden = false; } }
  function loadOutbox() {
    var sc = pickScope();
    if (!sc || !sc.canOutbox || !pickSheet) return;
    var sheetNow = pickSheet;
    fetch(scopeSubUrl(sc, "outbox"), { credentials: "same-origin" }).then(function (res) {
      return res.json().then(function (b) { return { ok: res.ok, body: b }; }, function () { return { ok: res.ok, body: {} }; });
    }).then(function (r) {
      if (pickSheet !== sheetNow) return;
      sheetNow.outbox = r.ok ? { busy: !!r.body.busy, files: r.body.files || [] } : { error: t("attachments.outboxLoadFailed") };
      drawPicker();
    }, function () { if (pickSheet === sheetNow) { sheetNow.outbox = { error: t("attachments.loadOffline") }; drawPicker(); } });
  }
  function publishOutbox(name) {
    var sc = pickScope();
    if (!sc || !sc.canOutbox || !pickSheet) return;
    fetch(scopeSubUrl(sc, "outbox"), { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Requested-With": "aigora" }, body: JSON.stringify({ name: name }) })
      .then(function (res) { return res.json().then(function (b) { return { ok: res.ok, body: b }; }, function () { return { ok: res.ok, body: {} }; }); })
      .then(function (r) {
        if (r.ok) { deps.toast(t("attachments.outboxPosted")); loadOutbox(); return; }
        sheetError(r.body && r.body.error === "busy" ? t("attachments.aiBusy") : reasonFor(r.body && r.body.error));
      }, function () { sheetError(t("attachments.uploadOfflineDot")); });
  }

  // --- Share sheet -----------------------------------------------------------------
  function checkedRoom(root) {
    var radios = Array.prototype.slice.call(root.querySelectorAll('input[name="att-share-room"]'));
    for (var i = 0; i < radios.length; i++) if (radios[i].checked === true || (radios[i].checked === undefined && radios[i].hasAttribute("checked"))) return radios[i];
    return null;
  }
  function closeSheet() {
    if (!sheet) return;
    var opener = sheet.opener;
    if (sheet.root.parentNode) sheet.root.parentNode.removeChild(sheet.root);
    sheet = null;
    if (opener && opener.focus) opener.focus();
  }
  function openShare(it, opener) {
    closeSheet();
    var rooms = deps.getRooms();
    var cur = deps.getRoom();
    var targets = shareTargets(rooms);
    var selected = cur && targets.some(function (r) { return String(r.id) === String(cur.id); }) ? cur.id : (targets[0] && targets[0].id);
    var root = document.createElement("div");
    root.className = "att-sheet-layer";
    root.innerHTML = shareSheetHtml(it, rooms, selected);
    els.root.appendChild(root);
    sheet = { root: root, opener: opener, id: it.attachmentId };
    var first = checkedRoom(root) || root.querySelector("button");
    if (first) first.focus();
  }
  function sendShare() {
    if (!sheet) return;
    var it = itemFor(sheet.id);
    var picked = checkedRoom(sheet.root);
    var err = sheet.root.querySelector(".att-sheet-error");
    var send = sheet.root.querySelector("[data-att-sheet-send]");
    if (!it || !picked) return;
    send.disabled = true;
    fetch(urlFor(it) + "/share", {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Requested-With": "aigora" },
      body: JSON.stringify({ targetRoomId: picked.getAttribute("value") }),
    }).then(function (res) {
      return res.json().then(function (b) { return { ok: res.ok, status: res.status, body: b }; }, function () { return { ok: res.ok, status: res.status, body: {} }; });
    }).then(function (r) {
      if (r.ok) { closeSheet(); deps.toast(t("attachments.shared")); return; }
      err.textContent = r.body && r.body.error === "quota" ? t("attachments.shareQuota") : r.body && r.body.error === "rate_limited" ? t("attachments.rateLimitedDot") : t("attachments.shareFailed");
      err.hidden = false; send.disabled = false;
    }, function () { err.textContent = t("attachments.shareOffline"); err.hidden = false; send.disabled = false; });
  }

  // --- Events ------------------------------------------------------------------------
  els.fileInput.setAttribute("accept", ACCEPT);
  els.fileInput.addEventListener("change", function () {
    var files = Array.prototype.slice.call(els.fileInput.files || []);
    els.fileInput.value = "";
    if (files.length) enqueue(files);
  });
  if (els.uploads) els.uploads.addEventListener("click", function (ev) {
    var c = ev.target.closest && ev.target.closest("[data-up-cancel]");
    var d = ev.target.closest && ev.target.closest("[data-up-dismiss]");
    var u = find((c && c.getAttribute("data-up-cancel")) || (d && d.getAttribute("data-up-dismiss")));
    if (!u) return;
    if (c && u.xhr) u.xhr.abort(); else drop(u);
  });
  els.chat.addEventListener("click", function (ev) {
    var t = ev.target;
    var btn = t && t.closest && t.closest("[data-att-preview],[data-att-ai],[data-att-delete],[data-att-share]");
    if (!btn) return;
    if (btn.hasAttribute("data-att-preview")) togglePreview(btn.getAttribute("data-att-preview"));
    else if (btn.hasAttribute("data-att-ai")) pickFromCard(btn.getAttribute("data-att-ai"));
    else if (btn.hasAttribute("data-att-delete")) armDelete(btn, btn.getAttribute("data-att-delete"));
    else if (btn.hasAttribute("data-att-share")) { var it = itemFor(btn.getAttribute("data-att-share")); if (it) openShare(it, btn); }
  });
  // The card's 더 보기 menu: opens on its button, closes on Escape, outside click, the scrim (phone sheet) and after most actions.
  function setMenu(wrap, on, refocus) {
    var menu = wrap.querySelector(".att-menu"), more = wrap.querySelector(".att-more");
    wrap.classList.toggle("is-open", on);
    menu.hidden = !on;
    more.setAttribute("aria-expanded", on ? "true" : "false");
    if (on) { var first = menu.querySelector(".att-menu-item"); if (first && first.focus) first.focus(); }
    else if (refocus && more.focus) more.focus();
  }
  function closeMenus(refocus) {
    Array.prototype.forEach.call(els.chat.querySelectorAll(".att-more-wrap.is-open"), function (w) { setMenu(w, false, refocus); });
  }
  els.chat.addEventListener("click", function (ev) {
    var t = ev.target, more = t && t.closest && t.closest("[data-att-more]");
    if (more) {
      var wrap = more.closest(".att-more-wrap"), was = wrap.classList.contains("is-open");
      closeMenus(false);
      if (!was) setMenu(wrap, true);
      return;
    }
    if (t && t.closest && t.closest("[data-att-more-close]")) { closeMenus(true); return; }
    var item = t && t.closest && t.closest(".att-menu-item");
    if (item && !item.hasAttribute("data-att-delete")) closeMenus(false);
  });
  els.root.addEventListener("click", function (ev) {
    if (!(ev.target && ev.target.closest && ev.target.closest(".att-more-wrap"))) closeMenus(false);
  });
  els.chat.addEventListener("keydown", function (ev) {
    var wrap = ev.target && ev.target.closest && ev.target.closest(".att-more-wrap.is-open");
    if (!wrap) return;
    if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); setMenu(wrap, false, true); return; }
    if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
    var items = Array.prototype.slice.call(wrap.querySelectorAll(".att-menu-item"));
    var at = items.indexOf(document.activeElement);
    var next = ev.key === "ArrowDown" ? (at + 1) % items.length : (at <= 0 ? items.length - 1 : at - 1);
    ev.preventDefault();
    if (items[next]) items[next].focus();
  });
  els.root.addEventListener("click", function (ev) {
    if (!pickSheet || !ev.target.closest) return;
    var pub = ev.target.closest("[data-ai-outbox-publish]");
    if (ev.target.closest("[data-att-sheet-close]")) closePicker();
    else if (ev.target.closest("[data-att-pick-apply]")) applyPicker();
    else if (ev.target.closest("[data-ai-outbox-load]")) loadOutbox();
    else if (pub) publishOutbox(pub.getAttribute("data-ai-outbox-publish"));
  });
  els.root.addEventListener("change", function (ev) {
    if (!pickSheet || !ev.target || !ev.target.hasAttribute || !ev.target.hasAttribute("data-att-pick")) return;
    var n = 0;
    Array.prototype.forEach.call(pickSheet.layer.querySelectorAll("[data-att-pick]"), function (c) { if (isChecked(c)) n++; });
    var b = pickSheet.layer.querySelector("[data-att-pick-apply]");
    if (b) { b.textContent = n ? t("attachments.attachCount", { count: n }) : t("attachments.attach"); b.disabled = n === 0 && !pickSheet.hadPicked; }
    pickSheet.html = null;
  });
  els.root.addEventListener("input", function (ev) {
    if (pickSheet && ev.target && ev.target.hasAttribute && ev.target.hasAttribute("data-att-pick-q")) filterPicker(ev.target.value);
  });
  els.root.addEventListener("click", function (ev) {
    if (!sheet) return;
    if (ev.target.closest && ev.target.closest("[data-att-sheet-close]")) closeSheet();
    else if (ev.target.closest && ev.target.closest("[data-att-sheet-send]")) sendShare();
  });
  els.root.addEventListener("keydown", function (ev) { if (sheet && ev.key === "Escape") closeSheet(); else if (pickSheet && ev.key === "Escape") closePicker(); });
  (els.dropZones || []).forEach(function (zone) {
    function hasFiles(ev) { var types = ev.dataTransfer && ev.dataTransfer.types; return !!types && Array.prototype.indexOf.call(types, "Files") >= 0; }
    zone.addEventListener("dragover", function (ev) { if (hasFiles(ev)) { ev.preventDefault(); zone.classList.add("is-drop"); } });
    zone.addEventListener("dragleave", function () { zone.classList.remove("is-drop"); });
    zone.addEventListener("drop", function (ev) {
      zone.classList.remove("is-drop");
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      var files = Array.prototype.slice.call(ev.dataTransfer.files || []);
      if (files.length) enqueue(files);
    });
  });
  refresh();

  return { pick: pick, pickFromCard: pickFromCard, openPicker: openPicker, picked: function () { return picked.slice(); }, removePicked: removePicked, setPicked: setPicked, clearPicked: clearPicked, refresh: refresh, renderInbox: renderInbox, cardHtml: renderCard, enqueue: enqueue, target: target, uploads: function () { return uploads.slice(); } };
}

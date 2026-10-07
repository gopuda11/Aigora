// room-admin.js - Owner-only room management for the standalone Aigora page,
// grouped into Room, Server, AI & routing and Transcription & video in the settings modal
// (settings.js): create rooms, issue/copy/revoke invitations, change member
// roles and remove members, restore or permanently delete archived rooms.
// Presentation only - the server re-checks the owner on every call, and nothing
// here runs (or fetches) unless setOwner(true) was called.
//
//   initRoomAdmin({ settings, confirm: openDialog(opts), getSelfId(), getRoom, getRooms, onRoomsChanged, toast, copy })
//     -> { openInvite(trigger), setOwner(isOwner, isAdmin), syncRooms() }
//     settings                the settings modal API (settings.js)
//     isAdmin (global admin) gates the archived-rooms section and its admin-only API call
//     getRoom()               current (selected) room { id, name, memberCount } or null
//     getRooms()              every live room the viewer can manage
//     onRoomsChanged(selectId) refresh the room list (and select selectId); returns a Promise
//     copy(text)              copy to the clipboard

import * as api from "./room-admin-api.js";

import { t, formatDate, formatBytes } from "./i18n.js";
var ROLE_LABELS = { get owner() { return t("roomAdmin.roleOwner"); }, get member() { return t("roomAdmin.roleMember"); }, get viewer() { return t("roomAdmin.roleViewer"); } };
var ARM_MS = 4000;

function h(tag, attrs, text) {
  var node = document.createElement(tag);
  Object.keys(attrs || {}).forEach(function (k) { node.setAttribute(k, attrs[k]); });
  if (text != null) node.textContent = text;
  return node;
}

function shortDate(ms) { var d = new Date(ms); return (d.getMonth() + 1) + "/" + d.getDate(); }

function inviteStatus(inv) {
  if (inv.revokedAt) return t("roomAdmin.inviteRevoked");
  if (inv.used) return t("roomAdmin.inviteUsed") + (inv.redeemedByName ? " · " + inv.redeemedByName + (inv.usedAt ? " · " + shortDate(inv.usedAt) : "") : " · " + t("roomAdmin.inviteNoRecord"));
  if (inv.expiresAt && inv.expiresAt < Date.now()) return t("roomAdmin.inviteExpired");
  return t("roomAdmin.inviteUsable");
}

export function initRoomAdmin(opts) {
  var $ = function (id) { return document.getElementById(id); };
  var settings = opts.settings;
  var els = {
    tools: $("ai-room-tools"), create: $("ai-room-create"), mobile: $("ai-room-manage-mobile"), sheetCreate: $("ai-room-create-sheet"),
    picker: $("ai-admin-room-picker"), summary: $("ai-admin-room-summary"),
    form: $("ai-admin-room-form"), name: $("ai-admin-room-name"), desc: $("ai-admin-room-desc"),
    inviteCreate: $("ai-admin-invite-create"), once: $("ai-admin-invite-once"),
    onceUrl: $("ai-admin-invite-url"), onceCopy: $("ai-admin-invite-copy"),
    snapOpen: $("ai-admin-snap-open"), invites: $("ai-admin-invites"), members: $("ai-admin-members"), archived: $("ai-admin-archived"), archivedSection: $("ai-admin-archived-section"), status: $("ai-admin-status"),
    skills: $("ai-admin-skills"), skillsOpen: $("ai-admin-skills-open"),
    skillManagersRow: $("ai-admin-skill-managers-row"), skillManagers: $("ai-admin-skill-managers"),
    approval: $("ai-admin-approval"), approvalHead: $("ai-admin-h-approval"), approvalForm: $("ai-admin-approval-form"),
    approvalRequester: $("ai-approval-requester"), approvalPatterns: $("ai-approval-patterns"),
    clef: $("ai-admin-clef"), clefOn: $("ai-clef-on"), clefAuto: $("ai-clef-auto"), clefAbstain: $("ai-clef-abstain"), clefStore: $("ai-clef-store"), clefForm: $("ai-clef-form"), clefAccount: $("ai-clef-account"), clefToken: $("ai-clef-token"), clefClear: $("ai-clef-clear"),
    decisionBackend: $("ai-decision-backend"), jevKey: $("ai-jev-key"),
    lm: $("ai-admin-localmodel"), lmList: $("ai-lm-list"), lmForm: $("ai-lm-form"), lmLabel: $("ai-lm-label"), lmUrl: $("ai-lm-url"), lmKey: $("ai-lm-key"), lmTitle: $("ai-lm-title"), lmVer: $("ai-lm-verifiers"), lmVMode: $("ai-lm-vmode"), lmResearch: $("ai-lm-research"),
  };
  var state = { owner: false, admin: false, roomId: null, seq: 0, url: "" };

  function status(text) { els.status.setAttribute("role", "status"); els.status.textContent = text || ""; }
  function fail(err) { els.status.setAttribute("role", "alert"); els.status.textContent = api.errorText(err) || ""; }
  function empty(list, text) {
    list.textContent = "";
    list.appendChild(h("li", { class: "ai-admin-empty" }, text));
    return Promise.resolve();
  }

  // The managed room is the picker's choice; it starts as the selected room (or the
  // first one) and stays put while the room list refreshes underneath it.
  function renderSummary() {
    var rooms = opts.getRooms() || [];
    var room = null;
    rooms.forEach(function (r) { if (state.roomId != null && String(r.id) === String(state.roomId)) room = r; });
    if (!room) {
      var current = opts.getRoom();
      rooms.forEach(function (r) { if (!room && current && String(r.id) === String(current.id)) room = r; });
      room = room || rooms[0] || null;
    }
    state.roomId = room ? room.id : null;
    els.picker.textContent = "";
    rooms.forEach(function (r) { els.picker.appendChild(h("option", { value: String(r.id) }, r.name)); });
    if (room) els.picker.value = String(room.id);
    els.picker.disabled = !rooms.length;
    els.summary.textContent = room ? t("roomAdmin.summary", { name: room.name, count: room.memberCount }) : t("roomAdmin.noRooms");
    var serverScope = $("ai-admin-server-scope");
    if (serverScope) serverScope.textContent = room ? t("roomAdmin.approvalFor", { name: room.name }) : t("roomAdmin.pickRoomFirst");
    els.inviteCreate.disabled = !room;
  }

  // --- Members ---------------------------------------------------------------------

  function renderMembers(members) {
    els.members.textContent = "";
    members.forEach(function (m) {
      var li = h("li", { class: "ai-admin-row ai-lm-card" });
      li.appendChild(h("span", { class: "ai-lm-head" }, m.displayName || m.username));
      if (m.role === "owner") {
        li.appendChild(h("span", { class: "ai-admin-tag" }, ROLE_LABELS.owner));
      } else {
        var select = h("select", { "data-member-role": m.id, "aria-label": t("roomAdmin.permissionOf", { name: m.displayName || m.username }) });
        ["member", "viewer"].forEach(function (role) { select.appendChild(h("option", { value: role }, ROLE_LABELS[role])); });
        select.value = m.role === "viewer" ? "viewer" : "member";
        select.addEventListener("change", function () { changeRole(m.id, select.value); });
        li.appendChild(select);
        li.appendChild(removeButton(m));
      }
      // Global admins can end another user's sessions everywhere; the server re-checks the role and refuses self.
      if (state.admin && String(m.id) !== String(opts.getSelfId ? opts.getSelfId() : "")) li.appendChild(forceLogoutButton(m));
      els.members.appendChild(li);
    });
  }

  function forceLogoutButton(m) {
    var name = m.displayName || m.username;
    var btn = h("button", { type: "button", class: "ai-admin-danger", "data-force-logout": m.id, "aria-label": t("roomAdmin.forceLogoutOf", { name: name }) }, t("roomAdmin.forceLogout"));
    btn.addEventListener("click", function () {
      opts.confirm({
        title: t("roomAdmin.forceLogoutTitle", { name: name }), text: t("roomAdmin.forceLogoutText"),
        confirmLabel: t("roomAdmin.forceLogout"), cancelLabel: t("roomAdmin.cancel"),
        restore: function () { if (btn.focus) btn.focus(); },
        onConfirm: function () {
          return api.forceLogout(m.id).then(function () { status(t("roomAdmin.forceLogoutDone", { name: name })); return true; }, function () { return t("roomAdmin.forceLogoutFailed"); });
        },
      });
    });
    return btn;
  }

  function removeButton(m) {
    var btn = h("button", { type: "button", class: "ai-admin-danger", "data-remove-member": m.id }, t("roomAdmin.remove"));
    var timer = null;
    btn.addEventListener("click", function () {
      if (btn.getAttribute("data-armed") !== "1") {
        btn.setAttribute("data-armed", "1");
        btn.textContent = t("roomAdmin.removeConfirm");
        timer = setTimeout(function () { btn.removeAttribute("data-armed"); btn.textContent = t("roomAdmin.remove"); }, ARM_MS);
        if (timer && typeof timer.unref === "function") timer.unref();
        return;
      }
      clearTimeout(timer);
      var roomId = state.roomId;
      api.removeMember(roomId, m.id).then(function () {
        status(t("roomAdmin.accessRemoved"));
        return Promise.all([loadMembers(), opts.onRoomsChanged()]).then(renderSummary);
      }, fail);
    });
    return btn;
  }

  function loadMembers() {
    var seq = state.seq, roomId = state.roomId;
    if (!roomId) return empty(els.members, t("roomAdmin.pickRoomFirst"));
    return api.listMembers(roomId).then(function (data) {
      if (seq === state.seq) renderMembers(data.members || []);
    }, fail);
  }

  function changeRole(userId, role) {
    api.setMemberRole(state.roomId, userId, role).then(function () {
      status(t("roomAdmin.roleChanged"));
      return loadMembers();
    }, function (err) {
      return loadMembers().then(function () { fail(err); });
    });
  }

  // --- Invites ---------------------------------------------------------------------

  function renderInvites(all) {
    var mine = all.filter(function (inv) { return inv.roomId === state.roomId; })
      .sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    if (!mine.length) return empty(els.invites, t("roomAdmin.noInvites"));
    els.invites.textContent = "";
    mine.forEach(function (inv) {
      var st = inviteStatus(inv);
      var li = h("li", { class: "ai-admin-row ai-invite-row", "data-invite-state": inv.revokedAt ? "revoked" : inv.used ? "used" : st === t("roomAdmin.inviteUsable") ? "usable" : "expired" });
      li.appendChild(h("span", { class: "ai-invite-code" }, (inv.codePrefix || "····") + "…"));
      li.appendChild(h("span", { class: "ai-admin-tag" }, st));
      // One control per row: a usable invite can be cancelled; a finished one (used, cancelled, expired) can be removed from the list.
      if (st === t("roomAdmin.inviteUsable") && inv.id) {
        var btn = h("button", { type: "button", class: "ai-admin-danger", "data-revoke-invite": inv.id }, t("roomAdmin.cancel"));
        btn.addEventListener("click", function () {
          api.revokeInvite(inv.id).then(function () { status(t("roomAdmin.inviteRevokedStatus")); return loadInvites(); }, fail);
        });
        li.appendChild(btn);
      }
      else if (inv.id) li.appendChild(deleteInviteButton(inv, false));
      els.invites.appendChild(li);
    });
  }

  function deleteInviteButton(inv, live) {
    var btn = h("button", { type: "button", class: "ai-admin-danger ai-admin-x", "data-delete-invite": inv.id, "aria-label": t("roomAdmin.deleteInvite"), title: t("roomAdmin.deleteInvite") }, "×");
    function run(done) {
      api.deleteInvite(inv.id).then(function () { if (done) done(); status(t("roomAdmin.inviteDeleted")); return loadInvites(); }, function (e) { if (done) done(); fail(e); });
    }
    btn.addEventListener("click", function () {
      if (!live) { run(); return; }
      var c = sheet(t("roomAdmin.deleteInviteTitle"));
      c.box.appendChild(h("p", { class: "att-sheet-note" }, t("roomAdmin.deleteInviteNote")));
      var actions = h("div", { class: "att-sheet-actions" });
      actions.appendChild(sheetButton(t("roomAdmin.cancel"), "", function () { c.layer.remove(); }));
      actions.appendChild(sheetButton(t("roomAdmin.delete"), "is-primary", function () { run(function () { c.layer.remove(); }); }));
      c.box.appendChild(actions);
    });
    return btn;
  }

  function loadInvites() {
    var seq = state.seq;
    if (!state.roomId) return empty(els.invites, t("roomAdmin.pickRoomFirst"));
    return api.listInvites().then(function (data) {
      if (seq === state.seq) renderInvites(data.invites || []);
    }, fail);
  }

  function hideOnce() {
    state.url = "";
    els.onceUrl.textContent = "";
    els.once.classList.add("hidden");
  }

  function issueInvite() {
    if (!state.roomId) return;
    api.createInvite(state.roomId).then(function (data) {
      state.url = data.url || "";
      els.onceUrl.textContent = state.url;
      els.once.classList.remove("hidden");
      status("");
      return loadInvites();
    }, fail);
  }

  // --- Archived rooms --------------------------------------------------------------

  function renderArchived(list) {
    if (!list.length) return empty(els.archived, t("roomAdmin.noArchived"));
    els.archived.textContent = "";
    list.forEach(function (r) {
      var li = h("li", { class: "ai-admin-row ai-lm-card" });
      li.appendChild(h("span", { class: "ai-lm-head" }, r.name));
      li.appendChild(h("span", { class: "ai-admin-tag" }, t("roomAdmin.archived")));
      var restore = h("button", { type: "button", "data-restore-room": r.id }, t("roomAdmin.restore"));
      restore.addEventListener("click", function () {
        api.restoreRoom(r.id).then(function () {
          status(t("roomAdmin.roomRestored"));
          return Promise.all([loadArchived(), opts.onRoomsChanged()]).then(renderSummary);
        }, fail);
      });
      li.appendChild(restore);
      var del = h("button", { type: "button", class: "ai-admin-danger", "data-delete-room": r.id }, t("roomAdmin.deleteForever"));
      del.addEventListener("click", function () { confirmDelete(li, r); });
      li.appendChild(del);
      els.archived.appendChild(li);
    });
  }

  // Permanent deletion is irreversible: the room name must be typed exactly.
  function confirmDelete(row, r) {
    if (row.nextSibling && row.nextSibling.getAttribute("data-delete-form") === r.id) return;
    var form = h("form", { class: "ai-admin-form", "data-delete-form": r.id });
    var input = h("input", { class: "ai-field", type: "text", placeholder: t("roomAdmin.typeName"), "aria-label": t("roomAdmin.deleteForeverAria", { name: r.name }), autocomplete: "off" });
    var submit = h("button", { type: "submit", class: "ai-admin-danger" }, t("roomAdmin.deleteForeverConfirm"));
    submit.disabled = true;
    input.addEventListener("input", function () { submit.disabled = input.value !== r.name; });
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (input.value !== r.name) return;
      api.deleteRoomPermanently(r.id, input.value).then(function () {
        status(t("roomAdmin.roomDeleted"));
        return Promise.all([loadArchived(), opts.onRoomsChanged()]).then(renderSummary);
      }, fail);
    });
    var label = h("label", { class: "ai-tr-field" });
    label.appendChild(h("span", { class: "ai-tr-label" }, t("roomAdmin.typeName")));
    label.appendChild(input);
    form.appendChild(label);
    form.appendChild(submit);
    row.parentNode.insertBefore(form, row.nextSibling);
    input.focus();
  }

  function loadArchived() {
    var seq = state.seq;
    return api.listArchivedRooms().then(function (data) {
      if (seq === state.seq) renderArchived(data.rooms || []);
    }, fail);
  }

  // --- Workspace backups (작업 폴더 되돌리기) -------------------------------------------

  function sizeText(n) { return n < 1024 * 1024 ? Math.max(1, Math.round(n / 1024)) + " KB" : formatBytes(n); }
  function timeText(ms) { return formatDate(ms, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }); }

  // A centred dialog on desktop, a bottom sheet on phones (aigora-attachments.css .att-sheet-layer).
  function sheet(title) {
    var layer = h("div", { class: "att-sheet-layer", role: "dialog", "aria-modal": "true", "aria-label": title });
    var scrim = h("div", { class: "att-sheet-scrim" });
    var box = h("div", { class: "att-sheet" });
    box.appendChild(h("h2", {}, title));
    layer.appendChild(scrim);
    layer.appendChild(box);
    document.body.appendChild(layer);
    scrim.addEventListener("click", function () { layer.remove(); });
    return { layer: layer, box: box };
  }
  function sheetButton(label, cls, onClick) {
    var b = h("button", { type: "button", class: "att-btn " + cls }, label);
    b.addEventListener("click", onClick);
    return b;
  }

  function confirmRestore(list, s) {
    var c = sheet(t("roomAdmin.restoreTitle"));
    c.box.appendChild(h("p", { class: "att-sheet-note" }, t("roomAdmin.restoreNote", { time: timeText(s.time) })));
    var err = h("p", { class: "att-sheet-error", hidden: "" });
    c.box.appendChild(err);
    var actions = h("div", { class: "att-sheet-actions" });
    actions.appendChild(sheetButton(t("roomAdmin.cancel"), "", function () { c.layer.remove(); }));
    var go = sheetButton(t("roomAdmin.restoreAction"), "is-primary", function () {
      go.disabled = true;
      api.restoreSnapshot(state.roomId, s.id).then(function () {
        c.layer.remove();
        list.layer.remove();
        status(t("roomAdmin.folderRestored"));
        if (opts.toast) opts.toast(t("roomAdmin.folderRestoredToast"));
      }, function (e) { go.disabled = false; err.textContent = api.errorText(e); err.hidden = false; });
    });
    actions.appendChild(go);
    c.box.appendChild(actions);
  }

  function openSnapshots() {
    if (!state.roomId) { status(t("roomAdmin.pickRoomFirst")); return; }
    var list = sheet(t("roomAdmin.snapshotsTitle"));
    var ul = h("ul", { class: "ai-admin-list snap-list" });
    list.box.appendChild(ul);
    ul.appendChild(h("li", { class: "ai-admin-empty" }, t("roomAdmin.loading")));
    list.box.appendChild(sheetButton(t("roomAdmin.close"), "", function () { list.layer.remove(); }));
    api.listSnapshots(state.roomId).then(function (data) {
      var items = data.snapshots || [];
      ul.textContent = "";
      if (!items.length) { ul.appendChild(h("li", { class: "ai-admin-empty" }, t("roomAdmin.noSnapshots"))); return; }
      items.forEach(function (s) {
        var li = h("li", { class: "snap-row" });
        var info = h("div", { class: "snap-info" });
        info.appendChild(h("strong", {}, timeText(s.time) + (s.actorName ? " · " + s.actorName : "")));
        info.appendChild(h("small", {}, s.preview || t("roomAdmin.noPrompt")));
        info.appendChild(h("small", {}, t("roomAdmin.snapMeta", { size: sizeText(s.bytes || 0), count: s.files || 0 })));
        li.appendChild(info);
        var b = h("button", { type: "button", "data-snapshot-restore": s.id }, t("roomAdmin.restoreHere"));
        b.addEventListener("click", function () { confirmRestore(list, s); });
        li.appendChild(b);
        ul.appendChild(li);
      });
    }, function (e) { ul.textContent = ""; ul.appendChild(h("li", { class: "ai-admin-empty" }, api.errorText(e))); });
  }

  // --- AI approval level (admin only) -------------------------------------------------

  function loadApproval() {
    if (!state.admin || !state.roomId) return Promise.resolve();
    var seq = state.seq;
    return api.getApproval(state.roomId).then(function (data) {
      if (seq !== state.seq) return;
      var a = data.approval || {};
      Array.prototype.forEach.call(els.approvalForm.querySelectorAll('input[name="ai-approval-level"]'), function (r) { r.checked = r.value === (a.level || "risky"); });
      els.approvalRequester.checked = !!a.requesterCanApprove;
      els.approvalPatterns.value = (a.askPatterns || []).join("\n");
    }, fail);
  }

  function saveApproval(ev) {
    ev.preventDefault();
    var picked = els.approvalForm.querySelector('input[name="ai-approval-level"]:checked');
    if (!state.roomId || !picked) return;
    api.setApproval(state.roomId, {
      level: picked.value, requesterCanApprove: els.approvalRequester.checked,
      askPatterns: els.approvalPatterns.value.split("\n"),
    }).then(function (data) {
      els.approvalPatterns.value = ((data.approval || {}).askPatterns || []).join("\n");
      status(t("roomAdmin.approvalSaved"));
    }, fail);
  }

  // --- Rooms -----------------------------------------------------------------------

  function submitRoom(ev) {
    ev.preventDefault();
    var name = els.name.value.trim();
    if (!name) { status(t("roomAdmin.nameRequired")); return; }
    api.createRoom(name, els.desc.value.trim()).then(function (data) {
      els.name.value = "";
      els.desc.value = "";
      hideOnce();
      status(t("roomAdmin.roomCreated"));
      state.roomId = data.room ? data.room.id : state.roomId;
      return opts.onRoomsChanged(data.room && data.room.id).then(function () { refresh(); settings.close(); });
    }, fail);
  }

  // --- Settings sections -------------------------------------------------------------

  function refresh() {
    state.seq++;
    hideOnce();
    renderSummary();
    loadMembers();
    loadInvites();
    loadApproval();
    loadSkillManagers();
    els.skills.classList.toggle("hidden", !(state.owner && opts.skillsOn && opts.skillsOn()));
  }

  // --- Who may manage skills (admin only) ---------------------------------------------
  function loadSkillManagers() {
    els.skillManagersRow.classList.toggle("hidden", !state.admin);
    if (!state.admin || !state.roomId) return;
    var seq = state.seq, roomId = state.roomId;
    api.getSkillManagers(roomId).then(function (data) {
      if (seq === state.seq && data && data.skillManagers) els.skillManagers.value = data.skillManagers;
    }).catch(function () {});
  }
  function saveSkillManagers() {
    var roomId = state.roomId, want = els.skillManagers.value;
    api.setSkillManagers(roomId, want).then(function (data) {
      if (data && data.skillManagers) els.skillManagers.value = data.skillManagers;
      opts.toast && opts.toast(t("roomAdmin.skillManagersChanged"));
    }).catch(function () { opts.toast && opts.toast(t("roomAdmin.changeFailed")); loadSkillManagers(); });
  }

  // --- Semantic routing (Clef), admin only. Token and account id are write-only: the server returns flags only. ---
  var clefAbstainShown = 0.55;
  function showClef(c) {
    c = c || {};
    els.clefOn.setAttribute("aria-checked", c.configured && c.enabled !== false ? "true" : "false");
    els.clefAuto.setAttribute("aria-checked", c.autoSelect === true ? "true" : "false");
    els.clefStore.setAttribute("aria-checked", c.storeText === true ? "true" : "false");
    clefAbstainShown = typeof c.abstainMin === "number" ? c.abstainMin : 0.4;
    els.clefAbstain.value = String(clefAbstainShown);
    els.clefAccount.value = "";
    els.clefToken.value = "";
    els.decisionBackend.value = c.backend || "clef";
    els.jevKey.value = "";
    els.jevKey.placeholder = c.hasJevKey ? t("roomAdmin.clefSet") : t("roomAdmin.jevKey");
    els.clefAccount.placeholder = c.hasAccountId ? t("roomAdmin.clefSet") : t("roomAdmin.clefAccountId");
    els.clefToken.placeholder = c.hasToken ? t("roomAdmin.clefSet") : t("roomAdmin.clefToken");
  }
  function loadClef() {
    els.clef.classList.toggle("hidden", !state.admin);
    if (state.admin) api.getClef().then(function (d) { showClef(d.clef); }).catch(function () {});
  }
  function saveClef(body, doneKey) {
    api.saveClef(body).then(function (d) { showClef(d.clef); opts.toast && opts.toast(t(doneKey)); }, fail);
  }

  // --- Extra local model servers + session title model, admin only. API keys are write-only: the server returns flags only. ---
  var lmView = { endpoints: [], titleModel: "", models: [], verifiers: [], verifyMode: "single", researchModel: "" };
  function showLocalModel(v) {
    lmView = v || lmView;
    els.lmList.textContent = "";
    lmView.endpoints.forEach(function (e) {
      var li = h("li", { class: "ai-admin-row ai-lm-card" });
      li.appendChild(h("span", { class: "ai-lm-head" }, e.label + " · " + e.baseUrl + (e.hasKey ? " · " + t("roomAdmin.lmKeySet") : "")));
      function saveEp(patch) {
        saveLocalModel({ endpoints: lmView.endpoints.map(function (x) { return epBody(x, x.id === e.id ? patch : null); }) }, "roomAdmin.lmSaved");
      }
      function check(attr, key, text, checked) {
        var lb = h("label", { class: "ai-lm-line is-check" }, "");
        var cb = h("input", { type: "checkbox" });
        cb.setAttribute(attr, e.id);
        cb.checked = checked;
        cb.addEventListener("change", function () { var p = {}; p[key] = cb.checked; saveEp(p); });
        lb.appendChild(cb); lb.appendChild(h("span", {}, t(text)));
        li.appendChild(lb);
      }
      function field(label, node) {
        if (!node.getAttribute("aria-label")) node.setAttribute("aria-label", label);   // the visible label is a sibling, not a <label>
        var row = h("div", { class: "ai-lm-line" });
        row.appendChild(h("div", { class: "ai-lm-label" }, label));
        row.appendChild(node);
        li.appendChild(row);
      }
      function secs(attr, key, ms) {
        var inp = h("input", { type: "number", class: "ai-field", min: "1", max: "3600", step: "1" });
        inp.setAttribute(attr, e.id);
        inp.value = ms ? String(Math.round(ms / 1000)) : "";
        inp.addEventListener("change", function () {
          var v = parseInt(inp.value, 10), p = {};
          p[key] = v >= 1 && v <= 3600 ? v * 1000 : null;
          saveEp(p);
        });
        return inp;
      }
      check("data-lm-routable", "routable", "roomAdmin.lmRoutable", e.routable === true);
      check("data-lm-pickable", "pickable", "roomAdmin.lmPickable", e.pickable !== false);
      var pm = h("select", { class: "ai-set-select" });
      pm.setAttribute("data-lm-pickmodel", e.id);
      var pms = lmView.models.map(function (m) { return m.value; }).filter(function (v) { return v.indexOf(e.id + "/") === 0; }).map(function (v) { return v.slice(e.id.length + 1); });
      if (e.pickModel && pms.indexOf(e.pickModel) === -1) pms.push(e.pickModel);
      pm.appendChild(h("option", { value: "" }, t("roomAdmin.lmPickModelDefault")));
      pms.forEach(function (n) { pm.appendChild(h("option", { value: n }, n)); });
      pm.value = e.pickModel || "";
      pm.addEventListener("change", function () { saveEp({ pickModel: pm.value }); });
      field(t("roomAdmin.lmPickModel"), pm);
      var al = h("input", { type: "text", class: "ai-field", maxlength: "160", autocomplete: "off", spellcheck: "false", placeholder: t("roomAdmin.lmAliasesHint") });
      al.setAttribute("data-lm-aliases", e.id);
      al.value = (e.aliases || []).join(", ");
      al.addEventListener("change", function () {
        var list = al.value.split(/[,\s]+/).map(function (a) { return a.trim().toLowerCase(); }).filter(Boolean);
        if (list.length > 6 || list.some(function (a) { return !/^[a-z0-9ㄱ-힣-]{2,20}$/.test(a); })) { al.value = (e.aliases || []).join(", "); opts.toast && opts.toast(t("roomAdmin.lmAliasesBad")); return; }
        saveEp({ aliases: list });
      });
      field(t("roomAdmin.lmAliases"), al);
      check("data-lm-private", "privateAllowed", "roomAdmin.lmPrivateAllowed", e.privateAllowed === true);
      check("data-lm-canwork", "canWork", "roomAdmin.lmCanWork", e.canWork === true);
      li.appendChild(h("small", { class: "ai-set-note ai-lm-warn" }, t("roomAdmin.lmCanWorkWarn")));
      var wr = h("input", { type: "number", class: "ai-field", min: "1", max: "12", step: "1" });
      wr.setAttribute("data-lm-rounds", e.id);
      wr.value = String(e.workRounds || 6);
      wr.addEventListener("change", function () {
        var v = parseInt(wr.value, 10);
        if (!(v >= 1 && v <= 12)) { wr.value = String(e.workRounds || 6); return; }
        saveEp({ workRounds: v });
      });
      field(t("roomAdmin.lmWorkRounds"), wr);
      field(t("roomAdmin.lmIdleSecs"), secs("data-lm-idle", "idleTimeoutMs", e.idleTimeoutMs));
      field(t("roomAdmin.lmTimeoutSecs"), secs("data-lm-timeout", "timeoutMs", e.timeoutMs));
      var rm = h("button", { type: "button", class: "ai-lm-remove", "data-lm-remove": e.id }, t("roomAdmin.remove"));
      rm.addEventListener("click", function () { saveLocalModel({ endpoints: keepEndpoints(e.id) }, "roomAdmin.lmSaved"); });
      li.appendChild(rm);
      els.lmList.appendChild(li);
    });
    els.lmTitle.textContent = "";
    els.lmTitle.appendChild(h("option", { value: "" }, t("roomAdmin.lmTitleDefault")));
    var seen = {};
    lmView.models.forEach(function (m) { seen[m.value] = true; els.lmTitle.appendChild(h("option", { value: m.value }, m.label)); });
    if (lmView.titleModel && !seen[lmView.titleModel]) els.lmTitle.appendChild(h("option", { value: lmView.titleModel }, lmView.titleModel));
    els.lmTitle.value = lmView.titleModel || "";
    // Verifier choices: the models of the extra endpoints only (never the primary local server).
    var epIds = {};
    lmView.endpoints.forEach(function (e) { epIds[e.id] = true; });
    var vModels = lmView.models.filter(function (m) { var i = m.value.indexOf("/"); return i > 0 && epIds[m.value.slice(0, i)]; });
    (lmView.verifiers || []).forEach(function (v) { if (!vModels.some(function (m) { return m.value === v; })) vModels.push({ value: v, label: v }); });
    els.lmVer.textContent = "";
    if (!vModels.length) els.lmVer.appendChild(h("li", { class: "ai-admin-row" }, t("roomAdmin.lmNoModels")));
    vModels.forEach(function (m) {
      var li = h("li", { class: "ai-admin-row" });
      var lb = h("label", {});
      var cb = h("input", { type: "checkbox", "data-lm-verifier": m.value });
      cb.checked = (lmView.verifiers || []).indexOf(m.value) !== -1;
      cb.addEventListener("change", function () {
        var next = (lmView.verifiers || []).filter(function (x) { return x !== m.value; });
        if (cb.checked) next.push(m.value);
        saveLocalModel({ verifiers: next }, "roomAdmin.lmSaved");
      });
      lb.appendChild(cb); lb.appendChild(h("span", {}, m.label));
      li.appendChild(lb); els.lmVer.appendChild(li);
    });
    els.lmVMode.value = lmView.verifyMode === "cross" ? "cross" : "single";
    // Research model: none, or one model of an extra endpoint.
    var rModels = vModels.slice();
    if (lmView.researchModel && !rModels.some(function (m) { return m.value === lmView.researchModel; })) rModels.push({ value: lmView.researchModel, label: lmView.researchModel });
    els.lmResearch.textContent = "";
    els.lmResearch.appendChild(h("option", { value: "" }, t("roomAdmin.lmResearchNone")));
    rModels.forEach(function (m) { els.lmResearch.appendChild(h("option", { value: m.value }, m.label)); });
    els.lmResearch.value = lmView.researchModel || "";
  }
  // Every stored flag goes back on each save (an omitted flag would keep its value on the server, but sending all keeps the view and the store in step).
  function epBody(x, patch) {
    return Object.assign({
      id: x.id, label: x.label, baseUrl: x.baseUrl, routable: x.routable === true,
      pickable: x.pickable !== false, pickModel: x.pickModel || "", aliases: (x.aliases || []).slice(), canWork: x.canWork === true, privateAllowed: x.privateAllowed === true,
      workRounds: x.workRounds || 6, idleTimeoutMs: x.idleTimeoutMs || null, timeoutMs: x.timeoutMs || null,
    }, patch || {});
  }
  function keepEndpoints(exceptId) {
    return lmView.endpoints.filter(function (e) { return e.id !== exceptId; }).map(function (e) { return epBody(e); });
  }
  function loadLocalModel() {
    els.lm.classList.toggle("hidden", !state.admin);
    if (state.admin) api.getLocalModel().then(function (d) { showLocalModel(d.localModel); }).catch(function () {});
  }
  function saveLocalModel(body, doneKey) {
    api.saveLocalModel(body).then(function (d) { showLocalModel(d.localModel); opts.toast && opts.toast(t(doneKey)); }, function (err) { showLocalModel(); fail(err); });
  }
  // --- Audio transcription endpoint, admin only (self-contained). The API key is write-only: the server returns a flag. ---
  var tr = { box: $("ai-admin-transcription"), on: $("ai-tr-on"), form: $("ai-tr-form"), url: $("ai-tr-url"), model: $("ai-tr-model"), lang: $("ai-tr-lang"), key: $("ai-tr-key"), von: $("ai-tr-von"), vllm: $("ai-tr-vllm"), vvisual: $("ai-tr-vvisual"), vk: $("ai-tr-vk"), vmax: $("ai-tr-vmax") };
  function showTranscription(c) {
    c = c || {};
    tr.on.setAttribute("aria-checked", c.enabled ? "true" : "false");
    tr.url.value = c.baseUrl || ""; tr.model.value = c.model || ""; tr.lang.value = c.language || ""; tr.key.value = "";
    tr.key.placeholder = c.hasApiKey ? t("transcription.keySet") : t("transcription.apiKey");
    var v = c.video || {};
    var vOn = typeof v.configuredEnabled === "boolean" ? v.configuredEnabled : v.enabled !== false; // the stored preference, not the effective state
    tr.von.setAttribute("aria-checked", vOn ? "true" : "false");
    tr.vllm.setAttribute("aria-checked", v.llm === false ? "false" : "true");
    tr.vvisual.setAttribute("aria-checked", v.visual === true ? "true" : "false");
    tr.vk.value = Number.isInteger(v.topK) ? v.topK : ""; tr.vmax.value = Number.isInteger(v.maxDurationSec) ? Math.round(v.maxDurationSec / 60) : "";
  }
  function loadTranscription() {
    tr.box.classList.toggle("hidden", !state.admin);
    if (state.admin) api.getTranscription().then(function (d) { showTranscription(d.transcription); }).catch(function () {});
  }
  function saveTranscription(enabled) {
    var body = { enabled: enabled, baseUrl: tr.url.value, model: tr.model.value, language: tr.lang.value };
    if (tr.key.value.trim()) body.apiKey = tr.key.value.trim();
    body.videoEnabled = tr.von.getAttribute("aria-checked") !== "false";
    body.videoLlm = tr.vllm.getAttribute("aria-checked") !== "false";
    body.videoVisual = tr.vvisual.getAttribute("aria-checked") === "true";
    if (String(tr.vk.value).trim() !== "") body.videoTopK = Number(tr.vk.value);
    if (String(tr.vmax.value).trim() !== "") body.videoMaxMinutes = Number(tr.vmax.value);
    api.saveTranscription(body).then(function (d) { showTranscription(d.transcription); opts.toast && opts.toast(t("transcription.saved")); },
      function (e) { if (e && e.message === "invalid_config") status(t("transcription.invalid")); else fail(e); loadTranscription(); });
  }
  tr.on.addEventListener("click", function () { saveTranscription(tr.on.getAttribute("aria-checked") !== "true"); });
  [tr.von, tr.vllm, tr.vvisual].forEach(function (sw) {
    sw.addEventListener("click", function () { sw.setAttribute("aria-checked", sw.getAttribute("aria-checked") === "false" ? "true" : "false"); saveTranscription(tr.on.getAttribute("aria-checked") === "true"); });
  });
  tr.form.addEventListener("submit", function (ev) { ev.preventDefault(); saveTranscription(tr.on.getAttribute("aria-checked") === "true"); });

  function open(trigger, focusEl) {
    if (!state.owner) return;
    status("");
    settings.open("rooms", { opener: trigger, focus: focusEl });
  }

  settings.onOpen(function () {
    state.roomId = null;
    status("");
  });
  settings.onClose(function () {
    clearInterval(pollTimer); pollTimer = null;
    state.seq++;
    hideOnce();
  });
  // While 방 관리 is open the invite list and the roster follow what happens elsewhere (someone joins with a link):
  // refreshed every few seconds and when the tab comes back, so "사용 가능" never lingers on a used link.
  var pollTimer = null;
  function pollTick() {
    if (!settings.isOpen() || settings.section() !== "rooms" || !state.roomId) { clearInterval(pollTimer); pollTimer = null; return; }
    if (typeof document !== "undefined" && document.hidden) return;
    loadInvites(); loadMembers();
    if (opts.onRoomsChanged) Promise.resolve(opts.onRoomsChanged(null, true)).then(renderSummary);
  }
  function startPoll() {
    if (pollTimer) return;
    pollTimer = setInterval(pollTick, 8000);
    if (pollTimer && typeof pollTimer.unref === "function") pollTimer.unref();
  }
  if (typeof document !== "undefined" && document.addEventListener) document.addEventListener("visibilitychange", function () { if (!document.hidden && pollTimer) pollTick(); });
  settings.onShow("rooms", function () { refresh(); if (state.admin) loadArchived(); startPoll(); });
  settings.onShow("server", function () { if (state.admin) { renderSummary(); loadApproval(); } });
  settings.onShow("routing", function () { loadClef(); loadLocalModel(); });
  settings.onShow("transcription", loadTranscription);

  els.mobile.addEventListener("click", function () { open(els.mobile); });
  els.create.addEventListener("click", function () { open(els.create, els.name); });
  // The phone's 방 전환 sheet: rooms, and 방 만들기 for the owner.
  els.sheetCreate.addEventListener("click", function () { open(els.sheetCreate, els.name); });
  els.picker.addEventListener("change", function () {
    state.roomId = els.picker.value;
    refresh();
  });
  els.form.addEventListener("submit", submitRoom);
  els.inviteCreate.addEventListener("click", issueInvite);
  els.snapOpen.addEventListener("click", openSnapshots);
  els.skillsOpen.addEventListener("click", function () { if (opts.openSkills) opts.openSkills(state.roomId); });
  els.approvalForm.addEventListener("submit", saveApproval);
  els.clefOn.addEventListener("click", function () { saveClef({ enabled: els.clefOn.getAttribute("aria-checked") !== "true" }, "roomAdmin.clefSaved"); });
  els.decisionBackend.addEventListener("change", function () { saveClef({ backend: els.decisionBackend.value }, "roomAdmin.clefSaved"); });
  els.clefAuto.addEventListener("click", function () { saveClef({ autoSelect: els.clefAuto.getAttribute("aria-checked") !== "true" }, "roomAdmin.clefSaved"); });
  els.clefStore.addEventListener("click", function () { saveClef({ storeText: els.clefStore.getAttribute("aria-checked") !== "true" }, "roomAdmin.clefSaved"); });
  els.clefAbstain.addEventListener("change", function () {
    var v = parseFloat(els.clefAbstain.value);
    // The server enforces the same bounds; a bad value never leaves the page.
    if (!(v >= 0.3 && v <= 0.95)) { els.clefAbstain.value = String(clefAbstainShown); opts.toast && opts.toast(t("roomAdmin.clefAbstainRange")); return; }
    saveClef({ abstainMin: Math.round(v * 100) / 100 }, "roomAdmin.clefSaved");
  });
  els.clefForm.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var body = {};
    if (els.clefAccount.value.trim()) body.accountId = els.clefAccount.value.trim();
    if (els.clefToken.value.trim()) body.token = els.clefToken.value.trim();
    if (els.jevKey.value.trim()) body.jevKey = els.jevKey.value.trim();
    if (Object.keys(body).length) saveClef(body, "roomAdmin.clefSaved");
  });
  els.clefClear.addEventListener("click", function () { saveClef({ clear: true }, "roomAdmin.clefCleared"); });
  els.lmForm.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var url = els.lmUrl.value.trim();
    if (!url) return;
    var entry = { label: els.lmLabel.value.trim() || url, baseUrl: url };
    if (els.lmKey.value.trim()) entry.apiKey = els.lmKey.value.trim();
    saveLocalModel({ endpoints: keepEndpoints().concat([entry]) }, "roomAdmin.lmSaved");
    els.lmLabel.value = ""; els.lmUrl.value = ""; els.lmKey.value = "";
  });
  els.lmVMode.addEventListener("change", function () { saveLocalModel({ verifyMode: els.lmVMode.value }, "roomAdmin.lmSaved"); });
  els.lmResearch.addEventListener("change", function () { saveLocalModel({ researchModel: els.lmResearch.value }, "roomAdmin.lmSaved"); });
  els.lmTitle.addEventListener("change", function () { saveLocalModel({ titleModel: els.lmTitle.value }, "roomAdmin.lmSaved"); });
  els.skillManagers.addEventListener("change", saveSkillManagers);
  els.onceCopy.addEventListener("click", function () { if (state.url) opts.copy(state.url); });

  return {
    // Open the 방 관리 section for the selected room with focus on "초대 코드 만들기".
    openInvite: function (trigger) { open(trigger, els.inviteCreate); },
    // The room list changed underneath an open section: keep the picker in step.
    syncRooms: function () {
      if (!settings.isOpen() || settings.section() !== "rooms") return;
      var before = state.roomId;
      renderSummary();
      if (state.roomId !== before) refresh();
    },
    setOwner: function (isOwner, isAdmin) {
      state.owner = !!isOwner;
      state.admin = !!isOwner && !!isAdmin;
      els.archivedSection.classList.toggle("hidden", !state.admin);
      els.tools.classList.toggle("hidden", !state.owner);
      els.approval.classList.toggle("hidden", !state.admin);
      els.approvalHead.classList.toggle("hidden", !state.admin);
      els.mobile.classList.toggle("hidden", !state.owner);
      els.sheetCreate.classList.toggle("hidden", !state.owner);
      settings.setAvailable("rooms", state.owner);
      settings.setAvailable("server", state.admin);
      settings.setAvailable("routing", state.admin);
      settings.setAvailable("transcription", state.admin);
      els.clef.classList.toggle("hidden", !state.admin);
      els.lm.classList.toggle("hidden", !state.admin);
      tr.box.classList.toggle("hidden", !state.admin);
    },
  };
}

// project-attachments.js - HTTP glue for room/private-channel file attachments.
// Bytes travel over HTTP (multipart upload, plain GET download), never the
// websocket. The actor is only req._aigoraUser; every route goes through
// the store's single authorizeAttachment. An attachment shows in the feed as
// its own history type (attachment_card, never user_message), so no agent
// input path reads it. The room or channel always comes from the URL and is
// re-checked by the store; ids that do not match a strict shape are 404.

var fs = require("fs");
var { createRoomAttachments, resolveAttachmentsRoot, LIMITS } = require("./room-attachments");
var { createAiInbox } = require("./attachment-ai");
var { createWorkspaceSnapshots, sharedSnapshots } = require("./workspace-snapshots");
var { createRoomMainThread } = require("./room-main-thread");
var { createPrivateSessionAccess } = require("./private-session-access");
var { readCappedBody } = require("./utils");
var transcription = require("./transcription");
var videoAnalysis = require("./video-analysis");

var blank = require("./office-blank");
var { sanitizeName } = require("./room-attachments");

var ROUTE_RE = /^\/api\/(room|channel)-attachments(?:\/([A-Za-z0-9_-]{1,128}))?(?:\/([a-f0-9]{32}))?(?:\/(share|blank|outbox|transcript))?$/;
var SNAP_RE = /^\/api\/room-snapshots\/([A-Za-z0-9_-]{1,64})(\/restore)?$/;
var ATT_MID_RE = /^att-([a-f0-9]{32})$/;

var shared = {};
function sharedStore(ctx) {
  if (!shared.store) {
    shared.store = createRoomAttachments({
      root: resolveAttachmentsRoot, usersModule: ctx.usersModule, getChannel: ctx.getChannel,
    });
  }
  return shared.store;
}

// --- Multipart ------------------------------------------------------------------------

function malformed() { var e = new Error("invalid"); e.code = "invalid"; e.status = 400; return e; }

// Streaming multipart/form-data parser. onPart({ name, filename }) returns a sink
// { write(buf), end() }; the file bytes are never held whole in memory.
function createMultipartParser(boundary, onPart) {
  var first = Buffer.from("--" + boundary), delim = Buffer.from("\r\n--" + boundary);
  var buf = Buffer.alloc(0), state = "preamble", sink = null;
  function headers(text) {
    var out = {};
    var disp = /content-disposition:\s*form-data;([^\r\n]*)/i.exec(text);
    if (!disp) return out;
    var n = /\bname="((?:[^"\\]|\\.)*)"/.exec(disp[1]), f = /\bfilename="((?:[^"\\]|\\.)*)"/.exec(disp[1]);
    out.name = n ? n[1] : "";
    if (f) out.filename = f[1].replace(/\\(.)/g, "$1");
    return out;
  }
  function push(chunk) {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (state === "preamble") {
        var i = buf.indexOf(first);
        if (i < 0) { buf = buf.slice(Math.max(0, buf.length - first.length)); return; }
        buf = buf.slice(i + first.length); state = "after";
      } else if (state === "after") {
        if (buf.length < 2) return;
        if (buf[0] === 0x2d && buf[1] === 0x2d) { state = "done"; buf = Buffer.alloc(0); return; }
        if (buf[0] !== 0x0d || buf[1] !== 0x0a) throw malformed();
        buf = buf.slice(2); state = "headers";
      } else if (state === "headers") {
        var e = buf.indexOf("\r\n\r\n");
        if (e < 0) { if (buf.length > 8192) throw malformed(); return; }
        var h = headers(buf.slice(0, e).toString("utf8"));
        buf = buf.slice(e + 4);
        sink = onPart(h) || { write: function () {}, end: function () {} };
        state = "body";
      } else if (state === "body") {
        var j = buf.indexOf(delim);
        if (j >= 0) {
          if (j > 0) sink.write(buf.slice(0, j));
          sink.end(); sink = null;
          buf = buf.slice(j + delim.length); state = "after";
        } else {
          var keep = delim.length - 1;
          if (buf.length > keep) { sink.write(buf.slice(0, buf.length - keep)); buf = buf.slice(buf.length - keep); }
          return;
        }
      } else return;
    }
  }
  return { push: push, finish: function () { if (state !== "done") throw malformed(); } };
}

function boundaryOf(req) {
  var ct = String(req.headers["content-type"] || "");
  var m = /^multipart\/form-data\s*;.*\bboundary=(?:"([^"]{1,200})"|([^;\s]{1,200}))/i.exec(ct);
  return m ? (m[1] || m[2]) : null;
}

// --- Glue -----------------------------------------------------------------------------

function attachAttachments(ctx) {
  var sm = ctx.sm;
  var users = ctx.usersModule;
  var store = ctx.store || sharedStore(ctx);
  var ai = ctx.aiInbox || createAiInbox({ store: store, baseDir: ctx.aiBaseDir });
  var roomMain = createRoomMainThread({ sm: sm });
  var snapshots = ctx.snapshots || (ctx.aiBaseDir ? createWorkspaceSnapshots({ baseDir: ctx.aiBaseDir, isLive: ctx.isLive }) : sharedSnapshots());
  var access = createPrivateSessionAccess(users);
  var transcriber = ctx.transcriber || transcription.sharedTranscriber();

  function userName(id) {
    var u = users.findUserById(id);
    if (!u) return "알 수 없음";
    var p = u.profile || {};
    return p.name || u.displayName || u.username || "알 수 없음";
  }
  function sessionById(id) {
    var found = null;
    sm.sessions.forEach(function (s) { if (String(s.localId) === String(id)) found = s; });
    return found;
  }
  function channelSessions(channelId) {
    var out = [];
    sm.sessions.forEach(function (s) { if (s && s.channelId === channelId && !s.hidden) out.push(s); });
    return out;
  }
  function json(res, status, obj) {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(JSON.stringify(obj));
  }
  function errorOf(res, e) {
    var code = e && e.code && e.status ? e.code : "failed";
    json(res, e && e.status ? e.status : 500, { error: code });
  }

  // A file in the feed: its own history type, anchored for comments on "att-<id>".
  function cardEntry(dto) {
    return {
      type: "attachment_card", attachmentId: dto.id, scope: dto.kind, roomId: dto.roomId, channelId: dto.channelId,
      name: dto.name, ext: dto.ext, size: dto.size, mediaType: dto.mediaType, fileType: dto.type,
      authorId: dto.uploaderId, authorName: userName(dto.uploaderId), _ts: dto.createdAt, _mid: "att-" + dto.id,
    };
  }
  function appendFeed(dto, session, entry) {
    try {
      if (dto.kind === "room") roomMain.append(users, dto.roomId, entry);
      else if (session && sessionById(session.localId) === session) sm.sendAndRecord(session, entry); // never into a removed session
    } catch (_) { /* the file stands without its card */ }
  }
  // A background job (transcription, video analysis) may report only while everything it belongs to still exists: its job token is
  // not cancelled (attachment deleted, room or channel purged), the attachment is live in its scope, the room exists and, for a
  // private channel, the session it posts into is still a registered session. Otherwise its update is dropped - nothing is
  // written to a removed session (which would recreate its file), and no stale card or status reaches a purged room.
  function jobGuard(dto, ref, session) {
    var tok = null;
    try { tok = store.beginJob(ref, dto.id); } catch (_) { tok = null; }
    var g = {
      token: tok,
      alive: function () {
        try {
          if (!tok || tok.cancelled || !store.aiRecord(ref, dto.id)) return false;
          if (dto.kind === "room") return !!users.findRoomById(dto.roomId);
          return !!session && sessionById(session.localId) === session;
        } catch (_) { return false; }
      },
      end: function () { try { store.endJob(tok); } catch (_) { /* gone */ } },
    };
    return g;
  }
  function postCard(dto, session) { appendFeed(dto, session, cardEntry(dto)); }
  function removeCard(dto) {
    var entry = { type: "attachment_card_removed", attachmentId: dto.id, _ts: Date.now() };
    try {
      if (dto.kind === "room") roomMain.append(users, dto.roomId, entry);
      else channelSessions(dto.channelId).forEach(function (s) { sm.sendAndRecord(s, entry); });
    } catch (_) { /* hidden on next reload at worst */ }
  }

  // Audio -> text. Runs after the file card is posted; the upload never waits for it and a failure never touches the
  // message. The feed gets only status entries (never the text); the text is stored with the attachment's scope and
  // read through the same authorization as the file (GET .../transcript).
  function transcriptEntry(dto, status, reason, expiresAt, extra) {
    var e = { type: "attachment_transcript", attachmentId: dto.id, scope: dto.kind, roomId: dto.roomId, channelId: dto.channelId, status: status, _ts: Date.now() };
    if (reason) e.reason = reason;
    if (expiresAt) e.expiresAt = expiresAt;
    if (extra) Object.assign(e, extra);
    return e;
  }
  // Video: probe -> audio -> transcript -> emphasis -> frames, one job at a time (lib/video-analysis.js). The feed gets the
  // stage while it runs and the counts when done; text and frames are stored with the attachment (putTranscript / putVideo).
  // An mp4/webm with no picture is a plain audio file: it falls back to the transcription path.
  function startVideoAnalysis(dto, ref, session, cfg) {
    var guard = jobGuard(dto, ref, session);
    if (!guard.token) return;
    try { if (!store.putTranscript(ref, dto.id, { status: "running" })) return guard.end(); } catch (_) { return guard.end(); }
    function deadline() { return Date.now() + 2 * transcription.timeoutFor(dto.size) + 30 * 60000; }
    function stage(name) { if (guard.alive()) appendFeed(dto, session, transcriptEntry(dto, "running", null, deadline(), { stage: name })); }
    function failed(code) {
      if (!guard.alive()) return;
      try { store.putTranscript(ref, dto.id, { status: "failed", error: code }); } catch (_) { /* the card still shows it */ }
      appendFeed(dto, session, transcriptEntry(dto, "failed", code));
    }
    stage("probe");
    videoAnalysis.enqueue(function () {
      if (!guard.alive()) throw Object.assign(new Error("cancelled"), { code: "cancelled" });
      var f = store.openInternal(ref, dto.id), closed = false;
      function close() { if (!closed) { closed = true; try { fs.closeSync(f.fd); } catch (_) { /* closed */ } } }
      return videoAnalysis.analyze({ fd: f.fd, size: f.size, ext: dto.ext }, cfg, { onStage: stage, cancelled: function () { return !guard.alive(); }, transcribe: videoAnalysis.transcribeVia(transcriber) })
        .then(function (r) { close(); return r; }, function (e) { close(); throw e; });
    }).then(function (r) {
      guard.end();
      if (!guard.alive()) return; // the attachment, room or channel is gone: keep nothing, post nothing
      var kept = false;
      try {
        kept = store.putVideo(ref, dto.id, { durationSec: r.durationSec, moments: r.moments, frames: r.frames });
        if (kept) kept = store.putTranscript(ref, dto.id, { status: "done", text: r.transcript, language: "", duration: r.durationSec });
      } catch (e) { failed(e && e.code === "quota" ? "quota" : "failed"); return; }
      if (kept) appendFeed(dto, session, transcriptEntry(dto, "done", null, null, { summary: { durationSec: Math.round(r.durationSec), moments: r.moments.length, frames: r.frames.length } }));
    }, function (e) {
      guard.end();
      var code = e && e.code ? String(e.code) : "failed";
      if (code === "cancelled") return;
      if (code === "not_video" && dto.type === "audio" && guard.alive()) return startAudioTranscription(dto, ref, session);
      failed(code === "not_video" ? "unsupported" : code);
    });
  }
  function startTranscription(dto, ref, session) {
    if (!dto || (dto.type !== "audio" && dto.type !== "video") || !transcriber.enabled()) return;
    var vcfg = null;
    try { vcfg = transcriber.config(); } catch (_) { vcfg = null; }
    if (vcfg && vcfg.video && vcfg.video.enabled && videoAnalysis.FORMAT_OF[dto.ext]) return startVideoAnalysis(dto, ref, session, vcfg);
    if (dto.type === "audio") startAudioTranscription(dto, ref, session);
  }
  function startAudioTranscription(dto, ref, session) {
    if (!dto || dto.type !== "audio" || !transcriber.enabled()) return;
    var guard = jobGuard(dto, ref, session);
    if (!guard.token) return;
    try { if (!store.putTranscript(ref, dto.id, { status: "running" })) return guard.end(); } catch (_) { return guard.end(); }
    appendFeed(dto, session, transcriptEntry(dto, "running", null, Date.now() + 2 * transcription.timeoutFor(dto.size) + 600000));
    function finish(data, status, reason) {
      guard.end();
      if (!guard.alive()) return; // removed meanwhile: write nothing
      var kept = false;
      try { kept = store.putTranscript(ref, dto.id, data); } catch (_) { kept = false; }
      if (kept || status === "failed") appendFeed(dto, session, transcriptEntry(dto, status, reason));
    }
    transcriber.enqueue({
      open: function () { if (!guard.alive()) throw Object.assign(new Error("cancelled"), { code: "cancelled" }); var f = store.openInternal(ref, dto.id); return { fd: f.fd, size: f.size, ext: dto.ext }; },
      close: function (f) { fs.closeSync(f.fd); },
    }).then(function (r) { finish({ status: "done", text: r.text, language: r.language, duration: r.duration }, "done"); },
      function (e) { var code = e && e.code ? String(e.code) : "failed"; finish({ status: "failed", error: code }, "failed", code); });
  }

  // Comment/pin anchors "att-<id>" must name a live attachment the actor may comment on.
  function commentable(user, session, mid) {
    var m = ATT_MID_RE.exec(String(mid));
    if (!m || !session) return false;
    var ref = session.channelId !== undefined && session.channelId !== null ? { channelId: session.channelId } : { roomId: session.roomId };
    try { store.authorizeAttachment({ id: user.id }, ref, m[1], "comment"); return true; } catch (_) { return false; }
  }

  function parseRoute(urlPath, query) {
    var m = ROUTE_RE.exec(urlPath);
    if (!m) return null;
    var ref = m[2] ? (m[1] === "room" ? { roomId: m[2] } : { channelId: m[2] }) : null;
    return { scopeKind: m[1], ref: ref, id: m[3] || null, share: m[4] === "share", blank: m[4] === "blank", action: m[4] || null, query: query };
  }

  // A private channel's file is always posted into one of that channel's sessions the actor may write to.
  function channelSessionFor(actor, route) {
    var session = route.query.get("session") ? sessionById(route.query.get("session")) : null;
    try {
      if (!session || session.channelId !== route.ref.channelId) throw new Error("no session");
      access.assertSessionAction(actor, session, { visibility: "public" }, "mutate");
    } catch (_) { return null; }
    return session;
  }

  // 새 문서: a blank docx/xlsx/pptx goes through the same upload pipeline (type checks, quota, card) as any file.
  function handleBlank(req, res, actor, route) {
    var session = null;
    if (route.scopeKind === "channel") {
      session = channelSessionFor(actor, route);
      if (!session) return json(res, 404, { error: "not_found" });
    }
    readCappedBody(req, 4096).then(function (body) {
      var parsed = {};
      try { parsed = JSON.parse(body || "{}"); } catch (_) { return json(res, 400, { error: "invalid" }); }
      var type = parsed && parsed.type;
      var bytes = typeof type === "string" ? blank.buildBlank(type) : null;
      if (!bytes) return json(res, 400, { error: "invalid" });
      var name = sanitizeName(parsed.name);
      name = name.replace(/\.[A-Za-z0-9]{1,8}$/, "") || blank.DEFAULT_NAMES[type].replace(/\.[^.]+$/, "");
      var dto = store.uploadBuffer(actor, route.ref, name + "." + type, bytes);
      postCard(dto, session);
      json(res, 200, { attachment: Object.assign({}, dto, { authorName: userName(dto.uploaderId) }) });
    }, function () { json(res, 400, { error: "invalid" }); }).catch(function (e) { errorOf(res, e); });
  }

  function handleUpload(req, res, actor, route) {
    var session = null;
    if (route.scopeKind === "channel") {
      session = channelSessionFor(actor, route);
      if (!session) return json(res, 404, { error: "not_found" });
    }
    try { store.authorizeAttachment(actor, route.ref, undefined, "upload"); } catch (e) { return errorOf(res, e); }
    var boundary = boundaryOf(req);
    var cap = LIMITS.perRequest * LIMITS.perFile + 1024 * 1024;
    try { var ac = transcriber.config(); if (ac.enabled) cap = Math.max(cap, ac.maxBytes + 1024 * 1024); } catch (_) { /* default cap */ }
    var declared = Number(req.headers["content-length"]);
    if (!boundary) return json(res, 400, { error: "invalid" });
    if (declared > cap) return json(res, 413, { error: "too_large" });

    var done = [], rejected = [], files = 0, total = 0, finished = false;
    var openUps = [];
    function abortOpen() { openUps.splice(0).forEach(function (u) { try { u.abort(); } catch (_) { /* already released */ } }); }
    var parser = createMultipartParser(boundary, function (h) {
      if (h.filename === undefined) return null; // a plain field: ignored
      files++;
      if (files > LIMITS.perRequest) { rejected.push({ name: h.filename, code: "invalid" }); return null; }
      var up = null, dead = false;
      try { up = store.beginUpload(actor, route.ref, h.filename); } catch (e) { rejected.push({ name: h.filename, code: e.code || "failed", status: e.status }); return null; }
      openUps.push(up);
      return {
        write: function (b) {
          if (dead) return;
          try { up.write(b); } catch (e) { dead = true; up.abort(); rejected.push({ name: h.filename, code: e.code || "failed", status: e.status }); }
        },
        end: function () {
          if (dead) return;
          var at = openUps.indexOf(up); if (at >= 0) openUps.splice(at, 1);
          try { done.push(up.finish()); } catch (e) { rejected.push({ name: h.filename, code: e.code || "failed", status: e.status }); }
        },
      };
    });
    function finish() {
      if (finished) return;
      finished = true;
      abortOpen();
      if (!done.length) {
        var r = rejected[0] || { code: "invalid", status: 400 };
        return json(res, r.status || 400, { error: r.code, rejected: rejected });
      }
      done.forEach(function (d) { postCard(d, session); startTranscription(d, route.ref, session); });
      json(res, 200, { attachments: done.map(function (d) { return Object.assign({}, d, { authorName: userName(d.uploaderId) }); }), rejected: rejected });
    }
    req.on("data", function (chunk) {
      if (finished) return;
      total += chunk.length;
      if (total > cap) { finished = true; abortOpen(); json(res, 413, { error: "too_large" }); req.resume(); return; }
      try { parser.push(chunk); } catch (e) { finished = true; abortOpen(); json(res, 400, { error: "invalid" }); req.resume(); }
    });
    req.on("end", function () {
      if (finished) return;
      try { parser.finish(); } catch (_) { finished = true; abortOpen(); return json(res, 400, { error: "invalid" }); }
      finish();
    });
    req.on("error", function () { finished = true; abortOpen(); });
    req.on("close", function () { if (!req.complete) { finished = true; abortOpen(); } });
  }

  function handleDownload(req, res, actor, route) {
    var f;
    try { f = store.open(actor, route.ref, route.id, "download"); } catch (e) { return errorOf(res, e); }
    var headers = f.headers({ disposition: route.query.get("disposition") });
    var status = 200, start = 0, end = f.size - 1;
    var range = headers["Accept-Ranges"] && /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
    if (range && (range[1] !== "" || range[2] !== "")) {
      if (range[1] === "") { start = Math.max(0, f.size - Number(range[2])); }
      else { start = Number(range[1]); if (range[2] !== "") end = Math.min(end, Number(range[2])); }
      if (start > end || start >= f.size) {
        fs.closeSync(f.fd);
        res.writeHead(416, { "Content-Range": "bytes */" + f.size });
        return res.end();
      }
      status = 206;
      headers["Content-Range"] = "bytes " + start + "-" + end + "/" + f.size;
      headers["Content-Length"] = String(end - start + 1);
    }
    res.writeHead(status, headers);
    if (f.size === 0) { fs.closeSync(f.fd); return res.end(); }
    var stream = fs.createReadStream(null, { fd: f.fd, start: start, end: end, autoClose: true });
    stream.on("error", function () { res.destroy(); });
    res.on("close", function () { stream.destroy(); });
    stream.pipe(res);
  }

  // 결과 파일 가져오기: list what the room AI wrote to outbox/, or publish one file as an attachment.
  function handleOutbox(req, res, actor, route) {
    if (route.scopeKind !== "room") return json(res, 404, { error: "not_found" });
    if (req.method === "GET") return json(res, 200, ai.outboxList(actor, route.ref));
    if (req.method !== "POST") return json(res, 404, { error: "not_found" });
    readCappedBody(req, 4096).then(function (body) {
      var parsed = {};
      try { parsed = JSON.parse(body || "{}"); } catch (_) { return json(res, 400, { error: "invalid" }); }
      var dto = ai.outboxPublish(actor, route.ref, parsed && parsed.name);
      postCard(dto, null);
      json(res, 200, { attachment: Object.assign({}, dto, { authorName: userName(dto.uploaderId) }) });
    }, function () { json(res, 400, { error: "invalid" }); }).catch(function (e) { errorOf(res, e); });
  }

  // 작업 폴더 되돌리기: a room's workspace backups. Room owner / admin only (a member or viewer is refused, a stranger sees 404).
  function handleSnapshots(req, res, m) {
    var actor = req._aigoraUser ? { id: req._aigoraUser.id } : null;
    if (!actor) return json(res, 401, { error: "unauthorized" });
    var roomId = m[1], role = null;
    try { role = users.getRoomRole(actor.id, roomId) || null; } catch (_) { role = null; }
    if (!role) return json(res, 404, { error: "not_found" });
    if (role !== "owner") return json(res, 403, { error: "forbidden" });
    if (!m[2]) {
      if (req.method !== "GET") return json(res, 404, { error: "not_found" });
      return json(res, 200, { snapshots: snapshots.list(roomId) });
    }
    if (req.method !== "POST") return json(res, 404, { error: "not_found" });
    if (!req.headers["x-requested-with"]) return json(res, 403, { error: "forbidden" });
    readCappedBody(req, 4096).then(function (body) {
      var parsed = {};
      try { parsed = JSON.parse(body || "{}"); } catch (_) { return json(res, 400, { error: "invalid" }); }
      var r = snapshots.restore(roomId, parsed && parsed.id, { id: actor.id, name: userName(actor.id) });
      var hhmm = new Date(r.time).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
      try { roomMain.append(users, roomId, { type: "skill_notice", noticeId: require("crypto").randomBytes(6).toString("hex"), text: "관리자가 작업 폴더를 " + hhmm + " 시점으로 되돌렸어요.", _ts: Date.now() }); } catch (_) { /* the restore stands */ }
      json(res, 200, { ok: true, time: r.time, snapshots: snapshots.list(roomId) });
    }, function () { json(res, 400, { error: "invalid" }); }).catch(function (e) { errorOf(res, e); });
  }

  function handleHttp(req, res, urlPath) {
    var parts = String(urlPath || "").split("?");
    var snap = SNAP_RE.exec(parts[0]);
    if (snap) { handleSnapshots(req, res, snap); return true; }
    if (!/^\/api\/(room|channel)-attachments(\/|$)/.test(parts[0])) return false;
    var actor = req._aigoraUser ? { id: req._aigoraUser.id } : null;
    if (!actor) { json(res, 401, { error: "unauthorized" }); return true; }
    var route = parseRoute(parts[0], new URLSearchParams(parts[1] || ""));
    var mutating = req.method === "POST" || req.method === "DELETE";
    if (!route || !route.ref) { json(res, 404, { error: "not_found" }); return true; }
    if (mutating && !req.headers["x-requested-with"]) { json(res, 403, { error: "forbidden" }); return true; }
    try {
      if (route.action === "outbox" && !route.id) handleOutbox(req, res, actor, route);
      else if (req.method === "POST" && route.blank && !route.id) handleBlank(req, res, actor, route);
      else if (req.method === "POST" && !route.id && !route.share && !route.action) handleUpload(req, res, actor, route);
      else if (req.method === "GET" && !route.id) json(res, 200, { attachments: store.list(actor, route.ref).map(function (d) { return Object.assign({}, d, { authorName: userName(d.uploaderId) }); }) });
      else if (req.method === "GET" && route.id && route.action === "transcript") {
        var tr = store.getTranscript(actor, route.ref, route.id);
        json(res, 200, tr ? { status: tr.status, text: tr.text || "", language: tr.language || "", duration: tr.duration == null ? null : tr.duration, error: tr.error || "" } : { status: "none", text: "" });
      } else if (req.method === "GET" && route.id && !route.share && !route.action) handleDownload(req, res, actor, route);
      else if (req.method === "DELETE" && route.id && !route.share && !route.action) {
        var removed = store.remove(actor, route.ref, route.id);
        removeCard(removed);
        if (ctx.onRemoved) ctx.onRemoved(removed);
        json(res, 200, { ok: true });
      } else if (req.method === "POST" && route.id && route.share && route.scopeKind === "channel") {
        readCappedBody(req, 4096).then(function (body) {
          var parsed = {};
          try { parsed = JSON.parse(body || "{}"); } catch (_) { return json(res, 400, { error: "invalid" }); }
          var copy = store.share(actor, route.ref, route.id, parsed && parsed.targetRoomId);
          postCard(copy, null);
          json(res, 200, { attachment: Object.assign({}, copy, { authorName: userName(copy.uploaderId) }) });
        }, function () { json(res, 400, { error: "invalid" }); }).catch(function (e) { errorOf(res, e); });
      } else json(res, 404, { error: "not_found" });
    } catch (e) { errorOf(res, e); }
    return true;
  }

  // The files a sender picked for ONE instruction, checked against that sender's access in the session's scope.
  // Throws (code/status) when any id is not theirs to attach or the pick is over the limits.
  function selectForTurn(actor, session, ids) {
    var ref = session.channelId !== undefined && session.channelId !== null ? { channelId: session.channelId } : { roomId: session.roomId };
    return store.aiSelect(actor, ref, ids);
  }

  return { handleHttp: handleHttp, commentable: commentable, store: store, selectForTurn: selectForTurn };
}

module.exports = { getSharedStore: function () { return shared.store || null; }, attachAttachments: attachAttachments, createMultipartParser: createMultipartParser };

"use strict";
// Streaming slide heuristics. No model or image dependencies. Memory is O(sample pixels), not O(video length):
// two RGB references, reusable per-pixel statistics/scratch space, <=16 tracks with <=11 recent centroids each,
// and <=400 events/scenes. Thresholds below are in pixels at the 480-wide sampling resolution.
var EVENT_CAP = 400;
function location(x, y) {
  return (x < 1 / 3 ? "왼쪽" : x < 2 / 3 ? "가운데" : "오른쪽") + " " +
    (y < 1 / 3 ? "위" : y < 2 / 3 ? "가운데" : "아래");
}
function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function laserColor(r, g, b) {
  var hi = Math.max(r, g, b), lo = Math.min(r, g, b), d = hi - lo;
  if (hi < 180 || d / hi < 0.65) return 0;
  var h = hi === r ? 60 * ((g - b) / d) : hi === g ? 120 + 60 * ((b - r) / d) : 240 + 60 * ((r - g) / d);
  if (h < 0) h += 360;
  return h <= 20 || h >= 340 ? 1 : h >= 75 && h <= 165 ? 2 : 0;
}
function createDetector(width, height) {
  var size = width * height, prev = null, base = null, segmentStart = 0, lastT = 0, samples = 0, segFrames = 0;
  var mask = new Uint8Array(size), mean = new Float32Array(size * 3), variance = new Float32Array(size), frequency = new Float32Array(size);
  var colors = new Uint8Array(size), prevColors = new Uint8Array(size), laserPixels = new Uint8Array(size), previousLaser = new Uint8Array(size), diff = new Uint8Array(size), inkPixels = new Uint8Array(size), committedPixels = new Uint8Array(size);
  var visited = new Uint8Array(size), queue = new Int32Array(size), indices = new Int32Array(size);
  var ink = [], laser = [], scenes = [], tracks = [], annotation = null;
  function priority(event) { return event.t_end !== undefined ? 3 : event.mode === "dwell" ? 2 : 1; }
  function boundedPush(list, event) {
    // Retain earlier events on ties. A stronger event evicts the newest event of the lowest priority.
    if (list.length >= EVENT_CAP) {
      var victim = -1, lowest = priority(event);
      for (var i = list.length - 1; i >= 0; i--) {
        var p = priority(list[i]);
        if (p < lowest) { lowest = p; victim = i; }
      }
      if (victim < 0) return;
      list.splice(victim, 1);
    }
    list.push(event);
  }
  function emitInk(t, buf, atSegmentEnd) {
    // At a cut, sustained writing is already evidence; keep rejecting a single late transient stroke.
    if (annotation && (t - annotation.t_end >= 1 || (atSegmentEnd && annotation.t_end - annotation.t_start >= 1)) && annotation.area >= 20) {
      var a = annotation, live = 0;
      for (var i = 0; i < size; i++) if (inkPixels[i] && !mask[i]) live++;
      if (live >= a.area * 0.8) {
        boundedPush(ink, { t_start: a.t_start, t_end: a.t_end,
          bbox: { x: a.x0, y: a.y0, width: a.x1 - a.x0 + 1, height: a.y1 - a.y0 + 1 } });
        // Only committed ink joins the reference; a simultaneous pointer must remain transient.
        if (buf) for (var j = 0; j < size; j++) if (inkPixels[j] && !mask[j]) {
          buf.copy(base, j * 3, j * 3, j * 3 + 3); committedPixels[j] = 1;
        }
      }
    }
    annotation = null; inkPixels.fill(0);
  }
  function emitTrack(track, end, atSegmentEnd) {
    var staticWholeSegment = atSegmentEnd && track.first <= segmentStart + 0.5 && track.last >= end - 0.5 &&
      track.x1 - track.x0 <= 8 && track.y1 - track.y0 <= 8;
    var e = track.event;
    if (!e || staticWholeSegment || mask[Math.min(size - 1, Math.floor(e.y) * width + Math.floor(e.x))]) return;
    boundedPush(laser, { t: e.t, x: e.x / width, y: e.y / height, region: location(e.x / width, e.y / height), mode: e.mode });
  }
  function endSegment(t) {
    emitInk(t, null, true); tracks.forEach(function (tr) { emitTrack(tr, t, true); }); tracks = [];
    base = null; samples = 0; committedPixels.fill(0);
    variance.fill(0); frequency.fill(0);
  }
  // A pointer is a sharp-edged patch that appears on a still slide. Picture content that merely contains a saturated red or
  // green patch is not one: a smooth colour gradient has no hard edge, and zooming/animated content moves around the patch.
  // Pointer pixels of this and the previous frame are ignored in the motion test, so a moving pointer does not disqualify itself.
  var curBuf = null;
  function plausiblePointer(x0, y0, x1, y1, pix, count) {
    if (!curBuf) return true;
    var mr = 0, mg = 0, mb = 0, k;
    for (k = 0; k < count; k++) { mr += curBuf[pix[k] * 3]; mg += curBuf[pix[k] * 3 + 1]; mb += curBuf[pix[k] * 3 + 2]; }
    mr /= count; mg /= count; mb /= count;
    var ring = 0, sharp = 0;
    for (var ry = Math.max(0, y0 - 3); ry <= Math.min(height - 1, y1 + 3); ry++) for (var rx = Math.max(0, x0 - 3); rx <= Math.min(width - 1, x1 + 3); rx++) {
      if (rx >= x0 && rx <= x1 && ry >= y0 && ry <= y1) continue;
      var rp = (ry * width + rx) * 3;
      ring++;
      if (Math.max(Math.abs(curBuf[rp] - mr), Math.abs(curBuf[rp + 1] - mg), Math.abs(curBuf[rp + 2] - mb)) > 80) sharp++;
    }
    if (ring && sharp < ring * 0.5) return false;
    if (!prev) return true;
    var m = 6, n = 0, moved = 0;
    for (var y = Math.max(0, y0 - m); y <= Math.min(height - 1, y1 + m); y++) for (var x = Math.max(0, x0 - m); x <= Math.min(width - 1, x1 + m); x++) {
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) continue;
      var i = y * width + x;
      if (colors[i] || previousLaser[i] || mask[i]) continue;
      n++;
      var q = i * 3;
      if (Math.max(Math.abs(curBuf[q] - prev[q]), Math.abs(curBuf[q + 1] - prev[q + 1]), Math.abs(curBuf[q + 2] - prev[q + 2])) > 12) moved++;
    }
    return n < 8 || moved <= n * 0.2;
  }
  function blobs() {
    var out = []; visited.fill(0); laserPixels.fill(0);
    for (var i = 0; i < size; i++) {
      if (!colors[i] || mask[i] || visited[i]) continue;
      var head = 0, tail = 1, sx = 0, sy = 0, x0 = width, y0 = height, x1 = 0, y1 = 0, color = colors[i];
      queue[0] = i; visited[i] = 1;
      while (head < tail) {
        var at = queue[head++], x = at % width, y = Math.floor(at / width);
        sx += x; sy += y; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        if (x && !visited[at - 1] && !mask[at - 1] && colors[at - 1] === color) { visited[at - 1] = 1; queue[tail++] = at - 1; }
        if (x + 1 < width && !visited[at + 1] && !mask[at + 1] && colors[at + 1] === color) { visited[at + 1] = 1; queue[tail++] = at + 1; }
        if (y && !visited[at - width] && !mask[at - width] && colors[at - width] === color) { visited[at - width] = 1; queue[tail++] = at - width; }
        if (y + 1 < height && !visited[at + width] && !mask[at + width] && colors[at + width] === color) { visited[at + width] = 1; queue[tail++] = at + width; }
      }
      var bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      if (tail >= 6 && tail <= 300 && bw <= 30 && bh <= 30 && Math.max(bw / bh, bh / bw) <= 2.5 &&
        tail / (bw * bh) >= 0.45 && out.length < 16 && plausiblePointer(x0, y0, x1, y1, queue, tail)) {
        // Same-coloured pixels already there (within 4 px) in the previous frame: this patch is picture content that grew or
        // drifted, not a pointer that just appeared.
        var old = 0;
        for (var yy = Math.max(0, y0 - 4); yy <= Math.min(height - 1, y1 + 4); yy++)
          for (var xx = Math.max(0, x0 - 4); xx <= Math.min(width - 1, x1 + 4); xx++) if (prevColors[yy * width + xx] === color) old++;
        out.push({ x: sx / tail, y: sy / tail, color: color, fresh: !prev || old < Math.max(3, tail * 0.3) });
        // Include the one-pixel antialiasing fringe: it can be pale enough to fail laserColor yet look like thin ink.
        for (var ly = Math.max(0, y0 - 1); ly <= Math.min(height - 1, y1 + 1); ly++)
          laserPixels.fill(1, ly * width + Math.max(0, x0 - 1), ly * width + Math.min(width, x1 + 2));
      }
    }
    return out;
  }
  function lasers(t, found) {
    tracks.forEach(function (tr) { tr.used = false; });
    found.forEach(function (point) {
      if (mask[Math.floor(point.y) * width + Math.floor(point.x)]) return;
      var nearest = null, best = 90;
      tracks.forEach(function (tr) {
        var d = distance(tr.point, point);
        if (!tr.used && tr.color === point.color && t - tr.last <= 0.5 && d < best) { nearest = tr; best = d; }
      });
      var tr = nearest;
      if (!tr) {
        if (tracks.length >= 16 || !point.fresh) return;
        tr = { first: t, last: t, color: point.color, point: point, anchor: point, dwellStart: t, trail: [], event: null,
          x0: point.x, x1: point.x, y0: point.y, y1: point.y };
        tracks.push(tr);
      }
      tr.used = true; tr.last = t; tr.point = point;
      tr.x0 = Math.min(tr.x0, point.x); tr.x1 = Math.max(tr.x1, point.x);
      tr.y0 = Math.min(tr.y0, point.y); tr.y1 = Math.max(tr.y1, point.y);
      if (distance(tr.anchor, point) > 8) { tr.anchor = point; tr.dwellStart = t; }
      if (t - tr.dwellStart >= 1 && (!tr.event || tr.event.mode !== "dwell")) tr.event = { t: t, x: point.x, y: point.y, mode: "dwell" };
      tr.trail.push({ t: t, x: point.x, y: point.y });
      while (tr.trail.length && t - tr.trail[0].t > 5) tr.trail.shift();
      if (!tr.event && tr.trail.length >= 10 && t - tr.trail[0].t >= 4.5) {
        // Two separated returns to the same small region, with an excursion in between (a straight pass is not a circle).
        var returns = 0, away = true;
        tr.trail.forEach(function (p) {
          if (t - p.t < 1) return;
          var d = distance(p, point);
          if (d > 18) away = true;
          else if (d <= 10 && away) { returns++; away = false; }
        });
        if (returns >= 2) tr.event = { t: t, x: point.x, y: point.y, mode: "sweep" };
      }
    });
    tracks = tracks.filter(function (tr) { if (tr.used) return true; emitTrack(tr, t); return false; });
  }
  function updateMask(buf) {
    // EW temporal variance + frequent frame-to-frame changes; a single persistent ink addition never qualifies.
    for (var i = 0, p = 0; i < size; i++, p += 3) {
      // Repeated pointer returns are the signal, not a webcam. Do not learn variance from compact pointer pixels
      // (or from their disappearance on the next frame). Larger saturated strokes still go through the ink detector.
      if (laserPixels[i] || previousLaser[i]) { frequency[i] *= 0.88; continue; }
      var dr = buf[p] - mean[p], dg = buf[p + 1] - mean[p + 1], db = buf[p + 2] - mean[p + 2];
      mean[p] += 0.12 * dr; mean[p + 1] += 0.12 * dg; mean[p + 2] += 0.12 * db;
      variance[i] = 0.88 * (variance[i] + 0.12 * (dr * dr + dg * dg + db * db) / 3);
      var change = Math.max(Math.abs(buf[p] - prev[p]), Math.abs(buf[p + 1] - prev[p + 1]), Math.abs(buf[p + 2] - prev[p + 2])) > 25;
      frequency[i] = 0.88 * frequency[i] + (change ? 0.12 : 0);
      if (samples >= 6 && frequency[i] > 0.35 && variance[i] > 200) mask[i] = 1;
    }
    // Fill a 16px tile only when a substantial part is noisy, covering the quiet pixels inside a webcam/clock region.
    for (var y = 0; y < height; y += 16) for (var x = 0; x < width; x += 16) {
      var count = 0, area = 0;
      for (var yy = y; yy < Math.min(height, y + 16); yy++) for (var xx = x; xx < Math.min(width, x + 16); xx++) { area++; count += mask[yy * width + xx]; }
      if (count > area * 0.25) for (var y2 = y; y2 < Math.min(height, y + 16); y2++) mask.fill(1, y2 * width + x, y2 * width + Math.min(width, x + 16));
    }
  }
  function additions(buf, t) {
    var count = 0, added = 0, removed = 0, erased = 0, x0 = width, y0 = height, x1 = 0, y1 = 0;
    for (var i = 0, p = 0; i < size; i++, p += 3) {
      var changed = !mask[i] && (laserPixels[i] ? !!inkPixels[i] :
        Math.max(Math.abs(buf[p] - base[p]), Math.abs(buf[p + 1] - base[p + 1]), Math.abs(buf[p + 2] - base[p + 2])) > 65);
      diff[i] = changed ? 1 : 0;
      if (changed) {
        if (committedPixels[i]) erased++;
        indices[count++] = i;
        if (!inkPixels[i]) added++;
        var x = i % width, y = Math.floor(i / width);
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      } else if (inkPixels[i]) {
        // Lost candidate ink includes newly masked pixels; hiding noisy edges must not make them
        // look monotonic before a cut or end-of-stream flush.
        removed++;
      }
    }
    if (!count && !annotation) return;
    var thin = 0;
    for (var k = 0; k < count; k++) {
      var at = indices[k], xx = at % width, yy = Math.floor(at / width);
      if (xx < 3 || xx >= width - 3 || yy < 3 || yy >= height - 3 ||
        !(diff[at - 3] && diff[at + 3] && diff[at - 3 * width] && diff[at + 3 * width])) thin++;
    }
    // Broad blocks/builds and removals reset the reference. Thin additions must be small, localized and monotonic.
    if (count > size * 0.05 || added > size * 0.01 || (count && thin / count < 0.7) ||
      (x1 - x0 + 1) * (y1 - y0 + 1) > size * 0.5 ||
      // A hand-drawn mark is local; a hairline spanning most of the picture is a codec/gradient edge or a layout shift.
      (count && (x1 - x0 + 1 > width * 0.7 || y1 - y0 + 1 > height * 0.7)) || erased > 6 || removed > Math.max(6, (annotation ? annotation.area : 0) * 0.1)) {
      annotation = null; inkPixels.fill(0); committedPixels.fill(0); base = Buffer.from(buf); return;
    }
    if (added >= 8 && count >= 20) {
      if (!annotation) annotation = { t_start: t };
      Object.assign(annotation, { t_end: t, area: count, x0: x0, y0: y0, x1: x1, y1: y1 });
    }
    inkPixels.set(diff);
    if (annotation && t - annotation.t_end >= 1.5) emitInk(t, buf, false);
  }
  return {
    add: function (buf, t) {
      if (buf.length !== size * 3) throw new Error("bad_rgb_frame");
      lastT = t; samples++; segFrames++; curBuf = buf;
      var changed = 0, unmasked = 0;
      for (var i = 0, p = 0; i < size; i++, p += 3) {
        colors[i] = laserColor(buf[p], buf[p + 1], buf[p + 2]);
        if (!prev) { mean[p] = buf[p]; mean[p + 1] = buf[p + 1]; mean[p + 2] = buf[p + 2]; }
        else if (!mask[i]) {
          unmasked++;
          if (Math.max(Math.abs(buf[p] - prev[p]), Math.abs(buf[p + 1] - prev[p + 1]), Math.abs(buf[p + 2] - prev[p + 2])) > 35) changed++;
        }
      }
      var share = changed / Math.max(1, unmasked);
      if (prev && share > 0.25) {
        endSegment(t - 0.5); segmentStart = t; segFrames = 1;
        if (scenes.length < EVENT_CAP) scenes.push(t);
        mean.set(buf);
        laserPixels.fill(0);
      } else {
        var found = blobs();
        if (prev) updateMask(buf);
        // Recompute stability outside the newly learned mask.
        var stableChanges = 0;
        if (prev) for (var s = 0; s < size; s++) if (!mask[s] &&
          Math.max(Math.abs(buf[s * 3] - prev[s * 3]), Math.abs(buf[s * 3 + 1] - prev[s * 3 + 1]), Math.abs(buf[s * 3 + 2] - prev[s * 3 + 2])) > 35) stableChanges++;
        if (stableChanges > size * 0.05) {
          // Embedded playback/animation: allow the temporal mask to learn first, without emitting visual events.
          annotation = null; base = null; inkPixels.fill(0); committedPixels.fill(0); tracks = [];
        } else {
          // Never the first frame of a segment: the first decoded frame after a cut or at the start can carry codec/render seams.
          if (!base && prev && segFrames >= 3 && stableChanges < size * 0.01) base = Buffer.from(prev);
          lasers(t, found);
          if (base) additions(buf, t);
        }
      }
      if (!prev) prev = Buffer.from(buf); else buf.copy(prev);
      previousLaser.set(laserPixels); prevColors.set(colors);
    },
    finish: function (t) { endSegment(t === undefined ? lastT : t); return { ink: ink, laser: laser, scenes: scenes, mask: mask, width: width, height: height }; }
  };
}
module.exports = { createDetector: createDetector, location: location };

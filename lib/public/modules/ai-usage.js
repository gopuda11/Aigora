// AI usage widget: compact top-bar control + popover backed by GET /api/ai-usage.
// Renders only server-provided values via textContent; never invents numbers.

import { t, onLangChange } from "../aigora/i18n.js";

export var POLL_MS = 60000;
export var STALE_MS = POLL_MS * 2 + 5000;

var state = { data: null, error: false, timer: null, open: false, inFlight: false, tick: null, basePath: "/", generation: 0 };
var els = {};

export function clampPercent(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? Math.round(value) : null;
}

export function levelFor(left) {
  if (left == null) return "unknown";
  if (left <= 10) return "critical";
  if (left <= 30) return "low";
  return "ok";
}

export function windowsOf(provider) {
  if (!provider || provider.status !== "ready") return [];
  var out = [];
  if (provider.session && clampPercent(provider.session.leftPercent) != null) out.push({ key: "session", left: clampPercent(provider.session.leftPercent) });
  if (provider.weekly && clampPercent(provider.weekly.leftPercent) != null) out.push({ key: "weekly", left: clampPercent(provider.weekly.leftPercent) });
  return out;
}

// Providers that never report a quota (local models) are status-only rows: they are
// neither "unavailable" nor part of the worst-remaining summary.
export function reportsQuota(provider) {
  return !(provider && provider.quota === "not_reported");
}

// A model's own remaining share is its tightest window. Work moves to another
// model when one runs out, so the summary is the model with the most left
// (`best`); `exhausted` counts models at 0%.
export function summarize(data) {
  var providers = (data && Array.isArray(data.providers) ? data.providers : []).filter(reportsQuota);
  var best = null;
  var exhausted = 0;
  var unavailable = 0;
  providers.forEach(function (p) {
    var wins = windowsOf(p);
    if (!wins.length) { unavailable++; return; }
    var left = Math.min.apply(null, wins.map(function (w) { return w.left; }));
    if (left === 0) exhausted++;
    if (!best || left > best.left) best = { left: left, label: providerLabel(p) };
  });
  return { best: best, exhausted: exhausted, unavailable: unavailable, total: providers.length };
}

export function formatDuration(ms) {
  var mins = Math.max(0, Math.round(ms / 60000));
  var d = Math.floor(mins / 1440);
  var h = Math.floor((mins % 1440) / 60);
  var m = mins % 60;
  if (d > 0) return t("aiUsage.durDH", { d: d, h: h });
  if (h > 0) return t("aiUsage.durHM", { h: h, m: m });
  return t("aiUsage.durM", { m: m });
}

export function formatReset(resetsAt, now) {
  var at = Number(resetsAt);
  if (!Number.isFinite(at) || at <= 0) return t("aiUsage.resetUnknown");
  var diff = at - now;
  if (diff <= 0) return t("aiUsage.resettingNow");
  return t("aiUsage.resetsIn", { duration: formatDuration(diff) });
}

export function formatFreshness(updatedAt, now, failed) {
  var at = Number(updatedAt);
  var prefix = failed ? t("aiUsage.refreshFailed") + " · " : "";
  if (!Number.isFinite(at) || at <= 0) return failed ? t("aiUsage.refreshFailed") : t("aiUsage.notUpdated");
  var age = now - at;
  if (age < 45000) return prefix + t("aiUsage.updatedNow");
  return prefix + t("aiUsage.updatedAgo", { duration: formatDuration(age) });
}

function el(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function windowRow(name, win, now) {
  var left = win ? clampPercent(win.leftPercent) : null;
  var row = el("div", "ai-usage-window");
  var line = el("div", "ai-usage-window-line");
  line.appendChild(el("span", "ai-usage-window-name", name));
  line.appendChild(el("span", "ai-usage-reset", " \u00b7 " + (left == null ? t("aiUsage.noData") : formatReset(win.resetsAt, now))));
  line.appendChild(el("span", "ai-usage-window-value", left == null ? t("aiUsage.unavailable") : t("aiUsage.percentLeft", { percent: left })));
  row.appendChild(line);
  var bar = el("div", "ai-usage-bar ai-usage-" + levelFor(left));
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-label", t("aiUsage.remainingOf", { name: name }) + "; " + t("aiUsage.level." + levelFor(left)));
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  if (left != null) {
    bar.setAttribute("aria-valuenow", String(left));
    bar.setAttribute("aria-valuetext", t("aiUsage.percentLeft", { percent: left }) + "; " + t("aiUsage.level." + levelFor(left)));
  } else {
    bar.setAttribute("aria-valuetext", t("aiUsage.unavailable"));
  }
  var fill = el("span", "ai-usage-bar-fill");
  fill.style.width = (left == null ? 0 : left) + "%";
  bar.appendChild(fill);
  row.appendChild(bar);
  return row;
}

function count(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
}

// Prefer structured translations; message remains the fallback for older servers/clients.
function providerMessage(p, fallback) {
  if (Array.isArray(p.messageParts) && p.messageParts.length) {
    return p.messageParts.map(function (part) { return t(part.key, part.params); }).join(" · ");
  }
  if (p.messageKey) return t(p.messageKey, p.messageParams);
  return p.message ? String(p.message) : fallback;
}

// Status-only card: runtime state and task counts, never a percentage.
function statusCard(p, card, head) {
  card.classList.add("is-status");
  var ready = p.status === "ready";
  head.appendChild(el("span", "ai-usage-badge" + (ready ? " is-ready" : ""), ready ? t("aiUsage.connected") : t("aiUsage.setupNeeded")));
  card.appendChild(head);
  var tasks = p.tasks || {};
  var waiting = count(tasks.awaitingExternal);
  var done = count(tasks.completed);
  if (waiting != null || done != null) {
    card.appendChild(el("div", "ai-usage-metrics",
      t("aiUsage.externalTasks", { waiting: waiting == null ? "–" : waiting, done: done == null ? "–" : done })));
  }
  card.appendChild(el("div", "ai-usage-message", providerMessage(p, t("aiUsage.noPercent"))));
  return card;
}

// The server names two of its providers in Korean ("로컬 (Ollama)", "외부 모델"); the page words them in its own language.
function providerLabel(p) {
  if (p && p.id === "local") return t("aiUsage.providerLocal");
  if (p && p.id === "endpoints") return t("aiUsage.providerEndpoints");
  return (p && (p.label || p.id)) || "";
}

function providerCard(p, now) {
  var card = el("section", "ai-usage-provider");
  card.setAttribute("aria-label", t("aiUsage.providerUsage", { name: providerLabel(p) }));
  var head = el("div", "ai-usage-provider-head");
  var dot = el("span", "ai-usage-dot");
  dot.setAttribute("title", t("aiUsage.providerDot", { name: providerLabel(p) }));
  dot.setAttribute("aria-label", t("aiUsage.providerDot", { name: providerLabel(p) }));
  if (/^#[0-9a-fA-F]{3,8}$/.test(String(p.color || ""))) dot.style.background = p.color;
  head.appendChild(dot);
  head.appendChild(el("span", "ai-usage-provider-name", providerLabel(p)));
  if (!reportsQuota(p)) return statusCard(p, card, head);
  var ready = windowsOf(p).length > 0;
  if (!ready) head.appendChild(el("span", "ai-usage-badge", t("aiUsage.unavailable")));
  card.appendChild(head);
  if (!ready) {
    card.appendChild(el("div", "ai-usage-message", providerMessage(p, t("aiUsage.cannotCheck"))));
    return card;
  }
  if (Array.isArray(p.pools) && p.pools.length) {
    p.pools.forEach(function (pool) {
      var group = el("div", "ai-usage-pool");
      group.appendChild(el("div", "ai-usage-pool-name", pool.label || pool.id));
      if (pool.session) group.appendChild(windowRow(t("aiUsage.window5h"), pool.session, now));
      if (pool.weekly) group.appendChild(windowRow(t("aiUsage.weekly"), pool.weekly, now));
      card.appendChild(group);
    });
    return card;
  }
  if (p.session) card.appendChild(windowRow(t("aiUsage.window5h"), p.session, now));
  if (p.weekly) card.appendChild(windowRow(t("aiUsage.weekly"), p.weekly, now));
  return card;
}

function render() {
  if (!els.btn) return;
  var now = Date.now();
  var data = state.data;
  var sum = summarize(data);
  var stale = !!data && (state.error || now - Number(data.updatedAt) > STALE_MS);
  var level = sum.best ? levelFor(sum.best.left) : "unknown";
  var text;
  var label;
  if (!data) {
    text = state.error ? t("aiUsage.unavailable") : t("aiUsage.loadingShort");   // not "사용량" again beside the label "AI 사용량"
    label = state.error ? t("aiUsage.labelUnavailable") : t("aiUsage.labelLoading");
  } else if (sum.best) {
    text = t("aiUsage.percentLeft", { percent: sum.best.left });
    label = t("aiUsage.labelBest", { name: sum.best.label, percent: sum.best.left });
    if (sum.exhausted) label += "; " + t("aiUsage.labelExhausted", { count: sum.exhausted });
    if (sum.unavailable) label += "; " + t("aiUsage.labelProvidersDown", { count: sum.unavailable });
  } else {
    text = t("aiUsage.unavailable");
    label = t("aiUsage.labelUnavailable");
  }
  if (stale && data) label += "; " + t("aiUsage.labelStale");
  els.btn.dataset.level = level;
  els.btn.classList.toggle("is-stale", stale);
  els.btn.setAttribute("aria-label", label);
  els.value.textContent = text;

  els.list.textContent = "";
  if (data && Array.isArray(data.providers) && data.providers.length) {
    data.providers.forEach(function (p) { els.list.appendChild(providerCard(p, now)); });
  } else {
    els.list.appendChild(el("div", "ai-usage-message", state.error ? t("aiUsage.loadFailed") : t("aiUsage.loadingUsage")));
  }
  els.fresh.textContent = data ? formatFreshness(data.updatedAt, now, state.error) : (state.error ? t("aiUsage.refreshFailed") : t("aiUsage.loadingShort"));
  els.fresh.classList.toggle("is-error", !!state.error);
  if (els.legend) els.legend.textContent = t("aiUsage.legend");
  if (state.open) positionPopover();
}

export function refresh() {
  if (state.inFlight) return Promise.resolve();
  state.inFlight = true;
  var generation = state.generation;
  var requestPath = state.basePath;
  if (els.root) els.root.classList.add("is-loading");
  return fetch(requestPath + "api/ai-usage", { credentials: "same-origin", cache: "no-store" })
    .then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    })
    .then(function (json) {
      if (!json || !Array.isArray(json.providers)) throw new Error("bad response");
      if (generation === state.generation) {
        state.data = json;
        state.error = false;
      }
    })
    .catch(function () { if (generation === state.generation) state.error = true; })
    .then(function () {
      state.inFlight = false;
      if (els.root) els.root.classList.remove("is-loading");
      if (generation === state.generation) { render(); schedule(); }
      else refresh();
    });
}

function schedule() {
  clearTimeout(state.timer);
  state.timer = null;
  if (document.hidden) return;
  state.timer = setTimeout(refresh, POLL_MS);
  // Browser timers are numeric; Node-based ESM smoke tests return Timeout.
  // Do not keep the test process alive solely for this passive refresh.
  if (state.timer && typeof state.timer.unref === "function") state.timer.unref();
}

function setOpen(open, restoreFocus) {
  state.open = open;
  els.pop.hidden = !open;
  els.btn.setAttribute("aria-expanded", open ? "true" : "false");
  clearInterval(state.tick);
  state.tick = null;
  if (open) {
    render();
    positionPopover();
    state.tick = setInterval(render, 30000);
    refresh();
  } else if (restoreFocus) {
    els.btn.focus();
  }
}

// Keep the floating popover below the branding/header and inside the viewport.
export function usagePopoverBounds(anchor, size, viewport, minTop) {
  var margin = 12, floor = Math.max(margin, minTop || margin);
  var height = Math.min(size.height, Math.max(0, viewport.height - floor - margin));
  var width = Math.min(size.width, Math.max(0, viewport.width - margin * 2));
  var top = Math.max(floor, Math.min(anchor.top - height - 8, viewport.height - height - margin));
  var left = Math.max(margin, Math.min(anchor.left, viewport.width - width - margin));
  return { top: top, left: left, width: width, maxHeight: Math.max(0, viewport.height - top - margin) };
}
function positionPopover() {
  if (!els.pop || !els.btn || !els.btn.getBoundingClientRect || !els.pop.getBoundingClientRect || typeof window === "undefined") return;
  if (els.root.classList.contains("is-docked")) {
    // The legacy mobile sheet deliberately keeps its popover in normal flow.
    els.pop.style.cssText = "";
    return;
  }
  var brand = document.querySelector(".ai-brand"), header = document.getElementById("ai-phone-bar");
  var mobile = isMobileWidth();
  var boundary = mobile ? header : brand;
  var minTop = boundary && boundary.getBoundingClientRect ? boundary.getBoundingClientRect().bottom + 12 : 84;
  var v = window.visualViewport;
  var viewport = { width: v ? v.width : window.innerWidth, height: v ? v.height + (v.offsetTop || 0) : window.innerHeight };
  var anchor = els.btn.getBoundingClientRect(), size = els.pop.getBoundingClientRect();
  var b = usagePopoverBounds(anchor, { width: mobile ? viewport.width - 24 : size.width || 320, height: size.height || 400 }, viewport, minTop);
  els.pop.style.position = "fixed";
  els.pop.style.top = b.top + "px";
  els.pop.style.left = b.left + "px";
  els.pop.style.right = "auto";
  els.pop.style.bottom = "auto";
  els.pop.style.width = b.width + "px";
  els.pop.style.maxHeight = b.maxHeight + "px";
  els.pop.style.boxSizing = "border-box";
}

// --- Docking ------------------------------------------------------------------
// The sidebar is display:none at <=768px, so on phones the one widget is moved
// (not cloned) into the mobile "More" sheet and returned when that sheet goes
// away. Moving keeps the ids unique and the state, timers and listeners single.

var MOBILE_QUERY = "(max-width: 768px)";
var home = null;

function isMobileWidth() {
  return typeof window === "undefined" || !window.matchMedia || window.matchMedia(MOBILE_QUERY).matches;
}

function relocate(parent, before) {
  if (state.open) setOpen(false);
  parent.insertBefore(els.root, before && before.parentNode === parent ? before : null);
}

/** Move the widget into `host` (mobile only). Returns whether it is there. */
export function dockAiUsage(host) {
  if (!els.root || !host || !isMobileWidth()) return false;
  if (!home) home = { parent: els.root.parentNode, next: els.root.nextSibling };
  if (els.root.parentNode !== host) relocate(host, null);
  els.root.classList.add("is-docked");
  return true;
}

/** Put the widget back where the markup placed it. */
export function undockAiUsage() {
  if (!els.root || !home || els.root.parentNode === home.parent) return;
  relocate(home.parent, home.next);
  els.root.classList.remove("is-docked");
}

export function initAiUsage(options) {
  state.basePath = options && options.basePath ? options.basePath : "/";
  els.root = document.getElementById("ai-usage");
  if (!els.root || els.btn) return;
  els.btn = document.getElementById("ai-usage-btn");
  els.value = document.getElementById("ai-usage-value");
  els.pop = document.getElementById("ai-usage-popover");
  els.list = document.getElementById("ai-usage-list");
  els.fresh = document.getElementById("ai-usage-fresh");
  els.legend = el("p", "ai-usage-legend", t("aiUsage.legend"));
  els.pop.appendChild(els.legend);
  var refreshBtn = document.getElementById("ai-usage-refresh");
  onLangChange(render);
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("resize", function () { if (state.open) positionPopover(); });
  }

  els.btn.addEventListener("click", function (e) {
    e.stopPropagation();
    setOpen(!state.open);
  });
  refreshBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    refresh();
  });
  document.addEventListener("click", function (e) {
    if (state.open && !els.root.contains(e.target)) setOpen(false);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && state.open) {
      e.stopPropagation();
      setOpen(false, true);
    }
  }, true);
  els.root.addEventListener("focusout", function (e) {
    if (state.open && e.relatedTarget && !els.root.contains(e.relatedTarget)) setOpen(false);
  });
  // Growing past the phone breakpoint hides the sheet's host, so go home.
  if (typeof window !== "undefined" && window.matchMedia) {
    window.matchMedia(MOBILE_QUERY).addEventListener("change", function (ev) {
      if (!ev.matches) undockAiUsage();
    });
  }
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) { clearTimeout(state.timer); state.timer = null; return; }
    var age = state.data ? Date.now() - Number(state.data.updatedAt) : Infinity;
    if (age >= POLL_MS) refresh(); else schedule();
  });

  render();
  refresh();
}

export function setAiUsageScope(basePath) {
  var next = basePath || "/";
  if (next === state.basePath) return;
  state.basePath = next;
  state.generation++;
  state.data = null;
  state.error = false;
  state.open = false;
  clearTimeout(state.timer);
  clearInterval(state.tick);
  state.timer = null;
  state.tick = null;
  if (els.pop) els.pop.hidden = true;
  if (els.btn) els.btn.setAttribute("aria-expanded", "false");
  render();
  refresh();
}

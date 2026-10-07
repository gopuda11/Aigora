// URLs here are built from the request Host header: escape for the HTML
// attribute and keep "</script>" / "<!--" from ending the inline script.
function escAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function jsLit(s) {
  return JSON.stringify(s).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function setupPageHtml(httpsUrl, httpUrl, hasCert, lanMode) {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<link rel="manifest" href="/manifest.json">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<title>Setup - Aigora</title>
<style>
:root{--s-bg:#060810;--s-text:#C8D4E0;--s-accent:#00CFFF;--s-muted:#7A8FA6;--s-border:#1E2E48;--s-dimmer:#3D5068;--s-success:#29D9A8;--s-accent-15:rgba(0,207,255,0.15);--s-success-10:rgba(41,217,168,0.1);--s-success-15:rgba(41,217,168,0.15);--s-accent-06:rgba(0,207,255,0.06);--s-muted-06:rgba(122,143,166,0.06);--s-muted-15:rgba(122,143,166,0.15)}
@media(prefers-color-scheme:light){:root{--s-bg:#F4F7FB;--s-text:#1E2A38;--s-accent:#0099CC;--s-muted:#4A5D72;--s-border:#B4C6D9;--s-dimmer:#8FA4BA;--s-success:#1BA87E;--s-accent-15:rgba(0,153,204,0.15);--s-success-10:rgba(27,168,126,0.1);--s-success-15:rgba(27,168,126,0.15);--s-accent-06:rgba(0,153,204,0.06);--s-muted-06:rgba(74,93,114,0.06);--s-muted-15:rgba(74,93,114,0.15)}}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--s-bg);color:var(--s-text);font-family:system-ui,-apple-system,sans-serif;min-height:100dvh;display:flex;justify-content:center;padding:env(safe-area-inset-top,0) 20px 40px}
.c{max-width:480px;width:100%;padding-top:40px}
h1{color:var(--s-accent);font-size:22px;margin:0 0 4px;text-align:center}
.subtitle{text-align:center;color:var(--s-muted);font-size:13px;margin-bottom:28px}

/* Steps indicator */
.steps-bar{display:flex;gap:6px;margin-bottom:32px}
.steps-bar .pip{flex:1;height:3px;border-radius:2px;background:var(--s-border);transition:background 0.3s}
.steps-bar .pip.done{background:var(--s-success)}
.steps-bar .pip.active{background:var(--s-accent)}

/* Step card */
.step-card{display:none;animation:fadeIn 0.25s ease}
.step-card.active{display:block}
@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}

.step-label{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--s-accent);font-weight:600;margin-bottom:8px}
.step-title{font-size:18px;font-weight:600;margin-bottom:6px}
.step-desc{font-size:14px;line-height:1.6;color:var(--s-muted);margin-bottom:20px}

.instruction{display:flex;gap:12px;margin-bottom:16px}
.inst-num{width:24px;height:24px;border-radius:50%;background:var(--s-accent-15);color:var(--s-accent);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;flex-shrink:0;margin-top:1px}
.inst-text{font-size:14px;line-height:1.6}
.inst-text .note{font-size:12px;color:var(--s-dimmer);margin-top:4px}

.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;background:var(--s-accent);color:#fff;text-decoration:none;padding:12px 24px;border-radius:12px;font-weight:600;font-size:14px;margin:4px 0;border:none;cursor:pointer;font-family:inherit;transition:opacity 0.15s}
.btn:hover{opacity:0.9}
.btn.outline{background:transparent;border:1.5px solid var(--s-border);color:var(--s-text)}
.btn.outline:hover{border-color:var(--s-dimmer)}
.btn.success{background:var(--s-success)}
.btn:disabled{opacity:0.4;cursor:default}

.btn-row{display:flex;gap:8px;margin-top:20px}
.btn-row .btn{flex:1}

.check-status{display:flex;align-items:center;gap:8px;padding:12px 16px;border-radius:10px;font-size:13px;margin:16px 0}
.check-status.ok{background:var(--s-success-10);color:var(--s-success);border:1px solid var(--s-success-15)}
.check-status.warn{background:var(--s-accent-06);border:1px solid var(--s-accent-15);color:var(--s-accent)}
.check-status.pending{background:var(--s-muted-06);border:1px solid var(--s-muted-15);color:var(--s-muted)}

.platform-ios,.platform-android,.platform-desktop{display:none}

.done-card{text-align:center;padding:40px 0}
.done-icon{font-size:48px;margin-bottom:16px}
.done-title{font-size:20px;font-weight:600;margin-bottom:8px}
.done-desc{font-size:14px;color:var(--s-muted);margin-bottom:24px}

.skip-link{display:block;text-align:center;color:var(--s-dimmer);font-size:13px;text-decoration:none;margin-top:12px;cursor:pointer;border:none;background:none;font-family:inherit}
.skip-link:hover{color:var(--s-muted)}
.done-note{font-size:13px;color:var(--s-muted);line-height:1.6;margin-bottom:20px;text-align:left}
.done-note a{color:var(--s-accent);text-decoration:none}
.done-note a:hover{text-decoration:underline}
.done-note .skip-link{display:inline;margin-top:0;font-size:13px}
</style></head><body>
<div class="c">
<h1>Aigora</h1>
<p class="subtitle">Setup your device for the best experience</p>

<div class="steps-bar" id="steps-bar"></div>

<!-- Step: Certificate -->
<div class="step-card" id="step-cert">
  <div class="step-label">Step <span class="step-cur">1</span> of <span class="step-total">3</span></div>
  <div class="step-title">Install certificate</div>
  <div class="step-desc">Encrypt all traffic between this device and the relay. The certificate is generated locally and does not grant any additional access.</div>

  <div class="instruction"><div class="inst-num">1</div>
    <div class="inst-text">Download the certificate.<br>
      <a class="btn" href="/ca/download" style="margin-top:8px">Download Certificate</a>
    </div>
  </div>

  <div class="platform-ios">
    <div class="instruction"><div class="inst-num">2</div>
      <div class="inst-text">Open <b>Settings</b> and tap the <b>Profile Downloaded</b> banner to install.
        <div class="note">If the banner is gone: Settings > General > VPN & Device Management</div>
      </div>
    </div>
    <div class="instruction"><div class="inst-num">3</div>
      <div class="inst-text">Go to <b>Settings > General > About > Certificate Trust Settings</b> and enable full trust.</div>
    </div>
  </div>

  <div class="platform-android">
    <div class="instruction"><div class="inst-num">2</div>
      <div class="inst-text">Open the downloaded file, or go to <b>Settings > Security > Install a certificate > CA certificate</b>.
        <div class="note">Path may vary by device. Search "certificate" in Settings if needed.</div>
      </div>
    </div>
  </div>

  <div class="platform-desktop">
    <div class="instruction"><div class="inst-num">2</div>
      <div class="inst-text">The certificate should be trusted automatically via mkcert. If your browser still shows a warning, run <code>mkcert -install</code> on the host machine.</div>
    </div>
  </div>

  <div id="cert-status" class="check-status pending">Checking HTTPS connection...</div>
  <div class="btn-row">
    <button class="btn" id="cert-retry" onclick="checkHttps()" style="display:none">Retry</button>
    <button class="btn" id="cert-next" onclick="nextStep()" disabled>Verifying...</button>
  </div>
</div>

<!-- Step: Install PWA -->
<div class="step-card" id="step-pwa">
  <div class="step-label">Step <span class="step-cur">2</span> of <span class="step-total">3</span></div>
  <div class="step-title">Add to Home Screen</div>
  <div class="step-desc">Install Aigora as an app for quick access and a full-screen experience.</div>

  <div class="platform-ios">
    <div class="check-status warn">On iOS, push notifications only work from the installed app. This step is required.</div>
    <div id="ios-not-safari" class="check-status warn" style="display:none">You must use <b>Safari</b> to install. Open this page in Safari first.</div>
    <div id="ios-safari-steps">
      <div class="instruction"><div class="inst-num">1</div>
        <div class="inst-text">Tap the <b>Share</b> button <svg width="18" height="18" viewBox="0 0 17.695 26.475" style="vertical-align:middle;margin:0 2px"><g fill="currentColor"><path d="M17.334 10.762v9.746c0 2.012-1.025 3.027-3.066 3.027H3.066C1.026 23.535 0 22.52 0 20.508v-9.746C0 8.75 1.025 7.734 3.066 7.734h2.94v1.573h-2.92c-.977 0-1.514.527-1.514 1.543v9.57c0 1.015.537 1.543 1.514 1.543h11.152c.967 0 1.524-.527 1.524-1.543v-9.57c0-1.016-.557-1.543-1.524-1.543h-2.91V7.734h2.94c2.04 0 3.066 1.016 3.066 3.028Z"/><path d="M8.662 15.889c.42 0 .781-.352.781-.762V5.097l-.058-1.464.654.693 1.484 1.582a.698.698 0 0 0 .528.235c.4 0 .713-.293.713-.694 0-.205-.088-.361-.235-.508l-3.3-3.183c-.196-.196-.362-.264-.567-.264-.195 0-.361.069-.566.264L4.795 4.94a.681.681 0 0 0-.225.508c0 .4.293.694.703.694.186 0 .4-.079.538-.235l1.474-1.582.664-.693-.058 1.465v10.029c0 .41.351.762.771.762Z"/></g></svg> at the bottom of the Safari toolbar.
          <div class="note" id="ios-ipad-hint" style="display:none">On iPad, the Share button is in the top toolbar.</div>
        </div>
      </div>
      <div class="instruction"><div class="inst-num">2</div>
        <div class="inst-text">Scroll down in the share sheet and tap <b>Add to Home Screen</b> <svg width="18" height="18" viewBox="0 0 25 25" style="vertical-align:middle;margin:0 2px"><g fill="currentColor"><path d="m23.40492,1.60784c-1.32504,-1.32504 -3.19052,-1.56912 -5.59644,-1.56912l-10.65243,0c-2.33622,0 -4.2017,0.24408 -5.5267,1.56912c-1.32504,1.34243 -1.56911,3.17306 -1.56911,5.50924l0,10.5827c0,2.40596 0.22665,4.254 1.55165,5.57902c1.34246,1.32501 3.19052,1.5691 5.59647,1.5691l10.60013,0c2.40592,0 4.2714,-0.24408 5.59644,-1.5691c1.325,-1.34245 1.55166,-3.17306 1.55166,-5.57902l0,-10.51293c0,-2.40596 -0.22666,-4.25401 -1.55166,-5.57901zm-0.38355,5.21289l0,11.24518c0,1.51681 -0.20924,2.94643 -1.02865,3.78327c-0.83683,0.83685 -2.30134,1.0635 -3.81815,1.0635l-11.33234,0c-1.51681,0 -2.96386,-0.22665 -3.80073,-1.0635c-0.83683,-0.83684 -1.04607,-2.26646 -1.04607,-3.78327l0,-11.19288c0,-1.5517 0.20924,-3.01617 1.02865,-3.85304c0.83687,-0.83683 2.31876,-1.04607 3.87042,-1.04607l11.28007,0c1.51681,0 2.98132,0.22666 3.81815,1.06353c0.81941,0.81941 1.02865,2.26645 1.02865,3.78327zm-10.53039,12.08205c0.64506,0 1.02861,-0.43586 1.02861,-1.13326l0,-4.34117l4.53294,0c0.66252,0 1.13326,-0.36613 1.13326,-0.99376c0,-0.64506 -0.43586,-1.02861 -1.13326,-1.02861l-4.53294,0l0,-4.53294c0,-0.6974 -0.38355,-1.13326 -1.02861,-1.13326c-0.62763,0 -0.99376,0.45332 -0.99376,1.13326l0,4.53294l-4.51552,0c-0.69737,0 -1.15069,0.38355 -1.15069,1.02861c0,0.62763 0.48817,0.99376 1.15069,0.99376l4.51552,0l0,4.34117c0,0.66252 0.36613,1.13326 0.99376,1.13326z"/></g></svg></div>
      </div>
      <div class="instruction"><div class="inst-num">3</div>
        <div class="inst-text">Tap <b>Add</b> in the top right corner to confirm.</div>
      </div>
    </div>
  </div>

  <div class="platform-android">
    <div class="instruction"><div class="inst-num">1</div>
      <div class="inst-text">Tap the <b>three dots menu</b> <svg width="16" height="16" viewBox="0 0 24 24" style="vertical-align:middle;margin:0 2px"><circle cx="12" cy="4" r="2.5" fill="currentColor"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/><circle cx="12" cy="20" r="2.5" fill="currentColor"/></svg> in the top right corner of Chrome.</div>
    </div>
    <div class="instruction"><div class="inst-num">2</div>
      <div class="inst-text">Tap <b>Install app</b> or <b>Add to Home screen</b>.
        <div class="note">If you don't see it, try <b>Open in Chrome</b> first if using another browser.</div>
      </div>
    </div>
    <div class="instruction"><div class="inst-num">3</div>
      <div class="inst-text">Tap <b>Install</b> in the confirmation dialog.</div>
    </div>
  </div>

  <div class="platform-desktop">
    <div class="instruction"><div class="inst-num">1</div>
      <div class="inst-text">Look for the <b>install icon</b> in the address bar (a monitor with a down arrow).</div>
    </div>
    <div class="instruction"><div class="inst-num">2</div>
      <div class="inst-text">Click it and then click <b>Install</b> to confirm.
        <div class="note">If there is no icon, go to <b>Menu > Install Aigora</b> or <b>Menu > Save and Share > Install</b>.</div>
      </div>
    </div>
  </div>

  <div id="pwa-status" class="check-status pending">After installing, open Aigora from your home screen to continue setup.</div>
  <button class="skip-link" id="pwa-skip" onclick="nextStep()" style="display:none">Skip for now</button>
</div>

<!-- Step 3: Push Notifications -->
<div class="step-card" id="step-push">
  <div class="step-label">Step <span class="step-cur">3</span> of <span class="step-total">3</span></div>
  <div class="step-title">Enable notifications</div>
  <div class="step-desc">Get alerted on your phone when Claude finishes a response, even when the app is in the background.</div>

  <div id="push-needs-https" class="check-status warn" style="display:none">Push notifications require HTTPS. Complete the certificate step first.</div>

  <button class="btn" id="push-enable-btn" onclick="enablePush()" style="width:100%">Enable Push Notifications</button>
  <div id="push-status" class="check-status pending" style="display:none"></div>

  <div class="btn-row">
    <button class="btn" id="push-next" onclick="nextStep()" style="display:none;width:100%">Finish</button>
  </div>
  <button class="skip-link" id="push-skip" onclick="nextStep()">Skip — I'll enable notifications later</button>
</div>

<!-- Done -->
<div class="step-card" id="step-done">
  <div class="done-card">
    <div class="done-icon">&#10003;</div>
    <div class="done-title">All set!</div>
    <div class="done-desc">Your device is configured. You can change these settings anytime from the app.</div>
    <p class="done-note" id="remote-access-note">Want access outside your local network? Options include <a href="https://tailscale.com" target="_blank" rel="noopener">Tailscale</a>, <a href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/" target="_blank" rel="noopener">Cloudflare Tunnel</a>, or your existing VPN. <button class="skip-link" onclick="document.getElementById('remote-access-note').style.display='none'">Dismiss</button></p>
    <a class="btn" id="done-link" href="${escAttr(httpsUrl)}">Open Aigora</a>
  </div>
</div>
</div>

<script>
var httpsUrl = ${jsLit(httpsUrl)};
var httpUrl = ${jsLit(httpUrl)};
var hasCert = ${hasCert ? 'true' : 'false'};
var lanMode = ${lanMode ? 'true' : 'false'};
var isHttps = location.protocol === "https:";
var ua = navigator.userAgent;
var isIOS = /iPhone|iPad|iPod/.test(ua);
var isAndroid = /Android/i.test(ua);
var isStandalone = window.matchMedia("(display-mode:standalone)").matches || navigator.standalone;
var isIPad = /iPad/.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
var isSafari = isIOS && /Safari/.test(ua) && !/CriOS|FxiOS|OPiOS|EdgiOS/.test(ua);

// Platform visibility
var platformClass = isIOS ? "platform-ios" : isAndroid ? "platform-android" : "platform-desktop";
var els = document.querySelectorAll("." + platformClass);
for (var i = 0; i < els.length; i++) els[i].style.display = "block";

// iOS: Safari check and iPad hint
if (isIOS) {
  if (!isSafari) {
    var warn = document.getElementById("ios-not-safari");
    var safariSteps = document.getElementById("ios-safari-steps");
    if (warn) warn.style.display = "flex";
    if (safariSteps) safariSteps.style.display = "none";
  }
  if (isIPad) {
    var hint = document.getElementById("ios-ipad-hint");
    if (hint) hint.style.display = "block";
  }
}

var isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";

function detectPush() {
  if (!("serviceWorker" in navigator) || (!isHttps && !isLocal)) return Promise.resolve(false);
  // If no SW is registered yet, don't wait for .ready (it never resolves)
  if (!navigator.serviceWorker.controller) return Promise.resolve(false);
  return navigator.serviceWorker.ready
    .then(function(reg) { return reg.pushManager.getSubscription(); })
    .then(function(sub) { return !!sub; })
    .catch(function() { return false; });
}

var steps = [];
var currentStep = 0;
var bar = document.getElementById("steps-bar");
var curEls = document.querySelectorAll(".step-cur");
var totalEls = document.querySelectorAll(".step-total");

// Step offset: when continuing from browser setup (PWA was installed), carry over step count
var stepOffset = 0;
if (isStandalone && localStorage.getItem("setup-pending")) {
  stepOffset = parseInt(localStorage.getItem("setup-pending"), 10) || 0;
}

function buildSteps(hasPushSub) {
  steps = [];
  if (hasCert && !isHttps) steps.push("cert");
  if (isAndroid) {
    // Android: push first (works in browser), then PWA as optional
    if ((isHttps || isLocal) && !hasPushSub) steps.push("push");
    if (!isStandalone) steps.push("pwa");
  } else {
    // iOS: PWA required for push, so install first
    if (!isStandalone) steps.push("pwa");
    if ((isHttps || isLocal) && !hasPushSub) steps.push("push");
  }
  steps.push("done");

  // Trigger HTTPS check now that steps are built
  if (steps.indexOf("cert") !== -1) {
    if (isHttps) {
      certStatus.className = "check-status ok";
      certStatus.textContent = "HTTPS connection verified";
      certNext.disabled = false;
      certNext.textContent = "Next";
    } else {
      checkHttps();
    }
  }

  // PWA: mark setup as pending so the app redirects here on first standalone launch
  if (steps.indexOf("pwa") !== -1) {
    var stepsBeforePwa = steps.indexOf("pwa");
    localStorage.setItem("setup-pending", String(stepsBeforePwa + 1));
  }

  // Android: PWA is optional, show skip button and update text
  if (isAndroid && steps.indexOf("pwa") !== -1) {
    var pwaSkip = document.getElementById("pwa-skip");
    var pwaStatus = document.getElementById("pwa-status");
    if (pwaSkip) pwaSkip.style.display = "block";
    if (pwaStatus) pwaStatus.textContent = "Optional: install for quick access and full-screen experience.";
  }

  // Push: show warning if not on HTTPS
  if (!isHttps && !isLocal) {
    pushBtn.style.display = "none";
    pushNeedsHttps.style.display = "flex";
    pushNext.style.display = "block";
    pushNext.textContent = "Finish anyway";
  }

  bar.innerHTML = "";
  var stepCount = steps.length - 1;
  var displayTotal = stepCount + stepOffset;
  if (displayTotal <= 1) {
    bar.style.display = "none";
    var labels = document.querySelectorAll(".step-label");
    for (var i = 0; i < labels.length; i++) labels[i].style.display = "none";
  } else {
    for (var i = 0; i < displayTotal; i++) {
      var pip = document.createElement("div");
      pip.className = "pip" + (i < stepOffset ? " done" : "");
      bar.appendChild(pip);
    }
    for (var i = 0; i < totalEls.length; i++) totalEls[i].textContent = displayTotal;
  }
}

function showStep(idx) {
  currentStep = idx;
  var cards = document.querySelectorAll(".step-card");
  for (var i = 0; i < cards.length; i++) cards[i].classList.remove("active");
  document.getElementById("step-" + steps[idx]).classList.add("active");

  var pips = bar.querySelectorAll(".pip");
  var displayIdx = idx + stepOffset;
  for (var i = 0; i < pips.length; i++) {
    pips[i].className = "pip" + (i < displayIdx ? " done" : i === displayIdx ? " active" : "");
  }

  for (var i = 0; i < curEls.length; i++) curEls[i].textContent = displayIdx + 1;
}

function nextStep() {
  // After cert step on HTTP, redirect to HTTPS for remaining steps
  if (!isHttps && steps[currentStep] === "cert") {
    location.replace(httpsUrl + "/setup" + (lanMode ? "?mode=lan" : ""));
    return;
  }
  if (currentStep < steps.length - 1) showStep(currentStep + 1);
}


// --- Step: Certificate ---
// Same pattern as main page HTTP->HTTPS check: fetch httpsUrl/info (has CORS headers).
// If cert is trusted, fetch succeeds -> enable Next. Otherwise show retry.
var certStatus = document.getElementById("cert-status");
var certNext = document.getElementById("cert-next");
var certRetry = document.getElementById("cert-retry");

function checkHttps() {
  certStatus.className = "check-status pending";
  certStatus.textContent = "Checking HTTPS connection...";
  certRetry.style.display = "none";
  certNext.disabled = true;
  certNext.textContent = "Verifying...";

  var ac = new AbortController();
  setTimeout(function() { ac.abort(); }, 3000);
  fetch(httpsUrl + "/info", { signal: ac.signal, mode: "no-cors" })
    .then(function() {
      // Any response (even opaque/401) means TLS handshake succeeded = cert is trusted
      certStatus.className = "check-status ok";
      certStatus.textContent = "HTTPS connection verified. Certificate is trusted.";
      certNext.disabled = false;
      certNext.textContent = "Next";
      certRetry.style.display = "none";
    })
    .catch(function() {
      certStatus.className = "check-status warn";
      certStatus.textContent = "Certificate not trusted yet. Install it above, then retry.";
      certRetry.style.display = "block";
      certNext.disabled = true;
      certNext.textContent = "Waiting for HTTPS...";
    });
}

// cert check is now triggered inside buildSteps() after steps array is populated

// PWA setup-pending flag is now set inside buildSteps()

// --- Confetti ---
function fireConfetti() {
  var canvas = document.createElement("canvas");
  canvas.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:9999";
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.appendChild(canvas);
  var ctx = canvas.getContext("2d");
  var particles = [];
  var colors = ["#DA7756","#57AB5A","#6CB6FF","#E8D44D","#DB61A2","#F0883E"];
  for (var i = 0; i < 100; i++) {
    var angle = Math.random() * Math.PI * 2;
    var speed = Math.random() * 8 + 4;
    particles.push({
      x: canvas.width / 2,
      y: canvas.height * 0.45,
      vx: Math.cos(angle) * speed * (0.6 + Math.random()),
      vy: Math.sin(angle) * speed * (0.6 + Math.random()) - 4,
      color: colors[Math.floor(Math.random() * colors.length)],
      w: Math.random() * 8 + 4,
      h: Math.random() * 4 + 2,
      rot: Math.random() * 360,
      rotV: (Math.random() - 0.5) * 12,
      alpha: 1
    });
  }
  function tick() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    var alive = false;
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      if (p.alpha <= 0) continue;
      alive = true;
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.35;
      p.vx *= 0.99;
      p.rot += p.rotV;
      p.alpha -= 0.008;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot * Math.PI / 180);
      ctx.globalAlpha = Math.max(0, p.alpha);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (alive) requestAnimationFrame(tick);
    else canvas.parentNode && canvas.parentNode.removeChild(canvas);
  }
  requestAnimationFrame(tick);
}

// --- Step: Push ---
var pushBtn = document.getElementById("push-enable-btn");
var pushStatus = document.getElementById("push-status");
var pushNeedsHttps = document.getElementById("push-needs-https");
var pushNext = document.getElementById("push-next");

function pushDone() {
  pushBtn.style.display = "none";
  pushStatus.style.display = "flex";
  pushStatus.className = "check-status ok";
  pushStatus.textContent = "Push notifications enabled!";
  fireConfetti();
  navigator.serviceWorker.ready.then(function(reg) {
    reg.showNotification("\ud83c\udf89 Welcome to Aigora!", {
      body: "\ud83d\udd14 You\u2019ll be notified when Claude responds.",
      tag: "claude-welcome",
    });
  }).catch(function() {});
  setTimeout(function() { nextStep(); }, 1200);
}

// Push HTTPS check is now done inside buildSteps()

function enablePush() {
  pushBtn.disabled = true;
  pushBtn.textContent = "Requesting permission...";

  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    pushStatus.style.display = "flex";
    pushStatus.className = "check-status warn";
    pushStatus.textContent = "Push notifications are not supported in this browser.";
    pushBtn.style.display = "none";
    pushNext.style.display = "block";
    pushNext.textContent = "Finish anyway";
    return;
  }

  navigator.serviceWorker.register("/sw.js")
    .then(function() { return navigator.serviceWorker.ready; })
    .then(function(reg) {
      return fetch("/api/vapid-public-key", { cache: "no-store" })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (!data.publicKey) throw new Error("No VAPID key");
          var raw = atob(data.publicKey.replace(/-/g, "+").replace(/_/g, "/"));
          var key = new Uint8Array(raw.length);
          for (var i = 0; i < raw.length; i++) key[i] = raw.charCodeAt(i);
          return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        });
    })
    .then(function(sub) {
      var prevEndpoint = localStorage.getItem("push-endpoint");
      localStorage.setItem("push-endpoint", sub.endpoint);
      var payload = { subscription: sub.toJSON() };
      if (prevEndpoint && prevEndpoint !== sub.endpoint) {
        payload.replaceEndpoint = prevEndpoint;
      }
      return fetch("/api/push-subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    })
    .then(pushDone)
    .catch(function(err) {
      pushBtn.disabled = false;
      pushBtn.textContent = "Enable Push Notifications";
      pushStatus.style.display = "flex";
      pushNext.style.display = "block";
      pushNext.textContent = "Finish anyway";
      if (Notification.permission === "denied") {
        pushStatus.className = "check-status warn";
        pushStatus.textContent = "Notification permission was denied. Enable it in browser settings.";
      } else {
        pushStatus.className = "check-status warn";
        pushStatus.textContent = "Could not enable push: " + (err.message || "unknown error");
      }
    });
}

// Done: clear setup-pending flag and link to app
var doneLink = document.getElementById("done-link");
doneLink.onclick = function() {
  localStorage.removeItem("setup-pending");
  localStorage.setItem("setup-done", "1");
};
if (isStandalone) {
  doneLink.href = "/";
} else if (isHttps) {
  doneLink.href = "/";
} else {
  doneLink.href = httpsUrl;
}

// Init: try HTTPS redirect first (same as main page), then build steps
function init() {
  detectPush().then(function(hasPushSub) {
    buildSteps(hasPushSub);
    showStep(0);
  });
}

if (!isHttps && !isLocal) {
  // Try redirecting to HTTPS like the main page does
  fetch("/https-info").then(function(r) { return r.json(); }).then(function(info) {
    if (!info.httpsUrl) { init(); return; }
    var ac = new AbortController();
    setTimeout(function() { ac.abort(); }, 3000);
    fetch(info.httpsUrl + "/info", { signal: ac.signal, mode: "no-cors" })
      .then(function() { location.replace(info.httpsUrl + "/setup" + (lanMode ? "?mode=lan" : "")); })
      .catch(function() { init(); });
  }).catch(function() { init(); });
} else {
  init();
}
</script>
</body></html>`;
}


// --- Build auth page CSS variables from ayu-light theme (same logic as theme.js computeVars) ---
var path = require("path");
var _authTheme = require(path.join(__dirname, "themes", "ayu-light.json"));

function _hexToRgb(hex) {
  hex = hex.replace("#", "");
  return {
    r: parseInt(hex.substring(0, 2), 16),
    g: parseInt(hex.substring(2, 4), 16),
    b: parseInt(hex.substring(4, 6), 16)
  };
}

function _hexToRgba(hex, alpha) {
  var c = _hexToRgb(hex);
  return "rgba(" + c.r + "," + c.g + "," + c.b + "," + alpha + ")";
}

function _mixColors(hex1, hex2, weight) {
  var c1 = _hexToRgb(hex1), c2 = _hexToRgb(hex2);
  var w = weight;
  var r = Math.round(c1.r * w + c2.r * (1 - w));
  var g = Math.round(c1.g * w + c2.g * (1 - w));
  var b = Math.round(c1.b * w + c2.b * (1 - w));
  return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

var _t = {};
var _keys = ["base00","base01","base02","base03","base04","base05","base06","base07",
             "base08","base09","base0A","base0B","base0C","base0D","base0E","base0F"];
for (var _ki = 0; _ki < _keys.length; _ki++) {
  _t[_keys[_ki]] = "#" + _authTheme[_keys[_ki]];
}

var _authVarsObj = {
  "--bg": _t.base00,
  "--bg-alt": _t.base01,
  "--text": _t.base06,
  "--text-muted": _t.base04,
  "--text-dimmer": _t.base03,
  "--accent": _t.base09,
  "--accent-15": _hexToRgba(_t.base09, 0.15),
  "--accent-20": _hexToRgba(_t.base09, 0.20),
  "--border": _t.base02,
  "--input-bg": _mixColors(_t.base01, _t.base02, 0.5),
  "--error": _t.base08,
};

var _authVarsStr = ":root{";
var _avKeys = Object.keys(_authVarsObj);
for (var _vi = 0; _vi < _avKeys.length; _vi++) {
  _authVarsStr += _avKeys[_vi] + ":" + _authVarsObj[_avKeys[_vi]] + ";";
}
_authVarsStr += "}";

// --- Shared CSS for auth pages (Aigora Light theme via CSS variables) ---
var authPageStyles =
  _authVarsStr +
  // Reset & layout
  '*{margin:0;padding:0;box-sizing:border-box}' +
  'body{background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,sans-serif;' +
  'min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:20px}' +
  '.c{max-width:380px;width:100%;text-align:center}' +
  'h1{color:var(--text);font-size:24px;font-weight:700;margin-bottom:6px}' +
  '.sub{color:var(--text-muted);font-size:14px;margin-bottom:28px}' +
  '.field{margin-bottom:16px;text-align:left}' +
  '.field label{display:block;font-size:12px;color:var(--text-muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px}' +
  'input{width:100%;background:var(--input-bg);border:1px solid var(--border);border-radius:12px;' +
  'color:var(--text);font-size:16px;padding:12px 14px;outline:none;font-family:inherit}' +
  'input:focus{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-15)}' +
  'input::placeholder{font-size:14px;color:var(--text-dimmer)}' +
  // PIN digit boxes
  '.pin-wrap{display:flex;gap:8px;justify-content:center}' +
  '.pin-digit{width:44px;height:56px;background:var(--input-bg);border:1.5px solid var(--border);border-radius:8px;' +
  'color:var(--text);font-family:"Courier New",Courier,"Roboto Mono",monospace;font-size:28px;font-weight:700;' +
  'text-align:center;line-height:56px;outline:none;caret-color:transparent;' +
  'transition:border-color 0.15s,box-shadow 0.15s}' +
  '.pin-digit:focus{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-20)}' +
  '.pin-digit.filled{color:var(--text)}' +
  // Legacy single-input fallback
  '.pin-input{font-size:24px;letter-spacing:12px;text-align:center;-webkit-text-security:disc;' +
  'font-family:"Courier New",Courier,"Roboto Mono",monospace}' +
  '.btn{width:100%;background:var(--accent);color:#fff;border:none;border-radius:12px;' +
  'padding:14px;font-size:15px;font-weight:600;cursor:pointer;font-family:inherit;' +
  'transition:opacity 0.15s;margin-top:8px}' +
  '.btn:hover{opacity:0.9}' +
  '.btn:disabled{opacity:0.4;cursor:default}' +
  '.err{color:var(--error);font-size:13px;margin-top:12px;min-height:1.3em}' +
  '.info{color:var(--text-dimmer);font-size:12px;margin-top:16px}' +
  // Step wizard
  '.step{display:none}.step.active{display:block}' +
  '.steps-bar{display:flex;gap:6px;justify-content:center;margin-bottom:28px}' +
  '.steps-dot{width:8px;height:8px;border-radius:50%;background:var(--border);transition:background 0.2s}' +
  '.steps-dot.done{background:var(--accent)}.steps-dot.current{background:var(--accent)}';

// --- Shared JS for PIN digit boxes ---
// initPinBoxes(containerId, hiddenInputId, onComplete) — wires up 6 individual digit inputs
var pinBoxScript =
  'function initPinBoxes(cId,hId,onComplete){' +
  'var wrap=document.getElementById(cId),hidden=document.getElementById(hId);' +
  'var boxes=wrap.querySelectorAll(".pin-digit");' +
  'var digits=["","","","","",""];' +
  'boxes[0].focus();' +
  'function setDigit(idx,v){digits[idx]=v;boxes[idx].value=v?"\\u2022":"";boxes[idx].classList.toggle("filled",v.length>0);syncHidden()}' +
  'for(var i=0;i<boxes.length;i++){(function(idx){' +
  'boxes[idx].addEventListener("input",function(e){' +
  'var raw=this.value.replace(/[^0-9]/g,"");' +
  'if(!raw){setDigit(idx,"");return}' +
  'var v=raw.charAt(raw.length-1);' +
  'setDigit(idx,v);' +
  'if(v&&idx<5)boxes[idx+1].focus();' +
  'if(hidden.value.length===6&&onComplete)onComplete()});' +
  'boxes[idx].addEventListener("keydown",function(e){' +
  'if(e.key==="Backspace"){if(!digits[idx]&&idx>0){setDigit(idx-1,"");boxes[idx-1].focus()}else{setDigit(idx,"")}syncHidden();return}' +
  'if(e.key==="ArrowLeft"&&idx>0)boxes[idx-1].focus();' +
  'if(e.key==="ArrowRight"&&idx<5)boxes[idx+1].focus();' +
  'if(e.key==="Enter"&&hidden.value.length===6&&onComplete){e.preventDefault();onComplete()}});' +
  'boxes[idx].addEventListener("paste",function(e){' +
  'e.preventDefault();var d=(e.clipboardData||window.clipboardData).getData("text").replace(/[^0-9]/g,"").slice(0,6);' +
  'for(var j=0;j<d.length&&j<6;j++){setDigit(j,d.charAt(j))}' +
  'if(d.length>=6){boxes[5].focus();if(onComplete)onComplete()}else if(d.length>0)boxes[d.length].focus()});' +
  'boxes[idx].addEventListener("focus",function(){this.select()});' +
  '})(i)}' +
  'function syncHidden(){var v="";for(var j=0;j<digits.length;j++)v+=digits[j];hidden.value=v}' +
  'wrap.resetPins=window.resetPinBoxes=function(){for(var j=0;j<6;j++){digits[j]="";boxes[j].value="";boxes[j].classList.remove("filled")}hidden.value="";boxes[0].focus()}' +
  '}';

// HTML fragment for 6 PIN digit boxes + hidden input
var pinBoxesHtml =
  '<div class="pin-wrap" id="pin-boxes">' +
  '<input class="pin-digit" type="tel" maxlength="1" inputmode="numeric" autocomplete="off">' +
  '<input class="pin-digit" type="tel" maxlength="1" inputmode="numeric" autocomplete="off">' +
  '<input class="pin-digit" type="tel" maxlength="1" inputmode="numeric" autocomplete="off">' +
  '<input class="pin-digit" type="tel" maxlength="1" inputmode="numeric" autocomplete="off">' +
  '<input class="pin-digit" type="tel" maxlength="1" inputmode="numeric" autocomplete="off">' +
  '<input class="pin-digit" type="tel" maxlength="1" inputmode="numeric" autocomplete="off">' +
  '</div>' +
  '<input type="hidden" id="pin">';

// --- Small ko/en layer for the entry pages (setup, sign-in, invite) ---
// Markup is rendered in its default language; this script switches it by the same rule as the app
// (saved "aigora.lang", else the browser language). data-i = text, data-ih = trusted HTML, data-ip = placeholder,
// data-ia = aria-label ("key" or "key:n" for the {n} placeholder). T(key, {n}) gives runtime messages.
function pageI18n(dict) {
  return '<script>' +
    '(function(){var D=' + JSON.stringify(dict).replace(/</g, '\\u003c') + ';var L;try{L=localStorage.getItem("aigora.lang")}catch(e){}' +
    'if(L!=="ko"&&L!=="en")L=/^ko($|[-_])/i.test(navigator.language||"ko")?"ko":"en";' +
    'document.documentElement.lang=L;' +
    'window.T=function(k,p){var s=(D[L]&&D[L][k])||(D.ko&&D.ko[k])||k;if(p)for(var n in p)s=s.split("{"+n+"}").join(p[n]);return s};' +
    'window.applyPageText=function(){' +
    'var q=function(a,f){var l=document.querySelectorAll("["+a+"]");for(var i=0;i<l.length;i++)f(l[i],l[i].getAttribute(a))};' +
    'q("data-i",function(e,k){e.textContent=T(k)});q("data-ih",function(e,k){e.innerHTML=T(k)});' +
    'q("data-ip",function(e,k){e.setAttribute("placeholder",T(k))});' +
    'q("data-ia",function(e,k){e.setAttribute("aria-label",T(k,{n:e.getAttribute("data-n")||""}))});' +
    'if(D.title)document.title=T("title")};window.applyPageText()})();' +
    '</script>';
}
// Server error strings the pages show, in both languages (anything else is shown as sent).
var serverErrorKeys = {
  'Invalid username or PIN': 'errLogin', 'Invalid setup code': 'errCode', 'Admin already exists': 'errAdminExists',
  'Username is required': 'errUsername', 'PIN must be exactly 6 digits': 'errPin6', 'Invalid request': 'errRequest', 'Request body too large': 'errRequest'
};
var serverErrorScript = 'var SE=' + JSON.stringify(serverErrorKeys) + ';function serverMsg(e,fb){return e?(SE[e]?T(SE[e]):e):T(fb)}';

// HTML for six PIN boxes. `labelKey` names the group; every box is "<digit n>" for assistive tech.
function pinBoxes(id, labelKey) {
  var out = '<div class="pin-wrap" id="' + id + '" role="group" data-ia="' + labelKey + '" aria-label="6자리 PIN">';
  for (var i = 1; i <= 6; i++) out += '<input class="pin-digit" type="tel" maxlength="1" inputmode="numeric" autocomplete="off" enterkeyhint="go" data-ia="pinDigit" data-n="' + i + '" aria-label="PIN ' + i + '번째 자리">';
  return out + '</div>';
}

// --- Admin Setup Page (5 steps: setup code, username, display name, PIN, PIN again) ---
// Same card as sign-in and invite. The setup code is checked by the server on the last step; a wrong code sends the
// person back to the first step with the message.
function adminSetupPageHtml() {
  var dict = {
    ko: {
      title: 'Aⁱgora 서버 설정', h0: '서버 설정', s0: '터미널에 표시된 설정 코드를 입력하세요.', lCode: '설정 코드', pCode: '설정 코드',
      h1: '사용자 이름 정하기', s1: '로그인할 때 쓰는 이름이에요.', lUser: '사용자 이름', pUser: '사용자 이름',
      h2: '어떻게 불러드릴까요?', s2: '대화에서 보이는 이름이에요.', lName: '표시 이름', pName: '내 이름',
      h3: '계정 보호', s3: '빠른 로그인에 쓸 6자리 PIN을 정하세요.', gPin: '새 PIN 6자리',
      h4: 'PIN 확인', s4: '같은 6자리를 한 번 더 입력하세요.', gPin2: 'PIN 확인 6자리', pinDigit: 'PIN {n}번째 자리',
      next: '계속', create: '계정 만들기', mismatch: 'PIN이 서로 다릅니다. 다시 입력하세요.', fail: '설정하지 못했어요', conn: '서버에 연결할 수 없습니다',
      errCode: '설정 코드가 올바르지 않아요. 터미널에 표시된 코드를 다시 확인하세요.', errAdminExists: '이미 관리자 계정이 있어요.', errUsername: '사용자 이름을 입력하세요.',
      errPin6: 'PIN은 숫자 6자리여야 합니다.', errRequest: '요청을 처리할 수 없어요. 다시 시도하세요.', errLogin: '사용자 이름 또는 PIN이 올바르지 않습니다', back: '이전'
    },
    en: {
      title: 'Aⁱgora server setup', h0: 'Set up your server', s0: 'Enter the setup code shown in your terminal.', lCode: 'Setup code', pCode: 'Setup code',
      h1: 'Pick a username', s1: 'You will use it to sign in.', lUser: 'Username', pUser: 'Username',
      h2: 'What should we call you?', s2: 'Your display name is shown in conversations.', lName: 'Display name', pName: 'Your name',
      h3: 'Secure your account', s3: 'Set a 6-digit PIN for quick sign-in.', gPin: 'New 6-digit PIN',
      h4: 'Confirm your PIN', s4: 'Enter the same 6 digits once more.', gPin2: 'Confirm 6-digit PIN', pinDigit: 'PIN digit {n}',
      next: 'Continue', create: 'Create account', mismatch: 'The PINs do not match. Try again.', fail: 'Setup failed', conn: 'Cannot reach the server',
      errCode: 'That setup code is not right. Check the code shown in your terminal.', errAdminExists: 'An admin account already exists.', errUsername: 'Enter a username.',
      errPin6: 'The PIN must be exactly 6 digits.', errRequest: 'The request could not be processed. Try again.', errLogin: 'Invalid username or PIN', back: 'Back'
    }
  };
  function step(n, active, inner) { return '<div class="step' + (active ? ' active' : '') + (n >= 3 ? ' pin-step' : '') + '" id="step' + n + '">' + inner + '</div>'; }
  return '<!DOCTYPE html><html lang="ko"><head>' +
    '<meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
    '<meta name="color-scheme" content="light dark">' +
    '<title>Aⁱgora 서버 설정</title>' +
    appleEntryThemeScript + '<style>' + appleEntryStyles + '</style></head><body><main class="card">' +
    '<img class="mark" src="/icon-192.png" width="56" height="56" alt="" aria-hidden="true">' +
    '<div class="dots" aria-hidden="true"><span class="dot current" id="dot0"></span><span class="dot" id="dot1"></span><span class="dot" id="dot2"></span><span class="dot" id="dot3"></span><span class="dot" id="dot4"></span></div>' +
    step(0, true, '<h1 data-i="h0">서버 설정</h1><div class="sub" data-i="s0">터미널에 표시된 설정 코드를 입력하세요.</div>' +
      '<div class="field"><label for="code" data-i="lCode">설정 코드</label><input class="text" id="code" type="text" maxlength="6" placeholder="설정 코드" data-ip="pCode" autocomplete="off" autocapitalize="characters" spellcheck="false" enterkeyhint="next" autofocus aria-describedby="err0"></div>' +
      '<div class="err" id="err0" role="alert"></div><button class="btn" id="btn0" type="button" disabled data-i="next">계속</button>') +
    step(1, false, '<h1 data-i="h1">사용자 이름 정하기</h1><div class="sub" data-i="s1">로그인할 때 쓰는 이름이에요.</div>' +
      '<div class="field"><label for="username" data-i="lUser">사용자 이름</label><input class="text" id="username" type="text" maxlength="100" placeholder="사용자 이름" data-ip="pUser" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="next" aria-describedby="err1"></div>' +
      '<div class="err" id="err1" role="alert"></div><button class="btn" id="btn1" type="button" disabled data-i="next">계속</button>') +
    step(2, false, '<h1 data-i="h2">어떻게 불러드릴까요?</h1><div class="sub" data-i="s2">대화에서 보이는 이름이에요.</div>' +
      '<div class="field"><label for="displayname" data-i="lName">표시 이름</label><input class="text" id="displayname" type="text" maxlength="30" placeholder="내 이름" data-ip="pName" autocomplete="name" enterkeyhint="next" aria-describedby="err2"></div>' +
      '<div class="err" id="err2" role="alert"></div><button class="btn" id="btn2" type="button" disabled data-i="next">계속</button>') +
    step(3, false, '<h1 data-i="h3">계정 보호</h1><div class="sub" data-i="s3">빠른 로그인에 쓸 6자리 PIN을 정하세요.</div>' + pinBoxes('pin-boxes', 'gPin') + '<input type="hidden" id="pin">' +
      '<div class="err" id="err3" role="alert"></div>') +
    step(4, false, '<h1 data-i="h4">PIN 확인</h1><div class="sub" data-i="s4">같은 6자리를 한 번 더 입력하세요.</div>' + pinBoxes('pin-boxes2', 'gPin2') + '<input type="hidden" id="pin2">' +
      '<div class="err" id="err4" role="alert" aria-live="assertive"></div><button class="btn" id="btn4" type="button" disabled data-i="create">계정 만들기</button>' +
      '<button class="link" id="back4" type="button" data-i="back">이전</button>') +
    pageI18n(dict) +
    '<script>' +
    pinBoxScript + serverErrorScript +
    'var step=0,pinInit=[false,false];' +
    'var $=function(i){return document.getElementById(i)};' +
    'var codeEl=$("code"),usernameEl=$("username"),dnEl=$("displayname"),pinEl=$("pin"),pin2El=$("pin2");' +
    'var steps=[0,1,2,3,4].map(function(i){return $("step"+i)}),dots=[0,1,2,3,4].map(function(i){return $("dot"+i)}),errs=[0,1,2,3,4].map(function(i){return $("err"+i)});' +
    'var btns=[$("btn0"),$("btn1"),$("btn2"),null,$("btn4")];' +
    'function setLoading(b,on){b.classList.toggle("loading",on);if(on)b.setAttribute("aria-busy","true");else b.removeAttribute("aria-busy")}' +
    'function goStep(n){' +
    'steps[step].classList.remove("active");dots[step].classList.remove("current");if(n>step)dots[step].classList.add("done");else dots[step].classList.remove("done");' +
    'step=n;steps[step].classList.add("active");dots[step].classList.add("current");dots[step].classList.remove("done");errs[step].textContent="";' +
    'if(step===0)codeEl.focus();if(step===1)usernameEl.focus();' +
    'if(step===2){dnEl.focus();if(!dnEl.value)dnEl.value=usernameEl.value;btns[2].disabled=dnEl.value.trim().length<1}' +
    'if(step===3){if(!pinInit[0]){pinInit[0]=true;initPinBoxes("pin-boxes","pin",function(){goStep(4)})}else if($("pin-boxes").resetPins)$("pin-boxes").resetPins()}' +
    'if(step===4){btns[4].disabled=true;if(!pinInit[1]){pinInit[1]=true;initPinBoxes("pin-boxes2","pin2",function(){btns[4].disabled=false;doSetup()});' +
    'var bx=$("pin-boxes2").querySelectorAll(".pin-digit");for(var i=0;i<bx.length;i++)bx[i].addEventListener("input",function(){btns[4].disabled=pin2El.value.length!==6})}else if($("pin-boxes2").resetPins)$("pin-boxes2").resetPins()}' +
    '}' +
    // Enter advances on every text step (first press included)
    'function wire(el,i,ok){el.addEventListener("input",function(){btns[i].disabled=!ok()});el.addEventListener("keydown",function(e){if(e.key==="Enter"&&ok()){e.preventDefault();goStep(i+1)}});btns[i].onclick=function(){goStep(i+1)}}' +
    'wire(codeEl,0,function(){return codeEl.value.trim().length>=4});wire(usernameEl,1,function(){return usernameEl.value.trim().length>=1});wire(dnEl,2,function(){return dnEl.value.trim().length>=1});' +
    '$("back4").onclick=function(){goStep(3)};' +
    'function doSetup(){' +
    'if(btns[4].classList.contains("loading"))return;' +
    'if(pinEl.value!==pin2El.value){errs[4].textContent=T("mismatch");if($("pin-boxes2").resetPins)$("pin-boxes2").resetPins();btns[4].disabled=true;return}' +
    'btns[4].disabled=true;setLoading(btns[4],true);errs[4].textContent="";' +
    'fetch("/auth/setup",{method:"POST",headers:{"Content-Type":"application/json"},' +
    'body:JSON.stringify({setupCode:codeEl.value.trim(),username:usernameEl.value.trim(),displayName:dnEl.value.trim(),pin:pinEl.value})})' +
    '.then(function(r){return r.json()})' +
    '.then(function(d){' +
    'if(d.ok){location.href="/";return}' +
    'setLoading(btns[4],false);' +
    'if(d.error==="Invalid setup code"){goStep(0);errs[0].textContent=serverMsg(d.error);return}' +
    'errs[4].textContent=serverMsg(d.error,"fail");btns[4].disabled=pin2El.value.length!==6})' +
    '.catch(function(){setLoading(btns[4],false);errs[4].textContent=T("conn");btns[4].disabled=false})}' +
    'btns[4].onclick=doSetup;' +
    '</script></main></body></html>';
}

// --- Apple-style entry pages (multi-user login + invite) ---
// Standalone stylesheet (does not touch authPageStyles, which other auth pages share).
// Tokens mirror lib/public/css/aigora-app.css (light) with iOS-style dark values.
// The dark palette is shared by the explicit choice (data-theme="dark") and the system fallback.
var appleEntryDark = [
  '--bg:#000;--card:#1c1c1e;--field:#2c2c2e;--text:#f5f5f7;--text-2:#a1a1a6;--muted:#8e8e93;--accent-fill:#0071e3;--accent-text:#409cff;',
  '--border:#3a3a3c;--border-subtle:#2c2c2e;--accent:#0a84ff;--accent-ring:rgba(10,132,255,.35);--accent-soft:rgba(10,132,255,.16);',
  '--danger:#ff453a;--btn-off-bg:#2c2c2e;--btn-off-fg:#636366;--shadow:0 0 0 1px rgba(255,255,255,.04),0 12px 40px rgba(0,0,0,.5)'
].join('');
// Same key as lib/public/aigora/theme.js: an explicit 라이트/다크 choice made in the Aigora settings wins
// over prefers-color-scheme; anything else (or no storage) leaves the system in charge.
var appleEntryThemeScript = '<link rel="icon" href="/favicon.ico" sizes="any"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="manifest" href="/manifest.json">' + '<script>try{var t=localStorage.getItem("aigora.theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}</script>';
var appleEntryStyles = [
  ':root{color-scheme:light dark;--bg:#f5f5f7;--card:#fff;--field:#fff;--text:#1d1d1f;--text-2:#58585d;--muted:#636366;--accent-fill:#0071e3;--accent-text:#0062cc;',
  '--border:#d9d9de;--border-subtle:#e9e9ed;--accent:#007aff;--accent-ring:rgba(0,122,255,.22);--accent-soft:rgba(0,122,255,.10);',
  '--danger:#d70015;--btn-off-bg:#e5e5ea;--btn-off-fg:#a1a1a6;--shadow:0 1px 2px rgba(0,0,0,.04),0 12px 40px rgba(0,0,0,.08)}',
  ':root[data-theme="light"]{color-scheme:light}',
  ':root[data-theme="dark"]{color-scheme:dark;' + appleEntryDark + '}',
  '@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){' + appleEntryDark + '}}',
  '*{margin:0;padding:0;box-sizing:border-box}',
  'html{-webkit-text-size-adjust:100%}',
  'body{background:var(--bg);color:var(--text);min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;',
  'padding:max(16px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(16px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));',
  'overflow-x:hidden;-webkit-font-smoothing:antialiased;',
  'font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Apple SD Gothic Neo","Pretendard",system-ui,sans-serif;font-size:16px;line-height:1.5}',
  '.card{width:100%;max-width:400px;background:var(--card);border:1px solid var(--border-subtle);border-radius:24px;box-shadow:var(--shadow);padding:40px 24px 28px;text-align:center}',
  '.mark{display:block;width:56px;height:56px;margin:0 auto 20px;border-radius:14px}',
  '.mark sup,h1 sup,.sub sup{font-size:.62em;line-height:0;vertical-align:baseline;position:relative;top:-.55em}',
  'h1 sup,.sub sup{color:var(--accent-text);margin:0 1px}',
  'h1{font-size:28px;line-height:1.2;font-weight:700;letter-spacing:-.025em;margin-bottom:8px;overflow-wrap:anywhere}',
  '.sub{color:var(--text-2);font-size:15px;line-height:1.45;margin-bottom:28px;overflow-wrap:anywhere}',
  '.dots{display:flex;gap:6px;justify-content:center;margin-bottom:20px}',
  '.dot{width:6px;height:6px;border-radius:50%;background:var(--border);transition:background .2s,transform .2s}',
  '.dot.current{background:var(--accent);transform:scale(1.25)}.dot.done{background:var(--accent)}',
  '.step{display:none}.step.active{display:block;animation:rise .24s ease-out}',
  '@keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',
  '.field{text-align:left}',
  '.field label{display:block;font-size:13px;font-weight:600;color:var(--text-2);margin-bottom:8px}',
  'input.text{display:block;width:100%;min-height:48px;padding:12px 16px;background:var(--field);color:var(--text);border:1px solid var(--border);border-radius:12px;',
  'font:inherit;font-size:17px;outline:none;-webkit-appearance:none;appearance:none;transition:border-color .15s,box-shadow .15s}',
  'input.text::placeholder{color:var(--muted)}',
  'input.text:focus{border-color:var(--accent);box-shadow:0 0 0 4px var(--accent-ring)}',
  '.pin-wrap{display:flex;gap:8px;justify-content:center}',
  '.pin-digit{flex:1 1 0;min-width:0;max-width:52px;height:56px;padding:0;background:var(--field);color:var(--text);border:1px solid var(--border);border-radius:12px;',
  'font:inherit;font-size:24px;font-weight:600;text-align:center;outline:none;caret-color:transparent;-webkit-appearance:none;appearance:none;',
  'transition:border-color .15s,box-shadow .15s}',
  '.pin-digit:focus{border-color:var(--accent);box-shadow:0 0 0 4px var(--accent-ring)}',
  '.pin-digit.filled{border-color:var(--text-2)}.pin-digit.filled:focus{border-color:var(--accent)}',
  '.pin-digit:disabled{opacity:.5}',
  '.err[role=alert]:not(:empty)::before{content:"\\26A0\\FE0E ";font-weight:700}.err{color:var(--danger);font-size:14px;line-height:1.4;text-align:left;margin-top:10px;min-height:20px;overflow-wrap:anywhere}',
  '.pin-step .err{text-align:center}',
  '.btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:50px;margin-top:12px;padding:12px 16px;border:0;border-radius:12px;',
  'background:var(--accent-fill);color:#fff;font:inherit;font-size:17px;font-weight:600;cursor:pointer;-webkit-tap-highlight-color:transparent;',
  'transition:transform .12s,filter .12s,background-color .15s}',
  '.btn:hover:not(:disabled){filter:brightness(1.06)}',
  '.btn:active:not(:disabled){transform:scale(.98);filter:brightness(.9)}',
  '.btn:disabled{cursor:default;background:var(--btn-off-bg);color:var(--btn-off-fg)}',
  '.btn.loading:disabled{background:var(--accent-fill);color:#fff;cursor:progress}',
  '.btn.loading::before{content:"";width:16px;height:16px;border-radius:50%;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;animation:spin .7s linear infinite}',
  '@keyframes spin{to{transform:rotate(360deg)}}',
  '.link{display:inline-flex;align-items:center;justify-content:center;min-height:44px;margin-top:8px;padding:0 12px;border:0;border-radius:10px;background:none;',
  'color:var(--accent-text);font:inherit;font-size:15px;cursor:pointer;-webkit-tap-highlight-color:transparent}',
  '.link:hover{background:var(--accent-soft)}',
  '.note{margin-top:20px;padding:14px 16px;border-radius:12px;background:var(--bg);color:var(--text-2);font-size:13px;line-height:1.55;text-align:left}',
  '.btn:focus-visible,.link:focus-visible{outline:3px solid var(--accent-ring);outline-offset:2px;box-shadow:0 0 0 1px var(--accent)}',
  '@media (max-width:360px){body{align-items:flex-start;padding-top:max(32px,env(safe-area-inset-top))}',
  '.card{background:transparent;border-color:transparent;box-shadow:none;padding:16px 0}.pin-wrap{gap:4px}h1{font-size:26px}}',
  '@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}',
  '.btn.loading::before{border-top-color:rgba(255,255,255,.4);border-right-color:#fff}}'
].join('');

// --- Multi-user Login Page ---
function multiUserLoginPageHtml() {
  var dict = {
    ko: {
      title: 'Aⁱgora 로그인', h0: '로그인', s0: 'A<sup>i</sup>gora 계정의 사용자 이름을 입력하세요.', lUser: '사용자 이름', pUser: '사용자 이름', next: '계속',
      h1: 'PIN 입력', s1: '6자리 PIN을 입력하세요.', s1n: '{name} 님, 6자리 PIN을 입력하세요.', gPin: '6자리 PIN', pinDigit: 'PIN {n}번째 자리', signin: '로그인', other: '다른 사용자 이름으로 로그인',
      locked: '시도 횟수를 초과했습니다. {min}분 후 다시 시도하세요.', left: ' (남은 시도 {n}회)', conn: '서버에 연결할 수 없습니다',
      errLogin: '사용자 이름 또는 PIN이 올바르지 않습니다', errCode: '설정 코드가 올바르지 않아요.', errAdminExists: '이미 관리자 계정이 있어요.', errUsername: '사용자 이름을 입력하세요.', errPin6: 'PIN은 숫자 6자리여야 합니다.', errRequest: '요청을 처리할 수 없어요. 다시 시도하세요.'
    },
    en: {
      title: 'Aⁱgora sign in', h0: 'Sign in', s0: 'Enter your A<sup>i</sup>gora username.', lUser: 'Username', pUser: 'Username', next: 'Continue',
      h1: 'Enter your PIN', s1: 'Enter your 6-digit PIN.', s1n: '{name}, enter your 6-digit PIN.', gPin: '6-digit PIN', pinDigit: 'PIN digit {n}', signin: 'Sign in', other: 'Use a different username',
      locked: 'Too many attempts. Try again in {min} min.', left: ' ({n} attempts left)', conn: 'Cannot reach the server',
      errLogin: 'Invalid username or PIN', errCode: 'That setup code is not right.', errAdminExists: 'An admin account already exists.', errUsername: 'Enter a username.', errPin6: 'The PIN must be exactly 6 digits.', errRequest: 'The request could not be processed. Try again.'
    }
  };
  return '<!DOCTYPE html><html lang="ko"><head>' +
    '<meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
    '<meta name="color-scheme" content="light dark">' +
    '<title>Aⁱgora 로그인</title>' +
    appleEntryThemeScript + '<style>' + appleEntryStyles + '</style></head><body><main class="card">' +
    '<img class="mark" src="/icon-192.png" width="56" height="56" alt="" aria-hidden="true">' +
    '<div class="dots" aria-hidden="true"><span class="dot current" id="dot0"></span><span class="dot" id="dot1"></span></div>' +

    // Step 1: Username
    '<div class="step active" id="step0">' +
    '<h1 data-i="h0">로그인</h1>' +
    '<div class="sub" data-ih="s0">A<sup>i</sup>gora 계정의 사용자 이름을 입력하세요.</div>' +
    '<div class="field"><label for="username" data-i="lUser">사용자 이름</label>' +
    '<input class="text" id="username" type="text" maxlength="100" placeholder="사용자 이름" data-ip="pUser" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="next" autofocus aria-describedby="err0"></div>' +
    '<div class="err" id="err0" role="alert"></div>' +
    '<button class="btn" id="btn0" type="button" disabled data-i="next">계속</button>' +
    '</div>' +

    // Step 2: PIN
    '<div class="step pin-step" id="step1">' +
    '<h1 data-i="h1">PIN 입력</h1>' +
    '<div class="sub" id="pin-sub" data-i="s1">6자리 PIN을 입력하세요.</div>' +
    pinBoxes('pin-boxes', 'gPin') + '<input type="hidden" id="pin">' +
    '<div class="err" id="err1" role="alert"></div>' +
    '<button class="btn" id="btn1" type="button" disabled data-i="signin">로그인</button>' +
    '<button class="link" id="back" type="button" data-i="other">다른 사용자 이름으로 로그인</button>' +
    '</div>' +

    pageI18n(dict) +
    '<script>' +
    pinBoxScript + serverErrorScript +
    'var step=0,pinReady=false;' +
    'var usernameEl=document.getElementById("username"),pinEl=document.getElementById("pin");' +
    'var steps=[document.getElementById("step0"),document.getElementById("step1")];' +
    'var dots=[document.getElementById("dot0"),document.getElementById("dot1")];' +
    'var btns=[document.getElementById("btn0"),document.getElementById("btn1")];' +
    'var errs=[document.getElementById("err0"),document.getElementById("err1")];' +
    'function setLoading(b,on){b.classList.toggle("loading",on);if(on)b.setAttribute("aria-busy","true");else b.removeAttribute("aria-busy")}' +

    // Restore saved username so users don\'t have to retype it after a PWA session loss
    'try{var saved=(localStorage.getItem("aigora_login_username")||localStorage.getItem("clay_login_username"));if(saved){usernameEl.value=saved;btns[0].disabled=false}}catch(e){}' +

    // The sixth digit signs in at once (the button flag is updated after the box handler, so it is set here).
    'function pinDone(){btns[1].disabled=false;doLogin()}' +
    'function goStep(n){' +
    'steps[step].classList.remove("active");dots[step].classList.remove("current");dots[step].classList.add("done");' +
    'step=n;steps[step].classList.add("active");dots[step].classList.add("current");' +
    'errs[step].textContent="";' +
    'if(step===1){document.getElementById("pin-sub").textContent=T("s1n",{name:usernameEl.value});' +
    'if(pinReady){resetPin();return}pinReady=true;' +
    'initPinBoxes("pin-boxes","pin",pinDone);' +
    'var boxes=document.querySelectorAll(".pin-digit");' +
    'for(var i=0;i<boxes.length;i++)boxes[i].addEventListener("input",function(){if(!btns[1].classList.contains("loading"))btns[1].disabled=pinEl.value.length!==6})}' +
    '}' +

    // Step 1: username validation
    'usernameEl.addEventListener("input",function(){btns[0].disabled=usernameEl.value.length<1});' +
    'usernameEl.addEventListener("keydown",function(e){if(e.key==="Enter"&&!btns[0].disabled)goStep(1)});' +
    'btns[0].onclick=function(){goStep(1)};' +

    'function resetPin(){' +
    'var boxes=document.querySelectorAll(".pin-digit");' +
    'for(var i=0;i<boxes.length;i++)boxes[i].disabled=false;' +
    'if(window.resetPinBoxes)resetPinBoxes();btns[1].disabled=true}' +

    'function goBackToUsername(){' +
    'steps[1].classList.remove("active");dots[1].classList.remove("current");dots[1].classList.remove("done");' +
    'dots[0].classList.remove("done");dots[0].classList.add("current");' +
    'steps[0].classList.add("active");step=0;' +
    'errs[0].textContent="";errs[1].textContent="";usernameEl.focus()}' +
    'document.getElementById("back").onclick=goBackToUsername;' +

    'function doLogin(){' +
    'if(btns[1].classList.contains("loading"))return;' +
    'btns[1].disabled=true;setLoading(btns[1],true);errs[1].textContent="";' +
    'fetch("/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},' +
    'body:JSON.stringify({username:usernameEl.value,pin:pinEl.value})})' +
    '.then(function(r){return r.json()})' +
    '.then(function(d){' +
    // mustChangePin is handled by the main app overlay
    // (showForceChangePinOverlay in app-misc.js): it has a logout escape
    // hatch and proper error display. Reload either way to enter it.
    'if(d.ok){try{localStorage.setItem("aigora_login_username",usernameEl.value)}catch(e){}location.reload();return}' +
    'setLoading(btns[1],false);' +
    'if(d.locked){var boxes=document.querySelectorAll(".pin-digit");' +
    'for(var i=0;i<boxes.length;i++)boxes[i].disabled=true;' +
    'errs[1].textContent=T("locked",{min:Math.ceil(d.retryAfter/60)});' +
    'setTimeout(function(){resetPin()},d.retryAfter*1000);return}' +
    'var msg=serverMsg(d.error,"errLogin");' +
    'if(typeof d.attemptsLeft==="number"&&d.attemptsLeft<=3)msg+=T("left",{n:d.attemptsLeft});' +
    'errs[1].textContent=msg;resetPin()})' +
    '.catch(function(){setLoading(btns[1],false);errs[1].textContent=T("conn");btns[1].disabled=false})}' +
    'btns[1].onclick=doLogin;' +

    '</script></main></body></html>';
}

// --- Invite Registration Page (sign-up: nickname, login ID, 6-digit PIN) ---
function invitePageHtml(inviteCode) {
  var dict = {
    ko: {
      title: 'Aⁱgora 초대', h: 'A<sup>i</sup>gora에 초대됐어요', s: '닉네임, 아이디, PIN을 정하면 바로 입장합니다.', lName: '닉네임', pName: '예: 김민지', lId: '아이디', pId: '영문, 숫자, . _ -  (3~30자)',
      lPin: 'PIN (숫자 6자리)', lPin2: 'PIN 확인', join: '가입하고 입장', note: '아이디와 PIN은 다른 기기에서 다시 로그인할 때 필요하니 기억해 두세요. 이메일은 필요하지 않습니다.',
      mismatch: 'PIN이 서로 다릅니다', fail: '입장할 수 없습니다', conn: '서버에 연결할 수 없습니다',
      errLogin: '사용자 이름 또는 PIN이 올바르지 않습니다', errCode: '설정 코드가 올바르지 않아요.', errAdminExists: '이미 관리자 계정이 있어요.', errUsername: '사용자 이름을 입력하세요.', errPin6: 'PIN은 숫자 6자리여야 합니다.', errRequest: '요청을 처리할 수 없어요. 다시 시도하세요.'
    },
    en: {
      title: 'Aⁱgora invitation', h: 'You are invited to A<sup>i</sup>gora', s: 'Pick a nickname, a login ID and a PIN to join right away.', lName: 'Nickname', pName: 'e.g. Alex Kim', lId: 'Login ID', pId: 'Letters, numbers, . _ -  (3-30 characters)',
      lPin: 'PIN (6 digits)', lPin2: 'Confirm PIN', join: 'Sign up and join', note: 'You need the login ID and PIN to sign in on another device, so keep them somewhere safe. No email is needed.',
      mismatch: 'The PINs do not match', fail: 'Could not join', conn: 'Cannot reach the server',
      errLogin: 'Invalid username or PIN', errCode: 'That setup code is not right.', errAdminExists: 'An admin account already exists.', errUsername: 'Enter a username.', errPin6: 'The PIN must be exactly 6 digits.', errRequest: 'The request could not be processed. Try again.'
    }
  };
  function field(id, labelKey, label, phKey, attrs) {
    return '<div class="field" style="margin-top:14px"><label for="' + id + '" data-i="' + labelKey + '">' + label + '</label><input class="text" id="' + id + '" ' + (phKey ? 'data-ip="' + phKey + '" ' : '') + attrs + '></div>';
  }
  return '<!DOCTYPE html><html lang="ko"><head>' +
    '<meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
    '<meta name="color-scheme" content="light dark">' +
    '<title>Aⁱgora 초대</title>' +
    appleEntryThemeScript + '<style>' + appleEntryStyles + '</style></head><body><main class="card">' +
    '<img class="mark" src="/icon-192.png" width="56" height="56" alt="" aria-hidden="true">' +
    '<h1 data-ih="h">A<sup>i</sup>gora에 초대됐어요</h1>' +
    '<div class="sub" data-i="s">닉네임, 아이디, PIN을 정하면 바로 입장합니다.</div>' +
    '<div style="margin-top:-8px">' +
    field("displayname", "lName", "닉네임", "pName", 'type="text" maxlength="40" placeholder="예: 김민지" autocomplete="nickname" autofocus') +
    field("loginid", "lId", "아이디", "pId", 'type="text" maxlength="30" placeholder="영문, 숫자, . _ -  (3~30자)" autocomplete="username" autocapitalize="none" spellcheck="false"') +
    field("pin", "lPin", "PIN (숫자 6자리)", "", 'type="password" maxlength="6" inputmode="numeric" pattern="[0-9]*" placeholder="••••••" autocomplete="new-password"') +
    field("pin2", "lPin2", "PIN 확인", "", 'type="password" maxlength="6" inputmode="numeric" pattern="[0-9]*" placeholder="••••••" autocomplete="new-password" enterkeyhint="go" aria-describedby="err"') +
    '</div>' +
    '<div class="err" id="err" role="alert"></div>' +
    '<button class="btn" id="join" type="button" disabled data-i="join">가입하고 입장</button>' +
    '<div class="note" data-i="note">아이디와 PIN은 다른 기기에서 다시 로그인할 때 필요하니 기억해 두세요. 이메일은 필요하지 않습니다.</div>' +
    pageI18n(dict) +
    '<script>' +
    serverErrorScript +
    'var inviteCode=' + JSON.stringify(inviteCode) + ';' +
    'var $=function(i){return document.getElementById(i)},nameEl=$("displayname"),idEl=$("loginid"),pinEl=$("pin"),pin2El=$("pin2"),btn=$("join"),err=$("err");' +
    'function setLoading(on){btn.classList.toggle("loading",on);if(on)btn.setAttribute("aria-busy","true");else btn.removeAttribute("aria-busy")}' +
    'function digits(el){el.value=el.value.replace(/[^0-9]/g,"").slice(0,6)}' +
    // A mismatch is told as soon as both PINs are complete, right above the button, and the button stays off until it is fixed.
    'function validate(){err.textContent="";pin2El.removeAttribute("aria-invalid");var both=pinEl.value.length===6&&pin2El.value.length===6,same=pinEl.value===pin2El.value;' +
    'if(both&&!same){err.textContent=T("mismatch");pin2El.setAttribute("aria-invalid","true")}' +
    'btn.disabled=!(nameEl.value.trim().length>=1&&idEl.value.trim().length>=3&&both&&same)}' +
    '[nameEl,idEl].forEach(function(e){e.addEventListener("input",validate)});' +
    '[pinEl,pin2El].forEach(function(e){e.addEventListener("input",function(){digits(e);validate()})});' +
    '[nameEl,idEl,pinEl,pin2El].forEach(function(e){e.addEventListener("keydown",function(ev){if(ev.key==="Enter"){if(!btn.disabled)join();else if(err.textContent){err.scrollIntoView({block:"center"});pin2El.focus()}}})});' +
    'function join(){err.textContent="";' +
    'if(pinEl.value!==pin2El.value){err.textContent=T("mismatch");pin2El.setAttribute("aria-invalid","true");err.scrollIntoView({block:"center"});pin2El.focus();return}' +
    'btn.disabled=true;setLoading(true);' +
    'fetch("/auth/register",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({inviteCode:inviteCode,displayName:nameEl.value.trim(),username:idEl.value.trim(),pin:pinEl.value})})' +
    '.then(function(r){return r.json()}).then(function(d){if(d.ok){location.href="/";return}setLoading(false);err.textContent=serverMsg(d.error,"fail");err.scrollIntoView({block:"center"});btn.disabled=false})' +
    '.catch(function(){setLoading(false);err.textContent=T("conn");btn.disabled=false})}' +
    'btn.onclick=join;' +
    '</script></main></body></html>';
}

// Invalid, expired, revoked or used invite link: same look, Korean text.
function inviteInvalidPageHtml(reason) {
  var which = reason === "Invite expired" ? "expired" : reason === "Invite already used" ? "used" : "bad";
  var dict = {
    ko: {
      title: 'Aⁱgora 초대', h: '초대 링크를 쓸 수 없어요',
      expired: '초대 링크가 만료됐어요. 초대한 사람에게 새 링크를 요청하세요.',
      used: '이미 사용된 초대 링크예요. 가입했다면 로그인 화면에서 아이디와 PIN으로 들어오세요.',
      bad: '올바르지 않거나 취소된 초대 링크예요. 초대한 사람에게 새 링크를 요청하세요.'
    },
    en: {
      title: 'Aⁱgora invitation', h: 'This invitation link cannot be used',
      expired: 'This invitation link has expired. Ask the person who invited you for a new one.',
      used: 'This invitation link was already used. If you signed up, sign in with your login ID and PIN.',
      bad: 'This invitation link is invalid or was cancelled. Ask the person who invited you for a new one.'
    }
  };
  return '<!DOCTYPE html><html lang="ko"><head>' +
    '<meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
    '<meta name="color-scheme" content="light dark">' +
    '<title>Aⁱgora 초대</title>' +
    appleEntryThemeScript + '<style>' + appleEntryStyles + '</style></head><body><main class="card">' +
    '<img class="mark" src="/icon-192.png" width="56" height="56" alt="" aria-hidden="true">' +
    '<h1 data-i="h">초대 링크를 쓸 수 없어요</h1>' +
    '<div class="sub" style="margin-bottom:0" data-i="' + which + '">' + dict.ko[which] + '</div>' +
    pageI18n(dict) +
    '</main></body></html>';
}
// --- SMTP OTP Login Page (2-step wizard: email → OTP code) ---
function smtpLoginPageHtml() {
  return '<!DOCTYPE html><html lang="en"><head>' +
    '<meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
    '<title>Login - Aigora</title>' +
    '<style>' + authPageStyles +
    '.otp-input{width:100%;font-size:24px;letter-spacing:8px;text-align:center;padding:12px;' +
    'background:var(--field-bg);border:1px solid var(--field-border);border-radius:8px;color:var(--fg);' +
    'font-family:monospace;outline:none;box-sizing:border-box}' +
    '.otp-input:focus{border-color:var(--accent)}' +
    '.resend-row{text-align:center;margin-top:12px;font-size:13px;color:var(--muted)}' +
    '.resend-link{color:var(--accent);cursor:pointer;text-decoration:underline;background:none;border:none;font:inherit}' +
    '.resend-link:disabled{color:var(--muted);cursor:default;text-decoration:none}' +
    '</style></head><body><div class="c">' +
    '<div class="steps-bar"><span class="steps-dot current" id="dot0"></span><span class="steps-dot" id="dot1"></span></div>' +

    // Step 1: Email
    '<div class="step active" id="step0">' +
    '<h1>Welcome back</h1>' +
    '<div class="sub">Enter your email to receive a login code</div>' +
    '<div class="field"><label>Email</label>' +
    '<input id="email" type="email" maxlength="100" placeholder="you@example.com" autocomplete="email" autofocus></div>' +
    '<button class="btn" id="btn0" disabled>Send Code</button>' +
    '<div class="err" id="err0"></div>' +
    '</div>' +

    // Step 2: OTP Code
    '<div class="step" id="step1">' +
    '<h1>Check your inbox</h1>' +
    '<div class="sub">Enter the 6-digit code sent to your email</div>' +
    '<input class="otp-input" id="otp" type="tel" maxlength="6" inputmode="numeric" placeholder="000000" autocomplete="one-time-code">' +
    '<button class="btn" id="btn1" disabled style="margin-top:20px">Log In</button>' +
    '<div class="resend-row"><button class="resend-link" id="resend" disabled>Resend code (<span id="countdown">60</span>s)</button></div>' +
    '<div class="err" id="err1"></div>' +
    '</div>' +

    // PIN fallback (hidden username+PIN form)
    '<div id="pin-fallback" style="display:none">' +
    '<h1>Log in with PIN</h1>' +
    '<div class="sub">Use your username and PIN instead</div>' +
    '<div class="field"><label>Username</label>' +
    '<input id="fb-username" type="text" maxlength="100" placeholder="Username" autocomplete="username"></div>' +
    '<div class="field" style="margin-top:12px"><label>PIN</label>' +
    '<input id="fb-pin" type="password" maxlength="6" inputmode="numeric" placeholder="6-digit PIN" autocomplete="current-password"></div>' +
    '<button class="btn" id="fb-btn" disabled style="margin-top:16px">Log In</button>' +
    '<div class="err" id="fb-err"></div>' +
    '<div class="resend-row"><button class="resend-link" id="fb-back">Back to email login</button></div>' +
    '</div>' +

    '<div class="resend-row" id="pin-link-row"><button class="resend-link" id="pin-link">Log in with PIN instead</button></div>' +

    '<script>' +
    'var step=0,cooldown=0,cooldownTimer=null;' +
    'var emailEl=document.getElementById("email"),otpEl=document.getElementById("otp");' +
    'var steps=[document.getElementById("step0"),document.getElementById("step1")];' +
    'var dots=[document.getElementById("dot0"),document.getElementById("dot1")];' +
    'var btns=[document.getElementById("btn0"),document.getElementById("btn1")];' +
    'var errs=[document.getElementById("err0"),document.getElementById("err1")];' +
    'var resendBtn=document.getElementById("resend"),cdSpan=document.getElementById("countdown");' +

    'function goStep(n){' +
    'steps[step].classList.remove("active");dots[step].classList.remove("current");dots[step].classList.add("done");' +
    'step=n;steps[step].classList.add("active");dots[step].classList.add("current");' +
    'errs[step].textContent="";' +
    'if(step===1){otpEl.value="";otpEl.focus()}' +
    '}' +

    'function startCooldown(){' +
    'cooldown=60;resendBtn.disabled=true;' +
    'cdSpan.textContent=cooldown;' +
    'if(cooldownTimer)clearInterval(cooldownTimer);' +
    'cooldownTimer=setInterval(function(){cooldown--;cdSpan.textContent=cooldown;' +
    'if(cooldown<=0){clearInterval(cooldownTimer);cooldownTimer=null;resendBtn.disabled=false;' +
    'resendBtn.innerHTML="Resend code"}},1000)}' +

    // Step 1: email validation + send OTP
    'emailEl.addEventListener("input",function(){btns[0].disabled=emailEl.value.length<1});' +
    'emailEl.addEventListener("keydown",function(e){if(e.key==="Enter"&&!btns[0].disabled)requestCode()});' +

    'function requestCode(){' +
    'btns[0].disabled=true;errs[0].textContent="";' +
    'fetch("/auth/request-otp",{method:"POST",headers:{"Content-Type":"application/json"},' +
    'body:JSON.stringify({email:emailEl.value})})' +
    '.then(function(r){return r.json()})' +
    '.then(function(d){' +
    'if(d.ok){goStep(1);startCooldown();return}' +
    'if(d.locked){errs[0].textContent="Too many attempts. Try again in "+Math.ceil(d.retryAfter/60)+" min";return}' +
    'errs[0].textContent=d.error||"Failed to send code";btns[0].disabled=false})' +
    '.catch(function(){errs[0].textContent="Connection error";btns[0].disabled=false})}' +
    'btns[0].onclick=requestCode;' +

    // Step 2: OTP validation
    'otpEl.addEventListener("input",function(){' +
    'var v=this.value.replace(/[^0-9]/g,"");if(v.length>6)v=v.slice(0,6);this.value=v;' +
    'btns[1].disabled=v.length!==6;' +
    'if(v.length===6)doLogin()});' +
    'otpEl.addEventListener("keydown",function(e){if(e.key==="Enter"&&!btns[1].disabled)doLogin()});' +

    // Resend
    'resendBtn.onclick=function(){' +
    'resendBtn.disabled=true;' +
    'fetch("/auth/request-otp",{method:"POST",headers:{"Content-Type":"application/json"},' +
    'body:JSON.stringify({email:emailEl.value})})' +
    '.then(function(r){return r.json()})' +
    '.then(function(d){if(d.ok){startCooldown();errs[1].textContent=""}' +
    'else{errs[1].textContent=d.error||"Failed to resend";resendBtn.disabled=false}})' +
    '.catch(function(){errs[1].textContent="Connection error";resendBtn.disabled=false})};' +

    'function doLogin(){' +
    'btns[1].disabled=true;errs[1].textContent="";' +
    'fetch("/auth/verify-otp",{method:"POST",headers:{"Content-Type":"application/json"},' +
    'body:JSON.stringify({email:emailEl.value,code:otpEl.value})})' +
    '.then(function(r){return r.json()})' +
    '.then(function(d){' +
    'if(d.ok){location.reload();return}' +
    'if(d.locked){otpEl.disabled=true;' +
    'errs[1].textContent="Too many attempts. Try again in "+Math.ceil(d.retryAfter/60)+" min";' +
    'setTimeout(function(){otpEl.disabled=false;otpEl.value="";btns[1].disabled=true;otpEl.focus()},d.retryAfter*1000);return}' +
    'var msg=d.error||"Invalid code";' +
    'if(typeof d.attemptsLeft==="number")msg+=" ("+d.attemptsLeft+" left)";' +
    'errs[1].textContent=msg;otpEl.value="";btns[1].disabled=true;otpEl.focus()})' +
    '.catch(function(){errs[1].textContent="Connection error";btns[1].disabled=false})}' +
    'btns[1].onclick=doLogin;' +

    // PIN fallback logic
    'var pinFb=document.getElementById("pin-fallback"),pinLinkRow=document.getElementById("pin-link-row");' +
    'var fbUser=document.getElementById("fb-username"),fbPin=document.getElementById("fb-pin");' +
    'var fbBtn=document.getElementById("fb-btn"),fbErr=document.getElementById("fb-err");' +
    'document.getElementById("pin-link").onclick=function(){' +
    'steps[step].classList.remove("active");dots[step].classList.remove("current");' +
    'pinFb.style.display="block";pinLinkRow.style.display="none";' +
    'document.querySelector(".steps-bar").style.display="none";fbUser.focus()};' +
    'document.getElementById("fb-back").onclick=function(){' +
    'pinFb.style.display="none";pinLinkRow.style.display="";' +
    'document.querySelector(".steps-bar").style.display="";' +
    'step=0;steps[0].classList.add("active");dots[0].classList.add("current");emailEl.focus()};' +
    'function checkFb(){fbBtn.disabled=!(fbUser.value.length>0&&fbPin.value.length===6)}' +
    'fbUser.addEventListener("input",checkFb);fbPin.addEventListener("input",checkFb);' +
    'function doPinLogin(){' +
    'fbBtn.disabled=true;fbErr.textContent="";' +
    'fetch("/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},' +
    'body:JSON.stringify({username:fbUser.value,pin:fbPin.value})})' +
    '.then(function(r){return r.json()})' +
    '.then(function(d){' +
    'if(d.ok){location.reload();return}' +
    'var msg=d.error||"Invalid credentials";' +
    'if(typeof d.attemptsLeft==="number"&&d.attemptsLeft<=3)msg+=" ("+d.attemptsLeft+" left)";' +
    'fbErr.textContent=msg;fbPin.value="";fbBtn.disabled=true;fbPin.focus()})' +
    '.catch(function(){fbErr.textContent="Connection error";fbBtn.disabled=false})}' +
    'fbBtn.onclick=doPinLogin;' +
    'fbPin.addEventListener("keydown",function(e){if(e.key==="Enter"&&!fbBtn.disabled)doPinLogin()});' +

    '</script></div></body></html>';
}

// --- No Projects Assigned Page (multi-user: user has no accessible projects) ---
function noProjectsPageHtml() {
  return '<!DOCTYPE html><html lang="en"><head>' +
    '<meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
    '<title>Aigora</title>' +
    '<style>' + authPageStyles + '</style></head><body><div class="c">' +
    '<h1>Hang tight!</h1>' +
    '<div class="sub">No projects have been assigned to your account yet.</div>' +
    '<div class="info">Ask an admin to grant you access to a project.</div>' +
    '</div></body></html>';
}

module.exports = { setupPageHtml: setupPageHtml, adminSetupPageHtml: adminSetupPageHtml, multiUserLoginPageHtml: multiUserLoginPageHtml, smtpLoginPageHtml: smtpLoginPageHtml, invitePageHtml: invitePageHtml, inviteInvalidPageHtml: inviteInvalidPageHtml, noProjectsPageHtml: noProjectsPageHtml };

import { copyToClipboard } from './utils.js';

function getShareUrl() {
  var url = window.location.href;
  var h = window.location.hostname;
  if ((h === "localhost" || h === "127.0.0.1") && window.__lanHost) {
    url = url.replace(h + ":" + window.location.port, window.__lanHost);
  }
  return url;
}

function setQrUrlText(el, url) {
  // textContent, not innerHTML: the URL is derived from window.location.
  el.textContent = url;
  var hint = document.createElement("span");
  hint.className = "qr-hint";
  hint.textContent = "click to copy";
  el.appendChild(hint);
}

export function triggerShare() {
  var url = getShareUrl();

  // Use Web Share API on mobile only
  var isMobile = window.innerWidth <= 768 || /Mobi|Android/i.test(navigator.userAgent);
  if (isMobile && navigator.share) {
    navigator.share({ title: document.title || "Aigora", url: url }).catch(function () {});
    return;
  }

  // Show QR overlay
  var qrOverlay = document.getElementById("qr-overlay");
  var qrCanvas = document.getElementById("qr-canvas");
  var qrUrl = document.getElementById("qr-url");
  var qrShareBtn = document.getElementById("qr-share-btn");

  var qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  qrCanvas.innerHTML = qr.createSvgTag(5, 0);
  setQrUrlText(qrUrl, url);

  // Show browser share button if Web Share API is available
  if (qrShareBtn) {
    if (navigator.share) {
      qrShareBtn.classList.remove("hidden");
    } else {
      qrShareBtn.classList.add("hidden");
    }
  }

  qrOverlay.classList.remove("hidden");
}

export function initQrCode() {
  var qrOverlay = document.getElementById("qr-overlay");
  var qrUrl = document.getElementById("qr-url");

  // click URL to copy
  qrUrl.addEventListener("click", function () {
    var url = getShareUrl();
    copyToClipboard(url).then(function () {
      qrUrl.innerHTML = "Copied!";
      qrUrl.classList.add("copied");
      setTimeout(function () {
        setQrUrlText(qrUrl, url);
        qrUrl.classList.remove("copied");
      }, 1500);
    });
  });

  qrOverlay.addEventListener("click", function () {
    qrOverlay.classList.add("hidden");
  });

  // prevent closing when clicking the inner card
  document.getElementById("qr-overlay-inner").addEventListener("click", function (e) {
    e.stopPropagation();
  });

  // Browser share button
  var qrShareBtn = document.getElementById("qr-share-btn");
  if (qrShareBtn) {
    qrShareBtn.addEventListener("click", function () {
      var url = getShareUrl();
      navigator.share({ title: document.title || "Aigora", url: url }).catch(function () {});
    });
  }

  // ESC to close
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !qrOverlay.classList.contains("hidden")) {
      qrOverlay.classList.add("hidden");
    }
  });
}

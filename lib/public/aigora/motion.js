// motion.js - Motion tokens for script-driven animation, and the helpers that use them.
// The CSS side of the same tokens is --ai-in / --ai-out / --ai-ease / --ai-ease-x in
// aigora-app.css (test/aigora-motion.test.js keeps the two in step).
//
// Everything here is decoration: it plays a Web Animation on an element whose real
// final state is already in the DOM/CSS. Nothing waits for an animation to finish, so a
// missing animate(), a throttled tab or reduced motion changes how it looks, never what
// state it is in. Only transform and opacity are animated here. (The sidebar disclosure,
// the list column, the inspector and the popover are CSS transitions driven by classes and
// attributes; see aigora-app.css.)

export var ENTER_MS = 180;
export var EXIT_MS = 120;
export var EASE_ENTER = "cubic-bezier(.2,.8,.2,1)";
export var EASE_EXIT = "cubic-bezier(.4,0,1,1)";
export var RISE_PX = 4;

// The OS preference or the in-app 동작 줄이기 switch (data-reduce-motion on <html>).
export function reducedMotion() {
  try {
    if (document.documentElement.getAttribute("data-reduce-motion") === "1") return true;
  } catch (e) { /* no document */ }
  try {
    return !!(typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  } catch (e) { return false; }
}

function play(el, frames, ms, easing) {
  if (!el || typeof el.animate !== "function" || reducedMotion()) return null;
  try { return el.animate(frames, { duration: ms, easing: easing, fill: "none" }); } catch (e) { return null; }
}

// Content switch (room, session) and a new message: a small rise plus fade.
export function riseIn(el) {
  return play(el, [{ opacity: 0, transform: "translateY(" + RISE_PX + "px)" }, { opacity: 1, transform: "none" }], ENTER_MS, EASE_ENTER);
}

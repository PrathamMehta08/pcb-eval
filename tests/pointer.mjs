// Selection and panning, against the pointer sequence a browser really sends.
//
// This exists because of a bug a green suite could not see. `attachPanZoom`
// takes pointer capture on the SVG root so a pan can leave the element it
// started on — and capture retargets the `click` that follows to the root, so
// the old `click` listener asked the root for the element under the cursor and
// got nothing. Every board view was read-only: the track, via and pour editors
// had no way in, and the check that claimed they were reachable was a grep for
// the operation's name in app.js.
//
// So the test is the event sequence, not the source text. `attachPanZoom`
// touches only a handful of DOM methods; a stub provides them, and the cases
// below drive pointerdown/move/up exactly as Chrome does.
//
//   node tests/pointer.mjs

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { attachPanZoom } = await import("file://" + join(root, "site", "render.js"));

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

/** Just enough of an SVGElement for attachPanZoom, plus a way to fire events. */
function fakeSvg(width = 610, height = 460) {
  const listeners = new Map();
  const attrs = { viewBox: "0 0 61 46" };
  const svg = {
    attrs,
    captured: null,
    classes: new Set(),
    style: { setProperty() {} },
    classList: {
      add: (c) => svg.classes.add(c),
      remove: (c) => svg.classes.delete(c),
      contains: (c) => svg.classes.has(c),
      toggle: (c, on) => (on ? svg.classes.add(c) : svg.classes.delete(c)),
    },
    getAttribute: (k) => attrs[k],
    setAttribute: (k, v) => (attrs[k] = v),
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
    setPointerCapture: (id) => (svg.captured = id),
    hasPointerCapture: (id) => svg.captured === id,
    releasePointerCapture: () => (svg.captured = null),
    fire(type, event) {
      for (const fn of listeners.get(type) || []) fn(event);
    },
  };
  return svg;
}

/** A pointer event whose target answers `closest` the way the real DOM does. */
function pointer(x, y, hit = null) {
  return {
    button: 0,
    pointerId: 1,
    clientX: x,
    clientY: y,
    preventDefault() {},
    target: { closest: (selector) => (hit && selector === "[data-kind]" ? hit : null) },
  };
}

const trackNode = { dataset: { kind: "track", id: "t7", net: "GND" }, closest: () => null };

// A press and release on a track, with no movement, is a selection.
{
  const svg = fakeSvg();
  const taps = [];
  attachPanZoom(svg, { onTap: (t) => taps.push(t) });
  svg.fire("pointerdown", pointer(100, 100, trackNode));
  svg.fire("pointerup", pointer(100, 100, trackNode));
  check(taps.length === 1, `a tap on a track reports once, got ${taps.length}`);
  check(taps[0] === trackNode, "and reports the element that was under it");
}

// The same press with a pixel of jitter is still a tap — fingers and trackpads
// never land perfectly still.
{
  const svg = fakeSvg();
  const taps = [];
  attachPanZoom(svg, { onTap: (t) => taps.push(t) });
  svg.fire("pointerdown", pointer(100, 100, trackNode));
  svg.fire("pointermove", pointer(101, 102, trackNode));
  svg.fire("pointerup", pointer(101, 102, trackNode));
  check(taps.length === 1 && taps[0] === trackNode, "two pixels of jitter is still a tap");
}

// A real drag pans and selects nothing.
{
  const svg = fakeSvg();
  const taps = [];
  attachPanZoom(svg, { onTap: (t) => taps.push(t) });
  const before = svg.getAttribute("viewBox");
  svg.fire("pointerdown", pointer(100, 100, trackNode));
  svg.fire("pointermove", pointer(160, 140, trackNode));
  svg.fire("pointerup", pointer(160, 140, trackNode));
  check(taps.length === 0, "a drag is not a tap");
  check(svg.getAttribute("viewBox") !== before, "and it panned the view");
}

// A tap on nothing clears the selection.
{
  const svg = fakeSvg();
  const taps = [];
  attachPanZoom(svg, { onTap: (t) => taps.push(t) });
  svg.fire("pointerdown", pointer(20, 20, null));
  svg.fire("pointerup", pointer(20, 20, null));
  check(taps.length === 1 && taps[0] === null, "a tap on empty space reports null");
}

// When the caller claims the gesture — a footprint drag — panning must not
// start and the tap must not fire, or a drag would also select and re-render.
{
  const svg = fakeSvg();
  const taps = [];
  const claimed = [];
  attachPanZoom(svg, {
    onTap: (t) => taps.push(t),
    onPointerDown: (event, target) => {
      claimed.push(target);
      return true;
    },
  });
  const before = svg.getAttribute("viewBox");
  svg.fire("pointerdown", pointer(100, 100, trackNode));
  svg.fire("pointermove", pointer(160, 140, trackNode));
  svg.fire("pointerup", pointer(160, 140, trackNode));
  check(claimed.length === 1, "the caller is offered the element under the pointer");
  check(taps.length === 0, "a claimed gesture reports no tap");
  check(svg.getAttribute("viewBox") === before, "and does not pan");
}

// Panning takes capture; that is what broke `click`, and it must stay taken.
{
  const svg = fakeSvg();
  attachPanZoom(svg, { onTap: () => {} });
  svg.fire("pointerdown", pointer(100, 100, null));
  check(svg.captured === 1, "panning captures the pointer, so a drag can leave the element");
  svg.fire("pointerup", pointer(100, 100, null));
  check(svg.captured === null, "and releases it");
}

// Wheel zoom keeps the point under the cursor where it is.
{
  const svg = fakeSvg();
  attachPanZoom(svg);
  svg.fire("wheel", { ...pointer(305, 230), deltaY: -400 });
  const [x, y, w, h] = svg.getAttribute("viewBox").split(" ").map(Number);
  check(w < 61 && h < 46, `zooming in shrinks the view, got ${w} x ${h}`);
  check(
    Math.abs(x + w / 2 - 30.5) < 0.2 && Math.abs(y + h / 2 - 23) < 0.2,
    `the centre of the view stays under the cursor, got ${x + w / 2}, ${y + h / 2}`
  );
}

for (const failure of failures) console.error("  x " + failure);
console.log(
  failures.length
    ? `${failures.length} pointer checks failed`
    : "tap selects, jitter still taps, drag pans, empty space clears, a claimed gesture does neither"
);
process.exit(failures.length ? 1 : 0);

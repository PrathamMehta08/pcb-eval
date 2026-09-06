// The three views, drawn from the Board object rather than from KiCad's plots.
//
// The schematic is KiCad's own SVG export nested inside ours, so it pans and
// zooms with everything else — but it is a picture, and edits cannot change it.
// Markers are drawn over it instead, at component level, from the symbol
// positions in the .kicad_sch.
//
// Layout and routing are drawn element by element out of Board.layout, because
// every track, pad, via and pour has to be individually selectable and mutable.
// That is about 700 nodes for this board, which needs no virtualisation.
//
// Coordinates are board-relative millimetres throughout, so the viewBox is
// "0 0 width height" and one user unit is one millimetre. `place()` is the same
// transform as extract/layout.py `place()`: KiCad's RotatePoint, y down,
// positive angles counter-clockwise. Pad angles are stored absolute — they
// already include the footprint's own rotation — so a pad inside a rotated
// footprint group needs the difference, not the sum.

// `place` is KiCad's RotatePoint and lives in copper.js, which needs it to put
// pads in board coordinates. One definition, used by both.
import { place } from "./copper.js";

const SVG_NS = "http://www.w3.org/2000/svg";

export function el(name, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child) node.appendChild(child);
  }
  return node;
}

const f = (n) => Number(n).toFixed(3);

// ------------------------------------------------------------------- outline

function arcPath(x1, y1, mx, my, x2, y2) {
  // Three points on a circle; SVG wants a radius, a sweep and a large-arc flag.
  const d =
    2 * (x1 * (my - y2) + mx * (y2 - y1) + x2 * (y1 - my));
  if (Math.abs(d) < 1e-9) return `L ${f(x2)} ${f(y2)}`; // collinear: a line
  const s1 = x1 * x1 + y1 * y1;
  const s2 = mx * mx + my * my;
  const s3 = x2 * x2 + y2 * y2;
  const ux = (s1 * (my - y2) + s2 * (y2 - y1) + s3 * (y1 - my)) / d;
  const uy = (s1 * (x2 - mx) + s2 * (x1 - x2) + s3 * (mx - x1)) / d;
  const r = Math.hypot(x1 - ux, y1 - uy);

  const angle = (px, py) => Math.atan2(py - uy, px - ux);
  const span = (a, b) => {
    let delta = b - a;
    while (delta < 0) delta += 2 * Math.PI;
    return delta;
  };
  const a1 = angle(x1, y1);
  const toMid = span(a1, angle(mx, my));
  const toEnd = span(a1, angle(x2, y2));
  const sweep = toMid <= toEnd ? 1 : 0;
  const arc = sweep ? toEnd : 2 * Math.PI - toEnd;
  return `A ${f(r)} ${f(r)} 0 ${arc > Math.PI ? 1 : 0} ${sweep} ${f(x2)} ${f(y2)}`;
}

function outlinePath(outline) {
  // Edge.Cuts is a bag of unordered segments; chain them so the result is one
  // closed path that can be filled as the board substrate.
  const items = outline.filter((i) => i.kind !== "circle");
  const circles = outline.filter((i) => i.kind === "circle");
  const used = new Array(items.length).fill(false);
  const near = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by) < 0.01;
  let path = "";

  for (let start = 0; start < items.length; start++) {
    if (used[start]) continue;
    used[start] = true;
    let head = items[start];
    let [cx, cy] = [head.x2, head.y2];
    path += ` M ${f(head.x1)} ${f(head.y1)} ${segmentTo(head, false)}`;

    let extended = true;
    while (extended) {
      extended = false;
      for (let i = 0; i < items.length; i++) {
        if (used[i]) continue;
        const item = items[i];
        if (near(cx, cy, item.x1, item.y1)) {
          path += " " + segmentTo(item, false);
          [cx, cy] = [item.x2, item.y2];
        } else if (near(cx, cy, item.x2, item.y2)) {
          path += " " + segmentTo(item, true);
          [cx, cy] = [item.x1, item.y1];
        } else {
          continue;
        }
        used[i] = true;
        extended = true;
        break;
      }
    }
    if (near(cx, cy, head.x1, head.y1)) path += " Z";
  }

  for (const c of circles) {
    path += ` M ${f(c.x - c.r)} ${f(c.y)} a ${f(c.r)} ${f(c.r)} 0 1 0 ${f(2 * c.r)} 0 a ${f(c.r)} ${f(c.r)} 0 1 0 ${f(-2 * c.r)} 0 Z`;
  }
  return path.trim();
}

function segmentTo(item, reversed) {
  const [x1, y1, x2, y2] = reversed
    ? [item.x2, item.y2, item.x1, item.y1]
    : [item.x1, item.y1, item.x2, item.y2];
  if (item.kind === "arc") return arcPath(x1, y1, item.mx, item.my, x2, y2);
  if (item.kind === "rect") {
    return `L ${f(x2)} ${f(y1)} L ${f(x2)} ${f(y2)} L ${f(x1)} ${f(y2)} Z`;
  }
  return `L ${f(x2)} ${f(y2)}`;
}

// ----------------------------------------------------------------- footprints

function padNode(pad, fpRot) {
  const w = pad.w || 0.2;
  const h = pad.h || 0.2;
  // Pad angles are absolute; the group has already applied the footprint's.
  const local = (pad.rot || 0) - (fpRot || 0);
  const transform = `translate(${f(pad.x)} ${f(pad.y)})` + (local ? ` rotate(${f(-local)})` : "");
  const attrs = {
    class: "pad" + (pad.kind === "np_thru_hole" ? " pad-hole" : ""),
    transform,
  };
  let shape;
  if (pad.shape === "circle" || (pad.shape === "oval" && Math.abs(w - h) < 1e-6)) {
    shape = el("circle", { ...attrs, r: f(w / 2) });
  } else {
    const rx = pad.shape === "roundrect" ? Math.min(w, h) * 0.25 : pad.shape === "oval" ? Math.min(w, h) / 2 : 0;
    shape = el("rect", {
      ...attrs,
      x: f(-w / 2),
      y: f(-h / 2),
      width: f(w),
      height: f(h),
      rx: rx ? f(rx) : null,
    });
  }
  if (!pad.drill) return [shape];
  return [shape, el("circle", { class: "drill", transform, r: f(pad.drill / 2) })];
}

function graphicNode(item) {
  if (item.kind === "poly") {
    return el("polygon", {
      class: `fp-${item.layer.includes("SilkS") ? "silk" : "fab"}`,
      points: item.pts.map(([x, y]) => `${f(x)},${f(y)}`).join(" "),
    });
  }
  const cls = `fp-${item.layer.includes("SilkS") ? "silk" : "fab"}`;
  if (item.kind === "rect") {
    return el("rect", {
      class: cls,
      x: f(Math.min(item.x1, item.x2)),
      y: f(Math.min(item.y1, item.y2)),
      width: f(Math.abs(item.x2 - item.x1)),
      height: f(Math.abs(item.y2 - item.y1)),
    });
  }
  if (item.kind === "circle") {
    return el("circle", { class: cls, cx: f(item.x1), cy: f(item.y1), r: f(item.r || 0.1) });
  }
  if (item.kind === "arc") {
    return el("path", {
      class: cls,
      d: `M ${f(item.x1)} ${f(item.y1)} ${arcPath(item.x1, item.y1, item.mx, item.my, item.x2, item.y2)}`,
    });
  }
  return el("line", { class: cls, x1: f(item.x1), y1: f(item.y1), x2: f(item.x2), y2: f(item.y2) });
}

function footprintNode(fp, { showSilk = true, showRefs = true } = {}) {
  // A back-layer footprint is mirrored in Y and turns the other way. This board
  // is single-sided so the branch is untested; it is here so the renderer does
  // not silently draw a back part in the wrong place if one ever appears.
  const flip = fp.layer === "B";
  const rot = flip ? fp.rot : -fp.rot;
  const transform =
    `translate(${f(fp.x)} ${f(fp.y)})` +
    (fp.rot ? ` rotate(${f(rot)})` : "") +
    (flip ? " scale(1 -1)" : "");

  const children = [];
  if (showSilk) {
    for (const item of fp.graphics) {
      if (item.layer.includes("SilkS")) children.push(graphicNode(item));
    }
  }
  for (const pad of fp.pads) {
    for (const node of padNode(pad, fp.rot)) {
      node.dataset.kind = "pad";
      node.dataset.ref = fp.ref;
      node.dataset.pad = pad.num;
      node.dataset.net = pad.net || "";
      children.push(node);
    }
  }
  if (showRefs && fp.ref) {
    children.push(
      el(
        "text",
        {
          class: "ref-label",
          x: 0,
          y: 0,
          "text-anchor": "middle",
          "dominant-baseline": "middle",
          transform: flip ? "scale(1 -1)" : null,
        },
        [document.createTextNode(fp.ref)]
      )
    );
  }
  const group = el("g", { class: `footprint layer-${fp.layer}`, transform }, children);
  group.dataset.kind = "footprint";
  group.dataset.ref = fp.ref;
  return group;
}

// ------------------------------------------------------------------ the board

const LAYER_CLASS = { "F.Cu": "f-cu", "B.Cu": "b-cu" };

/**
 * Draw the layout or routing view.
 *
 * `copper` false gives the layout view: outline, footprints, pads, silkscreen.
 * `copper` true adds tracks, vias and pours, which is the routing view.
 */
export function renderBoard(board, { copper = true, showSilk = true, showRefs = true } = {}) {
  const layout = board.layout;
  const svg = el("svg", {
    class: "board-svg",
    viewBox: `0 0 ${f(layout.size.w)} ${f(layout.size.h)}`,
    preserveAspectRatio: "xMidYMid meet",
  });

  svg.appendChild(el("path", { class: "substrate", d: outlinePath(layout.outline) }));

  if (copper) {
    const zones = el("g", { class: "zones" });
    for (const zone of layout.zones) {
      if (zone.disabled) continue;
      for (const fill of zone.filled) {
        if (!fill.pts.length) continue;
        const node = el("polygon", {
          class: `zone ${LAYER_CLASS[fill.layer] || ""}`,
          points: fill.pts.map(([x, y]) => `${f(x)},${f(y)}`).join(" "),
        });
        node.dataset.kind = "zone";
        node.dataset.id = zone.id;
        node.dataset.net = zone.net;
        zones.appendChild(node);
      }
    }
    svg.appendChild(zones);

    const tracks = el("g", { class: "tracks" });
    for (const track of layout.tracks) {
      const node = el("line", {
        class: `track ${LAYER_CLASS[track.layer] || ""}`,
        x1: f(track.x1),
        y1: f(track.y1),
        x2: f(track.x2),
        y2: f(track.y2),
        "stroke-width": f(track.width),
      });
      node.dataset.kind = "track";
      node.dataset.id = track.id;
      node.dataset.net = track.net;
      tracks.appendChild(node);
    }
    svg.appendChild(tracks);
  }

  const footprints = el("g", { class: "footprints" });
  for (const fp of layout.footprints) {
    footprints.appendChild(footprintNode(fp, { showSilk, showRefs }));
  }
  svg.appendChild(footprints);

  if (copper) {
    const vias = el("g", { class: "vias" });
    for (const via of layout.vias) {
      const node = el("circle", {
        class: "via",
        cx: f(via.x),
        cy: f(via.y),
        r: f(via.size / 2),
      });
      node.dataset.kind = "via";
      node.dataset.id = via.id;
      node.dataset.net = via.net;
      vias.appendChild(node);
      vias.appendChild(
        el("circle", { class: "via-drill", cx: f(via.x), cy: f(via.y), r: f(via.drill / 2) })
      );
    }
    svg.appendChild(vias);
  }

  svg.appendChild(el("path", { class: "edge", d: outlinePath(layout.outline) }));
  svg.appendChild(el("g", { class: "marks" }));
  return svg;
}

// ------------------------------------------------------------------ schematic

/**
 * Nest KiCad's schematic export inside our own SVG so it shares the pan and
 * zoom, and give it an empty overlay layer to draw markers into.
 *
 * KiCad plots A4 at one user unit per millimetre with the same origin the
 * .kicad_sch uses, so symbol coordinates drop straight in with no mapping.
 *
 * `sheetSvg` is markup or an already-parsed node — the page hands over a
 * <template>'s content, which the HTML parser has already turned into real SVG.
 */
export function renderSchematic(board, sheetSvg) {
  const sheet = board.meta.sheet;
  const svg = el("svg", {
    class: "board-svg schematic-svg",
    viewBox: `0 0 ${f(sheet.width)} ${f(sheet.height)}`,
    preserveAspectRatio: "xMidYMid meet",
  });
  // KiCad plots the schematic in its own palette on no background at all:
  // dark red bodies, green wires, black text. Inverting it for a dark page
  // turns that into cyan and magenta, so the sheet gets paper to sit on
  // instead and keeps the colours an engineer already reads fluently.
  svg.appendChild(
    el("rect", { class: "paper", x: 0, y: 0, width: f(sheet.width), height: f(sheet.height) })
  );
  const holder = el("g", { class: "sheet" });
  if (typeof sheetSvg === "string") holder.innerHTML = sheetSvg;
  else if (sheetSvg) holder.appendChild(sheetSvg);
  const inner = holder.querySelector("svg");
  if (inner) {
    inner.setAttribute("x", "0");
    inner.setAttribute("y", "0");
    inner.setAttribute("width", f(sheet.width));
    inner.setAttribute("height", f(sheet.height));
    inner.removeAttribute("style");
  }
  svg.appendChild(holder);

  const hits = el("g", { class: "sym-hits" });
  for (const comp of board.components) {
    if (!comp.sheet) continue;
    const [x0, y0, x1, y1] = comp.sheet.bbox;
    const node = el("rect", {
      class: "sym-hit",
      x: f(x0 - 0.6),
      y: f(y0 - 0.6),
      width: f(x1 - x0 + 1.2),
      height: f(y1 - y0 + 1.2),
      rx: 0.6,
    });
    node.dataset.kind = "symbol";
    node.dataset.ref = comp.ref;
    hits.appendChild(node);
  }
  svg.appendChild(hits);
  svg.appendChild(el("g", { class: "marks" }));
  return svg;
}

/**
 * Ring the components a set of findings or edits point at.
 *
 * Marking is at component level on purpose. Pin offsets live inside the
 * embedded lib_symbols definitions and rotate with the symbol, which is a great
 * deal of work for a smaller ring.
 */
export function markRefs(svg, board, refs, kind = "flag") {
  const marks = svg.querySelector(".marks");
  if (!marks) return;
  marks.textContent = "";
  const wanted = new Set(refs);
  if (!wanted.size) return;

  if (svg.classList.contains("schematic-svg")) {
    for (const comp of board.components) {
      if (!wanted.has(comp.ref) || !comp.sheet) continue;
      const [x0, y0, x1, y1] = comp.sheet.bbox;
      marks.appendChild(
        el("rect", {
          class: `mark mark-${kind}`,
          x: f(x0 - 1.2),
          y: f(y0 - 1.2),
          width: f(x1 - x0 + 2.4),
          height: f(y1 - y0 + 2.4),
          rx: 1,
        })
      );
    }
    return;
  }

  for (const fp of board.layout.footprints) {
    if (!wanted.has(fp.ref)) continue;
    const extent = fp.pads.reduce((max, pad) => {
      const [px, py] = place(pad.x, pad.y, fp.rot);
      return Math.max(max, Math.hypot(px, py) + Math.max(pad.w, pad.h) / 2);
    }, 1.2);
    marks.appendChild(
      el("circle", { class: `mark mark-${kind}`, cx: f(fp.x), cy: f(fp.y), r: f(extent + 0.4) })
    );
  }
}

/** Highlight every piece of copper on a net, across all three views. */
export function highlightNets(svg, nets) {
  const wanted = new Set(nets.filter(Boolean));
  for (const node of svg.querySelectorAll("[data-net]")) {
    node.classList.toggle("net-lit", wanted.has(node.dataset.net));
  }
}

// ----------------------------------------------------------------- pan & zoom

/**
 * Wheel to zoom about the cursor, drag empty space to pan.
 *
 * A 0.3 mm track on a 61 mm board is a third of a percent of the width, so the
 * views are unreadable without this.
 */
export function attachPanZoom(svg, { onPointerDown } = {}) {
  const [, , w0, h0] = svg.getAttribute("viewBox").split(/\s+/).map(Number);
  const home = { x: 0, y: 0, w: w0, h: h0 };
  let view = { ...home };
  let dragging = null;

  const apply = () => {
    svg.setAttribute("viewBox", `${f(view.x)} ${f(view.y)} ${f(view.w)} ${f(view.h)}`);
    // Keep hairlines hairline-thin as the view zooms in.
    svg.style.setProperty("--zoom", String(w0 / view.w));
  };

  const toBoard = (event) => {
    const rect = svg.getBoundingClientRect();
    const scale = Math.min(rect.width / view.w, rect.height / view.h);
    const insetX = (rect.width - view.w * scale) / 2;
    const insetY = (rect.height - view.h * scale) / 2;
    return {
      x: view.x + (event.clientX - rect.left - insetX) / scale,
      y: view.y + (event.clientY - rect.top - insetY) / scale,
    };
  };

  svg.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const at = toBoard(event);
      const factor = Math.exp(event.deltaY * 0.0015);
      const next = Math.min(Math.max(view.w * factor, w0 / 60), w0 * 3);
      const ratio = next / view.w;
      view = {
        x: at.x - (at.x - view.x) * ratio,
        y: at.y - (at.y - view.y) * ratio,
        w: next,
        h: view.h * ratio,
      };
      apply();
    },
    { passive: false }
  );

  svg.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const target = event.target.closest("[data-kind]");
    if (target && onPointerDown && onPointerDown(event, target, toBoard(event))) return;
    // Panning holds the view size fixed, so the millimetres-per-pixel scale is
    // constant for the whole drag and a screen delta converts straight across.
    const rect = svg.getBoundingClientRect();
    dragging = {
      clientX: event.clientX,
      clientY: event.clientY,
      vx: view.x,
      vy: view.y,
      scale: Math.min(rect.width / view.w, rect.height / view.h),
    };
    svg.setPointerCapture(event.pointerId);
    svg.classList.add("panning");
  });

  svg.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    view.x = dragging.vx - (event.clientX - dragging.clientX) / dragging.scale;
    view.y = dragging.vy - (event.clientY - dragging.clientY) / dragging.scale;
    apply();
  });

  const stop = (event) => {
    if (!dragging) return;
    dragging = null;
    svg.classList.remove("panning");
    if (event.pointerId !== undefined && svg.hasPointerCapture(event.pointerId)) {
      svg.releasePointerCapture(event.pointerId);
    }
  };
  svg.addEventListener("pointerup", stop);
  svg.addEventListener("pointercancel", stop);

  return {
    reset() {
      view = { ...home };
      apply();
    },
    toBoard,
    get view() {
      return { ...view };
    },
  };
}

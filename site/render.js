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
import { islands, place } from "./copper.js";

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

//: How far a pointer may travel and still count as a tap rather than a pan.
const TAP_SLOP = 3;

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

/** The footprint's own extent, in its local frame: pads and silkscreen. */
function footprintBox(fp) {
  const xs = [];
  const ys = [];
  for (const pad of fp.pads) {
    const half = Math.max(pad.w, pad.h) / 2;
    xs.push(pad.x - half, pad.x + half);
    ys.push(pad.y - half, pad.y + half);
  }
  for (const item of fp.graphics) {
    if (item.kind === "poly") {
      for (const [x, y] of item.pts) {
        xs.push(x);
        ys.push(y);
      }
    } else {
      xs.push(item.x1, item.x2);
      ys.push(item.y1, item.y2);
    }
  }
  if (!xs.length) return null;
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
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

  // A transparent body, so the part can be grabbed anywhere and not only on a
  // pad or a silkscreen line. Without it, pressing the middle of a two-pad part
  // hits nothing and pans the view instead of dragging the part.
  const body = footprintBox(fp);
  if (body) {
    const hit = el("rect", {
      class: "fp-body",
      x: f(body.x0),
      y: f(body.y0),
      width: f(body.x1 - body.x0),
      height: f(body.y1 - body.y0),
    });
    hit.dataset.kind = "footprint";
    hit.dataset.ref = fp.ref;
    children.push(hit);
  }

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
  svg.appendChild(el("g", { class: "divergence" }));
  svg.appendChild(el("g", { class: "marks" }));
  return svg;
}

// ------------------------------------------------------------------ schematic

/** Every pad's world position, keyed "REF.PIN". */
export function padIndex(board) {
  const index = new Map();
  for (const fp of board.layout.footprints) {
    for (const pad of fp.pads) {
      const [dx, dy] = place(pad.x, pad.y, fp.rot);
      index.set(`${fp.ref}.${pad.num}`, {
        ref: fp.ref,
        pin: pad.num,
        x: fp.x + dx,
        y: fp.y + dy,
        copper: pad.net,
      });
    }
  }
  return index;
}

/**
 * Where the board no longer agrees with itself.
 *
 * Two kinds, and between them they are what makes an edit visible:
 *
 * - **stale** — a pad whose netlist net is not the net its copper belongs to.
 *   That is what a schematic edit leaves behind: the design says this pin is on
 *   VBST now, and the track it sits on was laid for /FB. Nothing in the board
 *   data is changed to produce this; it is read off the two halves.
 * - **stranded** — a pad on a net whose copper is in more than one piece, and
 *   not on the largest piece. That is the ground defect, and it is invisible in
 *   the net list by construction.
 */
export function divergence(board) {
  const pads = padIndex(board);
  const stale = [];
  const byNet = new Map();

  for (const net of board.nets) {
    for (const node of net.nodes) {
      const pad = pads.get(`${node.ref}.${node.pin}`);
      if (!pad) continue;
      if (!byNet.has(net.name)) byNet.set(net.name, []);
      byNet.get(net.name).push(pad);
      if (pad.copper && pad.copper !== net.name) {
        stale.push({ ...pad, wants: net.name });
      }
    }
  }

  // For each stale pad, the nearest pin the schematic now says it joins. This
  // is the connection the copper does not provide — a ratsnest line, the same
  // thing a layout tool draws for an unrouted net.
  for (const item of stale) {
    let best = null;
    for (const other of byNet.get(item.wants) || []) {
      // By name, not by identity: `item` is a copy of the pad, so `other`
      // being the same pin is exactly the case that must be skipped.
      if (other.ref === item.ref && other.pin === item.pin) continue;
      const distance = Math.hypot(other.x - item.x, other.y - item.y);
      if (!best || distance < best.distance) best = { distance, to: other };
    }
    item.to = best ? best.to : null;
  }

  const stranded = [];
  for (const [net, groups] of islands(board)) {
    const withPads = groups.filter((g) => g.some((i) => i.kind === "pad"));
    if (withPads.length < 2) continue;
    const size = (g) => g.filter((i) => i.kind === "pad").length;
    const main = withPads.reduce((a, b) => (size(b) > size(a) ? b : a));
    for (const group of withPads) {
      if (group === main) continue;
      for (const item of group) {
        if (item.kind === "pad") stranded.push({ id: item.id, net, x: item.x, y: item.y });
      }
    }
  }
  return { stale, stranded };
}

/** Draw the divergence into a board view. Returns what it drew. */
export function markDivergence(svg, board) {
  const layer = svg.querySelector(".divergence");
  if (!layer) return { stale: [], stranded: [] };
  layer.textContent = "";
  const found = divergence(board);

  for (const item of found.stranded) {
    layer.appendChild(
      el("circle", { class: "stranded", cx: f(item.x), cy: f(item.y), r: 0.85 })
    );
  }
  for (const item of found.stale) {
    if (item.to) {
      layer.appendChild(
        el("line", {
          class: "ratsnest",
          x1: f(item.x),
          y1: f(item.y),
          x2: f(item.to.x),
          y2: f(item.to.y),
        })
      );
    }
    layer.appendChild(
      el("circle", { class: "stale-pad", cx: f(item.x), cy: f(item.y), r: 0.85 })
    );
  }
  return found;
}

/** Drop every marker. Findings and edits share the layer, so this comes first. */
export function clearMarks(svg) {
  const marks = svg.querySelector(".marks");
  if (marks) marks.textContent = "";
}

/**
 * Ring the components a set of findings or edits point at.
 *
 * Marking is at part level, not pin level: a ring around the footprint. A pad
 * ring would need the pin the finding names, and a reviewer naming pins is a
 * habit rather than a promise — `S1.4`, `S1 pin 4`, `FB`. The part is the thing
 * both ends agree on.
 */
export function markRefs(svg, board, refs, kind = "flag") {
  const marks = svg.querySelector(".marks");
  if (!marks) return;
  const wanted = new Set(refs);
  if (!wanted.size) return;

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

/** Highlight every piece of copper on a net. */
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
 *
 * Selection is reported through `onTap` on pointerup, not through a `click`
 * listener. Panning takes pointer capture on the root, and capture retargets
 * the click that follows to the root — so a `click` handler looking for the
 * element under the cursor finds the SVG and nothing else. That made every
 * board view read-only: the track, via and pour editors had no way in.
 */
export function attachPanZoom(svg, { onPointerDown, onTap } = {}) {
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
      target,
      moved: false,
    };
    svg.setPointerCapture(event.pointerId);
    svg.classList.add("panning");
  });

  svg.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    if (Math.hypot(event.clientX - dragging.clientX, event.clientY - dragging.clientY) > TAP_SLOP) {
      dragging.moved = true;
    }
    view.x = dragging.vx - (event.clientX - dragging.clientX) / dragging.scale;
    view.y = dragging.vy - (event.clientY - dragging.clientY) / dragging.scale;
    apply();
  });

  const stop = (event) => {
    if (!dragging) return;
    // A press that went nowhere is a tap on whatever was under it — including
    // nothing, which is how you clear the selection.
    if (!dragging.moved && onTap) onTap(dragging.target);
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

/**
 * One footprint, drawn on its own, at its own scale.
 *
 * The board view answers "where is this part". It cannot answer "what does this
 * pad look like", because at board scale a 0402 is four pixels. This draws the
 * part alone: the fabrication outline that says where the body sits, the
 * silkscreen, and every pad at its real size and shape, numbered.
 *
 * Drawn unrotated. The footprint's placement angle belongs to the board, and a
 * part inspected at 270 degrees should not be read upside down - the rotation is
 * stated in the facts beside it instead.
 */
export function renderFootprint(fp, { width = 200, height = 150 } = {}) {
  const box = footprintBounds(fp);
  const w = box.x2 - box.x1;
  const h = box.y2 - box.y1;
  // Fit the box, rather than fixing the width: a six-pin header is three times
  // taller than it is wide, and fixing the width made it 500 pixels of rail.
  const scale = Math.min(width / w, height / h);
  const svg = el("svg", {
    class: "fp-svg",
    viewBox: `${f(box.x1)} ${f(box.y1)} ${f(w)} ${f(h)}`,
    width: Math.round(w * scale),
    height: Math.round(h * scale),
    role: "img",
    "aria-label": `Footprint of ${fp.ref}: ${fp.pads.length} pads`,
  });

  // Fabrication and silkscreen first, so a pad is never hidden behind a line.
  for (const g of fp.graphics || []) {
    const fab = /Fab$/.test(g.layer || "");
    const cls = fab ? "fp-fab" : "fp-silk";
    if (g.kind === "line") {
      svg.appendChild(el("line", { class: cls, x1: f(g.x1), y1: f(g.y1), x2: f(g.x2), y2: f(g.y2) }));
    } else if (g.kind === "rect") {
      svg.appendChild(
        el("rect", {
          class: cls, x: f(Math.min(g.x1, g.x2)), y: f(Math.min(g.y1, g.y2)),
          width: f(Math.abs(g.x2 - g.x1)), height: f(Math.abs(g.y2 - g.y1)),
        })
      );
    } else if (g.kind === "circle") {
      svg.appendChild(el("circle", { class: cls, cx: f(g.x), cy: f(g.y), r: f(g.r) }));
    } else if (g.kind === "poly" && (g.points || []).length > 1) {
      svg.appendChild(
        el("polyline", { class: cls, points: g.points.map((p) => `${f(p.x)},${f(p.y)}`).join(" ") })
      );
    }
  }

  for (const pad of fp.pads) {
    const group = el("g", {
      class: `fp-pad fp-${pad.kind}`,
      transform: `translate(${f(pad.x)} ${f(pad.y)})${pad.rot ? ` rotate(${f(-pad.rot)})` : ""}`,
    });
    if (pad.shape === "circle") {
      group.appendChild(el("circle", { class: "fp-copper", cx: 0, cy: 0, r: f(pad.w / 2) }));
    } else {
      group.appendChild(
        el("rect", {
          class: "fp-copper", x: f(-pad.w / 2), y: f(-pad.h / 2),
          width: f(pad.w), height: f(pad.h),
          rx: pad.shape === "roundrect" ? f(Math.min(pad.w, pad.h) * 0.25) : 0,
        })
      );
    }
    if (pad.drill > 0) {
      group.appendChild(el("circle", { class: "fp-drill", cx: 0, cy: 0, r: f(pad.drill / 2) }));
    }
    svg.appendChild(group);
    // The number goes on unrotated, or a pad turned 270 degrees carries a
    // sideways label.
    // A number is only worth drawing where it can be read. On a 48-pin QFP
    // the pads are 0.3 mm across and forty-eight numbers became a smear, which
    // is worse than no numbers: it hides the pad shapes underneath them.
    if (Math.min(pad.w, pad.h) * scale >= 9) {
      const label = el("text", {
        class: "fp-num", x: f(pad.x), y: f(pad.y), "font-size": f(padFont(fp)),
      });
      label.textContent = pad.num;
      svg.appendChild(label);
    }
  }
  return svg;
}

/** Every pad and every graphic, plus a margin, so nothing touches the edge. */
function footprintBounds(fp) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  const grow = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    x1 = Math.min(x1, x); y1 = Math.min(y1, y);
    x2 = Math.max(x2, x); y2 = Math.max(y2, y);
  };
  for (const pad of fp.pads || []) {
    const reach = Math.max(pad.w, pad.h) / 2;
    grow(pad.x - reach, pad.y - reach);
    grow(pad.x + reach, pad.y + reach);
  }
  for (const g of fp.graphics || []) {
    if (g.kind === "line" || g.kind === "rect") {
      grow(g.x1, g.y1); grow(g.x2, g.y2);
    } else if (g.kind === "circle") {
      grow(g.x - g.r, g.y - g.r); grow(g.x + g.r, g.y + g.r);
    } else if (g.kind === "poly") {
      for (const p of g.points || []) grow(p.x, p.y);
    }
  }
  if (!Number.isFinite(x1)) return { x1: -1, y1: -1, x2: 1, y2: 1 };
  const pad = Math.max(0.2, (x2 - x1 + y2 - y1) * 0.06);
  return { x1: x1 - pad, y1: y1 - pad, x2: x2 + pad, y2: y2 + pad };
}

/** Pad numbers sized to the part, so a 0402 is not labelled in 3 mm type. */
function padFont(fp) {
  const smallest = Math.min(...(fp.pads || []).map((p) => Math.max(p.w, p.h)), 2);
  return Math.max(0.22, Math.min(0.8, smallest * 0.55));
}

/**
 * The physical facts of a package, measured rather than looked up.
 *
 * The body size is the fabrication outline's extent, which is what KiCad draws
 * the part's real body as. There is no 3D model in the extracted board, so
 * nothing here is a height or a rendering: it is the footprint's own geometry,
 * which is the part of "what is this package" the board file actually knows.
 */
export function packageFacts(fp) {
  const pads = fp.pads || [];
  const fab = (fp.graphics || []).filter((g) => /Fab$/.test(g.layer || ""));
  let body = null;
  if (fab.length) {
    const xs = [], ys = [];
    for (const g of fab) {
      if (g.kind === "circle") { xs.push(g.x - g.r, g.x + g.r); ys.push(g.y - g.r, g.y + g.r); }
      else if (g.kind === "poly") { for (const p of g.points || []) { xs.push(p.x); ys.push(p.y); } }
      else { xs.push(g.x1, g.x2); ys.push(g.y1, g.y2); }
    }
    // An arc contributes no endpoints here, so a shape list can come back
    // holding undefined. Taking a max over that yields NaN and a body of
    // "NaN x NaN mm", which reads as a measurement and is not one.
    const wide = xs.filter(Number.isFinite);
    const tall = ys.filter(Number.isFinite);
    if (wide.length && tall.length) {
      body = {
        w: Math.max(...wide) - Math.min(...wide),
        h: Math.max(...tall) - Math.min(...tall),
      };
    }
  }
  const kinds = new Set(pads.map((p) => p.kind));
  const mount = kinds.has("smd")
    ? kinds.size > 1 ? "SMD, with through-hole" : "SMD"
    : kinds.has("thru_hole") ? "Through-hole" : "Mechanical";
  return { body, mount, pads: pads.length, pitch: pitchOf(pads), drills: drillsOf(pads) };
}

/**
 * The smallest gap between neighbouring pad centres, which is the pitch for
 * anything laid out on a row. Null when there are fewer than two pads to
 * measure between - a single-pad footprint has no pitch, and saying 0 would
 * read as one.
 */
function pitchOf(pads) {
  if (pads.length < 2) return null;
  let best = Infinity;
  for (let i = 0; i < pads.length; i += 1) {
    for (let j = i + 1; j < pads.length; j += 1) {
      const d = Math.hypot(pads[i].x - pads[j].x, pads[i].y - pads[j].y);
      if (d > 0.01) best = Math.min(best, d);
    }
  }
  return Number.isFinite(best) ? best : null;
}

/** The distinct drill sizes, which is what a fab house asks about first. */
function drillsOf(pads) {
  return [...new Set(pads.filter((p) => p.drill > 0).map((p) => Number(p.drill.toFixed(4))))].sort(
    (a, b) => a - b
  );
}

// Copper connectivity in the browser. The mirror of the geometry half of
// harness/checks.py.
//
// This exists because the page has to describe the board as it is *now* — after
// whatever the visitor deleted — and only the browser holds that state. The
// island count is the one number that makes the ground defect legible: the
// netlist says GND is one net either way, and only the copper disagrees.
//
// Cost is a pair-wise walk per net, which is about 15,000 distance tests for
// this board and runs in a few milliseconds. Nets are small; GND is the only
// large one.

const TOL = 0.02; // mm; KiCad quantises to a nanometre, so this is generous

/** KiCad's RotatePoint. The same transform as extract/layout.py `place()`. */
export function place(x, y, deg) {
  if (!deg) return [x, y];
  const a = (deg * Math.PI) / 180;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  return [x * ca + y * sa, y * ca - x * sa];
}

function padLayers(pad) {
  const out = new Set();
  for (const layer of pad.layers || []) {
    if (layer === "*.Cu" || layer === "*") {
      out.add("F.Cu");
      out.add("B.Cu");
    } else if (layer.endsWith(".Cu")) {
      out.add(layer);
    }
  }
  return out;
}

export function copperItems(board) {
  const items = [];
  for (const fp of board.layout.footprints) {
    for (const pad of fp.pads) {
      const layers = padLayers(pad);
      if (!layers.size || !pad.net) continue;
      const [dx, dy] = place(pad.x, pad.y, fp.rot);
      items.push({
        kind: "pad",
        id: `${fp.ref}.${pad.num}`,
        net: pad.net,
        layers,
        x: fp.x + dx,
        y: fp.y + dy,
        r: Math.max(pad.w, pad.h) / 2,
      });
    }
  }
  for (const track of board.layout.tracks) {
    if (!track.layer.endsWith(".Cu")) continue;
    items.push({
      kind: "track",
      id: track.id,
      net: track.net,
      layers: new Set([track.layer]),
      seg: [track.x1, track.y1, track.x2, track.y2],
      r: track.width / 2,
    });
  }
  for (const via of board.layout.vias) {
    const layers = new Set((via.layers || []).filter((l) => l.endsWith(".Cu")));
    items.push({
      kind: "via",
      id: via.id,
      net: via.net,
      layers: layers.size ? layers : new Set(["F.Cu", "B.Cu"]),
      x: via.x,
      y: via.y,
      r: via.size / 2,
    });
  }
  for (const zone of board.layout.zones) {
    if (zone.disabled) continue;
    zone.filled.forEach((fill, i) => {
      if (!fill.layer.endsWith(".Cu") || fill.pts.length < 3) return;
      const xs = fill.pts.map((p) => p[0]);
      const ys = fill.pts.map((p) => p[1]);
      items.push({
        kind: "zone",
        id: `${zone.id}.${i}`,
        net: zone.net,
        layers: new Set([fill.layer]),
        poly: fill.pts,
        bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      });
    });
  }
  return items;
}

function pointToSegment(px, py, seg) {
  const [x1, y1, x2, y2] = seg;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length2 = dx * dx + dy * dy;
  if (length2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / length2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function segmentsClose(a, b, gap) {
  return (
    Math.min(
      pointToSegment(a[0], a[1], b),
      pointToSegment(a[2], a[3], b),
      pointToSegment(b[0], b[1], a),
      pointToSegment(b[2], b[3], a)
    ) <= gap
  );
}

function inPolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function touchesZone(item, zone) {
  const [bx0, by0, bx1, by1] = zone.bbox;
  const points =
    item.kind === "track"
      ? [
          [item.seg[0], item.seg[1]],
          [item.seg[2], item.seg[3]],
          [(item.seg[0] + item.seg[2]) / 2, (item.seg[1] + item.seg[3]) / 2],
        ]
      : [[item.x, item.y]];
  const pad = (item.r || 0) + TOL;
  for (const [px, py] of points) {
    if (px < bx0 - pad || px > bx1 + pad || py < by0 - pad || py > by1 + pad) continue;
    if (inPolygon(px, py, zone.poly)) return true;
    // A pad just outside the fill still connects through its thermal spoke;
    // the fill itself is drawn back by the clearance.
    for (let i = 0; i < zone.poly.length; i++) {
      const a = zone.poly[i === 0 ? zone.poly.length - 1 : i - 1];
      const b = zone.poly[i];
      if (pointToSegment(px, py, [a[0], a[1], b[0], b[1]]) <= pad) return true;
    }
  }
  return false;
}

function shareLayer(a, b) {
  for (const layer of a) if (b.has(layer)) return true;
  return false;
}

export function connected(a, b) {
  if (!shareLayer(a.layers, b.layers)) return false;
  if (a.kind === "zone" || b.kind === "zone") {
    const zone = a.kind === "zone" ? a : b;
    const other = a.kind === "zone" ? b : a;
    if (other.kind === "zone") return false; // two fills of one pour are one pour
    return touchesZone(other, zone);
  }
  const gap = (a.r || 0) + (b.r || 0) + TOL;
  if (a.kind === "track" && b.kind === "track") return segmentsClose(a.seg, b.seg, gap);
  if (a.kind === "track") return pointToSegment(b.x, b.y, a.seg) <= gap;
  if (b.kind === "track") return pointToSegment(a.x, a.y, b.seg) <= gap;
  return Math.hypot(a.x - b.x, a.y - b.y) <= gap;
}

/** Copper connectivity per net, as a map of net name to a list of groups. */
export function islands(board) {
  const byNet = new Map();
  for (const item of copperItems(board)) {
    if (!item.net) continue;
    if (!byNet.has(item.net)) byNet.set(item.net, []);
    byNet.get(item.net).push(item);
  }

  const out = new Map();
  for (const [net, items] of byNet) {
    const parent = items.map((_, i) => i);
    const find = (i) => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        if (find(i) !== find(j) && connected(items[i], items[j])) parent[find(i)] = find(j);
      }
    }
    const groups = new Map();
    items.forEach((item, i) => {
      const root = find(i);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(item);
    });
    out.set(net, [...groups.values()]);
  }
  return out;
}

/** How many separate pieces of copper a net's pads sit on. One is healthy. */
export function islandCounts(board) {
  const counts = new Map();
  for (const [net, groups] of islands(board)) {
    counts.set(net, groups.filter((g) => g.some((i) => i.kind === "pad")).length);
  }
  return counts;
}

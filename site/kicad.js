// Read a KiCad project in the browser, with no server and no kicad-cli.
//
// The Python extractor gets its net list from
// `kicad-cli sch export netlist --format kicadxml`, which is not available to a
// page. It does not need to be: every pad in a `.kicad_pcb` already carries
// `(net "NAME")`, `(pinfunction "VBST_6")` and `(pintype "power_in")` — the
// three things that make a net list worth reading. So the nets are derived from
// the copper itself, which is also the more honest source for a tool whose
// whole argument is that the copper is what matters.
//
// The one thing the board cannot supply is designators. A footprint's
// `Reference` property holds the *silkscreen* label, and on the board this
// project was built from, eleven of fifty-three say things like `LIN REG` and
// `BUCK`. The real designator lives in the schematic, and the two are joined on
// the UUID each footprint carries as `(path "/<uuid>")`. That is why an upload
// wants both files.
//
// Everything here mirrors extract/sexpr.py, extract/layout.py and
// extract/schematic.py, and produces the same Board shape those do.

// ------------------------------------------------------------------ s-expr

/** A string that was quoted in the source, so `"1"` is not the atom `1`. */
class Str extends String {}

function tokenize(text) {
  const out = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      i += 1;
    } else if (c === "(" || c === ")") {
      out.push(c);
      i += 1;
    } else if (c === '"') {
      i += 1;
      let s = "";
      while (i < n) {
        const ch = text[i];
        if (ch === "\\" && i + 1 < n) {
          const next = text[i + 1];
          s += next === "n" ? "\n" : next === "t" ? "\t" : next === "r" ? "\r" : next;
          i += 2;
        } else if (ch === '"') {
          i += 1;
          break;
        } else {
          s += ch;
          i += 1;
        }
      }
      out.push(new Str(s));
    } else {
      const start = i;
      while (i < n && !" \t\r\n()".includes(text[i])) i += 1;
      out.push(text.slice(start, i));
    }
  }
  return out;
}

export function parseSexpr(text) {
  const stack = [];
  let root = null;
  for (const token of tokenize(text)) {
    if (token === "(") {
      const node = [];
      if (stack.length) stack[stack.length - 1].push(node);
      stack.push(node);
    } else if (token === ")") {
      if (!stack.length) throw new Error("closes a list that was never opened");
      const node = stack.pop();
      if (!stack.length) {
        if (root) throw new Error("more than one top-level form");
        root = node;
      }
    } else if (stack.length) {
      stack[stack.length - 1].push(token);
    } else {
      throw new Error(`atom ${token} outside any list`);
    }
  }
  if (stack.length) throw new Error(`${stack.length} list(s) left open`);
  if (!root) throw new Error("empty file");
  return root;
}

const sxTag = (node) =>
  Array.isArray(node) && node.length && typeof node[0] === "string" && !(node[0] instanceof Str)
    ? node[0]
    : "";

function* sxChildren(node, name) {
  if (!Array.isArray(node)) return;
  for (let i = 1; i < node.length; i++) if (sxTag(node[i]) === name) yield node[i];
}

function sxChild(node, name) {
  for (const found of sxChildren(node, name)) return found;
  return null;
}

function sxValue(node, name, index = 1, fallback = null) {
  const found = sxChild(node, name);
  if (!found || found.length <= index) return fallback;
  return found[index];
}

const sxNum = (v, fallback = 0) => {
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const sxStr = (v) => (v === null || v === undefined ? "" : String(v));

// ------------------------------------------------------------------ geometry

function sxAt(node, fallback = [0, 0, 0]) {
  const found = sxChild(node, "at");
  if (!found) return fallback;
  return [
    found.length > 1 ? sxNum(found[1]) : fallback[0],
    found.length > 2 ? sxNum(found[2]) : fallback[1],
    found.length > 3 ? sxNum(found[3]) : 0,
  ];
}

function layersOf(node) {
  const found = sxChild(node, "layers");
  if (!found) {
    const one = sxValue(node, "layer");
    return one === null ? [] : [sxStr(one)];
  }
  return found.slice(1).filter((v) => typeof v === "string" || v instanceof Str).map(sxStr);
}

/** Net names are quoted in KiCad 9+; older files carry an index first. */
function netOf(node) {
  const found = sxChild(node, "net");
  if (!found || found.length < 2) return "";
  for (let i = 1; i < found.length; i++) if (found[i] instanceof Str) return sxStr(found[i]);
  return "";
}

function propertyOf(node, name) {
  for (const prop of sxChildren(node, "property")) {
    if (prop.length > 1 && sxStr(prop[1]) === name) return prop.length > 2 ? sxStr(prop[2]) : "";
  }
  return "";
}

// ------------------------------------------------------------------- the pcb

function parseOutline(doc) {
  const out = [];
  for (let i = 1; i < doc.length; i++) {
    const node = doc[i];
    const t = sxTag(node);
    if (!["gr_line", "gr_arc", "gr_circle", "gr_rect"].includes(t)) continue;
    if (sxStr(sxValue(node, "layer", 1, "")) !== "Edge.Cuts") continue;
    const [sx, sy] = [sxNum(sxValue(node, "start", 1)), sxNum(sxValue(node, "start", 2))];
    const [ex, ey] = [sxNum(sxValue(node, "end", 1)), sxNum(sxValue(node, "end", 2))];
    if (t === "gr_arc") {
      out.push({
        kind: "arc", x1: sx, y1: sy, x2: ex, y2: ey,
        mx: sxNum(sxValue(node, "mid", 1)), my: sxNum(sxValue(node, "mid", 2)),
      });
    } else if (t === "gr_circle") {
      out.push({ kind: "circle", x: sx, y: sy, r: Math.hypot(ex - sx, ey - sy) });
    } else if (t === "gr_rect") {
      out.push({ kind: "rect", x1: sx, y1: sy, x2: ex, y2: ey });
    } else {
      out.push({ kind: "line", x1: sx, y1: sy, x2: ex, y2: ey });
    }
  }
  return out;
}

function outlineBox(outline) {
  if (!outline.length) throw new Error("the board has no Edge.Cuts outline");
  const xs = [];
  const ys = [];
  for (const item of outline) {
    if (item.kind === "circle") {
      xs.push(item.x - item.r, item.x + item.r);
      ys.push(item.y - item.r, item.y + item.r);
      continue;
    }
    xs.push(item.x1, item.x2);
    ys.push(item.y1, item.y2);
    if (item.kind === "arc") {
      xs.push(item.mx);
      ys.push(item.my);
    }
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function padsOf(fp) {
  const pads = [];
  for (const pad of sxChildren(fp, "pad")) {
    const [x, y, rot] = sxAt(pad);
    pads.push({
      num: pad.length > 1 ? sxStr(pad[1]) : "",
      kind: pad.length > 2 ? sxStr(pad[2]) : "",
      shape: pad.length > 3 ? sxStr(pad[3]) : "",
      x, y, rot,
      w: sxNum(sxValue(pad, "size", 1)),
      h: sxNum(sxValue(pad, "size", 2)),
      drill: sxChild(pad, "drill") ? sxNum(sxValue(pad, "drill", 1)) : 0,
      layers: layersOf(pad),
      net: netOf(pad),
      function: sxStr(sxValue(pad, "pinfunction", 1, "")),
      type: sxStr(sxValue(pad, "pintype", 1, "")),
    });
  }
  return pads;
}

const DRAWN_LAYERS = ["F.SilkS", "B.SilkS", "F.Fab", "B.Fab"];

function graphicsOf(fp) {
  const out = [];
  for (let i = 1; i < fp.length; i++) {
    const node = fp[i];
    const t = sxTag(node);
    if (!["fp_line", "fp_arc", "fp_circle", "fp_rect", "fp_poly"].includes(t)) continue;
    const layer = sxStr(sxValue(node, "layer", 1, ""));
    if (!DRAWN_LAYERS.includes(layer)) continue;
    if (t === "fp_poly") {
      const pts = sxChild(node, "pts");
      if (!pts) continue;
      out.push({
        kind: "poly", layer,
        pts: [...sxChildren(pts, "xy")].map((p) => [sxNum(p[1]), sxNum(p[2])]),
      });
      continue;
    }
    const item = {
      kind: t.slice(3), layer,
      x1: sxNum(sxValue(node, "start", 1)), y1: sxNum(sxValue(node, "start", 2)),
      x2: sxNum(sxValue(node, "end", 1)), y2: sxNum(sxValue(node, "end", 2)),
    };
    if (t === "fp_arc") {
      item.mx = sxNum(sxValue(node, "mid", 1));
      item.my = sxNum(sxValue(node, "mid", 2));
    }
    if (t === "fp_circle") item.r = Math.hypot(item.x2 - item.x1, item.y2 - item.y1);
    out.push(item);
  }
  return out;
}

export function parsePcb(text) {
  const doc = parseSexpr(text);
  if (sxTag(doc) !== "kicad_pcb") throw new Error("this is not a .kicad_pcb file");

  const outline = parseOutline(doc);
  const [minX, minY, maxX, maxY] = outlineBox(outline);

  const footprints = [...sxChildren(doc, "footprint")].map((fp) => {
    const [x, y, rot] = sxAt(fp);
    return {
      uuid: sxStr(sxValue(fp, "path", 1, "")).replace(/^\//, ""),
      fp_uuid: sxStr(sxValue(fp, "uuid", 1, "")),
      library: fp.length > 1 ? sxStr(fp[1]) : "",
      silk: propertyOf(fp, "Reference"),
      value: propertyOf(fp, "Value"),
      datasheet: propertyOf(fp, "Datasheet"),
      description: propertyOf(fp, "Description") || sxStr(sxValue(fp, "descr", 1, "")),
      x, y, rot,
      layer: sxStr(sxValue(fp, "layer", 1, "F.Cu")).startsWith("B") ? "B" : "F",
      pads: padsOf(fp),
      graphics: graphicsOf(fp),
    };
  });

  const tracks = [...sxChildren(doc, "segment")].map((seg) => ({
    x1: sxNum(sxValue(seg, "start", 1)), y1: sxNum(sxValue(seg, "start", 2)),
    x2: sxNum(sxValue(seg, "end", 1)), y2: sxNum(sxValue(seg, "end", 2)),
    width: sxNum(sxValue(seg, "width", 1)),
    layer: sxStr(sxValue(seg, "layer", 1, "")),
    net: netOf(seg),
  }));

  const vias = [...sxChildren(doc, "via")].map((via) => {
    const [x, y] = sxAt(via);
    return {
      x, y,
      size: sxNum(sxValue(via, "size", 1)),
      drill: sxNum(sxValue(via, "drill", 1)),
      layers: layersOf(via),
      net: netOf(via),
    };
  });

  const zones = [...sxChildren(doc, "zone")].map((zone) => {
    const outlinePts = sxChild(sxChild(zone, "polygon") || [], "pts");
    const layers = layersOf(zone);
    return {
      name: sxStr(sxValue(zone, "name", 1, "")),
      net: netOf(zone),
      layer: layers[0] || "",
      layers,
      priority: Math.round(sxNum(sxValue(zone, "priority", 1, 0))),
      polygon: outlinePts ? [...sxChildren(outlinePts, "xy")].map((p) => [sxNum(p[1]), sxNum(p[2])]) : [],
      filled: [...sxChildren(zone, "filled_polygon")]
        .map((fill) => {
          const pts = sxChild(fill, "pts");
          return pts
            ? {
                layer: sxStr(sxValue(fill, "layer", 1, "")),
                pts: [...sxChildren(pts, "xy")].map((p) => [sxNum(p[1]), sxNum(p[2])]),
              }
            : null;
        })
        .filter(Boolean),
    };
  });

  const layout = {
    origin: { x: q4(minX), y: q4(minY) },
    size: { w: q4(maxX - minX), h: q4(maxY - minY) },
    outline, footprints, tracks, vias, zones,
  };
  reorigin(layout, minX, minY);
  return layout;
}

const q4 = (v) => Math.round(v * 1e4) / 1e4;

/** Re-origin everything to the outline's minimum, once, as the Python does. */
function reorigin(layout, ox, oy) {
  for (const item of layout.outline) {
    if (item.kind === "circle") {
      item.x -= ox;
      item.y -= oy;
      continue;
    }
    item.x1 -= ox; item.y1 -= oy; item.x2 -= ox; item.y2 -= oy;
    if (item.kind === "arc") { item.mx -= ox; item.my -= oy; }
  }
  for (const fp of layout.footprints) { fp.x -= ox; fp.y -= oy; }
  for (const t of layout.tracks) { t.x1 -= ox; t.y1 -= oy; t.x2 -= ox; t.y2 -= oy; }
  for (const v of layout.vias) { v.x -= ox; v.y -= oy; }
  for (const z of layout.zones) {
    z.polygon = z.polygon.map(([x, y]) => [x - ox, y - oy]);
    for (const fill of z.filled) fill.pts = fill.pts.map(([x, y]) => [x - ox, y - oy]);
  }
}

// -------------------------------------------------------------- the schematic

const PAPER = { A4: [297, 210], A3: [420, 297], A2: [594, 420], A: [279.4, 215.9], B: [431.8, 279.4] };

function libBox(sym) {
  const xs = [];
  const ys = [];
  const visit = (node) => {
    for (let i = 1; i < node.length; i++) {
      const item = node[i];
      if (!Array.isArray(item)) continue;
      const t = sxTag(item);
      if (t === "rectangle") {
        xs.push(sxNum(sxValue(item, "start", 1)), sxNum(sxValue(item, "end", 1)));
        ys.push(sxNum(sxValue(item, "start", 2)), sxNum(sxValue(item, "end", 2)));
      } else if (t === "polyline" || t === "bezier") {
        const pts = sxChild(item, "pts");
        for (const p of sxChildren(pts || [], "xy")) { xs.push(sxNum(p[1])); ys.push(sxNum(p[2])); }
      } else if (t === "circle") {
        const [cx, cy] = [sxNum(sxValue(item, "center", 1)), sxNum(sxValue(item, "center", 2))];
        const r = sxNum(sxValue(item, "radius", 1));
        xs.push(cx - r, cx + r);
        ys.push(cy - r, cy + r);
      } else if (t === "arc") {
        for (const key of ["start", "mid", "end"]) {
          xs.push(sxNum(sxValue(item, key, 1)));
          ys.push(sxNum(sxValue(item, key, 2)));
        }
      } else if (t === "pin") {
        xs.push(sxNum(sxValue(item, "at", 1)));
        ys.push(sxNum(sxValue(item, "at", 2)));
      } else if (t === "symbol") {
        visit(item);
      }
    }
  };
  visit(sym);
  if (!xs.length) return [-2.54, -2.54, 2.54, 2.54];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** Library frame (Y up) to sheet frame (Y down), with rotation and mirror. */
function toSheet(x, y, deg, mirror) {
  if (mirror === "x") y = -y;
  else if (mirror === "y") x = -x;
  const a = (deg * Math.PI) / 180;
  return [x * Math.cos(a) - y * Math.sin(a), -(x * Math.sin(a) + y * Math.cos(a))];
}

export function parseSchematic(text) {
  const doc = parseSexpr(text);
  if (sxTag(doc) !== "kicad_sch") throw new Error("this is not a .kicad_sch file");

  const lib = new Map();
  for (const sym of sxChildren(sxChild(doc, "lib_symbols") || [], "symbol")) {
    if (sym.length > 1) lib.set(sxStr(sym[1]), libBox(sym));
  }

  const symbols = [];
  for (const sym of sxChildren(doc, "symbol")) {
    const ref = propertyOf(sym, "Reference");
    if (!ref || ref.startsWith("#")) continue; // power and ground flags
    const [x, y, rot] = sxAt(sym);
    const mirror = sxStr(sxValue(sym, "mirror", 1, ""));
    const libId = sxStr(sxValue(sym, "lib_id", 1, ""));
    const [bx0, by0, bx1, by1] = lib.get(libId) || [-2.54, -2.54, 2.54, 2.54];
    const corners = [[bx0, by0], [bx1, by0], [bx1, by1], [bx0, by1]].map(([cx, cy]) =>
      toSheet(cx, cy, rot, mirror)
    );
    const cxs = corners.map((c) => c[0]);
    const cys = corners.map((c) => c[1]);
    symbols.push({
      ref,
      uuid: sxStr(sxValue(sym, "uuid", 1, "")),
      lib_id: libId,
      value: propertyOf(sym, "Value"),
      datasheet: propertyOf(sym, "Datasheet"),
      description: propertyOf(sym, "Description"),
      footprint: propertyOf(sym, "Footprint"),
      x: q4(x), y: q4(y), rot,
      bbox: [
        q4(x + Math.min(...cxs)), q4(y + Math.min(...cys)),
        q4(x + Math.max(...cxs)), q4(y + Math.max(...cys)),
      ],
    });
  }

  const paper = sxStr(sxValue(doc, "paper", 1, "A4")) || "A4";
  const [width, height] = PAPER[paper] || PAPER.A4;
  return { paper, width, height, symbols };
}

// -------------------------------------------------------------- put together

const refKey = (ref) => {
  const head = ref.replace(/\d+$/, "");
  const tail = ref.slice(head.length);
  return [head, tail ? Number(tail) : 0];
};

const byRef = (a, b) => {
  const [ah, an] = refKey(a.ref);
  const [bh, bn] = refKey(b.ref);
  return ah < bh ? -1 : ah > bh ? 1 : an - bn;
};

/**
 * Nets, straight off the copper.
 *
 * A pad carries its net, the chip's own name for the pin and the pin's
 * electrical type — everything the distiller and the rule checks read out of
 * the kicadxml export, without needing the export.
 */
function netsFromPads(footprints) {
  const nets = new Map();
  for (const fp of footprints) {
    for (const pad of fp.pads) {
      if (!pad.net || !fp.ref) continue;
      if (!nets.has(pad.net)) nets.set(pad.net, []);
      const nodes = nets.get(pad.net);
      // A part can carry the same pad number more than once — a thermal tab, a
      // split pad. One net list node is enough.
      if (nodes.some((n) => n.ref === fp.ref && n.pin === pad.num)) continue;
      nodes.push({ ref: fp.ref, pin: pad.num, function: pad.function, type: pad.type });
    }
  }
  return [...nets.entries()]
    .map(([name, nodes], i) => ({
      name,
      code: i + 1,
      nodes: nodes.sort((a, b) => byRef(a, b) || (a.pin < b.pin ? -1 : 1)),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export class BoardError extends Error {}

/**
 * A Board from a `.kicad_pcb` and, when there is one, its `.kicad_sch`.
 *
 * Without the schematic the designators come from the footprints' `Reference`
 * property, which is the silkscreen label — usually right, sometimes `BUCK`.
 * `joined` says which happened so the page can be honest about it.
 */
export function buildBoard({ name, pcbText, schText }) {
  const layout = parsePcb(pcbText);
  if (!layout.footprints.length) throw new BoardError("no footprints in this board");

  const schematic = schText ? parseSchematic(schText) : null;
  const byUuid = new Map((schematic?.symbols || []).map((s) => [s.uuid, s]));

  let joined = 0;
  for (const fp of layout.footprints) {
    const sym = byUuid.get(fp.uuid);
    if (sym) {
      fp.ref = sym.ref;
      joined += 1;
    } else {
      fp.ref = fp.silk;
    }
  }
  const unnamed = layout.footprints.filter((f) => !f.ref);
  if (unnamed.length === layout.footprints.length) {
    throw new BoardError("no footprint has a reference, so nothing can be identified");
  }
  layout.footprints.sort(byRef);

  const components = layout.footprints
    .filter((fp) => fp.ref)
    .map((fp) => {
      const sym = byUuid.get(fp.uuid);
      return {
        ref: fp.ref,
        value: sym?.value || fp.value || "",
        footprint: fp.library,
        description: sym?.description || fp.description || "",
        datasheet: sym?.datasheet || fp.datasheet || "",
        uuid: fp.uuid || fp.fp_uuid,
        ...(sym ? { sheet: { x: sym.x, y: sym.y, bbox: sym.bbox } } : {}),
      };
    })
    .sort(byRef);

  layout.tracks.forEach((t, i) => (t.id = `t${i}`));
  layout.vias.forEach((v, i) => (v.id = `v${i}`));
  layout.zones.forEach((z, i) => (z.id = `z${i}`));

  return {
    meta: {
      name,
      source: "uploaded",
      sheet: schematic
        ? { paper: schematic.paper, width: schematic.width, height: schematic.height }
        : { paper: "A4", width: 297, height: 210 },
      joined,
      hasSchematic: Boolean(schematic),
    },
    components,
    nets: netsFromPads(layout.footprints),
    layout,
  };
}

/** A one-line summary for the page to show after a load. */
export function summarise(board) {
  const l = board.layout;
  const pads = l.footprints.reduce((n, f) => n + f.pads.length, 0);
  return (
    `${board.components.length} parts · ${board.nets.length} nets · ${pads} pads · ` +
    `${l.tracks.length} tracks · ${l.vias.length} vias · ${l.zones.length} pours · ` +
    `${l.size.w.toFixed(0)}×${l.size.h.toFixed(0)} mm`
  );
}

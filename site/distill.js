// Board -> the text a reviewer reads. The mirror of harness/distill.py.
//
// The page has to send the board as the visitor just broke it, so the distiller
// has to run here. tests/fixtures/distill.json pins this against the Python:
// same board, same text, character for character, for the clean board and for
// all seven presets.

import { copperItems, islands, place } from "./copper.js";

export const PROMPT_VERSION = "distill-1";

const PACKAGE_TAIL = /^[^:]*:/;
const METRIC_IMPERIAL = /^[RCLD](?:_LED)?_(\d{4})_\d+Metric$/;
const HEADER = /^PinHeader_(\d+x\d+)_P([\d.]+)mm.*$/;
const LIB_BOILERPLATE =
  /(,?\s*script generated[\s\S]*$)|(^Generic connector,\s*)|(\s*\(kicad-library-utils[\s\S]*\)$)/gi;
// What is left of a pin header's description once the boilerplate is gone —
// and the package column already says 1x04hdr1.00mm.
const SAYS_NOTHING = /^single row,\s*\d+x\d+$/i;

const PIN_KIND = {
  power_in: "pwr-in",
  power_out: "pwr-out",
  open_collector: "oc",
  bidirectional: "",
  input: "in",
  output: "out",
  passive: "",
  tri_state: "tri",
  unspecified: "?",
};

const baseType = (pintype) => String(pintype || "").split("+")[0];

/** A rough token count. Four characters per token is close enough to budget by. */
export function approxTokens(text) {
  return Math.ceil(text.length / 4);
}

function packageName(footprint) {
  let tail = String(footprint || "").replace(PACKAGE_TAIL, "");
  const imperial = tail.match(METRIC_IMPERIAL);
  if (imperial) return imperial[1];
  const header = tail.match(HEADER);
  if (header) return `${header[1]}hdr${header[2]}mm`;
  tail = tail.replace(/_[\d.]+x[\d.]+mm.*$/, "");
  tail = tail.replace(/^MountingHole_/, "M-hole ");
  return tail || "-";
}

function shorten(text, words = 10) {
  const trimmed = String(text || "")
    .replace(LIB_BOILERPLATE, "")
    .replace(/^[\s,]+|[\s,]+$/g, "");
  if (SAYS_NOTHING.test(trimmed)) return "";
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length <= words) return parts.join(" ");
  return parts.slice(0, words).join(" ") + "…";
}

function nodeText(node) {
  let fn = node.function || "";
  const suffix = `_${node.pin}`;
  if (fn.endsWith(suffix)) fn = fn.slice(0, -suffix.length);
  if (!fn || fn.toLowerCase() === `pin_${node.pin}`.toLowerCase() || fn === node.pin) fn = "";
  const raw = baseType(node.type);
  const kind = raw in PIN_KIND ? PIN_KIND[raw] : raw;
  const inner = [fn, kind].filter(Boolean).join(",");
  return `${node.ref}.${node.pin}` + (inner ? `(${inner})` : "");
}

// Python sorts tuples; these comparators reproduce the same orders.
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byRefThenPin = (a, b) => cmp(a.ref, b.ref) || cmp(a.pin, b.pin);
const byDesignator = (a, b) =>
  cmp(a.ref[0], b.ref[0]) || a.ref.length - b.ref.length || cmp(a.ref, b.ref);

function componentsSection(board) {
  const lines = ["COMPONENTS  ref(s), value, package, description"];
  // Keyed on value plus package and insertion-ordered, like the Python's
  // list. The key is never split back apart: a value may contain a space.
  const grouped = new Map();
  for (const comp of [...board.components].sort(byDesignator)) {
    const pkg = packageName(comp.footprint);
    const value = comp.value || "-";
    if (/^(R|C|L|H|TP)/.test(comp.ref)) {
      const key = value + " " + pkg;
      if (!grouped.has(key)) grouped.set(key, { value, pkg, refs: [] });
      grouped.get(key).refs.push(comp.ref);
      continue;
    }
    let row = `${comp.ref} ${value} ${pkg}`;
    const description = shorten(comp.description);
    if (description) row += `  ${description}`;
    lines.push(row);
  }
  for (const group of grouped.values()) {
    lines.push(`${group.refs.join(",")} ${group.value} ${group.pkg}`);
  }
  return lines;
}

function netsSection(board) {
  const lines = [
    "NETS  name: ref.pin(pin name, type). Type is omitted where it is " +
      "passive or bidirectional.",
  ];
  const unconnected = [];
  for (const net of [...board.nets].sort((a, b) => cmp(a.name, b.name))) {
    if (net.name.startsWith("unconnected-")) {
      // Just the pin: see the note in harness/distill.py.
      unconnected.push(...net.nodes.map((n) => `${n.ref}.${n.pin}`));
      continue;
    }
    const nodes = [...net.nodes].sort(byRefThenPin).map(nodeText).join(" ");
    lines.push(`${net.name}: ${nodes}`);
  }
  if (unconnected.length) {
    lines.push(
      "UNCONNECTED pins, each its own net named unconnected-(REF-NAME-PadNUM):"
    );
    lines.push(unconnected.sort().join(" "));
  }
  return lines;
}

const trackLength = (t) => Math.hypot(t.x2 - t.x1, t.y2 - t.y1);

function copperSection(board) {
  const layout = board.layout;
  const groups = islands(board);

  const pads = new Map();
  for (const item of copperItems(board)) {
    if (item.kind === "pad" && item.net) pads.set(item.net, (pads.get(item.net) || 0) + 1);
  }
  const tracks = new Map();
  for (const track of layout.tracks) {
    if (!tracks.has(track.net)) tracks.set(track.net, []);
    tracks.get(track.net).push(track);
  }
  const vias = new Map();
  for (const via of layout.vias) vias.set(via.net, (vias.get(via.net) || 0) + 1);
  const pours = new Map();
  for (const zone of layout.zones) {
    if (zone.disabled) continue;
    if (!pours.has(zone.net)) pours.set(zone.net, []);
    pours.get(zone.net).push(zone.layer);
  }

  const lines = [
    `COPPER  board ${layout.size.w.toFixed(0)} x ${layout.size.h.toFixed(0)} mm, two layers: F.Cu top, B.Cu bottom`,
    "net, pads, copper islands, track mm, narrowest mm, vias, pours",
  ];
  const names = new Set([...pads.keys(), ...tracks.keys(), ...vias.keys(), ...pours.keys()]);
  for (const net of [...names].sort(cmp)) {
    if (!net || net.startsWith("unconnected-")) continue;
    const segs = tracks.get(net) || [];
    const total = segs.reduce((sum, t) => sum + trackLength(t), 0);
    const narrowest = segs.length ? Math.min(...segs.map((t) => t.width)) : 0;
    const islandCount = (groups.get(net) || []).filter((g) =>
      g.some((i) => i.kind === "pad")
    ).length;
    lines.push(
      [
        net,
        String(pads.get(net) || 0),
        String(islandCount),
        segs.length ? total.toFixed(0) : "none",
        segs.length ? narrowest.toFixed(2) : "-",
        String(vias.get(net) || 0),
        pours.has(net) ? [...pours.get(net)].sort(cmp).join("+") : "none",
      ].join(" ")
    );
  }
  return lines;
}

function decouplingSection(board) {
  // How far each supply pin is from the nearest capacitor on its own net. See
  // harness/distill.py for why this replaced a placement section keyed on what
  // had just been edited.
  const layout = board.layout;
  const pads = [];
  for (const fp of layout.footprints) {
    for (const pad of fp.pads) {
      if (!pad.net) continue;
      const [dx, dy] = place(pad.x, pad.y, fp.rot);
      pads.push({ ref: fp.ref, num: pad.num, net: pad.net, x: fp.x + dx, y: fp.y + dy });
    }
  }
  const caps = pads.filter((p) => p.ref.startsWith("C"));

  const rows = [];
  for (const net of board.nets) {
    for (const node of net.nodes) {
      if (!/^[US]\d+$/.test(node.ref)) continue;
      if (!["power_in", "power_out"].includes(baseType(node.type))) continue;
      const here = pads.find((p) => p.ref === node.ref && p.num === node.pin);
      if (!here) continue;
      let best = null;
      for (const cap of caps) {
        if (cap.net !== net.name) continue;
        const distance = Math.hypot(here.x - cap.x, here.y - cap.y);
        if (!best || distance < best[0] || (distance === best[0] && cap.ref < best[1])) {
          best = [distance, cap.ref];
        }
      }
      let fn = node.function || "";
      const suffix = `_${node.pin}`;
      if (fn.endsWith(suffix)) fn = fn.slice(0, -suffix.length);
      const label = `${node.ref}.${node.pin}` + (fn ? `(${fn})` : "");
      rows.push(
        best
          ? `${label} ${net.name} ${best[1]} ${best[0].toFixed(1)}`
          : `${label} ${net.name} none -`
      );
    }
  }
  if (!rows.length) return [];
  return [
    "DECOUPLING  supply pin, its net, the nearest capacitor on that net, mm away",
    ...rows.sort(cmp),
  ];
}

export function distill(board) {
  const blocks = [
    [
      `BOARD ${board.meta.name}`,
      `${board.components.length} components, ${board.nets.length} nets, ` +
        `${board.layout.footprints.length} footprints.`,
    ],
    componentsSection(board),
    netsSection(board),
    copperSection(board),
    decouplingSection(board),
  ];
  return blocks
    .filter((block) => block.length)
    .map((block) => block.join("\n"))
    .join("\n\n");
}

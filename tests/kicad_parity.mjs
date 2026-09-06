// site/kicad.js against the Python extractor, on the real board.
//
// The page can now read a KiCad project itself, with no kicad-cli and no
// server. That parser has to agree with extract/ — if it does not, an uploaded
// board is scored by rules that were written against a different reading of the
// same file.
//
// The one thing it cannot match exactly is the net list, and the difference is
// worth stating. The Python takes nets from the schematic's kicadxml export, so
// it sees pins that were never laid out — the `unconnected-(U2-PA10-Pad31)`
// nets, and mounting holes that have no copper. The browser takes them off the
// pads, so it sees exactly what is on the board. Every net with copper must
// match; the extras must all be schematic-only.
//
//   node tests/kicad_parity.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { buildBoard, summarise } = await import("file://" + join(root, "site", "kicad.js"));

const PCB = "C:/Users/pratham/Documents/PCBs/STM32/STM32/STM32.kicad_pcb";
const SCH = "C:/Users/pratham/Documents/PCBs/STM32/STM32/STM32.kicad_sch";

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

const want = JSON.parse(readFileSync(join(root, "boards", "stm32-good.json"), "utf8"));
const got = buildBoard({
  name: "stm32-good",
  pcbText: readFileSync(PCB, "utf8"),
  schText: readFileSync(SCH, "utf8"),
});

// ------------------------------------------------------------------- layout

check(
  got.layout.footprints.length === want.layout.footprints.length,
  `footprints: ${got.layout.footprints.length}, want ${want.layout.footprints.length}`
);
check(
  got.layout.tracks.length === want.layout.tracks.length,
  `tracks: ${got.layout.tracks.length}, want ${want.layout.tracks.length}`
);
check(got.layout.vias.length === want.layout.vias.length, `vias: ${got.layout.vias.length}`);
check(got.layout.zones.length === want.layout.zones.length, `zones: ${got.layout.zones.length}`);
check(
  Math.abs(got.layout.size.w - want.layout.size.w) < 0.001 &&
    Math.abs(got.layout.size.h - want.layout.size.h) < 0.001,
  `board size ${got.layout.size.w}x${got.layout.size.h}, want ${want.layout.size.w}x${want.layout.size.h}`
);

// The designator join is the whole reason the schematic is asked for.
check(got.meta.joined === 53, `${got.meta.joined} of 53 footprints joined on UUID`);
const renamed = got.layout.footprints.filter((f) => f.silk !== f.ref);
check(renamed.length === 11, `${renamed.length} silkscreen labels resolved, want 11`);

const wantFp = new Map(want.layout.footprints.map((f) => [f.ref, f]));
let placed = 0;
for (const fp of got.layout.footprints) {
  const other = wantFp.get(fp.ref);
  if (!other) {
    failures.push(`footprint ${fp.ref} is not in the Python board`);
    continue;
  }
  if (Math.abs(fp.x - other.x) > 0.001 || Math.abs(fp.y - other.y) > 0.001 || fp.rot !== other.rot) {
    failures.push(`${fp.ref} placed at ${fp.x},${fp.y}@${fp.rot}, Python says ${other.x},${other.y}@${other.rot}`);
  }
  if (fp.pads.length !== other.pads.length) {
    failures.push(`${fp.ref} has ${fp.pads.length} pads, Python says ${other.pads.length}`);
  }
  placed += 1;
}
check(placed === 53, `${placed} footprints compared`);

// Track geometry, every one of them, since the copper checks read it.
const key = (t) => `${t.x1.toFixed(4)},${t.y1.toFixed(4)},${t.x2.toFixed(4)},${t.y2.toFixed(4)},${t.width},${t.layer},${t.net}`;
const wantTracks = new Set(want.layout.tracks.map(key));
const missing = got.layout.tracks.filter((t) => !wantTracks.has(key(t)));
check(missing.length === 0, `${missing.length} tracks differ from the Python, e.g. ${missing[0] && key(missing[0])}`);

// ---------------------------------------------------------------- components

const wantComp = new Map(want.components.map((c) => [c.ref, c]));
check(got.components.length === 53, `${got.components.length} components, want 53`);
for (const comp of got.components) {
  const other = wantComp.get(comp.ref);
  if (!other) {
    failures.push(`component ${comp.ref} is not in the Python board`);
    continue;
  }
  if (comp.value !== other.value) {
    failures.push(`${comp.ref} value ${comp.value!==undefined?JSON.stringify(comp.value):"?"}, Python says ${JSON.stringify(other.value)}`);
  }
}

// ---------------------------------------------------------------------- nets

const wantNets = new Map(want.nets.map((n) => [n.name, n]));
const gotNets = new Map(got.nets.map((n) => [n.name, n]));

// Every net that carries copper must match the Python exactly, on membership.
const padNets = new Set();
for (const fp of want.layout.footprints) for (const pad of fp.pads) if (pad.net) padNets.add(pad.net);

for (const name of padNets) {
  const a = gotNets.get(name);
  const b = wantNets.get(name);
  if (!a) {
    failures.push(`net ${name} carries copper but the browser did not find it`);
    continue;
  }
  if (!b) continue;
  // The Python sees schematic-only pins too (a symbol with no footprint). Only
  // the pins that exist on the board can be compared.
  const boardRefs = new Set(want.layout.footprints.map((f) => f.ref));
  const mine = a.nodes.map((n) => `${n.ref}.${n.pin}`).sort();
  const theirs = b.nodes.filter((n) => boardRefs.has(n.ref)).map((n) => `${n.ref}.${n.pin}`).sort();
  if (JSON.stringify(mine) !== JSON.stringify(theirs)) {
    failures.push(`net ${name}: browser ${mine.join(" ")} / python ${theirs.join(" ")}`);
  }
}

// Pin names and types have to survive, or the datasheet checks lose their basis.
const fb = gotNets.get("/FB");
check(Boolean(fb), "/FB exists");
if (fb) {
  const s1 = fb.nodes.find((n) => n.ref === "S1");
  check(Boolean(s1), "/FB carries S1");
  check(s1 && s1.function === "VFB_4", `S1's pin name on /FB is ${s1 && s1.function}, want VFB_4`);
  check(s1 && s1.type === "input", `S1's pin type is ${s1 && s1.type}, want input`);
}

// ----------------------------------------------------- the checks still apply

const { islands } = await import("file://" + join(root, "site", "copper.js"));
let split = 0;
for (const [, groups] of islands(got)) {
  if (groups.filter((g) => g.some((i) => i.kind === "pad")).length > 1) split += 1;
}
check(split === 0, `${split} nets read as split on the board as manufactured`);

// And the distiller has to accept it.
const { distill, approxTokens } = await import("file://" + join(root, "site", "distill.js"));
const text = distill(got);
check(text.includes("COPPER"), "the distilled board has a copper section");
check(text.includes("S1 TPS563208DDCR"), "the distilled board names the buck and its part number");
check(approxTokens(text) < 4000, `distils to ${approxTokens(text)} tokens`);

// ------------------------------------------------------ without the schematic

const noSch = buildBoard({ name: "no-sch", pcbText: readFileSync(PCB, "utf8") });
check(noSch.meta.joined === 0, "without a schematic nothing joins on UUID");
check(
  noSch.layout.footprints.some((f) => f.ref === "BUCK"),
  "and the silkscreen label is what is left — which is the point of asking for the schematic"
);
check(noSch.nets.length > 30, `still finds the nets off the copper: ${noSch.nets.length}`);

for (const failure of failures) console.error("  x " + failure);
console.log(
  failures.length
    ? `${failures.length} kicad parity checks failed`
    : `the browser reads the same board as the Python: ${summarise(got)}`
);
process.exit(failures.length ? 1 : 0);

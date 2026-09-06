// site/render.js `place()` against KiCad's own plot.
//
// Every view and every copper check rests on this one transform. The reference
// values are pad centres read out of KiCad's layer-F_Cu.svg, in board-relative
// millimetres, and they are the same six that pin the Python side in
// tests/run.py step 3. If the two ever disagree, the page draws a board the
// harness is not scoring.
//
//   node tests/render_parity.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// render.js draws with it; copper.js owns it. Importing render.js here would
// also pull in the DOM calls, which node has no answer for.
const { place } = await import("file://" + join(root, "site", "copper.js"));

const board = JSON.parse(readFileSync(join(root, "boards", "stm32-good.json"), "utf8"));

const GOLDEN = {
  "U1.1": [48.1, 31.1],
  "U1.2": [45.8, 31.1],
  "U1.3": [43.5, 31.1],
  "C2.1": [51.3, 36.1],
  "R1.1": [55.21, 30.2],
  "Y1.1": [19.5, 10.95],
};

const failures = [];
const byRef = new Map(board.layout.footprints.map((f) => [f.ref, f]));

for (const [id, [wantX, wantY]] of Object.entries(GOLDEN)) {
  const [ref, num] = id.split(".");
  const fp = byRef.get(ref);
  const pad = fp?.pads.find((p) => p.num === num);
  if (!pad) {
    failures.push(`${id}: no such pad`);
    continue;
  }
  const [dx, dy] = place(pad.x, pad.y, fp.rot);
  const got = [fp.x + dx, fp.y + dy];
  const off = Math.hypot(got[0] - wantX, got[1] - wantY);
  if (off > 0.02) {
    failures.push(
      `${id}: place() gives ${got[0].toFixed(3)}, ${got[1].toFixed(3)}; ` +
        `KiCad plots ${wantX}, ${wantY} (off by ${off.toFixed(3)} mm)`
    );
  }
}

// Every pad must land inside the board outline, which catches a transform that
// is right on the six golden pads and wrong in a quadrant.
const { w, h } = board.layout.size;
let outside = 0;
for (const fp of board.layout.footprints) {
  for (const pad of fp.pads) {
    const [dx, dy] = place(pad.x, pad.y, fp.rot);
    const x = fp.x + dx;
    const y = fp.y + dy;
    if (x < -0.5 || x > w + 0.5 || y < -0.5 || y > h + 0.5) outside += 1;
  }
}
if (outside) failures.push(`${outside} of 199 pads land outside the board outline`);

for (const failure of failures) console.error("  x " + failure);
console.log(
  failures.length
    ? `${failures.length} render transform checks failed`
    : `place() matches KiCad's plot on all ${Object.keys(GOLDEN).length} reference pads, and all 199 pads land on the board`
);
process.exit(failures.length ? 1 : 0);

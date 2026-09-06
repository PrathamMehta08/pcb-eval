// What an edit looks like on the board, and what the clean board looks like.
//
// A schematic edit changes the net list and nothing else — the KiCad plot is a
// picture and the copper is deliberately untouched — so on its own it would
// leave no mark anywhere. What it does produce is a board that no longer agrees
// with itself, and that is drawable: the pad whose copper was laid for a net it
// is no longer on, and a line to the pin the schematic now says it joins.
//
// The load-bearing assertion is the first one. If the untouched board shows any
// divergence at all, every marker on the page is noise.
//
//   node tests/divergence.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { applyEdits } = await import("file://" + join(root, "site", "ops.js"));
const { divergence } = await import("file://" + join(root, "site", "render.js"));

const board = JSON.parse(readFileSync(join(root, "boards", "stm32-good.json"), "utf8"));
const fixture = JSON.parse(readFileSync(join(root, "tests", "fixtures", "distill.json"), "utf8"));

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

// How many of each the seven presets must produce. A value change touches no
// net, so it is visible only as the ring on the part it edited.
const EXPECTED = {
  clean: { stale: 0, stranded: 0 },
  "vfb-vbst-swap": { stale: 2, stranded: 0 },
  "stepper-common-open": { stale: 2, stranded: 0 },
  "servo-power-end-pin": { stale: 2, stranded: 0 },
  "ultrasonic-crossed": { stale: 2, stranded: 0 },
  "stepper-in4-floating": { stale: 1, stranded: 0 },
  "unbuildable-value": { stale: 0, stranded: 0 },
  "ground-stranded": { stale: 0, stranded: 32 },
};

for (const testCase of fixture.cases) {
  const work = JSON.parse(JSON.stringify(board));
  applyEdits(work, testCase.edits);
  const got = divergence(work);
  const want = EXPECTED[testCase.id];
  check(
    got.stale.length === want.stale,
    `${testCase.id}: ${got.stale.length} stale pads, want ${want.stale}`
  );
  check(
    got.stranded.length === want.stranded,
    `${testCase.id}: ${got.stranded.length} stranded pads, want ${want.stranded}`
  );
  // Every stale pad must have somewhere to point, or the ratsnest draws nothing
  // and the edit is invisible again.
  for (const item of got.stale) {
    check(
      item.to !== null,
      `${testCase.id}: ${item.ref}.${item.pin} has no pin to draw a ratsnest to`
    );
    check(
      !(item.to && item.to.ref === item.ref && item.to.pin === item.pin),
      `${testCase.id}: ${item.ref}.${item.pin} points its ratsnest at itself`
    );
  }
}

// The one that matters most, stated on its own: nothing is marked on a board
// nobody has touched.
{
  const got = divergence(JSON.parse(JSON.stringify(board)));
  check(
    got.stale.length === 0 && got.stranded.length === 0,
    `the untouched board is marked: ${got.stale.length} stale, ${got.stranded.length} stranded`
  );
}

// Undoing an edit must take the markers away with it.
{
  const work = JSON.parse(JSON.stringify(board));
  const { undo } = await import("file://" + join(root, "site", "ops.js"));
  const log = applyEdits(work, [
    { op: "move_pin", args: { ref: "S1", pin: "4", to_net: "VBST" } },
  ]);
  check(divergence(work).stale.length === 1, "one pin moved marks one pad");
  while (log.length) undo(work, log);
  const after = divergence(work);
  check(
    after.stale.length === 0 && after.stranded.length === 0,
    "undo clears the marks"
  );
}

for (const failure of failures) console.error("  x " + failure);
console.log(
  failures.length
    ? `${failures.length} divergence checks failed`
    : "the untouched board is unmarked; each preset marks exactly what it broke, and undo clears it"
);
process.exit(failures.length ? 1 : 0);

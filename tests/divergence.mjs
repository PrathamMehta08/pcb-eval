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

// What each generated defect on this board must produce. A schematic edit
// leaves the copper where it was, so the pads it moved go stale; a copper edit
// strands pads instead; a value change touches neither and shows only as a ring
// on the part it edited.
//
// `part-reversed` is the interesting one: it never touches the netlist at all,
// so the only trace of it is two pads that no longer reach their nets. That is
// the case this whole view exists for.
//
// Only this board's defects appear. The corpus spans two boards, and the other
// one's edits name refs that do not exist here.
const EXPECTED = {
  clean: { stale: 0, stranded: 0 },
  "stm32-good:supply-on-signal": { stale: 1, stranded: 0 },
  "stm32-good:ground-pin-lifted": { stale: 1, stranded: 0 },
  "stm32-good:outputs-shorted": { stale: 1, stranded: 0 },
  "stm32-good:regulator-io-swapped": { stale: 2, stranded: 0 },
  "stm32-good:feedback-from-input": { stale: 1, stranded: 0 },
  "stm32-good:divider-values-swapped": { stale: 0, stranded: 0 },
  "stm32-good:bulk-cap-undersized": { stale: 0, stranded: 0 },
  "stm32-good:companion-cap-oversized": { stale: 0, stranded: 0 },
  "stm32-good:part-reversed": { stale: 0, stranded: 2 },
  "stm32-good:value-unorderable": { stale: 0, stranded: 0 },
};

for (const testCase of fixture.cases) {
  if (!(testCase.id in EXPECTED)) continue; // a defect on the other board
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
  // A stale pad points at the nearest pin the schematic now says it joins, so
  // the ratsnest shows the connection the copper does not provide.
  //
  // Except when there is no such pin. Reassigning a pin to a net of its own -
  // which the editor allows and `ground-pin-lifted` does - leaves a pad that is
  // genuinely alone on its net, and `divergence` returns `to: null` for it.
  // `markDivergence` guards on that and draws the ring without the line, which
  // is the honest picture: the pad has moved and there is nothing to join it
  // to. Asserting a target always exists was the test being stricter than the
  // renderer, not the renderer being wrong.
  const alone = got.stale.filter((item) => item.to === null);
  for (const item of alone) {
    const net = work.nets.find((n) => n.name === item.wants);
    check(
      net !== undefined && net.nodes.length === 1,
      `${testCase.id}: ${item.ref}.${item.pin} has no ratsnest target but is not alone on ${item.wants}`
    );
  }
  for (const item of got.stale) {
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

// Replay tests/fixtures/distill.json through site/distill.js and compare text.
//
// The distilled board is what a review actually reads, so a drift between the
// Python and the browser means the harness scores a board the page never sends.
// This compares the two texts character for character.
//
//   node tests/distill_parity.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { applyEdits } = await import("file://" + join(root, "site", "ops.js"));
const { distill } = await import("file://" + join(root, "site", "distill.js"));

const board = JSON.parse(readFileSync(join(root, "boards", "stm32-good.json"), "utf8"));
const fixture = JSON.parse(readFileSync(join(root, "tests", "fixtures", "distill.json"), "utf8"));

const failures = [];
for (const testCase of fixture.cases) {
  const work = JSON.parse(JSON.stringify(board));
  applyEdits(work, testCase.edits);
  const got = distill(work, testCase.focus || []);
  if (got === testCase.text) continue;

  const a = got.split("\n");
  const b = testCase.text.split("\n");
  const at = a.findIndex((line, i) => line !== b[i]);
  failures.push(
    `${testCase.id}: line ${at + 1} differs\n` +
      `      js: ${JSON.stringify(a[at])}\n` +
      `      py: ${JSON.stringify(b[at])}` +
      (a.length !== b.length ? `\n      (js ${a.length} lines, py ${b.length})` : "")
  );
}

for (const failure of failures) console.error("  x " + failure);
console.log(
  failures.length
    ? `${failures.length} of ${fixture.cases.length} distilled boards differ`
    : `${fixture.cases.length} distilled boards match the Python character for character`
);
process.exit(failures.length ? 1 : 0);

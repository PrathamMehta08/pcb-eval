// Replay tests/fixtures/ops.json through site/ops.js and check every hash.
//
// The Python half of this lives in tests/run.py step 8. Both apply the same
// edit lists to the same board; if the two implementations have drifted, the
// canonical text differs and so do the sixteen characters.
//
//   node tests/ops_parity.mjs

import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { applyEdits, undo, boardHash } = await import(
  "file://" + join(root, "site", "ops.js")
);

const board = JSON.parse(readFileSync(join(root, "boards", "stm32-good.json"), "utf8"));
const fixture = JSON.parse(readFileSync(join(root, "tests", "fixtures", "ops.json"), "utf8"));

const clone = (value) => JSON.parse(JSON.stringify(value));
const failures = [];

const cleanHash = await boardHash(board);
if (cleanHash !== fixture.clean_hash) {
  failures.push(`clean board: js ${cleanHash}, py ${fixture.clean_hash}`);
}

for (const testCase of fixture.cases) {
  const work = clone(board);
  let log;
  try {
    log = applyEdits(work, testCase.edits);
  } catch (error) {
    failures.push(`${testCase.id}: threw ${error.message}`);
    continue;
  }
  const applied = await boardHash(work);
  if (applied !== testCase.hash) {
    failures.push(`${testCase.id}: after edits js ${applied}, py ${testCase.hash}`);
  }
  while (log.length) undo(work, log);
  const restored = await boardHash(work);
  if (restored !== testCase.undo_hash) {
    failures.push(`${testCase.id}: after undo js ${restored}, py ${testCase.undo_hash}`);
  }
}

for (const failure of failures) console.error("  x " + failure);
console.log(
  failures.length
    ? `${failures.length} of ${fixture.cases.length + 1} parity checks failed`
    : `${fixture.cases.length} edit cases plus the clean board agree, hash ${cleanHash}`
);
process.exit(failures.length ? 1 : 0);

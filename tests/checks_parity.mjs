// site/checks.js against harness/checks.py, on every board in the corpus.
//
// The page runs these rules now — before it asks a model anything, and again
// afterwards to refute what the model said. If the browser's copy and the
// Python's disagree, the page is scoring a board by different rules than the
// harness that produced the numbers in the README.
//
// The load-bearing assertion is the same one the Python has: the clean board
// trips nothing, and each seeded defect trips its own rule.
//
//   node tests/checks_parity.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { applyEdits } = await import("file://" + join(root, "site", "ops.js"));
const { runChecks, boardFacts, contradiction } = await import(
  "file://" + join(root, "site", "checks.js")
);

const board = JSON.parse(readFileSync(join(root, "boards", "stm32-good.json"), "utf8"));
const fixture = JSON.parse(readFileSync(join(root, "tests", "fixtures", "checks.json"), "utf8"));

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

for (const testCase of fixture.cases) {
  const work = JSON.parse(JSON.stringify(board));
  applyEdits(work, testCase.edits);
  const got = runChecks(work);

  const mine = got.map((f) => f.rule).sort();
  const theirs = [...testCase.rules].sort();
  if (JSON.stringify(mine) !== JSON.stringify(theirs)) {
    failures.push(`${testCase.id}: browser fires [${mine}], python fires [${theirs}]`);
    continue;
  }
  // Titles carry the measured numbers — 28 islands, 32 pads stranded — so they
  // have to agree too, or the two are measuring different things.
  const gotTitles = got.map((f) => f.title).sort();
  const wantTitles = [...testCase.titles].sort();
  if (JSON.stringify(gotTitles) !== JSON.stringify(wantTitles)) {
    failures.push(
      `${testCase.id}: titles differ\n      js: ${JSON.stringify(gotTitles)}\n      py: ${JSON.stringify(wantTitles)}`
    );
  }
  // And the refs, because section 8 grades findings by ref overlap.
  const gotRefs = JSON.stringify(got.map((f) => f.refs.slice().sort()));
  const wantRefs = JSON.stringify(testCase.refs.map((r) => r.slice().sort()));
  if (gotRefs !== wantRefs) {
    failures.push(`${testCase.id}: refs differ\n      js: ${gotRefs}\n      py: ${wantRefs}`);
  }
  check(
    got.every((f) => f.fix),
    `${testCase.id}: every rule recommends a fix`
  );
}

const clean = fixture.cases.find((c) => c.id === "clean");
check(clean && clean.rules.length === 0, "the clean board trips nothing in the fixture");
check(runChecks(JSON.parse(JSON.stringify(board))).length === 0, "and nothing in the browser");

// The refutation half, which is what the adjudicator uses.
{
  const facts = boardFacts(board);
  const cases = [
    [{ refs: ["U9"], nets: [], title: "U9 is wrong", why: "" }, true, "a part that does not exist"],
    [{ refs: [], nets: ["VBAT"], title: "x", why: "" }, true, "a net that does not exist"],
    [
      { refs: [], nets: ["GND"], title: "GND is stranded", why: "" },
      true,
      "a split claim the copper denies",
    ],
    [
      { refs: ["S1"], nets: ["/FB"], title: "the feedback divider is wrong", why: "" },
      false,
      "a claim about real parts on a real net",
    ],
    [
      { refs: ["R4"], nets: [], title: "R4 has no value", why: "" },
      true,
      "a no-value claim about a part that has one",
    ],
  ];
  for (const [item, shouldRefute, what] of cases) {
    const why = contradiction(item, facts);
    check(
      Boolean(why) === shouldRefute,
      `${what}: ${shouldRefute ? "should be refuted" : "should stand"}, got ${JSON.stringify(why)}`
    );
  }
}

for (const failure of failures) console.error("  x " + failure);
console.log(
  failures.length
    ? `${failures.length} rule parity checks failed`
    : `the browser runs the same ${fixture.cases.length - 1} rules as the Python, and refutes the same claims`
);
process.exit(failures.length ? 1 : 0);

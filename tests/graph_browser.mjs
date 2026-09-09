// site/graph.js against graph/v7.py: the page runs the architecture the sweep
// measured, not a picture of it.
//
// Four situations, and the first two are the ones that make a recall number on
// a seeded corpus worth reading at all.
//
//   The nodes run in order, and only two of them ask a model. A page that ran
//   three specialists while the README reported one reviewer would be a page
//   describing someone else's numbers.
//
//   The second look is shown the first pass's findings and nothing else. Shown
//   the rule findings it would be told where the deterministic layer already
//   looked, which on a seeded board is where the defect is.
//
//   The board refuses what it can disprove, without asking a model.
//
//   A finding naming a part that is not on the board never reaches the report.
//
//   node tests/graph_browser.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { applyEdits } = await import("file://" + join(root, "site", "ops.js"));
const { runGraph, MAX_PASSES, NODES, ASKS_MODEL } = await import(
  "file://" + join(root, "site", "graph.js")
);

const board = JSON.parse(readFileSync(join(root, "boards", "stm32-good.json"), "utf8"));
const clone = (b) => JSON.parse(JSON.stringify(b));

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

/** A stub model. `answers` is one reply per call, in order. */
function stub(answers) {
  const seen = { prompts: [], calls: 0 };
  const ask = async (prompt) => {
    seen.prompts.push(prompt);
    return answers[seen.calls++] ?? { findings: [] };
  };
  ask.seen = seen;
  return ask;
}

// --------------------------------------------------- the shape of the graph

{
  const ask = stub([{ findings: [] }, { findings: [] }]);
  const out = await runGraph(clone(board), ask, {});
  check(
    JSON.stringify(out.steps.map((s) => s.node)) === JSON.stringify(NODES),
    `the nodes run in order, got ${out.steps.map((s) => s.node).join(" -> ")}`
  );
  check(ask.seen.calls === 2, `two model calls for a board, got ${ask.seen.calls}`);
  check(
    ASKS_MODEL.size === 2 && ASKS_MODEL.has("review") && ASKS_MODEL.has("second_look"),
    "and exactly the two nodes that say they ask a model do"
  );
  check(MAX_PASSES === 1, "one pass: the loop went with the gate that drove it");
  check(out.stopped === "stop:one-pass", `stopped ${out.stopped}`);
}

// ------------------------------------------- what the second look is shown

{
  // The first pass finds something. Whatever it says must reach the second
  // look; whatever the rules found must not.
  const ask = stub([
    {
      findings: [
        {
          severity: "major",
          refs: ["R4"],
          nets: [],
          problem: "a thing the reviewer noticed",
          why: "w",
          fix: "f",
        },
      ],
    },
    { findings: [] },
  ]);
  const work = clone(board);
  // An edit the rules do catch, so there is something for a leak to leak.
  applyEdits(work, [{ op: "set_value", args: { ref: "R4", value: "R" } }]);
  const out = await runGraph(work, ask, {});
  check(out.rules.length > 0, "the rules found something on this board");

  const look = ask.seen.prompts[1];
  check(
    look.includes("ALREADY REPORTED") && look.includes("a thing the reviewer noticed"),
    "the second look is shown the first pass's own findings"
  );
  for (const rule of out.rules) {
    check(
      !look.includes(rule.title),
      `and not what the rules found: ${rule.title.slice(0, 40)}`
    );
  }
  check(
    !/HANDLED BY MEASUREMENT|net-island|value-not-orderable/.test(look),
    "nor the names of the checks that run"
  );
}

// ------------------------------------------ the board refuses what it can

{
  const ask = stub([
    {
      findings: [
        {
          severity: "critical",
          refs: ["U9"],
          nets: [],
          problem: "U9 is wired wrongly",
          why: "w",
          fix: "f",
        },
      ],
    },
    { findings: [] },
  ]);
  const out = await runGraph(clone(board), ask, {});
  const dropped = out.dropped.map((d) => d.title);
  check(
    dropped.includes("U9 is wired wrongly"),
    `a finding about a part that is not on the board is refused: ${JSON.stringify(dropped)}`
  );
  check(
    !out.findings.some((f) => f.title === "U9 is wired wrongly"),
    "and it does not reach the report"
  );
  const validate = out.steps.find((s) => s.node === "validate");
  check(validate && !ASKS_MODEL.has("validate"), "and no model was asked whether to");
}

// -------------------------------------- the rules reach the report as well

{
  const work = clone(board);
  applyEdits(work, [{ op: "set_value", args: { ref: "R4", value: "R" } }]);
  const ask = stub([{ findings: [] }, { findings: [] }]);
  const out = await runGraph(work, ask, {});
  check(
    out.findings.length >= out.rules.length,
    "what the rules measured is reported even when the reviewer says nothing"
  );
  const aggregate = out.steps.find((s) => s.node === "aggregate");
  check(
    aggregate?.fromRules === out.rules.length,
    `and the report says how many came from measurement, got ${aggregate?.fromRules}`
  );
}

for (const failure of failures) console.error("  x " + failure);
console.log(
  failures.length
    ? `${failures.length} browser-graph checks failed`
    : "the page walks the five nodes, asks the model twice, and leaks nothing to the second look"
);
process.exit(failures.length ? 1 : 0);

// The browser graph against a stub Claude — the wiring, the loop, the gate.
//
// The mirror of tests/run.py step 12, which does the same to graph/build.py.
// Everything except the quality of the findings is decidable without a network:
// which nodes run and in what order, whether the gate loops, and whether the
// board throws out what it can refute.
//
//   node tests/graph_browser.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { applyEdits } = await import("file://" + join(root, "site", "ops.js"));
const { runGraph, MAX_PASSES, REVIEWERS } = await import("file://" + join(root, "site", "graph.js"));

const board = JSON.parse(readFileSync(join(root, "boards", "stm32-good.json"), "utf8"));
const clone = (v) => JSON.parse(JSON.stringify(v));

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

/** A Claude that says what the test tells it to, and counts the asking. */
function stub(byNode = {}) {
  const asked = [];
  const ask = async (prompt) => {
    // Which node is asking is legible from the job at the top of the prompt.
    const node =
      REVIEWERS.find((n) => prompt.includes(JOB_MARK[n])) ??
      (prompt.includes("merging three reviews") ? "adjudicate" : "?");
    asked.push(node);
    return byNode[node] ?? { findings: [] };
  };
  ask.asked = asked;
  return ask;
}
const JOB_MARK = {
  datasheet: "Your area is what each pin is for",
  connections: "Your area is the wiring between parts",
  layout: "Your area is placement and copper",
};

// A clean board gives the rules nothing to chase: one pass, then stop.
{
  const ask = stub();
  const out = await runGraph(clone(board), ask);
  check(out.stopped === "stop:nothing-to-chase", `clean board stopped ${out.stopped}`);
  check(out.passes === 1, `clean board took ${out.passes} passes`);
  check(
    JSON.stringify(ask.asked) === JSON.stringify(REVIEWERS),
    `every reviewer ran once, in order: ${ask.asked}`
  );
  check(out.steps[0].node === "ingest" && out.steps[0].measured, "ingest runs first and is measured");
  check(out.steps.at(-1).node === "gate", "the gate runs last");
}

const broken = clone(board);
applyEdits(broken, [
  { op: "set_value", args: { ref: "R4", value: "R" } },
]);

// A rule fires and nothing the model says accounts for it: loop, then give up
// rather than call the board clean.
{
  const ask = stub({
    datasheet: {
      findings: [{ problem: "something unrelated", refs: ["U2"], severity: "minor", why: "", fix: "" }],
    },
  });
  const out = await runGraph(clone(broken), ask);
  check(out.stopped === "stop:passes-spent", `unaccounted rule stopped ${out.stopped}`);
  check(out.passes === MAX_PASSES, `it used ${out.passes} of ${MAX_PASSES} passes`);
  check(ask.asked.filter((n) => n === "datasheet").length === 2, "the datasheet node ran twice");
  const gates = out.steps.filter((s) => s.node === "gate");
  check(gates.length === 2, `two gate decisions, got ${gates.length}`);
  check(gates[0].decision === "again", `the first gate said ${gates[0].decision}`);
  check(
    gates[0].unaccounted.includes("unbuildable-value"),
    `the gate names what is outstanding: ${gates[0].unaccounted}`
  );
}

// A finding that overlaps the rule ends it after one pass.
{
  const ask = stub({
    datasheet: {
      findings: [{ problem: "R4 has no value", refs: ["R4"], severity: "major", why: "", fix: "Give it one." }],
    },
  });
  const out = await runGraph(clone(broken), ask);
  check(out.stopped === "stop:rules-accounted-for", `matched rule stopped ${out.stopped}`);
  check(out.passes === 1, "in one pass");
}

// And the board throws out what it can refute, with no model consulted.
{
  const ask = stub({
    datasheet: {
      findings: [
        { problem: "U9 is wrong", refs: ["U9"], severity: "major", why: "", fix: "" },
        { problem: "GND is stranded", nets: ["GND"], severity: "critical", why: "", fix: "" },
        { problem: "R4 has no value", refs: ["R4"], severity: "major", why: "", fix: "" },
      ],
    },
  });
  const out = await runGraph(clone(broken), ask);
  const droppedTitles = out.dropped.map((d) => d.title);
  check(droppedTitles.includes("U9 is wrong"), `a part that does not exist is refuted: ${droppedTitles}`);
  check(
    droppedTitles.includes("GND is stranded"),
    "a split claim the copper denies is refuted"
  );
  check(
    out.findings.some((f) => f.title === "R4 has no value"),
    "and the one the board agrees with survives"
  );
}

// A reviewer writing D2.2 means pin 2 of D2, not a part called D2.2.
{
  const ask = stub({
    layout: {
      findings: [
        {
          problem: "the +5V rail is thin",
          refs: ["D2.2"],
          nets: ["U2.1(VBAT,pwr-in)", "+5V"],
          severity: "major",
          why: "",
          fix: "Widen it.",
        },
      ],
    },
  });
  const out = await runGraph(clone(board), ask);
  const item = out.findings[0];
  check(Boolean(item), "the finding survived rather than being refuted as invented");
  if (item) {
    check(
      item.refs.includes("D2") && item.refs.includes("U2"),
      `pin references become part references: ${JSON.stringify(item.refs)}`
    );
    check(item.nets.includes("+5V") && item.nets.length === 1, `nets: ${JSON.stringify(item.nets)}`);
  }
}

// Steps are reported as they run, so the page can show the pipeline moving.
{
  const seen = [];
  const ask = stub();
  await runGraph(clone(board), ask, {
    onStep: (step) => seen.push(`${step.node}${step.running ? ":start" : ":done"}`),
  });
  check(seen.includes("datasheet:start"), "a node is reported when it starts");
  check(seen.includes("datasheet:done"), "and again when it finishes");
  check(seen.indexOf("datasheet:start") < seen.indexOf("datasheet:done"), "in that order");
}

for (const failure of failures) console.error("  x " + failure);
console.log(
  failures.length
    ? `${failures.length} browser graph checks failed`
    : "the browser graph runs its nodes in order, loops on an unaccounted rule, gives up rather than passing a bad board, and refutes what the copper denies"
);
process.exit(failures.length ? 1 : 0);

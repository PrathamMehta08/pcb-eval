// The four spending limits in site/review.js, and the grading rule.
//
// Money is spent per review on the viewer's own account, so these are not
// nice-to-haves. Each one is asserted here against a stub Claude that counts
// how many times it was actually asked.
//
// The module keeps its state in localStorage and mirrors it in module memory,
// so "a fresh browser" means a fresh module instance as well as an empty store.
// `load()` imports with a cache-busting query, which is what a reload does.
//
//   node tests/review_limits.mjs

import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const reviewUrl = "file://" + join(root, "site", "review.js");
const { applyEdits } = await import("file://" + join(root, "site", "ops.js"));

const board = JSON.parse(readFileSync(join(root, "boards", "stm32-good.json"), "utf8"));
const clone = (v) => JSON.parse(JSON.stringify(v));

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

/** A working localStorage, replaced whenever a case wants a fresh browser. */
function useStore() {
  const map = new Map();
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
  return map;
}

/** One that throws on every access, the way a blocked-site-data browser does. */
function useBrokenStore() {
  const boom = () => {
    throw new Error("site data is blocked");
  };
  globalThis.localStorage = { getItem: boom, setItem: boom, removeItem: boom, clear: boom };
}

let generation = 0;
/** A fresh module instance — the equivalent of reloading the page. */
const load = () => import(`${reviewUrl}?v=${++generation}`);

// One review is three model calls — two reviewers and a merge, or five when
// the gate loops — so what the limits are about is reviews, not calls.
// `asked` counts calls; `reviews` counts the graph runs they belong to,
// keyed off the circuit reviewer's prompt.
function stubSample(findings = []) {
  const stub = { asked: 0, reviews: 0, lastPrompt: "" };
  stub.json = async (prompt) => {
    stub.asked += 1;
    // The first node's job text marks the start of a graph run. It was the
    // circuit specialist's opening line; that reviewer no longer exists, and
    // matching a line nothing sends counted every review as zero.
    if (prompt.includes("Review this board before it is manufactured")) stub.reviews += 1;
    stub.lastPrompt = prompt;
    return { findings };
  };
  return stub;
}

async function expectCode(promise, code, label) {
  try {
    await promise;
    failures.push(`${label}: expected to be refused with ${code}, but it went through`);
  } catch (error) {
    check(error.code === code, `${label}: expected ${code}, got ${error.code}`);
  }
}

// ---------------------------------------------------------------- the prompt

{
  useStore();
  const review = await load();
  const prompt = review.buildPrompt("BOARD stm32-good\nNETS\n/FB: R2.2 R3.1 S1.4");
  check(prompt.includes("/FB: R2.2"), "the prompt carries the distilled board");
  check(prompt.includes('"findings"'), "the prompt states the output schema");
  check(/JSON only/i.test(prompt), "the prompt asks for JSON only");
}

// ------------------------------------------------- caching, then the interval

{
  useStore();
  const review = await load();
  const sample = stubSample([
    { severity: "critical", refs: ["S1"], nets: ["/FB"], title: "x", why: "y" },
  ]);
  const work = clone(board);

  const first = await review.review(sample, work, {});
  check(sample.reviews === 1, `the first review runs the graph once (${sample.asked} calls)`);
  check(first.cached === false, "the first review is not a cache hit");

  const second = await review.review(sample, work, {});
  check(sample.reviews === 1, `a repeat of the same board must not run again (${sample.reviews})`);
  check(second.cached === true, "the repeat is reported as cached");
  check(second.findings.length === 1, "the cached verdict carries its findings");

  // A different board misses the cache, and the ten seconds then bite.
  const edited = clone(board);
  applyEdits(edited, [{ op: "set_value", args: { ref: "R4", value: "R" } }]);
  await expectCode(review.review(sample, edited, {}), "cooldown", "ten second interval");
  check(sample.reviews === 1, "a refused review must not have run the graph again");
}

// ------------------------------------------------------------ no session cap
//
// The page used to stop after five reviews per browser, which fell hardest on
// the person exploring their own board. The count is still kept, because how
// many reviews have run is worth knowing, but nothing is refused on it. The
// cooldown is what remains, and it is a different thing: it stops a held-down
// button from hammering a service that is already failing.

{
  useStore();
  const review = await load();
  localStorage.setItem("pcb-eval.reviewCount.v1", "500");
  check(review.budget.used() === 500, "the count is read back");

  const sample = stubSample();
  const fresh = clone(board);
  applyEdits(fresh, [{ op: "set_value", args: { ref: "R5", value: "2k2" } }]);
  const out = await review.review(sample, fresh, {});
  check(out.cached === false, "a board reviewed after 500 others still runs");
  check(sample.reviews === 1, "and it really did run rather than answering from cache");
}

// A board already in the cache answers without running the graph, whatever the
// count says. That was the point of the cache before the cap existed and it is
// still the point now.
{
  useStore();
  const review = await load();
  const sample = stubSample([
    { severity: "minor", refs: ["R4"], nets: [], title: "cached one", why: "" },
  ]);
  const work = clone(board);
  applyEdits(work, [{ op: "set_value", args: { ref: "R4", value: "R" } }]);
  await review.review(sample, work, {});
  const replayed = await review.review(sample, work, {});
  check(replayed.cached === true, "a cached board answers from the cache");
  check(sample.reviews === 1, "and it did not run the graph again");
}

// ------------------------------------------- storage that is not there at all

{
  useBrokenStore();
  const review = await load();
  const sample = stubSample();
  const work = clone(board);
  applyEdits(work, [{ op: "set_value", args: { ref: "R6", value: "330" } }]);

  await review.review(sample, work, {});
  check(sample.reviews === 1, "with storage blocked, the first review still goes through");

  // The bug this replaces: with every storage access throwing, the counter, the
  // interval and the cache all read back empty, so three clicks in one second
  // made three live calls for one board and the budget never moved.
  const other = clone(board);
  applyEdits(other, [{ op: "set_value", args: { ref: "R7", value: "2k2" } }]);
  await expectCode(review.review(sample, other, {}), "cooldown", "interval without storage");
  check(sample.reviews === 1, "and no second review was run");

  const again = await review.review(sample, work, {});
  check(again.cached === true, "the cache still replays without storage");
  check(review.budget.used() === 1, `the counter still counts (${review.budget.used()})`);
}

// ----------------------------------------------------------- no sample at all

{
  useStore();
  const review = await load();
  const work = clone(board);
  applyEdits(work, [{ op: "set_value", args: { ref: "R6", value: "330" } }]);
  await expectCode(review.review(null, work, {}), "unavailable", "no sample capability");
}

// -------------------------------------------------------------------- grading

{
  useStore();
  const { grade } = await load();
  const defect = { id: "vfb-vbst-swap", title: "swap", refs: ["S1"], nets: ["/FB", "VBST"] };

  const byRef = grade([{ refs: ["S1"], nets: [], title: "a" }], [defect]);
  check(byRef.caught.length === 1, "a shared ref counts as caught");

  const byNet = grade([{ refs: [], nets: ["FB"], title: "b" }], [defect]);
  check(byNet.caught.length === 1, "a net matches with or without the leading slash");

  const byWords = grade(
    [{ refs: ["U2"], nets: ["/TRIG"], title: "feedback and bootstrap swapped on S1" }],
    [defect]
  );
  check(
    byWords.caught.length === 0 && byWords.other.length === 1,
    "wording alone never counts as caught"
  );

  const scattergun = grade(
    [
      { refs: ["S1"], nets: [], title: "one" },
      { refs: ["S1"], nets: [], title: "two" },
    ],
    [defect]
  );
  check(
    scattergun.caught.length === 1 && scattergun.other.length === 1,
    "one finding accounts for one defect; the rest are unmatched"
  );

  const cleanBoard = grade([{ refs: ["C1"], nets: [], title: "invented" }], []);
  check(
    cleanBoard.other.length === 1 && cleanBoard.caught.length === 0,
    "every finding on a clean board is a false alarm"
  );
}

for (const failure of failures) console.error("  x " + failure);
console.log(
  failures.length
    ? `${failures.length} review-limit checks failed`
    : "cache, cooldown, an absent cap, blocked storage, absence and grading all hold"
);
process.exit(failures.length ? 1 : 0);

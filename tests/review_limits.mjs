// The four spending limits in site/review.js, and the grading rule.
//
// Money is spent per review on the viewer's own account, so these are not
// nice-to-haves. Each one is asserted here against a stub Claude that counts
// how many times it was actually asked.
//
//   node tests/review_limits.mjs

import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

// review.js keeps its cache and its session counter in localStorage. Node has
// none, so here is one, and clearing it is how each case starts fresh.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { applyEdits } = await import("file://" + join(root, "site", "ops.js"));
const review = await import("file://" + join(root, "site", "review.js"));

const board = JSON.parse(readFileSync(join(root, "boards", "stm32-good.json"), "utf8"));
const clone = (v) => JSON.parse(JSON.stringify(v));

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

function stubSample(findings = []) {
  const stub = { asked: 0, lastPrompt: "" };
  stub.json = async (prompt) => {
    stub.asked += 1;
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
  const prompt = review.buildPrompt("BOARD stm32-good\nNETS\n/FB: R2.2 R3.1 S1.4");
  check(prompt.includes("/FB: R2.2"), "the prompt carries the distilled board");
  check(prompt.includes('"findings"'), "the prompt states the output schema");
  check(/JSON only/i.test(prompt), "the prompt asks for JSON only");
}

// ------------------------------------------------------------------- caching

{
  store.clear();
  const sample = stubSample([{ severity: "critical", refs: ["S1"], nets: ["/FB"], title: "x", why: "y" }]);
  const work = clone(board);
  const first = await review.review(sample, work, {});
  check(sample.asked === 1, "the first review asks Claude once");
  check(first.cached === false, "the first review is not a cache hit");

  const second = await review.review(sample, work, {});
  check(sample.asked === 1, `a repeat of the same board must not ask again (asked ${sample.asked})`);
  check(second.cached === true, "the repeat is reported as cached");
  check(second.findings.length === 1, "the cached verdict carries its findings");
}

// A different board must miss the cache, and the cooldown must then bite.
{
  const edited = clone(board);
  applyEdits(edited, [{ op: "set_value", args: { ref: "R4", value: "R" } }]);
  const sample = stubSample();
  await expectCode(review.review(sample, edited, {}), "cooldown", "ten second interval");
  check(sample.asked === 0, "a refused review must not have asked Claude");
}

// --------------------------------------------------------------- session cap

{
  store.clear();
  localStorage.setItem("pcb-eval.reviewCount.v1", String(review.SESSION_CAP));
  check(review.budget.left() === 0, "the session cap is reached");
  const sample = stubSample();
  const fresh = clone(board);
  applyEdits(fresh, [{ op: "set_value", args: { ref: "R5", value: "2k2" } }]);
  await expectCode(review.review(sample, fresh, {}), "capped", "session cap");
  check(sample.asked === 0, "a capped review must not have asked Claude");
}

// A board already in the cache still works after the cap, which is the point:
// the presets keep answering, only live review stops.
{
  store.clear();
  const sample = stubSample([{ severity: "minor", refs: ["R4"], nets: [], title: "cached one", why: "" }]);
  const work = clone(board);
  applyEdits(work, [{ op: "set_value", args: { ref: "R4", value: "R" } }]);
  await review.review(sample, work, {});
  localStorage.setItem("pcb-eval.reviewCount.v1", String(review.SESSION_CAP));
  const replayed = await review.review(sample, work, {});
  check(replayed.cached === true, "a cached board still answers after the cap");
  check(sample.asked === 1, "and it did not ask Claude again");
}

// ----------------------------------------------------------- no sample at all

{
  store.clear();
  const work = clone(board);
  applyEdits(work, [{ op: "set_value", args: { ref: "R6", value: "330" } }]);
  await expectCode(review.review(null, work, {}), "unavailable", "no sample capability");
}

// -------------------------------------------------------------------- grading

{
  const defect = { id: "vfb-vbst-swap", title: "swap", refs: ["S1"], nets: ["/FB", "VBST"] };

  const byRef = review.grade([{ refs: ["S1"], nets: [], title: "a" }], [defect]);
  check(byRef.caught.length === 1, "a shared ref counts as caught");

  const byNet = review.grade([{ refs: [], nets: ["FB"], title: "b" }], [defect]);
  check(byNet.caught.length === 1, "a net matches with or without the leading slash");

  const byWords = review.grade(
    [{ refs: ["U2"], nets: ["/TRIG"], title: "feedback and bootstrap swapped on S1" }],
    [defect]
  );
  check(
    byWords.caught.length === 0 && byWords.other.length === 1,
    "wording alone never counts as caught"
  );

  const scattergun = review.grade(
    [{ refs: ["S1"], nets: [], title: "one" }, { refs: ["S1"], nets: [], title: "two" }],
    [defect]
  );
  check(
    scattergun.caught.length === 1 && scattergun.other.length === 1,
    "one finding accounts for one defect; the rest are unmatched"
  );

  const cleanBoard = review.grade([{ refs: ["C1"], nets: [], title: "invented" }], []);
  check(
    cleanBoard.other.length === 1 && cleanBoard.caught.length === 0,
    "every finding on a clean board is a false alarm"
  );
}

for (const failure of failures) console.error("  x " + failure);
console.log(
  failures.length
    ? `${failures.length} review-limit checks failed`
    : "cache, cooldown, session cap, absence and grading all hold"
);
process.exit(failures.length ? 1 : 0);

// The reviewer's pack stays mostly board, however many datasheets are attached.
//
// WHAT WENT WRONG
//
// `passagesBlock` took three whole chunks per documented part with no ceiling
// anywhere. The distilled board is 810 words and three chunks are about 970, so
// one documented part made the pack 56% datasheet, three made it 79%, and six
// would have reached 89%.
//
// That is the architecture inverted. Every measurement this project has taken
// says the reviewer wants the whole board - splitting it between specialists is
// what V2 through V6 lost recall doing. Attaching datasheets was doing the same
// thing by dilution, and getting worse with every document somebody added.
//
// So four properties are asserted here, and the last one is the point: the pack
// stops growing.
//
//   node tests/doc_budget.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const docs = await import("file://" + join(root, "site", "docs.js"));
const { distill } = await import("file://" + join(root, "site", "distill.js"));

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

const board = JSON.parse(readFileSync(join(root, "boards", "stm32-good.json"), "utf8"));
const words = (s) => String(s || "").split(/\s+/).filter(Boolean).length;

// A stand-in datasheet long enough to matter: six pages of filler with one
// paragraph per page that a board query could plausibly land on. Real PDFs are
// not in the repository and a test may not reach for a vendor CDN.
const pages = [];
for (let n = 0; n < 6; n += 1) {
  pages.push(
    `Section ${n} Electrical Characteristics supply input voltage range 4.5 to 17 V ` +
      `operating junction temperature thermal resistance junction to ambient ` +
      "filler ".repeat(400)
  );
}

// Every part the board has, so the pack can be measured as documents pile up.
const refs = board.components.slice(0, 6).map((c) => c.ref);
const boardWords = words(distill(board));
const budget = Math.round(boardWords * 0.35);

await docs.loadDocs(board.meta.name);
check(docs.passagesBlock(board, budget).length === 0, "no documents means no section at all");

const sizes = [];
for (const ref of refs) {
  await docs.attach(board.meta.name, ref, { name: `${ref}.pdf`, pages });
  const block = docs.passagesBlock(board, budget);
  sizes.push({ ref, docs: sizes.length + 1, words: words(block.join("\n")) });
}

// 1. Something comes back. A budget that silently returns nothing is a worse
//    bug than the one it replaced, because nobody sees it happen.
check(sizes[0].words > 0, "one documented part produces at least one passage");

// 2. The budget holds. Not approximately - the section is built by adding whole
//    passages and stopping, so it can only ever be under.
for (const row of sizes) {
  check(
    row.words <= budget + 1,
    `${row.docs} documented parts stay inside the ${budget}-word budget, got ${row.words}`
  );
}

// 3. The board keeps its own pack. This is the number the whole change exists
//    for: it used to be 21% at three parts.
const worst = Math.max(...sizes.map((s) => s.words));
const share = worst / (boardWords + worst);
check(
  share < 0.3,
  `the datasheet section stays under 30% of the pack, got ${Math.round(share * 100)}%`
);

// 4. It stops growing. Six documents may not cost more than two - which is
//    exactly what the old section did, linearly and without limit.
check(
  sizes[5].words <= sizes[1].words + 1,
  `six documents cost no more than two: ${sizes[1].words} then ${sizes[5].words}`
);

// And the budget is still a budget: asked for nothing, it gives nothing.
check(docs.passagesBlock(board, 0).length === 0, "a zero budget produces no section");

for (const failure of failures) console.error("  x " + failure);
console.log(
  failures.length
    ? `${failures.length} pack-budget checks failed`
    : `the datasheet section is bounded: ${sizes[0].words}w at one part, ` +
      `${sizes[5].words}w at six, against a ${boardWords}-word board`
);
process.exit(failures.length ? 1 : 0);

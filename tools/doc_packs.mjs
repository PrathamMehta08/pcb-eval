// The datasheet block each corpus board would get in the browser.
//
// The page attaches documents to parts and retrieves passages from them; the
// harness runs offline and never has. That gap is why the browser's pack went
// unmeasured long enough to grow to four fifths datasheet text - so this hands
// the browser's own retrieval across to the sweep rather than reimplementing it
// in Python, which would make retrieval the fifth thing written twice.
//
// Two variants, because the point is a comparison:
//
//   before  three whole chunks per documented part, no ceiling. What the page
//           shipped, and what made the board 21% of its own pack.
//   after   passagesBlock's budget: a share of the board, spent round-robin,
//           each passage narrowed to the span that earned it.
//
//   node tools/doc_packs.mjs <cases.json> <pages.json> <out.json>

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const docs = await import("file://" + join(root, "site", "docs.js"));
const { pinsByRef } = await import("file://" + join(root, "site", "checks.js"));
const { distill } = await import("file://" + join(root, "site", "distill.js"));

const [casesPath, pagesPath, outPath] = process.argv.slice(2);
const cases = JSON.parse(readFileSync(casesPath, "utf8"));
const pages = JSON.parse(readFileSync(pagesPath, "utf8"));

const wordsIn = (s) => String(s || "").split(/\s+/).filter(Boolean).length;

/**
 * The section as it stood before the budget: three whole chunks per part.
 *
 * Kept here rather than in site/, because it is the thing being argued against
 * and a benchmark needs both sides. It is the old `passagesBlock` verbatim -
 * `passagesFor(..., 3)` with no width, which is a whole 350-word chunk.
 */
function unbudgeted(board) {
  const attached = docs.docsFor(board.meta.name);
  if (!attached.size) return "";
  const pins = pinsByRef(board);
  const lines = ["RETRIEVED DOCUMENTATION  verbatim, from documents attached to this board"];
  for (const ref of [...attached.keys()].sort()) {
    for (const hit of docs.passagesFor(board, ref, pins.get(ref) || [], 3)) {
      const where = [`${hit.source} p${hit.page}`, hit.section].filter(Boolean).join(", ");
      lines.push(`${ref} (${where}): ${hit.text}`);
    }
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

/** What the page builds now: budgeted at a share of the distilled board. */
const RATIO = 0.35;
function budgeted(board) {
  const block = docs.passagesBlock(board, Math.round(wordsIn(distill(board)) * RATIO));
  return block.length ? block.join("\n") : "";
}

const out = { before: {}, after: {} };
const rows = [];

for (const item of cases) {
  const board = item.board;
  // A fresh store per case. `loadDocs` clears the built indexes too, which
  // matters: an index keyed on board name and ref would otherwise be reused
  // across two boards of the same name carrying different edits.
  await docs.loadDocs(board.meta.name);
  let attached = 0;
  for (const [ref, doc] of Object.entries(pages)) {
    // Designator AND part. Both boards have a U1 and they are different chips,
    // so matching on the designator alone handed dcdcc's regulator the
    // AMS1117's datasheet - the same mistake as joining a schematic to a layout
    // by reference, which this repository already learned the hard way.
    if (!board.components.some((c) => c.ref === ref && c.value === doc.part)) continue;
    await docs.attach(board.meta.name, ref, { name: doc.source, pages: doc.pages });
    attached += 1;
  }
  const before = unbudgeted(board);
  const after = budgeted(board);
  out.before[item.id] = before;
  out.after[item.id] = after;

  const boardWords = wordsIn(distill(board));
  rows.push({
    id: item.id,
    attached,
    board: boardWords,
    before: wordsIn(before),
    after: wordsIn(after),
  });
}

writeFileSync(outPath, JSON.stringify(out, null, 1), "utf8");

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);
console.log(
  `${pad("case", 24)}${num("docs", 5)}${num("board", 7)}${num("before", 8)}${num("sheet%", 8)}` +
    `${num("after", 8)}${num("sheet%", 8)}`
);
console.log("-".repeat(68));
for (const r of rows) {
  const bp = r.before ? Math.round((r.before / (r.board + r.before)) * 100) : 0;
  const ap = r.after ? Math.round((r.after / (r.board + r.after)) * 100) : 0;
  console.log(
    pad(r.id, 24) + num(r.attached, 5) + num(r.board, 7) +
      num(r.before, 8) + num(bp + "%", 8) + num(r.after, 8) + num(ap + "%", 8)
  );
}
console.log(`\nwrote ${outPath}`);

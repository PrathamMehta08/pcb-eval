// site/rag.js: BM25 over documentation somebody attached to a part.
//
// Four things are asserted.
//
// The tokenizer has to survive datasheet notation. A tokenizer that splits on
// every non-letter turns 0.1uF into "0", "1", "uf", and a retrieval built on it
// looks correct right up until it returns the revision history.
//
// The ranking has to be the ranking BM25 describes: the passage about the
// bootstrap capacitor above the table that mentions VBST once, and a long
// section of prose that matches nothing scored out rather than padded in.
//
// It has to be deterministic. Passages go into a prompt and the prompt is a
// cache key, so two chunks that score alike must not swap places between runs.
//
// And the query must be a function of the board alone. Built from the
// deterministic findings instead, retrieval would fetch the passage describing
// the seeded defect and the pack would quote it - the leak the checks block was
// rewritten to close, arriving by a different route.
//
//   node tests/rag.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rag = await import("file://" + join(root, "site", "rag.js"));

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

// A stand-in datasheet. Four pages, each about something different, so a query
// that lands on the wrong one is visible rather than plausible.
const PAGES = [
  "Absolute Maximum Ratings VIN -0.3 to 20 V VBST to SW -0.3 to 6 V " +
    "operating junction temperature -40 to 150 C storage temperature range",
  "Application Information The bootstrap capacitor between VBST and SW supplies " +
    "the high side gate driver. A 0.1 uF ceramic bootstrap capacitor is " +
    "recommended for most applications. Sizing the bootstrap capacitor smaller " +
    "degrades efficiency at high duty cycle.",
  "Revision History Changed layout section. Added note. Updated ordering " +
    "information. Corrected typo. Revised figure numbering throughout the " +
    "document for clarity and consistency across every section of this " +
    "datasheet as published.",
  "Thermal Information RθJA junction to ambient thermal resistance 92.6 °C/W " +
    "RθJC junction to case thermal resistance 32.1 °C/W measured on a JEDEC board",
];

// Notation a naive tokenizer destroys.
const tokens = rag.terms("The 0.1uF VBST cap, RθJA = 92.6 °C/W over 4.5V-17V.");
for (const wanted of ["0.1uf", "vbst", "rthetaja", "92.6", "degc/w", "4.5v-17v"]) {
  check(tokens.includes(wanted), `the tokenizer keeps ${wanted}, got ${JSON.stringify(tokens)}`);
}

const chunks = rag.chunk(PAGES, { part: "U1", source: "tps563208.pdf" });
check(chunks.length === PAGES.length, `one chunk per short page, got ${chunks.length}`);
check(
  chunks.every((c) => c.page >= 1 && c.page <= PAGES.length),
  "every chunk carries the page it came from"
);

// A page longer than the chunk size splits, and never across a page boundary.
const long = rag.chunk([Array.from({ length: 900 }, (_, i) => `w${i}`).join(" "), "short page"]);
check(long.length > 2, `a 900-word page splits into several chunks, got ${long.length}`);
check(
  long.filter((c) => c.page === 2).length === 1,
  "the short second page stays one chunk of its own"
);
check(
  new Set(long.map((c) => c.page)).size === 2,
  "no chunk spans two pages, or a quote could be cited to neither"
);

const idx = rag.index(chunks);

// Ranking. The bootstrap paragraph beats the table that says VBST once.
const boot = rag.search(idx, "bootstrap capacitor VBST", 3);
check(boot[0]?.page === 2, `the bootstrap query lands on page 2, got page ${boot[0]?.page}`);
check(
  boot.length < chunks.length,
  "a passage matching nothing is dropped rather than ranked last"
);
check(
  !boot.some((h) => h.page === 3),
  "the revision history never surfaces: it matches none of the query"
);

// The expansion table has to bridge what the tokenizer cannot: someone asking
// about theta has to reach a page that printed the Greek letter.
const thermal = rag.search(idx, "theta thermal resistance", 2);
check(thermal[0]?.page === 4, `the thermal query lands on page 4, got page ${thermal[0]?.page}`);

// Determinism, run to run and against an identical rebuild of the index.
const a = rag.search(idx, "bootstrap capacitor VBST", 3);
const b = rag.search(rag.index(rag.chunk(PAGES, { part: "U1" })), "bootstrap capacitor VBST", 3);
check(
  JSON.stringify(a.map((h) => [h.page, h.index, h.score])) ===
    JSON.stringify(b.map((h) => [h.page, h.index, h.score])),
  "the same query over the same document ranks identically every time"
);

// The query is a function of the board and nothing else.
const board = JSON.parse(readFileSync(join(root, "boards", "stm32-good.json"), "utf8"));
const pins = board.nets
  .flatMap((n) => (n.nodes || []).map((nd) => ({ ...nd, net: n.name })))
  .filter((p) => p.ref === "U1");
const query = rag.queryFor(board, "U1", pins);
check(query.length > 0, "a researched part produces a query");
check(
  rag.queryFor(board, "U1", pins) === query,
  "the same part produces the same query every time"
);
// Nothing a rule found may reach it. The words a finding is written in - the
// rule names, the verdict vocabulary - must not be in the query at all.
for (const word of ["island", "miswired", "floating", "defect", "wrong", "missing", "violation"]) {
  check(
    !query.toLowerCase().includes(word),
    `the query is built from the board, so it cannot contain "${word}": ${query}`
  );
}

for (const failure of failures) console.error("  x " + failure);
console.log(
  failures.length
    ? `${failures.length} retrieval checks failed`
    : "BM25 ranks the right passage, drops the rest, and the query never sees a finding"
);
process.exit(failures.length ? 1 : 0);

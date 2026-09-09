/**
 * Retrieval over documentation somebody attached to a part.
 *
 * A datasheet is 30 to 100 pages. Six researched parts on one board is a few
 * hundred thousand tokens, and the reviewer needs about two thousand of it. The
 * job of this module is to pick which two thousand.
 *
 * WHY BM25 AND NOT EMBEDDINGS
 *
 * The obvious move is to embed every passage and rank by cosine distance. It is
 * the wrong tool here, for four reasons that are all about this project rather
 * than about retrieval in general.
 *
 * The queries are rare exact tokens. VBST, RthetaJA, UVLO, 0.1uF. Lexical
 * scoring is at its strongest on exactly those, because a term in one chunk of
 * four hundred outweighs a term in three hundred and eighty of them. Embeddings
 * smooth rare tokens toward their neighbours, which is the opposite of what you
 * want when VBST and VBAT must not be confused.
 *
 * A scored sweep may not touch the network, and it is stamped with hashes so it
 * can be reproduced. An embedding call in the retrieval path breaks both.
 *
 * It has to run in the browser, on a board someone just dropped on the page,
 * with no server. A local embedding model does not.
 *
 * And when retrieval returns the wrong passage you can read the reason. A
 * vector store gives you a number.
 *
 * WHAT BM25 IS
 *
 * Three ideas. Rare terms count more, which is the idf term. A term repeated
 * ten times is not ten times the evidence, so term frequency saturates, which
 * is k1. A long passage should not win by being long, so length is normalised
 * against the collection average, which is b. That is the whole algorithm.
 *
 * DETERMINISM
 *
 * Scores are rounded before sorting and ties break on page then index. Two
 * chunks that score alike must not swap places between one run and the next, or
 * between this file and the Python beside it - the passages go into a prompt,
 * and the prompt is a cache key.
 */

/** BM25's two knobs, at the values the literature settled on. */
const K1 = 1.2;
const B = 0.75;

/** Chunk size in words, and how much neighbouring chunks share. */
const CHUNK_WORDS = 350;
const OVERLAP_WORDS = 50;

/** Scores are compared at this precision, so float noise cannot reorder them. */
const PRECISION = 6;

/**
 * Symbols a datasheet uses that a keyboard does not. Indexed both ways, so
 * someone who typed "theta" finds a page that printed the Greek letter.
 */
const TRANSLITERATE = [
  [/θ/g, "theta"],
  [/µ|μ/g, "u"],
  [/Ω/g, "ohm"],
  [/°/g, "deg"],
];

/**
 * Words that mean the same thing to a datasheet and different things to a
 * tokenizer. Hand-written and inspectable on purpose: a model could generate a
 * longer table, and then nobody could say why a retrieval missed.
 */
export const EXPANSIONS = {
  theta: ["thermal", "resistance", "junction", "ambient", "rthetaja"],
  thermal: ["theta", "rthetaja", "junction", "dissipation"],
  bootstrap: ["vbst", "boot", "capacitor"],
  enable: ["en", "uvlo", "threshold", "shutdown"],
  input: ["vin", "supply", "operating", "range"],
  output: ["vout", "regulation"],
  maximum: ["absolute", "ratings", "max"],
  decoupling: ["bypass", "capacitor", "placement"],
};

/**
 * Split text into terms without destroying the ones that matter.
 *
 * A tokenizer that splits on every non-letter turns 0.1uF into "0", "1", "uf"
 * and 4.5V into "4", "5v", which is how a retrieval that looks correct returns
 * the revision history. Dots, signs and slashes are kept inside a token and
 * trimmed only from its ends.
 */
export function terms(text) {
  let source = String(text || "").toLowerCase();
  for (const [pattern, plain] of TRANSLITERATE) source = source.replace(pattern, plain);
  const out = [];
  for (const raw of source.split(/[^a-z0-9.\-+_/]+/)) {
    const token = raw.replace(/^[.\-+_/]+/, "").replace(/[.\-+_/]+$/, "");
    if (token.length > 1) out.push(token);
  }
  return out;
}

/**
 * A best guess at which section a passage came from.
 *
 * Datasheet headings are short and title-case, and sit at the start of what
 * follows them. This is a label for whoever reads the citation, not something a
 * check depends on, so a wrong guess costs nothing.
 */
function heading(words) {
  const head = words.slice(0, 8).join(" ");
  const match = /^([A-Z][A-Za-z ]{3,40}?)(?=\s+[A-Z]?[a-z]|\s*$)/.exec(head);
  return match ? match[1].trim() : "";
}

/**
 * Cut a document into passages, never across a page boundary.
 *
 * Page boundaries are hard limits because the page number is the provenance: a
 * quote spanning two pages cannot be cited to either. Inside a page the split is
 * by word count with an overlap, so a parameter table straddling a boundary
 * survives whole in one of the two chunks.
 *
 * `pages` is one string per page, which is what a PDF extractor gives and what
 * pasted text degenerates to - a single page.
 */
/**
 * Pages that match every query and answer none of them.
 *
 * A table of contents names every section in the document, so it scores against
 * any query built out of section names - which is what a standing question like
 * "absolute maximum ratings" is. One came back as the third best passage about
 * an MCU: a row of dot leaders and page numbers. No amount of term weighting
 * fixes it, because the terms really are in there.
 *
 * The test is the dot leader and nothing else. The obvious alternative - that a
 * contents page is short on letters and long on punctuation - also describes a
 * parameter table, and a parameter table is the single most valuable page in a
 * datasheet. Better to keep a contents page nobody formatted with dots than to
 * silently drop the absolute maximum ratings.
 *
 * The dots may be spaced. A PDF extractor pulls a leader out as ". . . . . ."
 * as often as "......", depending on how the run was laid out, and the first
 * version of this only matched the second - which is not the one that was in
 * the document that prompted it.
 */
function isNavigation(text) {
  return /(\.\s*){4,}/.test(text);
}

export function chunk(pages, { part = "", source = "" } = {}) {
  const out = [];
  const step = Math.max(1, CHUNK_WORDS - OVERLAP_WORDS);
  pages.forEach((text, i) => {
    if (isNavigation(text)) return;
    const words = String(text || "").split(/\s+/).filter(Boolean);
    if (!words.length) return;
    for (let at = 0; at < words.length; at += step) {
      const slice = words.slice(at, at + CHUNK_WORDS);
      if (!slice.length) break;
      out.push({
        part,
        source,
        page: i + 1,
        index: out.length,
        text: slice.join(" "),
        section: heading(slice),
      });
      if (at + CHUNK_WORDS >= words.length) break;
    }
  });
  return out;
}

/**
 * A BM25 index over one part's documentation.
 *
 * The collection is that part's own chunks rather than every part's, because
 * idf should mean "rare in this document". A term common in a regulator
 * datasheet is not thereby common in an MCU's.
 */
export function index(chunks) {
  const docs = chunks.map((c) => {
    const words = terms(c.text);
    const freq = new Map();
    for (const t of words) freq.set(t, (freq.get(t) || 0) + 1);
    return { chunk: c, freq, length: words.length };
  });
  const seen = new Map();
  for (const doc of docs) {
    for (const term of doc.freq.keys()) seen.set(term, (seen.get(term) || 0) + 1);
  }
  const total = docs.length || 1;
  const avg = docs.reduce((sum, d) => sum + d.length, 0) / total;
  const idf = new Map();
  for (const [term, n] of seen) {
    // The 1 inside the log keeps idf positive for a term that appears in every
    // chunk, so a ubiquitous term contributes nothing rather than contributing
    // backwards and pushing the passages that contain it below the ones that
    // do not.
    idf.set(term, Math.log(1 + (total - n + 0.5) / (n + 0.5)));
  }
  return { docs, idf, avg: avg || 1, size: docs.length };
}

/** Expand a query with the hand-written synonyms, originals first. */
export function expand(wanted) {
  const out = [...wanted];
  for (const term of wanted) {
    for (const extra of EXPANSIONS[term] || []) {
      if (!out.includes(extra)) out.push(extra);
    }
  }
  return out;
}

/**
 * The top `k` passages for a query, best first.
 *
 * A chunk matching nothing scores zero and is dropped rather than ranked last.
 * Padding a pack with irrelevant text is worse than a shorter pack: every line
 * of it is a line the reviewer might reason from.
 */
export function search(idx, query, k = 3) {
  const wanted = expand(terms(query));
  const scored = [];
  for (const doc of idx.docs) {
    let score = 0;
    for (const term of wanted) {
      const f = doc.freq.get(term);
      if (!f) continue;
      const norm = f + K1 * (1 - B + (B * doc.length) / idx.avg);
      score += (idx.idf.get(term) || 0) * ((f * (K1 + 1)) / norm);
    }
    if (score <= 0) continue;
    scored.push({ ...doc.chunk, score: Number(score.toFixed(PRECISION)) });
  }
  scored.sort((a, b) => b.score - a.score || a.page - b.page || a.index - b.index);
  return scored.slice(0, k);
}

/**
 * The query for one part, built from the board and nothing else.
 *
 * This is a boundary, not a convenience. Built from the deterministic findings
 * instead, retrieval would fetch the passage describing the seeded defect and
 * the pack would quote it - the same leak the checks block was rewritten to
 * close, arriving by a different route. It reads the part, its value, its
 * package and the nets its pins sit on: all things true of the board whether or
 * not anything is wrong with it.
 */
export function queryFor(board, ref, pins = []) {
  const comp = board.components.find((c) => c.ref === ref);
  if (!comp) return "";
  const nets = [...new Set(pins.map((p) => p.net).filter(Boolean))];
  const functions = [...new Set(pins.map((p) => p.name || p.function).filter(Boolean))];
  return [
    comp.value || "",
    comp.description || "",
    (comp.footprint || "").split(":").pop() || "",
    ...functions,
    ...nets.map((n) => n.replace(/^\//, "")),
    // Standing questions, identical for every part on every board.
    "absolute maximum ratings input voltage range thermal resistance",
    "required external components enable threshold",
  ]
    .filter(Boolean)
    .join(" ");
}

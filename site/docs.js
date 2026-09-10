/**
 * The documentation somebody attached to a part, and where it is kept.
 *
 * The harness fetches a datasheet, caches the PDF and reads it. The page cannot:
 * no server, and a board someone just dropped on it must not need a vendor CDN
 * to be reviewed. So the page accepts the document instead - dropped in, or
 * pasted as text - extracts what it can, and keeps it in the browser.
 *
 * WHERE IT LIVES
 *
 * IndexedDB, not localStorage. The extracted text of a sixty-page datasheet is
 * a couple of hundred kilobytes and localStorage is a five-megabyte budget
 * shared with everything else the page stores; four datasheets would fill it and
 * the failure mode is a thrown quota error in the middle of an attach.
 *
 * Only the extracted text is stored, never the PDF. Text is what retrieval
 * reads, it is a tenth of the size, and a document nobody can re-download from
 * here is not worth the space.
 *
 * WHY THERE IS A SYNCHRONOUS CACHE IN FRONT OF IT
 *
 * IndexedDB is asynchronous and pack building is not. Rather than colour every
 * caller async for a store that holds a handful of small records, the documents
 * for the open board are read into memory once when the board loads and after
 * every attach. Everything downstream reads the cache.
 */

import { pinsByRef } from "./checks.js";
import { chunk, index, queryFor, search } from "./rag.js";

const DB = "pcb-eval";
const STORE = "docs";
const VERSION = 1;

/** board name -> ref -> {name, pages, addedAt}. Filled by `loadDocs`. */
const attached = new Map();

/** ref -> built BM25 index. Dropped whenever that part's document changes. */
const indexes = new Map();

function open() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("no indexedDB"));
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function transact(mode, run) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const out = run(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
        tx.onerror = () => reject(tx.error);
      })
  );
}

const keyOf = (boardName, ref) => `${boardName}::${ref}`;

/**
 * Read this board's documents into memory. Called when a board loads.
 *
 * A browser with IndexedDB blocked - a private window, or site data turned off -
 * resolves to an empty board rather than failing. Nothing here is load-bearing:
 * no attached document is the ordinary state, and the review runs without one.
 */
export async function loadDocs(boardName) {
  const board = new Map();
  attached.set(boardName, board);
  indexes.clear();
  try {
    const rows = await transact("readonly", (store) => store.getAll());
    for (const row of rows || []) {
      if (row.board === boardName) board.set(row.ref, row);
    }
  } catch {
    /* storage unavailable. The page works without it. */
  }
  return board;
}

/** Every document attached to this board, keyed by ref. */
export function docsFor(boardName) {
  return attached.get(boardName) || new Map();
}

/** The document attached to one part, or null. */
export function docFor(boardName, ref) {
  return docsFor(boardName).get(ref) || null;
}

/** Store a document against a part, replacing whatever was there. */
export async function attach(boardName, ref, { name, pages }) {
  const record = {
    key: keyOf(boardName, ref),
    board: boardName,
    ref,
    name: String(name || "document"),
    pages: (pages || []).map((p) => String(p || "")),
    // Filled in by the datasheet agent, which runs after the file is stored
    // rather than before: reading is a model call over a network, and a drop
    // that waits on one feels broken even when it is working.
    facts: {},
    dropped: [],
    read: "pending",
    addedAt: Date.now(),
  };
  docsFor(boardName).set(ref, record);
  indexes.delete(record.key);
  try {
    await transact("readwrite", (store) => store.put(record));
  } catch {
    /* it stays in memory for this session, which is better than refusing. */
  }
  return record;
}

/** Record what the agent read out of a document, against that document. */
export async function setFacts(boardName, ref, { facts, dropped, failed }) {
  const record = docFor(boardName, ref);
  if (!record) return null;
  Object.assign(record, {
    facts: facts || {},
    dropped: dropped || [],
    read: failed ? "failed" : "read",
  });
  try {
    await transact("readwrite", (store) => store.put(record));
  } catch {
    /* it stays in memory for this session, which is better than losing it. */
  }
  return record;
}

/** Forget the document attached to a part. */
export async function detach(boardName, ref) {
  docsFor(boardName).delete(ref);
  indexes.delete(keyOf(boardName, ref));
  try {
    await transact("readwrite", (store) => store.delete(keyOf(boardName, ref)));
  } catch {
    /* nothing to do: it is already gone from memory. */
  }
}

/** The BM25 index over one part's document, built once and kept. */
function indexFor(boardName, ref) {
  const key = keyOf(boardName, ref);
  if (indexes.has(key)) return indexes.get(key);
  const doc = docFor(boardName, ref);
  if (!doc) return null;
  const built = index(chunk(doc.pages, { part: ref, source: doc.name }));
  indexes.set(key, built);
  return built;
}

/** How many passages a part's document was cut into. */
export function chunkCount(boardName, ref) {
  return indexFor(boardName, ref)?.size || 0;
}

/**
 * The passages worth showing a reviewer about one part.
 *
 * The query comes from `queryFor`, which reads the board and never the
 * findings. That is the whole reason retrieval is safe to put in a pack.
 */
export function passagesFor(board, ref, pins, k = 3, words = 0) {
  const idx = indexFor(board.meta.name, ref);
  if (!idx) return [];
  return search(idx, queryFor(board, ref, pins), k, { words });
}

/**
 * Extract one string per page from a PDF.
 *
 * pdf.js is fetched from the CDN the moment a PDF is actually dropped, never on
 * page load: a visitor who only wants to look at a board should not pay for a
 * parser they will not use, and the page has to keep working when the CDN is
 * unreachable. If it cannot load, the caller is told to paste text instead,
 * which is a real answer rather than a broken button.
 */
export async function pagesOfPdf(file) {
  const pdfjs = await loadPdfJs();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const content = await (await doc.getPage(n)).getTextContent();
    pages.push(content.items.map((i) => i.str).join(" ").replace(/\s+/g, " ").trim());
  }
  return pages;
}

const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174";

let pending = null;
function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (pending) return pending;
  pending = new Promise((resolve, reject) => {
    const tag = document.createElement("script");
    tag.src = `${PDFJS}/pdf.min.js`;
    tag.onload = () => {
      if (!window.pdfjsLib) return reject(new Error("pdf.js loaded but defined nothing"));
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS}/pdf.worker.min.js`;
      resolve(window.pdfjsLib);
    };
    tag.onerror = () => reject(new Error("could not reach the PDF reader"));
    document.head.appendChild(tag);
  });
  return pending;
}

/**
 * The retrieved passages, as a pack section.
 *
 * Verbatim, with the page they came from, because a reviewer that paraphrases a
 * datasheet cannot be checked and one that quotes it can. Three passages per
 * part is the budget: a pack is a prompt, and a prompt that recites a datasheet
 * has spent its room on text the reviewer was going to skim.
 *
 * Absent for a board nobody has attached anything to, which is the ordinary
 * state and not a defect.
 */
/**
 * The parameters a reviewer is given, and where each was read.
 *
 * Only facts the document was checked against reach this: the agent's answer is
 * matched back to the pages it was shown, and anything whose quote is not there
 * never becomes a fact at all. So the quote beside each value is not a claim
 * about the datasheet, it is a substring of it.
 */
export function factsBlock(board) {
  const docs = docsFor(board.meta.name);
  const lines = ["DATASHEET PARAMETERS  read from the attached documents, quoted"];
  for (const ref of [...docs.keys()].sort()) {
    for (const [key, value] of Object.entries(docs.get(ref).facts || {})) {
      for (const fact of Array.isArray(value) ? value : [value]) {
        const where = fact.applies_to ? `, ${fact.applies_to}` : "";
        lines.push(`${ref} ${key}: ${fact.shown} (p${fact.page}${where}) "${fact.quote}"`);
      }
    }
  }
  return lines.length > 1 ? lines : [];
}

/**
 * Parameters read out of one part's document, for the reader rather than the
 * reviewer. Low-confidence readings are kept here and marked, because someone
 * checking the extraction needs to see the ones it is unsure about most of all.
 */
export function factsOf(boardName, ref) {
  return docFor(boardName, ref)?.facts || {};
}

/**
 * Every fact as one flat list, because some parameters have several answers.
 *
 * A regulator needs an input capacitor and an output capacitor and a catch
 * diode, so `required_external_part` holds a list where the others hold a
 * value. Everything that displays them wants the same shape, and building that
 * shape in each of them is how one of them ends up showing "[object Object]".
 */
export function factsList(boardName, ref) {
  return Object.entries(factsOf(boardName, ref)).flatMap(([name, value]) =>
    (Array.isArray(value) ? value : [value]).map((fact) => ({ name, ...fact }))
  );
}

/**
 * How wide a retrieved passage is, and how many any one part may contribute.
 *
 * A chunk is 350 words because that is the unit BM25 ranks well. `focus` cuts
 * what is sent down to the span that earned the score, and 80 words is a
 * parameter row with its heading and its units still attached - enough to read,
 * short enough that five of them cost less than one whole chunk did.
 *
 * The per-part ceiling exists so a board with one documented part cannot spend
 * the whole budget on it. Six passages from one datasheet is the same mistake as
 * three from each of six, arriving from the other direction.
 */
const PASSAGE_WORDS = 80;
const MOST_PER_PART = 4;

/**
 * The retrieved passages, as a pack section, inside a word budget.
 *
 * WHAT WENT WRONG WITHOUT ONE
 *
 * This used to take three whole chunks per documented part with no ceiling at
 * all, and the arithmetic is unkind: the distilled board is 810 words and three
 * chunks are about 970, so **one** documented part made the pack 56% datasheet,
 * and three made it 79%. Six would have reached 89%.
 *
 * That is not a tuning problem, it is the architecture inverted. Every
 * measurement this project has taken says the reviewer wants the whole board -
 * splitting the board between specialists is what V2 through V6 lost recall
 * doing, and "a reviewer holding half a board speculates about the other half"
 * is the sentence the single-reviewer design is built on. Attaching datasheets
 * was quietly doing the same thing by dilution: the board did not shrink, but
 * its share of the reviewer's attention did, and it got worse with every
 * document somebody helpfully added.
 *
 * So the budget is a share of the board rather than a count per part, and it is
 * spent round-robin - every documented part gets its best passage before any
 * part gets its second. Sorted by ref first, so the order is the board's and not
 * the order somebody happened to attach documents in.
 *
 * Verbatim still, with the page it came from, because a reviewer that
 * paraphrases a datasheet cannot be checked and one that quotes it can.
 */
export function passagesBlock(board, budget = Infinity) {
  const docs = docsFor(board.meta.name);
  if (!docs.size || budget <= 0) return [];
  const pins = pinsByRef(board);

  const queues = [...docs.keys()]
    .sort()
    .map((ref) => passagesFor(board, ref, pins.get(ref) || [], MOST_PER_PART, PASSAGE_WORDS));

  const lines = ["RETRIEVED DOCUMENTATION  verbatim, from documents attached to this board"];
  let spent = 0;
  for (let round = 0; round < MOST_PER_PART; round += 1) {
    for (const queue of queues) {
      const hit = queue[round];
      if (!hit) continue;
      const cost = hit.text.split(/\s+/).filter(Boolean).length;
      // The best passage always goes in, whatever the budget says. A share of a
      // small board can be narrower than a single passage, and dropping the
      // section entirely is the wrong answer to that: somebody attached a
      // document and got nothing back, silently. One passage against a 200-word
      // board is still a board that is mostly itself; the failure this budget
      // exists to stop is six parts contributing four passages each.
      //
      // After the first, stop rather than skip. Skipping a long passage to fit
      // a short one after it silently reorders the section by length instead of
      // by relevance, which is the one thing the ranking exists to decide.
      if (lines.length > 1 && spent + cost > budget) return lines;
      spent += cost;
      const where = [`${hit.source} p${hit.page}`, hit.section].filter(Boolean).join(", ");
      lines.push(`${hit.part} (${where}): ${hit.text}`);
    }
  }
  return lines.length > 1 ? lines : [];
}

/**
 * Rated output current per part, for the ampacity check.
 *
 * Only what a document actually stated and the verifier kept - a value whose
 * quote was found in the pages it came from. No document, no entry, and the
 * check that needs it reports as unassessed rather than guessing a current.
 */
export function ratedCurrents(board) {
  const out = {};
  for (const [ref, doc] of docsFor(board.meta.name)) {
    const fact = (doc.facts || {}).output_current_a;
    if (fact && typeof fact.value === "number") out[ref] = fact.value;
  }
  return out;
}

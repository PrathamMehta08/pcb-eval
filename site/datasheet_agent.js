/**
 * The datasheet agent: a model reads the document, and the document checks it.
 *
 * This replaces a table of regular expressions, and it replaces it because the
 * regexes were quietly wrong. Asked about a ULN2003A they reported an output
 * current of 2002 A - the "2002" of a neighbouring part number with the "A" of
 * "ULN2002A" - and the failure is not a missing word boundary but the approach.
 * A pattern matches shapes. "A number, then an A" is the shape of an ampere
 * rating and also the shape of half a part number, half a table index and half
 * a revision code, and every one of those will appear within forty characters
 * of the words "output current" in some datasheet somewhere.
 *
 * A model reading the sentence knows which is which. What it does not do
 * reliably is stay inside the document, so the document is what checks it.
 *
 * HOW A FACT IS ADMITTED
 *
 * The agent must return a verbatim quote for every value. That quote is then
 * looked for in the pages it was supposedly read from, whitespace-normalised,
 * and a fact whose quote is not there is dropped - not flagged, dropped. The
 * value has to appear inside its own quote too, so "45 C/W" cannot be supported
 * by a sentence with no 45 in it. Neither check asks a model anything: they are
 * string comparisons against the source, which is the only part of this that
 * cannot be talked into agreeing.
 *
 * That is the whole design. The model is allowed to be the thing that
 * understands the sentence, and is not allowed to be the thing that decides
 * whether the sentence exists.
 *
 * WHAT IT IS SHOWN
 *
 * Not the document. Sixty pages is more than the context is worth spending and
 * most of it is packaging drawings, so BM25 picks the passages for each
 * parameter and the agent sees those. Retrieval choosing badly costs a missing
 * fact, which is the safe direction: a fact that was never extracted leaves its
 * check gated, and a gated check reports as unassessed rather than as passing.
 */

import { index, chunk, search } from "./rag.js";

export const AGENT_VERSION = "1";

/**
 * What to ask about, and what a plausible answer looks like.
 *
 * The bounds are not a second opinion on the datasheet - they are a bound on
 * the extraction. A junction temperature of 2002 degrees is not a reading a
 * document supports, it is a misread, and the cheapest place to catch a misread
 * is against the order of magnitude every part of this kind shares.
 */
export const WANTED = [
  {
    name: "vin_range_v",
    label: "Input voltage range",
    ask: "the supply or input voltage range the part operates over",
    query: "input supply voltage range operating conditions minimum maximum V",
    unit: "V",
    range: [0.5, 1000],
    enables: "rail_within_input_range",
  },
  {
    name: "max_junction_c",
    label: "Maximum junction temperature",
    ask: "the maximum junction temperature",
    query: "maximum junction temperature TJ absolute ratings degrees C",
    unit: "°C",
    range: [50, 250],
    enables: "junction_temp",
  },
  {
    name: "theta_ja",
    label: "Junction-to-ambient",
    ask: "the junction-to-ambient thermal resistance for this package",
    query: "thermal resistance junction to ambient RthJA theta JA C/W package",
    unit: "°C/W",
    range: [0.5, 1000],
    enables: "junction_temp",
  },
  {
    name: "output_current_a",
    label: "Output current",
    ask: "the rated or maximum output current per channel",
    query: "output current rating per channel maximum continuous A mA",
    unit: "A",
    range: [0.0001, 500],
    enables: null,
  },
  {
    name: "required_external_part",
    label: "Required external part",
    ask:
      "any external component the datasheet says must be fitted - a bootstrap " +
      "capacitor, a pull-up on an enable pin, a compensation network",
    query: "connect capacitor between pin required external components bootstrap enable pull-up",
    unit: "",
    range: null,
    enables: "required_external_part",
  },
];

/**
 * The passages the agent is shown, one set per parameter.
 *
 * Each parameter gets its own query, because a single query for everything
 * returns the passage that is vaguely about all of them - which is usually the
 * contents page, and contents pages are already dropped for that reason.
 */
export function evidenceFor(pages, source = "document") {
  const idx = index(chunk(pages, { source }));
  const seen = new Map();
  for (const want of WANTED) {
    for (const hit of search(idx, want.query, 2)) {
      const key = `${hit.page}:${hit.index}`;
      if (!seen.has(key)) seen.set(key, hit);
    }
  }
  return [...seen.values()].sort((a, b) => a.page - b.page || a.index - b.index);
}

const PROMPT_HEAD = [
  "You are reading one component datasheet and reporting what it states.",
  "",
  "You are given passages from the document, each with the page it came from.",
  "Report only what these passages actually say. You are not being asked what",
  "is typical for this kind of part, and a value you supply from experience is",
  "worse than no value: every fact you return is checked against the passages",
  "and dropped if its quote is not found in them, so an invented fact costs the",
  "reader a parameter and buys nothing.",
  "",
  "Report nothing for a parameter the passages do not state. That is the",
  "expected answer for most parameters in most documents.",
  "",
  "WHAT TO LOOK FOR",
];

const PROMPT_TAIL = [
  "",
  "ANSWER",
  "",
  "JSON only, no prose:",
  "",
  '{"facts": [{"name": "<one of the names above>", "value": <number or string>,',
  '  "unit": "<the unit as printed>", "page": <page number>,',
  '  "quote": "<the words from the passage that state it, copied exactly>"}]}',
  "",
  "The quote must be copied character for character from a passage above. Do",
  "not tidy it, join it to another line, or write out what it means. A table",
  "row is a quote. If you cannot copy a quote that states the value, leave the",
  "parameter out.",
];

/** The prompt for one part's document. */
export function agentPrompt(part, value, evidence) {
  const lines = [
    ...PROMPT_HEAD,
    ...WANTED.map((w) => `- ${w.name}: ${w.ask}`),
    "",
    `THE PART  ${part}${value ? ` (${value})` : ""}`,
    "",
    "PASSAGES",
    "",
  ];
  for (const hit of evidence) {
    lines.push(`[page ${hit.page}] ${hit.text}`);
    lines.push("");
  }
  lines.push(...PROMPT_TAIL);
  return lines.join("\n");
}

/** Whitespace and case are not evidence, so neither decides a comparison. */
const flatten = (text) =>
  String(text || "")
    .toLowerCase()
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

/** The numbers in a string, so a value can be checked against its own quote. */
const numbersIn = (text) =>
  (String(text).match(/-?\d+(?:\.\d+)?/g) || []).map(Number);

/**
 * Keep the facts the document supports, and say why each of the rest went.
 *
 * Four gates, none of which asks a model anything. The quote has to be in the
 * document. The value has to be in the quote. The parameter has to be one that
 * was asked for. And a number has to be the right order of magnitude for the
 * quantity it claims to be, which is what catches a part number read as an
 * ampere rating.
 */
export function verifyFacts(answer, pages) {
  const haystack = flatten(pages.join(" "));
  const wanted = new Map(WANTED.map((w) => [w.name, w]));
  const kept = {};
  const dropped = [];

  for (const raw of (answer && answer.facts) || []) {
    if (!raw || typeof raw !== "object") continue;
    const spec = wanted.get(String(raw.name));
    const quote = String(raw.quote || "").trim();
    const why = (reason) => dropped.push({ name: raw.name, quote, reason });

    if (!spec) {
      why("not a parameter that was asked for");
      continue;
    }
    if (quote.length < 8) {
      why("no quote");
      continue;
    }
    if (!haystack.includes(flatten(quote))) {
      why("the quote is not in the document");
      continue;
    }
    const numeric = typeof raw.value === "number" || /^-?[\d.]+$/.test(String(raw.value));
    if (numeric) {
      const value = Number(raw.value);
      if (!numbersIn(quote).includes(value)) {
        why("the value does not appear in its own quote");
        continue;
      }
      if (spec.range && (value < spec.range[0] || value > spec.range[1])) {
        why(`${value} is outside the range a ${spec.label.toLowerCase()} takes`);
        continue;
      }
    }
    if (kept[spec.name]) continue;
    kept[spec.name] = {
      label: spec.label,
      value: numeric ? Number(raw.value) : String(raw.value),
      unit: String(raw.unit || spec.unit || ""),
      shown: numeric
        ? `${Number(raw.value)}${spec.unit ? ` ${spec.unit}` : ""}`
        : String(raw.value),
      page: Number(raw.page) || null,
      quote: quote.slice(0, 240),
      enables: spec.enables,
    };
  }
  return { facts: kept, dropped };
}

/**
 * Read one part's document. Runs before any review, once per document.
 *
 * `ask(prompt)` is the only thing this needs from outside - the same call the
 * review makes. A failure returns no facts rather than throwing: a document
 * that could not be read leaves its checks gated, which is the state the board
 * was already in, and is a much better outcome than refusing the attachment.
 */
export async function readDatasheet(ask, { part, value, pages }) {
  const evidence = evidenceFor(pages, part);
  if (!evidence.length) return { facts: {}, dropped: [], evidence: 0 };
  let answer = null;
  try {
    answer = await ask(agentPrompt(part, value, evidence));
  } catch {
    return { facts: {}, dropped: [], evidence: evidence.length, failed: true };
  }
  const { facts, dropped } = verifyFacts(answer, pages);
  return { facts, dropped, evidence: evidence.length };
}

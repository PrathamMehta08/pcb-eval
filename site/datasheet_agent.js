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
    // A regulator wants an input capacitor and an output capacitor and a catch
    // diode and an inductor. Keeping the first and discarding the rest reported
    // one of four requirements as though it were the requirement.
    many: true,
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
export function evidenceFor(pages, source = "document", part = "") {
  const idx = index(chunk(pages, { source }));
  const seen = new Map();
  for (const want of WANTED) {
    // The part number goes into every query. One document often covers a whole
    // family - an LM2576 and an LM2576HV differ by twenty volts of input range
    // and share a datasheet - so a passage that names the exact part is the one
    // worth reading, and BM25 ranks a rare exact token like "LM2576HVS" highly
    // when it is in the query at all.
    for (const hit of search(idx, `${part} ${want.query}`.trim(), 2)) {
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
  "ONE DOCUMENT, SEVERAL PARTS",
  "",
  "A datasheet usually covers a family, and the members differ. An LM2576 and",
  "an LM2576HV share a document and not an input voltage range. Report the row",
  "for the exact part named below, and put what that row applies to in",
  "`applies_to` - the part number, the package, the temperature range, whatever",
  "the table says it is conditioned on. If the passages state a value only for",
  "a different member of the family, report nothing for that parameter: a",
  "neighbour's number is worse than no number, because it looks like an answer.",
  "",
  "Some parameters have more than one answer - a regulator needs an input",
  "capacitor and an output capacitor and a catch diode. Report each as its own",
  "entry rather than choosing between them.",
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
  '  "applies_to": "<the part number or condition this row is for, if the passage says>",',
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
    ...WANTED.map((w) => `- ${w.name}: ${w.ask}${w.many ? " (may have several)" : ""}`),
    "",
    `THE PART  ${value || part} — the board calls it ${part}`,
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
    // A parameter that declares a range is a number, and it has to arrive as
    // one. "42.6 32.4" is two columns of a table read as a single answer, and
    // it used to survive: it is not a clean number, so it fell through to the
    // string branch and skipped both the value-in-quote check and the range
    // check on its way to being displayed as a thermal resistance.
    const wantsNumber = Boolean(spec.range);
    const single = /^-?\d+(?:\.\d+)?$/.test(String(raw.value).trim());
    if (wantsNumber) {
      if (!single) {
        why(`${JSON.stringify(raw.value)} is not a single number`);
        continue;
      }
      const value = Number(raw.value);
      if (!numbersIn(quote).includes(value)) {
        why("the value does not appear in its own quote");
        continue;
      }
      if (value < spec.range[0] || value > spec.range[1]) {
        why(`${value} is outside the range a ${spec.label.toLowerCase()} takes`);
        continue;
      }
    }
    if (kept[spec.name] && !spec.many) continue;
    const fact = {
      label: spec.label,
      value: wantsNumber ? Number(raw.value) : String(raw.value),
      unit: String(raw.unit || spec.unit || ""),
      shown: wantsNumber
        ? `${Number(raw.value)}${spec.unit ? ` ${spec.unit}` : ""}`
        : String(raw.value),
      page: Number(raw.page) || null,
      quote: quote.slice(0, 240),
      // Which member of the family, or which operating condition, this row is
      // for. A datasheet that covers an LM2576 and an LM2576HV states an input
      // range twice, and a value with no condition beside it is a value nobody
      // can tell was the right one.
      applies_to: String(raw.applies_to || "").slice(0, 80),
      enables: spec.enables,
    };
    if (spec.many) {
      kept[spec.name] = [...(kept[spec.name] || []), fact];
      if (kept[spec.name].length > 4) kept[spec.name].length = 4;
    } else {
      kept[spec.name] = fact;
    }
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
const readings = new Map();

/** A cheap stable key for a document's text, so the same file is read once. */
function fingerprint(pages) {
  const text = pages.join("\n");
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return `${text.length}:${h.toString(36)}`;
}

export async function readDatasheet(ask, { part, value, pages }) {
  // The same PDF attached to three parts gave three different answers - 60 V,
  // 40 V and 63 V for one input range - because the agent was asked three
  // times and a model asked twice does not answer twice the same way. It is a
  // property of the document, so it is read once per document and the answer is
  // shared. That is also two calls cheaper.
  const seen = fingerprint(pages);
  if (readings.has(seen)) return readings.get(seen);

  const evidence = evidenceFor(pages, part, value);
  if (!evidence.length) return { facts: {}, dropped: [], evidence: 0 };
  let answer = null;
  try {
    answer = await ask(agentPrompt(part, value, evidence));
  } catch {
    // Not remembered: a document that could not be read this time is worth
    // trying again, and caching the failure would make one dropped connection
    // permanent for as long as the page is open.
    return { facts: {}, dropped: [], evidence: evidence.length, failed: true };
  }
  const { facts, dropped } = verifyFacts(answer, pages);
  const result = { facts, dropped, evidence: evidence.length };
  readings.set(seen, result);
  return result;
}

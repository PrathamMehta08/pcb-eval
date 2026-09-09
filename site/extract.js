/**
 * Reading parameters out of an attached document.
 *
 * The mirror of the EXTRACTORS table in harness/research.py. The harness pulls
 * these out of a datasheet it fetched; the page pulls them out of a PDF
 * somebody dropped on a part. Same patterns, same names, same `enables`, so a
 * fact found here means to an evaluator what the same fact means there.
 *
 * WHAT A FACT CARRIES
 *
 * A value is not enough. Every fact records the page it was found on, the
 * section heading above it, and the line it came out of, because a number
 * without a quote is a number nobody can check - and this project throws out
 * findings for exactly that. If the quote does not support the value, the fact
 * is wrong in a way somebody can see.
 *
 * WHY THE MATCH HAPPENS INSIDE ONE LINE
 *
 * The first version of the harness's extractor searched the whole document
 * flattened to a single string, which matched patterns across unrelated
 * paragraphs and produced values whose quotes did not support them. A pattern
 * matches within a line, or within a line joined to the next one when a table
 * row has wrapped - and a wrapped match is marked, because that is where a row
 * can pick up its neighbour's number.
 */

/** Datasheet notation for the same quantity, so one pattern can match either. */
const NORMALISE = (text) => text.replace(/θ/g, "th").replace(/µ|μ/g, "u");

/**
 * The largest number in a match, which is what a range's upper bound is.
 *
 * Datasheets state limits as table rows - "TJ Junction temperature -40 150 C" -
 * where min and max are two columns with nothing between them but space. A
 * pattern that takes the first number takes the minimum, and reports -40 as the
 * maximum junction temperature. Taking the largest is right for every limit
 * spelled this way, and a row with one number is a range of one.
 */
const largest = (text) => {
  const numbers = (text.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  return numbers.length ? Math.max(...numbers) : null;
};

/** Both ends of a range, smallest and largest, from the same row. */
const span = (text) => {
  const numbers = (text.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  if (numbers.length < 2) return null;
  return { min: Math.min(...numbers), max: Math.max(...numbers) };
};

/**
 * What to look for. Each is a name, a pattern, how to read the match, and the
 * deterministic evaluator the fact turns on - null when nothing consumes it yet
 * and it is shown for the reader alone.
 *
 * The patterns are written for the way a datasheet is actually laid out rather
 * than the way one might describe itself in a sentence. A parameter is a table
 * row: a symbol, a description, a min, a max and a unit, separated by nothing
 * but whitespace once a PDF extractor has flattened the columns. The first
 * version of these wanted prose - "supply input voltage range 4.5 to 17 V" -
 * and found nothing at all in two real documents, because no datasheet writes
 * that sentence. What every one of them does write is the unit, so the unit
 * anchors the match and the numbers are read out of the span before it.
 */
export const EXTRACTORS = [
  {
    name: "vin_range_v",
    label: "Input voltage range",
    // A package name between the description and the numbers - "LQFP48 7x7" -
    // carries digits, so the gap cannot be digit-free the way prose allows.
    pattern: /(?:input|supply|operating)\s+voltage(?:\s+range)?[^\n]{0,60}?((?:-?[\d.]+\s+){1,3}-?[\d.]+)\s*V\b/i,
    read: (m) => span(m[1]),
    show: (v) => `${v.min} to ${v.max} V`,
    enables: "rail_within_input_range",
  },
  {
    name: "bootstrap_cap",
    label: "Bootstrap capacitor",
    // Either order: "0.1 uF capacitor between VBST and SW" and "VBST: connect
    // a 0.1 uF capacitor" are one sentence to a reader.
    pattern:
      /(?:(VBST|BOOT)\b[^.]{0,80}?([\d.]+)\s*uF|([\d.]+)\s*uF[^.]{0,80}?\b(VBST|BOOT)\b)/i,
    read: (m) => ({ value_uf: Number(m[2] ?? m[3]), pin: (m[1] ?? m[4]).toUpperCase() }),
    show: (v) => `${v.value_uf} uF at ${v.pin}`,
    enables: "required_external_part",
  },
  {
    name: "enable_needs_pullup",
    label: "Enable pin",
    pattern: /\bEN\b[^.]{0,60}?(?:must be pulled up|requires a pull-?up)/i,
    read: () => true,
    show: () => "must be pulled up",
    enables: null,
  },
  {
    name: "output_current_a",
    label: "Output current",
    pattern: /\b([\d.]+)\s*A\s+(?:synchronous\s+)?step-?down|output current[^\n]{0,40}?([\d.]+)\s*A\b/i,
    read: (m) => Number(m[1] ?? m[2]),
    show: (v) => `${v} A`,
    enables: null,
  },
  {
    name: "thermal",
    label: "Junction-to-ambient",
    pattern:
      /(?:R\s*th\s*JA|RthJA|Theta\s*JA|junction[- ]to[- ]ambient|junction[- ]ambient)[^\n]{0,60}?(-?[\d.]+)\s*(?:°|deg)?\s*C\s*\/\s*W/i,
    read: (m) => ({ theta_ja_c_per_w: Number(m[1]) }),
    show: (v) => `${v.theta_ja_c_per_w} °C/W`,
    enables: "junction_temp",
  },
  {
    name: "max_junction_c",
    label: "Maximum junction temperature",
    pattern:
      /(?:maximum |max |operating )?(?:chip[- ])?junction temperature[^\n]{0,60}?((?:-?[\d.]+[\s,]+){0,3}-?[\d.]+)\s*(?:°|deg)?\s*C\b/i,
    read: (m) => largest(m[1]),
    show: (v) => `${v} °C`,
    enables: "junction_temp",
  },
];

/** Lines that look like a section heading, so a fact can say where it sat. */
const HEADING = /^[A-Z][A-Za-z ]{3,48}$/;

/**
 * How much the quote actually pins the number down.
 *
 * A thermal table puts one row across several package columns - "RthJA 88.6
 * 66.7 95.2 123.1" - and a pattern that takes a number from such a row has
 * picked a column, not read a value. The quote is real and the reading is a
 * guess, which is the shape of error this project rejects everywhere else, so
 * it is labelled rather than hidden.
 */
function confidence(line, wrapped) {
  const numbers = line.match(/\d+\.\d+|\d{2,}/g) || [];
  if (numbers.length >= 3) return "low";
  return wrapped ? "medium" : "high";
}

/**
 * Every parameter this document gives up, keyed by name.
 *
 * Pages arrive as one string each. A page is split on sentence and newline
 * boundaries so a pattern matches inside a statement rather than across two,
 * and each candidate is tried joined to the next as well, because a table row
 * that wrapped is one row.
 */
export function extractFacts(pages) {
  const facts = {};
  pages.forEach((raw, index) => {
    const text = NORMALISE(String(raw || ""));
    const lines = text.split(/(?<=\.)\s+|\n+/).map((l) => l.trim()).filter(Boolean);
    let section = "";
    lines.forEach((line, i) => {
      if (HEADING.test(line)) section = line;
      for (const rule of EXTRACTORS) {
        if (facts[rule.name]) continue;
        let match = rule.pattern.exec(line);
        let quote = line;
        let wrapped = false;
        if (!match && lines[i + 1]) {
          quote = `${line} ${lines[i + 1]}`;
          match = rule.pattern.exec(quote);
          wrapped = Boolean(match);
        }
        if (!match) continue;
        facts[rule.name] = {
          label: rule.label,
          value: rule.read(match),
          shown: rule.show(rule.read(match)),
          page: index + 1,
          section,
          confidence: confidence(quote, wrapped),
          enables: rule.enables,
          quote: quote.split(/\s+/).join(" ").slice(0, 200),
        };
      }
    });
  });
  return facts;
}

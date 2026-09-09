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
 * What to look for. Each is a name, a pattern, how to read the match, and the
 * deterministic evaluator the fact turns on - null when nothing consumes it yet
 * and it is shown for the reader alone.
 */
export const EXTRACTORS = [
  {
    name: "vin_range_v",
    label: "Input voltage range",
    pattern: /(?:supply )?input voltage range\D{0,20}?([\d.]+)\s*(?:to|-|–)?\s*([\d.]+)\s*V/i,
    read: (m) => ({ min: Number(m[1]), max: Number(m[2]) }),
    show: (v) => `${v.min} to ${v.max} V`,
    enables: "rail_within_input_range",
  },
  {
    name: "bootstrap_cap",
    label: "Bootstrap capacitor",
    // Either order. "Connect a 0.1 uF capacitor between VBST and SW" and
    // "VBST: connect a 0.1 uF capacitor" are one sentence to a reader and
    // were not to the first version of this, which wanted the pin name first
    // and so missed the phrasing the datasheet actually uses.
    pattern:
      /(?:(VBST|BOOT)\b[^.]{0,80}?([\d.]+)\s*uF|([\d.]+)\s*uF[^.]{0,80}?\b(VBST|BOOT)\b)/i,
    read: (m) => ({
      value_uf: Number(m[2] ?? m[3]),
      pin: (m[1] ?? m[4]).toUpperCase(),
    }),
    show: (v) => `${v.value_uf} uF at ${v.pin}`,
    enables: "required_external_part",
  },
  {
    name: "enable_needs_pullup",
    label: "Enable pin",
    pattern: /\bEN\b[^.]{0,60}?must be pulled up/i,
    read: () => true,
    show: () => "must be pulled up",
    enables: null,
  },
  {
    name: "output_current_a",
    label: "Output current",
    pattern: /\b([\d.]+)\s*A\s+(?:synchronous )?step-down/i,
    read: (m) => Number(m[1]),
    show: (v) => `${v} A`,
    enables: null,
  },
  {
    name: "thermal",
    label: "Junction-to-ambient",
    pattern: /(?:R\s*th\s*JA|RthJA|Theta\s*JA|junction-to-ambient[^\n]{0,40}?)\D{0,40}?([\d.]+)\s*(?:C|°C)\s*\/\s*W/i,
    read: (m) => ({ theta_ja_c_per_w: Number(m[1]) }),
    show: (v) => `${v.theta_ja_c_per_w} °C/W`,
    enables: "junction_temp",
  },
  {
    name: "max_junction_c",
    label: "Maximum junction temperature",
    pattern: /(?:maximum |max )?(?:chip[- ])?junction temperature\D{0,40}?([\d.]+)\s*(?:C|°C)\b/i,
    read: (m) => Number(m[1]),
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

// site/extract.js: reading parameters out of an attached datasheet.
//
// Every case here is written the way a PDF extractor actually yields it, which
// is the whole point of the file. A datasheet does not say "the supply input
// voltage range is 4.5 to 17 volts". It prints a table - a symbol, a
// description, a min, a max and a unit - and pdf.js flattens those columns into
// one line separated by spaces. The first version of these patterns wanted the
// sentence and found nothing at all in two real documents.
//
// Three failures are pinned here because each cost a real extraction:
//
//   A package name has digits in it. "RthJA Thermal resistance
//   junction-ambient LQFP48 7 x 7 mm 45 C/W" put "LQFP48 7 x 7" between the
//   description and the value, and a digit-free gap could not cross it.
//
//   A limit row is a range. "TJ Operating junction temperature range -40 105 C"
//   holds min and max with nothing between them, so a pattern taking the first
//   number reports -40 as the maximum junction temperature.
//
//   The same quantity has several spellings. RthJA, RthetaJA, Theta JA,
//   junction-to-ambient and junction-ambient are one parameter.
//
//   node tests/extract.mjs

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { extractFacts, EXTRACTORS } = await import("file://" + join(root, "site", "extract.js"));

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

/** [text as a PDF yields it, field, what it should read] */
const CASES = [
  [
    "Table 9. General operating conditions Symbol Parameter Conditions Min Max " +
      "Unit VDD Standard operating voltage 2.0 3.6 V",
    "vin_range_v",
    "2 to 3.6 V",
  ],
  [
    "Thermal characteristics Symbol Parameter Value Unit RthJA Thermal " +
      "resistance junction-ambient LQFP48 7 x 7 mm 45 C/W",
    "thermal",
    "45 °C/W",
  ],
  ["RthetaJA Junction-to-ambient thermal resistance 46.9 degC/W", "thermal", "46.9 °C/W"],
  ["TJ Operating junction temperature range -40 105 C", "max_junction_c", "105 °C"],
  ["VIN Input voltage range 4.5 17 V", "vin_range_v", "4.5 to 17 V"],
  ["Connect a 0.1 uF capacitor between VBST and SW.", "bootstrap_cap", "0.1 uF at VBST"],
  ["2 A synchronous step-down converter", "output_current_a", "2 A"],
];

for (const [text, field, want] of CASES) {
  const got = extractFacts([text])[field];
  check(
    got && got.shown === want,
    `${field}: wanted ${want}, got ${got ? got.shown : "nothing"} — from ${text.slice(0, 60)}`
  );
}

// Provenance. A value with no page is a value nobody can check, and being
// checkable is the whole reason a document beats a number somebody typed.
const facts = extractFacts(["nothing here", "TJ Operating junction temperature range -40 150 C"]);
check(facts.max_junction_c?.page === 2, "a fact carries the page it was found on");
check(
  facts.max_junction_c?.quote.includes("junction temperature"),
  "and the line it was read out of"
);

// A row carrying several numbers where one was wanted is a reading the
// extractor guessed at, and it says so rather than presenting it as read.
const multi = extractFacts([
  "RthJA Junction-to-ambient thermal resistance 88.6 66.7 95.2 123.1 C/W",
]);
check(
  multi.thermal?.confidence === "low",
  `a multi-column thermal row reads as low confidence, got ${multi.thermal?.confidence}`
);

// Nothing invented from a document that says nothing.
check(
  Object.keys(extractFacts(["Revision history. Corrected a typo. Updated ordering."])).length === 0,
  "a document with no parameters yields no parameters"
);

// Every extractor names the evaluator it feeds, or explicitly feeds none.
for (const rule of EXTRACTORS) {
  check(
    "enables" in rule && rule.label,
    `${rule.name} says what it enables and what to call it`
  );
}

for (const failure of failures) console.error("  x " + failure);
console.log(
  failures.length
    ? `${failures.length} extraction checks failed`
    : `${CASES.length} datasheet layouts read correctly, with the page behind each value`
);
process.exit(failures.length ? 1 : 0);

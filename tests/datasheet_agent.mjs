// site/datasheet_agent.js: a model reads the datasheet, the datasheet checks it.
//
// The regexes this replaced reported an output current of 2002 A for a
// ULN2003A - the "2002" of a neighbouring part number with the "A" of
// "ULN2002A". That is not a missing word boundary, it is the approach: a
// pattern matches shapes, and "a number then an A" is the shape of an ampere
// rating and equally of half a part number.
//
// So a model reads the sentence, and everything it says is checked back against
// the document by string comparison. This file tests the checking, because the
// checking is the part that has to be right - a model that hallucinates is
// expected and handled; a verifier that passes a hallucination is a hole.
//
// Every case below is a way a plausible-looking answer must still be refused.
//
//   node tests/datasheet_agent.mjs

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const agent = await import("file://" + join(root, "site", "datasheet_agent.js"));

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

const PAGES = [
  "ULN2001A, ULN2002A, ULN2003A, ULN2004A high-voltage high-current darlington " +
    "transistor arrays. Each output is rated 500 mA continuous collector current.",
  "Absolute maximum ratings. Output clamp diode current 500 mA. Operating " +
    "junction temperature range -40 to 125 C. Thermal resistance RthJA 70 C/W " +
    "for the SOIC-16 package.",
];

const only = (answer) => agent.verifyFacts(answer, PAGES);

// The reading the regexes got wrong, offered as an answer. The quote is real
// prose from the document, and the value is not in it.
{
  const { facts, dropped } = only({
    facts: [
      {
        name: "output_current_a",
        value: 2002,
        unit: "A",
        page: 1,
        quote: "ULN2001A, ULN2002A, ULN2003A, ULN2004A high-voltage high-current",
      },
    ],
  });
  check(!facts.output_current_a, "a part number read as an ampere rating is refused");
  // Worth being exact about which gate stops it, because it is not the one it
  // looks like. "ULN2002A" contains the digits 2002, so the value really does
  // appear in its own quote and that check passes. What refuses it is the
  // order of magnitude: no darlington array sources two thousand amps. Either
  // gate alone would have let this through.
  check(
    dropped[0]?.reason.includes("outside the range"),
    `and says why: ${dropped[0]?.reason}`
  );
}

// A value genuinely absent from its quote, which is the gate the case above
// does not exercise.
{
  const { facts, dropped } = only({
    facts: [
      {
        name: "theta_ja",
        value: 45,
        unit: "C/W",
        page: 2,
        quote: "Thermal resistance RthJA 70 C/W for the SOIC-16 package.",
      },
    ],
  });
  check(!facts.theta_ja, "a value absent from its own quote is refused");
  check(
    dropped[0]?.reason.includes("does not appear in its own quote"),
    `and says why: ${dropped[0]?.reason}`
  );
}

// A quote the document does not contain, however well it reads.
{
  const { facts, dropped } = only({
    facts: [
      {
        name: "theta_ja",
        value: 45,
        unit: "C/W",
        page: 2,
        quote: "The junction-to-ambient thermal resistance is 45 C/W.",
      },
    ],
  });
  check(!facts.theta_ja, "a quote that is not in the document is refused");
  check(
    dropped[0]?.reason.includes("not in the document"),
    `and says why: ${dropped[0]?.reason}`
  );
}

// A value the document does support.
{
  const { facts } = only({
    facts: [
      {
        name: "theta_ja",
        value: 70,
        unit: "C/W",
        page: 2,
        quote: "Thermal resistance RthJA 70 C/W for the SOIC-16 package.",
      },
    ],
  });
  check(facts.theta_ja?.value === 70, "a quoted value that is in the document is kept");
  check(facts.theta_ja?.enables === "junction_temp", "and carries the check it turns on");
}

// Whitespace is not evidence: a PDF's spacing must not decide a match.
{
  const { facts } = only({
    facts: [
      {
        name: "max_junction_c",
        value: 125,
        unit: "C",
        page: 2,
        quote: "Operating   junction temperature range  -40 to 125 C",
      },
    ],
  });
  check(facts.max_junction_c?.value === 125, "whitespace does not decide whether a quote matches");
}

// An order of magnitude no such parameter takes, with a quote that does contain
// the number - the last gate, for when the first three all pass.
{
  const { facts, dropped } = only({
    facts: [
      {
        name: "max_junction_c",
        value: 2001,
        unit: "C",
        page: 1,
        quote: "ULN2001A, ULN2002A, ULN2003A, ULN2004A high-voltage high-current",
      },
    ],
  });
  check(!facts.max_junction_c, "a junction temperature of 2001 C is refused");
  check(dropped[0]?.reason.includes("outside the range"), `and says why: ${dropped[0]?.reason}`);
}

// Two table columns read as one answer. This reached a user's screen as a
// thermal resistance of "42.6 32.4 C/W": not a clean number, so it fell through
// to the string branch and skipped both the value-in-quote and the range check.
{
  const { facts, dropped } = only({
    facts: [
      {
        name: "theta_ja",
        value: "70 32.4",
        unit: "C/W",
        page: 2,
        quote: "Thermal resistance RthJA 70 C/W for the SOIC-16 package.",
      },
    ],
  });
  check(!facts.theta_ja, "two columns read as one value are refused");
  check(
    dropped[0]?.reason.includes("not a single number"),
    `and says why: ${dropped[0]?.reason}`
  );
}

// A parameter with no range is free text, and stays free text.
{
  const { facts } = only({
    facts: [
      {
        name: "required_external_part",
        value: "a catch diode",
        unit: "",
        page: 1,
        quote: "Each output is rated 500 mA continuous collector current.",
      },
    ],
  });
  check(
    facts.required_external_part?.[0]?.value === "a catch diode",
    "a parameter that is not a number is still allowed to be words"
  );
}

// A regulator needs an input capacitor and an output capacitor and a catch
// diode. Keeping the first and discarding the rest reported one of several
// requirements as though it were the requirement.
{
  const { facts } = only({
    facts: ["input capacitor", "output capacitor", "a catch diode"].map((v) => ({
      name: "required_external_part",
      value: v,
      page: 1,
      quote: "Each output is rated 500 mA continuous collector current.",
    })),
  });
  check(
    facts.required_external_part?.length === 3,
    `a parameter with several answers keeps them all, got ${facts.required_external_part?.length}`
  );
}

// One document, one family. A value read off a sibling part's row is worse than
// no value, so the row it came from travels with it.
{
  const { facts } = only({
    facts: [
      {
        name: "theta_ja",
        value: 70,
        unit: "C/W",
        page: 2,
        applies_to: "SOIC-16",
        quote: "Thermal resistance RthJA 70 C/W for the SOIC-16 package.",
      },
    ],
  });
  check(
    facts.theta_ja?.applies_to === "SOIC-16",
    "a fact records which variant or condition its row was for"
  );
}

// A parameter nobody asked about is not a parameter.
{
  const { facts } = only({
    facts: [{ name: "price_usd", value: 1, unit: "$", page: 1, quote: "ULN2001A, ULN2002A" }],
  });
  check(Object.keys(facts).length === 0, "an unasked-for parameter is refused");
}

// No quote at all.
{
  const { facts } = only({ facts: [{ name: "theta_ja", value: 70, unit: "C/W", page: 2 }] });
  check(!facts.theta_ja, "a fact with no quote is refused");
}

// Junk in, nothing out - the model's answer is not trusted to have a shape.
for (const junk of [null, {}, { facts: null }, { facts: [null, 3, "x"] }]) {
  check(
    Object.keys(agent.verifyFacts(junk, PAGES).facts).length === 0,
    `a malformed answer yields no facts: ${JSON.stringify(junk)}`
  );
}

// Retrieval picks what the agent is shown, and never the whole document.
{
  const evidence = agent.evidenceFor(PAGES, "ULN2003A");
  check(evidence.length > 0, "some passage is selected for a document with content");
  check(
    evidence.every((e) => e.page >= 1 && e.page <= PAGES.length),
    "every passage carries the page it came from"
  );
  const prompt = agent.agentPrompt("U3", "ULN2003", evidence);
  check(prompt.includes("JSON only"), "the prompt asks for JSON");
  check(
    prompt.includes("checked against the passages"),
    "and tells the model its answer will be checked"
  );
  check(!/seeded|defect|injected/i.test(prompt), "and names no defect");
}

for (const failure of failures) console.error("  x " + failure);
console.log(
  failures.length
    ? `${failures.length} agent checks failed`
    : "a fact survives only when the document contains its quote and the quote contains its value"
);
process.exit(failures.length ? 1 : 0);

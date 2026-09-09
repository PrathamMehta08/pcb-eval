/**
 * Datasheet facts the person reviewing supplies, because the page cannot fetch.
 *
 * The harness has a research layer: it downloads a datasheet, caches it, and
 * pulls parameters out with the page it found them on. The page cannot do any
 * of that. It has no server, the artifact CSP blocks the fetch, and a board
 * someone just dropped on it must not need a vendor CDN to be reviewed.
 *
 * So the browser asks instead. A component that would be researched and has no
 * facts wears a warning; one with facts wears a check; everything else - the
 * passives, the connectors, the mounting holes - wears nothing, because a
 * datasheet for a 10k resistor answers no question worth asking.
 *
 * WHAT COUNTS AS A FACT
 *
 * The same shape the harness extracts, minus the provenance it cannot have.
 * Every field is optional and an empty store is the normal state: an absent
 * fact means the check that needs it is skipped, exactly as it does in the
 * harness, and never means a default.
 *
 * Stored per board name in localStorage, so the work of typing in a part's
 * input range is not lost on reload. Storage can throw - a private window, or
 * a browser told to block site data - so every access is guarded and the page
 * works with none of it.
 */

import { baseType, pinsByRef } from "./checks.js";
import { docFor } from "./docs.js";

/** Descriptions that mark a part as active silicon. Mirrors harness/research.py. */
const SIGNIFICANT =
  /regulat|converter|\bMCU\b|microcontroller|driver|sensor|transceiver|memory|flash|eeprom|\bADC\b|\bDAC\b|\bPHY\b|amplifier|comparator|reference|oscillator|controller|switch mode|step-down|step-up|LDO/i;
const POWER_TYPES = new Set(["power_in", "power_out", "open_collector", "tri_state"]);
const NEVER_RESEARCHED = /^(R|C|L|FB|TP|H|Y)\d/;

/**
 * Which parts are worth a datasheet, and why. First rule that matches wins.
 *
 * The same triage the harness runs, so the badges on the board agree with what
 * a scored review would actually research.
 *
 * Every clause answers one question: does the netlist already say what this
 * part does? For a resistor it does, and the value is the whole story. For a
 * part number it does not, and the document is the only place the answer lives.
 * So each clause names a property meaning "not deducible from the netlist" - the
 * designator the schematic gave it, a pin that supplies or drives rather than
 * merely conducts, a description of an active device, or a part sitting across
 * more than one supply rail.
 *
 * There used to be a fifth clause, six or more pins, and it was a number
 * somebody picked. It caught exactly one part, a bare 1x06 header, which is the
 * case where a datasheet buys least: there is no document for a row of holes,
 * and what matters about a connector is the pinout of whatever mates with it.
 *
 * The reason is a predicate, not a noun: it is read back as "researched because
 * it <why>", and a phrase that does not finish that sentence is a phrase nobody
 * wrote for a reader.
 */
export function needsDatasheet(board) {
  const pins = pinsByRef(board);
  const out = new Map();
  for (const comp of board.components) {
    const mine = pins.get(comp.ref) || [];
    const rails = new Set(
      mine.map((p) => p.net).filter((n) => /^\/?(VBUS|VCC|VDD|VEE|VIN|VOUT|[+-]?\d+V\d*|[+-]\d+(\.\d+)?V)[A-Z0-9]*$/i.test(n))
    );
    let why = null;
    if (/^(U|S|IC|Q)\d/.test(comp.ref)) {
      why = `carries a ${comp.ref[0]} designator, which marks an integrated circuit`;
    } else if (mine.some((p) => POWER_TYPES.has(baseType(p.node.type)))) {
      why = "has a pin that supplies or drives, so it holds circuitry of its own";
    } else if (SIGNIFICANT.test(`${comp.description || ""} ${comp.value || ""}`)) {
      why = "is described as an active device";
    } else if (rails.size > 1) {
      why = `bridges ${rails.size} supply rails`;
    }
    if (!why) continue;
    if (NEVER_RESEARCHED.test(comp.ref) && mine.length <= 2) continue;
    out.set(comp.ref, why);
  }
  return out;
}

/**
 * How each part stands: "have", "missing", or absent when it needs nothing.
 *
 * A document is the only answer that counts, because it is the only one that
 * can be quoted. Retrieval hands a reviewer a passage with a page number on it,
 * and a finding resting on that can be checked against the document. A number
 * somebody typed into a box cannot be, which is why the box is gone.
 */
export function coverage(board) {
  const out = new Map();
  for (const [ref, why] of needsDatasheet(board)) {
    const doc = docFor(board.meta.name, ref);
    out.set(ref, { status: doc ? "have" : "missing", why, doc: doc || null });
  }
  return out;
}

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

const KEY = "pcb-eval.datasheets.v1";

/** Descriptions that mark a part as active silicon. Mirrors harness/research.py. */
const SIGNIFICANT =
  /regulat|converter|\bMCU\b|microcontroller|driver|sensor|transceiver|memory|flash|eeprom|\bADC\b|\bDAC\b|\bPHY\b|amplifier|comparator|reference|oscillator|controller|switch mode|step-down|step-up|LDO/i;
const POWER_TYPES = new Set(["power_in", "power_out", "open_collector", "tri_state"]);
const NEVER_RESEARCHED = /^(R|C|L|FB|TP|H|Y)\d/;

/**
 * Which parts are worth a datasheet, and why. First rule that matches wins.
 *
 * The reason is a predicate, not a noun: it is read back to a person as
 * "researched because it <why>", and a phrase that does not finish that
 * sentence is a phrase nobody wrote for a reader.
 *
 * The same triage the harness runs, so the badges on the board agree with what
 * a scored review would actually research. A two-pin passive never qualifies
 * however it matched: what is worth knowing about it is its value, and the
 * netlist already carries that.
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
    if (mine.length >= 6) why = `has ${mine.length} pins`;
    else if (/^(U|S|IC|Q)\d/.test(comp.ref))
      why = `carries a ${comp.ref[0]} designator`;
    else if (mine.some((p) => POWER_TYPES.has(baseType(p.type)))) why = "carries a power or driver pin";
    else if (SIGNIFICANT.test(`${comp.description || ""} ${comp.value || ""}`))
      why = "reads as an active part";
    else if (rails.size > 1) why = `sits on ${rails.size} supply rails`;
    if (!why) continue;
    if (NEVER_RESEARCHED.test(comp.ref) && mine.length <= 2) continue;
    out.set(comp.ref, why);
  }
  return out;
}

function read() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}");
  } catch {
    return {};
  }
}

function write(all) {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* a private window, or site data blocked. The page still works. */
  }
}

/** Every fact supplied for this board, keyed by ref. */
export function factsFor(boardName) {
  return read()[boardName] || {};
}

/** What has been supplied for one part, or null. */
export function factsOf(boardName, ref) {
  return factsFor(boardName)[ref] || null;
}

/**
 * Record what someone read off a datasheet. Empty fields are dropped, and a
 * part with nothing left is forgotten rather than stored empty - an empty
 * record and no record mean the same thing and should not look different.
 */
export function setFacts(boardName, ref, facts) {
  const all = read();
  const board = { ...(all[boardName] || {}) };
  const kept = {};
  for (const [name, value] of Object.entries(facts || {})) {
    const text = typeof value === "string" ? value.trim() : value;
    if (text === "" || text === null || text === undefined) continue;
    kept[name] = text;
  }
  if (Object.keys(kept).length) board[ref] = kept;
  else delete board[ref];
  all[boardName] = board;
  write(all);
  return board[ref] || null;
}

/** How each part stands: "have", "missing", or absent when it needs nothing. */
export function coverage(board) {
  const needed = needsDatasheet(board);
  const have = factsFor(board.meta.name);
  const out = new Map();
  for (const [ref, why] of needed) {
    out.set(ref, { status: have[ref] ? "have" : "missing", why });
  }
  return out;
}

/**
 * The researched-facts block for the circuit pack, in the harness's shape.
 *
 * Marked as supplied by hand rather than read from a document, because that is
 * what it is: nobody checked these against a PDF, and a reviewer leaning on one
 * should be able to say where it came from.
 */
export function researchBlock(board) {
  const have = factsFor(board.meta.name);
  const refs = Object.keys(have).sort();
  if (!refs.length) return [];
  const values = new Map(board.components.map((c) => [c.ref, c.value]));
  const lines = ["DATASHEET FACTS  supplied by hand, not read from a document"];
  for (const ref of refs) {
    for (const [name, value] of Object.entries(have[ref])) {
      lines.push(`${ref} (${values.get(ref) || "?"}) ${name}: ${value}`);
    }
  }
  return lines;
}

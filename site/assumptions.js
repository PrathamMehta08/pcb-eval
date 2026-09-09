/**
 * The inputs a gated reviewer needs, and where the page gets them.
 *
 * The mirror of harness/assumptions.py. Three of the five reviewers cannot say
 * anything true about a board from the board alone. A thermal reviewer needs an
 * ambient and a dissipation before a junction temperature means anything; a
 * signal-integrity reviewer needs a stackup before a trace width is an
 * impedance; a power-integrity reviewer needs both. Absent those, the honest
 * answer is not an estimate with a caveat attached - it is that the domain was
 * not assessed, and it is reported that way.
 *
 * The harness reads them from `boards/<name>.assumptions.yml`. The page has no
 * file to read, so it asks, the same way it asks for datasheet facts: what
 * someone supplies turns a reviewer on, and the graph visibly grows a node.
 * Nothing is defaulted. A field left blank keeps its domain switched off rather
 * than filling in a plausible number, because a number nobody supplied is the
 * one kind of evidence a reviewer cannot tell apart from a measured one.
 */

import { factsFor } from "./datasheets.js";

const KEY = "pcb-eval.assumptions.v1";

/** What each gated domain cannot run without. Mirrors REQUIREMENTS in the Python. */
export const REQUIREMENTS = {
  thermal: ["ambient_c", "dissipation_w"],
  signal_integrity: ["stackup", "high_speed_nets"],
  power_integrity: ["stackup", "dissipation_w"],
};

/** Every input the page can be told, in the order the form shows them. */
export const FIELDS = [
  ["ambient_c", "Ambient", "°C", "25"],
  ["dissipation_w", "Dissipation", "W", "1.2"],
  ["stackup", "Stackup", "", "2-layer, 1.6 mm FR4"],
  ["high_speed_nets", "Fast nets", "", "USB_DP, USB_DM"],
  ["copper_weight_oz", "Copper", "oz", "1"],
];

function read() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}");
  } catch {
    return {};
  }
}

export function inputsFor(boardName) {
  return read()[boardName] || {};
}

/** Store what was supplied, dropping blanks so an empty field stays a gate. */
export function setInputs(boardName, inputs) {
  const all = read();
  const kept = {};
  for (const [name, value] of Object.entries(inputs || {})) {
    const text = typeof value === "string" ? value.trim() : value;
    if (text === "" || text === null || text === undefined) continue;
    kept[name] = text;
  }
  all[boardName] = kept;
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* a private window, or site data blocked. The page still works. */
  }
  return kept;
}

/**
 * Which gated domains may run, and why each of the rest may not.
 *
 * Every domain is returned: "" when it is enabled, the reason when it is not,
 * so one answer both gates the graph and prints as coverage. Thermal takes a
 * third requirement from somewhere else - a junction-to-ambient resistance,
 * which is a datasheet number rather than a board number. A thermal reviewer
 * holding two of the three has nothing to compute a margin from; it would be
 * reasoning about heat in general instead of about this board.
 */
export function enabled(inputs, facts) {
  const out = {};
  for (const [domain, needs] of Object.entries(REQUIREMENTS)) {
    const missing = needs.filter((name) => !(inputs || {})[name]);
    out[domain] = missing.length
      ? "no " + missing.map((n) => n.replace(/_/g, " ")).join(" and no ")
      : "";
  }
  if (!out.thermal) {
    const usable = Object.values(facts || {}).some((rec) => rec && rec.theta_ja);
    if (!usable) {
      out.thermal = "no junction-to-ambient resistance among the supplied facts";
    }
  }
  return out;
}

/** The gates for a board, from everything the page has been told about it. */
export function gatesFor(board) {
  return enabled(inputsFor(board.meta.name), factsFor(board.meta.name));
}

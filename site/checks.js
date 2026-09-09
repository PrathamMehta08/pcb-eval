// The deterministic rules, in the browser. The mirror of harness/checks.py.
//
// Seven rules and one contract that matters more than any of them: every seeded
// defect trips its own rule, and the board as manufactured trips none. A
// detector that fires on a clean board is worth nothing.
//
// These run before any model is asked anything, and again afterwards to refute
// what a model said. That is the whole shape of the review: the model proposes,
// the measurements dispose, and the referee is the board.
//
// tests/checks_parity.mjs holds this to the Python, rule for rule, on the clean
// board and on all seven seeded ones.

import { islands } from "./copper.js";

const GROUND = /^\/?((A|D|P|E|SG|PG|GND)?GND[A-Z0-9_]*|GND|VSS[A-Z0-9_]*)$/i;
const RAIL = /^\/?(VBUS|VCC|VDD|VEE|VIN|VOUT|[+-]?\d+V\d*|[+-]\d+(\.\d+)?V)[A-Z0-9]*$/i;
const DRIVERS = new Set(["output", "power_out", "open_collector", "tri_state"]);
const SERVO_NET = /SERVO|\bPWM\b|ESC/i;
const DRIVER_PART = /darlington|transistor array|\bdriver\b|h-?bridge|mosfet|\bgate\b|relay/i;
const PASSIVE_PREFIX = /^[RCL]/;

export const isGround = (name) => GROUND.test(name || "");
export const isRail = (name) => RAIL.test(name || "") || isGround(name);
export const baseType = (t) => String(t || "").split("+")[0];

function finding(rule, title, why, { refs = [], nets = [], severity = "major", fix = "" } = {}) {
  return {
    rule,
    severity,
    refs: [...new Set(refs)].sort(),
    nets: [...new Set(nets)].sort(),
    title,
    why,
    fix,
  };
}

/** ref -> [{net, node}], every pin of every part. */
export function pinsByRef(board) {
  const out = new Map();
  for (const net of board.nets) {
    for (const node of net.nodes) {
      if (!out.has(node.ref)) out.set(node.ref, []);
      out.get(node.ref).push({ net: net.name, node });
    }
  }
  return out;
}

// ----------------------------------------------------------------- schematic

/** A pin whose datasheet name is also a net name must be on that net. */
function powerPinMiswired(board) {
  const names = new Map(board.nets.map((n) => [n.name.replace(/^\//, "").toUpperCase(), n.name]));
  const out = [];
  for (const net of board.nets) {
    for (const node of net.nodes) {
      const fn = node.function || "";
      if (!fn) continue;
      const declared = fn.replace(new RegExp(`_${node.pin}$`), "").toUpperCase();
      if (declared.length < 2 || !names.has(declared)) continue;
      const expected = names.get(declared);
      if (expected === net.name) continue;
      // Splitting the return around a switcher is what you are supposed to do.
      if (isGround(expected) && isGround(net.name)) continue;
      out.push(
        finding(
          "power-pin-miswired",
          `${node.ref} pin ${node.pin} (${fn}) is on ${net.name}, not ${expected}`,
          `The part names this pin ${declared}, and the board has a net called ${expected}. ` +
            `Wiring it to ${net.name} means the pin is doing a different job than the symbol says.`,
          {
            refs: [node.ref],
            nets: [net.name, expected],
            severity: "critical",
            fix: `Move ${node.ref} pin ${node.pin} back to ${expected}.`,
          }
        )
      );
    }
  }
  return out;
}

/** A connector with three or more pins must carry a ground or a supply. */
function connectorNoReference(board) {
  const out = [];
  for (const [ref, pins] of pinsByRef(board)) {
    if (!ref.startsWith("J") || pins.length < 3) continue;
    const names = pins.map((p) => p.net);
    if (names.some(isRail)) continue;
    if (names.every((n) => n.startsWith("unconnected-"))) continue;
    out.push(
      finding(
        "connector-no-reference",
        `${ref} has ${pins.length} pins and no ground or supply among them`,
        "Every pin on this header is a signal, so whatever plugs in has no return " +
          "path and no rail.",
        {
          refs: [ref],
          nets: names,
          severity: "critical",
          fix: `Give ${ref} a ground pin, a supply pin, or both.`,
        }
      )
    );
  }
  return out;
}

/** On a three-pin servo header the supply belongs on the middle pin. */
function connectorPowerOrder(board) {
  const out = [];
  for (const [ref, pins] of pinsByRef(board)) {
    if (!ref.startsWith("J") || pins.length !== 3) continue;
    const byPin = new Map(pins.map((p) => [p.node.pin, p.net]));
    if (["1", "2", "3"].some((k) => !byPin.has(k)) || byPin.size !== 3) continue;
    const supplies = [...byPin].filter(([, n]) => isRail(n) && !isGround(n)).map(([p]) => p);
    const grounds = [...byPin].filter(([, n]) => isGround(n)).map(([p]) => p);
    const signals = [...byPin].filter(([, n]) => !isRail(n)).map(([p]) => p);
    if (supplies.length !== 1 || grounds.length !== 1 || signals.length !== 1) continue;
    // Only a servo lead has this convention; a three-pin sensor header is
    // supply, output, ground and correct that way.
    if (!SERVO_NET.test(byPin.get(signals[0]))) continue;
    if (supplies[0] === "2") continue;
    out.push(
      finding(
        "connector-power-order",
        `${ref}: ${byPin.get(supplies[0])} is on end pin ${supplies[0]}, not the middle pin`,
        "A three-wire servo lead is signal, power, ground in that order and the " +
          "header is not keyed, so a lead plugged in the normal way puts the supply " +
          "on the servo's ground.",
        {
          refs: [ref],
          nets: [...byPin.values()],
          severity: "critical",
          fix: `Swap ${ref} pins ${supplies[0]} and 2, so the supply is in the middle.`,
        }
      )
    );
  }
  return out;
}

/** A four-pin sensor header is supply, signal, signal, ground, in that order. */
function sensorPinoutOrder(board) {
  const out = [];
  for (const [ref, pins] of pinsByRef(board)) {
    if (!ref.startsWith("J") || pins.length !== 4) continue;
    const byPin = new Map(pins.map((p) => [p.node.pin, p.net]));
    if (["1", "2", "3", "4"].some((k) => !byPin.has(k)) || byPin.size !== 4) continue;
    const supplies = [...byPin].filter(([, n]) => isRail(n) && !isGround(n)).map(([p]) => p);
    const grounds = [...byPin].filter(([, n]) => isGround(n)).map(([p]) => p);
    const signals = [...byPin].filter(([, n]) => !isRail(n)).map(([p]) => p);
    if (supplies.length !== 1 || grounds.length !== 1 || signals.length !== 2) continue;

    const problems = [];
    if (supplies[0] !== "1") {
      problems.push(`the supply ${byPin.get(supplies[0])} is on pin ${supplies[0]}, not pin 1`);
    }
    if (grounds[0] !== "4") problems.push(`ground is on pin ${grounds[0]}, not pin 4`);
    const trig = signals.filter((p) => byPin.get(p).toUpperCase().includes("TRIG"));
    const echo = signals.filter((p) => byPin.get(p).toUpperCase().includes("ECHO"));
    if (trig.length === 1 && echo.length === 1 && Number(trig[0]) > Number(echo[0])) {
      problems.push(`trigger is on pin ${trig[0]} and echo on pin ${echo[0]}, the wrong way round`);
    }
    if (!problems.length) continue;
    out.push(
      finding(
        "sensor-pinout-order",
        `${ref} does not match a four-wire sensor pinout: ${problems.join("; ")}`,
        "A four-wire module's cable is supply, signal, signal, ground, and the " +
          "header is not keyed, so this connects the wrong wire to the wrong pin.",
        {
          refs: [ref],
          nets: [...byPin.values()],
          severity: "critical",
          fix: `Rewire ${ref} as supply, signal, signal, ground on pins 1 to 4.`,
        }
      )
    );
  }
  return out;
}

/** Does this passive pin's part have another pin sitting on a rail? */
function reachesRail(board, node, fromNet) {
  if (!/^(R|L|FB)/.test(node.ref)) return false;
  for (const other of board.nets) {
    if (other.name === fromNet) continue;
    if (other.nodes.some((n) => n.ref === node.ref) && isRail(other.name)) return true;
  }
  return false;
}

/** A power driver's input needs something holding it while the MCU resets. */
function floatingDriverInput(board) {
  const drivers = new Set(
    board.components
      .filter((c) => DRIVER_PART.test(`${c.description || ""} ${c.value || ""}`))
      .map((c) => c.ref)
  );
  const out = [];
  for (const net of board.nets) {
    if (isRail(net.name) || net.name.startsWith("unconnected-")) continue;
    const inputs = net.nodes.filter((n) => baseType(n.type) === "input" && drivers.has(n.ref));
    if (!inputs.length) continue;
    if (net.nodes.some((n) => DRIVERS.has(baseType(n.type)))) continue;
    // A capacitor is not a pull: what defines a level is a part whose other end
    // lands on a rail.
    if (net.nodes.some((n) => baseType(n.type) === "passive" && reachesRail(board, n, net.name))) {
      continue;
    }
    out.push(
      finding(
        "floating-driver-input",
        `${net.name} drives ${inputs[0].ref} with nothing holding it at reset`,
        "The only other pin on this net is a port that sits high impedance until " +
          "firmware configures it, so the driver input floats from power-up and what " +
          "it drives can energise.",
        {
          refs: net.nodes.map((n) => n.ref),
          nets: [net.name],
          fix: `Add a pull resistor from ${net.name} to a rail.`,
        }
      )
    );
  }
  return out;
}

/** A resistor, capacitor or inductor needs a magnitude to be orderable. */
function unbuildableValue(board) {
  const out = [];
  for (const comp of board.components) {
    if (!PASSIVE_PREFIX.test(comp.ref)) continue;
    const value = (comp.value || "").trim();
    if (/\d/.test(value)) continue;
    out.push(
      finding(
        "value-not-orderable",
        `${comp.ref} has value ${JSON.stringify(value)}, which is not a quantity`,
        "There is no magnitude here, so the line cannot be ordered and nobody " +
          "assembling the board knows what to fit.",
        { refs: [comp.ref], fix: `Give ${comp.ref} a value that can be ordered.` }
      )
    );
  }
  return out;
}

// -------------------------------------------------------------------- copper

/** A net's pads must all reach each other through copper. */
function netIsland(board) {
  const out = [];
  for (const [net, groups] of islands(board)) {
    const withPads = groups.filter((g) => g.some((i) => i.kind === "pad"));
    if (withPads.length < 2) continue;
    const size = (g) => g.filter((i) => i.kind === "pad").length;
    const main = withPads.reduce((a, b) => (size(b) > size(a) ? b : a));
    const rest = withPads.filter((g) => g !== main);
    const stranded = rest.reduce((n, g) => n + size(g), 0);
    const refs = new Set();
    for (const group of rest) {
      for (const item of group) if (item.kind === "pad") refs.add(item.id.split(".")[0]);
    }
    out.push(
      finding(
        "net-island",
        `${net} is not one piece of copper: ${withPads.length} separate islands, ${stranded} pads stranded`,
        "The net list says these pads are one net and the copper says otherwise. " +
          "Nothing in ERC or DRC reads the copper, so both pass a board that cannot work.",
        {
          refs: [...refs],
          nets: [net],
          severity: "critical",
          fix: `Stitch the ${net} islands together: vias between the layers where the pads are, and a pour on both.`,
        }
      )
    );
  }
  return out;
}

/**
 * A supply pin must not share a net with an MCU port.
 *
 * `powerPinMiswired` only fires when the designer named a net after the pin, so
 * it is blind whenever they did not: this board's buck takes its input on a pin
 * the library calls `VIN_3`, and the net is called `/IN`. Move that pin onto a
 * servo signal and every rule stayed silent, the gate saw nothing to chase, and
 * the review stopped after one pass.
 *
 * Electrical type is the signal it uses instead, and the netlist always carries
 * it: a `power_in` pin sharing copper with a `bidirectional` MCU port is not a
 * choice anyone makes. Quiet on the board as manufactured, where none of the
 * six nets carrying a supply pin also carries a GPIO.
 */
function powerPinOnSignalNet(board) {
  const out = [];
  for (const net of board.nets) {
    const supplies = net.nodes.filter((n) => baseType(n.type) === "power_in");
    const ports = net.nodes.filter((n) => baseType(n.type) === "bidirectional");
    if (!supplies.length || !ports.length) continue;
    const supply = supplies[0];
    const port = ports[0];
    out.push(
      finding(
        "power-pin-on-signal-net",
        `${supply.ref} pin ${supply.pin} is a supply pin sharing ${net.name} ` +
          `with the MCU port ${port.ref}.${port.pin}`,
        `${net.name} carries both a power input and a general-purpose pin. ` +
          "Either the port is being asked to source a rail, or the rail is " +
          "backfeeding the port through its protection diode. Neither part " +
          "survives that for long.",
        {
          refs: [...new Set([supply.ref, port.ref])].sort(),
          nets: [net.name],
          severity: "critical",
          fix:
            `Return ${supply.ref} pin ${supply.pin} to its supply net and leave ` +
            `${net.name} to the signal.`,
        }
      )
    );
  }
  return out;
}

const RULES = [
  powerPinMiswired,
  connectorNoReference,
  connectorPowerOrder,
  sensorPinoutOrder,
  floatingDriverInput,
  powerPinOnSignalNet,
  unbuildableValue,
  netIsland,
];

export function runChecks(board) {
  // The schematic rules, then the fab limits. The page ran only the first group
  // for a long time, so narrowing a track past what a process can etch produced
  // no finding here while the harness measured one.
  return RULES.flatMap((rule) => rule(board)).concat(runDfm(board));
}

// ------------------------------------------------------- refuting a claim

const SPLIT_CLAIM =
  /\b(strand|island|isolat|not connected|unconnected|disconnect|floating copper|no return|open circuit|separate piece)/i;
const NO_VALUE_CLAIM = /\b(no value|missing value|unspecified value|value is missing)/i;

/** The measurements a finding can be checked against. */
export function boardFacts(board) {
  const counts = new Map();
  const pads = new Map();
  for (const [net, groups] of islands(board)) {
    const key = net.replace(/^\//, "").toUpperCase();
    counts.set(key, groups.filter((g) => g.some((i) => i.kind === "pad")).length);
    pads.set(key, groups.reduce((n, g) => n + g.filter((i) => i.kind === "pad").length, 0));
  }
  // Which nets something holds at a level, for the floating check. Held-ness
  // belongs to the net, not the part.
  const held = new Set();
  for (const net of board.nets) {
    const key = net.name.replace(/^\//, "").toUpperCase();
    if (isRail(net.name) || isGround(net.name)) {
      held.add(key);
      continue;
    }
    if (net.nodes.some((n) => reachesRail(board, n, net.name))) held.add(key);
  }

  return {
    refs: new Set(board.components.map((c) => c.ref.toUpperCase())),
    nets: new Set(board.nets.map((n) => n.name.replace(/^\//, "").toUpperCase())),
    islands: counts,
    pads,
    values: new Map(board.components.map((c) => [c.ref.toUpperCase(), c.value || ""])),
    held,
  };
}

/**
 * Why the board says this finding is wrong, or "" if it does not.
 *
 * Identity is judged on the whole finding: a reviewer that names S1 correctly
 * and gets a net name slightly wrong has still found something. Only a finding
 * where nothing it names exists is talking about a different board.
 */
export function contradiction(item, facts) {
  const named = [...(item.refs || []), ...(item.nets || [])];
  if (named.length) {
    const known = [
      ...(item.refs || []).filter((r) => facts.refs.has(r.toUpperCase())),
      ...(item.nets || []).filter((n) => facts.nets.has(n.replace(/^\//, "").toUpperCase())),
    ];
    if (!known.length) return `nothing it names is on this board: ${named.join(", ")}`;
  }

  const text = `${item.title || ""} ${item.why || ""}`;
  if (SPLIT_CLAIM.test(text)) {
    for (const net of item.nets || []) {
      const key = net.replace(/^\//, "").toUpperCase();
      if (facts.islands.get(key) === 1 && (facts.pads.get(key) || 0) >= 2) {
        return `${net} is one connected piece of copper across all ${facts.pads.get(key)} of its pads`;
      }
    }
  }
  if (NO_VALUE_CLAIM.test(text)) {
    for (const ref of item.refs || []) {
      const value = facts.values.get(ref.toUpperCase()) || "";
      if (/\d/.test(value)) return `${ref} has the value ${value}`;
    }
  }
  return "";
}

/**
 * The critic: deterministic, and typed by the finding's own `claim`.
 *
 * The mirror of graph/verify.py. It is deliberately not the same function as
 * `contradiction` above — that one is the grader, frozen so the sweep compares
 * architectures on a ruler neither of them can move. This one does the work.
 *
 * Kinds nothing can settle from a netlist and copper are passed through rather
 * than guessed at: `pin_floating` needs to know what firmware configures a pin
 * as, and `trace_undersized` needs a current the extraction does not carry.
 */
const CHECKABLE = new Set([
  "net_split",
  "value_unbuildable",
  "missing_component",
  "decoupling_distance",
  // Held-ness is a property of the net, never of the part: a part is not
  // floating as a whole, only one of its pins is. Judging it on the part marks
  // every powered IC as held and deletes the real floating-input defect.
  "pin_floating",
]);

const squeeze = (s) => s.split(/\s+/).join(" ").toUpperCase();
const normNet = (s) => String(s ?? "").trim().toUpperCase().replace(/^\//, "");

export function verify(item, facts, distilled) {
  const claim = String(item.claim || "").trim();
  const subject = String(item.subject || "").trim();

  // A subject that is not on this board: the finding is about a different one.
  if (subject) {
    const s = normNet(subject);
    if (!facts.refs.has(s) && !facts.nets.has(s)) {
      return `its subject ${subject} is not on this board`;
    }
  }

  // Evidence that is not in the board data. A reviewer that cannot copy a line
  // supporting its claim did not read one.
  const evidence = String(item.evidence || "").trim();
  if (evidence && evidence.length > 12 && !squeeze(distilled).includes(squeeze(evidence))) {
    return `its evidence is not a line in the board data: "${evidence.slice(0, 60)}"`;
  }

  if (CHECKABLE.has(claim)) {
    const s = normNet(subject);
    if (claim === "net_split") {
      for (const name of [s, ...(item.nets || []).map(normNet)]) {
        if (facts.islands.get(name) === 1 && (facts.pads.get(name) || 0) >= 2) {
          return `${name} is one connected piece of copper across all ${facts.pads.get(name)} of its pads`;
        }
      }
    } else if (claim === "value_unbuildable") {
      for (const ref of [s, ...(item.refs || []).map(normNet)]) {
        const value = facts.values.get(ref) || "";
        if (/\d/.test(value)) return `${ref} has the value ${value}, which can be ordered`;
      }
    } else if (claim === "missing_component") {
      if (facts.refs.has(s)) return `${s} is on this board`;
    } else if (claim === "pin_floating") {
      for (const name of [s, ...(item.nets || []).map(normNet)]) {
        if (facts.held.has(name)) {
          return `${name} is held at a level by a resistor or inductor to a rail`;
        }
      }
    }
  }

  // The frozen floor, so an untyped finding is still held to the old checks.
  return contradiction(item, facts);
}

// --------------------------------------------------- fab limits and current

/**
 * Manufacturability and ampacity, against fab limits. Mirrors harness/dfm.py.
 *
 * These were in the harness and not here, so the page ran eight deterministic
 * rules where a sweep ran eleven. Narrowing a track to 0.1 mm on the page
 * produced nothing at all, and the reviewer was left to notice it in prose.
 *
 * The parity test never caught the gap because it holds `harness/checks.py`
 * against this file, and these rules lived in `harness/dfm.py`, which had no
 * counterpart here to compare against. A file with no mirror cannot drift; it
 * can only be missing, which is quieter and worse.
 */
const MIN_ANNULAR_RING_MM = 0.13;
const MIN_PLATED_DRILL_MM = 0.3;
const MIN_TRACK_WIDTH_MM = 0.127;

/**
 * Holes with no plating: mounting holes, alignment pegs, tooling.
 *
 * The pad is the same size as the drill by design, because there is no copper
 * to ring it. The Python's first version flagged six of them - four mounting
 * holes and two switch pegs - which is the trap this constant exists to avoid.
 */
const UNPLATED = "np_thru_hole";

function dfmFinding(rule, title, why, fix, refs = [], nets = [], severity = "major") {
  return {
    rule,
    source: "dfm",
    severity,
    refs: [...refs],
    nets: [...nets],
    title,
    why,
    fix,
    claim: "manufacturability",
    subject: refs[0] || nets[0] || "",
    evidence: "",
  };
}

/** A plated hole needs copper left around it after the drill wanders. */
function annularRing(board) {
  const out = [];
  for (const fp of board.layout.footprints) {
    for (const pad of fp.pads) {
      const drill = pad.drill || 0;
      if (!drill || pad.kind === UNPLATED) continue;
      const ring = (Math.min(pad.w, pad.h) - drill) / 2;
      if (ring < MIN_ANNULAR_RING_MM) {
        out.push(
          dfmFinding(
            "dfm-annular-ring",
            `${fp.ref} pad ${pad.num} has a ${ring.toFixed(3)} mm annular ring`,
            `Below the ${MIN_ANNULAR_RING_MM} mm a low-cost two-layer process holds, so ` +
              "drill wander can break the pad away from its barrel.",
            `Grow the pad to at least ${(drill + 2 * MIN_ANNULAR_RING_MM).toFixed(2)} mm across.`,
            [fp.ref],
            pad.net ? [pad.net] : []
          )
        );
      }
    }
  }
  return out;
}

/** Plated holes below the fab's smallest drill. */
function drillSize(board) {
  const out = [];
  for (const fp of board.layout.footprints) {
    for (const pad of fp.pads) {
      const drill = pad.drill || 0;
      if (!drill || pad.kind === UNPLATED) continue;
      if (drill < MIN_PLATED_DRILL_MM) {
        out.push(
          dfmFinding(
            "dfm-drill-size",
            `${fp.ref} pad ${pad.num} drills ${drill.toFixed(2)} mm`,
            `Smaller than the ${MIN_PLATED_DRILL_MM} mm minimum plated drill.`,
            `Open the hole to ${MIN_PLATED_DRILL_MM} mm.`,
            [fp.ref]
          )
        );
      }
    }
  }
  for (const via of board.layout.vias) {
    if (via.drill < MIN_PLATED_DRILL_MM) {
      out.push(
        dfmFinding(
          "dfm-drill-size",
          `A via on ${via.net} drills ${via.drill.toFixed(2)} mm`,
          `Smaller than the ${MIN_PLATED_DRILL_MM} mm minimum plated drill.`,
          `Open the via drill to ${MIN_PLATED_DRILL_MM} mm.`,
          [],
          via.net ? [via.net] : [],
          "minor"
        )
      );
    }
  }
  return out;
}

/** Tracks below what the process can etch reliably. */
function trackWidth(board) {
  const thin = board.layout.tracks.filter((t) => t.width < MIN_TRACK_WIDTH_MM);
  if (!thin.length) return [];
  const nets = [...new Set(thin.map((t) => t.net).filter(Boolean))].sort();
  return [
    dfmFinding(
      "dfm-track-width",
      `${thin.length} track segments are narrower than ${MIN_TRACK_WIDTH_MM} mm`,
      "Below the minimum trace width the process can etch, so the copper may " +
        "come out thin or open.",
      `Widen them to at least ${MIN_TRACK_WIDTH_MM} mm.`,
      [],
      nets.slice(0, 4)
    ),
  ];
}

/**
 * How much current a track can carry, by IPC-2221.
 *
 *   I = k * dT^0.44 * A^0.725      A in square mils, dT in degrees C
 *
 * `k` is 0.048 for an outer layer and 0.024 for an inner one, and the
 * difference is the whole reason a number is quoted with its assumptions
 * beside it: the same 0.1 mm track carries 0.45 A on the outside of a board
 * and 0.22 A buried in it. Assumed 1 oz copper and a 10 degree rise, which is
 * the ordinary case and is stated wherever the number is shown.
 */
const OUNCE_MILS = 1.378;
const RISE_C = 10;

export function ampacity(widthMm, { outer = true, ounces = 1 } = {}) {
  const mils = (widthMm / 0.0254) * ounces * OUNCE_MILS;
  const k = outer ? 0.048 : 0.024;
  return k * Math.pow(RISE_C, 0.44) * Math.pow(mils, 0.725);
}

/**
 * Which nets are supply rails, by two routes rather than one.
 *
 * A name that follows the convention - VBUS, VCC, +3.3V, VOUT - or a net
 * carrying a pin the symbol typed as power. Either is enough, because neither
 * is reliable alone: one board calls its rails `/IN` and `/OUT`, which no
 * naming rule catches, and another draws every symbol with untyped pins.
 *
 * The honest limit is that a board doing both - unconventional names and
 * untyped pins - has no supply rail this can find, and the ampacity check is
 * silent on it rather than wrong about it. `dcdcc` in this repository is
 * exactly that board, which is why it is worth saying out loud instead of
 * discovering later.
 */
function supplyRails(board) {
  const out = new Set();
  for (const net of board.nets) {
    if (isGround(net.name)) continue;
    if (isRail(net.name)) {
      out.add(net.name);
      continue;
    }
    if (net.nodes.some((n) => POWER_PIN.has(baseType(n.type)))) out.add(net.name);
  }
  return out;
}

const POWER_PIN = new Set(["power_in", "power_out"]);

/**
 * The narrowest track on each supply rail, and what it can carry.
 *
 * A measurement, not a verdict, and it is here because the verdict needs a
 * number nobody has supplied: how much current the rail actually draws. What
 * can be said without that is what the copper can take, and a 5 V rail whose
 * narrowest segment carries 0.45 A is a fact worth a reviewer's attention even
 * though it is not yet a defect.
 */
export function railCapacity(board) {
  const out = [];
  const rails = supplyRails(board);
  const narrowest = new Map();
  for (const track of board.layout.tracks) {
    const net = track.net;
    if (!net || !rails.has(net)) continue;
    if (!narrowest.has(net) || track.width < narrowest.get(net)) {
      narrowest.set(net, track.width);
    }
  }
  for (const [net, width] of [...narrowest].sort()) {
    out.push({
      rule: "rail-ampacity",
      source: "measured",
      net,
      width_mm: width,
      amps: Number(ampacity(width).toFixed(2)),
      note:
        `${net} narrows to ${width} mm, which carries about ` +
        `${ampacity(width).toFixed(2)} A on an outer layer at 1 oz copper and a ` +
        "10 C rise.",
    });
  }
  return out;
}

export const DFM_RULES = [annularRing, drillSize, trackWidth];

export function runDfm(board) {
  return DFM_RULES.flatMap((rule) => rule(board));
}

/**
 * A rail that cannot carry what its regulator is rated to deliver.
 *
 * This is the check the fab-limit rule is not. A 0.1 mm track on a 5 V rail is
 * two separate problems: the process may not etch it, which `dfm-track-width`
 * says, and it carries about a quarter of an amp, which is an electrical fact
 * and the one that actually burns. The first is about the board being made; the
 * second is about it working.
 *
 * It needs a current, and it refuses to guess one. `rated` maps a part to the
 * output current its datasheet states - which the datasheet agent extracts and
 * verifies against a quote - and the rail is whatever that part's power-output
 * pins sit on. No datasheet, no rated current, no finding: the rail's capacity
 * is still reported as a measurement, and the check reports as unassessed
 * rather than as passed.
 */
export function railAmpacityFindings(board, rated) {
  if (!rated || !Object.keys(rated).length) return [];
  const rails = supplyRails(board);
  const narrowest = new Map();
  for (const track of board.layout.tracks) {
    const net = track.net;
    if (!net || !rails.has(net)) continue;
    if (!narrowest.has(net) || track.width < narrowest.get(net)) {
      narrowest.set(net, track.width);
    }
  }

  const out = [];
  for (const net of board.nets) {
    for (const node of net.nodes) {
      const amps = rated[node.ref];
      if (!amps || baseType(node.type) !== "power_out") continue;
      const width = narrowest.get(net.name);
      if (width === undefined) continue;
      const carries = ampacity(width);
      if (carries >= amps) continue;
      out.push(
        dfmFinding(
          "rail-ampacity",
          `${net.name} narrows to ${width} mm, below what ${node.ref} can deliver`,
          `${node.ref} is rated for ${amps} A and the narrowest segment on this ` +
            `rail carries about ${carries.toFixed(2)} A at 1 oz copper on an outer ` +
            "layer, so the copper is the limit rather than the regulator.",
          `Widen ${net.name} to at least ${widthFor(amps).toFixed(2)} mm, or pour it.`,
          [node.ref],
          [net.name],
          "critical"
        )
      );
    }
  }
  return out;
}

/** The width IPC-2221 wants for a current, inverting `ampacity`. */
export function widthFor(amps, { outer = true, ounces = 1 } = {}) {
  const k = outer ? 0.048 : 0.024;
  const mils = Math.pow(amps / (k * Math.pow(RISE_C, 0.44)), 1 / 0.725);
  return (mils / (ounces * OUNCE_MILS)) * 0.0254;
}

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
function pinsByRef(board) {
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
  return RULES.flatMap((rule) => rule(board));
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

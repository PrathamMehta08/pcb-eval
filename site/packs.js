/**
 * Evidence packs, in the browser. The mirror of harness/packs.py.
 *
 * The same boundary the harness enforces: a reviewer is handed its pack and
 * nothing else, so what it can say is bounded by what it was shown. The circuit
 * reviewer has no copper to speculate about; the physical reviewer has no pin
 * semantics to duplicate.
 *
 * One honest difference from the Python. The page has no research layer - it
 * cannot fetch a datasheet, and it must not depend on a vendor CDN to review a
 * board someone just dropped on it - so the circuit pack here carries no
 * RESEARCHED FACTS section. Everything else is built from the same sections in
 * the same order, and `tests/checks_parity.mjs` holds the two together.
 */

import {
  componentsSection,
  copperSection,
  decouplingSection,
  netsSection,
} from "./distill.js";

export const PACK_VERSION = "1";

/** Rules whose findings belong to the physical reviewer rather than the circuit one. */
const GEOMETRY_RULES = new Set([
  "net-island",
  "dfm-annular-ring",
  "dfm-drill-size",
  "dfm-track-width",
]);

function header(board) {
  return [
    `BOARD ${board.meta.name}`,
    `${board.components.length} components, ${board.nets.length} nets, ` +
      `${board.layout.footprints.length} footprints.`,
  ];
}

/**
 * What was already measured, so a reviewer does not spend its call repeating it.
 *
 * Written as findings that have been reported, never as a list of the kinds of
 * defect that exist: a reviewer handed a taxonomy fills it in, which is measured
 * behaviour rather than a worry.
 */
function findingsBlock(findings, title) {
  if (!findings.length) {
    return [
      title,
      "Nothing. No deterministic check failed in this area, which is not the " +
        "same as the area being correct.",
    ];
  }
  return [
    title,
    ...findings.map((f) => {
      const refs = (f.refs || []).join(", ") || "-";
      const nets = (f.nets || []).join(", ") || "-";
      return `- ${f.title} (refs ${refs}; nets ${nets})`;
    }),
  ];
}

const join = (blocks) =>
  blocks.filter((b) => b && b.length).map((b) => b.join("\n")).join("\n\n");

export function circuitPack(board, findings = []) {
  return join([
    header(board),
    componentsSection(board),
    netsSection(board),
    findingsBlock(findings, "ALREADY MEASURED  do not report these again"),
  ]);
}

export function physicalPack(board, findings = []) {
  return join([
    header(board),
    copperSection(board),
    decouplingSection(board),
    [
      "READING THIS",
      "Every number above is a measurement, not a verdict. A distance is only " +
        "a defect once you can say why it matters for that particular pin on " +
        "this particular rail.",
    ],
    findingsBlock(findings, "ALREADY MEASURED  do not report these again"),
  ]);
}

/** Every pack for this board, keyed by the reviewer that receives it. */
export function buildPacks(board, deterministic = []) {
  const geometry = deterministic.filter((f) => GEOMETRY_RULES.has(f.rule));
  const circuit = deterministic.filter((f) => !GEOMETRY_RULES.has(f.rule));
  return {
    circuit: circuitPack(board, circuit),
    physical: physicalPack(board, geometry),
  };
}

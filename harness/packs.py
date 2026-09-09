"""Evidence Packs: the only thing a language model is ever shown.

THE BOUNDARY

Everything upstream of here is deterministic - extraction, research, geometry,
evaluators. Everything downstream is a model reasoning in prose. This module is
the seam, and it is narrow on purpose: a specialist receives its pack and
nothing else, so what a model can possibly say is bounded by what was put in
front of it.

That matters more than it sounds. Two measurements from this repository:
offering one defect category for a quantity the board did not carry produced
twelve fabricated findings on a clean board out of thirty-six, and once
board-specific hints were removed three quarters of everything the reviewers
said collapsed into the two categories that could always be satisfied. Both are
failures of *input*, not of reasoning. The narrower and more honest the pack,
the less there is to invent from.

WHAT A PACK CONTAINS

Measurements, and findings that were already computed from them. Never a raw
KiCad object, never a whole datasheet, never a defect taxonomy, and never a
quantity the board does not carry. A pack is reproducible: the same board and
the same research produce the same bytes, which is what makes a scored run
repeatable and what lets `state.packs` stand as the record of what was asked.

WHY TWO PACKS RATHER THAN ONE

The old pipeline sent the whole distilled board to all three reviewers, so every
reviewer could and did report on every subject - the same defect arriving three
times in three wordings, and each reviewer free to speculate about a domain it
had no measurements for. Splitting the pack splits the responsibility: the
circuit reviewer has no geometry to speculate about and the physical reviewer
has no pin semantics to duplicate. It also roughly halves each prompt.
"""

from __future__ import annotations

from harness.distill import (
    _components_section,
    _copper_section,
    _decoupling_section,
    _nets_section,
)

#: Bumped whenever the shape of a pack changes, so a stored result says which
#: pack format produced it. Reproducibility needs this the way a score needs a
#: prompt hash.
PACK_VERSION = "1"


def _header(board: dict, agent: str) -> list[str]:
    meta = board["meta"]
    return [
        f"BOARD {meta['name']}",
        f"{len(board['components'])} components, {len(board['nets'])} nets, "
        f"{len(board['layout']['footprints'])} footprints.",
    ]


def _findings_block(findings: list[dict], title: str) -> list[str]:
    """Deterministic findings, so a reviewer does not spend its call on them.

    Stated as measurements that have already been reported rather than as a list
    of the kinds of defect that exist - a reviewer given a taxonomy fills it in.
    """
    if not findings:
        return [
            title,
            "Nothing. No deterministic check failed in this area, which is not "
            "the same as the area being correct.",
        ]
    lines = [title]
    for item in findings:
        refs = ", ".join(item.get("refs") or []) or "-"
        nets = ", ".join(item.get("nets") or []) or "-"
        lines.append(f"- {item['title']} (refs {refs}; nets {nets})")
    return lines


def _research_block(research: dict) -> list[str]:
    """Researched facts, as sentences from the document, never the document.

    Only facts that were actually extracted appear. A part whose datasheet could
    not be read is listed as unavailable, because "we do not know" is a fact the
    reviewer needs and an absence it would otherwise fill in.
    """
    if not research:
        return []
    lines = ["RESEARCHED FACTS  from the parts' own datasheets"]
    for ref, record in sorted(research.items()):
        part = record.get("part", ref)
        facts = record.get("facts") or {}
        if not facts:
            lines.append(f"{ref} ({part}): datasheet not readable; no facts established")
            continue
        for name, fact in sorted(facts.items()):
            quote = " ".join(str(fact.get("quote", "")).split())[:150]
            lines.append(f"{ref} ({part}) {name} = {fact['value']}")
            lines.append(f'    datasheet says: "{quote}"')
    return lines


def circuit_pack(board: dict, research: dict, findings: list[dict]) -> str:
    """What the circuit reviewer sees: parts, nets, pin meaning, researched facts.

    No geometry. Not because geometry is secret, but because a reviewer asked
    about copper it cannot measure will speculate about copper, and there is a
    second reviewer whose whole job is the copper it can measure.
    """
    blocks = [
        _header(board, "circuit"),
        _components_section(board),
        _nets_section(board),
        _research_block(research),
        _findings_block(findings, "ALREADY MEASURED  do not report these again"),
    ]
    return "\n\n".join("\n".join(b) for b in blocks if b)


def physical_pack(board: dict, findings: list[dict]) -> str:
    """What the physical reviewer sees: copper, placement, distances.

    No pin functions and no part descriptions. The measurements here are facts;
    turning one into a defect is the reviewer's job and needs saying, because a
    distance is not a verdict.
    """
    blocks = [
        _header(board, "physical"),
        _copper_section(board),
        _decoupling_section(board),
        [
            "READING THIS",
            "Every number above is a measurement, not a verdict. A distance is "
            "only a defect once you can say why it matters for that particular "
            "pin on this particular rail.",
        ],
        _findings_block(findings, "ALREADY MEASURED  do not report these again"),
    ]
    return "\n\n".join("\n".join(b) for b in blocks if b)


#: Which deterministic findings belong in which pack. A finding is shown to the
#: reviewer whose domain it falls in, so that reviewer does not repeat it.
GEOMETRY_RULES = {
    "net-island",
    "dfm-annular-ring",
    "dfm-drill-size",
    "dfm-track-width",
}


def _inputs_block(inputs: dict, keys: tuple[str, ...]) -> list[str]:
    """The supplied figures a gated reviewer is allowed to reason from.

    Only what it needs, and labelled as supplied rather than measured, so a
    finding resting on one can say so.
    """
    lines = ["SUPPLIED INPUTS  given by hand, not measured from the board"]
    for key in keys:
        value = inputs.get(key)
        if value in (None, {}, []):
            continue
        lines.append(f"{key}: {value}")
    return lines if len(lines) > 1 else []


def thermal_pack(board: dict, research: dict, inputs: dict, findings: list[dict]) -> str:
    """Heat, and only for a board whose ambient and dissipation are known."""
    thermal_facts = {
        ref: rec
        for ref, rec in (research or {}).items()
        if (rec.get("facts") or {}).get("thermal")
    }
    blocks = [
        _header(board, "thermal"),
        _inputs_block(inputs, ("ambient_c", "max_junction_c", "dissipation_w", "copper_weight_oz")),
        _research_block(thermal_facts),
        _copper_section(board),
        _findings_block(findings, "COMPUTED  already calculated, with their inputs"),
    ]
    return "\n\n".join("\n".join(b) for b in blocks if b)


def si_pack(board: dict, inputs: dict, findings: list[dict]) -> str:
    """Signal integrity, and only where a stackup makes impedance meaningful."""
    blocks = [
        _header(board, "signal_integrity"),
        _inputs_block(inputs, ("stackup", "high_speed_nets", "copper_weight_oz")),
        _copper_section(board),
        _findings_block(findings, "ALREADY MEASURED  do not report these again"),
    ]
    return "\n\n".join("\n".join(b) for b in blocks if b)


def pi_pack(board: dict, inputs: dict, findings: list[dict]) -> str:
    """The power distribution network, given real currents."""
    blocks = [
        _header(board, "power_integrity"),
        _inputs_block(inputs, ("rails", "dissipation_w", "stackup", "copper_weight_oz")),
        _copper_section(board),
        _decoupling_section(board),
        _findings_block(findings, "COMPUTED  already calculated, with their inputs"),
    ]
    return "\n\n".join("\n".join(b) for b in blocks if b)


def build_packs(
    board: dict,
    research: dict | None = None,
    deterministic: list[dict] | None = None,
    inputs: dict | None = None,
) -> dict[str, str]:
    """Every pack this board has the inputs for, keyed by the agent.

    A gated pack is absent rather than empty. An absent pack is how the graph
    knows not to build that node at all, so a domain nobody can assess costs no
    call and appears in coverage as unassessed instead of as a clean section.
    """
    from harness.assumptions import enabled

    research = research or {}
    inputs = inputs or {}
    findings = deterministic or []
    geometry = [f for f in findings if f.get("rule") in GEOMETRY_RULES]
    circuit = [f for f in findings if f.get("rule") not in GEOMETRY_RULES]

    packs = {
        "circuit": circuit_pack(board, research, circuit),
        "physical": physical_pack(board, geometry),
    }
    gates = enabled(inputs, research)
    if not gates["thermal"]:
        packs["thermal"] = thermal_pack(board, research, inputs, findings)
    if not gates["signal_integrity"]:
        packs["signal_integrity"] = si_pack(board, inputs, findings)
    if not gates["power_integrity"]:
        packs["power_integrity"] = pi_pack(board, inputs, findings)
    return packs

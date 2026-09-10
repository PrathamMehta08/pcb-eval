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


def _checks_block(title: str, covered: tuple[str, ...] = ()) -> list[str]:
    """The division of labour, written the same way on every board.

    A reviewer should not spend its call on what arithmetic already settles, so
    it has to be told what the deterministic layer covers. The question is how
    to say that without saying anything about *this* board.

    Naming the checks that fired does say something about this board. The first
    version of this block listed each finding with its refs and nets - on a
    seeded board, the planted defect, which is exactly what the grader matches.
    That was fixed to name only the checks, and that is still not enough: a
    corpus board carries one seeded defect, so "net-island fired" is very nearly
    "the defect is a split net". A reviewer given that hunts around the split
    copper and turns up its neighbours, and those neighbours score as
    independent discoveries. The measurement is contaminated either way.

    So the block names every check that runs, on every board, whether or not it
    fired. It is a constant. A constant cannot carry information about which
    board it is attached to, which is a guarantee rather than a judgement about
    how much a hint is worth - and `tests.run` asserts it by comparing the block
    across the whole corpus byte for byte.

    The cost is that a reviewer may re-report something a rule already found.
    That costs a few tokens and the aggregator merges it on (subject, claim),
    preferring the deterministic finding. A cheap duplicate is worth more than
    an expensive hint.
    """
    from harness.evaluate import EVALUATORS, NEEDS_INPUTS

    names = sorted(set(EVALUATORS.values()) | set(NEEDS_INPUTS))
    if covered:
        names = sorted(set(names) & set(covered))
    return [
        title,
        "These are computed from the board itself, on every board, and whatever "
        "they find is already in the report. Nothing here says what was found "
        "on this one. Spend your answer on what measurement cannot settle:",
        *(f"- {name}" for name in names),
    ]


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


def circuit_pack(board: dict, research: dict) -> str:
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
        _checks_block("HANDLED BY MEASUREMENT  do not spend your answer here", CIRCUIT_RULES),
    ]
    return "\n\n".join("\n".join(b) for b in blocks if b)


def physical_pack(board: dict) -> str:
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
        _checks_block("HANDLED BY MEASUREMENT  do not spend your answer here", GEOMETRY_RULES),
    ]
    return "\n\n".join("\n".join(b) for b in blocks if b)


#: Which checks each pack declares as already handled. These are catalogues of
#: what runs, not lists of what fired, so they are the same on every board.
THERMAL_RULES = ("junction_temp",)

GEOMETRY_RULES = (
    "net-island",
    "dfm-annular-ring",
    "dfm-drill-size",
    "dfm-track-width",
)


def _circuit_rules() -> tuple[str, ...]:
    """Everything measured that is not geometry and not heat."""
    from harness.evaluate import EVALUATORS, NEEDS_INPUTS

    every = set(EVALUATORS.values()) | set(NEEDS_INPUTS)
    return tuple(sorted(every - set(GEOMETRY_RULES) - set(THERMAL_RULES)))


CIRCUIT_RULES = _circuit_rules()


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


def thermal_pack(board: dict, research: dict, inputs: dict) -> str:
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
        _checks_block("HANDLED BY MEASUREMENT  do not spend your answer here", THERMAL_RULES),
    ]
    return "\n\n".join("\n".join(b) for b in blocks if b)


def si_pack(board: dict, inputs: dict) -> str:
    """Signal integrity, and only where a stackup makes impedance meaningful."""
    blocks = [
        _header(board, "signal_integrity"),
        _inputs_block(inputs, ("stackup", "high_speed_nets", "copper_weight_oz")),
        _copper_section(board),
        _checks_block("HANDLED BY MEASUREMENT  do not spend your answer here", GEOMETRY_RULES),
    ]
    return "\n\n".join("\n".join(b) for b in blocks if b)


def pi_pack(board: dict, inputs: dict) -> str:
    """The power distribution network, given real currents."""
    blocks = [
        _header(board, "power_integrity"),
        _inputs_block(inputs, ("rails", "dissipation_w", "stackup", "copper_weight_oz")),
        _copper_section(board),
        _decoupling_section(board),
        _checks_block("HANDLED BY MEASUREMENT  do not spend your answer here", GEOMETRY_RULES),
    ]
    return "\n\n".join("\n".join(b) for b in blocks if b)


def build_packs(
    board: dict,
    research: dict | None = None,
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

    packs = {
        "circuit": circuit_pack(board, research),
        "physical": physical_pack(board),
    }
    gates = enabled(inputs, research)
    if not gates["thermal"]:
        packs["thermal"] = thermal_pack(board, research, inputs)
    if not gates["signal_integrity"]:
        packs["signal_integrity"] = si_pack(board, inputs)
    if not gates["power_integrity"]:
        packs["power_integrity"] = pi_pack(board, inputs)
    return packs


def reviewer_pack(
    board: dict, research: dict | None = None, documentation: str = ""
) -> str:
    """V7's one pack: the distilled board, and nothing added to it.

    It carried the catalogue of deterministic checks at first, with a note not
    to spend the answer on what they cover. That cost five points of recall. The
    reviewer read "these are handled" as covering whole categories rather than
    the individual checks named, and stopped reporting a swapped regulator and
    an oversized companion capacitor - neither of which any rule had fired on.
    The duplicate findings it saved were worth far less than the defects it
    stopped looking for, and duplicates are cheap to merge afterwards anyway.

    So the pack is the distilled board, which is what `baseline.single_prompt`
    is given. The two reviewers now see the same bytes and are asked the same
    question, and every difference between the detectors is the architecture
    around the call. It also removes the last thing in the pack that a seeded
    corpus could have been leaked through, since a board's own description is
    all that is left.

    WHY IT CAN NOW CARRY DOCUMENTATION, WHEN IT COULD NOT BEFORE

    `documentation` is the one thing that may be appended, and only because the
    page had it all along and the harness did not - which meant the page's pack
    was unmeasurable. The browser attaches a datasheet to a part, retrieves
    passages from it and puts them in front of the reviewer; the sweep runs
    offline with nothing attached, so five trials said nothing whatever about
    the pack a visitor with datasheets actually gets. A path the eval cannot see
    is a path nobody can defend, and this one turned out to need defending: the
    section had no ceiling, and three documented parts left the board at 21% of
    its own pack.

    The block is built by `site/rag.js`, not rebuilt here. There are already
    four things written twice in this repository and each one costs a parity
    test; retrieval is not becoming the fifth. The browser is the only place a
    document is ever attached, so it stays the only place retrieval lives, and
    the benchmark hands its output across rather than reimplementing it.

    Empty by default, which is every scored sweep in the README.
    """
    from harness.distill import distill

    described = distill(board)
    if not documentation:
        return described
    return "\n\n".join([described, documentation])

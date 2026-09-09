"""The deterministic evaluation layer, and the record of what it could not do.

Every evaluator here answers a question exactly or declines to answer it. The
declining is the part worth building carefully: a check that quietly does not
run looks identical, in a report, to a check that ran and passed. So an
evaluator that lacks an input returns `skipped` with the reason, `coverage`
carries that reason to the report, and the scoring refuses to let a skipped
check improve a score.

WHAT BELONGS HERE

Anything computable. A union-find settles whether copper is connected; a
subtraction settles an annular ring; a comparison against a datasheet number
settles whether a rail is inside a part's input range. None of that is a
judgement and none of it should reach a model.

WHAT DOES NOT

`decoupling_distance` is the instructive one. It measures, and it never returns
a finding. "17.2 mm" is a fact; "17.2 mm is too far" depends on the rail, the
load and the package, and is exactly the kind of judgement an evaluator would
get wrong in both directions. Emitting it as a finding is what once let a single
always-satisfiable category absorb a quarter of everything the reviewers said.
The measurement goes in the physical pack and a reviewer argues for it or does
not.

`junction_temp` is the other kind. It is computable - Tj = Ta + P x theta_JA -
and the arithmetic is trivial, but the board carries no load current and no
ambient. It is skipped rather than estimated, because a fabricated input
produces a real-looking number that nothing downstream can tell from a measured
one.
"""

from __future__ import annotations

from harness.checks import run_checks
from harness.datasheet_checks import run_datasheet_checks
from harness.dfm import run_dfm

#: Every evaluator, and which layer owns it. The names are the ones the
#: architecture specifies; several map onto rules that already existed under a
#: different name, and the mapping is stated here rather than by renaming code
#: whose behaviour the fixtures pin.
EVALUATORS = {
    "net_islands": "net-island",
    "pin_name_vs_net": "power-pin-miswired",
    "supply_on_signal": "power-pin-on-signal-net",
    "held_at_reset": "floating-driver-input",
    "value_orderable": "value-not-orderable",
    "connector_reference": "connector-no-reference",
    "connector_power_order": "connector-power-order",
    "sensor_pinout_order": "sensor-pinout-order",
    "required_external_part": "datasheet-bootstrap-cap",
    "annular_ring": "dfm-annular-ring",
    "drill_size": "dfm-drill-size",
    "track_width_min": "dfm-track-width",
}

#: Evaluators that need something the board does not carry. Each states the
#: input it wants, so `coverage` can say why it did not run.
NEEDS_INPUTS = {
    "rail_within_input_range": ("rail voltages", "a nominal voltage for each rail"),
    "junction_temp": (
        "load current and ambient",
        "a load current or dissipation per part, and an ambient temperature",
    ),
}


def rail_within_input_range(board: dict, research: dict, inputs: dict | None) -> tuple[list, str]:
    """Is each part's supply rail inside the input range its datasheet gives?

    Needs two things that come from different places: the datasheet's min and
    max, which research supplies, and the rail's actual voltage, which nothing
    in a KiCad project states. A net called `+3.3V` is a naming convention, not
    a measurement, and treating it as one would be the same guess this layer
    exists to refuse.
    """
    rails = (inputs or {}).get("rails") or {}
    if not rails:
        return [], "no rail voltages supplied"

    out = []
    for ref, record in sorted(research.items()):
        fact = (record.get("facts") or {}).get("vin_range_v")
        if not fact:
            continue
        low, high = fact["value"]["min"], fact["value"]["max"]
        for net in board["nets"]:
            if not any(n["ref"] == ref for n in net["nodes"]):
                continue
            volts = rails.get(net["name"]) or rails.get(net["name"].lstrip("/"))
            if volts is None:
                continue
            if low <= volts <= high:
                continue
            out.append(
                {
                    "rule": "rail_within_input_range",
                    "severity": "critical",
                    "refs": [ref],
                    "nets": [net["name"]],
                    "title": (
                        f"{ref} sits on {net['name']} at {volts} V, outside its "
                        f"{low}-{high} V input range"
                    ),
                    "why": (
                        f"The {record.get('part', ref)} datasheet gives a recommended "
                        f"input range of {low} V to {high} V. Outside it the part is "
                        "not specified to work, and above it may not survive."
                    ),
                    "fix": f"Bring {net['name']} inside {low}-{high} V, or choose a part rated for it.",
                    "evidence": fact.get("quote", ""),
                }
            )
    return out, ""


def junction_temp(board: dict, research: dict, inputs: dict | None) -> tuple[list, str]:
    """Tj = Ta + P x theta_JA, when all three inputs exist. Never estimated."""
    inputs = inputs or {}
    ambient = inputs.get("ambient_c")
    loads = inputs.get("dissipation_w") or {}
    if ambient is None:
        return [], "no ambient temperature supplied"
    if not loads:
        return [], "no load current or dissipation supplied"

    # Having ambient and a dissipation is not enough: the thermal resistance
    # comes from a datasheet, and reporting "ran" when no part has one would
    # read as "checked and fine" for a check that had nothing to compute with.
    with_theta = {
        ref: ((research.get(ref) or {}).get("facts") or {}).get("thermal")
        for ref in loads
    }
    if not any(with_theta.values()):
        return [], "no junction-to-ambient resistance in the researched facts"

    out = []
    for ref, watts in sorted(loads.items()):
        fact = with_theta.get(ref)
        if not fact:
            continue
        theta = fact["value"].get("theta_ja_c_per_w")
        if theta is None:
            continue
        tj = ambient + watts * theta
        limit = inputs.get("max_junction_c", 125.0)
        if tj <= limit:
            continue
        out.append(
            {
                "rule": "junction_temp",
                "severity": "critical" if tj > limit + 20 else "major",
                "refs": [ref],
                "nets": [],
                "title": f"{ref} runs at an estimated {tj:.0f} C junction temperature",
                "why": (
                    f"{watts} W through a junction-to-ambient resistance of {theta} C/W "
                    f"from {ambient} C ambient. The limit taken here is {limit} C."
                ),
                "fix": f"Reduce dissipation, improve the thermal path, or accept a derated life.",
                "evidence": fact.get("quote", ""),
            }
        )
    return out, ""


GATED = {
    "rail_within_input_range": rail_within_input_range,
    "junction_temp": junction_temp,
}


def evaluate(board: dict, research: dict | None = None, inputs: dict | None = None) -> dict:
    """Every deterministic finding, plus what did not run and why.

    Returns `findings`, `measurements` (things reported but never a defect) and
    `coverage`: one line per evaluator saying `ran` or `skipped: reason`. The
    report prints coverage beside the score, because a domain that was not
    assessed is not a domain that passed.
    """
    research = research or {}
    findings: list[dict] = []
    coverage: dict[str, str] = {}

    # Two kinds, and the difference is what the gate does with them.
    #
    # A rule finding is a defect the reviewers were also supposed to notice, so
    # one still outstanding is a reason to send them round again. A DFM or
    # datasheet finding is complete as it stands - the geometry or the datasheet
    # has already settled it - and looping a model over it would spend calls to
    # be told what arithmetic said.
    chaseable = run_checks(board)
    complete = run_dfm(board) + run_datasheet_checks(board, research)
    fired = {f["rule"] for f in chaseable + complete}
    findings.extend(chaseable)
    for name, rule_id in EVALUATORS.items():
        coverage[name] = "ran" + (" (fired)" if rule_id in fired else "")

    for name, fn in GATED.items():
        found, skipped = fn(board, research, inputs)
        if skipped:
            coverage[name] = f"skipped: {skipped}"
            continue
        coverage[name] = "ran" + (" (fired)" if found else "")
        # Gated evaluators are complete too: nothing a reviewer says changes
        # whether a rail is inside a datasheet range.
        complete.extend(found)

    # Measured, never a finding. It goes into the physical pack as a number and
    # a reviewer has to argue for it.
    coverage["decoupling_distance"] = "measured, reported as evidence rather than as a finding"

    return {
        "findings": findings,
        "measured": complete,
        "coverage": coverage,
    }


def unassessed(coverage: dict[str, str]) -> dict[str, str]:
    """Only the checks that did not run, for the report's coverage section."""
    return {
        name: reason.split("skipped: ", 1)[1]
        for name, reason in sorted(coverage.items())
        if reason.startswith("skipped:")
    }

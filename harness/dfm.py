"""Manufacturability checks, against fab limits, with no model involved.

The fourth evaluator. It is deterministic for the same reason the other rules
are: an annular ring is `(pad - drill) / 2`, and a number either clears the fab's
minimum or it does not. There is no judgement here for a model to add, and
asking one would only introduce the chance of a wrong answer.

WHAT THIS CAN AND CANNOT SCORE

Nothing in the seeded corpus is a DFM defect - the seven presets break
connectivity, pin order, values and copper, not geometry. So these rules cannot
raise recall on the current eval and are not scored by it. They are here because
the board data already carries everything they need, and because a review that
never mentions manufacturability is not a review an engineer would accept.

They also stay out of the gate. The gate loops when a rule found something the
reviewers did not account for, which is a statement about the model missing
something. A DFM finding is already complete, and looping the model over it
would spend calls to be told what geometry already said.

THE TRAP THIS RULE ALREADY FELL INTO

The first version flagged six pads on the board as manufactured. All six were
`np_thru_hole`: four mounting holes and two switch alignment pegs, where the pad
is the same size as the hole by definition because there is no copper to ring
it. Plated holes only - which is the rule CLAUDE.md states for this file, and it
caught this one on the first run.
"""

from __future__ import annotations

#: Limits for a typical low-cost two-layer process (JLCPCB-class). Conservative
#: on purpose: a rule that fires on a board a real fab would happily build is
#: worse than no rule, because it teaches the reader to ignore this section.
MIN_ANNULAR_RING_MM = 0.13
MIN_PLATED_DRILL_MM = 0.30
MIN_TRACK_WIDTH_MM = 0.127

#: Holes with no plating: mounting holes, alignment pegs, tooling. The pad and
#: the drill are the same size by design, so annular ring does not apply.
UNPLATED = "np_thru_hole"


def _finding(rule: str, title: str, why: str, fix: str, refs=(), nets=(), severity="major") -> dict:
    return {
        "rule": rule,
        "source": "dfm",
        "severity": severity,
        "refs": list(refs),
        "nets": list(nets),
        "title": title,
        "why": why,
        "fix": fix,
        "claim": "manufacturability",
        "subject": (list(refs) or list(nets) or [""])[0],
        "evidence": "",
    }


def check_annular_ring(board: dict) -> list[dict]:
    """A plated hole needs copper left around it after the drill wanders."""
    out = []
    for fp in board["layout"]["footprints"]:
        for pad in fp["pads"]:
            drill = pad.get("drill") or 0
            if not drill or pad.get("kind") == UNPLATED:
                continue
            ring = (min(pad["w"], pad["h"]) - drill) / 2
            if ring < MIN_ANNULAR_RING_MM:
                out.append(
                    _finding(
                        "dfm-annular-ring",
                        f"{fp['ref']} pad {pad['num']} has a {ring:.3f} mm annular ring",
                        f"Below the {MIN_ANNULAR_RING_MM} mm a low-cost two-layer process "
                        "holds, so drill wander can break the pad away from its barrel.",
                        f"Grow the pad to at least {drill + 2 * MIN_ANNULAR_RING_MM:.2f} mm "
                        "across, or shrink the drill.",
                        refs=[fp["ref"]],
                        nets=[pad["net"]] if pad.get("net") else [],
                    )
                )
    return out


def check_drill_size(board: dict) -> list[dict]:
    """Plated holes below the fab's smallest drill."""
    out = []
    for fp in board["layout"]["footprints"]:
        for pad in fp["pads"]:
            drill = pad.get("drill") or 0
            if not drill or pad.get("kind") == UNPLATED:
                continue
            if drill < MIN_PLATED_DRILL_MM:
                out.append(
                    _finding(
                        "dfm-drill-size",
                        f"{fp['ref']} pad {pad['num']} drills {drill:.2f} mm",
                        f"Smaller than the {MIN_PLATED_DRILL_MM} mm minimum plated drill, "
                        "which pushes the board to a more expensive process.",
                        f"Open the hole to {MIN_PLATED_DRILL_MM} mm.",
                        refs=[fp["ref"]],
                    )
                )
    for via in board["layout"]["vias"]:
        if via["drill"] < MIN_PLATED_DRILL_MM:
            out.append(
                _finding(
                    "dfm-drill-size",
                    f"A via on {via['net']} drills {via['drill']:.2f} mm",
                    f"Smaller than the {MIN_PLATED_DRILL_MM} mm minimum plated drill.",
                    f"Open the via drill to {MIN_PLATED_DRILL_MM} mm.",
                    nets=[via["net"]] if via.get("net") else [],
                    severity="minor",
                )
            )
    return out


def check_track_width(board: dict) -> list[dict]:
    """Tracks below what the process can etch reliably."""
    thin = [t for t in board["layout"]["tracks"] if t["width"] < MIN_TRACK_WIDTH_MM]
    if not thin:
        return []
    nets = sorted({t["net"] for t in thin if t.get("net")})
    return [
        _finding(
            "dfm-track-width",
            f"{len(thin)} track segments are narrower than {MIN_TRACK_WIDTH_MM} mm",
            "Below the minimum trace width the process can etch, so the copper "
            "may come out thin or open.",
            f"Widen them to at least {MIN_TRACK_WIDTH_MM} mm.",
            nets=nets[:4],
        )
    ]


DFM_RULES = (check_annular_ring, check_drill_size, check_track_width)


def run_dfm(board: dict) -> list[dict]:
    """Every manufacturability finding, in the order the rules are declared."""
    out = []
    for check in DFM_RULES:
        out.extend(check(board))
    return out

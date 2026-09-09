"""The last node, and the only one that assigns a number. No model involved.

Scoring is where a report stops describing a board and starts judging it, so it
is the last place an opinion could sneak in wearing arithmetic's clothes. It
does not: `harness/report.py` merges on identity, ranks by severity then
confidence then whether a measurement backs it, and weights only what can be
verified.

The property worth stating is the one that is easiest to lose. A skipped check
must never improve a score - if an unassessed domain is simply absent, the board
looks better than one whose domain was assessed and passed. So coverage travels
here and is printed beside the number.
"""

from __future__ import annotations

from graph.state import ReviewState
from harness.report import build


def aggregate(state: ReviewState) -> dict:
    """Merge, rank, score. Everything it needs has already been decided."""
    findings = list(state.get("verified") or [])
    # Measured findings never went to a model, so they never reached the critic.
    # They belong in the report on their own evidence.
    findings += list(state.get("measured") or [])
    return {"report": build(findings, state.get("coverage") or {})}

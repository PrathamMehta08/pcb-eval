"""One prompt, one call, the whole review. The thing the graph is measured against.

This is deliberately not a straw man. It gets the same distilled board, the same
output schema, the same model and the same temperature; the only difference is
that one call is asked to do all three jobs at once instead of three calls doing
one each. If decomposition buys nothing, this is what the README should say.
"""

from __future__ import annotations

from graph.prompts import SYSTEM, single_prompt
from graph.state import normalise
from harness.distill import distill


def review_once(board: dict, client) -> dict:
    distilled = distill(board)
    parsed, info = client.json(single_prompt(distilled), label="single", system=SYSTEM)
    findings = normalise(parsed.get("findings"), "single")
    return {
        "findings": findings,
        "confirmed": findings,  # no adjudication stage; the answer is the answer
        "dropped": [],
        "deterministic": [],
        "passes": 1,
        "stopped": "stop:single-call",
        "calls": [{**info, "node": "single", "found": len(findings)}],
        "distilled": distilled,
    }

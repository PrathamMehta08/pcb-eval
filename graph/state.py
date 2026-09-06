"""The state the review graph carries, and the finding shape everything speaks."""

from __future__ import annotations

import re
from typing import TypedDict

_DESIGNATOR = re.compile(r"^[A-Za-z]{1,3}\d+$")
#: A node, not a net: `C4.2`, `U2.1(VBAT,pwr-in)`, `S1.5(EN,in)`.
_NODE = re.compile(r"^([A-Za-z]{1,3}\d+)\.[A-Za-z0-9_]+")


class ReviewState(TypedDict, total=False):
    board: dict
    #: The distilled board. Computed once in `ingest`; every node sends it whole,
    #: because the model has no memory between nodes.
    distilled: str
    #: What the deterministic rules measured. Never produced by a model.
    deterministic: list[dict]
    #: Everything every LLM node has proposed, across every pass.
    findings: list[dict]
    #: What survived adjudication: deduped, and with contradictions removed.
    confirmed: list[dict]
    #: What adjudication threw out, each with the measurement that refuted it.
    dropped: list[dict]
    passes: int
    #: One row per model call, for the cost log.
    calls: list[dict]
    #: Why the gate stopped, so a result can be read six months later.
    stopped: str


def tidy(refs, nets) -> tuple[list[str], list[str]]:
    """Sort the model's refs and nets into refs and nets.

    Reviewers write `D2.2` when they mean pin 2 of D2, and put whole node
    strings like `U2.1(VBAT,pwr-in)` in the nets list. Taken literally, both
    look like a part or a net that does not exist — which is exactly what the
    adjudicator's contradiction check is for, so without this it throws out
    correct findings for a formatting habit. Twenty of them, in the first
    scored sweep.
    """
    out_refs: list[str] = []
    out_nets: list[str] = []

    def add_ref(value: str) -> None:
        value = value.strip()
        node = _NODE.match(value)
        if node:
            value = node.group(1)
        value = value.split("(")[0].strip()
        if _DESIGNATOR.match(value) and value not in out_refs:
            out_refs.append(value)

    for raw in refs or []:
        add_ref(str(raw))
    for raw in nets or []:
        value = str(raw).strip().rstrip(",")
        # A net name can legitimately contain brackets — `unconnected-(J12-Pad3)`
        # is one — so nothing is stripped here beyond whitespace.
        if _NODE.match(value) or _DESIGNATOR.match(value):
            add_ref(value)
            continue
        if value and value not in out_nets:
            out_nets.append(value)
    return out_refs, out_nets


def finding(
    source: str,
    title: str,
    why: str = "",
    refs: list[str] | None = None,
    nets: list[str] | None = None,
    severity: str = "major",
) -> dict:
    clean_refs, clean_nets = tidy(refs, nets)
    return {
        "source": source,
        "severity": severity if severity in ("critical", "major", "minor") else "major",
        "refs": clean_refs,
        "nets": clean_nets,
        "title": str(title).strip(),
        "why": str(why).strip(),
    }


def normalise(items, source: str) -> list[dict]:
    """Coerce whatever a model returned into the finding shape, dropping junk."""
    out = []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title", "")).strip()
        if not title:
            continue
        out.append(
            finding(
                source,
                title,
                item.get("why", ""),
                [r for r in item.get("refs", []) or [] if isinstance(r, (str, int))],
                [n for n in item.get("nets", []) or [] if isinstance(n, (str, int))],
                str(item.get("severity", "major")).lower(),
            )
        )
    return out


def key(item: dict) -> frozenset:
    """What two findings must share to be the same finding: refs and nets."""
    return frozenset(
        [f"r:{r.upper()}" for r in item.get("refs", [])]
        + [f"n:{n.upper().lstrip('/')}" for n in item.get("nets", [])]
    )

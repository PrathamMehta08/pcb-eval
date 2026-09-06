"""The state the review graph carries, and the finding shape everything speaks."""

from __future__ import annotations

from typing import TypedDict


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
    #: Parts a layout edit touched, so distil can include the geometry near them.
    focus_refs: list[str]
    passes: int
    #: One row per model call, for the cost log.
    calls: list[dict]
    #: Why the gate stopped, so a result can be read six months later.
    stopped: str


def finding(
    source: str,
    title: str,
    why: str = "",
    refs: list[str] | None = None,
    nets: list[str] | None = None,
    severity: str = "major",
) -> dict:
    return {
        "source": source,
        "severity": severity if severity in ("critical", "major", "minor") else "major",
        "refs": [str(r) for r in (refs or [])],
        "nets": [str(n) for n in (nets or [])],
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

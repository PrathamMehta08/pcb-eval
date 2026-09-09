"""The state the review graph carries, and the finding shape everything speaks."""

from __future__ import annotations

import operator
import re
from typing import Annotated, TypedDict

_DESIGNATOR = re.compile(r"^[A-Za-z]{1,3}\d+$")
#: A node, not a net: `C4.2`, `U2.1(VBAT,pwr-in)`, `S1.5(EN,in)`.
_NODE = re.compile(r"^([A-Za-z]{1,3}\d+)\.[A-Za-z0-9_]+")


class ReviewState(TypedDict, total=False):
    board: dict
    #: The distilled board. Still computed for the deterministic layer and for
    #: the record; it is no longer what a reviewer is shown.
    distilled: str
    #: The evidence packs, keyed by the agent each belongs to. This is the only
    #: board information any language model receives, and it is kept in state so
    #: a scored run records exactly what was asked of each model.
    packs: dict
    #: What the deterministic rules measured. Never produced by a model.
    deterministic: list[dict]
    #: Findings the deterministic layer settled outright - manufacturability,
    #: datasheet requirements, gated checks. Reported, never chased: the gate
    #: sends the reviewers round again for rules they missed, and there is
    #: nothing for them to add to a number.
    measured: list[dict]
    #: The specialists that actually ran, decided before the graph was built.
    enabled_agents: list
    #: Which evaluators ran, and why each of the rest did not. First-class
    #: because a skipped check and a passing check look identical in a report
    #: unless one of them says so.
    coverage: dict
    #: Inputs a KiCad project cannot supply - rail voltages, load currents,
    #: ambient, stackup. Absent by default, which is why the checks that need
    #: them are skipped rather than estimated.
    inputs: dict
    #: What the reviewers proposed, appended to as each one finishes.
    #:
    #: Annotated because the reviewers run in parallel and LangGraph refuses two
    #: concurrent writes to a plain channel. It is a separate channel from
    #: `findings` on purpose: `findings` is what adjudication *replaces* with
    #: its deduped list, and a reducer there would append the deduped copy to
    #: the originals instead of standing in for them.
    proposed: Annotated[list[dict], operator.add]
    #: The deduped proposals. Written once per pass, by adjudication.
    findings: list[dict]
    #: What survived adjudication: deduped, and with contradictions removed.
    confirmed: list[dict]
    #: What adjudication threw out, each with the measurement that refuted it.
    dropped: list[dict]
    #: Findings that exist only in the interaction between two reviewers.
    cross_domain: list[dict]
    #: What survived both critics, with any severity the second one corrected.
    verified: list[dict]
    #: Everything any stage refused, with the reason. Kept rather than discarded
    #: because a list of rejections is the only way to tell a strict critic from
    #: a broken one.
    rejected: Annotated[list[dict], operator.add]
    passes: int
    #: One row per model call, for the cost log. Appended, for the same reason.
    calls: Annotated[list[dict], operator.add]
    #: Why the gate stopped, so a result can be read six months later.
    stopped: str
    #: One row per time the gate ran: the decision, and what it was based on.
    gates: list[dict]


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


def normalise_subject(value) -> str:
    """`S1.4` and `S1.6(VBST)` mean pin 4 and pin 6 of S1. The subject is S1.

    The same habit `tidy()` exists for, in a field that did not exist when it
    was written. Left literal, a subject of `S1.4` is a part that is not on the
    board, and the critic throws out the finding for a formatting convention -
    which is exactly how twenty correct findings were lost in the first scored
    sweep. It threw out a correctly identified defect the first time this
    field was wired up, which is why there is a test for it now.
    """
    text = str(value or "").strip()
    node = _NODE.match(text)
    if node:
        return node.group(1)
    # `S1(VBST)` and trailing punctuation, but never inside a net name like
    # `unconnected-(J12-Pad3)`, which is a real net and has to survive whole.
    if _DESIGNATOR.match(text.split("(")[0].strip()):
        return text.split("(")[0].strip()
    return text.rstrip(",")


def finding(
    source: str,
    title: str,
    why: str = "",
    refs: list[str] | None = None,
    nets: list[str] | None = None,
    severity: str = "major",
    fix: str = "",
    claim: str = "",
    subject: str = "",
    evidence: str = "",
) -> dict:
    clean_refs, clean_nets = tidy(refs, nets)
    return {
        "source": source,
        "severity": severity if severity in ("critical", "major", "minor") else "major",
        "refs": clean_refs,
        "nets": clean_nets,
        "title": str(title).strip(),
        "why": str(why).strip(),
        "fix": str(fix).strip(),
        # The typed fields. Empty for rule findings and for anything a model
        # returned without them, which `verify()` then holds to the old floor.
        "claim": str(claim).strip(),
        "subject": normalise_subject(subject),
        "evidence": str(evidence).strip(),
    }


def normalise(items, source: str) -> list[dict]:
    """Coerce whatever a model returned into the finding shape, dropping junk."""
    out = []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        # The schema calls it `problem`; older replies and the rule checks call
        # the same thing `title`.
        title = str(item.get("problem") or item.get("title") or "").strip()
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
                item.get("fix", ""),
                item.get("claim", ""),
                item.get("subject", ""),
                item.get("evidence", ""),
            )
        )
    return out


def key(item: dict) -> frozenset:
    """What two findings must share to be the same finding: refs and nets.

    This is the grading identity and the gate's identity, and it is frozen for
    the same reason `contradiction()` is: the sweep compares architectures, so
    the things doing the comparing cannot move underneath it.
    """
    return frozenset(
        [f"r:{r.upper()}" for r in item.get("refs", [])]
        + [f"n:{n.upper().lstrip('/')}" for n in item.get("nets", [])]
    )


def claim_key(item: dict) -> tuple[str, str] | None:
    """Typed identity: the same defect kind about the same thing.

    Two reviewers describing one defect used to collide only if their ref and
    net lists happened to intersect, so the same problem in different words
    survived as two findings. A kind plus a subject is the identity the schema
    was given for.
    """
    claim = str(item.get("claim") or "").strip().lower()
    subject = str(item.get("subject") or "").strip().upper().lstrip("/")
    if not claim or not subject or claim == "other":
        return None
    return (claim, subject)

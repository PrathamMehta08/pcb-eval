"""Aggregation, scoring and coverage. All of it arithmetic.

The score is the last place a number can be invented, and the easiest one to get
wrong in a way nobody notices: a report that deducts for everything a model said
punishes a board for the reviewer's enthusiasm, and a report that deducts only
for what it is sure of says nothing at all.

The arrangement here is that **only what can be verified scores**. A finding a
measurement confirms is worth its full weight. A finding a model argued for and
the critic accepted is worth half, and the half is capped at the confirmed total
so speculation can never outweigh measurement however much of it there is.
Anything resting on an assumption, or true but not actionable, is reported at
full length and weighted zero.

And a skipped check never improves a score. That sounds obvious and is the
easiest property to lose: if thermal is unassessed and simply absent from the
report, the board looks better than one whose thermal was assessed and passed.
So coverage is printed beside the score, and an unassessed domain is stated.
"""

from __future__ import annotations

from graph.state import key

#: What a confirmed finding costs, by severity.
WEIGHTS = {"critical": 10, "high": 5, "major": 5, "medium": 2, "low": 1, "minor": 1}

#: Ranking. Severity first, then confidence, then whether a measurement backs it.
_SEVERITY_ORDER = {"critical": 0, "high": 1, "major": 1, "medium": 2, "low": 3, "minor": 3,
                   "informational": 4}
_CONFIDENCE_ORDER = {"high": 0, "medium": 1, "low": 2}


def classify(item: dict) -> str:
    """Which of the four classes a finding falls into.

    The distinction that matters is not how sure the model sounded, but whether
    anything other than the model backs it.
    """
    if item.get("origin") == "deterministic" or item.get("rule"):
        return "confirmed_violation"
    if item.get("severity") == "informational" or item.get("verdict") == "downgrade":
        return "informational"
    if item.get("assumption") or item.get("confidence") in ("medium", "low"):
        return "engineering_concern"
    if item.get("status") == "risk":
        return "engineering_concern"
    return "probable_issue"


def merge(findings: list[dict]) -> list[dict]:
    """One finding per (subject, claim), keeping every source that reported it.

    Identity is the claim and what it is about, not the wording, so the same
    defect described by a measurement and by a reviewer becomes one entry that
    records both - and the measurement's evidence is what a reader is shown.
    """
    out: dict[tuple, dict] = {}
    order: list[tuple] = []
    for item in findings:
        subject = str(item.get("subject") or "").strip().upper().lstrip("/")
        if not subject:
            names = sorted(key(item))
            subject = names[0] if names else (item.get("title") or "")[:40].lower()
        ident = (str(item.get("claim") or item.get("rule") or "").lower(), subject)
        if ident not in out:
            out[ident] = {**item, "found_by": [item.get("source") or item.get("rule") or "?"]}
            order.append(ident)
            continue
        kept = out[ident]
        kept["found_by"].append(item.get("source") or item.get("rule") or "?")
        # A measured finding takes over the entry: its evidence is the reason to
        # believe the thing, and its severity was not a model's opinion.
        if item.get("rule") and not kept.get("rule"):
            out[ident] = {**item, "found_by": kept["found_by"]}
    return [out[i] for i in order]


def rank(findings: list[dict]) -> list[dict]:
    return sorted(
        findings,
        key=lambda f: (
            _SEVERITY_ORDER.get(str(f.get("severity", "major")).lower(), 2),
            _CONFIDENCE_ORDER.get(str(f.get("confidence", "high")).lower(), 1),
            0 if f.get("rule") else 1,
            str(f.get("title", "")),
        ),
    )


def score(findings: list[dict]) -> dict:
    """100 minus what the verifiable findings cost, and nothing else.

    Probable issues are halved and then capped at the confirmed total. Without
    the cap a reviewer having a productive day could sink a board no measurement
    objected to; with it, prose can at most double the damage that evidence
    already did.

    THE CAP'S EDGE, WHICH IS WORTH KNOWING BEFORE TRUSTING A SCORE

    `capped = min(probable, confirmed)` means a board no deterministic check
    fires on scores 100 however much the reviewers say about it. That is the
    specified rule read literally, and it is a coherent position - only what can
    be verified counts, and prose can at most double the damage evidence already
    did. It is also a strong one: on a board with no rule findings the entire
    language-model half of this system is worth nothing to the number.

    Whether that is right depends on what the score is for. As a regression
    metric it is exactly right, because it cannot be moved by a reviewer having
    a productive day. As advice to an engineer it understates: the findings are
    all still in the report, ranked and readable, and only the number ignores
    them. The alternative - a floor, so probable issues can deduct some fixed
    amount even with nothing confirmed - is one line here, and is not taken
    because it was not specified.
    """
    confirmed = concern = informational = 0
    probable = 0.0
    for item in findings:
        weight = WEIGHTS.get(str(item.get("severity", "major")).lower(), 1)
        kind = classify(item)
        if kind == "confirmed_violation":
            confirmed += weight
        elif kind == "probable_issue":
            probable += weight / 2
        elif kind == "engineering_concern":
            concern += 1
        else:
            informational += 1

    capped = min(probable, float(confirmed))
    deductions = confirmed + capped
    return {
        "score": max(0, round(100 - min(deductions, 100))),
        "confirmed": confirmed,
        "probable": round(probable, 1),
        "probable_capped_to": round(capped, 1),
        "engineering_concerns": concern,
        "informational": informational,
    }


def build(findings: list[dict], coverage: dict[str, str]) -> dict:
    """The whole report: findings merged and ranked, a score, and coverage."""
    merged = rank(merge(findings))
    for item in merged:
        item["class"] = classify(item)
    unassessed = {
        name: reason.split("skipped: ", 1)[-1]
        for name, reason in sorted((coverage or {}).items())
        if str(reason).startswith("skipped:")
    }
    return {
        "findings": merged,
        "score": score(merged),
        "coverage": coverage or {},
        "unassessed": unassessed,
    }


def render(report: dict) -> str:
    """The report as an engineer reads it, coverage included rather than implied."""
    s = report["score"]
    lines = [f"{s['score']}/100"]
    lines.append(
        f"  {s['confirmed']} from confirmed violations, {s['probable_capped_to']} from "
        f"probable issues (capped at {s['confirmed']})"
    )
    if s["engineering_concerns"] or s["informational"]:
        lines.append(
            f"  {s['engineering_concerns']} engineering concerns and "
            f"{s['informational']} observations, weighted zero"
        )

    by_class: dict[str, list] = {}
    for item in report["findings"]:
        by_class.setdefault(item["class"], []).append(item)
    for name in ("confirmed_violation", "probable_issue", "engineering_concern", "informational"):
        items = by_class.get(name)
        if not items:
            continue
        lines.append("")
        lines.append(f"{name.replace('_', ' ').upper()}  ({len(items)})")
        for item in items:
            found = "+".join(dict.fromkeys(item.get("found_by") or []))
            lines.append(f"  [{item.get('severity', '?'):<8}] {item.get('title', '')}  ({found})")

    if report["unassessed"]:
        lines.append("")
        lines.append("NOT ASSESSED  these were not checked, which is not the same as passing")
        for name, why in report["unassessed"].items():
            lines.append(f"  {name}: {why}")
    return "\n".join(lines)

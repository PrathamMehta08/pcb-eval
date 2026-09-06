"""Match findings to injected defects by overlap, never by wording.

A finding matches a defect when their component refs or their net names
intersect. Nothing here reads a sentence, because grading on wording would make
the score a measure of how the prompt phrases things.

Three outcomes, and the third is the one that keeps the other two honest:

- **caught** — a finding overlapped the defect;
- **missed** — nothing did;
- **other** — findings that matched no defect. On the clean board every finding
  is one of these, and that number is what decides whether the recall number
  means anything at all. A reviewer that flags everything catches every defect.

`site/review.js` grades the same way in the browser.
"""

from __future__ import annotations

import hashlib
import json


def norm(value: str) -> str:
    return str(value or "").strip().upper().lstrip("/")


def overlaps(finding: dict, defect: dict) -> bool:
    refs = {norm(r) for r in defect.get("refs", [])}
    nets = {norm(n) for n in defect.get("nets", [])}
    if not refs and not nets:
        return False
    return bool(
        refs & {norm(r) for r in finding.get("refs", [])}
        or nets & {norm(n) for n in finding.get("nets", [])}
    )


def grade(findings: list[dict], defects: list[dict]) -> dict:
    """One finding can only account for one defect, so a scattergun scores once."""
    claimed: set[int] = set()
    caught, missed = [], []
    for defect in defects:
        hit = next(
            (
                i
                for i, finding in enumerate(findings)
                if i not in claimed and overlaps(finding, defect)
            ),
            None,
        )
        if hit is None:
            missed.append(defect["id"])
        else:
            claimed.add(hit)
            caught.append({"defect": defect["id"], "finding": findings[hit]["title"]})
    other = [f["title"] for i, f in enumerate(findings) if i not in claimed]
    return {
        "caught": caught,
        "missed": missed,
        "other": other,
        "recall": round(len(caught) / len(defects), 3) if defects else None,
        "false_alarms": len(other),
    }


def totals(rows: list[dict]) -> dict:
    """The headline: recall over the seeded boards, false alarms on the clean one."""
    seeded = [r for r in rows if r["defects"]]
    clean = [r for r in rows if not r["defects"]]
    caught = sum(len(r["grade"]["caught"]) for r in seeded)
    total = sum(len(r["defects"]) for r in seeded)
    return {
        "boards": len(rows),
        "caught": caught,
        "of": total,
        "recall": round(caught / total, 3) if total else None,
        "false_alarms_on_clean": sum(r["grade"]["false_alarms"] for r in clean),
        "extra_findings_on_seeded": sum(r["grade"]["false_alarms"] for r in seeded),
    }


def corpus_hash(board_hashes: list[str]) -> str:
    """A score that outlives the corpus it measured is worse than no score."""
    return hashlib.sha256("|".join(sorted(board_hashes)).encode("utf-8")).hexdigest()[:12]


def schema_hash() -> str:
    """The finding shape plus the operation signatures the corpus was built from."""
    from graph.prompts import SCHEMA
    from harness.ops import OPS

    signature = {name: sorted(fn.__code__.co_varnames[1 : fn.__code__.co_argcount]) for name, fn in OPS.items()}
    blob = SCHEMA + json.dumps(signature, sort_keys=True)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:12]

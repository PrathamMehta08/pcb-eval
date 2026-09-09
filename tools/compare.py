"""Compare detectors on one corpus, splitting recall by what the rules cover.

    python tools/compare.py results/sweep-A.json results/sweep-B.json

WHY THE SPLIT

Four of the thirteen seeded defects are also caught by a deterministic rule, and
three of those are a rule and a generator written from the same condition -
`supply-on-signal` against `power-pin-on-signal-net`, `value-unorderable`
against `value-not-orderable`. Any system carrying those rules catches those
defects, and a recall number over all thirteen is partly a measurement of that
coincidence.

So recall is reported twice. `rule-silent` is over the defects no rule fires on,
and is what actually distinguishes one reviewer from another. `all` is over the
whole corpus, and is what the system delivers.

WHAT ELSE IS WORTH READING

A reviewer that reports everything catches every defect, so recall alone ranks a
scattergun first. The clean boards are the control: findings there are false by
construction, because nothing is wrong with them. `refuted` counts findings the
board itself contradicts, which is the sharpest precision signal available
without a human.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from console import utf8  # noqa: E402


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def rule_covered(rows: list[dict]) -> set[str]:
    """Defect ids some detector's rules caught, from the rows themselves."""
    covered = set()
    for row in rows:
        if not row.get("defects"):
            continue
        if row.get("rules"):
            covered.add(row["defects"][0]["id"])
    return covered


def summarise(rows: list[dict], covered: set[str]) -> dict:
    seeded = [r for r in rows if r.get("defects")]
    clean = [r for r in rows if not r.get("defects")]

    caught_all = caught_silent = total_silent = 0
    for row in seeded:
        did = row["defects"][0]["id"]
        hit = bool(row.get("grade", {}).get("caught"))
        caught_all += hit
        if did not in covered:
            total_silent += 1
            caught_silent += hit

    return {
        "boards": len(rows),
        "recall_all": f"{caught_all}/{len(seeded)}",
        "recall_silent": f"{caught_silent}/{total_silent}",
        "_silent_rate": caught_silent / total_silent if total_silent else 0.0,
        "clean_false": sum(len(r.get("grade", {}).get("other", [])) for r in clean),
        "seeded_extra": sum(len(r.get("grade", {}).get("other", [])) for r in seeded),
        "refuted": sum(len(r.get("refuted", [])) for r in rows),
        "calls": sum(r.get("calls", 0) for r in rows),
        "truncated": sum(r.get("truncated_calls", 0) for r in rows),
    }


def main() -> int:
    utf8()
    paths = [Path(a) for a in sys.argv[1:]]
    if not paths:
        paths = sorted(ROOT.glob("results/sweep-*.json"))[-1:]

    rows: list[dict] = []
    for path in paths:
        rows += load(path)["rows"]

    detectors = sorted({r["detector"] for r in rows})
    # A defect is rule-covered if any detector's rules fired on that board, so
    # the split is a property of the corpus and not of whichever ran first.
    covered = rule_covered(rows)

    print(f"corpus: {len(covered)} of the seeded defects are also caught by a rule")
    print(f"        {sorted(covered)}\n")

    table = {d: summarise([r for r in rows if r["detector"] == d], covered) for d in detectors}
    keys = [k for k in next(iter(table.values())) if not k.startswith("_")]
    width = max(len(k) for k in keys) + 2
    head = "".join(f"{d:>18}" for d in detectors)
    print(f"{'':<{width}}{head}")
    for k in keys:
        line = "".join(f"{str(table[d][k]):>18}" for d in detectors)
        print(f"{k:<{width}}{line}")

    if len(detectors) > 1:
        best = max(detectors, key=lambda d: table[d]["_silent_rate"])
        print(f"\nbest rule-silent recall: {best} ({table[best]['recall_silent']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

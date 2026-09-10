"""What attaching datasheets does to the reviewer, with and without a budget.

    python tools/doc_budget.py

Three sweeps of the same detector on the same corpus, differing only in what
was appended to the reviewer's pack:

    control   nothing. The board, which is every sweep the README quotes.
    before    three whole chunks per documented part, no ceiling - what the
              page shipped, and what left the board at 21% of its own pack.
    after     the budget that replaced it: a share of the board, spent
              round-robin, each passage narrowed to the span that earned it.

WHY THE COMPARISON IS RESTRICTED

Only one of the two corpus boards has cached datasheets, so four of the fifteen
cases are byte-identical across all three sweeps. Counting them flattens the
difference toward zero by adding the same rows to both sides. The headline rows
are the eleven cases that actually carry documents; the whole corpus is printed
underneath, because that is what a visitor with one documented board gets.

WHAT WOULD COUNT AS THE FIX WORKING

Not "after beats before". Documents are not expected to *help* on this corpus -
none of the thirteen seeded defects needs a datasheet to see, and the one
datasheet-driven rule is deterministic and runs either way. The question is what
attaching them *costs*, and the fix works if `after` gives that cost back.
"""

from __future__ import annotations

import json
import statistics
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from console import utf8  # noqa: E402
from harness.grade import pipeline_hash  # noqa: E402
from harness.llm import PRICE_IN, PRICE_OUT  # noqa: E402

RESULTS = ROOT / "results"
VARIANTS = (
    ("control", RESULTS / "latest.json"),
    ("before", RESULTS / "doc-before.json"),
    ("after", RESULTS / "doc-after.json"),
)


def documented_ids() -> set[str]:
    blocks = json.loads((RESULTS / "doc-packs-before.json").read_text(encoding="utf-8"))
    return {case for case, text in blocks.items() if text}


def rule_covered(rows: list[dict]) -> set[str]:
    return {
        row["defects"][0]["id"]
        for row in rows
        if row.get("defects") and row.get("rules")
    }


def summarise(rows: list[dict], covered: set[str]) -> dict:
    seeded = [r for r in rows if r.get("defects")]
    clean = [r for r in rows if not r.get("defects")]
    trials = sorted({r.get("trial", 1) for r in rows})

    caught_all = caught_silent = total_silent = total_all = 0
    for row in seeded:
        hit = bool(row.get("grade", {}).get("caught"))
        total_all += 1
        caught_all += hit
        if row["defects"][0]["id"] not in covered:
            total_silent += 1
            caught_silent += hit

    tokens_in = sum(r.get("tokens_in", 0) for r in rows)
    tokens_out = sum(r.get("tokens_out", 0) for r in rows)
    per_trial_clean = [
        sum(len(r.get("grade", {}).get("other", [])) for r in clean if r.get("trial", 1) == t)
        for t in trials
    ]
    return {
        "trials": len(trials),
        "rule-silent recall": _rate(caught_silent, total_silent),
        "all-defects recall": _rate(caught_all, total_all),
        "findings on clean, median": statistics.median(per_trial_clean) if per_trial_clean else 0,
        "unmatched on seeded": sum(
            len(r.get("grade", {}).get("other", [])) for r in seeded
        ),
        "board-refuted, reported": sum(len(r.get("refuted_reported", [])) for r in rows),
        "truncated calls": sum(r.get("truncated_calls", 0) for r in rows),
        "prompt tokens per board": round(tokens_in / max(len(rows), 1)),
        "cost per 11 boards": f"${(tokens_in * PRICE_IN + tokens_out * PRICE_OUT) / 1e6 / max(len(trials), 1):.4f}",
    }


def _rate(hit: int, of: int) -> str:
    return f"{hit}/{of}  {round(100 * hit / of) if of else 0}%"


def main() -> int:
    utf8()
    loaded = {}
    for name, path in VARIANTS:
        if not path.exists():
            raise SystemExit(f"{path} is missing. Run tools/doc_packs.py, then the sweeps.")
        data = json.loads(path.read_text(encoding="utf-8"))
        loaded[name] = data
        mark = "" if data.get("pipeline_hash") == pipeline_hash() else "  <- DIFFERENT PIPELINE"
        print(f"read {path.name:<22} pipeline {data.get('pipeline_hash','?')}{mark}")
    print(f"code in the tree:      pipeline {pipeline_hash()}\n")

    # Every variant ran V8, and only the trials all three share are comparable:
    # the control has five and the documented sweeps three, and reading five
    # draws against three would credit the control with the wider sample.
    trials = min(d["trials"] for d in loaded.values())
    rows = {
        name: [r for r in d["rows"] if r["detector"] == "v8" and r.get("trial", 1) <= trials]
        for name, d in loaded.items()
    }
    print(f"V8 only, trials 1-{trials}, on the corpus all three sweeps share\n")

    docs = documented_ids()
    covered = rule_covered([r for rs in rows.values() for r in rs])

    # The spread first, because it is what the table means. Three draws of the
    # same reviewer on the same prompt at temperature zero caught 7, 6 and 3 of
    # the 7 rule-silent defects on these boards - a range wider than any gap
    # between the three variants. A reader shown only the totals would read a
    # one-defect difference as a result.
    silent = [
        r for r in rows["control"]
        if r.get("defects") and r["defects"][0]["id"] not in covered and r["board"] in docs
    ]
    per = {t: sum(1 for r in silent if r.get("trial", 1) == t) for t in range(1, trials + 1)}
    print("RULE-SILENT RECALL PER TRIAL, on the documented cases")
    print(f"{'':<10}" + "".join(f"{'trial ' + str(t):<12}" for t in range(1, trials + 1)))
    for name in (n for n, _ in VARIANTS):
        cells = []
        for t in range(1, trials + 1):
            sel = [
                r for r in rows[name]
                if r.get("trial", 1) == t and r["board"] in docs and r.get("defects")
                and r["defects"][0]["id"] not in covered
            ]
            hit = sum(1 for r in sel if r.get("grade", {}).get("caught"))
            cells.append(f"{hit}/{len(sel)}".ljust(12))
        print(f"{name:<10}" + "".join(cells))
    print()

    for title, keep in (
        (f"the {len(docs)} cases carrying datasheets", lambda r: r["board"] in docs),
        ("the whole corpus", lambda r: True),
    ):
        table = {n: summarise([r for r in rs if keep(r)], covered) for n, rs in rows.items()}
        names = [n for n, _ in VARIANTS]
        keys = list(next(iter(table.values())))
        width = max(len(k) for k in keys) + 2
        print(title.upper())
        print(f"{'':<{width}}" + "".join(f"{n:>16}" for n in names))
        for k in keys:
            print(f"{k:<{width}}" + "".join(f"{str(table[n][k]):>16}" for n in names))
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

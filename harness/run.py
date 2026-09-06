"""The eval runner: eight boards, two detectors, one scored table.

    python -m harness.run                       both detectors, all eight boards
    python -m harness.run --detector graph      one of them
    python -m harness.run --board clean         one board
    python -m harness.run --concurrency 1 --tpm 4000

Eight boards: one clean, seven seeded. Two detectors: a single flat prompt, and
the graph. The headline is the comparison between them, and the clean board is
what makes that comparison mean anything — a reviewer that flags everything
catches every defect and is worth nothing.

Every result carries the prompt hash, the schema hash and the corpus hash. A
score that outlives the system it measured is worse than no score.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from console import utf8  # noqa: E402
from baseline.single_prompt import review_once  # noqa: E402
from graph.build import run_graph  # noqa: E402
from graph.prompts import prompt_hash  # noqa: E402
from harness.grade import corpus_hash, grade, schema_hash, totals  # noqa: E402
from harness.llm import Client  # noqa: E402
from harness.ops import apply_edits, board_hash  # noqa: E402
from harness.presets import PRESETS, edits_for  # noqa: E402

BOARD_JSON = ROOT / "boards" / "stm32-good.json"
RESULTS = ROOT / "results"


def corpus() -> list[dict]:
    """The eight boards, built fresh from the one extracted board."""
    good = json.loads(BOARD_JSON.read_text(encoding="utf-8"))
    boards = [
        {
            "id": "clean",
            "title": "The board as manufactured",
            "board": good,
            "defects": [],
            "focus": [],
        }
    ]
    for preset in PRESETS:
        work = json.loads(json.dumps(good))
        apply_edits(work, edits_for(preset, work))
        boards.append(
            {
                "id": preset["id"],
                "title": preset["title"],
                "board": work,
                "defects": [
                    {
                        "id": preset["id"],
                        "title": preset["title"],
                        "refs": preset["refs"],
                        "nets": preset["nets"],
                    }
                ],
                "focus": preset["refs"],
            }
        )
    return boards


def run_one(detector: str, case: dict, client: Client) -> dict:
    started = time.monotonic()
    if detector == "graph":
        state = run_graph(case["board"], client, case["focus"])
    else:
        state = review_once(case["board"], client, case["focus"])

    findings = state["confirmed"]
    row = {
        "detector": detector,
        "board": case["id"],
        "title": case["title"],
        "board_hash": board_hash(case["board"]),
        "defects": case["defects"],
        "findings": findings,
        "dropped": [
            {"title": d["title"], "because": d["dropped"]} for d in state.get("dropped", [])
        ],
        "rules": [f["rule"] for f in state.get("deterministic", [])],
        "passes": state.get("passes", 1),
        "stopped": state.get("stopped", ""),
        "calls": len(state.get("calls", [])),
        "cached_calls": sum(1 for c in state.get("calls", []) if c.get("cached")),
        "tokens_in": sum(c.get("tokens_in", 0) for c in state.get("calls", [])),
        "tokens_out": sum(c.get("tokens_out", 0) for c in state.get("calls", [])),
        "seconds": round(time.monotonic() - started, 1),
    }
    row["grade"] = grade(findings, case["defects"])
    return row


def report(rows: list[dict]) -> str:
    """The grid, as it goes in the README."""
    detectors = sorted({r["detector"] for r in rows})
    boards = [r["board"] for r in rows if r["detector"] == detectors[0]]
    width = max(len(b) for b in boards) + 2

    lines = [
        "board".ljust(width) + "".join(d.ljust(22) for d in detectors),
        "-" * (width + 22 * len(detectors)),
    ]
    for board in boards:
        cells = []
        for detector in detectors:
            row = next(r for r in rows if r["detector"] == detector and r["board"] == board)
            g = row["grade"]
            mark = "clean" if not row["defects"] else ("caught" if g["caught"] else "MISSED")
            cells.append(f"{mark}, {g['false_alarms']} other".ljust(22))
        lines.append(board.ljust(width) + "".join(cells))

    lines.append("")
    for detector in detectors:
        t = totals([r for r in rows if r["detector"] == detector])
        lines.append(
            f"{detector:<12} {t['caught']} of {t['of']} defects"
            f" · {t['false_alarms_on_clean']} findings on the clean board"
            f" · {t['extra_findings_on_seeded']} extra on the seeded ones"
        )
    return "\n".join(lines)


def main() -> int:
    utf8()
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--detector", choices=["single", "graph", "both"], default="both")
    ap.add_argument("--board", default="", help="one board id, or a prefix")
    ap.add_argument("--concurrency", type=int, default=2)
    ap.add_argument("--tpm", type=int, default=8000, help="token budget per minute")
    ap.add_argument("--model", default="")
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args()

    cases = corpus()
    if args.board:
        cases = [c for c in cases if c["id"].startswith(args.board)]
        if not cases:
            raise SystemExit(f"no board matching {args.board!r}")
    detectors = ["single", "graph"] if args.detector == "both" else [args.detector]

    client = Client(model=args.model, concurrency=args.concurrency, tpm=args.tpm)
    rows = []
    for detector in detectors:
        for case in cases:
            row = run_one(detector, case, client)
            rows.append(row)
            g = row["grade"]
            mark = "·" if not case["defects"] else ("+" if g["caught"] else "-")
            print(
                f"{mark} {detector:<7} {case['id']:<22} "
                f"{len(row['findings'])} findings, {g['false_alarms']} unmatched, "
                f"{row['calls']} calls, {row['seconds']}s"
            )

    print()
    print(report(rows))
    print()
    print(f"usage {client.usage.as_dict()}")

    result = {
        "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "model": client.model,
        "prompt_hash": prompt_hash(),
        "schema_hash": schema_hash(),
        "corpus_hash": corpus_hash([r["board_hash"] for r in rows]),
        "usage": client.usage.as_dict(),
        "totals": {d: totals([r for r in rows if r["detector"] == d]) for d in detectors},
        "rows": rows,
    }
    out = args.out or RESULTS / f"sweep-{time.strftime('%Y%m%d-%H%M%S')}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=1), encoding="utf-8")
    (RESULTS / "latest.json").write_text(json.dumps(result, indent=1), encoding="utf-8")
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

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
import hashlib
import json
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from console import utf8  # noqa: E402
from baseline.single_prompt import review_once  # noqa: E402
from graph.build import run_graph  # noqa: E402
from graph.prompts import prompt_hash  # noqa: E402
from harness.grade import corpus_hash, grade, pipeline_hash, refuted, schema_hash, totals  # noqa: E402
from harness.packs import PACK_VERSION  # noqa: E402
from harness.research import FACTS_FORMAT  # noqa: E402
from harness.llm import PRICE_IN, PRICE_OUT, Client  # noqa: E402
from harness.ops import apply_edits, board_hash  # noqa: E402
from harness.generators import defects_for  # noqa: E402

#: Every board the sweep scores. A defect names the board it belongs to, so the
#: corpus is one clean case per board plus one case per defect.
BOARDS = {
    "stm32-good": ROOT / "boards" / "stm32-good.json",
    "dcdcc": ROOT / "boards" / "dcdcc.json",
}
BOARD_JSON = BOARDS["stm32-good"]
RESULTS = ROOT / "results"


def _load(name: str) -> dict:
    return json.loads(BOARDS[name].read_text(encoding="utf-8"))


def corpus() -> list[dict]:
    """The clean boards, then every seeded defect, built fresh each time.

    Defects are generated rather than listed. Each generator searches the board
    for a site matching its pattern, so adding a KiCad project adds every defect
    whose pattern that board contains, and a board with no such site contributes
    nothing for that generator. The corpus is therefore a function of the boards
    rather than a list written beside them.

    The clean cases carry no defects at all, so every finding on them is a false
    alarm; they are what stop a detector scoring well by flagging everything.
    """
    boards = {name: _load(name) for name in BOARDS}
    cases = [
        {
            "id": f"clean:{name}",
            "board_name": name,
            "title": f"{name} as designed",
            "board": board,
            "defects": [],
        }
        for name, board in boards.items()
    ]
    for name, board in boards.items():
        for defect in defects_for(board, name):
            work = json.loads(json.dumps(board))
            apply_edits(work, defect["edits"])
            cases.append(
                {
                    "id": defect["id"],
                    "board_name": name,
                    "title": defect["title"],
                    "board": work,
                    "defects": [
                        {
                            "id": defect["id"],
                            "generator": defect["generator"],
                            "title": defect["title"],
                            "refs": defect["refs"],
                            "nets": defect["nets"],
                        }
                    ],
                }
            )

    return cases


def run_one(detector: str, case: dict, client: Client) -> dict:
    started = time.monotonic()
    if detector == "graph":
        state = run_graph(case["board"], client)
    else:
        state = review_once(case["board"], client)

    findings = state["confirmed"]
    row = {
        "detector": detector,
        "board": case["id"],
        "board_name": case["board_name"],
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
    # What a scored run has to carry to be reproducible: the exact packs each
    # model was shown, which specialists existed, what every stage refused and
    # why, and the coverage. A result that cannot say what was asked of the
    # model is a result nobody can check.
    row["packs"] = {name: pack for name, pack in (state.get("packs") or {}).items()}
    row["pack_hashes"] = {
        name: hashlib.sha256(pack.encode("utf-8")).hexdigest()[:16]
        for name, pack in row["packs"].items()
    }
    row["enabled_agents"] = list(state.get("enabled_agents") or [])
    row["coverage"] = dict(state.get("coverage") or {})
    row["rejected"] = [
        {
            "stage": entry.get("stage", "?"),
            "because": entry.get("because", ""),
            "title": (entry.get("finding") or {}).get("title", ""),
        }
        for entry in (state.get("rejected") or [])
    ]
    row["report"] = state.get("report") or {}
    row["grade"] = grade(findings, case["defects"])
    # What the board refutes, before and after whatever the detector does about
    # it. For the single prompt those two are the same list, which is the point.
    row["refuted_proposed"] = refuted(state.get("findings", findings), case["board"])
    row["refuted_reported"] = refuted(findings, case["board"])
    return row


#: The metrics a repeat can move. `caught` is here even though it has never
#: moved off 7/7, because "it never moves" is a finding and only repeats show it.
VARIES = (
    "caught",
    "false_alarms_on_clean",
    "extra_findings_on_seeded",
    "refuted_proposed",
    "refuted_reported",
)


def spread(per_trial: list[dict]) -> dict:
    """Median and range for each metric across the trials.

    A point estimate from one run cannot be told apart from noise, and this
    project's own history is the argument: an earlier sweep had the two
    detectors level, and the published one has the graph further ahead than it
    has ever been. Same code, same prompts, different draw. So the honest unit
    of measurement is a distribution, and the range is reported next to the
    median rather than tucked into a caveat.
    """
    out = {}
    for metric in VARIES:
        values = sorted(t[metric] for t in per_trial)
        out[metric] = {
            "median": statistics.median(values),
            "min": values[0],
            "max": values[-1],
            "values": values,
        }
    return out


def breadth_of(rows: list[dict]) -> dict:
    """How many names each matched finding threw at the board.

    The automatic match rule cannot tell identifying a defect from mentioning a
    part it touches, and the only fix in the schema today is to record how wide
    the finding cast. A match on a finding naming two things is worth more than
    the same match on one naming nine, so a lower median is a more specific
    detector. It is a proxy for the hand read, not a replacement for it.
    """
    widths = [c["breadth"] for r in rows for c in r["grade"]["caught"]]
    return {
        "matches": len(widths),
        "median": statistics.median(widths) if widths else None,
        "mean": round(statistics.fmean(widths), 2) if widths else None,
    }


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
            f" · {t['refuted_reported']} reported findings the copper refutes"
            f" (of {t['refuted_proposed']} proposed)"
        )
    return "\n".join(lines)


def by_trial(rows: list[dict], detector: str, trials: int) -> list[dict]:
    """One totals row per trial, for one detector."""
    return [
        totals([r for r in rows if r["detector"] == detector and r["trial"] == t])
        for t in range(1, trials + 1)
    ]


def across_trials(rows: list[dict], detectors: list[str], trials: int) -> str:
    """The distribution, which is the only honest way to read a repeated sweep."""
    lines = [f"across {trials} trials — median (min-max)", ""]
    label = {
        "caught": "defects matched, of 7",
        "false_alarms_on_clean": "findings on the clean board",
        "extra_findings_on_seeded": "unmatched findings on seeded",
        "refuted_proposed": "board-refuted claims proposed",
        "refuted_reported": "board-refuted claims reported",
    }
    spreads = {d: spread(by_trial(rows, d, trials)) for d in detectors}
    width = max(len(v) for v in label.values()) + 2
    lines.append("".ljust(width) + "".join(d.ljust(20) for d in detectors))
    for metric, text in label.items():
        cells = []
        for d in detectors:
            s = spreads[d][metric]
            cells.append(f"{s['median']:g} ({s['min']}-{s['max']})".ljust(20))
        lines.append(text.ljust(width) + "".join(cells))

    lines.append("")
    lines.append("".ljust(width) + "".join(d.ljust(20) for d in detectors))
    cells = []
    for d in detectors:
        b = breadth_of([r for r in rows if r["detector"] == d])
        # No matches at all when only the clean board ran; it has no defects.
        text = "-" if b["median"] is None else f"{b['median']:g} median, {b['mean']} mean"
        cells.append(text.ljust(20))
    lines.append("names per matched finding".ljust(width) + "".join(cells))
    return "\n".join(lines)


def main() -> int:
    utf8()
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--detector", choices=["single", "graph", "both"], default="both")
    ap.add_argument("--board", default="", help="one board id, or a prefix")
    ap.add_argument("--concurrency", type=int, default=2)
    ap.add_argument("--tpm", type=int, default=8000, help="token budget per minute")
    ap.add_argument("--model", default="")
    ap.add_argument(
        "--trials",
        type=int,
        default=1,
        help="repeat the whole sweep N times and report median and range",
    )
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
    for trial in range(1, args.trials + 1):
        # Trials start at 1, so none of them reuses the pre-trials cache. The
        # published single run was scored under the same code, but it is not
        # folded in here as a sixth sample: it is the run that was read and
        # written up, and a draw you have already looked at is not a draw.
        client.trial = trial
        if args.trials > 1:
            print(f"--- trial {trial} of {args.trials}")
        for detector in detectors:
            for case in cases:
                row = run_one(detector, case, client)
                row["trial"] = trial
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
    if args.trials > 1:
        print(across_trials(rows, detectors, args.trials))
        print()
    print(f"usage {client.usage.as_dict()}")

    # What this run spent depends on how much of it was cached, which makes it
    # useless as a figure to quote. The per-row token counts come out of the
    # cached payloads either way, so they are what a cold run costs.
    tokens_in = sum(row["tokens_in"] for row in rows)
    tokens_out = sum(row["tokens_out"] for row in rows)
    cost = {
        "calls": sum(row["calls"] for row in rows),
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
        "dollars": round((tokens_in * PRICE_IN + tokens_out * PRICE_OUT) / 1e6, 4),
    }
    print(f"cold  {cost}")

    result = {
        "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "model": client.model,
        "cost": cost,
        "prompt_hash": prompt_hash(),
        "pack_version": PACK_VERSION,
        "facts_format": FACTS_FORMAT,
        "temperature": client.temperature,
        "max_tokens": client.max_tokens,
        "schema_hash": schema_hash(),
        "pipeline_hash": pipeline_hash(),
        # The corpus is the eight boards. It is deduplicated because scoring
        # them twice, or ten times, does not make it a different corpus.
        "corpus_hash": corpus_hash(sorted({r["board_hash"] for r in rows})),
        "usage": client.usage.as_dict(),
        "trials": args.trials,
        "totals": {d: totals([r for r in rows if r["detector"] == d]) for d in detectors},
        "by_trial": {d: by_trial(rows, d, args.trials) for d in detectors},
        "spread": {d: spread(by_trial(rows, d, args.trials)) for d in detectors},
        "breadth": {
            d: breadth_of([r for r in rows if r["detector"] == d]) for d in detectors
        },
        "rows": rows,
    }
    # The packs themselves are megabytes across a sweep and their hashes are
    # what a reproduction needs to compare; the full text stays in the timestamped
    # file and is stripped from the one that is committed.
    out = args.out or RESULTS / f"sweep-{time.strftime('%Y%m%d-%H%M%S')}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=1), encoding="utf-8")
    slim = {
        **result,
        "rows": [{k: v for k, v in row.items() if k != "packs"} for row in result["rows"]],
    }
    (RESULTS / "latest.json").write_text(json.dumps(slim, indent=1), encoding="utf-8")
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Run the graph and keep everything it thought, not just what it concluded.

    python -m harness.trace                 all eight boards
    python -m harness.trace ground-stranded one of them

Writes `results/trace.json`: for every board, every node in the order it ran,
with the job it was given, the model's own reasoning, what it proposed, and —
at each turn of the loop — the gate's decision and the measurement behind it.

`tools/build_trace.py` turns that into a page. The point of keeping the
reasoning is that a review you cannot read the argument for is a review you have
to take on trust, which is the opposite of what this project is for.
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
from graph.build import MAX_PASSES, build_graph  # noqa: E402
from graph.prompts import BOARD_CONTEXT, SCHEMA, prompt_hash  # noqa: E402
from harness.checks import run_checks  # noqa: E402
from harness.distill import approx_tokens, distill  # noqa: E402
from harness.grade import grade, refuted  # noqa: E402
from harness.llm import PRICE_IN, PRICE_OUT, Client  # noqa: E402
from harness.ops import apply_edits, board_hash  # noqa: E402
from harness.presets import PRESETS, edits_for  # noqa: E402

OUT = ROOT / "results" / "trace.json"

#: What each node is for, in one line, for the page.
ROLES = {
    "ingest": "Parse, distil, and run the rule checks. No model is asked anything.",
    "datasheet": "What each pin is for, against what it is wired to.",
    "connections": "The wiring between parts, and off the board.",
    "layout": "Placement and copper.",
    "adjudicate": "Merge the three reviews, then let the board refute what it can.",
    "gate": "Stop, or go round again. Decided on measurements, never on the model's say-so.",
}
MEASURED = {"ingest", "gate"}


def job_of(prompt: str, distilled: str) -> str:
    """The prompt minus the board and the boilerplate every node shares.

    All six prompts carry the same 2,918-token board and the same schema. What
    differs between them is a paragraph, and that paragraph is the interesting
    part, so the page shows it and the board once.
    """
    job = prompt.replace(distilled, "").replace(BOARD_CONTEXT, "").replace(SCHEMA, "")
    job = job.replace("Here is the board.", "")
    job = job.replace(
        "Use the exact ref and net strings from the board so findings can be "
        "matched to\nthe design. Reply with JSON only, in exactly this shape:",
        "",
    )
    return "\n".join(line for line in job.splitlines() if line.strip()).strip()


def trace_board(name: str, title: str, board: dict, client: Client) -> dict:
    started = time.monotonic()
    state = build_graph(client).invoke({"board": board}, {"recursion_limit": 50})
    elapsed = time.monotonic() - started

    distilled = state["distilled"]
    rules = state.get("deterministic", [])

    steps = [
        {
            "node": "ingest",
            "pass": 0,
            "measured": True,
            "seconds": 0.0,
            "summary": (
                f"Distilled the board to {approx_tokens(distilled)} tokens. "
                + (
                    f"{len(rules)} rule check fired: "
                    + ", ".join(item["rule"] for item in rules)
                    if rules
                    else "No rule check fired."
                )
            ),
            "rules": rules,
        }
    ]

    gates = list(state.get("gates", []))
    for call in state.get("calls", []):
        node = call["node"]
        pass_no = int(call.get("label", "/pass1").split("pass")[-1] or 1)
        steps.append(
            {
                "node": node,
                "pass": pass_no,
                "measured": False,
                "job": job_of(call.get("prompt", ""), distilled),
                "reasoning": call.get("reasoning", ""),
                "answer": call.get("text", ""),
                "found": call.get("found", 0),
                "tokens_in": call.get("tokens_in", 0),
                "tokens_out": call.get("tokens_out", 0),
                "seconds": call.get("seconds", 0.0),
                "cached": bool(call.get("cached")),
            }
        )
        if node == "adjudicate":
            steps[-1]["dropped"] = [
                {"title": item["title"], "because": item["dropped"]}
                for item in state.get("dropped", [])
            ]
            steps[-1]["confirmed"] = [item["title"] for item in state.get("confirmed", [])]
            gate = next((g for g in gates if g["pass"] == pass_no), None)
            if gate:
                steps.append({**gate, "node": "gate", "measured": True})

    tokens_in = sum(s.get("tokens_in", 0) for s in steps)
    tokens_out = sum(s.get("tokens_out", 0) for s in steps)
    return {
        "board": name,
        "title": title,
        "board_hash": board_hash(board),
        "distilled": distilled,
        "distilled_tokens": approx_tokens(distilled),
        "steps": steps,
        "confirmed": state.get("confirmed", []),
        "proposed": len(state.get("findings", [])),
        "dropped": [
            {"title": d["title"], "because": d["dropped"]} for d in state.get("dropped", [])
        ],
        "refuted_reported": refuted(state.get("confirmed", []), board),
        "passes": state.get("passes", 1),
        "stopped": state.get("stopped", ""),
        "seconds": round(elapsed, 1),
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
        "dollars": round((tokens_in * PRICE_IN + tokens_out * PRICE_OUT) / 1e6, 5),
    }


def corpus(only: str = "") -> list[tuple[str, str, dict]]:
    good = json.loads((ROOT / "boards" / "stm32-good.json").read_text(encoding="utf-8"))
    out = [("clean", "The board as manufactured", good)]
    for preset in PRESETS:
        work = json.loads(json.dumps(good))
        apply_edits(work, edits_for(preset, work))
        out.append((preset["id"], preset["title"], work))
    if only:
        out = [row for row in out if row[0].startswith(only)]
        if not out:
            raise SystemExit(f"no board matching {only!r}")
    return out


def main() -> int:
    utf8()
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("board", nargs="?", default="")
    ap.add_argument("--tpm", type=int, default=40000)
    ap.add_argument("--concurrency", type=int, default=2)
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args()

    client = Client(concurrency=args.concurrency, tpm=args.tpm)
    boards = []
    for name, title, board in corpus(args.board):
        row = trace_board(name, title, board, client)
        boards.append(row)
        print(
            f"{name:<22} {row['passes']} pass · {len(row['steps'])} steps · "
            f"{row['stopped']:<26} {row['seconds']}s · ${row['dollars']}"
        )

    defects = {p["id"]: p for p in PRESETS}
    for row in boards:
        preset = defects.get(row["board"])
        row["defect"] = (
            {
                "id": preset["id"],
                "title": preset["title"],
                "breaks": preset["breaks"],
                "refs": preset["refs"],
                "nets": preset["nets"],
            }
            if preset
            else None
        )
        row["grade"] = grade(row["confirmed"], [row["defect"]] if preset else [])

    result = {
        "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "model": client.model,
        "prompt_hash": prompt_hash(),
        "max_passes": MAX_PASSES,
        "roles": ROLES,
        "measured": sorted(MEASURED),
        "boards": boards,
        "totals": {
            "boards": len(boards),
            "calls": sum(len([s for s in b["steps"] if not s["measured"]]) for b in boards),
            "tokens_in": sum(b["tokens_in"] for b in boards),
            "tokens_out": sum(b["tokens_out"] for b in boards),
            "dollars": round(sum(b["dollars"] for b in boards), 4),
            "seconds": round(sum(b["seconds"] for b in boards), 1),
        },
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=1), encoding="utf-8")
    print(f"\n{result['totals']}")
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

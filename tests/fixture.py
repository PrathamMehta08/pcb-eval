"""Generate tests/fixtures/ops.json, the fixture both op implementations answer to.

`harness/ops.py` and `site/ops.js` are the same nine operations written twice,
which is a standing invitation to drift. This writes out a set of edit lists and
the board hash Python produces for each; `tests/ops_parity.mjs` replays the same
lists through the JavaScript and must arrive at the same sixteen characters.

Regenerate after changing either implementation:

    python -m tests.fixture
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from console import utf8  # noqa: E402
from graph.prompts import single_prompt  # noqa: E402
from harness.checks import run_checks  # noqa: E402
from harness.distill import approx_tokens, distill  # noqa: E402
from harness.ops import apply_edits, board_hash, undo  # noqa: E402
from harness.generators import defects_for  # noqa: E402

OUT = ROOT / "tests" / "fixtures" / "ops.json"
DISTILL_OUT = ROOT / "tests" / "fixtures" / "distill.json"
CHECKS_OUT = ROOT / "tests" / "fixtures" / "checks.json"


def _edit(op: str, **args) -> dict:
    return {"op": op, "args": args}


def direct_cases(board: dict) -> list[dict]:
    """One case per operation, so a preset never masks a broken primitive."""
    first_track = board["layout"]["tracks"][0]["id"]
    wide_track = next(t for t in board["layout"]["tracks"] if t["width"] >= 0.5)["id"]
    first_via = board["layout"]["vias"][0]["id"]
    zone = board["layout"]["zones"][0]["id"]
    return [
        {"id": "op:move_pin", "edits": [_edit("move_pin", ref="R4", pin="2", to_net="GND")]},
        {
            "id": "op:move_pin-new-net",
            "edits": [_edit("move_pin", ref="R4", pin="2", to_net="/A_NET_THAT_DID_NOT_EXIST")],
        },
        {"id": "op:swap_pins", "edits": [_edit("swap_pins", ref="J2", pin_a="1", pin_b="4")]},
        {"id": "op:set_value", "edits": [_edit("set_value", ref="R4", value="4k7")]},
        {
            "id": "op:move_footprint",
            "edits": [_edit("move_footprint", ref="C6", x=12.3456, y=7.891)],
        },
        {"id": "op:rotate_footprint", "edits": [_edit("rotate_footprint", ref="C6", deg=270)]},
        {
            "id": "op:rotate_footprint-negative",
            "edits": [_edit("rotate_footprint", ref="C6", deg=-45)],
        },
        {"id": "op:delete_track", "edits": [_edit("delete_track", track_id=first_track)]},
        {
            "id": "op:set_track_width",
            "edits": [_edit("set_track_width", track_id=wide_track, mm=0.1524)],
        },
        {
            # Five decimals on purpose. Python's round() is banker's and
            # JavaScript's Math.round is half-up, so this argument used to hash
            # to two different boards — and every case here passed four decimals,
            # which is exactly why the parity test never saw it.
            "id": "op:set_track_width-five-decimals",
            "edits": [_edit("set_track_width", track_id=wide_track, mm=0.15005)],
        },
        {
            "id": "op:move_footprint-five-decimals",
            "edits": [_edit("move_footprint", ref="C6", x=12.34565, y=-0.00001)],
        },
        {"id": "op:delete_via", "edits": [_edit("delete_via", via_id=first_via)]},
        {"id": "op:toggle_zone", "edits": [_edit("toggle_zone", zone_id=zone)]},
        {
            "id": "op:toggle_zone-twice",
            "edits": [_edit("toggle_zone", zone_id=zone), _edit("toggle_zone", zone_id=zone)],
        },
        {
            "id": "op:mixed",
            "edits": [
                _edit("set_value", ref="R4", value="R"),
                _edit("move_footprint", ref="U3", x=40.0, y=20.0),
                _edit("rotate_footprint", ref="U3", deg=90),
                _edit("delete_via", via_id=first_via),
                _edit("toggle_zone", zone_id=zone),
            ],
        },
    ]


def main() -> int:
    utf8()
    board = json.loads((ROOT / "boards" / "stm32-good.json").read_text(encoding="utf-8"))
    clean = board_hash(board)

    cases = direct_cases(board)
    cases += [
        {"id": defect["id"], "edits": defect["edits"]}
        for defect in defects_for(board, "stm32-good")
    ]

    reference = json.dumps(board, sort_keys=True)
    for case in cases:
        work = json.loads(json.dumps(board))
        log = apply_edits(work, case["edits"])
        case["hash"] = board_hash(work)
        case["labels"] = [entry["label"] for entry in log]
        while log:
            undo(work, log)
        case["undo_hash"] = board_hash(work)
        if case["undo_hash"] != clean:
            raise SystemExit(f"{case['id']}: undo did not restore the board hash")
        # And restore it exactly, not merely to something that hashes the same.
        # The hash sorts net nodes, so an undo that put a node back at the wrong
        # index — or a deleted track back at the wrong position — would pass on
        # the hash alone.
        if json.dumps(work, sort_keys=True) != reference:
            raise SystemExit(f"{case['id']}: undo restored the hash but not the board")

    # The distilled text is what a review actually reads, so the browser copy
    # has to produce it character for character or the harness would be scoring
    # a board the page never sent.
    distilled = []
    for defect in [None] + defects_for(board, "stm32-good"):
        work = json.loads(json.dumps(board))
        edits = [] if defect is None else defect["edits"]
        apply_edits(work, edits)
        distilled.append(
            {
                "id": "clean" if defect is None else defect["id"],
                "edits": edits,
                "text": distill(work),
                "tokens": approx_tokens(distill(work)),
            }
        )

    # The rules run in the page too, so the browser copy answers to this. Every
    # case this board generates is included, clean first.
    rules = []
    for defect in [None] + defects_for(board, "stm32-good"):
        work = json.loads(json.dumps(board))
        edits = [] if defect is None else defect["edits"]
        apply_edits(work, edits)
        found = run_checks(work)
        rules.append(
            {
                "id": "clean" if defect is None else defect["id"],
                "edits": edits,
                "rules": [f["rule"] for f in found],
                "titles": [f["title"] for f in found],
                "refs": [f["refs"] for f in found],
            }
        )

    OUT.parent.mkdir(parents=True, exist_ok=True)
    CHECKS_OUT.write_text(json.dumps({"cases": rules}, indent=1), encoding="utf-8")
    print(
        f"wrote {CHECKS_OUT.relative_to(ROOT)}: {len(rules)} boards, "
        f"{sum(len(r['rules']) for r in rules)} rule findings"
    )
    # The page has to send the same prompt as the `single` detector, or the
    # README's comparison is not about the page. The whole prompt for the clean
    # board goes in, so the parity script compares the text, not a hash of it.
    DISTILL_OUT.write_text(
        json.dumps(
            {
                "cases": distilled,
                "single_prompt_clean": single_prompt(distilled[0]["text"]),
            },
            indent=1,
        ),
        encoding="utf-8",
    )
    print(
        f"wrote {DISTILL_OUT.relative_to(ROOT)}: {len(distilled)} boards, "
        f"{max(d['tokens'] for d in distilled)} tokens at most"
    )
    OUT.write_text(
        json.dumps({"clean_hash": clean, "cases": cases}, indent=1), encoding="utf-8"
    )
    unique = len({case["hash"] for case in cases})
    print(f"wrote {OUT.relative_to(ROOT)}: {len(cases)} cases, {unique} distinct hashes")
    print(f"clean board {clean}")
    if unique != len(cases):
        print("note: two cases produced the same hash, which may mean one is a no-op")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

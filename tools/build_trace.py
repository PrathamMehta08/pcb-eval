"""Assemble the trace page into one publishable file.

    python -m harness.trace          -> results/trace.json
    python tools/build_trace.py      -> dist/pcb-trace.html

The trace is the run, kept whole: every prompt, the model's own reasoning at
each node, and the gate's decision at each turn of the loop. This inlines it.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from console import utf8  # noqa: E402
from tools.build_site import PREVIEW_SHELL  # noqa: E402

SITE = ROOT / "site"
TRACE = ROOT / "results" / "trace.json"


def build(out: Path, trace: Path) -> Path:
    if not trace.exists():
        raise SystemExit(f"{trace} is missing. Run: python -m harness.trace")
    page = (SITE / "trace.html").read_text(encoding="utf-8")
    data = json.loads(trace.read_text(encoding="utf-8"))

    for marker, payload in (
        ("/*@TRACE@*/", json.dumps(data, separators=(",", ":"))),
        ("/*@TRACEJS@*/", (SITE / "trace.js").read_text(encoding="utf-8")),
    ):
        if marker not in page:
            raise SystemExit(f"site/trace.html has no {marker} marker")
        page = page.replace(marker, payload, 1)

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page, encoding="utf-8")
    (out.parent / "trace-preview.html").write_text(PREVIEW_SHELL % page, encoding="utf-8")
    return out


def main() -> int:
    utf8()
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, default=ROOT / "dist" / "pcb-trace.html")
    ap.add_argument("--trace", type=Path, default=TRACE)
    args = ap.parse_args()
    out = build(args.out, args.trace)
    data = json.loads(args.trace.read_text(encoding="utf-8"))
    print(
        f"wrote {out} ({out.stat().st_size / 1024 / 1024:.2f} MB) — "
        f"{len(data['boards'])} boards, {data['totals']['calls']} model calls"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

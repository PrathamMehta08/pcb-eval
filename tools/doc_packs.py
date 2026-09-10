"""Build the datasheet block every corpus board would get in the browser.

    .venv/Scripts/python.exe tools/doc_packs.py
    .venv/Scripts/python.exe -m harness.run --detector v8 --trials 3 \
        --documentation results/doc-packs-after.json

The page can attach a datasheet to a part; the harness never could, so five
trials said nothing about the pack a visitor with documents actually gets. This
closes that: the corpus is built here, handed to the browser's own retrieval,
and the resulting block is written out per case for `--documentation` to read.

Retrieval stays in `site/rag.js`. Four things in this repository are written
twice and each costs a parity test - a fifth would cost another, for a path that
only ever runs in a browser.

Two files come out, `before` and `after`, so the benchmark has both sides: three
whole chunks per part with no ceiling, against the budget that replaced it.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from console import utf8  # noqa: E402
from harness.research import _PAGE_BREAK, fetch, major_parts, text_of  # noqa: E402
from harness.run import BOARDS, corpus  # noqa: E402

RESULTS = ROOT / "results"


def pages_of_cached_datasheets() -> dict[str, dict]:
    """Every cached datasheet as one string per page, keyed by the ref.

    Offline, always. A benchmark that depends on a vendor CDN being up is not a
    benchmark, and the cache is populated deliberately by `harness.research`.

    Every page, not the first twelve `harness.research` reads for its regexes:
    the browser indexes the whole document, and a budget measured against a
    truncated one would be measuring the wrong thing.
    """
    out: dict[str, dict] = {}
    for name, path in BOARDS.items():
        board = json.loads(path.read_text(encoding="utf-8"))
        for part in major_parts(board):
            ref = part["ref"]
            if ref in out:
                continue
            url = part["datasheet"].strip()
            pdf = fetch(url, offline=True)
            if pdf is None:
                print(f"  {ref:<4} {part['value']:<22} not cached, skipped")
                continue
            pages = [" ".join(p.split()) for p in text_of(pdf, pages=999).split(_PAGE_BREAK)]
            out[ref] = {
                "part": part["value"],
                "source": url.rsplit("/", 1)[-1],
                "pages": pages,
            }
            words = sum(len(p.split()) for p in pages)
            print(f"  {ref:<4} {part['value']:<22} {len(pages):>3} pages, {words:>6} words")
    return out


def main() -> int:
    utf8()
    print("cached datasheets")
    pages = pages_of_cached_datasheets()
    if not pages:
        raise SystemExit(
            "no datasheets cached. Run `python -m harness.research` once, online, "
            "to populate .cache/datasheets."
        )

    cases = [{"id": c["id"], "board": c["board"]} for c in corpus()]
    print(f"\n{len(cases)} corpus cases\n")

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        (tmp / "cases.json").write_text(json.dumps(cases), encoding="utf-8")
        (tmp / "pages.json").write_text(json.dumps(pages), encoding="utf-8")
        both = tmp / "both.json"
        built = subprocess.run(
            ["node", str(ROOT / "tools" / "doc_packs.mjs"), str(tmp / "cases.json"),
             str(tmp / "pages.json"), str(both)],
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        print(built.stdout)
        blocks = json.loads(both.read_text(encoding="utf-8"))

    RESULTS.mkdir(parents=True, exist_ok=True)
    for variant in ("before", "after"):
        out = RESULTS / f"doc-packs-{variant}.json"
        out.write_text(json.dumps(blocks[variant], indent=1), encoding="utf-8")
        print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

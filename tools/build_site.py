"""Assemble site/ into one publishable file.

An Artifact is a single HTML file, so the board JSON, KiCad's schematic plot and
six ES modules all have to end up inside it. The modules are concatenated rather
than bundled: they import only from each other, every exported name is unique
across the six, and the artifact CSP would block a real module graph anyway.

    python tools/build_site.py            -> dist/pcb-eval.html

Not named site/build.py on purpose: `site` is a standard-library module, and
`python -m site.build` would resolve to the wrong one.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from console import utf8  # noqa: E402
from harness.presets import PRESETS, edits_for  # noqa: E402

SITE = ROOT / "site"
DIST = ROOT / "dist"
SCHEMATIC_SVG = Path(
    r"C:/Users/pratham/Documents/Portfolio/media/pillmate/schematic.svg"
)

PREVIEW_SHELL = """<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 14px system-ui, sans-serif; background: #faf9f7; }
  img { max-width: 100%%; }
  [hidden] { display: none !important; }
</style>
</head><body>
%s
</body></html>
"""

#: Dependency order. copper feeds distill, distill and ops feed review, app last.
MODULES = [
    "copper.js",
    "ops.js",
    "distill.js",
    "kicad.js",
    "upload.js",
    "render.js",
    "review.js",
    "app.js",
]

_IMPORT = re.compile(r"^import\s+[\s\S]*?from\s+\"\./[^\"]+\";\s*$", re.M)
_EXPORT = re.compile(r"^export\s+(?=const|let|var|function|async|class)", re.M)


def bundle_modules() -> str:
    parts = []
    for name in MODULES:
        source = (SITE / name).read_text(encoding="utf-8")
        source = _IMPORT.sub("", source)
        source = _EXPORT.sub("", source)
        parts.append(f"// ===== site/{name} " + "=" * (58 - len(name)) + "\n\n" + source.strip())
    return "\n\n".join(parts)


def minify_svg(markup: str) -> str:
    """KiCad's schematic plot is 1.2 MB, most of it whitespace and <desc>."""
    markup = re.sub(r"<\?xml[^>]*\?>", "", markup)
    markup = re.sub(r"<!DOCTYPE[^>]*>", "", markup, flags=re.I)
    markup = re.sub(r"<desc>[\s\S]*?</desc>", "", markup)
    markup = re.sub(r"<title>[\s\S]*?</title>", "", markup)
    markup = re.sub(r"<!--[\s\S]*?-->", "", markup)
    # Path data is one number per line in the export; a space does the same job.
    markup = re.sub(r"\s*\n\s*", " ", markup)
    return markup.strip()


def presets_for_page() -> list[dict]:
    """Presets with their edits resolved against the board the page will hold."""
    board = json.loads((ROOT / "boards" / "stm32-good.json").read_text(encoding="utf-8"))
    out = []
    for preset in PRESETS:
        out.append(
            {
                "id": preset["id"],
                "title": preset["title"],
                "view": preset["view"],
                "breaks": preset["breaks"],
                "refs": preset["refs"],
                "nets": preset["nets"],
                "edits": edits_for(preset, board),
            }
        )
    return out


def build(out: Path, schematic: Path) -> Path:
    # The page is meant to be the `single` detector the README scores, so it
    # must not ship a prompt that has drifted from graph/prompts.py.
    from tools.sync_prompt import block, BEGIN, END

    review = (SITE / "review.js").read_text(encoding="utf-8")
    current = review[review.index(BEGIN) : review.index(END) + len(END)]
    if current != block():
        raise SystemExit(
            "site/review.js carries a stale review prompt. "
            "Regenerate it: python tools/sync_prompt.py"
        )

    board = json.loads((ROOT / "boards" / "stm32-good.json").read_text(encoding="utf-8"))
    page = (SITE / "index.html").read_text(encoding="utf-8")

    sheet = minify_svg(schematic.read_text(encoding="utf-8")) if schematic.exists() else ""
    if not sheet:
        print(f"warning: {schematic} is missing; the schematic view will be empty")

    for marker, payload in (
        ("<!--@SCHEMATIC@-->", sheet),
        ("/*@BOARD@*/", json.dumps(board, separators=(",", ":"))),
        ("/*@PRESETS@*/", json.dumps(presets_for_page(), separators=(",", ":"))),
        ("/*@MODULES@*/", bundle_modules()),
    ):
        if marker not in page:
            raise SystemExit(f"site/index.html has no {marker} marker")
        page = page.replace(marker, payload, 1)

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page, encoding="utf-8")

    # A local copy inside the same skeleton the Artifact host wraps the file in,
    # so a browser check here sees what a viewer will see.
    (out.parent / "preview.html").write_text(PREVIEW_SHELL % page, encoding="utf-8")
    return out


def main() -> int:
    utf8()
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, default=DIST / "pcb-eval.html")
    ap.add_argument("--schematic", type=Path, default=SCHEMATIC_SVG)
    args = ap.parse_args()

    out = build(args.out, args.schematic)
    size = out.stat().st_size / 1024 / 1024
    print(f"wrote {out} ({size:.2f} MB of a 16 MB budget)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

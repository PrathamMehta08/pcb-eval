"""Assemble site/ into one publishable file.

An Artifact is a single HTML file, so the board JSON and nine ES modules all
have to end up inside it. The modules are concatenated rather than bundled: they
import only from each other, every declared name is unique across them — which
`bundle_modules` enforces — and the artifact CSP would block a real module graph
anyway.

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

SITE = ROOT / "site"
DIST = ROOT / "dist"

#: The page is hosted now rather than published as an Artifact, so the build has
#: to supply the document shell the artifact host used to wrap around it. Without
#: a charset declaration the file is served as whatever the host guesses, and
#: every arrow and middle dot in the interface turns to mojibake.
PAGE_SHELL = """<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Break a real circuit board on purpose and see whether a language model notices.">
<meta name="theme-color" content="#08090c">
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 14px system-ui, sans-serif; background: #08090c; }
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
    "checks.js",
    "ops.js",
    "distill.js",
    "packs.js",
    "kicad.js",
    "upload.js",
    "datasheets.js",
    "render.js",
    "graph.js",
    "review.js",
    "app.js",
]

_IMPORT = re.compile(r"^import\s+[\s\S]*?from\s+\"\./[^\"]+\";\s*$", re.M)
_EXPORT = re.compile(r"^export\s+(?=const|let|var|function|async|class)", re.M)
#: `export { name };` re-exports a name already declared above it, so in one
#: scope the statement is redundant — and a duplicate export is a syntax error.
_REEXPORT = re.compile(r"^export\s*\{[^}]*\};\s*$", re.M)
_DECLARES = re.compile(
    r"^(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)", re.M
)


def bundle_modules() -> str:
    """Concatenate the modules, and refuse to if two of them declare one name.

    Eight module scopes become one, so a name declared twice is a SyntaxError
    the browser only reports at load — a blank page and one console line. This
    guard has caught it twice: `place` in copper.js and render.js, and
    `baseType` in distill.js and checks.js.
    """
    seen: dict[str, str] = {}
    parts = []
    for name in MODULES:
        source = (SITE / name).read_text(encoding="utf-8")
        for declared in _DECLARES.findall(source):
            if declared in seen:
                raise SystemExit(
                    f"site/{name} and site/{seen[declared]} both declare {declared!r}; "
                    "one module has to own it and the other has to import it"
                )
            seen[declared] = name
        source = _IMPORT.sub("", source)
        source = _REEXPORT.sub("", source)
        source = _EXPORT.sub("", source)
        parts.append(f"// ===== site/{name} " + "=" * (58 - len(name)) + "\n\n" + source.strip())
    return "\n\n".join(parts)


def build(out: Path) -> Path:
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

    for marker, payload in (
        ("/*@BOARD@*/", json.dumps(board, separators=(",", ":"))),
        ("/*@MODULES@*/", bundle_modules()),
    ):
        if marker not in page:
            raise SystemExit(f"site/index.html has no {marker} marker")
        page = page.replace(marker, payload, 1)

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(PAGE_SHELL % page, encoding="utf-8")

    # The bare fragment, without the shell. What an Artifact host wraps itself,
    # and what a test that only cares about the body should read.
    (out.parent / "preview.html").write_text(page, encoding="utf-8")
    return out


def main() -> int:
    utf8()
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, default=DIST / "pcb-eval.html")
    args = ap.parse_args()

    out = build(args.out)
    size = out.stat().st_size / 1024 / 1024
    print(f"wrote {out} ({size:.2f} MB of a 16 MB budget)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

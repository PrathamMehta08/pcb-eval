# Working in this repository

`PLAN.md` is the specification and `README.md` is the result. This file is the
short version of how to touch the code without breaking the things that are
easy to break.

## The Python

Always the project virtualenv — it is KiCad's own 3.11, and the system `python`
on this machine is a Microsoft Store stub that does not exist:

```bash
.venv/Scripts/python.exe -m tests.run          # the contract: 14 of 14, no API key
.venv/Scripts/python.exe -m extract.build      # rebuild boards/stm32-good.json
.venv/Scripts/python.exe tools/build_site.py   # rebuild dist/pcb-eval.html
.venv/Scripts/python.exe -m tests.fixture      # after changing ops or the distiller
```

Console output is UTF-8 only because every entry point calls `console.utf8()`
first; without it the edit-log arrows crash on cp1252.

## The rules that are easy to break

**Four things are written twice, and the tests hold them together.**

| Python | JavaScript | held by |
| --- | --- | --- |
| `harness/ops.py` | `site/ops.js` | `tests/ops_parity.mjs` against `tests.fixture` |
| `harness/distill.py` | `site/distill.js` | `tests/distill_parity.mjs`, character for character |
| `harness/checks.py` | `site/checks.js` | `tests/checks_parity.mjs` |
| `graph/build.py` | `site/graph.js` | `tests/graph_browser.mjs`, same four situations |

Change one side and you must change the other and re-run `tests.fixture`. The
page needs its own copy because it has to describe and judge the board as the
visitor just broke it, and only the browser holds that state.

Two cross-language traps are already paid for, so do not reintroduce them:
number formatting goes through `mm()` and `round4()`, which are written to match
JavaScript exactly — `round()` is banker's rounding and `Math.round` is not, and
the board hash is the review cache key.

**`distill()` takes the board and nothing else.** It used to take a list of
interesting refs, and that put the injected defect's name in the review prompt.
If you find yourself wanting to pass it a hint, that is the bug.

**Schematic edits stop at the schematic.** `move_pin`, `swap_pins` and
`set_value` change the netlist; the copper keeps the routing it was extracted
with. Repointing pads too would make `net-island` catch every preset for free
and the scores would measure the editor.

**The page has one board view, and adding a second is a regression.** There
were three. The schematic was KiCad's 1.2 MB plot — a picture, so edits could not
change it, and unmakeable for an uploaded board because plotting one needs
KiCad. The bare layout was the routing view with the copper hidden. `tests.run 7`
asserts `renderSchematic` and `data-view="layout"` are *absent*, so they cannot
creep back unnoticed.

**The page's review prompt is generated.** `tools/sync_prompt.py` writes it into
`site/review.js` from `graph/prompts.py`; the builder refuses a stale copy.

**Join the schematic to the board on UUID, never on the designator.** Eleven of
the 53 footprints carry a silkscreen label like `LIN REG` in their `Reference`
field.

## The rules for the deterministic checks

`harness/checks.py` has one contract that matters more than any individual rule:
**every preset trips its own rule, and the clean board trips none.** Before
adding a rule, build a *correct* board that it might fire on — a three-wire
sensor header, a split ground, a board whose ground net is called `DGND` — and
check it stays quiet. Three rules failed exactly that test the first time.

## Verifying the page

```bash
.venv/Scripts/python.exe -m http.server 8731 --directory dist
```

then open `http://localhost:8731/preview.html`, which is the built page inside
the same skeleton the Artifact host wraps it in. `pcb-eval.html` is the file to
publish; it must carry no `<html>`, `<head>` or `<body>` tag of its own.

## Costs

The scored sweep is about $0.09 and four minutes. Re-scoring after a harness
change is free, because the cache is keyed on `(model, prompt)` — but changing a
prompt invalidates all of it, and `tests.run 13` will tell you the committed
result went stale.

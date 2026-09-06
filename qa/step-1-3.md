# Steps 1–3 — netlist.py, layout.py, build.py

**Verdict: PASS WITH DEFECTS**

All three "Done when" rows in PLAN.md §10 are met, verified against the source
files rather than the code's own output. `place()` is correct — proven against
KiCad's own plot, not just against the formula. The defects are in test
coverage and in error handling, not in the extracted numbers.

Reviewed at the tree of 2026-09-06 06:17 (`extract/build.py` 4870 bytes, with the
`t<i>`/`v<i>`/`z<i>` stable ids; `tests/run.py` 11313 bytes; `console.py` added).
An earlier revision was also checked and gave the same result.

## Evidence

**Counts, taken from the source with my own depth-tracking tokenizer**
(`scratchpad/indep_count.py`, no project code): direct children of `kicad_pcb`
are segment 400, via 63, footprint 53, zone 5, gr_arc 4, gr_line 4; pads with a
`footprint` parent 199, summing to 199 across 53 footprints. Matches step 2
exactly. No `arc` (curved track) elements exist, so `parse_tracks` handling only
`segment` loses nothing on this board.

**Netlist is the real export.** Re-ran
`kicad-cli sch export netlist --format kicadxml` against `STM32.kicad_sch`; the
output is byte-identical to the committed `boards/stm32-good.net.xml` apart from
the `<date>` line. Raw regex count and ElementTree agree: 53 `<comp>`, 62
`<net>`, 62 unique net names, 53 unique non-empty `<tstamps>`.
`/FB` (code 8) = `R2.2`, `R3.1`, `S1.4` with `pinfunction="VFB_4"` — exactly, no
extras. Also confirmed PLAN §7's other quoted net facts: `+5V` = C12.1 D2.2
J11.5 J2.1 J3.1 J4.2 J7.2 J8.2 L1.2 R2.1 U3.9; `VBST` = C4.2 S1.6;
`/TRIG` = J2.2 U2.38; `/ECHO` = J2.3 U2.39; `/STEPPER_IN4` = R11.2 U2.14 U3.4.

**Outline bbox.** Independently parsed the 4 Edge.Cuts `gr_line` and 4 `gr_arc`
and computed the true arc extents (circumcentre + axis-crossing sweep, not just
the mid point): x ∈ [57.0, 118.0], y ∈ [77.0, 123.001666] → **61.0 × 46.0017 mm**,
origin (57, 77). `layout.py` reports the same to the digit. The true-arc bbox
equals the endpoint bbox here, so `outline_bbox`'s mid-point shortcut is safe on
this board.

Cross-checked against KiCad's own crop: `layer-Edge.svg` draws its first point at
exactly `M3.0000 0.0000`, i.e. sheet (60, 77) → board (3, 0), pinning the origin
at (57, 77) with zero error. The **drawn geometry** in that SVG spans exactly
0…61.0 and 0…46.0017 — identical to the extractor. The `viewBox` KiCad wrote
(60.9854 × 45.9994) is ~15 µm/2 µm *smaller than KiCad's own geometry*; that is a
KiCad crop artefact, not an extractor error. Well inside the 0.1 mm tolerance.

**`place()` is correct — verified against the plot, not the formula.**
`scratchpad/svgmatch2.py` computes a world position for all 199 pads and looks
for a copper shape centre in `layer-F_Cu.svg` within 0.02 mm, then repeats with
four wrong transforms:

| transform | pads matched (all) | pads matched (33 rotated footprints, 95 pads) |
|---|---|---|
| `x·c+y·s, y·c−x·s` (shipped) | **199/199** | **95/95** |
| `x·c−y·s, x·s+y·c` (CCW) | 171/199 | 67/95 |
| `x·c−y·s, −x·s+y·c` | 173/199 | 69/95 |
| `y·c+x·s, x·c−y·s` | 66/199 | 6/95 |
| identity (no rotation) | 120/199 | 16/95 |

Named spot checks, all `d = 0.0000 mm`:

- **U1** SOT-223, sheet (102.8, 111.25) rot −90 → board (45.8, 34.25).
  pad 1 local (−3.15, −2.30) → world (48.100, 31.100); pad 2 → (45.800, 31.100);
  pad 3 → (43.500, 31.100). SVG pad centres identical, plotted 1.50 × 2.00 mm
  against a stored size of 2.00 × 1.50 — the aspect swap a −90° pad requires.
- **C2** 0805 rot +90 → pads (51.300, 36.100) and (51.300, 34.200), exact.
- **R1** 0402 rot 180 → (55.210, 30.200) and (54.190, 30.200), exact.
- **Y1** crystal rot −90 pad 1 → (19.500, 10.950), exact.
- **J2** 1×04 header rot −90 pad 1 → (37.800, 4.200), exact.
- **U2** LQFP-48 rot 0 pads 1 and 13, exact (control case).

`place()` also matches `x·cos+y·sin, y·cos−x·sin` to 1e-12 at 0/30/45/90/135/180/
−45/−90/270/359.5°, so the implementation is the formula, and the formula is what
KiCad plotted.

**Pad rotation is ABSOLUTE — it already includes the footprint rotation.**
Renderers must NOT add `footprint.rot` to `pad.rot`. Two independent proofs:
(a) every library footprint on this board whose pads have zero relative rotation
stores a pad angle exactly equal to the footprint angle normalised to 0–360
(U1 fp −90 → pads 270; C2 fp 90 → pads 90; C11/R1 fp 180 → pads 180; SW1 fp 180
→ pads 180; D3/FB1 likewise). (b) **J10**, fp rot 90, stored pad rot 90, stored
size 0.45 × 1.3, is plotted by KiCad as 1.300 × 0.450 — a 90° pad. Had the stored
angle been relative, the effective angle would be 90+90 = 180 and the aspect
would *not* swap. It does swap. Absolute, confirmed.
Pad `x`/`y` remain footprint-local and unrotated, so `place()` is required for
position and *not* for angle.

**UUID join is real** (`scratchpad/join.py`, straight from the two source files):
all 53 footprints carry a `(path "/<uuid>")`; the set of 53 path UUIDs is
*equal* to the set of 53 `<tstamps>` — exact 1:1, no leftovers on either side.
11 footprints carry a silkscreen label that is not the designator, and all 11
resolve correctly in `boards/stm32-good.json`:

```
USB→J10  WALL→J12  US→J2  UART→J3  SERVO→J4  LDR→J5
LED→J9   BUCK→S1   LIN REG→U1  STEPPER→U3  HSE→Y1
```

A designator join would drop exactly those 11. 0 footprints in the built board
have an empty `ref`.

**End-to-end consistency (steps 1+2+3 together).** Grouping PCB pads by net and
comparing with the netlist node lists: **61 of 62 nets have identical membership**.
`/FB` on the PCB is `R2.2, R3.1, S1.4`. Every net named in tracks, vias, zones
and pads exists in the netlist (0 orphans). The single difference is
`unconnected-(J10-Shield-PadSH)`: the netlist has `J10.SH`, and the PCB footprint
(`SamacSys:629105150521`) genuinely has no pad `SH` — it has MH1–MH4 instead.
That is a source-board symbol/footprint mismatch, not an extractor bug.

**Rebuild is deterministic and the artifact is current.** `python -m extract.build`
into a scratchpad output produces JSON byte-equal to the committed
`boards/stm32-good.json` once `meta.extracted` is dropped.

**`sexpr.py` adversarial probe** (`scratchpad/break_sexpr.py`). Correct on:
escaped quotes `\"`, parens and close-parens inside quoted strings, escaped
backslashes, empty strings, empty lists `()`, a list as a head, atoms before the
root. The `Str` distinction holds: in `(pad "1" smd …)` `node[1]` is `Str` and
`node[2]` is plain `str`; `(layer 1)` yields a bare atom while `(layer "1")`
yields `Str`, and `tag()` correctly refuses a `Str` head so a quoted `"1"` can
never be mistaken for a tag. Re-serialising both real files and re-parsing gives
an identical tree (`reparse-stable: True` for `.kicad_pcb` and `.kicad_sch`), so
nothing is lost on the real input.

**Schematic overlay spot-check** (`scratchpad/schcheck.py`, against
`schematic.svg`, viewBox 297.0022 × 210.0072). 52 of 53 designator texts in the
SVG fall within 6 mm of the bbox `schematic.py` computed. **R2** lands: computed
bbox [106.93, 170.18, 108.97, 175.26] (2.03 × 5.08 mm, the standard R symbol's
pin-to-pin extent centred on (107.95, 172.72)); the `R2` label in the SVG is at
(111.84, 172.08), immediately beside it. R3, C4, J4, Y1, U1, S1, J11 all land.
The one outlier is **U2**, whose designator text sits 16.4 mm above the box — but
that is a manually-dragged field, not a bbox error: U2's pin-name texts in the
SVG (`BOOT0` 133.86/74.58 … `PB9` 133.86/121.28 … `PA1` 163.32/73.03) and its
Value text `STM32F103C8T6` at (160.98, 144.40) all sit inside or on the computed
box [130.81, 62.23, 166.37, 143.51]. The Y-up→Y-down flip is right.
53 of 53 components got `sheet` coordinates.

## Findings

### 1. Step 3's acceptance check never executes `extract/build.py` — major

`tests/run.py:130` `check_build` only calls `load_board()`, which reads
`boards/stm32-good.json` off disk. It never imports `extract.build`, so the
join it is supposed to prove is not exercised; it asserts against whatever
artifact is lying around.

Reproduced: copied `extract/`, `tests/`, `boards/`, `console.py` to a scratch
directory, inserted `raise JoinError("SABOTAGE")` as the first statement of
`build()` in the copy, and ran `python -m tests.run 3`:

```
[PASS] step 3  extract/build.py writes boards/stm32-good.json
       . 11 footprints carry a silkscreen label, not a designator
1/1 steps pass
```

while `python -m extract.build` in the same tree dies with `JoinError: SABOTAGE`.

Correct looks like: `check_build` calls `build(NET_XML, DEFAULT_PCB, DEFAULT_SCH)`
itself and asserts on the returned dict, then separately asserts that the
committed `boards/stm32-good.json` equals that result with `meta.extracted`
dropped — which also catches a stale checked-in artifact. Keep the existing
assertions; they are otherwise good (the `renamed >= 10` one is the right test
for the §4.3 gotcha).

### 2. `place()` has no test at all — major

`extract/layout.py:19` is the transform every downstream view depends on, and
`tests/run.py` step 2 never calls it. A sign flip there would pass steps 1–6 and
only surface as a visibly wrong board at step 7.

Correct looks like: pin it with the golden values measured above, which came
from KiCad's own plot and are exact —

```python
from extract.layout import place
assert place(-3.15, -2.30, -90) == (2.30, -3.15)     # U1 (SOT-223) pad 1
# world: (45.8 + 2.30, 34.25 - 3.15) == (48.100, 31.100)
assert place(-0.95, 0.0, 90)  == (0.0, 0.95)         # C2 pad 1 -> (51.300, 36.100)
assert place(-0.51, 0.0, 180) == (0.51, 0.0)         # R1 pad 1 -> (55.210, 30.200)
```

(compare with `math.isclose`; the −90 case returns 2.2999999999999994.)
A stronger version, worth the twenty lines: assert that all 199 pads land within
0.02 mm of a filled-shape centre parsed out of
`Portfolio/media/pillmate/layer-F_Cu.svg`. That is what caught nothing here but
would catch everything later.

### 3. `sexpr.parse()` silently returns the last of several top-level forms — minor

`extract/sexpr.py:58`. `parse("(a 1) (b 2)")` returns `['b', '2']`; the first
form is parsed and thrown away because `root` is reassigned every time the stack
empties. KiCad files have exactly one top-level form, so this cannot bite today,
but it turns "I fed it two documents" into "I got the wrong one" with no signal.
Correct: raise on a second top-level form, or document that only the last is
returned.

### 4. `sexpr.parse()` raises `IndexError` on a stray close paren — minor

`extract/sexpr.py:68`. `parse("(a) )")` → `IndexError: pop from empty list`,
whereas the function's own contract raises `ValueError("unbalanced s-expression")`
for the other imbalance direction (`parse("(a (b")`). Guard the pop and raise the
same `ValueError`.

### 5. The tokenizer invents `\n`, `\t`, `\r` escapes that KiCad never writes — minor

`extract/sexpr.py:42` maps `\n`→newline, `\t`→tab, `\r`→CR. KiCad's own escaper
only ever emits `\\` and `\"`, so a two-character `\n` in a KiCad file is always
an escaped backslash followed by the letter n, which this handles correctly
(verified: reparse of both real files is stable, and `"C:\\net\\x"` decodes to
`C:\net\x`). But `parse('(a "line\\nbreak")')` with a *single* backslash yields a
real newline where the source meant the two characters. Since KiCad is the only
producer, drop the map and pass the escaped character through verbatim — that is
strictly closer to the format.

### 6. Missing Edge.Cuts fails with an opaque `min() arg is an empty sequence` — minor

`extract/layout.py:102`, reached from `parse_layout` at line 291. Reproduced on
three synthetic boards (no Edge.Cuts at all; footprints only; empty document).
The whole coordinate model rests on this origin, so the message should name the
cause: raise `ValueError("no Edge.Cuts geometry in <path>: cannot establish the
board origin")`. A one-line degenerate outline currently yields `h: 0.0` silently
as well.

### 7. `path.lstrip("/")` only normalises a flat schematic — minor

`extract/layout.py:179`. On this board `<tstamps>` is a bare UUID and `(path)` is
`/<uuid>`, so stripping the slash is exactly right and the join is 53/53. On a
*hierarchical* schematic KiCad writes `/<sheet-uuid>/<symbol-uuid>` in both
places, and `lstrip` would leave `sheet/symbol` against a `<tstamps>` of
`/sheet/symbol` — every part would fail to resolve. `build()` does raise
`JoinError` in that case rather than silently dropping parts, which is the right
failure mode, so this is a latent portability note, not a live bug. Also
`lstrip("/")` is character-class based; `removeprefix("/")` says what is meant.

### 8. `(ref, pad number)` is not a unique key — minor, matters from step 4 on

Measured in the built board: 10 pads have an empty `num` (H1–H4 mounting holes,
one each; SW1, six — four SMD and two `np_thru_hole`), and two pad entries
collide outright: `('SW1', '')` appears 6 times and `('U1', '2')` twice (the
SOT-223 tab is a second pin 2). Nothing in steps 1–3 depends on it, but
`harness/ops.py`, `checks.py` and the renderer will all want to address a pad,
and `f"{ref}.{num}"` will alias these. Give each pad a stable index-based id in
`build.py` the way tracks, vias and zones now get one.

## Not checked

- **Back-layer footprints.** All 53 are on F; `place()` has no mirror handling
  and `parse_footprints` records `layer: "B"` without anything consuming it. I
  could not test whether a B-side pad places correctly because the board has
  none. Flag it before step 7 renders a two-sided board.
- **Mirrored schematic symbols.** 15 symbols carry `(mirror x|y)` (J2, J3, J4,
  J10, S1, C4, D1, D2 plus power flags). `_transform` applies mirror before
  rotation; for the 90°-multiple rotations on this sheet the resulting *bounding
  box* is identical either way, so the ordering is untested. The bboxes land
  correctly on the SVG, which is all step 3 needs.
- **Non-90° footprint rotations.** None exist on this board, so `place()` at
  arbitrary angles was only checked against the formula, not against a plot.
- **`gr_circle` / `gr_rect` / `fp_poly` outline branches** in `parse_outline` and
  `_graphics`: no such elements on this board. Synthetic `gr_rect` input parsed
  correctly; `gr_circle` untested against real data.
- **Zone `filled_polygon` fidelity.** I confirmed the five zones' nets, layers
  and point counts (`GND` on B.Cu has 4818 fill points) but did not compare the
  fill geometry to `layer-B_Cu.svg`.
- **`min.json`.** `build.py` also writes `boards/stm32-good.min.json`; nothing in
  `tests/run.py` asserts the two files agree.

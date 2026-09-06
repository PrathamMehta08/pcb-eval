# Steps 7, 9, 10, 11 — render, editing UI, review, publish

**Verdict: FAIL** — step 7 PASS, step 10 PASS WITH DEFECTS, step 11 PASS,
**step 9 FAIL**. One blocking defect: nothing in the board views can be
selected by clicking, so the track, via, pour and pin editors are unreachable
in a real browser. `tests/run.py 7 9 10 11` all pass; step 9's check does not
test what it claims to.

Driven for real in Chrome against `dist/preview.html` on the local server:
clicks, drags, keyboard, both themes, mobile width, and a stub `window.claude`
injected ahead of the page to exercise the review path.

## Evidence

**Step 7 — the layout against KiCad's own plots.** Numeric, not eyeballed;
every board element compared against `Portfolio/media/pillmate/layer-*.svg`.

- **Tracks: 400 of 400 exact.** Parsed every stroked `M x y L x y` path out of
  `layer-F_Cu.svg` (379) and `layer-B_Cu.svg` (21) and matched endpoints (0.01 mm),
  stroke width and layer against `board.layout.tracks`. 379 F.Cu + 21 B.Cu
  matched; **0 only-in-KiCad, 0 only-in-JSON, on either layer.** Nothing is on
  the wrong layer and no width is wrong.
- **Pads: 199 of 199 within 0.03 mm.** Placed every pad through `place()` and
  matched against the filled pad outlines and circles in `layer-F_Cu.svg`
  (384 shapes). Every pad found a plotted shape; sizes agree within 0.12 mm
  except J4.1 and J6.1, where my nearest-shape matcher grabbed the coincident
  0.5 mm drill circle rather than the 0.85 mm rect pad — a matcher artefact,
  checked by hand against the source, not a render defect.
- **Holes: 61 of 61.** Every drill mark in `layer-Edge.svg` coincides with a THT
  pad or via hole in the board JSON, radii within 0.02 mm; no KiCad hole is
  missing from the page.
- **Outline arcs are right.** The rendered `.substrate` is one closed path
  `M 0,3 A3 3 0 0 1 3,0 L58,0 A3 3 0 0 1 61,3 L61,43.1 A3.002 … Z`. Sampled at
  400 points: bbox exactly `0,0 → 61,46.002`; points in each corner quadrant lie
  on the r=3 circle to within **0.0011 mm** (TL 0.0008, TR 0.0008, BL 0.0011).
  Matches KiCad's four `A3.0000 3.0000` arcs including the odd r=3.0017
  bottom-right one. KiCad's own viewBox is 60.9854 × 45.9994 against our
  61 × 46.0017 — that 0.015 mm is KiCad's arc-bbox rounding in its crop, not ours.
- **Zones are fills, not outlines.** 5 `<polygon>` nodes, `stroke:none`,
  fill `--f-cu`/`--b-cu`: z0 /VIN_LDO, z1 VBUS, z2 +3.3V, z3 GND (all F.Cu) and
  z4 GND on B.Cu spanning the whole board, 4818 points, keyholes around every
  pad and via. Overlaying `layer-B_Cu.svg` at 50 % over the routing view shows
  the same shape. Source has 5 zones and 5 `filled_polygon` blocks, so no island
  was concatenated.
- **Silk: 184 of 184 primitives drawn** (177 line, 4 arc, 2 poly, 1 circle),
  which is exactly what the source carries on F.SilkS. 173 of the 177 lines
  match a plotted line in `layer-F_SilkS.svg` exactly; the other 4 are
  zero-length (finding 4).
- **All three views render.** Schematic is KiCad's plot nested at
  viewBox `0 0 297 210` with 53 symbol hit boxes; painting them cyan and zooming
  on the MCU shows each box sitting on its own symbol. Routing draws 400 tracks,
  199 pads, 63 vias, 5 zones. Clean load: **no console messages, one network
  request** (the document itself).

**Step 9 — driven by hand.**

- Drag: grabbing D1's pad and dragging +60/−40 device px moved it from
  (48.000, 25.500) to (52.099, 22.767) mm — 4.098/−2.732 mm at the measured
  14.64 px/mm, exact. One log line, `D1: moved to (52.10, 22.77) mm`. Both pads
  moved with the body (screen positions shifted by exactly +60/−40). Tracks
  correctly stayed put.
- Undo after that drag made the rendered SVG **byte-identical** to the
  pre-drag snapshot (208 326 chars both).
- All seven presets: applied, then undone to empty. Rendered SVG identical to
  pristine every time (comparing with selection/highlight classes stripped —
  the only difference was `net-lit`/`selected` left by the lingering selection).
  ground-stranded is 42 edits, 63→22 vias and 5→4 pours, all restored.
- Adversarial: undo past the beginning is a no-op (button disabled, five extra
  clicks changed nothing); ground-stranded applied twice gives the same 42
  edits; ground-stranded → 20 undos → vfb-vbst-swap resets cleanly to 2 edits
  with vias back at 63 and pours at 5, then undoes to pristine.
- Part inspector (reachable only via a preset — see finding 1): value edit,
  rotate 90°, net dropdown and ⇆ swap all record one correct entry each
  (`S1: value 'TPS563208DDCR' → 'NOT-A-PART'`, `S1: rotated to 90°`,
  `S1.1: GND → +5V`, `S1: pin 2 ↔ pin 3 (/SW ↔ /IN)`); re-rotating to 90° and
  re-picking the same net are refused with a flash rather than logged; arming a
  swap and clicking the same button again disarms; **Escape mid-swap disarms and
  records nothing**. Six mixed edits undid back to a byte-identical render.

**Step 10 — with a stub `sample` injected before the page.**

- No call on load: exactly one `claude.use("sample")`, zero `sample.json`.
- One click → one call, prompt 6 730 chars, opts `{modelTier:"default",cache:true}`.
  Findings render, grading is by ref/net overlap (clean board → 0 caught,
  0 missed, 2 also raised; after vfb-vbst-swap → 1 caught of 1, 1 also raised),
  and the two findings are ringed on the board at C1 (51.300, 29.500) and
  S1 (33.050, 32.700).
- Cache: re-reviewing the same board makes **no** call, does not decrement the
  budget, does not start a cooldown, and says "Replayed from this browser's
  cache — no call was made."
- Cooldown: the button really disables and counts down — measured "Review in
  10s" at +0.3 s, "Review in 1s" at +9 s, enabled again at +10 s.
- Both survive a reload: after reloading, budget read "23 of 25 left · 2 cached"
  and the button resumed at "Review in 4s".
- Session cap: with the counter at 25, a click on an uncached board made no call
  and flashed the right copy; a cached board still replayed.
- `sample` genuinely absent (plain `preview.html`, no `window.claude`): the
  button is hidden, the panel explains why, nothing throws.

**Step 11 — the built file.** 1 534 188 bytes = **1.463 MB of 16 MB**. One
`<title>PCB Eval</title>` in the first 8 KB. **No** `<html>`, `<head>`, `<body>`
or doctype of its own (`<header>` is the only `<head` substring). Exactly one
external reference, the Google Fonts stylesheet — no external scripts, no
`fetch(`, `XMLHttpRequest`, `WebSocket`, `import(`, `new Worker`, `@import` or
`url(http` anywhere in the file, so nothing the artifact CSP blocks. Three
`<script>` tags, two `application/json` and one inline module. `claude.use(`
appears once, in `getSample()`; `sample.json(` appears once, inside `review()`,
which is reached only from `$("go").addEventListener("click", runReview)`. A
"PCB Eval" artifact does exist at the URL the README cites, owned and private,
updated today.

## Findings

### 1. Clicking anything in the board views never leaves it selected — blocking

`site/render.js:479-495` takes pointer capture on the SVG root on every
`pointerdown` (line 493, and again in `site/app.js:130` for a footprint drag).
Pointer capture retargets the following `click` to the capturing element, so the
listener at `site/app.js:75-78` sees `event.target === <svg>`, finds no
`[data-kind]` ancestor, and calls `select(null)`.

Reproduced with a real mouse click on a U2 pad, with a MutationObserver on
`#inspector`: the panel goes to `"U2 STM32F103C8T6 …"` and then, in the same
gesture, back to `"Click a part, a track, a via or a pour…"`. The event log for
that one click is:

```
pointerdown  rect  class="pad"      data-kind="pad"
pointerup    svg   class="board-svg" (retargeted by the capture)
click        svg   class="board-svg" (retargeted by the capture)
```

A track behaves worse: `startDrag` returns false, `attachPanZoom` takes the
capture for a pan, and the click clears the selection that was never made.
Clicked track `t121` (+3.3V) at its own centre, confirmed by `elementFromPoint`
— inspector unchanged.

Consequence: **four of the nine operations have no path to them in the running
page.** `delete_track`, `set_track_width`, `delete_via` and `toggle_zone` all
live in inspectors that only `select()` can open, and the only surviving caller
of `select()` with something selected is `applyPreset`, which always selects a
part. Step 9's "delete a track, reassign a pin" is not doable by hand; the
routing view — the view the whole project argues for — is read-only.

Correct: the selection has to come from the pointer, not from a `click` that
capture has moved. Either drop the `click` listener and select in the `pointerup`
handler from the element the `pointerdown` landed on, or do not
`setPointerCapture` until the pointer has actually moved far enough to be a
pan/drag.

### 2. With localStorage unavailable, three of the four rate limits silently vanish — major

`site/review.js:71-87` swallows every localStorage error, which keeps the page
alive (good) but leaves `budget`, `coolingDownMs` and `reviewCache` permanently
empty, so `review()` at lines 199-207 never refuses anything and the cache never
hits.

Reproduced by loading the page in a document where `localStorage` throws
`SecurityError` on access (a private window, or a browser with site data
blocked). Three clicks on Review inside one second produced **three live
`sample.json` calls for the identical, unedited board**; the button never
disabled, the budget stayed "25 of 25 left · 0 cached". Only "never on load"
still holds. Money is spent on the viewer's account, so this is the one limit
failure that costs someone something.

Correct: mirror the counter, the last-review timestamp and the cache in module
memory, write through to localStorage when it works, and read from memory when
it does not. The limits then hold for the session even with storage blocked.

### 3. `tests/edit_cycle.mjs` asserts UI reachability with a string search — major

`tests/edit_cycle.mjs:79-81`:

```js
for (const name of Object.keys(OPS)) {
  check(app.includes(`op: "${name}"`), `app.js has no control that records ${name}`);
}
```

and it reports "all 9 operations are reachable from the UI". `app.js` contains
the literal `op: "delete_track"`, so the check passes while the control is
unreachable (finding 1). Line 88, `check(/pointerdown|startDrag/.test(app),
"app.js wires dragging")`, is vacuous in the same way. `tests/run.py:432-437`
then records in a comment that pointer events "were driven by hand" — the
preset path was, but clicking to select was not, or finding 1 would have
surfaced.

Correct: this one genuinely needs a browser. Either drive it (the four routing
edits, by click, in a headless Chrome) or delete the claim and say in the step's
note which operations are covered and which are not.

### 4. Zero-length silkscreen segments render as nothing — minor

Four of the 177 placed F.SilkS lines have identical endpoints — J10 at
(52.90, 16.68) and (53.00, 16.68), J12 at (17.04, 31.60) and (17.10, 31.80) —
which is how KiCad draws a pin-1 dot. `.fp-silk` in `site/index.html:177` sets
no `stroke-linecap`, so the SVG default of `butt` paints a zero-length line as
nothing, while KiCad's plot (`stroke-linecap:round`) shows a dot. Add
`stroke-linecap: round` to `.fp-silk`.

### 5. A track width of 999 mm is accepted; 0 and negative are refused in silence — minor

`site/app.js:424-427` guards only `mm > 0`. The `max="5"` on the number input at
line 420 is not enforced for a typed value, and `site/ops.js:150-160`
`set_track_width` validates nothing, so `999` is recorded and drawn. `0`, `-1`
and non-numeric input are dropped with no flash, so the field just appears not
to work. Clamp in `OPS.set_track_width` (0.05–5 mm is what the input advertises)
and flash the refusal like the other operations do.

Not reproducible through the UI today because of finding 1; read out of the
source and confirmed against the input's attributes.

### 6. A footprint's body is not a grab target — minor

`footprintNode` draws pads, silk lines and a label, but nothing filling the
body, so `.footprint { cursor: move }` (`site/index.html:204`) is a lie over most
of a part. Reproduced: dragging from D1's centre (710, 422) — between its two
pads — panned the view instead of moving the part; the same drag started 27 px
lower, on a pad, moved it. On a 0402 the pads are the only target at all. An
invisible `fill: transparent` rect over each footprint's pad bbox, inside the
group, would fix it.

### 7. The two viewport overlays collide at mobile width — minor

At 375 px the layer chips (`.overlay-tl`, `left: 12px; bottom: 12px`) and the
Fit/hint row (`.overlay-br`, `right: 12px; bottom: 12px`) overlap into one
unreadable line: `F.CU ● B.CU FIT SILK ⇱ REFS … to zoom · drag to pan`. No
horizontal page overflow otherwise (`scrollWidth` 375 = `innerWidth` 375), and
the stacked layout is fine. Stack the two overlays, or drop the hint text below
900 px where it is not true anyway (there is no scroll wheel).

### 8. The board is entirely keyboard-inaccessible — minor

The board SVG has no `tabindex`, no `role`, no `aria-label`, and nothing inside
it is focusable, so no part, track, via or pour can be reached or edited without
a mouse. The tab strip is `role="tablist"` + `role="tab"` with no `aria-controls`
and no `role="tabpanel"`, and no arrow-key roving; the layer chips are toggles
with no `aria-pressed`. Focus visibility itself is fine — `:focus-visible` gives
a clear 2 px mint ring, verified by tabbing to the Layout tab.

## Not checked

- **`capabilities: {sample: {}}`.** The declaration is a publish-time parameter
  and is not in the file, so nothing in the repo or in the artifact's HTML can
  confirm it. Reading the published artifact confirms it exists, is owned and
  private, 1.5 MB, and carries the same page — but not what it declares. Someone
  has to open the artifact as a viewer and press Review once.
- **Whether `window.claude.use("sample")` itself prompts the viewer.**
  `boot()` calls `getSample()` on load, which the plan says is safe. If `use()`
  prompts rather than only resolving, that is a consent dialog on page load. Not
  testable against a stub.
- **The four routing edit controls end to end** (delete track, set width, delete
  via, toggle pour). Their operations are covered by `tests/edit_cycle.mjs` and
  by the ground-stranded preset, which exercises `delete_via` and `toggle_zone`
  41+1 times; the inspector panels that expose them cannot be opened at all
  until finding 1 is fixed.
- **`canonical()` on the live board.** Nothing is exposed on `window`, so the
  undo-identity check in the browser is a byte comparison of the rendered SVG
  plus the pin tables, not of the canonical text. The canonical/hash identity is
  covered in node (`tests/edit_cycle.mjs`, hash `fdbf9eacfc0782bf` before and
  after), and the page's own review cache key for the untouched board is that
  same `fdbf9eacfc0782bf`, so the two agree.
- **The published artifact is a build from before this review.** Whatever fixes
  land for findings 1 and 2 need a republish to the same URL.

# Steps 4, 5, 6, 8 — ops.py, checks.py, distill.py, ops.js

**Step 4: PASS** · **Step 5: PASS WITH DEFECTS** · **Step 6: FAIL** · **Step 8: PASS WITH DEFECTS**

`python -m tests.run` reports 7/7. `node tests/ops_parity.mjs` and
`node tests/distill_parity.mjs` both exit 0. I did not stop there.

---

## Evidence

### Step 4 — undo exactness, and whether `canonical` can hide a mutation

I enumerated all nine operations against the canonical text mechanically: apply
one op, diff the whole board JSON path-by-path, and check the canonical text also
changed. **All nine change it. No operation mutates a field `canonical` omits.**

| op | JSON paths changed | canonical changed | undo deep-equal |
|---|---|---|---|
| move_pin | 2 | yes | **no** (node order) |
| swap_pins | 93 | yes | **no** (node order) |
| set_value | 1 | yes | yes |
| move_footprint | 2 | yes | yes |
| rotate_footprint | 1 | yes | yes |
| delete_track | 1 | yes | yes |
| set_track_width | 1 | yes | yes |
| delete_via | 1 | yes | yes |
| toggle_zone | 1 | yes | yes |

So the "board hash returns to the original" claim is sound — the hash is not
blind to any op. All seven presets restore the exact hash `fdbf9eacfc0782bf`.
Five of the seven do **not** restore the board deep-equally (see finding 6).

### Step 5 — `net-island`, verified independently against the source

I wrote a connectivity checker with no project code in it at all
(`scratchpad/fromsrc.py`): own s-expression tokenizer over
`C:\Users\pratham\Documents\PCBs\STM32\STM32\STM32.kicad_pcb`, own geometry —
**exact rotated rectangles** for pads (not discs), capsules for tracks, discs for
vias, raw `filled_polygon` rings for zones, proper segment/segment and
polygon distance. It reads 53 footprints, 199 pads, 400 segments, 63 vias, 5 zones
straight out of the source.

Result: **61 nets carry copper and every one of them is a single island.**
GND = 44 pads in one island, +3.3V = 20, +5V = 11, /FB = 3, VBUS = 2, /VIN_LDO = 4.
`harness.checks.islands()` reports exactly the same: 61 nets, `all(len(v)==1)`.
The clean-board silence is real, not an artefact of the model.

**The pad model does not matter.** Swapping the disc radius between
`max(w,h)/2` (shipped), the mean, and `min(w,h)/2`, and separately using the exact
rotated rectangle, all give **0 nets with more than one pad-island**, at both
TOL = 0.02 and TOL = 0.0:

```
padmodel=exact  TOL=0.02  nets with >1 pad-island: 0
padmodel=exact  TOL=0.0   nets with >1 pad-island: 0
padmodel=max    TOL=0.02  nets with >1 pad-island: 0
padmodel=min    TOL=0.0   nets with >1 pad-island: 0
```

So the over-estimate never falsely merges anything on this board, and the answer
does not depend on the pad model. Margin: pushing the tolerance negative
(demanding real overlap) first splits nets at −0.02 mm, and only the four
zone-attached nets (`+3.3V`, `GND`, `VBUS`, `/VIN_LDO`), which is the expected
thermal-relief geometry, not a bug. The stranded board gives **28 GND
pad-islands, sizes [12, 3, 2, 2, 2, 1×23]** under all three pad models
identically — the defect is detected robustly, not marginally.

`site/copper.js` is a faithful transliteration of the geometry half of
`checks.py` (I read both line by line; the only differences are `Math.hypot` for
`math.dist` and JS `&&` short-circuit for Python's nested `if`, both equivalent),
and it is exercised transitively by `distill_parity.mjs` because the island count
appears in the COPPER section.

### Step 5 — are the seven rules real rules?

Each preset trips **exactly one** rule, its own, and the clean board trips none.
I measured each rule's real surface on the clean board and then mutation-tested it.

| rule | objects it evaluates on the clean board | same-class mutations that fire |
|---|---|---|
| power-pin-miswired | **13 constrained pins** (of 126 with a `pinfunction`) | 7 of 7 |
| connector-no-reference | 9 headers with ≥3 pins | fires on J3 stripped of its rails |
| connector-power-order | 3 (J4, J7, J8) | fires on J7 and J8 too |
| **sensor-pinout-order** | **1 (J2 only)** | **0 of 4** |
| floating-driver-input | 8 nets containing an input pin | 4 of 4 |
| unbuildable-value | 28 R/C/L parts | fires on C1, L1, `''`, `'TBD'` |
| net-island | 61 nets of copper | see above |

`power-pin-miswired` is a real rule, not a lookup: 13 pins on this board are
constrained (`U2.44 BOOT0_44`, `U2.7 NRST_7`, `U3.13/14/15/16 O1–O4`,
`S1.2 SW_2`, `S1.1/U1.1/U3.8/J10.5 GND_n`, `S1.6 VBST_6`, `J10.1 VBUS_1`), and
moving any one of them fires the rule with the right message. Its limits are in
findings 2 and 3.

`sensor-pinout-order` is the one that does not survive. See finding 1.

### Step 6 — token budget under a real tokenizer

`approx_tokens` does use tiktoken (`o200k_base`, 0.14.0 installed) — that half of
the claim is honest. But the number the test measures is not the number the page
sends. Counting the **project's own** `tests/fixtures/distill.json`, which is the
exact text `site/distill.js` produces:

```
clean                 focus=['U3','S1']    3207 tokens
vfb-vbst-swap         focus=['S1']         3104
stepper-common-open   focus=['J11','U3']   3102
servo-power-end-pin   focus=['J4']         3050
ultrasonic-crossed    focus=['J2','U2']    3126
stepper-in4-floating  focus=['R11','U3']   2991
unbuildable-value     focus=['R4']         3136
ground-stranded       focus=[]             2841
```

**Six of the eight boards in the corpus are over 3000 tokens.** cl100k_base 2869
and p50k_base 2885 for the no-focus clean board, so the choice of encoding is not
what is carrying it.

### Step 8 — cross-language divergence, found

Two reproducible disagreements between the Python and the JavaScript, neither of
which the fixture can see. Findings 7 and 8.

`fixed()` against `toFixed`: I brute-forced **135,105** cases (every `i/2`,
`i/20`, `i/200`, `i/8`, `i/16` up to 200, plus 25,000 random doubles, at 0, 1 and
2 places, floats passed as round-tripping literals). Exactly **3** disagreements,
all negative zero. Everything else, including every half-way tie, matches. The
Decimal/ROUND_HALF_UP approach is correct.

---

## Findings

### 1. `sensor-pinout-order` is a detector for the injected edit, not a rule — major

`harness/checks.py:187-220`. After its guards it reduces to one comparison:
`int(trig_pin) < int(echo_pin)`. It never checks VCC or GND, despite the
docstring claiming "A four-pin ultrasonic header is VCC, TRIG, ECHO, GND, in that
order". On the clean board exactly one object (J2) reaches that comparison.

Every other instance of the same defect class is invisible. Reproduced on the
clean board:

```
J2 swap 1<->4 (VCC and GND swapped, back-powers the module)   SILENT
J2 swap 1<->2 (+5V driven onto TRIG)                          SILENT
J2 swap 3<->4 (ECHO on the ground pin)                        SILENT
J2 swap 2<->3 but nets renamed /US_T and /US_E                SILENT
```

The last one matters most: the rule fires only because the designer happened to
name the nets `/TRIG` and `/ECHO`. Rename them and the identical defect passes.

Correct looks like: check the whole declared pinout, not one ordering. Take the
four nets on a four-pin header, require exactly one supply and one ground, and
assert supply on pin 1 and ground on pin 4 with the two signals between them;
keep the TRIG/ECHO ordering as an additional clause rather than the only one.
That fires on all four mutations above and still stays quiet on the clean board
(J2 = +5V, /TRIG, /ECHO, GND) and on J6 (+3.3V, SWDIO, SWCLK, GND — supply pin 1,
ground pin 4, correct).

### 2. Three rules false-fire on plausible correct boards — major

Each reproduced by building a variant board and running `run_checks` on it.

**`connector-power-order`** (`checks.py:150`) assumes any three-pin header with
one supply, one ground and one signal is a hobby servo. Add a perfectly correct
three-pin analogue sensor header — `J13 = (+3.3V, /TEMP, GND)`, the pinout of a
TMP36, a hall sensor or a three-wire fan — and it fires:

```
connector-power-order: J13: +3.3V is on end pin 1, not the middle pin
```

Correct looks like: gate on something that says "servo" — the symbol/footprint
name, the description, or a net name matching `SERVO` — rather than on pin count
alone. All three real instances here (J4, J7, J8) carry `/SERVO_n`.

**`power-pin-miswired`** (`checks.py:81`) fires on a split-ground layout, which is
standard practice for a buck. Move `S1.1 (GND_1)` onto a separate `PGND` star
point, leaving everything else correct:

```
power-pin-miswired: S1 pin 1 (GND_1) is on PGND, not GND
```

**`connector-no-reference`** (`checks.py:119`) depends on `GROUND_PATTERN`
recognising the ground net's name. Rename `GND` to `DGND` board-wide — same
board, same topology, a common convention — and it fires on J12.

None of these break the step-5 contract on this board. They are the reason the
clean-board silence should not be read as "these rules generalise".

### 3. `power-pin-miswired` sees only half of preset 1, and misses the worse version — minor

`checks.py:99`. `S1.4`'s `pinfunction` is `VFB_4`, so the declared name is `VFB`
and the net is `/FB` — no match, so pin 4 places no constraint. Reproduced:

```
move_pin(S1, 4, VBST) alone   ->  SILENT
move_pin(S1, 4, GND)  alone   ->  SILENT   (VFB tied to ground; output pins high)
```

The preset only trips because its *second* edit moves `S1.6 (VBST_6)` off `VBST`.
Worth stating in the docstring, since the preset table implies the rule catches
the feedback half.

### 4. `floating-driver-input` is silenced by any passive, including a capacitor — minor

`checks.py:241`. `has_passive` is any passive pin on the net, not a pin that
defines a DC level. A capacitor or a series resistor satisfies it while the input
still floats at reset. Reproduced — preset 5 plus one capacitor pin dragged onto
the now-floating net:

```
move_pin(R11, 2, /STEPPER_IN1) ; move_pin(C15, 1, /STEPPER_IN4)   ->  SILENT
```

Correct looks like: require a passive that reaches a rail — walk the other pin of
the two-terminal part and check it lands on something `is_rail`.

### 5. `net-island` reports the wrong refs — major

`checks.py:501-508`. `stranded` is computed from `counts`, which is **sorted by
size**, but `refs` is computed from `with_pads[1:]`, which is **dict insertion
order**. The two describe different partitions. On the ground-stranded preset the
largest island is at index 14, not index 0:

```
pad-island sizes in dict order: [1,1,1,3,1,1,1,1,2,1,2,2,1,1,12,1,...]
reported refs wrongly INCLUDE (they sit on the surviving island):
    J12 J2 J3 J4 J6 J7 J8 J9 U3
reported refs MISS: C1
```

The count in the title (32 stranded of 44) is right; the ref list is 9 wrong and
1 short. This matters because §5.3 and §8 grade findings by ref overlap, so the
deterministic detector is handing the grader a ref set that does not match the
copper it just described.

Correct looks like: pick the largest group once and derive both numbers from it —
`main = max(with_pads, key=pad_count)`, then `stranded` and `refs` from
`[g for g in with_pads if g is not main]`.

### 6. Undo restores the hash but not the board; the fixture cannot tell — minor

`ops.py:110`, `ops.py:148`, `ops.js:60`, `ops.js:81`. `move_pin` and `swap_pins`
remove a node and **append** it, and their undos append too, so node order inside
`net.nodes` never comes back. `canonical` sorts nodes, so the hash matches anyway.
Five of the seven presets end deep-unequal after a full undo:

```
vfb-vbst-swap        hash=True deep-equal=True
stepper-common-open  hash=True deep-equal=False  12 paths
servo-power-end-pin  hash=True deep-equal=False  83 paths
ultrasonic-crossed   hash=True deep-equal=False  16 paths
stepper-in4-floating hash=True deep-equal=False  12 paths
unbuildable-value    hash=True deep-equal=True
ground-stranded      hash=True deep-equal=True
```

Nothing downstream reads node order (distill sorts too), so this is not a live
bug. It is a test blind spot: `undo_hash` is checked only up to canonical
equivalence, so an undo that reinserted a deleted track at the wrong index would
also pass. `delete_track`/`delete_via` do restore the index correctly today — I
checked with a full deep diff, not with the hash.

Correct looks like: `tests/fixture.py:97-101` should assert
`json.dumps(work, sort_keys=True) == json.dumps(board, sort_keys=True)` in
addition to the hash, and `move_pin`/`swap_pins` undo should insert the node back
at its recorded index.

### 7. `set_track_width(0.15005)` gives two different board hashes — major

`ops.py:253` uses `round(float(mm), 4)`; `ops.js:245` uses
`Math.round(v*1e4)/1e4`. Python rounds half-to-even on the decimal, JavaScript
rounds half-up on the scaled binary. Reproduced end to end:

```
edit: {"op":"set_track_width","args":{"track_id":"t0","mm":0.15005}}
python board_hash  ca192d90d8ce22ec
js     boardHash   e2c96fdc5e5755bf      *** DIVERGE ***
```

(`round(0.15005,4)` = 0.15, `Math.round(0.15005*1e4)/1e4` = 0.1501.)

I brute-forced 280,015 values through `mm(round4(v))` in both languages:
0 of 50,000 random doubles disagree, 0 of 50,000 values rounded to 3 or 4 places,
0 of 20,000 on a 0.05 mm grid — but **2,166 of 50,000 values rounded to 5 places**
and 4,427 of 20,000 exact `i/20000` ties do. So this is latent, not routine, but
it is reachable: `site/app.js:426` passes the raw `Number(input.value)` from the
width field and `site/app.js:126` passes raw pointer floats, neither snapped.

It matters beyond the fixture because the board hash is the review cache key
(§5.4) — a divergence means the page and the harness cache the same board under
different keys.

Correct looks like: define one rounding in both, e.g. Python
`float(Decimal(v).quantize(Decimal('1e-4'), ROUND_HALF_UP))` to match
`Math.round`, or scale-and-round identically in both. Add a fixture case with a
five-decimal argument so the parity test would have caught it.

### 8. `distill.fixed()` disagrees with `toFixed` on negative zero — minor

`distill.py:44` has no negative-zero guard, while `ops.py:345` (`mm`) does.
`str(Decimal(-0.0).quantize(...))` is `"-0.0"`; `(-0).toFixed(1)` is `"0.0"`.
Reproduced end to end through the placement section:

```
edit: {"op":"move_footprint","args":{"ref":"C6","x":-0.00001,"y":-0.00001}}
py:  "  C6 (-0.0, -0.0) 90 deg F.Cu, edited"
js:  "  C6 (0.0, 0.0) 90 deg F.Cu, edited"
```

The board hash still matches (because `mm` guards), so this is a silent text
divergence: the harness would score a string the page never sent. Reachable
whenever a drag lands a footprint a hair left of or above the Edge.Cuts minimum,
which is inside the board area the UI allows.

Correct looks like: give `fixed()` the same guard `mm()` has — `if value == 0:
value = 0.0` before quantising. This was the only class of disagreement in
135,105 brute-forced cases, so fixing it makes the two exactly equivalent over
the reachable domain.

### 9. The distilled board the page actually sends is over the 3000-token budget — blocking

`harness/distill.py`, `tests/run.py:260-266`. Step 6's check measures
`distill(board)` with **no focus refs**, which is 2845 tokens. The page never
sends that string: `site/app.js:501` derives `focusRefs()` from the edit log and
`site/review.js:209` passes it to `distill`, so every edited board carries a
PLACEMENT section. Measured on the project's own `tests/fixtures/distill.json`
with `tiktoken.o200k_base`: **2991 to 3207 tokens, 6 of 8 boards ≥ 3000**
(table above). The worst case is the clean board at 3207.

Correct looks like: `check_distill` should measure the same eight texts the
fixture stores, not one text with an empty focus. Then either raise the cap or
trim — the PLACEMENT section is 250–360 tokens and the 12-word descriptions and
the UNCONNECTED block are the next largest levers.

### 10. Step 6's coverage assertions are vacuous substring tests — major

`tests/run.py:268-283` asserts `comp["ref"] in text` and `net["name"] in text`.
Both are substring tests on a 5 KB blob, so they pass on refs and nets that are
entirely absent. Reproduced by deleting `C1` from the BOM line and the whole
`/SW:` line from the distilled text and re-running the assertions verbatim:

```
C1 still listed in the BOM?  False
assertion "C1"  in text -> True   (matched C12, C14, C15,C16)
assertion "/SW" in text -> True   (matched /SWCLK:, /SWDIO:, /SW_BOOT0:)
```

Every ref of the form `C1`, `R1`, `J1`, `D1`, `U1`, `H1` and every net that is a
prefix of another (`/SW`, `/O1`, `GND`, `+3.3V`) is unprotected. The loops also
`break` on the first failure, so one miss hides the rest.

Correct looks like: tokenise the distilled text once
(`set(re.findall(r"[A-Za-z0-9_+./()-]+", text))` plus the comma-split BOM refs)
and assert membership in that set. I ran that stronger check against the real
output: 0 refs missing, 0 values missing, 0 nets missing — so the claim itself
holds today, only the test does not prove it.

### 11. The distilled board names the parts the visitor just edited — major

`harness/distill.py:233` emits `PLACEMENT near the edited parts` and marks the
focus part `, edited`. `site/app.js:501` builds that focus from the edit log, so
for six of the seven presets the prompt ends with the injected component's ref
and the literal word "edited". On the clean board `focusRefs()` returns `[]`, so
the whole block is absent — meaning the *presence* of the section is itself a
signal that the board was tampered with.

§8 scores recall by ref overlap and false alarms on the clean board. Both numbers
are compromised if the prompt names the answer. `tests/fixture.py:111` already
half-notices this by giving the clean board a synthetic `["U3","S1"]` focus, but
`app.js` does not.

Correct looks like: either send placement for a fixed set of refs regardless of
what was edited, or send it for every board and drop the "edited" marker and the
"near the edited parts" heading.

### 12. `tests/run.py` step 8's Python half is tautological — minor

`tests/run.py:306-311` recomputes each fixture hash with the same
`harness.ops.board_hash` that generated `tests/fixtures/ops.json`. It can only
detect a stale fixture, never a wrong hash. The real check is `ops_parity.mjs`,
which is genuinely independent at runtime.

On the circularity question directly: the fixture **cannot** catch a shared blind
spot, because `canonical` is written once in Python and transliterated into JS —
a field omitted from one is omitted from both. I closed that hole independently
(the table at the top: all nine ops move the canonical text, no op mutates a field
it omits), and it is clean. What the fixture demonstrably does miss is argument
coverage: `tests/fixture.py` only ever passes 4-decimal arguments and never a
negative zero, which is why findings 7 and 8 survived it.

### 13. Op labels are never compared across the two languages — minor

`ops.py:174` formats with `!r` and `:g`; `ops.js:102`/`ops.js:252` use
`'${v}'` and `String(Number(v))`. The fixture stores no labels, so these have
never been checked. `set_value(R4, "1'2")` gives Python `"1'2"` (repr switches to
double quotes) and JS `'1'2'`; `set_track_width(t, 1e-7)` gives Python `1e-07`
and JS `1e-7`. The labels are what the edit log shows and what §8 reads. Add them
to `ops.json` and compare.

### 14. `GND_ZONE_F_CU` is dead — minor

`harness/presets.py:26`. `_strand_ground` selects by `(net, layer)`, never by this
constant. Its value `"GND_1"` is the zone's `name` field, not its `id` (`z3`), so
anyone who does start using it will get nothing back from `_by_id`. Delete it.

### 15. Re-applying a preset is unguarded and partly un-breaks the board — minor

`harness/presets.py:163`. Applying each preset twice:

```
vfb-vbst-swap         refused (S1.4 is already on 'VBST')
stepper-common-open   refused
stepper-in4-floating  refused
unbuildable-value     refused
servo-power-end-pin   SUCCEEDS, hash back to fdbf9eacfc0782bf (clean)
ultrasonic-crossed    SUCCEEDS, hash back to fdbf9eacfc0782bf (clean)
ground-stranded       SUCCEEDS, hash 9a4301d5900368cf
```

The two `swap_pins` presets silently restore the clean board while leaving two
entries in the edit log. `ground-stranded` recomputes its edit list from the
already-broken board, finds no GND vias left to delete, and **toggles the F.Cu
pour back on** — so a second click restores the top pour and leaves the board in a
state that is neither clean nor the shipped defect. Guard `apply_preset` against
re-application, or make it reset first.

---

## Not checked

- Whether `sample` actually receives the distilled string — that is step 10/11.
  I verified the call path (`app.js:513` → `review.js:209`) by reading, not by
  running the page.
- Rendering (step 7) and the editing UI (step 9); I only read `app.js` where it
  feeds the ops, to establish that findings 7 and 8 are reachable.
- Groq / the graph. Nothing in `ops.py`, `presets.py`, `checks.py` or
  `distill.py` imports anything network-facing, so the "no API key below step 12"
  rule holds for these four modules.
- Zone `filled_polygon` self-intersection and hole handling. The even-odd
  point-in-polygon in both languages gave the same answer as my independent
  implementation on this board, but I did not construct a pathological pour.
- `check_net_island` behaviour on a board with copper on more than two layers;
  this board is two-layer only.

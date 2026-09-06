# PCB Eval

A browser tool for breaking a real circuit board on purpose and measuring
whether a language model notices.

Three editable views (schematic, layout, routing), a review button, and a score.

---

## 0. Read this first

This document is the complete specification. It assumes no conversation history.
Everything stated as fact below was verified against the real files, not
recalled. Where a number appears, it was measured.

**Who this is for.** Pratham Mehta, incoming UCLA EE. Two audiences:

1. **arxlabs (Rehan).** The role, in his words:
   > a harness to auto generate new PCBs and validate their quality before we
   > use them in training

   > building agentic systems + being able to QA PCBs well

   Generating broken boards and measuring whether a model catches them is that
   loop. The tool *is* the job description.

2. **UCLA engineering clubs.** It reads as hardware, because the input is a
   board that exists and the defects are ones it really had.

**What makes it uncopyable.** The board is his. The defects are the ones his
first revision actually shipped with. Nobody else has that corpus.

---

## 1. The product

A single web page. Left: the board in one of three views. Right: an inspector.

| View | Shows | Editable |
|------|-------|----------|
| **Schematic** | KiCad SVG export, with overlay markers | Reassign a pin to a different net; change a component value |
| **Layout** | Board outline, footprint bodies, pads, silkscreen refs | Drag a footprint; rotate it |
| **Routing** | Layout plus tracks, vias, copper zones | Delete a track; change its width; delete vias; toggle a zone |

Every edit mutates one in-memory `Board` object. The review reads that object,
never the original files.

**The loop.** Break something. Press Review. A model inspects the modified board
and reports findings. The page says whether it caught the edit, missed it, or
flagged something else.

**Why all three views.** Different defect classes live in different places, and
a netlist cannot see all of them:

- Schematic: swapped pins, wrong net, unbuildable value
- Layout: decoupling capacitor far from the pin it serves, antenna over copper,
  connector not on an edge
- Routing: power trace too thin for its current, stranded ground pads, missing
  stitching vias

The real board's worst defect was a routing one: every ground pad stranded, no
vias, no top pour. ERC and DRC both passed. That defect is invisible in a
netlist, which is exactly the point the tool makes.

---

## 2. Environment

**Python.** KiCad ships 3.11 with pip. No separate install needed.

```
C:\Program Files\KiCad\10.0\bin\python.exe
C:\Program Files\KiCad\10.0\bin\kicad-cli.exe
```

Set up:

```bash
"/c/Program Files/KiCad/10.0/bin/python.exe" -m venv C:/Users/pratham/Documents/pcb-eval/.venv
C:/Users/pratham/Documents/pcb-eval/.venv/Scripts/python.exe -m pip install -U pip
C:/Users/pratham/Documents/pcb-eval/.venv/Scripts/python.exe -m pip install langgraph langchain-openai pydantic python-dotenv
```

**Node** (for local preview only): `C:\Program Files\nodejs\node.exe`, v24.19.0.

**Source board.** Do not modify these files. They are the reference.

```
C:\Users\pratham\Documents\PCBs\STM32\STM32\STM32.kicad_sch
C:\Users\pratham\Documents\PCBs\STM32\STM32\STM32.kicad_pcb
```

**Existing exports** already generated and reusable:

```
C:\Users\pratham\Documents\Portfolio\media\pillmate\schematic.svg      1.2 MB
C:\Users\pratham\Documents\Portfolio\media\pillmate\pcb.svg            279 KB
C:\Users\pratham\Documents\Portfolio\media\pillmate\layer-{F_Cu,B_Cu,F_SilkS,B_SilkS,Edge}.svg
```

Regenerate with `Portfolio/tools/export-pcb.ps1`.

**LLM.** Groq, OpenAI-compatible wire format.

```
GROQ_API_KEY=<redacted>
GROQ_BASE_URL=https://api.groq.com/openai/v1
GROQ_MODEL=openai/gpt-oss-120b
```

Goes in `pcb-eval/.env`. **`.env` must be gitignored before the first commit.**
Hard spending limit of $2 set in the Groq console. This key has appeared in a
chat transcript, so rotate it once the project is public.

Free-tier Groq throttles hard. Default to concurrency 2 and a token budget of
8000 per minute. The runner must accept `--concurrency` and `--tpm` overrides.

---

## 3. The data model

One structure, shared by the extractor, the page, and the harness.

```python
Board = {
  "meta": {"name": str, "source": str, "extracted": iso8601},

  "components": [{
    "ref": str,            # "S1"          netlist designator, the canonical id
    "value": str,          # "TPS563208DDCR"
    "footprint": str,      # "SamacSys:SOT95P280X110-6N"
    "description": str,    # from the symbol library, useful to the reviewer
    "datasheet": str,
    "uuid": str,           # <tstamps> in the netlist == (path) in the pcb
  }],

  "nets": [{
    "name": str,           # "/FB", "+5V", "GND"
    "nodes": [{"ref": str, "pin": str, "function": str, "type": str}],
  }],

  "layout": {
    "outline": [{"kind": "line"|"arc", ...}],   # Edge.Cuts, board-relative mm
    "footprints": [{
      "ref": str,          # resolved through uuid, NOT the pcb Reference field
      "uuid": str,
      "x": float, "y": float, "rot": float, "layer": "F"|"B",
      "pads": [{"num": str, "x": float, "y": float,   # relative to footprint
                "w": float, "h": float, "shape": str, "net": str}],
    }],
    "tracks": [{"x1": float, "y1": float, "x2": float, "y2": float,
                "width": float, "layer": str, "net": str}],
    "vias":   [{"x": float, "y": float, "size": float, "drill": float,
                "net": str}],
    "zones":  [{"layer": str, "net": str, "polygon": [[x, y], ...]}],
  },
}
```

**All layout coordinates are board-relative millimetres**, origin at the
Edge.Cuts bounding-box minimum. The extractor subtracts that origin once so the
page never deals with KiCad's sheet coordinates.

---

## 4. Extraction

### 4.1 Netlist

```bash
kicad-cli sch export netlist --format kicadxml -o boards/stm32-good.net.xml STM32.kicad_sch
```

Output is 98 KB of XML. Shape, verified:

```xml
<comp ref="S1">
  <value>TPS563208DDCR</value>
  <footprint>SamacSys:SOT95P280X110-6N</footprint>
  <datasheet>http://www.ti.com/lit/gpn/tps563208</datasheet>
  <description>4.5 V to 17 V input, 3 A output, synchronous step-down
               converter in FCCM mode</description>
  <tstamps>83e0c5a3-2b07-4851-a3f3-b9c21a72adee</tstamps>
</comp>

<net code="22" name="/STEPPER_IN1" class="Default">
  <node ref="R8" pin="2" pintype="passive"/>
  <node ref="U2" pin="11" pinfunction="PA1_11" pintype="bidirectional"/>
  <node ref="U3" pin="1" pinfunction="I1_1" pintype="input"/>
</net>
```

`pinfunction` is the chip's own pin name. It is what makes datasheet-level
checks writable at all. `description` gives the reviewer part context for free.

Parse with `xml.etree.ElementTree`. No dependencies.

### 4.2 Layout

Parse `.kicad_pcb` as s-expressions. Write a small recursive tokenizer; do not
use regex. Verified element counts:

| element | count |
|---------|-------|
| footprint | 53 |
| pad | 199 |
| segment | 400 |
| via | 63 |
| zone | 5 |
| gr_line | 4 |
| gr_arc | 4 |

Shapes, verified:

```lisp
(segment (start 87.25 89.3375) (end 87.25 90.525) (width 0.3) (layer "F.Cu") (net "GND"))
(via (at 108.9 108.45) (size 0.7) (drill 0.3) (layers "F.Cu" "B.Cu") (net "GND"))
(pad "1" smd roundrect (at -3.15 -2.3 270) (size 2 1.5) (layers "F.Cu" "F.Mask" "F.Paste"))
(footprint "Package_TO_SOT_SMD:SOT-223-3_TabPin2" (at 102.8 111.25 -90) ...)
```

### 4.3 Two gotchas that will cost hours if missed

**The PCB reference fields are renamed.** They hold silkscreen labels, not
designators. Actual values found on the board include `LIN REG`, `WALL`,
`BUCK`, `SERVO`, `STEPPER`, `US`, `LDR`, `HSE`, `USB`, `UART`, `LED`. Matching
overlays by designator fails silently for those parts.

**Join on the UUID instead.** Each footprint carries `(path "/<uuid>")` and each
netlist `<comp>` carries `<tstamps><uuid></tstamps>`. Verified 53 footprints and
53 paths, exact 1:1. This is the only reliable link between schematic and board.

### 4.4 Coordinate mapping

Measured: the Edge.Cuts outline spans about x ∈ [57, 118], y ∈ [77, 123] in
sheet millimetres. The exported `layer-Edge.svg` carries
`viewBox="0 0 60.9854 45.9994"`, matching 61 × 46 mm.

So, with `page-size-mode 2` (crop to board outline):

```
svg_x = pcb_x - outline_min_x
svg_y = pcb_y - outline_min_y
```

Compute `outline_min_*` from the parsed Edge.Cuts geometry. Do not hardcode it.
The renderer works in these board-relative millimetres throughout, so an SVG
`viewBox="0 0 W H"` maps one unit per millimetre.

---

## 5. The page

### 5.1 Rendering

**Schematic view.** Embed the KiCad SVG. It is a picture, so edits cannot change
it. Draw overlay markers on top instead: a ring around each affected component,
positioned from `.kicad_sch` symbol coordinates. Mark at component level, not
pin level. Pin offsets live inside embedded `lib_symbols` definitions and rotate
with the symbol, which is a great deal of work for a smaller ring.

**Layout and routing views.** Do not use KiCad's SVG. Render from `Board.layout`
into SVG elements so every item is individually selectable and mutable:

- outline as a `path`
- each footprint as a `g` with its pads as `rect`s, translated and rotated
- each track as a `line`
- each via as a `circle`
- each zone as a `polygon`

Layer visibility toggles the same way the portfolio's existing layer viewer
does. Routing view is the layout view with tracks, vias and zones enabled.

400 tracks plus 199 pads plus 63 vias is roughly 700 SVG nodes. That renders and
drags smoothly with no virtualisation.

### 5.2 Editing

Every edit is a named operation that mutates `Board` and appends to an edit log.
The log is what gets shown, scored, and undone.

```python
# schematic
move_pin(ref, pin, to_net)         # the primitive behind most net defects
swap_pins(ref, pin_a, pin_b)
set_value(ref, value)

# layout
move_footprint(ref, x, y)
rotate_footprint(ref, deg)

# routing
delete_track(track_id)
set_track_width(track_id, mm)
delete_via(via_id)
toggle_zone(zone_id)
```

Every operation is reversible. Undo is popping the log and replaying.

### 5.3 Review

The page calls Claude directly through the Artifact `sample` capability. No API
key is embedded, and the viewer's own account pays.

```js
const sample = await claude.use("sample");   // null when unavailable: hide the button
const out = await sample.json(prompt, { modelTier: "default", cache: true });
```

Declare on publish:

```js
capabilities: { sample: {} }
```

`sample` has no memory between calls. Every call sends the whole distilled board
and the required output shape.

Findings schema:

```json
{"findings": [{
  "severity": "critical" | "major" | "minor",
  "refs": ["S1"],
  "nets": ["/FB", "VBST"],
  "title": "Feedback and bootstrap pins swapped",
  "why": "one sentence on the consequence"
}]}
```

**Grade by overlap, never by wording.** A finding matches an edit when their
component refs or net names intersect. Report three outcomes: caught, missed,
and other findings raised.

Running against the untouched board matters as much as running against a broken
one. A reviewer that flags everything catches every defect and is worth nothing.
The page must make that testable in one click.

### 5.4 Rate limiting

Money is spent per review. Enforce all four:

1. **Cache on board hash.** Hash the distilled board plus the prompt version.
   Identical state returns the stored verdict and costs nothing. This alone
   removes most repeat spending, because visitors re-review the same edit.
2. **Minimum interval.** One review per 10 seconds. Disable the button and show
   the countdown.
3. **Session cap.** 25 reviews per viewer, held in `localStorage`. On reaching
   it, keep presets working from cache and explain why live review stopped.
4. **No review on load, ever.** Only on an explicit click. `sample` prompts the
   viewer for consent on first call, so an automatic call is both rude and
   wasteful.

Distil before sending. Raw netlist XML is 98 KB. The distilled form must come in
near 2k tokens: components with value and description, nets with their nodes,
and for layout edits only the geometry near what changed.

### 5.5 Style

Match prathamm.com. Near-black ground (`#08090c`), IBM Plex Mono for anything
countable, Inter for prose, one mint accent. Theme-aware, per the artifact rules.

---

## 6. The reviewer

LangGraph. Sequential.

```
ingest        deterministic: parse, run rule checks
  |
datasheet     pin function against what the pin is wired to
  |
connections   connector pinouts, floating inputs, power and ground
  |
layout        placement and routing: trace width against current,
              ground return, decoupling distance
  |
adjudicate    dedupe; drop findings the deterministic checks contradict
  |
gate          deterministic set empty, or passes == 2 ? END : back to datasheet
```

State:

```python
class ReviewState(TypedDict):
    board: dict
    distilled: str
    findings: list[dict]
    confirmed: list[dict]
    passes: int
```

**The gate never asks the model whether it is finished.** If the loop exits when
the reviewers agree the board looks fine, it always exits, and the harness
launders bad boards as checked. That is precisely the failure the arxlabs role
exists to prevent. LLM nodes propose. Deterministic checks dispose.

Sequential, not parallel. Parallel fan-out needs reducer annotations on the
state and is not worth the debugging time.

**No thermals node.** Thermal analysis needs copper geometry, current and
ambient temperature. Two of the three are absent, so such a node produces
confident nonsense in front of people who read boards for a living. The layout
node replaces it and does something checkable: trace width against IPC-2221 for
the current a rail carries. The real board has a 1 A part feeding three servos
that stall near 700 mA each.

The page runs a single-node version of these prompts, for latency. The harness
runs the full graph. Comparing the two is the finding.

---

## 7. Seed defects

Presets, not the product. They give a visitor somewhere to start and give the
eval a fixed corpus. Every edit below was checked against the exported netlist.

| # | id | operation | what it breaks |
|---|----|-----------|----------------|
| 1 | `vfb-vbst-swap` | `move_pin(S1, 4, VBST)` + `move_pin(S1, 6, /FB)` | The buck regulates from the bootstrap node instead of the feedback divider. Output runs away. |
| 2 | `stepper-common-open` | `move_pin(J11, 5, <new net with U3.12>)` | The stepper's centre tap hangs off an unused open-collector output instead of the 5V rail. Motor never turns. |
| 3 | `servo-power-end-pin` | `swap_pins(J4, 2, 3)` | +5V lands on the end pin. A standard servo lead plugged in normally puts 5V on the servo's ground. |
| 4 | `ultrasonic-crossed` | `swap_pins(J2, 2, 3)` | The MCU drives the sensor's echo output and listens on its trigger input. |
| 5 | `stepper-in4-floating` | `move_pin(R11, 2, /STEPPER_IN1)` | ULN2003 input 4 floats at power-up. That coil can energise before firmware runs. |
| 6 | `unbuildable-value` | `set_value(R4, "R")` | Not a connectivity fault. The BOM cannot be ordered. |
| 7 | `ground-stranded` | delete every via on `GND`, delete the `F.Cu` `GND` zone | Every ground pad stranded. **This is the one the real board shipped with, and it passes ERC and DRC.** |

Defect 7 only exists because routing is editable. It is the strongest item in
the set: a netlist-only tool cannot represent it at all.

Verified net facts used above:

```
/FB           R2.2, R3.1, S1.4(VFB_4)
VBST          C4.2, S1.6(VBST_6)
/TRIG         J2.2, U2.38(PA15_38)
/ECHO         J2.3, U2.39(PB3_39)
/SERVO_3      J4.1, U2.18(PB0_18)
+5V           C12.1, D2.2, J11.5, J2.1, J3.1, J4.2, J7.2, J8.2, L1.2, R2.1, U3.9(COM_9)
/STEPPER_IN1  R8.2, U2.11(PA1_11), U3.1(I1_1)
/STEPPER_IN4  R11.2, U2.14(PA4_14), U3.4(I4_4)
/O1../O4      J11.1..4, U3.16/15/14/13
U3.12 (O5)    unconnected
```

Board summary: 53 components, 62 nets. S1 = TPS563208DDCR buck,
U1 = AMS1117-3.3 LDO, U2 = STM32F103C8T6, U3 = ULN2003 driver, Y1 = 16 MHz.

---

## 8. Scoring

Eight boards: one clean, seven seeded. Two detectors: a single flat prompt, and
the graph.

- **Recall.** Did the findings name the injected defect? Matched on refs and
  nets, not wording.
- **False alarms.** Findings on the clean board. This number decides whether the
  other one means anything.

The headline is the comparison, in the shape of *one prompt finds 2 of 7, the
graph finds 5 and adds one false positive.*

Stamp every result with the prompt hash, the tool-schema hash, and the corpus
hash. A score that outlives the system it measured is worse than no score.

### Cost ceiling

Distilled board is about 2k tokens. The single prompt is one call per board; the
graph is four nodes across up to two passes, so eight. Eight boards puts the
ceiling near 72 calls and 250k tokens. Cents against the $2 limit.

Guardrails: dashboard limit, disk cache keyed on `(model, prompt hash)`,
distilled input, one board during development, tokens and dollars logged per
call to JSONL.

---

## 9. Repository

```
pcb-eval/
  .env                        gitignored
  .gitignore
  PLAN.md
  README.md
  boards/
    stm32-good.net.xml        kicad-cli export
    stm32-good.json           extracted Board, the single source of truth
  extract/
    netlist.py                XML -> components, nets
    layout.py                 s-expression parser -> layout
    build.py                  writes boards/stm32-good.json
  harness/
    ops.py                    the edit operations, shared with the page
    presets.py                the seven seed defects
    distill.py                Board -> ~2k tokens
    checks.py                 deterministic detectors
    grade.py                  finding vs edit matching
    llm.py                    Groq client, disk cache, cost log
    run.py                    the eval runner
  graph/
    state.py
    nodes/{datasheet,connections,layout,adjudicate}.py
    build.py                  wiring and the gate
  baseline/
    single_prompt.py
  results/
  site/
    index.html                the page, published as an Artifact
    render.js                 SVG renderers for the three views
    ops.js                    same operations as ops.py, in the browser
    review.js                 sample integration, cache, rate limits
  tests/
```

`ops.py` and `ops.js` implement the same operations. Keep them in step: a shared
JSON fixture of before and after states, asserted by both test suites.

---

## 10. Build order

Each step states how to prove it works. A step is not done until its check
passes.

| # | Step | Done when |
|---|------|-----------|
| 1 | `extract/netlist.py` | Round-trips the real export: 53 components, 62 nets, `/FB` contains exactly `R2.2, R3.1, S1.4` |
| 2 | `extract/layout.py` | Parses 53 footprints, 199 pads, 400 segments, 63 vias, 5 zones. Outline bbox is 61 × 46 mm within 0.1 mm |
| 3 | `extract/build.py` | `boards/stm32-good.json` written. Every footprint resolves to a netlist ref through its UUID, 53 of 53 |
| 4 | `harness/ops.py` | All seven presets apply cleanly and each is reversible; board hash returns to the original after undo |
| 5 | `harness/checks.py` | Every preset trips its own deterministic check. The clean board trips none |
| 6 | `harness/distill.py` | Distilled board under 3000 tokens, and contains every ref, net and value |
| 7 | `site/render.js` | All three views render. Layout matches the KiCad plot when overlaid |
| 8 | `site/ops.js` | Same fixture as step 4 produces identical results in the browser |
| 9 | Editing UI | Drag a footprint, delete a track, reassign a pin. Edit log shows each. Undo restores |
| 10 | `site/review.js` | Review returns findings. Cache hits cost nothing. Rate limits enforced |
| 11 | Publish | Artifact published with `capabilities: {sample: {}}`, review works for a viewer |
| 12 | `harness/llm.py` + graph | Full graph runs headless against one board |
| 13 | `harness/run.py` | Scored sweep over eight boards, results JSON with all three hashes |
| 14 | README | Results grid, the cost per run, and what a netlist cannot see |

Steps 1 through 11 need no API key. The page is a complete deliverable on its
own. Steps 12 to 14 use Groq and only improve the README.

---

## 11. Known gotchas

- PCB `Reference` fields hold silkscreen labels. Join on UUID. (§4.3)
- KiCad SVG exports carry no layer names, only colours. Do not try to pick
  groups apart afterwards; plot one layer per file, which the export script
  already does.
- Perl and shell regex break on net names because they begin with `/`. Use
  Python.
- The 3D GLB is 10.4 MB against a 16 MB artifact budget. Leave it out of the
  page. It already lives on prathamm.com.
- glTF defaults `metallicFactor` to 1, and KiCad omits it for most materials.
  Irrelevant here, but the reason the portfolio's 3D viewer needed material
  correction.
- `sample` resolves `null` when unavailable. Branch on it and hide the review
  affordance rather than throwing.
- Artifact pages get one origin each, so `localStorage` is private to the page
  and survives republishing. Safe for the session review counter.

---

## 12. Open questions

1. **Repo name and visibility**, if the source is meant to be public alongside
   the page.
2. Whether the page gets linked from prathamm.com as a project card.
3. Whether the harness runs against a second model, which would answer whether
   decomposition beats capability. Worth about twenty cents.

---

## 13. Verified at spec time

- Groq key responds. `POST /openai/v1/chat/completions` with
  `model: openai/gpt-oss-120b` returns 200.
- **`gpt-oss-120b` is a reasoning model.** The response carries `reasoning`
  before `content`. A tight `max_tokens` burns the whole budget on reasoning and
  returns an empty `content`. Allow at least 2000 completion tokens, and read
  `choices[0].message.content`, never `reasoning`.

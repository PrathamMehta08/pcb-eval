# PCB Eval

A browser tool for breaking a real circuit board on purpose and measuring
whether a language model notices.

Three editable views — schematic, layout, routing — a review button, and a
score. **[Open the page](https://claude.ai/code/artifact/57369783-5bbd-45c9-a3fa-fa314b956d0d)**;
it reviews with your own Claude account and needs no key.

---

## The board is real, and so are the defects

`STM32.kicad_pcb` is the controller for a pill dispenser: 53 components, 62
nets, 400 track segments, 63 vias, five copper pours, 61 × 46 mm on two layers.
An STM32F103C8T6, a TPS563208 buck from a barrel jack, an AMS1117-3.3 LDO, a
ULN2003 driving a unipolar stepper, three servo headers and an HC-SR04.

The seven seeded defects are not invented. Each one is a fault this design could
plausibly have shipped with, and the seventh is the one it **did** ship with:

> Every ground pad on the top layer stranded from the pour on the bottom.
> No stitching vias, no top pour. ERC passed. DRC passed. The board did not work.

That defect is why the routing view is editable rather than decorative. It does
not exist in the netlist at all — the netlist says GND is one net, and it is
right, and the copper disagrees. A tool that reviews a netlist cannot represent
it, let alone find it.

## Results

Eight boards — one clean, seven seeded. Two detectors, given the same distilled
board, the same output schema, the same model and the same temperature. The only
difference is that one asks a single flat prompt to do all three jobs, and the
other splits them across a LangGraph pipeline of three specialists plus an
adjudicator.

`openai/gpt-oss-120b` · prompts `bab4450ceef8` · schema `234a1c9dd4ac` · corpus `c945775a879c`

| board | one prompt | the graph |
|---|---|---|
| clean (no defect) | 5 findings | 4 findings |
| `vfb-vbst-swap` | caught | caught |
| `stepper-common-open` | **missed** | caught |
| `servo-power-end-pin` | caught | caught |
| `ultrasonic-crossed` | caught | caught |
| `stepper-in4-floating` | caught | **missed** |
| `unbuildable-value` | caught | **missed** |
| `ground-stranded` | caught | caught |
| **recall** | **6 of 7** | **5 of 7** |
| **false alarms on the clean board** | **5** | **4** |

By the metric the plan specified — a finding matches a defect when their
component refs or net names intersect — the single prompt wins.

**That number is wrong, and the interesting result is why.**

## The metric is too generous, and here is the proof

Overlap cannot tell a finding that *identified* a defect from one that merely
*mentioned a part the defect touches*. Every match is recorded with `via`, the
identifier the match rested on, and `breadth`, how many names the finding threw
at the board. Read the pairs:

**One prompt — three of its six catches are coincidences.**

| defect | matched on | the finding that "caught" it |
|---|---|---|
| `vfb-vbst-swap` | `S1` | /IN trace width insufficient for barrel-jack input current |
| `servo-power-end-pin` | `J4`, `+5V` | +5 V trace width too narrow for load *(named 11 things)* |
| `ultrasonic-crossed` | `U2` | NRST pin lacks pull-up resistor |
| `stepper-in4-floating` | `U3`, `/STEPPER_IN4` | Series resistor missing on stepper driver input ✅ |
| `unbuildable-value` | `R4` | Resistor R4 has no defined value ✅ |
| `ground-stranded` | `GND` | Ground net split into multiple copper islands with no vias ✅ |

The first three are a trace-width observation that happens to name the buck, a
power-rail observation that happens to name a rail every servo header sits on,
and a reset-pin observation that happens to name the 48-pin MCU. None of them
found the defect.

**The graph — four of its five catches name the defect exactly.**

| defect | matched on | the finding that caught it |
|---|---|---|
| `vfb-vbst-swap` | `S1` | EN pin of buck converter tied to VIN net |
| `stepper-common-open` | `J11`, `/O5` | J11 connector provides only driver outputs with no ground or supply pins ✅ |
| `servo-power-end-pin` | `J4`, `+5V`, `GND` | Servo connector J4 pin order incorrect ✅ |
| `ultrasonic-crossed` | `J2`, `/ECHO`, `/TRIG` | HC-SR04 header pin order swapped ✅ |
| `ground-stranded` | `GND` | Ground net split across multiple islands with no vias and pour on only one layer ✅ |

So the honest scoreboard is the other way round:

|  | overlap recall | catches that actually name the defect |
|---|---|---|
| one prompt | 6 of 7 | **3** |
| the graph | 5 of 7 | **4** |

**What this corpus mainly has to say is about the schema, not the model.**
Grading exactly would need a finding to carry a machine-checkable claim — the
kind of defect, and the specific pin or net it is about — instead of a sentence
plus a bag of references. `{"claim": "connector-pin-order", "ref": "J4"}` can be
scored. "Servo connector J4 pin order incorrect" can only be pattern-matched,
and pattern-matching on refs is what produced the flattering number above.

Neither prompt was edited after the scores were seen. One harness bug was fixed
after the first run and both detectors were re-scored: reviewers write `D2.2`
meaning pin 2 of D2, and the adjudicator's contradiction check was reading that
as a part that does not exist and throwing out twenty correct findings.

### What it cost

One full sweep from cold: 48 model calls, 144k tokens in, 90k out, **$0.075**,
205 seconds wall clock at two concurrent requests and a 40k-token-per-minute
budget. Re-running is free — the disk cache is keyed on `(model, prompt)`, so
re-scoring after a harness change costs nothing and takes four seconds.

Every call is logged to `results/calls.jsonl` with its tokens, seconds and
dollars. Every sweep is stamped with the prompt hash, the schema hash and the
corpus hash, because a score that outlives the system it measured is worse than
no score.

## What a netlist cannot see

The distilled board is 2,845 tokens, down from 98 KB of netlist XML and 520 KB
of extracted JSON. The part that matters is the copper summary — per net, its
pads, **how many separate copper islands those pads sit on**, its track length
and narrowest width, its vias, and which layers carry a pour.

That island count is a real measurement, not a heuristic: a union-find over
pads, track segments, vias and filled zone polygons, with pads placed through
KiCad's own rotation transform. On the board as manufactured, every net is one
island. Strip the ground vias and the top pour and GND becomes **28 islands with
32 pads stranded** — while the netlist, ERC and DRC all still say it is fine.

## The page

One HTML file, 1.46 MB, published as an Artifact. It holds the extracted board,
KiCad's own schematic plot, and six ES modules.

- **Schematic** — KiCad's SVG export nested inside ours so it shares the pan and
  zoom. It is a picture, so edits cannot change it; markers are drawn over it
  from the symbol coordinates in the `.kicad_sch`. Reassign a pin to another
  net, swap two pins, change a value.
- **Layout** — drawn element by element from the board object, not from a plot,
  so every pad and footprint is selectable. Drag a part, rotate it.
- **Routing** — layout plus 400 tracks, 63 vias and five pours. Delete a track,
  change its width, delete vias, turn a pour off.

Every edit is one of nine named operations, appends to the edit log, and is
reversible. The review reads the mutated board, never the original files.

Reviewing uses the artifact `sample` capability, so no API key is embedded and
the viewer's own account pays. Four limits, all enforced: a cache keyed on the
board hash, one review per ten seconds, 25 per browser, and never on load.

## Running it

Steps 1 through 11 need no API key at all.

```bash
"/c/Program Files/KiCad/10.0/bin/python.exe" -m venv .venv
.venv/Scripts/python.exe -m pip install -U pip
.venv/Scripts/python.exe -m pip install langgraph langchain-openai pydantic python-dotenv tiktoken
```

```bash
.venv/Scripts/python.exe -m extract.build      # boards/stm32-good.json
.venv/Scripts/python.exe -m tests.run          # the acceptance checks, 10 of 10
.venv/Scripts/python.exe tools/build_site.py   # dist/pcb-eval.html
```

The scored sweep needs a Groq key in `.env` (copy `.env.example`):

```bash
.venv/Scripts/python.exe -m harness.run --tpm 40000 --concurrency 2
```

`tests/run.py` is the contract: one check per row of the build order, each
asserting the thing that row claims. `place()`, the transform every view and
every copper check rests on, is pinned to six pad centres read out of KiCad's
own `layer-F_Cu.svg` plot — in Python and again in JavaScript.

## Repository

```
extract/     kicadxml and .kicad_pcb into one Board object, joined on UUID
harness/     the nine edit operations, seven deterministic rules, the distiller,
             the Groq client, the grader, the sweep runner
graph/       ingest, three reviewers, adjudicate, gate
baseline/    the single flat prompt the graph is measured against
site/        six ES modules; tools/build_site.py makes one file of them
tests/       the acceptance checks, and the fixtures that keep Python and
             JavaScript telling the same story
```

Two things are written twice on purpose. `harness/ops.py` and `site/ops.js` are
the same nine operations; `harness/distill.py` and `site/distill.js` are the
same distiller. The page has to describe the board as the visitor just broke it,
and only the browser holds that state. Both pairs are pinned by fixtures — 20
edit cases must produce identical board hashes, and eight distilled boards must
match character for character. That last one caught a real difference: Python
formats half to even and JavaScript's `toFixed` rounds half away from zero, so a
pad at 30.25 mm printed as 30.2 in one and 30.3 in the other.

## Two gotchas worth writing down

**The PCB `Reference` fields are silkscreen labels, not designators.** Eleven of
the 53 footprints on this board say `LIN REG`, `WALL`, `BUCK`, `SERVO`,
`STEPPER`, `US`, `LDR`, `HSE`, `USB`, `UART` or `LED`. Matching the schematic to
the board by designator drops exactly those eleven, silently. Join on the UUID:
each footprint carries `(path "/<uuid>")` and each netlist `<comp>` carries
`<tstamps>`, and they are a 1:1 covering.

**`gpt-oss-120b` writes its reasoning before its content.** A tight `max_tokens`
spends the whole budget thinking and returns an empty `content`. The floor here
is 2000 completion tokens, and the answer is read from
`choices[0].message.content`, never from `reasoning`.

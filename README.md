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
· full record in [`results/latest.json`](results/latest.json)

| board | one prompt | the graph |
|---|---|---|
| clean (no defect) | 4 findings | 6 findings |
| `vfb-vbst-swap` | caught | caught |
| `stepper-common-open` | caught | caught |
| `servo-power-end-pin` | **missed** | caught |
| `ultrasonic-crossed` | caught | caught |
| `stepper-in4-floating` | caught | caught |
| `unbuildable-value` | **missed** | **missed** |
| `ground-stranded` | caught | caught |
| **recall** | **5 of 7** | **6 of 7** |
| **false alarms on the clean board** | **4** | **6** |
| calls per board | 1 | 4, or 8 when the gate loops |

By the metric the plan specified — a finding matches a defect when their
component refs or net names intersect — the graph wins on recall and loses on
false alarms.

**Both numbers are softer than they look, and that is the more useful result.**

## The metric is too generous, and here is the proof

Overlap cannot tell a finding that *identified* a defect from one that merely
*mentioned a part the defect touches*. So every match records `via`, the
identifier it rested on, and `breadth`, how many names the finding threw at the
board. Reading the pairs is a judgement, not a computation — here is the data so
you can disagree with mine.

**One prompt — two of its five catches are real.**

| defect | matched on | the finding that "caught" it | real? |
|---|---|---|---|
| `vfb-vbst-swap` | `S1` | Enable pin of buck converter tied to VIN net | no |
| `stepper-common-open` | `+5V` | Buck feedback network sets output ~3.3 V | no |
| `ultrasonic-crossed` | `U2` | NRST pin lacks pull-up resistor | no |
| `stepper-in4-floating` | `U3`, `/STEPPER_IN4` | Missing series resistor on stepper driver input 4 | **yes** |
| `ground-stranded` | `GND` | GND net split into multiple copper islands | **yes** |

**The graph — three of its six.**

| defect | matched on | the finding that caught it | real? |
|---|---|---|---|
| `vfb-vbst-swap` | `S1`, `/FB`, `VBST` | **Feedback pin wired to VBST net instead of VFB net** | **yes** |
| `stepper-common-open` | `J11`, `/O5` | Connector J11 provides only control signals with no ground or supply pins | **yes** |
| `servo-power-end-pin` | `+5V` | Connector J11 provides no ground pin — J11, not J4 | no |
| `ultrasonic-crossed` | `U2` | NRST pin lacks pull-up resistor to VDD | no |
| `stepper-in4-floating` | `U3` | Decoupling capacitor far from GND pin | no |
| `ground-stranded` | `GND` | Ground net not connected between layers (no vias, single-side pour) | **yes** |

So the honest scoreboard is:

|  | overlap recall | catches that actually name the defect |
|---|---|---|
| one prompt | 5 of 7 | **2** |
| the graph | 6 of 7 | **3** |

The graph's win is narrow, and the interesting part is *which* one it wins on:
the feedback-and-bootstrap swap, named exactly — "Feedback pin wired to VBST net
instead of VFB net". The single prompt has never produced that sentence, in
either sweep. It is the defect that most needs the datasheet's own pin names,
which is what the `datasheet` node exists to read.

Neither detector found `unbuildable-value`, a resistor whose value is the letter
`R`. The deterministic rule catches it in a millisecond. That is the division of
labour the whole design argues for, and it is worth more than the recall column.

**What this corpus mainly has to say is about the schema, not the model.**
Grading exactly would need a finding to carry a machine-checkable claim — the
kind of defect, and the specific pin or net it is about — instead of a sentence
plus a bag of references. `{"claim": "pin-on-wrong-net", "ref": "S1", "pin": "4"}`
can be scored. "Feedback pin wired to VBST net instead of VFB net" can only be
pattern-matched, and pattern-matching on refs is what produced both flattering
recall numbers above.

### What is not being claimed

Seven seeded defects is a small corpus and the sweep has been run twice. Both
runs put the two detectors within one defect of each other and both showed the
same pattern of coincidental matches, but one defect of difference on seven
boards is not a result that would survive a third model or a second board.

Neither prompt was edited after any score was seen; `prompt_hash` is there to
make that checkable. Two harness bugs were fixed between the runs and everything
was re-scored:

- **The first sweep was invalid.** The distiller took a list of "focus" refs and
  printed the geometry around them, ending with the literal word `edited` — so
  the prompt named the part that had just been broken on a seeded board and said
  nothing at all on the clean one. `distill()` now takes the board and nothing
  else, and the plumbing that fed it is gone rather than merely unused.
- Reviewers write `D2.2` meaning pin 2 of D2, and the adjudicator's
  contradiction check read that as a part that does not exist, throwing out
  twenty correct findings.

### What it cost

The full sweep: 44 model calls, 154k tokens in, 105k out, **$0.086**, 251
seconds at two concurrent requests. Re-running is free — the disk cache is keyed
on `(model, prompt)`, so re-scoring after a harness change costs nothing and
takes four seconds.

Every call is logged with its tokens, seconds and dollars. Every sweep is
stamped with the prompt hash, the schema hash and the corpus hash, because a
score that outlives the system it measured is worse than no score.

## What a netlist cannot see

The distilled board is 2,918 tokens at worst across the eight, down from 98 KB
of netlist XML and 520 KB of extracted JSON. The part that matters is the copper
summary — per net, its pads, **how many separate copper islands those pads sit
on**, its track length and narrowest width, its vias, and which layers carry a
pour. Alongside it goes one more measurement: how far each supply pin sits from
the nearest capacitor on its own net, which is how the ULN2003's ground pin at
17.2 mm becomes visible.

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
.venv/Scripts/python.exe -m tests.run          # the acceptance checks, 14 of 14
.venv/Scripts/python.exe tools/build_site.py   # dist/pcb-eval.html
```

The scored sweep needs a Groq key in `.env` (copy `.env.example`):

```bash
.venv/Scripts/python.exe -m harness.run --tpm 40000 --concurrency 2
```

`tests/run.py` is the contract: one check per row of the build order, each
asserting the thing that row claims. Fourteen of fourteen pass, and none of them
needs an API key: the graph's wiring, its gate and its contradiction check are
all decidable against a stub, and only the quality of the findings is not.
`place()`, the transform every view and every copper check rests on, is pinned
to six pad centres read out of KiCad's own `layer-F_Cu.svg` plot — in Python and
again in JavaScript.

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
qa/          adversarial review of each build step, kept as written
```

Every step was built and then handed to a reviewer whose job was to break it
against the real KiCad files rather than against this code's own output.
[`qa/`](qa/) has the reports and a list of what they caught that a green test
suite did not — including a prompt that named the part that had just been
broken, three deterministic rules that turned out to be pattern-matching the
seeded defect, and a coverage assertion that passed with a component deleted
because `C1` is a substring of `C11`.

Two things are written twice on purpose. `harness/ops.py` and `site/ops.js` are
the same nine operations; `harness/distill.py` and `site/distill.js` are the
same distiller. The page has to describe the board as the visitor just broke it,
and only the browser holds that state. Both pairs are pinned by fixtures — 22
edit cases must produce identical board hashes and identical edit-log labels,
and eight distilled boards must match character for character. Both caught real
differences. Python formats half to even and JavaScript's `toFixed` rounds half
away from zero, so a pad at 30.25 mm printed as 30.2 in one and 30.3 in the
other; and `round(v, 4)` against `Math.round(v * 1e4) / 1e4` made one
five-decimal track width hash to two different boards — which matters because
that hash is the review cache key.

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

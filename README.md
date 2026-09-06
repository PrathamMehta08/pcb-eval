# PCB Eval

A browser tool for breaking a real circuit board on purpose and measuring
whether a language model notices.

Three editable views — schematic, layout, routing — a review button, and a
score. **[Open the page](https://claude.ai/code/artifact/57369783-5bbd-45c9-a3fa-fa314b956d0d)**;
it reviews with your own Claude account and needs no key.

**[Inside the review graph](https://claude.ai/code/artifact/fc2288ed-9a8c-4fa9-b777-23ffad65c7a2)** — the headless reviewer's
own working, kept whole: every prompt, the model's reasoning at each node, and
the gate's decision at each turn of the loop, across all eight boards.

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
board, the same output schema, the same model and the same temperature, and
pointed at the same data sections in the same words. The only thing that varies
is that one asks a single flat prompt to do all three jobs, and the other splits
them across a LangGraph pipeline of three specialists plus an adjudicator.

`openai/gpt-oss-120b` · prompts `743e7f6977bd` · schema `234a1c9dd4ac` · corpus `c945775a879c`
· full record in [`results/latest.json`](results/latest.json)

| | one prompt | the graph |
|---|---|---|
| defects matched, of 7 | 6 | 7 |
| **defects the finding actually names** | **2** | **2** |
| findings the copper refutes — reported | **1** | **0** |
| findings the copper refutes — proposed | 1 | 3 |
| findings on the clean board | 7 | 8 |
| model calls per board | 1 | 4, or 8 when the gate loops |

Read the middle three rows. **The first row — 6 of 7 and 7 of 7 — says
nothing**, and the second half of this section is the evidence for that.

### Why the recall row says nothing

The plan's rule is that a finding matches a defect when their component refs or
net names intersect. That rule cannot tell a finding that *identified* a defect
from one that merely *mentioned a part the defect touches*, so every match here
records `via` — the identifier it rested on — and `breadth`, how many names the
finding threw at the board. Reading the pairs is a judgement, not a computation;
here is the data so you can disagree with mine.

**One prompt: two of its six.**

| defect | matched on | the finding that "caught" it | names it? |
|---|---|---|---|
| `vfb-vbst-swap` | `S1` | EN pin of buck converter tied to VIN net | no |
| `stepper-common-open` | `+5V` | Trace width on +5 V net insufficient for 3 A buck output | no |
| `servo-power-end-pin` | `+5V` | Trace width too narrow for high-current rails | no |
| `ultrasonic-crossed` | `U2` | BOOT0 pin left floating | no |
| `stepper-in4-floating` | — | missed | — |
| `unbuildable-value` | `R4` | **Resistor R4 has no value specified** | **yes** |
| `ground-stranded` | `GND` | **GND net split across 28 copper islands** | **yes** |

**The graph: two of its seven.**

| defect | matched on | the finding that "caught" it | names it? |
|---|---|---|---|
| `vfb-vbst-swap` | `S1` | EN pin of buck converter tied to VIN net | no |
| `stepper-common-open` | `U3`, `+5V` | Trace width on +5V net insufficient for 3 A buck output | no |
| `servo-power-end-pin` | `J4`, `+5V`, `GND` | **Servo header J4 pin order incorrect** | **yes** |
| `ultrasonic-crossed` | `U2` | NRST pin lacks a pull-up resistor | no |
| `stepper-in4-floating` | `U3` | +5V trace width insufficient for 3 A load *(named 12 things)* | no |
| `unbuildable-value` | `R4` | BOOT0 lacks defined pull-up | no |
| `ground-stranded` | `GND` | **Ground net split across 28 islands with no vias and pour only on bottom layer** | **yes** |

Two each, and each found one the other did not: the flat prompt named the
unorderable resistor, the graph named the crossed servo header. **On this corpus
decomposition did not beat a single prompt at finding defects.**

### The row that does mean something

A finding that says a net is split into copper islands, on a net whose copper is
one connected piece, is wrong — and the geometry says so without anyone's
opinion. `harness/grade.py` measures that for both detectors, over both what
each *proposed* and what it *reported*, so the graph earns no credit merely for
having a stage the baseline lacks.

- **The graph proposed three claims the board refutes and reported none.** Its
  adjudicator dropped all three: `/VIN_LDO`, `/BOOT0` and `GND` each claimed to
  be disconnected, each one connected piece of copper.
- **The single prompt proposed one and reported it**, because nothing in that
  path consults the board. It named a net called `/5V`, which does not exist.

An earlier sweep, before both prompts were pointed at the same sections, made
this larger and starker: the flat prompt invented a copper split **five times
across four boards whose copper was intact**, including "Ground net split into
41 isolated copper islands" on a board where ground is one piece — and two of
those fabrications are what scored it a match under the overlap rule.

That is the whole design in one number. LLM nodes propose; deterministic checks
dispose. The referee is the board, and only one of the two detectors asks it
anything before speaking.

### What is not being claimed

- **Seven defects on one board is a small corpus**, run four times as the
  harness was corrected. Across those runs the two detectors stayed within one
  defect of each other on the overlap rule and within one on the honest reading.
  That is not a result that would survive a second model or a second board.
- **The clean-board count conflates two different things.** Three of the graph's
  eight are true measurements it was handed — "Decoupling capacitor for ULN2003
  GND is 17.2 mm away" is correct, and the distance came out of the board. They
  are not defects anyone seeded, but they are not inventions either.
- **The refutation check is narrow.** It catches a part or net that does not
  exist and a disconnection claim the copper denies. It has nothing to say about
  a trace-width claim, which is most of what both detectors report.
- **Neither prompt was edited after a score was seen.** `prompt_hash` makes that
  checkable, and `tests/run.py` step 13 fails when the committed result predates
  the current prompts — which is how the stale results in this file were caught
  twice.

Three harness bugs were fixed between runs, and everything was re-scored:

1. **The first sweep was invalid.** The distiller took a list of "focus" refs
   and printed the geometry around them, ending with the literal word `edited` —
   so the prompt named the part that had just been broken on a seeded board and
   said nothing on the clean one. `distill()` now takes the board and nothing
   else, and the plumbing that fed it is gone rather than merely unused.
2. Reviewers write `D2.2` meaning pin 2 of D2, and the adjudicator's
   contradiction check read that as a part that does not exist, throwing out
   twenty correct findings.
3. The layout node was told to read a `PLACEMENT` section the distiller had
   stopped emitting, and nothing pointed at the `DECOUPLING` section that
   replaced it. Both prompts now name the same sections in the same words, so
   what varies is the decomposition and not who was told where to look.

### What it cost

The full sweep from cold: 44 model calls, 155k tokens in, 106k out, **$0.0869**,
242 seconds at two concurrent requests. That figure comes from the per-call
token counts rather than from what the run happened to spend, so it does not
shrink to zero the moment the cache is warm. Re-scoring after a harness change is
free and takes four seconds — the disk cache is keyed on `(model, prompt)`.
Four sweeps and all the development around them came to about forty cents.

Every call is logged with its tokens, seconds and dollars. Every sweep carries
the prompt hash, the schema hash and the corpus hash, because a score that
outlives the system it measured is worse than no score.

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

## What I would do next

In order of how much each would change what this measures.

1. **Make findings machine-checkable.** The grading section above is really an
   argument for a different output schema: a `claim` field naming the kind of
   defect plus the pin or net it is about. Then `caught` is an equality test
   rather than a judgement call, and the recall numbers mean what they look like
   they mean.
2. **Run the deterministic rules in the page.** They already exist, the copper
   geometry is already ported to the browser, and the thing the README argues —
   that a millisecond of rule beats a dollar of model on some defect classes,
   and loses badly on others — would be visible to anyone who opens it rather
   than only stated here.
3. **A second model.** Whether decomposition beats capability is the question
   behind the whole comparison, and one model cannot answer it. About twenty
   cents.
4. **More boards.** Seven defects on one board is a corpus you can overfit by
   accident. The extractor takes any KiCad project; the presets are the part
   that is board-specific.

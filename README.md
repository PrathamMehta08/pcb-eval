# PCB Eval

A browser tool for breaking a real circuit board on purpose and measuring
whether a language model notices.

An editable board, a review button, and a score.
**[Open the page](https://claude.ai/code/artifact/57369783-5bbd-45c9-a3fa-fa314b956d0d)**; it
reviews with your own Claude account and needs no key.

Pressing Review runs the graph in front of you — each node as it starts, what it
proposed, what the board refuted, and the gate's decision at each turn of the
loop.

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

That defect is why the board view is editable rather than decorative. It does
not exist in the netlist at all — the netlist says GND is one net, and it is
right, and the copper disagrees. A tool that reviews a netlist cannot represent
it, let alone find it.

## Results

Eight boards — one clean, seven seeded. Two detectors, given the same distilled
board, the same output schema, the same model and the same temperature, and
pointed at the same data sections in the same words. The only thing that varies
is that one asks a single flat prompt to do all three jobs, and the other splits
them across a LangGraph pipeline of three specialists plus an adjudicator.

`openai/gpt-oss-120b` · prompts `b6cfd574e684` · schema `cd607fa645b8` · corpus `c945775a879c`
· full record in [`results/latest.json`](results/latest.json)

| | one prompt | the graph |
|---|---|---|
| defects matched, of 7 | 7 | 7 |
| **defects the finding actually names** | **2** | **5** |
| findings the copper refutes — reported | **1** | **0** |
| findings the copper refutes — proposed | 1 | 2 |
| findings on the clean board | 5 | 3 |
| model calls per board | 1 | 4, or 8 when the gate loops |

The first row says nothing — both detectors match all seven under the plan's
rule. The rows under it are the result.

### Why the recall row says nothing

The plan's rule is that a finding matches a defect when their component refs or
net names intersect. That cannot tell a finding that *identified* a defect from
one that merely *mentioned a part the defect touches*, so every match records
`via` — the identifier it rested on — and `breadth`, how many names the finding
threw at the board. Reading the pairs is a judgement; here is the data.

**One prompt: two of its seven name the defect.**

| defect | matched on | the finding that "caught" it | names it? |
|---|---|---|---|
| `vfb-vbst-swap` | `S1` | /SW is not driven by any PWM source | no |
| `stepper-common-open` | `+5V` | Schottky D2 is oriented anode on +5 V | no |
| `servo-power-end-pin` | `+5V` | D2 is oriented anode on +5V, shorting the rail | no |
| `ultrasonic-crossed` | `U2` | Numerous MCU pins are left unconnected | no |
| `stepper-in4-floating` | `U3` | Trace width on +5V is only 0.50 mm | no |
| `unbuildable-value` | `R4` | **Resistor R4 has no value defined** | **yes** |
| `ground-stranded` | `GND` | **The GND net is split into 28 separate copper islands** | **yes** |

**The graph: five of seven, and four of those name it exactly.**

| defect | matched on | the finding that caught it | names it? |
|---|---|---|---|
| `vfb-vbst-swap` | `S1`, `VBST` | **VFB is only connected to C4.2 on net VBST** | **yes** |
| `stepper-common-open` | `J11`, `/O5` | **J11 provides only open-collector outputs, no ground or supply** | **yes** |
| `servo-power-end-pin` | `J4`, `+5V`, `GND` | **J4 pin order is signal, ground, power instead of signal, power, ground** | **yes** |
| `ultrasonic-crossed` | `J2`, `/ECHO`, `/TRIG` | **Header order is VCC, ECHO, TRIG, GND instead of VCC, TRIG, ECHO, GND** | **yes** |
| `stepper-in4-floating` | `U3` | Decoupling capacitor C16 is 17.2 mm from U3.8 | no |
| `unbuildable-value` | `R4` | **Resistor R4 has no defined resistance value** | **yes** |
| `ground-stranded` | `GND` | NRST pin lacks an external pull-up | no |

Five against two, and the graph's are specific: it names the pin, the connector
and the order they should be in. Those four are the defects that need the
datasheet's own pin names and the module's own pinout, which is what the
`datasheet` and `connections` nodes exist to read.

### The row that needs no opinion

A finding that says a net is split into copper islands, on a net whose copper is
one connected piece, is wrong — and the geometry says so. `harness/grade.py`
measures that for both detectors, over both what each *proposed* and what it
*reported*, so the graph earns nothing merely for having a stage the baseline
lacks.

- **The graph proposed two claims the board refutes and reported neither.**
- **The single prompt proposed one and reported it**: that R2 sits on `+5V`
  rather than `/FB`, "leaving the buck converter feedback node unconnected" — on
  a board where `/FB` is one connected piece of copper across all three of its
  pads. Nothing in that path consults the board before speaking.

That is the design in one number. LLM nodes propose; deterministic checks
dispose. The referee is the board.

### What is not being claimed

- **Seven defects on one board is a small corpus**, and it has been run five
  times as the harness was corrected. The gap has moved between runs — earlier
  ones had the two detectors level at two real catches each. This one is the
  widest the graph has been ahead, and one board is not enough to say it will
  hold against a second model.
- **The clean-board count conflates two things.** Some of what both raise there
  is true and simply not a seeded defect: the ULN2003's decoupling capacitor
  really is 17.2 mm from its ground pin.
- **The refutation check is narrow.** It catches a part or net that does not
  exist and a disconnection claim the copper denies. It says nothing about a
  trace-width claim, which is much of what both detectors report.
- **Neither prompt was edited after a score was seen.** `prompt_hash` makes that
  checkable, and `tests/run.py` step 13 fails when the committed result predates
  the current prompts — which has caught a stale result three times.

Harness bugs fixed between runs, everything re-scored each time:

1. **The first sweep was invalid.** The distiller took a list of "focus" refs and
   printed the geometry around them, ending with the literal word `edited` — so
   the prompt named the part that had just been broken on a seeded board and
   said nothing on the clean one. `distill()` now takes the board and nothing
   else.
2. Reviewers write `D2.2` meaning pin 2 of D2, and the adjudicator's
   contradiction check read that as a part that does not exist, throwing out
   twenty correct findings.
3. The layout node was told to read a `PLACEMENT` section the distiller had
   stopped emitting. Both prompts now name the same sections in the same words.
4. The schema gained a `fix` field, so a finding says what to do about itself
   rather than only what is wrong.

### What it cost

The full sweep from cold: 48 model calls, 170k tokens in, 112k out, **$0.093**,
147 seconds at two concurrent requests. That figure comes from the per-call
token counts rather than from what the run happened to spend, so it does not
shrink to zero when the cache is warm. Re-scoring after a harness change is free
and takes four seconds; changing a prompt invalidates all of it.

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

One HTML file, 0.40 MB, published as an Artifact. It holds the extracted board
and ten ES modules.

One view: the board, drawn element by element from the board object rather than
from a plot, so every pad, track, via and pour is selectable — 53 footprints,
400 tracks, 63 vias, five pours. Reassign a pin to another net, swap two pins,
change a value, drag a part, rotate it, delete a track, change its width, delete
a via, turn a pour off.

There were three views and now there is one. The schematic was KiCad's own
1.2 MB plot, which is a picture — edits could not change it — and which cannot be
produced at all for a board someone uploads, because making it needs KiCad's
plotter. The bare layout was the board with the copper switched off. Neither
earned its megabyte.

A schematic edit stops at the schematic: the netlist changes and the copper keeps
the routing it was extracted with, which is the real failure mode this tool is
about. The board shows where the two now disagree — an amber ring and a dashed
line to the pad the netlist now claims, a red ring on a pad the copper has
stranded.

Every edit is one of nine named operations, appends to the edit log, and is
reversible. The review reads the mutated board, never the original files.

Reviewing uses the artifact `sample` capability, so no API key is embedded and
the viewer's own account pays. Four limits, all enforced: a cache keyed on the
board hash, one review per ten seconds, five per browser, and never on load.
Per-browser rather than per-visitor, because a static page has no server to
count against an address — and the bill lands on whoever clicks, not on me.

You can also drop your own KiCad project folder on the page. It is read in the
browser with no upload and no API call; the board view, the edits and the rule
checks all work on it.

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
site/        ten ES modules; tools/build_site.py makes one file of them
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

# PCB Eval

A browser tool for breaking a real circuit board on purpose and measuring
whether a language model notices.

An editable board, a review button, and a score.
**[Open the page](https://pcb-eval.vercel.app)**; the review runs through a
serverless function that holds the key, so nothing is needed to try it.

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

Eight boards - one clean, seven seeded. Two detectors, given the same distilled
board, the same output schema, the same model and the same temperature, and
pointed at the same data sections in the same words. The only thing that varies
is that one asks a single flat prompt to do all three jobs, and the other splits
them across a LangGraph pipeline of three specialists plus an adjudicator.

**The whole sweep is run five times.** One run of this cannot be told apart from
noise: an earlier single-run sweep put both detectors at 7 of 7, and that number
turns out to be the top of the range rather than the typical case. Everything
below is a median over five trials with the full range beside it, and the
per-trial numbers are in the record.

`openai/gpt-oss-120b` - 5 trials - 216 calls - prompts `b6cfd574e684` - schema
`cd607fa645b8` - corpus `d2138f0ecf8d` - full record in
[`results/latest.json`](results/latest.json)

| per trial, median (min-max) | one prompt | the graph |
|---|---|---|
| defects matched, of 7 | 5 (5-7) | **6 (6-7)** |
| findings on the clean board | 7 (5-8) | **5 (2-7)** |
| unmatched findings on the seeded boards | **41 (37-43)** | 48 (39-55) |
| findings the copper refutes - proposed | 2 (1-2) | 3 (3-7) |
| **findings the copper refutes - reported** | **2 (1-2)** | **0 (0-0)** |
| model calls per board | 1 | 4, or 8 when the gate loops |

Over all five trials: 28 of 35 for the single prompt, 32 of 35 for the graph.

### The row that needs no opinion

A finding that says a net is split into copper islands, on a net whose copper is
one connected piece, is wrong - and the geometry says so. `harness/grade.py`
measures that over both what each detector *proposed* and what it *reported*, so
the graph earns nothing merely for having a stage the baseline lacks.

**The graph reported zero board-refuted claims in all five trials. The single
prompt reported one or two in every trial, and never zero.** The ranges do not
overlap, and the graph's variance on it is nil.

That is the design in one number, and it is the only number here that needs no
judgement: LLM nodes propose, deterministic checks dispose, and the referee is
the board. It is also the only comparison in this table whose ranges separate
cleanly - every other row overlaps.

### Where recall comes from, and why 7 of 7 was not real

Per defect, out of five trials:

| defect | one prompt | the graph |
|---|---|---|
| `vfb-vbst-swap` | 5 | 5 |
| `servo-power-end-pin` | 5 | 5 |
| `ultrasonic-crossed` | 5 | 5 |
| `ground-stranded` | 5 | 5 |
| `stepper-common-open` | 4 | 5 |
| `stepper-in4-floating` | 3 | 4 |
| `unbuildable-value` | **1** | **3** |

Four of the seven are caught every time by both, and the comparison lives
entirely in the other three. `unbuildable-value` - a resistor whose value reads
`R`, which no assembler can buy - is the noisiest: the single prompt found it
once in five. The earlier single-run sweep caught it with both detectors, which
was a one-in-five draw for the baseline written up as though it were the norm.

The deterministic rule in `harness/checks.py` catches it five times out of five,
for no tokens, which is the argument the whole project is making.

### The matching rule is generous, and one detector exploits it

A finding matches a defect when their component refs or net names intersect.
That cannot tell a finding that *identified* a defect from one that merely
*named a part the defect touches*, so every match records `breadth`: how many
refs and nets the finding threw at the board.

| breadth of a matched finding | one prompt | the graph |
|---|---|---|
| median | 2 | 4 |
| mean | 8.46 | 4.09 |
| 90th percentile | 37 | 6 |
| largest | **50** | **8** |
| share naming 10 or more | **14%** | **0%** |

The single prompt's matches are bimodal. Just over half name two things or
fewer, which is genuinely specific - and 14% name ten or more, one of them
naming **50 refs and nets on a board with 53 components**. A finding that names
most of the board intersects any defect you like. The graph never does this: its
widest match names eight.

Discounting matches above a breadth cutoff, out of 35:

| a match may name at most | one prompt | the graph |
|---|---|---|
| no limit | 28 | 32 |
| 20 | 24 | 32 |
| 10 | 24 | 32 |
| 6 | 23 | 31 |
| 4 | 18 | 19 |
| 2 | **15** | **6** |

**This is the honest shape of the result, including where it turns over.** From
a cutoff of 6 to 20 the graph leads by eight or nine and the lead is flat,
because that band removes the single prompt's scattergun matches and touches
almost none of the graph's. Below 4 the gap closes, and at 2 it reverses - the
graph habitually names about four things (the part, the pin, the net, the
connector at the other end) where the single prompt sometimes names exactly one.

So *more specific* is the wrong word for what the graph is. The right one is
*bounded*: it never buys a match by naming half the board, and the baseline does
that in one match out of seven.

### What is not being claimed

- **It is one board.** Seven defects seeded into a single design - one MCU, one
  power tree, one connector set - so they are not independent draws. Five trials
  fix the noise in the measurement, not the narrowness of the corpus.
- **Only the automatic metrics are repeated.** Whether a finding *reads* as
  identifying its defect is a judgement, and judging 5 x 14 pairs by hand would
  be a worse number than not having one. `breadth` is the automatic proxy, and
  the table above is what it says.
- **The graph is noisier on the seeded boards**, 48 unmatched findings to 41,
  and produces more findings overall - 298 to 263 across the sweep. It is
  quieter only where it counts: the clean board, and refuted claims.
- **The clean-board count conflates two things.** Some of what both raise there
  is true and simply not a seeded defect: the ULN2003's decoupling capacitor
  really is 17.2 mm from its ground pin.
- **The refutation check is narrow.** It catches a part or net that does not
  exist and a disconnection claim the copper denies. It says nothing about a
  trace-width claim, which is much of what both detectors report.
- **Neither prompt was edited after a score was seen.** `prompt_hash` makes that
  checkable, and `tests/run.py` step 13 fails when the committed result predates
  the current prompts - which has caught a stale result three times.

Harness bugs fixed between runs, everything re-scored each time:

1. **The first sweep was invalid.** The distiller took a list of "focus" refs and
   printed the geometry around them, ending with the literal word `edited` - so
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
5. **Every sweep before this one was a single run**, and the headline it produced
   - 7 of 7 against 7 of 7 - was the best draw of five for both detectors.
   `--trials` folds a trial index into the cache key, so a repeat asks the model
   again instead of replaying the answer it gave last time.

### What it cost

Five trials from cold: 216 model calls, 764k tokens in, 529k out, **$0.43**,
18 minutes at two concurrent requests. That figure comes from the per-call token
counts rather than from what the run happened to spend, so it does not shrink to
zero when the cache is warm. Re-scoring after a harness change is free; changing
a prompt invalidates all of it.

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

The review goes to `/api/review`, a serverless function that holds the key, so
nothing reaches the browser and no visitor needs an account. The limits are in
two places on purpose. In the browser: a cache keyed on the board hash, one
review per ten seconds, five per session, and never on load. In the function:
per-IP hourly and daily ceilings, counted against the address Vercel writes into
`x-forwarded-for` rather than one the client can pick for itself.

Neither is a spending guarantee, and `api/review.mjs` says so where someone
changing it will read it. A serverless counter lives in one warm instance and
dies with it, so the hard ceiling is the spending limit set in the Groq console:
enforced by the party doing the billing, and not routed around by running more
instances. Everything in the function is courtesy on top of that.

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
.venv/Scripts/python.exe -m harness.run --trials 5 --tpm 40000 --concurrency 2
```

`--trials` repeats the whole sweep and reports a median with its range. It folds
the trial number into the cache key, so trial 2 asks the model again rather than
replaying trial 1 — without which repeating a sweep measures the cache and
reports a variance of zero.

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
2. **A second model.** Whether decomposition beats capability is the question
   behind the whole comparison, and one model cannot answer it. The trial
   machinery makes it cheap: `--trials 5 --model <other>` is about a dollar, and
   it is the difference between "the graph helps this model" and "the graph
   helps".
4. **More boards.** Seven defects on one board is a corpus you can overfit by
   accident. The extractor takes any KiCad project; the presets are the part
   that is board-specific.

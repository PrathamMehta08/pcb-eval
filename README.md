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

## What it works on

Any KiCad project. `extract/` reads a `.kicad_pcb` and a `.kicad_sch` into one
board object; the page reads the same pair in the browser with no upload. Every
rule is structural — a four-pin header with one supply, one ground and two
signals; a supply pin sharing a net with a port; a net whose pads sit on more
than one island — so none of them names a part, and none was written against a
particular defect. The prompts name nothing board-specific either, and
`tests.run 12` fails if that changes.

One board is the **corpus**, not the scope. It is the design the numbers below
were measured on, because scoring a detector needs defects whose location is
already known.

## The board the numbers come from

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
board, the same model and the same temperature. One asks a single flat prompt to
do all three jobs; the other splits them across a LangGraph pipeline of three
specialists, a merge, and a deterministic critic. The whole sweep runs five
times, because a single run of this cannot be told apart from noise.

`openai/gpt-oss-120b` - 5 trials - 439 calls - prompts `51fa87930f52` -
schema `96e5a7694704` - corpus `56602c9aa9ca` - pipeline
`d7d5464cc261` - full record in
[`results/latest.json`](results/latest.json)

Three detectors. **one prompt** is a single call with the whole board. **V7** is
that same call, byte for byte, with a deterministic layer before it and two
gates after. **V8** is V7 plus one more call that asks the reviewer what its own
first pass missed.

| per trial, median (min-max) | one prompt | V7 | V8 |
|---|---|---|---|
| defects matched, of 13 | 7 (4-9) | 9 (8-11) | **12 (8-12)** |
| findings on the clean board | **4 (3-5)** | 5 (3-6) | 8 (6-9) |
| unmatched findings on the seeded boards | **26 (22-36)** | 30 (17-46) | 52 (44-75) |
| **findings the copper refutes - reported** | 6 total | **0** | **0** |
| model calls per board | 1 | 2 | 3 |

Over five trials, recall on the seeded defects:

| over 5 trials | one prompt | V7 | V8 |
|---|---|---|---|
| **rule-silent, of 45** | 24 | 27 | **35** |
| all defects, of 65 | 33 | 47 | **55** |
| board-refuted claims proposed | 6 | 3 | 13 |
| board-refuted claims reported | 6 | **0** | **0** |

**Rule-silent is the headline, and it is the smaller number on purpose.** Four
of the thirteen seeded defects are also caught by a deterministic rule, and
three of those are a rule and a generator written from the same condition -
`supply-on-signal` against `power-pin-on-signal-net`, `value-unorderable`
against `value-not-orderable`. Any system carrying those rules catches those
defects, so recall over all thirteen partly measures that coincidence rather
than the reviewer. The rule-silent column is the nine no rule fires on, and V8
wins there too: **35 of 45 against 24**.

The other column that matters is the last one. The single prompt reported six
findings the board's own copper contradicts. V7 and V8 proposed sixteen between
them and reported none, because the deterministic gate refuses a finding whose
subject is not on the board, whose evidence is not in what the model was shown,
or that the board itself disproves. That gate is not the grader - the grader is
a separate frozen function - so this is not the ruler being moved.

What V8 costs is noise: eight findings on a clean board against four. It finds
half again as many real defects and roughly doubles what it says about a board
that is fine.

### One sample of a reviewer is not the reviewer

The measurement that produced V8, and the most surprising number here.

Two runs of the *same* reviewer, on the *same* prompt, at temperature zero,
caught seven and eleven of thirteen defects - and between them covered twelve.
Not different architectures. The same question asked twice. The spread between
one draw and another was wider than the spread between any two architectures
this project has measured.

So V8 takes a second draw. After the first pass it asks the same model, with the
same board, what its own list is missing - and it is shown only that list, never
the rule findings and never the defects. It costs one call and it is worth eight
points of rule-silent recall.

The corollary is worth stating plainly: **any single-sample comparison of two
reviewers on this corpus is mostly noise.** The first version of V7 measured
7 of 13 and the corrected one measured 11, and part of that gap was the fix and
part was the draw. Five trials is the minimum this corpus supports, and
`tests.run 13` refuses to accept a committed sweep with fewer.

### What V7 got wrong first, which was mine and not the model's

V7's first build scored *below* the baseline - 3 of 9 rule-silent against 5.

Its pack carried a catalogue of the deterministic checks with a note not to
spend the answer on what they cover. The reviewer read "these are handled" as
covering whole categories rather than the individual checks named, and stopped
reporting a swapped regulator and an oversized companion capacitor - neither of
which any rule had fired on, and both of which the baseline caught. The
suppression note cost more recall than the duplicate findings it saved, and
duplicates were already free to merge afterwards.

The reviewer is now handed the baseline's prompt through the baseline's own
builder, so the two are asked the same question about the same bytes and
anything V7 or V8 wins is the architecture around the call.

### The prompts used to name the defects, and the scores moved when they stopped

This is the finding worth reading the rest for.

Until this sweep the reviewers' prompts opened with a description of this exact
board, and the jobs spelled out the conventions the seeded defects break - a
three-wire servo lead's pin order, a four-wire sensor module's pin order, the
buck's supply pins, the buck's 3 A rating. The output schema's own example
carried this board's net names, `/FB` and `VBST`. None of that was edited after
a score was seen, but all of it told the detectors where to look.

Removing every trace of it, so a prompt names no part, no net and no convention
specific to one board, cost both detectors about a fifth of their recall:

| over 5 trials | prompts naming the defects | board-agnostic prompts |
|---|---|---|
| the graph, caught /35 | 27 | **21** |
| one prompt, caught /35 | 28 | **24** |
| the graph, clean-board findings | 17 | 21 |
| one prompt, clean-board findings | 33 | **18** |
| the graph, seeded noise | 97 | 166 |
| one prompt, seeded noise | 202 | **100** |

**And it reverses the comparison.** With prompts that named the defect classes,
the graph led on noise and matched on recall. Without them the single flat
prompt is ahead on recall, 24 to 21, and quieter on the seeded boards, 100
unmatched findings to 166. Everything this project previously reported about
decomposition beating a flat prompt was measured through prompts that had been
told what to find.

`tests/run.py` step 12 now fails if any prompt names a part, a net, a designator
or a board-specific convention, so the leak cannot come back quietly. The guard
earned its place immediately: its first version used a length cutoff and sailed
past `S1` and `/FB` sitting in the schema example.

### What survives

One thing, and it is the one that needs no judgement.

**The graph reported zero findings the copper refutes, in all five trials. The
single prompt reported one in the median trial and up to two.** A finding that
says a net is split into islands, on a net whose copper is one connected piece,
is wrong and a union-find says so. The graph proposes none of them at all now
(0 of 0); the baseline proposes five across the sweep and reports all five.

Its matched findings are also tighter: a mean breadth of 2.9 names against 8.21,
and it never buys a match by naming half the board.

That is a real difference, and it is a smaller claim than the one this README
used to make. Decomposition did not beat a flat prompt at finding defects on this
corpus. What it bought is that nothing reaches the report which the board itself
can contradict.

### Where recall comes from

Per defect, out of five trials:

| defect | the graph | one prompt |
|---|---|---|
| `vfb-vbst-swap` | 5 | 5 |
| `ground-stranded` | 4 | 4 |
| `stepper-common-open` | **4** | 2 |
| `servo-power-end-pin` | **3** | 2 |
| `stepper-in4-floating` | **3** | 1 |
| `ultrasonic-crossed` | 1 | **5** |
| `unbuildable-value` | 1 | **5** |

The graph leads on three, the baseline on two, and they tie on two. The
baseline's two are the ones a deterministic rule settles instantly - a value
with no digits in it, and a header whose pin order does not match the module -
which is the argument this project keeps arriving at from different directions.

### What is not being claimed

- **It is one board.** Seven defects seeded into a single design, so they are
  not independent draws. Five trials fix the noise in the measurement, not the
  narrowness of the corpus.
- **The spread is wide enough to swallow most of these differences.** The
  graph's clean-board count ranges from 0 to 10 across five identical runs. Read
  the ranges, not the medians.
- **Recall here is the model's, not the system's.** The deterministic rules
  always run, and on every miss the rule for that defect fired. That is equally
  true of both detectors.
- **The clean-board count conflates two things.** Some of what both raise there
  is true and simply not a seeded defect: a decoupling capacitor really is
  17.2 mm from its ground pin, and one reset pin really has no external pull.
- **The refutation check is narrow.** It settles existence, split nets, values,
  and whether a net is held at a level. It says nothing about a thermal or
  current claim, which is why those are not solicited.

### What it cost

Five trials from cold: 439 model calls, 952k tokens in, 804k out, **$0.6249**,
23 minutes at two concurrent requests. Every sweep carries the prompt, schema,
corpus and pipeline hashes, because a score that outlives the system it measured
is worse than no score - and `pipeline_hash` exists because adding an evaluator
once changed the results while the other three hashes stayed identical.


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

The research agent reads the datasheet URLs the schematic already carries, and
needs the network once. Everything after that runs from its cache:

```bash
.venv/Scripts/python.exe -m harness.research   # fetch, cache, extract
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
baseline/    the single flat prompt every architecture is measured against
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

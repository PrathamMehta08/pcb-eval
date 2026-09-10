# PCB Eval

A browser tool for breaking a real circuit board on purpose and measuring
whether a language model notices.

An editable board, a review button, and a score.
**[Open the page](https://pcb-eval.vercel.app)**; the review runs through a
serverless function that holds the key, so nothing is needed to try it.

Pressing Review walks the five nodes in front of you — which one is running,
which two ask a model and which three are arithmetic, what each proposed, and
what the board refused.

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

A second board, `dcdcc`, is a bare TPS561208 buck converter, and between them
they carry thirteen seeded defects. None is invented. Each is a fault the design
could plausibly have shipped with, and one of them is the fault this board
**did** ship with:

> Every ground pad on the top layer stranded from the pour on the bottom.
> No stitching vias, no top pour. ERC passed. DRC passed. The board did not work.

That defect is why the board view is editable rather than decorative. It does
not exist in the netlist at all — the netlist says GND is one net, and it is
right, and the copper disagrees. A tool that reviews a netlist cannot represent
it, let alone find it.

## Results

One corpus, two detectors, five trials.

**one prompt** is the baseline: the whole distilled board, one model call,
whatever it says is the answer. **V8** wraps that same call - the same bytes,
the same question, through the same prompt builder - in deterministic work
before and after it, and adds one more call that asks the reviewer what its own
first pass missed.

`openai/gpt-oss-120b` - 5 trials - 225 calls - prompts `29d9b80529de` -
schema `96e5a7694704` - corpus `56602c9aa9ca` - pipeline
`7c696b353d19` - full record in
[`results/latest.json`](results/latest.json)

Two boards, one clean case each and thirteen seeded defects. Every seeded board
carries exactly one planted defect, so a trial is 13 chances to catch something
and 2 chances to invent something.

## The two architectures

Boxes a model sees are marked `LLM`. Everything else is arithmetic.

```text
ONE PROMPT                    V8

                              analyse
                              distil the board,
                              run the rules
                                 |
  distil the board            distil the board
     |                           |
  +--------+                  +--------+
  | review |  LLM             | review |  LLM
  +--------+                  +--------+
     |                           |
     |                        +-------------+
     |                        | second look |  LLM
     |                        +-------------+
     |                           |
     |                        validate
     |                        is the subject on this board?
     |                        does the copper refute it?
     |                        is it a repeat?
     |                           |
     |                        aggregate
     |                        merge with the rules, rank, score
     |                           |
  findings                    findings

1 call/board                 2 calls/board
```

There is no LLM critic in V8, and its absence is a measurement rather than an
omission - see below.

## What they scored

| per trial, median (min-max) | one prompt | V8 |
|---|---|---|
| defects caught, of 13 | 7 (4-9) | **12 (8-12)** |
| findings on the clean boards | **4 (3-5)** | 8 (6-9) |
| unmatched findings on seeded boards | **26 (22-36)** | 52 (44-75) |

| over 5 trials | one prompt | V8 |
|---|---|---|
| **rule-silent recall** | 24 of 45 - 53% | **35 of 45 - 78%** |
| all defects | 33 of 65 - 51% | **55 of 65 - 85%** |
| **findings the copper refutes - reported** | 6 | **0** |
| model calls per board | 1 | 2 |
| **cost per pass** (15 boards) | $0.024 | $0.058 |
| cost per board | $0.0016 | $0.0039 |

At these prices a hundred boards is sixteen cents with the baseline and thirty-
nine with V8. The model is `openai/gpt-oss-120b` at $0.15 per million tokens in
and $0.60 out; a different model moves every figure in those two rows and none
of the figures above them.

## What "rule-silent" means, and why it is the headline

Four of the thirteen seeded defects are also caught by a deterministic rule, and
three of those are a rule and a generator written from the same condition -
`supply-on-signal` against the `power-pin-on-signal-net` rule,
`value-unorderable` against `value-not-orderable`. The defect is planted by the
same logic that detects it.

Any system carrying those rules catches those defects with no model involved, so
recall over all thirteen is partly a measurement of that coincidence rather than
of the reviewer.

**Rule-silent recall is over the nine defects no rule fires on.** It is the
smaller, less flattering number and the one that distinguishes one reviewer from
another. V8 wins there - **78% against 53%** - so the gain is the architecture
and not the rules.

Both are reported because both are true: rule-silent measures the reviewer, and
all-defects measures what the system delivers to someone reviewing a board.

## The gap between two draws is wider than the gap between two architectures

The measurement that produced V8, and the most surprising number here.

Two runs of the *same* reviewer, on the *same* prompt, at temperature zero,
caught seven and eleven of thirteen defects - and between them covered twelve.
Not different architectures. The same question asked twice.

So V8 takes a second draw. After the first pass it asks the same model, with the
same board, what its own list is missing - and it is shown only that list, never
the rule findings and never the defects. It costs one call and it is worth eight
points of rule-silent recall.

The corollary is worth stating plainly: **a single-sample comparison of two
reviewers on this corpus is mostly noise.** Five trials is the minimum it
supports, and `tests.run 13` refuses a committed sweep with fewer.

## The LLM critic was measured three ways and deleted

V8 was specified with one. It does not have one.

Wired as written it rejected **409 of 409 findings across five trials** - the
entire reviewer output. It was told to be strictest about whether quoted
evidence supports a claim, and this schema carries no quoted evidence, so every
finding reached it reading `evidence: (none quoted)`. Recall fell to exactly the
four defects the deterministic rules catch.

Rewritten to judge what is actually there, and told the asymmetry - a defect
rejected is gone and ships with the board, a doubtful finding kept costs a
person a minute - it went the other way and rejected six of two hundred and
twenty-nine. Over five trials it cost two rule-silent defects, 33 against 35,
and saved one finding on a clean board.

So it went, and V8 got cheaper as well as better. What it was meant to do is
already done by `validate`, which is arithmetic and string comparison rather
than a second opinion - and which is why V8 reports zero findings the board
contradicts while the baseline reports six.

The rule it failed is this project's own: **if what would refute a node's output
is a measurement, build the measurement; if the answer is another model, the
node is probably unnecessary.**

## What is not being claimed

- **It is two boards.** Thirteen defects seeded into two designs, so they are
  not independent draws. Five trials fix the noise in the measurement, not the
  narrowness of the corpus.
- **The spread is wide.** V8's per-trial catch ranges from 8 to 12. Read the
  ranges, not the medians.
- **V8 is noisier.** Eight findings on a clean board against four. It finds half
  again as many real defects and roughly doubles what it says about a board that
  is fine, and the clean-board count is the honest measure of that cost.
- **The clean-board count conflates two things.** Some of what both raise there
  is true and simply not a seeded defect: a decoupling capacitor really is
  17.2 mm from its ground pin, and one reset pin really has no external pull.
- **The refutation check is narrow.** It settles existence, split nets, values,
  and whether a net is held at a level. It says nothing about a thermal or
  current claim, which is why those are not solicited.
- **No prompt names anything belonging to one board.** Not a part, not a net,
  not a convention only one seeded defect breaks. `tests.run 12` asserts it
  mechanically, and it earns its place: an earlier version of this project
  opened its prompts with a description of this exact board and its recall was a
  fifth higher for it.

## Attaching datasheets was unmeasured, and the fix is worth less than I thought

The page lets you drop a PDF onto a part. It retrieves passages from it and puts
them in the reviewer's pack - and the sweeps run offline with nothing attached,
so five trials said nothing at all about the pack somebody with datasheets
actually gets.

It needed saying. On the corpus board - 810 distilled words, three cached
datasheets - the section was three whole 350-word chunks per documented part
with no ceiling anywhere:

| documented parts | datasheet share of the pack |
|---|---|
| 0 | 0% |
| 1 | 56% |
| 3 | **78%** |

The board was 22% of the prompt written about it, and every document somebody
helpfully added made that worse. Given that this project's whole argument is
that a reviewer wants the *whole* board - splitting it between specialists is
what V2 through V6 lost recall doing - that looked like the architecture
inverted by dilution.

So the harness learned to carry a documentation block (`tools/doc_packs.py`
hands it the browser's own retrieval rather than reimplementing it), and V8 ran
three times over three packs that differ in nothing else.

| on the 11 documented cases, 3 trials | no documents | unbudgeted | budgeted |
|---|---|---|---|
| rule-silent recall | 16/21 - 76% | 17/21 - 81% | 15/21 - 71% |
| all defects | 25/30 - 83% | 26/30 - 87% | 24/30 - 80% |
| findings on clean, median | 5 | 6 | 7 |
| **prompt tokens per board** | 6,938 | **18,158** | **7,969** |
| cost per pass | $0.0508 | $0.0670 | $0.0476 |

**The recall differences are noise, and the per-trial numbers say so plainly.**

| rule-silent, of 7 | trial 1 | trial 2 | trial 3 |
|---|---|---|---|
| no documents | 7 | 6 | 3 |
| unbudgeted | 5 | 5 | 7 |
| budgeted | 5 | 5 | 5 |

Three draws of the same reviewer on the same prompt at temperature zero caught
seven, six and three. That range is wider than every gap between the three
variants put together. Stuffing four fifths of the prompt with datasheet text
did not measurably hurt this reviewer, and taking it away did not measurably
help it.

So the budget is kept on the two things that are not sampled at all: the prompt
is **56% smaller** on a documented board, the pass is **29% cheaper**, and the
section is now *bounded* - six documents cost what one does, where before the
growth was linear and had no limit. `tests/doc_budget.mjs` holds that.

What it is not is a recall improvement, and the honest headline is that the
problem I set out to fix was not the problem I found. The measurement said so
and the measurement wins.

## What it cost

Five trials from cold: 225 model calls, 628k tokens in,
528k out, **$0.4112**. Every sweep carries the prompt,
schema, corpus and pipeline hashes, because a score that outlives the system it
measured is worse than no score - and `pipeline_hash` covers the detectors' own
code, because it once did not and two sweeps an hour apart reported V8 at 55 of
65 and at 20 under the same hash.


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

Everything except the sweep itself needs no API key at all.

```bash
"/c/Program Files/KiCad/10.0/bin/python.exe" -m venv .venv
.venv/Scripts/python.exe -m pip install -U pip
.venv/Scripts/python.exe -m pip install langgraph langchain-openai pydantic python-dotenv tiktoken
```

```bash
.venv/Scripts/python.exe -m extract.build      # boards/stm32-good.json
.venv/Scripts/python.exe -m tests.run          # the acceptance checks, 19 of 19
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

That runs the baseline and V8. `--detector ablation` adds V7 - V8 without the
second look - which is how the value of that one call was measured. Then:

```bash
.venv/Scripts/python.exe tools/compare.py
```

which splits recall into rule-silent and all-defects, and refuses to print a
table quietly if the sweep was produced by different code than is checked out.

`--trials` repeats the whole sweep and reports a median with its range. It folds
the trial number into the cache key, so trial 2 asks the model again rather than
replaying trial 1 — without which repeating a sweep measures the cache and
reports a variance of zero.

`tests/run.py` is the contract: one check per row of the build order, each
asserting the thing that row claims. Nineteen of nineteen pass, and none of them
needs an API key: the graph's wiring and its deterministic checks are all
decidable against a stub, and only the quality of the findings is not.
`place()`, the transform every view and every copper check rests on, is pinned
to six pad centres read out of KiCad's own `layer-F_Cu.svg` plot — in Python and
again in JavaScript.

## Repository

```
extract/     kicadxml and .kicad_pcb into one Board object, joined on UUID
harness/     the nine edit operations, seven deterministic rules, the distiller,
             the Groq client, the grader, the sweep runner
graph/       V8: analyse, review, second look, validate, aggregate
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
   it is the difference between "this helps this model" and "this
   helps".
4. **More boards.** Thirteen defects on two boards is a corpus you can overfit by
   accident. The extractor takes any KiCad project; the presets are the part
   that is board-specific.

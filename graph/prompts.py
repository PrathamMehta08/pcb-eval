"""The prompts the three review nodes send, and the framing they share.

Each node gets one job and the whole board. That is the experiment: the baseline
in `baseline/single_prompt.py` asks one prompt to do all three at once, and the
score in the README is the difference between them.

The `sample` prompt on the page is a fourth thing again — a single-node version
of these, for latency. Comparing the page to the harness is the finding.
"""

from __future__ import annotations

import hashlib

SCHEMA = """{"findings": [{
  "severity": "critical" | "major" | "minor",
  "refs": ["<ref>", "..."],
  "nets": ["<net>", "..."],
  "problem": "one line naming the defect",
  "why": "one sentence on the consequence",
  "fix": "one sentence naming the change that would correct it"
}]}"""

#: The graph's schema. Three fields the single prompt does not ask for, and each
#: one exists to convert a judgement into something a machine can check:
#:
#:   claim     one of a closed vocabulary, so two reviewers describing the same
#:             defect collide on identity rather than on wording, and so the
#:             verifier knows which measurement settles it;
#:   subject   the single ref or net the finding is really about, as against the
#:             pile of names a finding throws when it is hedging;
#:   evidence  a line copied from the board, so a claim that rests on nothing in
#:             the data can be dropped without asking a model's opinion.
#:
#: This is the architecture change. The old schema could only be checked for
#: existence and for two hard-coded phrasings; this one can be checked per kind.
#: A vocabulary is a prompt. The first version of this list offered
#: `trace_undersized`, and on the clean board the reviewers filed twelve of them
#: - a quarter of everything they reported there - each resting on a current
#: figure the board data does not contain and the critic therefore could not
#: refute. Offering a category is an instruction to go and fill it, which is the
#: same failure as a report template with a section per topic. So a kind earns
#: its place here only if something can settle it.
CLAIM_KINDS = (
    "pin_miswired",
    "pinout_order",
    "connector_incomplete",
    "pin_floating",
    "value_unbuildable",
    "net_split",
    "decoupling_distance",
    "missing_component",
    "manufacturability",
    "other",
)

GRAPH_SCHEMA = """{"findings": [{
  "claim": one of "pin_miswired" | "pinout_order" | "connector_incomplete" |
           "pin_floating" | "value_unbuildable" | "net_split" |
           "decoupling_distance" | "missing_component" |
           "manufacturability" | "other",
  "subject": "<the one ref or net this finding is about>",
  "evidence": "a line copied exactly from the board data above",
  "severity": "critical" | "major" | "minor",
  "refs": ["<ref>", "..."],
  "nets": ["<net>", "..."],
  "problem": "one line naming the defect",
  "why": "one sentence on the consequence",
  "fix": "one sentence naming the change that would correct it"
}]}"""

SYSTEM = """You review printed circuit boards before they are manufactured. You
report only what the data supports. An empty findings list is the correct answer
for a board with no defects in your area, and inventing a defect is worse than
missing one. You always reply with JSON only, no prose around it."""

#: Appended to each reviewer's job. The single prompt never sees it.
CLAIM_RULES = """
Every finding must carry three extra fields, and a finding without them is
discarded unread:

- `claim`: the kind of defect, from the list in the schema. Pick the one that
  fits; use "other" only when none does.
- `subject`: the one ref or net the finding is actually about. Not a list. If
  you cannot name a single subject, you are describing more than one finding.
- `evidence`: one line copied exactly from the board data above — the line that
  makes the claim true. Copy it character for character. Do not paraphrase it,
  and do not write a line that is not there.

Name only what the finding needs. Listing extra refs and nets does not make a
finding stronger; it makes it unfalsifiable, and unfalsifiable findings are
thrown out.

What the board data does not contain: any current, load, power, temperature or
timing figure. There is no supply current for any rail, no duty cycle, no
ambient, and no stackup beyond the layer count. A finding that depends on one of
those depends on a number you would have to supply yourself, and supplying it is
inventing evidence. Do not report trace width, current capacity, heating or
power dissipation. Report what the netlist, the copper geometry and the pin
functions can settle."""

#: Deliberately empty, and it used to describe one board.
#:
#: It read "a two-layer STM32F103 controller for a pill dispenser: a TPS563208
#: buck converter from a barrel jack, an AMS1117-3.3 LDO..." - sent verbatim
#: with every review, including reviews of somebody else's board uploaded to the
#: page. It was wrong there, and redundant here: the distilled board already
#: opens with a COMPONENTS section giving every part its value, package and the
#: library's own description, so the model reads what this board is from the
#: data instead of being told what one board was.
BOARD_CONTEXT = ""

#: The tail every prompt shares. It says nothing about areas: the three node
#: jobs each say what is not theirs, and the single prompt has no area at all —
#: telling it otherwise would hand the comparison to the graph on wording.
_TAIL = """
Use the exact ref and net strings from the board so findings can be matched to
the design. Reply with JSON only, in exactly this shape:

{schema}

Here is the board.

{distilled}"""

#: What `single_prompt_template()` leaves for the page to substitute.
BOARD_SLOT = "<<<BOARD>>>"


def _build(job: str, distilled: str, schema: str = SCHEMA) -> str:
    head = f"{BOARD_CONTEXT}\n\n" if BOARD_CONTEXT else ""
    return f"{head}{job.strip()}\n" + _TAIL.format(schema=schema, distilled=distilled)


def _node(job: str, distilled: str) -> str:
    """A reviewer's prompt: its job, the claim rules, and the graph schema."""
    return _build(job.strip() + "\n" + CLAIM_RULES, distilled, GRAPH_SCHEMA)


DATASHEET_JOB = """Your area is what each pin is for, against what it is wired to.

The net list gives every pin the chip's own name for it, taken from the symbol
library, and the pin's electrical type. Use them. Look for:

- a pin whose library name says one node and whose net is another;
- a supply or bias pin sitting on a net with no source of that supply;
- a control pin wired somewhere its part cannot work from;
- a part whose value cannot be ordered.

Report only defects in your area. Do not comment on layout, copper, trace
widths or placement — another reviewer has those."""

CONNECTIONS_JOB = """Your area is the wiring between parts and off the board.

Look for:

- a connector whose pin order does not match the module that plugs into it.
  Headers like these are not keyed, so the board has to match the cable; the
  designer's own net names are what say which module is expected.
- an input pin with nothing holding it at reset. An MCU port is high impedance
  until firmware configures it, so an input whose only company is an MCU port
  and no pull resistor floats from power-up.
- two pins that both drive on one net, or a net with no driver at all;
- a connector that leaves the board with no ground or supply among its pins;
- a pin the design clearly meant to use that is left unconnected.

Report only defects in your area. Do not comment on layout, copper, trace
widths or placement — another reviewer has those."""

LAYOUT_JOB = """Your area is placement and copper.

The COPPER section states, per net, how many pads it has, how many separate
copper islands those pads sit on, how much track, the narrowest track, how many
vias, and which layers carry a pour. Read it carefully. Look for:

- a net whose pads sit on more than one island. That net is not connected,
  whatever the net list says. Both ERC and DRC read the net list rather than
  the copper, so both pass a board like that.
- a ground net with no vias tying the layers together, or with a pour on only
  one layer while pads sit on both;
- a decoupling capacitor far from the pin it serves. The DECOUPLING section
  gives that distance in millimetres for every supply pin on the board.

The board data carries no current, load, power, temperature or timing figure.
Do not report trace width, current capacity or heating: any such finding would
rest on a number you supplied yourself.

Report only defects in your area. Do not comment on schematic connectivity, pin
functions or part values — another reviewer has those."""

ADJUDICATE_JOB = """You are merging three reviews of one board into one list.

Below are findings from three reviewers, each numbered. Some describe the same
defect in different words. Return the numbers to keep: one per real defect,
choosing the clearest wording, and dropping anything that is a restatement,
a suggestion rather than a defect, or a claim the board data does not support.

Reply with JSON only:

{"keep": [0, 3, 7], "why": "one short sentence"}

Findings:

{findings}

Here is the board they reviewed.

{distilled}"""

SINGLE_PROMPT_JOB = """Review this board before it is manufactured. Weigh three
things:

1. What each pin is for, against what it is wired to. The net list gives every
   pin the chip's own name and its electrical type.
2. The wiring between parts and off the board: connector pin order against the
   modules that plug in, inputs with nothing holding them at reset, nets with
   no driver, parts whose value cannot be ordered.
3. Placement and copper. The COPPER section states, per net, how many pads it
   has, how many separate copper islands those pads sit on, how much track, the
   narrowest track, how many vias, and which layers carry a pour; the
   DECOUPLING section gives the distance from every supply pin to the nearest
   capacitor on its net. A net whose pads sit on more than one island is not
   connected, whatever the net list says. Ground return, pour coverage,
   decoupling distance.

The board data carries no current, load, power, temperature or timing figure.
Do not report trace width, current capacity or heating: any such finding would
rest on a number you supplied yourself.

Do not report style, silkscreen or aesthetics, or anything you would have to
guess at."""


def datasheet_prompt(distilled: str) -> str:
    return _node(DATASHEET_JOB, distilled)


def connections_prompt(distilled: str) -> str:
    return _node(CONNECTIONS_JOB, distilled)


def layout_prompt(distilled: str) -> str:
    return _node(LAYOUT_JOB, distilled)


def single_prompt(distilled: str) -> str:
    return _build(SINGLE_PROMPT_JOB, distilled)


def single_prompt_template() -> str:
    """The same prompt with a slot where the board goes.

    `site/review.js` builds this string too, and `tests/fixtures/distill.json`
    holds the Python's copy so the two are compared byte for byte. The page is
    meant to be the `single` detector, not something that resembles it — the
    README's `one prompt` column is only about the page if they are the same
    prompt.
    """
    return _build(SINGLE_PROMPT_JOB, BOARD_SLOT)


def adjudicate_prompt(findings_text: str, distilled: str) -> str:
    return (
        ADJUDICATE_JOB.replace("{findings}", findings_text)
        .replace("{distilled}", distilled)
    )


def prompt_hash() -> str:
    """Stamped onto every result. A score that outlives its prompts is a lie."""
    blob = "\n".join(
        [
            SYSTEM,
            BOARD_CONTEXT,
            SCHEMA,
            GRAPH_SCHEMA,
            CLAIM_RULES,
            _TAIL,
            DATASHEET_JOB,
            CONNECTIONS_JOB,
            LAYOUT_JOB,
            ADJUDICATE_JOB,
            SINGLE_PROMPT_JOB,
        ]
    )
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:12]

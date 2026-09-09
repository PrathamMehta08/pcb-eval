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
#: A vocabulary is a prompt, and this one was a list of the seeded defects.
#:
#: It offered the reviewers a closed set - `value_unbuildable`, `pinout_order`,
#: `net_split` and the rest - which was the corpus's own defect taxonomy handed
#: to the detector as the output format. Two things were measured about it.
#: Offering `trace_undersized`, for a quantity the board data does not carry,
#: produced twelve fabricated findings on a clean board out of thirty-six. And
#: once the board-specific hints were removed from the jobs, three quarters of
#: everything the reviewers said fell into the two kinds that can always be
#: satisfied - `pin_floating` and `decoupling_distance` - while the defect
#: actually seeded went unmentioned. A closed list is a checklist, and a model
#: fills the cheapest boxes on it.
#:
#: So there is no list any more. A reviewer invents a short tag for what it
#: found, which is enough for two findings about one defect to collide, and the
#: critic decides what it can from the finding's own words and the board.
#: Nothing here tells a detector what kinds of defect exist.
CLAIM_KINDS: tuple[str, ...] = ()

GRAPH_SCHEMA = """{"findings": [{
  "claim": "a short lowercase tag naming the kind of defect, in your own words",
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

- `claim`: a short lowercase tag for the kind of defect, in your own words.
  Two findings about the same kind of problem should carry the same tag.
- `subject`: the one ref or net the finding is actually about. Not a list. If
  you cannot name a single subject, you are describing more than one finding.
- `evidence`: one line copied exactly from the board data above — the line that
  makes the claim true. Copy it character for character. Do not paraphrase it,
  and do not write a line that is not there.

Name only what the finding needs. Listing extra refs and nets does not make a
finding stronger; it makes it unfalsifiable, and unfalsifiable findings are
thrown out.

inventing evidence."""

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

The board data carries no current, load, power, temperature or timing figure.
There is no supply current for any rail, no duty cycle and no ambient. A finding
that depends on one of those depends on a number you would have to supply
yourself, and supplying it is inventing evidence.

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

The NETS section gives every pin the name its symbol library uses for it and the
pin's electrical type, alongside the net the designer put it on. The COMPONENTS
section gives each part its value, package and the library's own description of
what it is.

Report anything in that which is wrong. Report only defects in your area: leave
copper, placement and trace geometry to another reviewer."""

CONNECTIONS_JOB = """Your area is the wiring between parts, and off the board.

The NETS section lists every net with the pins on it. Connectors are parts like
any other; what plugs into one is not written down anywhere, so the designer's
own net names are the only statement of intent you have.

Report anything in that wiring which is wrong. Report only defects in your area:
leave copper, placement and trace geometry to another reviewer."""

LAYOUT_JOB = """Your area is placement and copper.

The COPPER section states, per net, how many pads it has, how many separate
copper islands those pads sit on, how much track it carries, its narrowest
track, how many vias, and which layers carry a pour. The DECOUPLING section
gives the distance in millimetres from every supply pin to the nearest capacitor
on its own net.

Report anything in that geometry which is wrong. Report only defects in your
area: leave pin functions, part values and netlist connectivity to another
reviewer."""

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

SINGLE_PROMPT_JOB = """Review this board before it is manufactured.

You have the whole design. The COMPONENTS section gives each part its value,
package and the library's description of what it is. The NETS section gives
every net, the pins on it, each pin's library name and its electrical type. The
COPPER section states, per net, how many pads it has, how many separate copper
islands those pads sit on, how much track it carries, its narrowest track, how
many vias, and which layers carry a pour. The DECOUPLING section gives the
distance in millimetres from every supply pin to the nearest capacitor on its
own net.

Report anything wrong with the design.

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

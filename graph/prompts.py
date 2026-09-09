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


CIRCUIT_JOB = """You are reviewing the circuit: what the parts are, what their
pins are for, and whether the wiring achieves what the design is trying to do.

Read the design for intent first, then ask whether it is built that way. What is
worth reporting is usually an interaction between parts rather than a property
of one, so consider the power architecture as a whole, what each pin is for
against the net it sits on, what holds a node at a defined level before any
firmware runs, what a part needs alongside it to work at all, what a connector's
pin order implies about whatever plugs into it, and whether a part's value or
type suits the job it has been given.

Your evidence is the COMPONENTS and NETS sections and the RESEARCHED FACTS. A
researched fact is established; anything you know about a part that is not
listed there comes from your own training, and a finding resting on it must say
so in `assumption`.

You have no geometry: no copper, no placement, no distances, no layer
assignments. Another reviewer holds those and reports on them. Do not infer them
and do not comment on them."""

PHYSICAL_JOB = """You are reviewing the physical board: where things sit and
how the copper joins them.

Every number you have been given is a measurement, not a verdict. A distance is
only a defect once you can say why it matters for that pin on that net, and a
narrow track is only a defect if something about this design makes it one. Your
job is what the measurements mean together: the size of the loop a return
current is forced to take, whether the reference under a signal is continuous,
whether a capacitor that is on the correct net is near enough and on the right
layer to serve the pin it was put there for, what a pour's shape does to current
that has to cross it, which parts should be close and which should not, and what
a manufacturer or a test fixture would struggle with.

Your evidence is the COPPER and DECOUPLING sections. You do not have pin
functions, part values or part descriptions: another reviewer holds those and
reports on netlist correctness and component selection. Do not infer them and do
not comment on them."""

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


def circuit_prompt(pack: str) -> str:
    return _node(CIRCUIT_JOB, pack)


def physical_prompt(pack: str) -> str:
    return _node(PHYSICAL_JOB, pack)


#: The reviewers, and the pack each one is handed. Two, not three, and not
#: seven: a specialist earns its call by holding evidence no other specialist
#: holds, and there are two disjoint bodies of evidence here.
REVIEWERS = {
    "circuit": (circuit_prompt, "circuit"),
    "physical": (physical_prompt, "physical"),
}


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
            CIRCUIT_JOB,
            PHYSICAL_JOB,
            ADJUDICATE_JOB,
            SINGLE_PROMPT_JOB,
        ]
    )
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:12]

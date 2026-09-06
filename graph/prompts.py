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
  "refs": ["S1"],
  "nets": ["/FB", "VBST"],
  "title": "one line naming the defect",
  "why": "one sentence on the consequence"
}]}"""

SYSTEM = """You review printed circuit boards before they are manufactured. You
report only what the data supports. An empty findings list is the correct answer
for a board with no defects in your area, and inventing a defect is worse than
missing one. You always reply with JSON only, no prose around it."""

BOARD_CONTEXT = """The board is a two-layer STM32F103 controller for a pill
dispenser: a TPS563208 buck converter from a barrel jack, an AMS1117-3.3 LDO,
a ULN2003 driving a 5 V unipolar stepper, three servo headers, an HC-SR04
ultrasonic header, a USB micro-B connector, and a 16 MHz crystal."""

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


def _build(job: str, distilled: str) -> str:
    return f"{BOARD_CONTEXT}\n\n{job.strip()}\n" + _TAIL.format(
        schema=SCHEMA, distilled=distilled
    )


DATASHEET_JOB = """Your area is what each pin is for, against what it is wired to.

The net list gives every pin the chip's own name for it, taken from the symbol
library, and the pin's electrical type. Use them. Look for:

- a pin whose name says one node and whose net is another, especially on the
  buck converter, the regulator and the MCU's supply pins;
- a supply or bias pin sitting on a net with no source of that supply;
- a feedback or bootstrap pin on the wrong node;
- a crystal, reset or boot pin wired in a way the part cannot work with;
- a part whose value cannot be ordered, or cannot carry what is asked of it.

Report only defects in your area. Do not comment on layout, copper, trace
widths or placement — another reviewer has those."""

CONNECTIONS_JOB = """Your area is the wiring between parts and off the board.

Look for:

- a connector whose pin order does not match the module that plugs into it. A
  three-wire servo lead is signal, power, ground in that physical order. An
  HC-SR04 is VCC, TRIG, ECHO, GND in that order. Neither connector is keyed.
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
- a ground net with no vias tying the two layers together, or with a pour on
  only one layer while pads sit on both;
- a trace too narrow for the current its rail carries. Roughly 0.5 mm per amp
  on 1 oz outer copper for a 20 C rise. The buck is rated 3 A; three servos
  stall near 700 mA each; the ULN2003 sinks the stepper coils.
- a decoupling capacitor far from the pin it serves, where the PLACEMENT
  section says so.

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
3. Placement and copper. A net whose pads sit on more than one island is not
   connected, whatever the net list says. Trace width against the current a
   rail carries, at roughly 0.5 mm per amp on 1 oz outer copper for a 20 C
   rise. Ground return and pour coverage.

Do not report style, silkscreen or aesthetics, or anything you would have to
guess at."""


def datasheet_prompt(distilled: str) -> str:
    return _build(DATASHEET_JOB, distilled)


def connections_prompt(distilled: str) -> str:
    return _build(CONNECTIONS_JOB, distilled)


def layout_prompt(distilled: str) -> str:
    return _build(LAYOUT_JOB, distilled)


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
            _TAIL,
            DATASHEET_JOB,
            CONNECTIONS_JOB,
            LAYOUT_JOB,
            ADJUDICATE_JOB,
            SINGLE_PROMPT_JOB,
        ]
    )
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:12]

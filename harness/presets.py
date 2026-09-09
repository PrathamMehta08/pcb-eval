"""The seeded defects: ten faults across two boards, held out from everything.

WHAT CHANGED, AND WHY IT MATTERS MORE THAN THE DEFECTS THEMSELVES

The first corpus was seven defects on one board, and every one of them had a
deterministic rule in `harness/checks.py` written to catch it - the acceptance
suite even asserted that pairing, one preset to one rule. The reviewers' prompts
then went further and named the conventions those defects broke: a servo lead's
pin order, a four-wire module's pin order, the buck's supply pins. Removing the
prompt half of that cost both detectors a fifth of their recall, which is the
measure of how much the scores had been leaning on it.

This corpus is the other half. **No rule in `harness/checks.py` was written
against any defect here, and no prompt names any of them.** Whatever the rules
catch, they catch by generalising from a different board's faults; whatever the
models catch, they catch from the netlist, the copper and the part descriptions.
That makes it a held-out test set rather than a set of answers the system was
built around, and it is the only way the numbers mean what they look like.

Some of these will be caught by existing rules. That is a result, not a problem:
a rule written for a stranded ground plane catching a reversed diode's broken
copper is exactly the generalisation worth measuring.

TWO BOARDS

`stm32-good` is a 53-part controller. `dcdcc` is a 9-part TPS561208 buck - small
enough that nothing hides, and a different designer's conventions: every pin is
typed `passive` because its symbols carry no electrical types, which is a fair
test of rules that key on those types.

Net facts these depend on, read out of the extracted boards:

    stm32-good  +3.3V     C2.1 ... U2.1/24/36/48 (power_in), U1.2 (power_out)
                GND       U2.8, U2.23 (power_in) ... C2.2
                /SERVO_1  J3.1, U2.16 (PA16, bidirectional)
                /SERVO_2  J8.1, U2.17 (PA7, bidirectional)
                /VIN_LDO  C1.1, D1.1, D2.1, U1.3 (VI)
                VBUS      D1.2, J6.1
    dcdcc       /FB       R1.1, R2.2, U1.4 (VFB_4)
                /OUT      C3.1, J2.1, L1.2, R2.1
                /SW       C2.1, L1.1, U1.2 (SW_2)
                /IN       C1.1, J1.1, U1.3 (VIN_3), U1.5 (EN_5)
                VBST      C2.2, U1.6 (VBST_6)
"""

from __future__ import annotations

from harness.ops import apply_edits


class AlreadyApplied(ValueError):
    """This preset is already on the board it was handed."""


def _edit(op: str, **args) -> dict:
    return {"op": op, "args": args}


def _reverse_footprint(ref: str):
    """Turn a two-pin part end for end, in place.

    A polarised part fitted backwards is one of the commonest assembly faults
    there is, and it does not touch the netlist at all - the pads keep their
    nets and swap places, so the only trace of it is in the copper.
    """

    def build(board: dict) -> list[dict]:
        fp = next(f for f in board["layout"]["footprints"] if f["ref"] == ref)
        return [_edit("rotate_footprint", ref=ref, deg=(fp["rot"] + 180) % 360)]

    return build


#: Every defect names the board it belongs to, the refs and nets a finding must
#: intersect to count as having found it, and what actually goes wrong. None of
#: them names a rule, because none of them has one.
PRESETS: list[dict] = [
    # ---------------------------------------------------------------- dcdcc
    {
        "id": "fb-divider-swapped",
        "board": "dcdcc",
        "title": "Feedback divider resistors exchanged",
        "breaks": (
            "R1 and R2 set the output voltage by their ratio. Exchanged, the "
            "converter regulates to a different voltage than the design asks "
            "for, and everything downstream sees it."
        ),
        "refs": ["R1", "R2"],
        "nets": ["/FB", "/OUT"],
        "edits": [
            _edit("set_value", ref="R1", value="56.2K"),
            _edit("set_value", ref="R2", value="10K"),
        ],
    },
    {
        "id": "bootstrap-cap-oversized",
        "board": "dcdcc",
        "title": "Bootstrap capacitor a hundred times too large",
        "breaks": (
            "The high-side gate drive is supplied by a small capacitor charged "
            "each switching cycle. Oversized, it cannot charge in time and the "
            "high-side switch never fully turns on."
        ),
        "refs": ["C2", "U1"],
        "nets": ["VBST", "/SW"],
        "edits": [_edit("set_value", ref="C2", value="10uF")],
    },
    {
        "id": "output-cap-undersized",
        "board": "dcdcc",
        "title": "Output bulk capacitor replaced with a decoupling part",
        "breaks": (
            "47uF of output bulk becomes 100nF. There is nothing left to hold "
            "the rail up between switching cycles or through a load step."
        ),
        "refs": ["C3"],
        "nets": ["/OUT"],
        "edits": [_edit("set_value", ref="C3", value="0.1uF")],
    },
    {
        "id": "feedback-from-input",
        "board": "dcdcc",
        "title": "Feedback divider sensing the input instead of the output",
        "breaks": (
            "The top of the divider is moved from the output to the input, so "
            "the converter measures a voltage it does not control. The output "
            "runs to whatever the duty cycle limit allows."
        ),
        "refs": ["R2", "U1"],
        "nets": ["/OUT", "/IN", "/FB"],
        "edits": [_edit("move_pin", ref="R2", pin="1", to_net="/IN")],
    },
    {
        "id": "inductor-bypassed",
        "board": "dcdcc",
        "title": "Inductor shorted across by its own pins",
        "breaks": (
            "Both ends of L1 land on the output, so the switching node reaches "
            "the load through nothing. There is no energy storage and no "
            "filtering; the output becomes a square wave."
        ),
        "refs": ["L1", "U1"],
        "nets": ["/SW", "/OUT"],
        "edits": [_edit("move_pin", ref="L1", pin="1", to_net="/OUT")],
    },
    # ----------------------------------------------------------- stm32-good
    {
        "id": "mcu-ground-lifted",
        "board": "stm32-good",
        "title": "One MCU ground pin lifted off ground",
        "breaks": (
            "A supply return pin is moved to a net of its own. The part has "
            "other ground pins so it may appear to work, while the current it "
            "was meant to return finds another path."
        ),
        "refs": ["U2"],
        "nets": ["GND"],
        "edits": [_edit("move_pin", ref="U2", pin="23", to_net="/GND_LIFTED")],
    },
    {
        "id": "bulk-cap-on-signal",
        "board": "stm32-good",
        "title": "Rail bulk capacitor moved onto a signal",
        "breaks": (
            "22uF lands across a servo signal and ground instead of across the "
            "3.3 V rail. The rail loses its bulk, and the signal is loaded by a "
            "capacitor no driver can slew."
        ),
        "refs": ["C2"],
        "nets": ["+3.3V", "/SERVO_1"],
        "edits": [_edit("move_pin", ref="C2", pin="1", to_net="/SERVO_1")],
    },
    {
        "id": "outputs-shorted",
        "board": "stm32-good",
        "title": "Two MCU pins driving one net",
        "breaks": (
            "Two port pins are tied together. Whenever firmware drives them to "
            "opposite levels the pair is a short across the supply, through the "
            "output transistors of both."
        ),
        "refs": ["U2"],
        "nets": ["/SERVO_1", "/SERVO_2"],
        "edits": [_edit("move_pin", ref="U2", pin="17", to_net="/SERVO_1")],
    },
    {
        "id": "ldo-in-out-swapped",
        "board": "stm32-good",
        "title": "Regulator input and output exchanged",
        "breaks": (
            "The regulator is fed from its own output and drives the raw input "
            "rail. Nothing regulates, and the parts on 3.3 V see whatever the "
            "input supply happens to be."
        ),
        "refs": ["U1"],
        "nets": ["+3.3V", "/VIN_LDO"],
        "edits": [_edit("swap_pins", ref="U1", pin_a="2", pin_b="3")],
    },
    {
        "id": "diode-reversed",
        "board": "stm32-good",
        "title": "Input protection diode fitted backwards",
        "breaks": (
            "The Schottky between the USB input and the regulator is turned end "
            "for end. Its pads keep their nets and change places, so the "
            "netlist still reads correctly and only the copper disagrees."
        ),
        "refs": ["D1"],
        "nets": ["VBUS", "/VIN_LDO"],
        "build": _reverse_footprint("D1"),
    },
]

BY_ID = {preset["id"]: preset for preset in PRESETS}


def edits_for(preset: dict, board: dict) -> list[dict]:
    """The edit list, resolving the ones that depend on the board's own ids."""
    if "build" in preset:
        return preset["build"](board)
    return preset["edits"]


def apply_preset(board: dict, preset_id: str) -> list[dict]:
    """Apply a preset to a board that has not been edited yet.

    Applying one twice is not idempotent and is not a no-op either: the
    `swap_pins` preset is its own inverse, so a second application quietly
    restores the clean board while leaving edits in the log. The page resets
    before applying; this raises rather than let a script do it by accident.
    """
    preset = BY_ID.get(preset_id)
    if preset is None:
        raise KeyError(f"no preset {preset_id!r}")
    edits = edits_for(preset, board)
    apply_edits(board, edits)
    return edits

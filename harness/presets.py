"""The seven seed defects.

Presets are not the product — the product is the editor. These exist so a
visitor has somewhere to start and so the eval has a fixed corpus to score
against. Each was checked against the exported netlist, and each names the
deterministic rule in `harness/checks.py` that must trip when it is applied.

Verified net facts these depend on, read out of boards/stm32-good.json:

    /FB           R2.2, R3.1, S1.4 (VFB_4)
    VBST          C4.2, S1.6 (VBST_6)
    +5V           ... J2.1, J4.2, J11.5, U3.9 (COM_9) ...
    /TRIG         J2.2, U2.38 (PA15_38)
    /ECHO         J2.3, U2.39 (PB3_39)
    /SERVO_3      J4.1, U2.18 (PB0_18)
    GND           ... J2.4, J4.3, R8.1, R11.1 ...
    /STEPPER_IN1  R8.2, U2.11 (PA1_11), U3.1 (I1_1)
    /STEPPER_IN4  R11.2, U2.14 (PA4_14), U3.4 (I4_4)
    U3.12 (O5_12) unconnected-(U3-O5-Pad12)
"""

from __future__ import annotations

from harness.ops import apply_edits

class AlreadyApplied(ValueError):
    """This preset is already on the board it was handed."""


def _edit(op: str, **args) -> dict:
    return {"op": op, "args": args}


def _strand_ground(board: dict) -> list[dict]:
    """Every GND via gone and the top pour gone — rev 1's actual defect.

    Built dynamically because it depends on which vias the board has, and
    because "delete 41 vias" as a literal list would be unreadable.
    """
    edits = [
        _edit("delete_via", via_id=via["id"])
        for via in board["layout"]["vias"]
        if via["net"] == "GND"
    ]
    edits += [
        _edit("toggle_zone", zone_id=zone["id"])
        for zone in board["layout"]["zones"]
        if zone["net"] == "GND" and zone["layer"] == "F.Cu"
    ]
    return edits


PRESETS: list[dict] = [
    {
        "id": "vfb-vbst-swap",
        "title": "Feedback and bootstrap swapped on the buck",
        "view": "schematic",
        "rule": "power-pin-miswired",
        "breaks": (
            "The buck regulates from the bootstrap node instead of the feedback "
            "divider. The output runs away to whatever the input can supply."
        ),
        "refs": ["S1"],
        "nets": ["/FB", "VBST"],
        "edits": [
            _edit("move_pin", ref="S1", pin="4", to_net="VBST"),
            _edit("move_pin", ref="S1", pin="6", to_net="/FB"),
        ],
    },
    {
        "id": "stepper-common-open",
        "title": "Stepper centre tap on an open-collector output",
        "view": "schematic",
        "rule": "connector-no-reference",
        "breaks": (
            "The stepper's centre tap hangs off an unused ULN2003 output instead "
            "of the 5 V rail. No coil ever sees supply, so the motor never turns."
        ),
        "refs": ["J11", "U3"],
        "nets": ["+5V", "/O5"],
        "edits": [
            _edit("move_pin", ref="U3", pin="12", to_net="/O5"),
            _edit("move_pin", ref="J11", pin="5", to_net="/O5"),
        ],
    },
    {
        "id": "servo-power-end-pin",
        "title": "Servo header power on the end pin",
        "view": "schematic",
        "rule": "connector-power-order",
        "breaks": (
            "+5V lands on the end pin of the servo header. A standard three-wire "
            "servo lead plugged in the normal way puts 5 V on the servo's ground."
        ),
        "refs": ["J4"],
        "nets": ["+5V", "GND"],
        "edits": [_edit("swap_pins", ref="J4", pin_a="2", pin_b="3")],
    },
    {
        "id": "ultrasonic-crossed",
        "title": "Ultrasonic trigger and echo crossed",
        "view": "schematic",
        "rule": "sensor-pinout-order",
        "breaks": (
            "The MCU drives the sensor's echo output and listens on its trigger "
            "input. Two outputs fight; the range reading never arrives."
        ),
        "refs": ["J2", "U2"],
        "nets": ["/TRIG", "/ECHO"],
        "edits": [_edit("swap_pins", ref="J2", pin_a="2", pin_b="3")],
    },
    {
        "id": "stepper-in4-floating",
        "title": "Stepper input 4 pull-down moved off its net",
        "view": "schematic",
        "rule": "floating-driver-input",
        "breaks": (
            "ULN2003 input 4 floats at power-up with nothing holding it low. "
            "That coil can energise before firmware ever runs."
        ),
        "refs": ["R11", "U3"],
        "nets": ["/STEPPER_IN4", "/STEPPER_IN1"],
        "edits": [_edit("move_pin", ref="R11", pin="2", to_net="/STEPPER_IN1")],
    },
    {
        "id": "unbuildable-value",
        "title": "Resistor with no value",
        "view": "schematic",
        "rule": "unbuildable-value",
        "breaks": (
            "Not a connectivity fault, and ERC will not say a word. The BOM "
            "simply cannot be ordered."
        ),
        "refs": ["R4"],
        "nets": [],
        "edits": [_edit("set_value", ref="R4", value="R")],
    },
    {
        "id": "ground-stranded",
        "title": "Ground stranded: no vias, no top pour",
        "view": "routing",
        "rule": "net-island",
        "breaks": (
            "Every ground pad on the top layer is stranded from the bottom pour. "
            "This is the defect the real board shipped with, and both ERC and "
            "DRC passed it."
        ),
        "refs": [],
        "nets": ["GND"],
        "build": _strand_ground,
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

    Applying one twice is not idempotent and is not a no-op either. The two
    `swap_pins` presets are their own inverse, so a second application quietly
    restores the clean board while leaving edits in the log; `ground-stranded`
    recomputes its list against the already-broken board, finds no ground vias
    left to delete, and toggles the top pour back **on** — leaving a board that
    is neither clean nor the defect it is named after. The page resets before
    applying; this raises rather than let a script do it by accident.
    """
    from harness.checks import run_checks  # local: checks.py is the heavier half

    preset = BY_ID.get(preset_id)
    if preset is None:
        raise KeyError(f"no preset {preset_id!r}")
    if preset["rule"] in {f["rule"] for f in run_checks(board)}:
        raise AlreadyApplied(
            f"{preset_id} is already on this board — {preset['rule']} is tripping. "
            "Start from a clean board."
        )
    return apply_edits(board, edits_for(preset, board))


if __name__ == "__main__":
    import json
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from console import utf8
    from harness.ops import board_hash

    utf8()

    root = Path(__file__).resolve().parent.parent
    good = json.loads((root / "boards" / "stm32-good.json").read_text(encoding="utf-8"))
    print(f"clean {board_hash(good)}")
    for preset in PRESETS:
        work = json.loads(json.dumps(good))
        log = apply_preset(work, preset["id"])
        print(f"{preset['id']:<22} {board_hash(work)}  {len(log):>2} edits")
        for entry in log[:3]:
            print(f"    {entry['label']}")
        if len(log) > 3:
            print(f"    ... and {len(log) - 3} more")

"""Inputs a KiCad project does not contain, supplied by hand or not at all.

A schematic states what is connected to what and a layout states where the
copper is. Neither states how much current a rail carries, how hot the room is,
or what the dielectric between the layers does - and those are the inputs three
whole domains rest on. Thermal needs a dissipation and an ambient; power
integrity needs a current; signal integrity needs a stackup.

The architecture's rule is that a missing input means the domain is skipped, not
guessed. This is where the inputs come from when they do exist: a short file
beside the board, written by whoever knows the answers.

    boards/stm32-good.assumptions.yml

    ambient_c: 25
    max_junction_c: 125
    rails:
      "+3.3V": 3.3
      "/IN": 12.0
    dissipation_w:
      S1: 1.7
    copper_weight_oz: 1
    stackup:
      layers: 2
      dielectric_mm: 1.5
    high_speed_nets: ["/USB_D+", "/USB_D-"]

Everything in it is optional and nothing is defaulted. An absent `ambient_c`
means the thermal check is skipped and coverage says why; it does not mean 25 C.
Defaulting is the same failure as estimating, one layer further down, and harder
to see because it looks like configuration rather than invention.

No YAML dependency: the format is a small subset - scalars, one level of
mapping, and inline lists - parsed here rather than adding a package for forty
lines of input.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

#: What each gated domain needs before it may run. Stated once, so the gate and
#: the coverage message cannot disagree about it.
REQUIREMENTS = {
    "thermal": ("ambient_c", "dissipation_w"),
    "signal_integrity": ("stackup", "high_speed_nets"),
    "power_integrity": ("stackup", "dissipation_w"),
}


def _scalar(text: str):
    text = text.strip().strip('"').strip("'")
    if text.startswith("[") and text.endswith("]"):
        return [
            part.strip().strip('"').strip("'")
            for part in text[1:-1].split(",")
            if part.strip()
        ]
    if re.fullmatch(r"-?\d+", text):
        return int(text)
    if re.fullmatch(r"-?\d*\.\d+", text):
        return float(text)
    return text


def parse(text: str) -> dict:
    """A small YAML subset: `key: value`, and one level of indented mapping."""
    out: dict = {}
    current: dict | None = None
    for raw in text.split("\n"):
        line = raw.split("#", 1)[0].rstrip()
        if not line.strip():
            continue
        indented = line[:1].isspace()
        if ":" not in line:
            continue
        key, _, value = line.strip().partition(":")
        key = key.strip().strip('"').strip("'")
        value = value.strip()
        if indented and current is not None:
            current[key] = _scalar(value)
        elif value:
            out[key] = _scalar(value)
            current = None
        else:
            current = {}
            out[key] = current
    return out


def load(board_name: str) -> dict | None:
    """The assumptions beside a board, or None when nobody wrote any.

    None and an empty file mean the same thing to everything downstream: the
    gated domains do not run and coverage says which input was missing.
    """
    for suffix in (".assumptions.yml", ".assumptions.yaml", ".assumptions.json"):
        path = ROOT / "boards" / f"{board_name}{suffix}"
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        return json.loads(text) if suffix.endswith(".json") else parse(text)
    return None


def enabled(inputs: dict | None, research: dict | None = None) -> dict[str, str]:
    """Which gated domains may run, and why each of the rest may not.

    Returns every domain, mapped to "" when it is enabled and to the reason when
    it is not, so the caller can gate and report coverage from one answer.

    Thermal takes a third requirement from a different place. Ambient and a
    dissipation come from the assumptions file, but the junction-to-ambient
    resistance comes from a datasheet, and a thermal reviewer holding two of the
    three has nothing to compute a margin from - it would be reasoning about
    heat in general rather than about this board. A trustworthy figure means one
    the extractor did not mark `low`: those come from multi-column package
    tables where a column was chosen rather than a value read.
    """
    inputs = inputs or {}
    out = {}
    for domain, needs in REQUIREMENTS.items():
        missing = [name for name in needs if not inputs.get(name)]
        out[domain] = "" if not missing else "no " + " and no ".join(
            name.replace("_", " ") for name in missing
        )

    if not out["thermal"]:
        usable = [
            ref
            for ref, record in (research or {}).items()
            if ((record.get("facts") or {}).get("thermal") or {}).get("confidence") != "low"
            and (record.get("facts") or {}).get("thermal")
        ]
        if not usable:
            out["thermal"] = (
                "no trustworthy junction-to-ambient resistance in the researched facts"
            )
    return out

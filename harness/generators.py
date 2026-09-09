"""Defect generators: faults that find their own site on any board.

WHY THIS REPLACED A LIST OF PRESETS

The corpus used to be hand-written edits naming this repository's own boards -
`move_pin(ref="R2", pin="1")`. Point that at a third board and it produces
nothing, so every claim about the system generalising rested on the two designs
the defects had been written against.

A generator is the same defect stated as a search. It asks the board for a site
matching a pattern - a supply pin sharing a net with a port, a divider feeding a
regulator's feedback pin, a polarised two-pin part - and injects there. Add a
KiCad project and it inherits every defect whose pattern it contains. A board
with no such site yields nothing from that generator, which is information about
the board rather than a gap in the corpus.

DETERMINISM

Sites are chosen by sorting the candidates and taking the first, never at
random, so the corpus is reproducible and `corpus_hash` means something. Two
runs on the same board produce byte-identical boards.

WHAT A GENERATOR MUST NOT DO

It must not consult `harness/checks.py`. A defect chosen because a rule catches
it is an answer key, which is exactly what the previous corpus turned out to be:
the rules scored seven of seven on the defects they were written beside, and one
of ten on defects chosen without reference to them. Generators describe faults
an engineer would recognise; whether any rule catches them is the measurement,
not the design goal.
"""

from __future__ import annotations

import re
from typing import Callable, Iterator

GENERATORS: list[dict] = []


def generator(gid: str, title: str, breaks: str):
    """Register a generator. It yields zero or more sites on a given board."""

    def wrap(fn: Callable[[dict], Iterator[dict]]):
        GENERATORS.append({"id": gid, "title": title, "breaks": breaks, "find": fn})
        return fn

    return wrap


# ------------------------------------------------------------------ helpers


def _edit(op: str, **args) -> dict:
    return {"op": op, "args": args}


def _pins_by_ref(board: dict) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for net in board["nets"]:
        for node in net["nodes"]:
            out.setdefault(node["ref"], []).append({**node, "net": net["name"]})
    return out


def _type(node: dict) -> str:
    return str(node.get("type") or "").split("+", 1)[0]


def _value_of(board: dict) -> dict[str, str]:
    return {c["ref"]: c.get("value", "") for c in board["components"]}


def _farads(value: str) -> float | None:
    """`0.1u`, `100n`, `22uF` in farads. None when it is not a capacitance."""
    text = str(value or "").strip().lower().replace("µ", "u").rstrip("f")
    match = re.fullmatch(r"([\d.]+)\s*([munp]?)", text)
    if not match:
        return None
    try:
        number = float(match.group(1))
    except ValueError:
        return None
    return number * {"": 1.0, "m": 1e-3, "u": 1e-6, "n": 1e-9, "p": 1e-12}[match.group(2)]


def _rails(board: dict):
    from harness.checks import is_ground, is_rail

    return {
        n["name"]
        for n in board["nets"]
        if is_rail(n["name"]) and not is_ground(n["name"])
    }


def _site(edits, refs, nets, note="") -> dict:
    return {"edits": edits, "refs": sorted(set(refs)), "nets": sorted(set(nets)), "note": note}


# --------------------------------------------------------------- generators


@generator(
    "supply-on-signal",
    "Supply pin moved onto a signal net",
    "A part's supply pin lands on a net driven by a port. Either the port is "
    "asked to source a rail, or the rail backfeeds the port through its "
    "protection diode.",
)
def find_supply_on_signal(board: dict) -> Iterator[dict]:
    pins = _pins_by_ref(board)
    signal_nets = sorted(
        net["name"]
        for net in board["nets"]
        if net["nodes"]
        and all(_type(n) in ("bidirectional", "input", "output", "passive") for n in net["nodes"])
        and any(_type(n) == "bidirectional" for n in net["nodes"])
    )
    if not signal_nets:
        return
    for ref in sorted(pins):
        for pin in sorted(pins[ref], key=lambda p: str(p["pin"])):
            if _type(pin) != "power_in":
                continue
            target = signal_nets[0]
            if pin["net"] == target:
                continue
            yield _site(
                [_edit("move_pin", ref=ref, pin=pin["pin"], to_net=target)],
                [ref], [pin["net"], target],
            )
            return


@generator(
    "ground-pin-lifted",
    "One ground pin lifted off ground",
    "A part with several ground pins keeps working well enough to look fine, "
    "while the current one pin was meant to return finds another path.",
)
def find_ground_lifted(board: dict) -> Iterator[dict]:
    from harness.checks import is_ground

    pins = _pins_by_ref(board)
    for ref in sorted(pins):
        grounds = sorted(
            (p for p in pins[ref] if is_ground(p["net"])), key=lambda p: str(p["pin"])
        )
        if len(grounds) < 2:
            continue
        pin = grounds[0]
        yield _site(
            [_edit("move_pin", ref=ref, pin=pin["pin"], to_net=f"/LIFTED_{ref}")],
            [ref], [pin["net"]],
        )
        return


@generator(
    "outputs-shorted",
    "Two port pins driving one net",
    "Whenever firmware drives the two pins to opposite levels the pair is a "
    "short across the supply, through the output transistors of both.",
)
def find_outputs_shorted(board: dict) -> Iterator[dict]:
    ports = []
    for net in board["nets"]:
        for node in net["nodes"]:
            if _type(node) == "bidirectional":
                ports.append((net["name"], node["ref"], str(node["pin"])))
    ports.sort()
    if len(ports) < 2:
        return
    (net_a, ref_a, _), (net_b, ref_b, pin_b) = ports[0], ports[1]
    if net_a == net_b:
        return
    yield _site(
        [_edit("move_pin", ref=ref_b, pin=pin_b, to_net=net_a)],
        [ref_a, ref_b], [net_a, net_b],
    )


@generator(
    "regulator-io-swapped",
    "Regulator input and output exchanged",
    "The regulator is fed from its own output and drives the raw input rail. "
    "Nothing regulates, and everything downstream sees the input supply.",
)
def find_regulator_swapped(board: dict) -> Iterator[dict]:
    pins = _pins_by_ref(board)
    for ref in sorted(pins):
        named = {
            re.sub(r"_\d+$", "", str(p.get("function") or "")).upper(): p
            for p in pins[ref]
            if p.get("function")
        }
        vin = named.get("VI") or named.get("VIN") or named.get("IN")
        vout = named.get("VO") or named.get("VOUT") or named.get("OUT")
        if not vin or not vout or vin["net"] == vout["net"]:
            continue
        yield _site(
            [_edit("swap_pins", ref=ref, pin_a=str(vin["pin"]), pin_b=str(vout["pin"]))],
            [ref], [vin["net"], vout["net"]],
        )
        return


@generator(
    "feedback-from-input",
    "Feedback divider sensing the wrong node",
    "The converter measures a voltage it does not control, so the output runs "
    "to whatever the duty-cycle limit allows.",
)
def find_feedback_from_input(board: dict) -> Iterator[dict]:
    pins = _pins_by_ref(board)
    for ref in sorted(pins):
        fb = next(
            (
                p
                for p in sorted(pins[ref], key=lambda p: str(p["pin"]))
                if re.match(r"^(VFB|FB)(_\d+)?$", str(p.get("function") or ""), re.I)
            ),
            None,
        )
        if not fb:
            continue
        # The divider: passives sharing the feedback net. The one whose other
        # pin is not on ground is the top of it.
        fb_net = next(n for n in board["nets"] if n["name"] == fb["net"])
        for node in sorted(fb_net["nodes"], key=lambda n: (n["ref"], str(n["pin"]))):
            if node["ref"] == ref or not node["ref"].startswith("R"):
                continue
            from harness.checks import is_ground

            others = [p for p in pins[node["ref"]] if str(p["pin"]) != str(node["pin"])]
            if not others or is_ground(others[0]["net"]):
                continue
            top, sensed = others[0], others[0]["net"]
            supplies = sorted(_rails(board) - {sensed})
            if not supplies:
                continue
            yield _site(
                [_edit("move_pin", ref=node["ref"], pin=str(top["pin"]), to_net=supplies[0])],
                [node["ref"], ref], [sensed, supplies[0], fb["net"]],
            )
            return


@generator(
    "divider-values-swapped",
    "Feedback divider resistors exchanged",
    "The two resistors set an output voltage by their ratio. Exchanged, the "
    "converter regulates to a different voltage than the design asks for.",
)
def find_divider_swapped(board: dict) -> Iterator[dict]:
    pins = _pins_by_ref(board)
    values = _value_of(board)
    for ref in sorted(pins):
        fb = next(
            (
                p
                for p in pins[ref]
                if re.match(r"^(VFB|FB)(_\d+)?$", str(p.get("function") or ""), re.I)
            ),
            None,
        )
        if not fb:
            continue
        divider = sorted(
            n["ref"]
            for net in board["nets"]
            if net["name"] == fb["net"]
            for n in net["nodes"]
            if n["ref"].startswith("R")
        )
        if len(divider) != 2 or values[divider[0]] == values[divider[1]]:
            continue
        a, b = divider
        yield _site(
            [
                _edit("set_value", ref=a, value=values[b]),
                _edit("set_value", ref=b, value=values[a]),
            ],
            [a, b], [fb["net"]],
        )
        return


@generator(
    "bulk-cap-undersized",
    "Bulk capacitor replaced with a decoupling part",
    "The largest capacitor on a rail becomes 100nF. Nothing is left to hold "
    "the rail up between switching cycles or through a load step.",
)
def find_bulk_undersized(board: dict) -> Iterator[dict]:
    values = _value_of(board)
    best = None
    for net in sorted(board["nets"], key=lambda n: n["name"]):
        if net["name"] not in _rails(board):
            continue
        for node in sorted(net["nodes"], key=lambda n: n["ref"]):
            farads = _farads(values.get(node["ref"], "")) if node["ref"].startswith("C") else None
            if farads and farads >= 1e-6 and (best is None or farads > best[0]):
                best = (farads, node["ref"], net["name"])
    if not best:
        return
    _, ref, net = best
    yield _site([_edit("set_value", ref=ref, value="0.1uF")], [ref], [net])


@generator(
    "companion-cap-oversized",
    "A required companion capacitor a hundred times too large",
    "A capacitor sized by the part it serves is replaced with one that cannot "
    "charge in the time available to it.",
)
def find_companion_oversized(board: dict) -> Iterator[dict]:
    values = _value_of(board)
    for net in sorted(board["nets"], key=lambda n: n["name"]):
        caps = sorted(
            n["ref"] for n in net["nodes"] if n["ref"].startswith("C")
        )
        for ref in caps:
            farads = _farads(values.get(ref, ""))
            # A small capacitor on a net with exactly one active pin is doing a
            # job for that pin: bootstrap, charge pump, soft start.
            actives = [n for n in net["nodes"] if not n["ref"].startswith(("C", "R", "L"))]
            if farads and farads <= 2.2e-7 and len(net["nodes"]) == 2 and len(actives) == 1:
                yield _site(
                    [_edit("set_value", ref=ref, value="10uF")],
                    [ref, actives[0]["ref"]], [net["name"]],
                )
                return


@generator(
    "part-reversed",
    "Polarised two-pin part fitted backwards",
    "The part is turned end for end. Its pads keep their nets and change "
    "places, so the netlist still reads correctly and only the copper "
    "disagrees.",
)
def find_part_reversed(board: dict) -> Iterator[dict]:
    pins = _pins_by_ref(board)
    footprints = {f["ref"]: f for f in board["layout"]["footprints"]}
    for ref in sorted(pins):
        if not ref.startswith("D") or len(pins[ref]) != 2:
            continue
        fp = footprints.get(ref)
        if fp is None:
            continue
        yield _site(
            [_edit("rotate_footprint", ref=ref, deg=(fp["rot"] + 180) % 360)],
            [ref], sorted(p["net"] for p in pins[ref]),
        )
        return


@generator(
    "value-unorderable",
    "A part whose value cannot be ordered",
    "The value carries no number, so nobody can buy the part and the board "
    "cannot be assembled from its own bill of materials.",
)
def find_value_unorderable(board: dict) -> Iterator[dict]:
    values = _value_of(board)
    for ref in sorted(values):
        if ref.startswith("R") and any(ch.isdigit() for ch in values[ref]):
            yield _site([_edit("set_value", ref=ref, value="R")], [ref], [])
            return


# ------------------------------------------------------------------- corpus


def defects_for(board: dict, board_name: str) -> list[dict]:
    """Every defect this board has a site for, in generator order."""
    out = []
    for gen in GENERATORS:
        for site in gen["find"](board):
            out.append(
                {
                    "id": f"{board_name}:{gen['id']}",
                    "generator": gen["id"],
                    "board": board_name,
                    "title": gen["title"],
                    "breaks": gen["breaks"],
                    "refs": site["refs"],
                    "nets": site["nets"],
                    "edits": site["edits"],
                }
            )
            break  # one site per generator per board, deterministically the first
    return out

"""Deterministic detectors. LLM nodes propose; these dispose.

Rules an engineer would actually apply, written against conventions rather than
against any particular fault. They were built alongside an earlier corpus that
has since been replaced, and none of them was rewritten to suit the current one:
whatever they catch now, they catch by generalising. That is the point of them.

**The contract is that the clean boards trip nothing.** A detector that fires on
an untouched board is worthless however many defects it also finds, and every
rule here has to stay silent on two real boards from different designers. What
fraction of the seeded defects they happen to catch is a measurement reported by
the sweep, not a requirement any rule was built to satisfy.

The split between the two halves is deliberate. Schematic operations change the
netlist only, so the copper rules below see the board exactly as it was routed
and stay silent on a pin reassignment. Were it otherwise, `net-island` would
report an island every time a pin moved, catch all seven presets for free, and
measure the editor instead of the review.

`net-island` is the exception and the centrepiece: it walks real copper
geometry, and it is what catches the defect the physical board shipped with.
"""

from __future__ import annotations

import math
import re
from typing import Iterable

RULES: list[tuple[str, callable]] = []

#: Net names that are a supply or a return by convention, not by topology.
#: Grounds go by many names on a real board — DGND, AGND and PGND are all
#: ground, and a split ground is standard practice around a switching converter.
GROUND_PATTERN = re.compile(r"^/?((A|D|P|E|SG|PG|GND)?GND[A-Z0-9_]*|GND|VSS[A-Z0-9_]*)$", re.I)
RAIL_PATTERN = re.compile(
    r"^/?(VBUS|VCC|VDD|VEE|VIN|VOUT|[+-]?\d+V\d*|[+-]\d+(\.\d+)?V)[A-Z0-9]*$", re.I
)
DRIVERS = {"output", "power_out", "open_collector", "tri_state"}
#: The convention below belongs to servo leads, and this is how the board says so.
SERVO_NET = re.compile(r"SERVO|\bPWM\b|ESC", re.I)
#: Parts that switch real current, where an undefined input at power-up moves
#: something. An MCU reset or boot pin is not one of these and has its own
#: conventions — an internal pull-up, a mode switch — so it is out of scope.
DRIVER_PART = re.compile(
    r"darlington|transistor array|\bdriver\b|h-?bridge|mosfet|\bgate\b|relay", re.I
)
PASSIVE_PREFIXES = ("R", "C", "L")


def rule(rule_id: str, severity: str = "major"):
    def wrap(fn):
        RULES.append((rule_id, fn))
        fn.rule_id = rule_id
        fn.severity = severity
        return fn

    return wrap


def finding(rule_id: str, title: str, why: str, refs: Iterable[str] = (), nets: Iterable[str] = (), severity: str = "major", fix: str = "") -> dict:
    return {
        "rule": rule_id,
        "severity": severity,
        "refs": sorted(set(refs)),
        "nets": sorted(set(nets)),
        "title": title,
        "why": why,
        "fix": fix,
    }


def is_rail(name: str) -> bool:
    return bool(RAIL_PATTERN.match(name)) or is_ground(name)


def is_ground(name: str) -> bool:
    return bool(GROUND_PATTERN.match(name))


def base_type(pintype: str) -> str:
    """`bidirectional+no_connect` is still a bidirectional pin."""
    return pintype.split("+", 1)[0]


def _nets_by_ref(board: dict) -> dict[str, list[tuple[str, dict]]]:
    """ref -> [(net name, node)], every pin of every part."""
    out: dict[str, list[tuple[str, dict]]] = {}
    for net in board["nets"]:
        for node in net["nodes"]:
            out.setdefault(node["ref"], []).append((net["name"], node))
    return out


# ----------------------------------------------------------------- schematic


@rule("power-pin-miswired", "critical")
def check_power_pin_miswired(board: dict) -> list[dict]:
    """A pin whose datasheet name is also a net name must be on that net.

    `pinfunction` comes from the symbol library, so it is the chip's own name
    for the pin: `VBST_6`, `GND_1`, `VBUS_1`. Where the designer has given a net
    that same name, the binding is explicit and a mismatch is unambiguous. Pins
    whose name matches nothing on the board place no constraint at all, which is
    why this stays quiet on a board full of `PA1_11` and `Pin_5_5`.

    Two limits worth stating rather than discovering. It sees only pins the
    designer happened to name after a net, so a pin called `VFB_4` against a net
    called `/FB` is invisible to it: the names have to match for the binding to
    be explicit. And two grounds are never a mismatch, because splitting the
    return around a switcher is what you are supposed to do.
    """
    net_names = {n["name"].lstrip("/").upper(): n["name"] for n in board["nets"]}
    out = []
    for net in board["nets"]:
        for node in net["nodes"]:
            function = node.get("function") or ""
            if not function:
                continue
            # `VBST_6` names pin 6 of the VBST net; strip the pin-number suffix.
            declared = re.sub(r"_%s$" % re.escape(node["pin"]), "", function).upper()
            if len(declared) < 2 or declared not in net_names:
                continue
            expected = net_names[declared]
            if expected == net["name"]:
                continue
            # A separate return for the switching stage is standard practice,
            # so GND_1 landing on PGND rather than GND is a layout decision,
            # not a miswire.
            if is_ground(expected) and is_ground(net["name"]):
                continue
            out.append(
                finding(
                    "power-pin-miswired",
                    f"{node['ref']} pin {node['pin']} ({function}) is on {net['name']}, not {expected}",
                    f"The part names this pin {declared}, and the board has a net called "
                    f"{expected}. Wiring it to {net['name']} instead means the pin is "
                    "doing a different job than the symbol says it does.",
                    refs=[node["ref"]],
                    nets=[net["name"], expected],
                    severity="critical",
                    fix=f"Move {node['ref']} pin {node['pin']} back to {expected}.",
                )
            )
    return out


@rule("connector-no-reference", "critical")
def check_connector_no_reference(board: dict) -> list[dict]:
    """A connector with three or more pins must carry a ground or a supply.

    An off-board device needs a return path. A header that leaves with nothing
    but signals has no reference, so nothing on the far end can be driven.
    """
    out = []
    for ref, pins in _nets_by_ref(board).items():
        if not ref.startswith("J") or len(pins) < 3:
            continue
        names = [name for name, _ in pins]
        if any(is_rail(name) for name in names):
            continue
        if all(name.startswith("unconnected-") for name in names):
            continue
        out.append(
            finding(
                "connector-no-reference",
                f"{ref} has {len(pins)} pins and no ground or supply among them",
                "Every pin on this header is a signal. Whatever plugs in has no "
                "return path and no rail, so none of those signals mean anything "
                "at the far end.",
                refs=[ref],
                nets=names,
                severity="critical",
                fix=f"Give {ref} a ground pin, a supply pin, or both.",
            )
        )
    return out


@rule("connector-power-order", "critical")
def check_connector_power_order(board: dict) -> list[dict]:
    """On a three-pin servo-style header, the supply belongs on the middle pin.

    Hobby servo leads are signal / power / ground in that physical order, and
    the connector is not keyed. Power on an end pin means a lead inserted the
    normal way puts the supply on the servo's ground wire.

    It applies only where the designer has named the signal after a servo. Pin
    count alone would condemn a three-wire analogue sensor header, which is
    supply / output / ground and correct.
    """
    out = []
    for ref, pins in _nets_by_ref(board).items():
        if not ref.startswith("J") or len(pins) != 3:
            continue
        by_pin = {node["pin"]: name for name, node in pins}
        if set(by_pin) != {"1", "2", "3"}:
            continue
        supplies = [p for p, n in by_pin.items() if is_rail(n) and not is_ground(n)]
        grounds = [p for p, n in by_pin.items() if is_ground(n)]
        signals = [p for p, n in by_pin.items() if not is_rail(n)]
        if not (len(supplies) == 1 and len(grounds) == 1 and len(signals) == 1):
            continue
        # Only a servo lead has this convention. A three-pin analogue sensor
        # header is supply, output, ground and is perfectly correct that way,
        # so the rule reads the designer's own label rather than guessing from
        # the pin count.
        if not SERVO_NET.search(by_pin[signals[0]]):
            continue
        if supplies[0] == "2":
            continue
        out.append(
            finding(
                "connector-power-order",
                f"{ref}: {by_pin[supplies[0]]} is on end pin {supplies[0]}, not the middle pin",
                "A three-wire servo lead is signal, power, ground in that order "
                "and the header is not keyed. With the supply on an end pin, a "
                "lead plugged in the normal way puts it on the servo's ground.",
                refs=[ref],
                nets=list(by_pin.values()),
                severity="critical",
                fix=(
                    f"Swap {ref} pins {supplies[0]} and 2, so the supply is in the "
                    "middle and ground is on an end."
                ),
            )
        )
    return out


@rule("sensor-pinout-order", "critical")
def check_sensor_pinout_order(board: dict) -> list[dict]:
    """A four-pin sensor header is supply, signal, signal, ground, in that order.

    Every common four-wire module — HC-SR04, DHT-style sensors, most I2C
    breakouts — puts the supply on pin 1 and ground on pin 4 with the signals
    between, because that is what the cable that ships with them expects. The
    header is not keyed, so the board has to match.

    The ordering of the two middle signals is checked as well where the board
    names them: an HC-SR04 is VCC, TRIG, ECHO, GND, and crossing the middle two
    means the MCU drives the sensor's output and listens on its input. Reading
    the designer's own net names is what makes that clause checkable; the outer
    two pins need no names at all.
    """
    out = []
    for ref, pins in _nets_by_ref(board).items():
        if not ref.startswith("J") or len(pins) != 4:
            continue
        by_pin = {node["pin"]: name for name, node in pins}
        if set(by_pin) != {"1", "2", "3", "4"}:
            continue
        supplies = [p for p, n in by_pin.items() if is_rail(n) and not is_ground(n)]
        grounds = [p for p, n in by_pin.items() if is_ground(n)]
        signals = [p for p, n in by_pin.items() if not is_rail(n)]
        if not (len(supplies) == 1 and len(grounds) == 1 and len(signals) == 2):
            continue

        problems = []
        if supplies[0] != "1":
            problems.append(f"the supply {by_pin[supplies[0]]} is on pin {supplies[0]}, not pin 1")
        if grounds[0] != "4":
            problems.append(f"ground is on pin {grounds[0]}, not pin 4")
        trig = [p for p in signals if "TRIG" in by_pin[p].upper()]
        echo = [p for p in signals if "ECHO" in by_pin[p].upper()]
        if len(trig) == 1 and len(echo) == 1 and int(trig[0]) > int(echo[0]):
            problems.append(
                f"trigger is on pin {trig[0]} and echo on pin {echo[0]}, the wrong way round"
            )
        if not problems:
            continue

        out.append(
            finding(
                "sensor-pinout-order",
                f"{ref} does not match a four-wire sensor pinout: " + "; ".join(problems),
                "A four-wire module's cable is supply, signal, signal, ground, "
                "and the header is not keyed. Plugged in the normal way, this "
                "one connects the wrong wire to the wrong pin.",
                refs=[ref],
                nets=list(by_pin.values()),
                severity="critical",
                fix=f"Rewire {ref} as supply, signal, signal, ground on pins 1 to 4.",
            )
        )
    return out


def _reaches_rail(board: dict, node: dict, from_net: str) -> bool:
    """Does this passive pin's part have another pin sitting on a rail?

    A resistor to +3.3V or to ground defines a level. A decoupling capacitor's
    far side is on a rail too, but a capacitor is not a pull — so only parts
    that conduct at DC count, which on a board like this means R and L.
    """
    if not node["ref"].startswith(("R", "L", "FB")):
        return False
    for other in board["nets"]:
        if other["name"] == from_net:
            continue
        for candidate in other["nodes"]:
            if candidate["ref"] == node["ref"] and is_rail(other["name"]):
                return True
    return False


@rule("floating-driver-input", "major")
def check_floating_driver_input(board: dict) -> list[dict]:
    """A power driver's input needs something holding it while the MCU resets.

    A net whose only other member is a bidirectional MCU port has no defined
    level at power-up: the port is high impedance until firmware configures it.
    On something that switches real current that is a coil or a FET energising
    before any code has run.

    Two things keep this off correct boards. It applies only to parts the
    library describes as drivers, so an MCU reset pin held by its internal
    pull-up and a boot pin on a mode switch are out of scope — both are correct
    and both would otherwise be flagged. And what satisfies it is a driver on
    the net or a resistor whose other end is on a rail, not merely any passive:
    a capacitor leaves the input floating just the same.
    """
    drivers = {
        comp["ref"]
        for comp in board["components"]
        if DRIVER_PART.search(f"{comp.get('description', '')} {comp.get('value', '')}")
    }
    out = []
    for net in board["nets"]:
        if is_rail(net["name"]) or net["name"].startswith("unconnected-"):
            continue
        inputs = [
            n
            for n in net["nodes"]
            if base_type(n["type"]) == "input" and n["ref"] in drivers
        ]
        if not inputs:
            continue
        if any(base_type(n["type"]) in DRIVERS for n in net["nodes"]):
            continue
        if any(
            _reaches_rail(board, node, net["name"])
            for node in net["nodes"]
            if base_type(node["type"]) == "passive"
        ):
            continue
        out.append(
            finding(
                "floating-driver-input",
                f"{net['name']} drives {inputs[0]['ref']} with nothing holding it at reset",
                "The only other pin on this net is a port that sits high "
                "impedance until firmware configures it, and there is no pull "
                "resistor to a rail. The driver input floats from power-up "
                "until then, and what it drives can energise.",
                refs=[n["ref"] for n in net["nodes"]],
                nets=[net["name"]],
                fix=(
                    f"Add a pull resistor from {net['name']} to a rail, so the input "
                    "has a level before firmware runs."
                ),
            )
        )
    return out


@rule("power-pin-on-signal-net", "critical")
def check_power_pin_on_signal_net(board: dict) -> list[dict]:
    """A supply pin must not share a net with an MCU port.

    `power-pin-miswired` only fires when the designer named a net after the pin,
    so it is blind whenever they did not: this board's buck takes its input on a
    pin the library calls `VIN_3`, and the net is called `/IN`. Move that pin
    onto a servo signal and every rule stayed silent, the gate saw nothing to
    chase, and the review stopped after one pass. That gap is what this closes.

    The signal it uses is electrical type rather than naming, which the netlist
    always carries: a `power_in` pin sharing copper with a `bidirectional` MCU
    port is not a design choice anyone makes. The port drives a rail, or the
    rail backfeeds the port, and one of the two parts dies.

    Quiet on the board as manufactured: of its six nets carrying a supply pin -
    +3.3V, +3.3VA, /IN, /VIN_LDO, GND, VBST - not one also carries a GPIO. It is
    passives, regulator outputs and other supply pins all the way down.
    """
    out = []
    for net in board["nets"]:
        supplies = [n for n in net["nodes"] if base_type(n.get("type", "")) == "power_in"]
        ports = [n for n in net["nodes"] if base_type(n.get("type", "")) == "bidirectional"]
        if not supplies or not ports:
            continue
        supply = supplies[0]
        port = ports[0]
        out.append(
            finding(
                "power-pin-on-signal-net",
                f"{supply['ref']} pin {supply['pin']} is a supply pin sharing {net['name']} "
                f"with the MCU port {port['ref']}.{port['pin']}",
                f"{net['name']} carries both a power input and a general-purpose pin. "
                "Either the port is being asked to source a rail, or the rail is "
                "backfeeding the port through its protection diode. Neither part "
                "survives that for long.",
                refs=sorted({supply["ref"], port["ref"]}),
                nets=[net["name"]],
                severity="critical",
                fix=f"Return {supply['ref']} pin {supply['pin']} to its supply net and "
                f"leave {net['name']} to the signal.",
            )
        )
    return out


@rule("value-not-orderable", "major")
def check_unbuildable_value(board: dict) -> list[dict]:
    """A resistor, capacitor or inductor needs a magnitude, or it cannot be bought.

    ERC will not say a word about this: connectivity is perfect and the part is
    simply unorderable. Requiring one digit is enough — it accepts `10k`, `1k5`,
    `100n` and a manufacturer part number like `SPM3015T-3R3M`, and rejects the
    bare library name a symbol carries before anyone fills it in.
    """
    out = []
    for comp in board["components"]:
        if not comp["ref"].startswith(PASSIVE_PREFIXES):
            continue
        value = (comp["value"] or "").strip()
        if any(ch.isdigit() for ch in value):
            continue
        out.append(
            finding(
                "value-not-orderable",
                # An explicit quote rather than !r: repr uses single quotes and
                # JSON.stringify uses double, and the two copies of this rule
                # have to produce the same sentence.
                f'{comp["ref"]} has value "{value}", which is not a quantity',
                "There is no magnitude here, so the line cannot be ordered and "
                "nobody assembling the board knows what to fit.",
                refs=[comp["ref"]],
                fix=f"Give {comp['ref']} a value that can be ordered.",
            )
        )
    return out


# -------------------------------------------------------------------- copper

TOL = 0.02  # mm; KiCad quantises to a nanometre, so this is generous


def _rot(x: float, y: float, deg: float) -> tuple[float, float]:
    """KiCad's RotatePoint, matching extract/layout.place()."""
    if not deg:
        return x, y
    a = math.radians(deg)
    ca, sa = math.cos(a), math.sin(a)
    return x * ca + y * sa, y * ca - x * sa


def _pad_layers(pad: dict) -> set[str]:
    out = set()
    for layer in pad["layers"]:
        if layer in ("*.Cu", "*"):
            out |= {"F.Cu", "B.Cu"}
        elif layer.endswith(".Cu"):
            out.add(layer)
    return out


def copper_items(board: dict) -> list[dict]:
    """Every piece of copper, as a net plus a layer set plus a shape."""
    items: list[dict] = []
    for fp in board["layout"]["footprints"]:
        for pad in fp["pads"]:
            layers = _pad_layers(pad)
            if not layers or not pad["net"]:
                continue
            dx, dy = _rot(pad["x"], pad["y"], fp["rot"])
            items.append(
                {
                    "kind": "pad",
                    "id": f"{fp['ref']}.{pad['num']}",
                    "net": pad["net"],
                    "layers": layers,
                    "x": fp["x"] + dx,
                    "y": fp["y"] + dy,
                    # A pad is treated as a disc of its inscribed-to-circumscribed
                    # mean radius: exact enough at this tolerance and immune to
                    # the pad's own rotation.
                    "r": max(pad["w"], pad["h"]) / 2.0,
                }
            )
    for track in board["layout"]["tracks"]:
        if not track["layer"].endswith(".Cu"):
            continue
        items.append(
            {
                "kind": "track",
                "id": track["id"],
                "net": track["net"],
                "layers": {track["layer"]},
                "seg": (track["x1"], track["y1"], track["x2"], track["y2"]),
                "r": track["width"] / 2.0,
            }
        )
    for via in board["layout"]["vias"]:
        items.append(
            {
                "kind": "via",
                "id": via["id"],
                "net": via["net"],
                "layers": {l for l in via["layers"] if l.endswith(".Cu")} or {"F.Cu", "B.Cu"},
                "x": via["x"],
                "y": via["y"],
                "r": via["size"] / 2.0,
            }
        )
    for zone in board["layout"]["zones"]:
        if zone.get("disabled"):
            continue
        for i, fill in enumerate(zone["filled"]):
            if not fill["layer"].endswith(".Cu") or len(fill["pts"]) < 3:
                continue
            items.append(
                {
                    "kind": "zone",
                    "id": f"{zone['id']}.{i}",
                    "net": zone["net"],
                    "layers": {fill["layer"]},
                    "poly": fill["pts"],
                    "bbox": (
                        min(p[0] for p in fill["pts"]),
                        min(p[1] for p in fill["pts"]),
                        max(p[0] for p in fill["pts"]),
                        max(p[1] for p in fill["pts"]),
                    ),
                }
            )
    return items


def _point_to_segment(px: float, py: float, seg) -> float:
    x1, y1, x2, y2 = seg
    dx, dy = x2 - x1, y2 - y1
    length2 = dx * dx + dy * dy
    if length2 == 0.0:
        return math.dist((px, py), (x1, y1))
    t = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / length2))
    return math.dist((px, py), (x1 + t * dx, y1 + t * dy))


def _segments_close(a, b, gap: float) -> bool:
    return min(
        _point_to_segment(a[0], a[1], b),
        _point_to_segment(a[2], a[3], b),
        _point_to_segment(b[0], b[1], a),
        _point_to_segment(b[2], b[3], a),
    ) <= gap


def _in_polygon(px: float, py: float, poly) -> bool:
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > py) != (yj > py):
            if px < (xj - xi) * (py - yi) / (yj - yi) + xi:
                inside = not inside
        j = i
    return inside


def _touches_zone(item: dict, zone: dict) -> bool:
    bx0, by0, bx1, by1 = zone["bbox"]
    points = []
    if item["kind"] == "track":
        x1, y1, x2, y2 = item["seg"]
        points = [(x1, y1), (x2, y2), ((x1 + x2) / 2, (y1 + y2) / 2)]
    else:
        points = [(item["x"], item["y"])]
    pad = item.get("r", 0.0) + TOL
    for px, py in points:
        if not (bx0 - pad <= px <= bx1 + pad and by0 - pad <= py <= by1 + pad):
            continue
        if _in_polygon(px, py, zone["poly"]):
            return True
        # A pad sitting just outside the fill still connects through its own
        # thermal spoke; the fill is drawn back by the clearance.
        for i in range(len(zone["poly"])):
            edge = (*zone["poly"][i - 1], *zone["poly"][i])
            if _point_to_segment(px, py, edge) <= pad:
                return True
    return False


def connected(a: dict, b: dict) -> bool:
    if not (a["layers"] & b["layers"]):
        return False
    if a["kind"] == "zone" or b["kind"] == "zone":
        zone, other = (a, b) if a["kind"] == "zone" else (b, a)
        if other["kind"] == "zone":
            return False  # two fills of the same net on the same layer are one pour
        return _touches_zone(other, zone)
    gap = a.get("r", 0.0) + b.get("r", 0.0) + TOL
    if a["kind"] == "track" and b["kind"] == "track":
        return _segments_close(a["seg"], b["seg"], gap)
    if a["kind"] == "track":
        return _point_to_segment(b["x"], b["y"], a["seg"]) <= gap
    if b["kind"] == "track":
        return _point_to_segment(a["x"], a["y"], b["seg"]) <= gap
    return math.dist((a["x"], a["y"]), (b["x"], b["y"])) <= gap


def islands(board: dict) -> dict[str, list[list[dict]]]:
    """Copper connectivity per net, as a list of connected groups."""
    by_net: dict[str, list[dict]] = {}
    for item in copper_items(board):
        if item["net"]:
            by_net.setdefault(item["net"], []).append(item)

    out: dict[str, list[list[dict]]] = {}
    for net, items in by_net.items():
        parent = list(range(len(items)))

        def find(i: int) -> int:
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i

        for i in range(len(items)):
            for j in range(i + 1, len(items)):
                if find(i) != find(j) and connected(items[i], items[j]):
                    parent[find(i)] = find(j)

        groups: dict[int, list[dict]] = {}
        for i, item in enumerate(items):
            groups.setdefault(find(i), []).append(item)
        out[net] = list(groups.values())
    return out


@rule("net-island", "critical")
def check_net_island(board: dict) -> list[dict]:
    """A net's pads must all reach each other through copper.

    This is the whole argument for making routing editable. Strip the ground
    vias and the top pour and every ground pad on the front of the board is
    stranded from the pour on the back — while the netlist still says they are
    one net, ERC still passes, and DRC still passes, because both of them are
    reading the same netlist rather than the copper.
    """
    out = []
    for net, groups in islands(board).items():
        with_pads = [g for g in groups if any(i["kind"] == "pad" for i in g)]
        if len(with_pads) < 2:
            continue
        # Pick the main island once and derive both the count and the refs from
        # the same partition. Sorting the counts but slicing the unsorted list
        # named nine parts that were on the surviving island and missed one
        # that was not — and section 8 grades findings by ref overlap.
        pads_in = lambda group: sum(1 for i in group if i["kind"] == "pad")
        main = max(with_pads, key=pads_in)
        rest = [g for g in with_pads if g is not main]
        stranded = sum(pads_in(g) for g in rest)
        refs = {i["id"].split(".")[0] for g in rest for i in g if i["kind"] == "pad"}
        out.append(
            finding(
                "net-island",
                f"{net} is not one piece of copper: {len(with_pads)} separate islands, {stranded} pads stranded",
                "The netlist says these pads are one net and the copper says "
                "otherwise. Nothing in ERC or DRC reads the copper, so both pass "
                "a board that cannot work.",
                refs=sorted(refs),
                nets=[net],
                severity="critical",
                fix=(
                    f"Stitch the {net} islands together: vias between the layers "
                    "where the pads are, and a pour on both."
                ),
            )
        )
    return out


# ---------------------------------------------------------------------------


def run_checks(board: dict) -> list[dict]:
    out: list[dict] = []
    for _, fn in RULES:
        out.extend(fn(board))
    return out


if __name__ == "__main__":
    import json
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from console import utf8
    from harness.ops import apply_edits
    from harness.generators import defects_for

    utf8()
    root = Path(__file__).resolve().parent.parent
    good = json.loads((root / "boards" / "stm32-good.json").read_text(encoding="utf-8"))

    print("clean board:")
    for f in run_checks(good) or [None]:
        print("  ", f["title"] if f else "no findings")

    for preset in defects_for(good, "stm32-good"):
        work = json.loads(json.dumps(good))
        apply_edits(work, preset["edits"])
        found = run_checks(work)
        hit = "HIT " if found else "-   "
        print(f"\n{hit} {preset['id']} (wants {preset['rule']})")
        for f in found:
            print(f"     [{f['rule']}] {f['title']}")

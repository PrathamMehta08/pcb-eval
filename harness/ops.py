"""The edit operations. Every defect this tool can inject is one of these.

Each operation mutates the `Board` dict in place and returns a log entry that
carries everything needed to reverse it. `undo` pops the last entry and applies
its inverse, so the board hash returns to exactly what it was.

`site/ops.js` implements the same nine operations against the same JSON, and
`tests/fixtures/ops.json` is the shared fixture that keeps the two honest.

**Schematic edits stop at the schematic.** `move_pin`, `swap_pins` and
`set_value` change the netlist and nothing else; the copper keeps the routing it
was extracted with. That is the honest model, because the three views edit three
different things, and because the alternative poisons the eval: if a pin
reassignment also repointed its pads, every schematic defect would show up as a
copper island, `net-island` would catch all seven presets for free, and the
scores would measure an artifact of the editor rather than anything about how
well a board gets reviewed.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Callable

OPS: dict[str, Callable] = {}
UNDOS: dict[str, Callable] = {}


class OpError(ValueError):
    """An operation that cannot apply — a missing ref, pin, net or id."""


def op(name: str):
    def wrap(fn):
        OPS[name] = fn
        return fn

    return wrap


def undo_op(name: str):
    def wrap(fn):
        UNDOS[name] = fn
        return fn

    return wrap


# --------------------------------------------------------------------- lookup


def find_component(board: dict, ref: str) -> dict:
    for comp in board["components"]:
        if comp["ref"] == ref:
            return comp
    raise OpError(f"no component {ref!r}")


def find_net(board: dict, name: str) -> dict | None:
    for net in board["nets"]:
        if net["name"] == name:
            return net
    return None


def find_node(board: dict, ref: str, pin: str) -> tuple[dict, dict]:
    for net in board["nets"]:
        for node in net["nodes"]:
            if node["ref"] == ref and node["pin"] == pin:
                return net, node
    raise OpError(f"no pin {ref}.{pin} on any net")


def find_footprint(board: dict, ref: str) -> dict:
    for fp in board["layout"]["footprints"]:
        if fp["ref"] == ref:
            return fp
    raise OpError(f"no footprint {ref!r}")


def _by_id(items: list[dict], item_id: str, what: str) -> tuple[int, dict]:
    for i, item in enumerate(items):
        if item.get("id") == item_id:
            return i, item
    raise OpError(f"no {what} {item_id!r}")


# ------------------------------------------------------------------ schematic


@op("move_pin")
def move_pin(board: dict, ref: str, pin: str, to_net: str) -> dict:
    """Reassign one pin to a different net, creating the net if it is new."""
    pin = str(pin)
    net, node = find_node(board, ref, pin)
    if net["name"] == to_net:
        raise OpError(f"{ref}.{pin} is already on {to_net!r}")

    target = find_net(board, to_net)
    created = target is None
    if created:
        target = {
            "name": to_net,
            "code": max((n.get("code", 0) for n in board["nets"]), default=0) + 1,
            "nodes": [],
        }
        board["nets"].append(target)

    net["nodes"].remove(node)
    target["nodes"].append(node)

    return {
        "op": "move_pin",
        "args": {"ref": ref, "pin": pin, "to_net": to_net},
        "from_net": net["name"],
        "created_net": created,
        "label": f"{ref}.{pin}: {net['name']} → {to_net}",
    }


@undo_op("move_pin")
def _undo_move_pin(board: dict, entry: dict) -> None:
    ref = entry["args"]["ref"]
    pin = entry["args"]["pin"]
    net, node = find_node(board, ref, pin)
    home = find_net(board, entry["from_net"])
    if home is None:
        raise OpError(f"net {entry['from_net']!r} vanished; cannot undo")
    net["nodes"].remove(node)
    home["nodes"].append(node)
    if entry["created_net"] and not net["nodes"]:
        board["nets"].remove(net)


@op("swap_pins")
def swap_pins(board: dict, ref: str, pin_a: str, pin_b: str) -> dict:
    """Exchange the nets of two pins on the same part — the connector defect."""
    pin_a, pin_b = str(pin_a), str(pin_b)
    net_a, node_a = find_node(board, ref, pin_a)
    net_b, node_b = find_node(board, ref, pin_b)
    if net_a is net_b:
        raise OpError(f"{ref}.{pin_a} and {ref}.{pin_b} are already the same net")

    name_a, name_b = net_a["name"], net_b["name"]
    net_a["nodes"].remove(node_a)
    net_b["nodes"].remove(node_b)
    net_a["nodes"].append(node_b)
    net_b["nodes"].append(node_a)

    return {
        "op": "swap_pins",
        "args": {"ref": ref, "pin_a": pin_a, "pin_b": pin_b},
        "label": f"{ref}: pin {pin_a} ↔ pin {pin_b} ({name_a} ↔ {name_b})",
    }


@undo_op("swap_pins")
def _undo_swap_pins(board: dict, entry: dict) -> None:
    swap_pins(board, **entry["args"])  # a swap is its own inverse


@op("set_value")
def set_value(board: dict, ref: str, value: str) -> dict:
    comp = find_component(board, ref)
    before = comp["value"]
    if before == value:
        raise OpError(f"{ref} is already {value!r}")
    comp["value"] = value
    return {
        "op": "set_value",
        "args": {"ref": ref, "value": value},
        "from_value": before,
        "label": f"{ref}: value {before!r} → {value!r}",
    }


@undo_op("set_value")
def _undo_set_value(board: dict, entry: dict) -> None:
    find_component(board, entry["args"]["ref"])["value"] = entry["from_value"]


# --------------------------------------------------------------------- layout


@op("move_footprint")
def move_footprint(board: dict, ref: str, x: float, y: float) -> dict:
    fp = find_footprint(board, ref)
    before = (fp["x"], fp["y"])
    fp["x"], fp["y"] = round(float(x), 4), round(float(y), 4)
    return {
        "op": "move_footprint",
        "args": {"ref": ref, "x": fp["x"], "y": fp["y"]},
        "from_xy": list(before),
        "label": f"{ref}: moved to ({fp['x']:.2f}, {fp['y']:.2f}) mm",
    }


@undo_op("move_footprint")
def _undo_move_footprint(board: dict, entry: dict) -> None:
    fp = find_footprint(board, entry["args"]["ref"])
    fp["x"], fp["y"] = entry["from_xy"]


@op("rotate_footprint")
def rotate_footprint(board: dict, ref: str, deg: float) -> dict:
    """Set the absolute orientation. The UI passes current + 90."""
    fp = find_footprint(board, ref)
    before = fp["rot"]
    after = round(float(deg) % 360.0, 4)
    if after == before % 360.0:
        raise OpError(f"{ref} is already at {deg} degrees")
    fp["rot"] = after
    return {
        "op": "rotate_footprint",
        "args": {"ref": ref, "deg": after},
        "from_rot": before,
        "label": f"{ref}: rotated to {after:g}°",
    }


@undo_op("rotate_footprint")
def _undo_rotate_footprint(board: dict, entry: dict) -> None:
    find_footprint(board, entry["args"]["ref"])["rot"] = entry["from_rot"]


# -------------------------------------------------------------------- routing


@op("delete_track")
def delete_track(board: dict, track_id: str) -> dict:
    tracks = board["layout"]["tracks"]
    index, track = _by_id(tracks, track_id, "track")
    tracks.pop(index)
    return {
        "op": "delete_track",
        "args": {"track_id": track_id},
        "index": index,
        "track": track,
        "label": f"deleted {track['width']:g} mm {track['net'] or 'unnamed'} track on {track['layer']}",
    }


@undo_op("delete_track")
def _undo_delete_track(board: dict, entry: dict) -> None:
    board["layout"]["tracks"].insert(entry["index"], entry["track"])


@op("set_track_width")
def set_track_width(board: dict, track_id: str, mm: float) -> dict:
    _, track = _by_id(board["layout"]["tracks"], track_id, "track")
    before = track["width"]
    track["width"] = round(float(mm), 4)
    return {
        "op": "set_track_width",
        "args": {"track_id": track_id, "mm": track["width"]},
        "from_width": before,
        "label": f"{track['net'] or 'unnamed'} track: {before:g} → {track['width']:g} mm",
    }


@undo_op("set_track_width")
def _undo_set_track_width(board: dict, entry: dict) -> None:
    _, track = _by_id(board["layout"]["tracks"], entry["args"]["track_id"], "track")
    track["width"] = entry["from_width"]


@op("delete_via")
def delete_via(board: dict, via_id: str) -> dict:
    vias = board["layout"]["vias"]
    index, via = _by_id(vias, via_id, "via")
    vias.pop(index)
    return {
        "op": "delete_via",
        "args": {"via_id": via_id},
        "index": index,
        "via": via,
        "label": f"deleted {via['net'] or 'unnamed'} via at ({via['x']:.1f}, {via['y']:.1f})",
    }


@undo_op("delete_via")
def _undo_delete_via(board: dict, entry: dict) -> None:
    board["layout"]["vias"].insert(entry["index"], entry["via"])


@op("toggle_zone")
def toggle_zone(board: dict, zone_id: str) -> dict:
    """Turn a copper pour off. The zone stays in the file, unfilled, which is
    what an un-poured board looks like: outline drawn, no copper."""
    _, zone = _by_id(board["layout"]["zones"], zone_id, "zone")
    now_off = not zone.get("disabled", False)
    if now_off:
        zone["disabled"] = True
    else:
        zone.pop("disabled", None)
    state = "removed" if now_off else "restored"
    return {
        "op": "toggle_zone",
        "args": {"zone_id": zone_id},
        "disabled": now_off,
        "label": f"{state} {zone['net'] or 'unnamed'} pour on {zone['layer']}",
    }


@undo_op("toggle_zone")
def _undo_toggle_zone(board: dict, entry: dict) -> None:
    toggle_zone(board, entry["args"]["zone_id"])  # a toggle is its own inverse


# ------------------------------------------------------------------ the cycle


def apply_edit(board: dict, edit: dict) -> dict:
    name = edit["op"]
    if name not in OPS:
        raise OpError(f"unknown operation {name!r}")
    return OPS[name](board, **edit.get("args", {}))


def apply_edits(board: dict, edits: list[dict]) -> list[dict]:
    log: list[dict] = []
    for edit in edits:
        log.append(apply_edit(board, edit))
    return log


def undo(board: dict, log: list[dict]) -> dict | None:
    if not log:
        return None
    entry = log.pop()
    UNDOS[entry["op"]](board, entry)
    return entry


def canonical(board: dict) -> Any:
    """The board's meaning, independent of list order and of `meta`.

    Operations append rather than re-sort, so two boards that differ only in the
    order nodes were added must still hash the same. Normalising here is what
    makes `undo` provably exact, and what lets `site/ops.js` agree with this
    file without also copying its insertion order.
    """
    layout = board["layout"]
    return {
        "components": sorted(board["components"], key=lambda c: c["ref"]),
        "nets": sorted(
            (
                {
                    "name": net["name"],
                    "nodes": sorted(
                        ({"ref": n["ref"], "pin": n["pin"]} for n in net["nodes"]),
                        key=lambda n: (n["ref"], n["pin"]),
                    ),
                }
                for net in board["nets"]
            ),
            key=lambda n: n["name"],
        ),
        "layout": {
            "size": layout["size"],
            "outline": layout["outline"],
            "footprints": sorted(layout["footprints"], key=lambda f: f["ref"]),
            "tracks": sorted(layout["tracks"], key=lambda t: t["id"]),
            "vias": sorted(layout["vias"], key=lambda v: v["id"]),
            "zones": sorted(layout["zones"], key=lambda z: z["id"]),
        },
    }


def board_hash(board: dict) -> str:
    blob = json.dumps(canonical(board), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]

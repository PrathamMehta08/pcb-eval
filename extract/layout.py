"""Parse a `.kicad_pcb` into the `layout` half of the Board model.

Everything is emitted in board-relative millimetres: the Edge.Cuts bounding-box
minimum is subtracted once here, so nothing downstream ever sees KiCad sheet
coordinates. Footprint pads and graphics stay in footprint-local millimetres and
are placed by `place()`, which is mirrored by `place()` in site/render.js.
"""

from __future__ import annotations

import math
from pathlib import Path

from extract.sexpr import Str, child, children, num, parse, tag, value

COPPER = ("F.Cu", "B.Cu")


def place(x: float, y: float, rot_deg: float) -> tuple[float, float]:
    """KiCad's RotatePoint: y is down, positive angles turn counter-clockwise."""
    if not rot_deg:
        return x, y
    a = math.radians(rot_deg)
    ca, sa = math.cos(a), math.sin(a)
    return x * ca + y * sa, y * ca - x * sa


def _at(node, default=(0.0, 0.0, 0.0)):
    found = child(node, "at")
    if found is None:
        return default
    x = num(found[1]) if len(found) > 1 else default[0]
    y = num(found[2]) if len(found) > 2 else default[1]
    r = num(found[3]) if len(found) > 3 else 0.0
    return x, y, r


def _layers(node) -> list[str]:
    found = child(node, "layers")
    if found is None:
        one = value(node, "layer")
        return [str(one)] if one is not None else []
    return [str(v) for v in found[1:] if isinstance(v, str)]


def _net(node) -> str:
    """Net names are quoted strings in KiCad 9+; older files use an index."""
    found = child(node, "net")
    if found is None or len(found) < 2:
        return ""
    for item in found[1:]:
        if isinstance(item, Str):
            return str(item)
    return ""


def parse_outline(doc) -> list[dict]:
    """Edge.Cuts graphics, in sheet millimetres (the caller re-origins them)."""
    out = []
    for node in doc[1:]:
        t = tag(node)
        if t not in ("gr_line", "gr_arc", "gr_circle", "gr_rect"):
            continue
        if str(value(node, "layer", default="")) != "Edge.Cuts":
            continue
        sx, sy = num(value(node, "start", 1)), num(value(node, "start", 2))
        ex, ey = num(value(node, "end", 1)), num(value(node, "end", 2))
        if t == "gr_arc":
            out.append(
                {
                    "kind": "arc",
                    "x1": sx, "y1": sy,
                    "mx": num(value(node, "mid", 1)), "my": num(value(node, "mid", 2)),
                    "x2": ex, "y2": ey,
                }
            )
        elif t == "gr_circle":
            r = math.dist((sx, sy), (ex, ey))
            out.append({"kind": "circle", "x": sx, "y": sy, "r": r})
        elif t == "gr_rect":
            out.append({"kind": "rect", "x1": sx, "y1": sy, "x2": ex, "y2": ey})
        else:
            out.append({"kind": "line", "x1": sx, "y1": sy, "x2": ex, "y2": ey})
    return out


def outline_bbox(outline: list[dict]) -> tuple[float, float, float, float]:
    if not outline:
        raise ValueError(
            "the board has no Edge.Cuts geometry, so there is no origin to "
            "make coordinates relative to"
        )
    xs: list[float] = []
    ys: list[float] = []
    for item in outline:
        if item["kind"] == "circle":
            xs += [item["x"] - item["r"], item["x"] + item["r"]]
            ys += [item["y"] - item["r"], item["y"] + item["r"]]
            continue
        xs += [item["x1"], item["x2"]]
        ys += [item["y1"], item["y2"]]
        if item["kind"] == "arc":
            # The arc bulges past its endpoints; the mid point lies on the arc,
            # so including it bounds a 90 degree corner exactly.
            xs.append(item["mx"])
            ys.append(item["my"])
    return min(xs), min(ys), max(xs), max(ys)


def _pads(fp) -> list[dict]:
    pads = []
    for pad in children(fp, "pad"):
        number = str(pad[1]) if len(pad) > 1 else ""
        kind = str(pad[2]) if len(pad) > 2 else ""
        shape = str(pad[3]) if len(pad) > 3 else ""
        x, y, rot = _at(pad)
        pads.append(
            {
                "num": number,
                "kind": kind,
                "shape": shape,
                "x": x, "y": y, "rot": rot,
                "w": num(value(pad, "size", 1)),
                "h": num(value(pad, "size", 2)),
                "drill": num(value(pad, "drill", 1)) if child(pad, "drill") else 0.0,
                "layers": _layers(pad),
                "net": _net(pad),
                "function": str(value(pad, "pinfunction", default="") or ""),
                "type": str(value(pad, "pintype", default="") or ""),
            }
        )
    return pads


def _graphics(fp) -> list[dict]:
    """Silkscreen and fabrication outlines, footprint-local, for the body shape."""
    out = []
    for node in fp[1:]:
        t = tag(node)
        if t not in ("fp_line", "fp_arc", "fp_circle", "fp_rect", "fp_poly"):
            continue
        layer = str(value(node, "layer", default=""))
        if layer not in ("F.SilkS", "B.SilkS", "F.Fab", "B.Fab"):
            continue
        if t == "fp_poly":
            pts = child(node, "pts")
            if pts is None:
                continue
            out.append(
                {
                    "kind": "poly",
                    "layer": layer,
                    "pts": [[num(p[1]), num(p[2])] for p in children(pts, "xy")],
                }
            )
            continue
        item = {
            "kind": t[3:],
            "layer": layer,
            "x1": num(value(node, "start", 1)), "y1": num(value(node, "start", 2)),
            "x2": num(value(node, "end", 1)), "y2": num(value(node, "end", 2)),
        }
        if t == "fp_arc":
            item["mx"] = num(value(node, "mid", 1))
            item["my"] = num(value(node, "mid", 2))
        if t == "fp_circle":
            item["r"] = math.dist((item["x1"], item["y1"]), (item["x2"], item["y2"]))
        out.append(item)
    return out


def _property(fp, name: str) -> str:
    for prop in children(fp, "property"):
        if len(prop) > 1 and str(prop[1]) == name:
            return str(prop[2]) if len(prop) > 2 else ""
    return ""


def parse_footprints(doc) -> list[dict]:
    fps = []
    for fp in children(doc, "footprint"):
        x, y, rot = _at(fp)
        path = str(value(fp, "path", default="") or "")
        fps.append(
            {
                "uuid": path.lstrip("/"),
                "fp_uuid": str(value(fp, "uuid", default="") or ""),
                "library": str(fp[1]) if len(fp) > 1 else "",
                "silk": _property(fp, "Reference"),
                "value": _property(fp, "Value"),
                "x": x, "y": y, "rot": rot,
                "layer": "B" if str(value(fp, "layer", default="F.Cu")).startswith("B") else "F",
                "pads": _pads(fp),
                "graphics": _graphics(fp),
            }
        )
    return fps


def parse_tracks(doc) -> list[dict]:
    tracks = []
    for seg in children(doc, "segment"):
        tracks.append(
            {
                "x1": num(value(seg, "start", 1)), "y1": num(value(seg, "start", 2)),
                "x2": num(value(seg, "end", 1)), "y2": num(value(seg, "end", 2)),
                "width": num(value(seg, "width", 1)),
                "layer": str(value(seg, "layer", default="")),
                "net": _net(seg),
            }
        )
    return tracks


def parse_vias(doc) -> list[dict]:
    vias = []
    for via in children(doc, "via"):
        x, y, _ = _at(via)
        vias.append(
            {
                "x": x, "y": y,
                "size": num(value(via, "size", 1)),
                "drill": num(value(via, "drill", 1)),
                "layers": _layers(via),
                "net": _net(via),
            }
        )
    return vias


def parse_zones(doc) -> list[dict]:
    zones = []
    for zone in children(doc, "zone"):
        outline = child(zone, "polygon")
        pts = child(outline, "pts") if outline is not None else None
        filled = []
        for fill in children(zone, "filled_polygon"):
            fpts = child(fill, "pts")
            if fpts is None:
                continue
            filled.append(
                {
                    "layer": str(value(fill, "layer", default="")),
                    "pts": [[num(p[1]), num(p[2])] for p in children(fpts, "xy")],
                }
            )
        layers = _layers(zone)
        zones.append(
            {
                "name": str(value(zone, "name", default="") or ""),
                "net": _net(zone),
                "layer": layers[0] if layers else "",
                "layers": layers,
                "priority": int(num(value(zone, "priority", default=0))),
                "polygon": [[num(p[1]), num(p[2])] for p in children(pts, "xy")] if pts else [],
                "filled": filled,
            }
        )
    return zones


def _shift(layout: dict, ox: float, oy: float) -> None:
    """Re-origin every absolute coordinate to the outline bounding box minimum."""
    for item in layout["outline"]:
        if item["kind"] == "circle":
            item["x"] -= ox
            item["y"] -= oy
            continue
        item["x1"] -= ox
        item["y1"] -= oy
        item["x2"] -= ox
        item["y2"] -= oy
        if item["kind"] == "arc":
            item["mx"] -= ox
            item["my"] -= oy
    for fp in layout["footprints"]:
        fp["x"] -= ox
        fp["y"] -= oy
    for tr in layout["tracks"]:
        tr["x1"] -= ox
        tr["y1"] -= oy
        tr["x2"] -= ox
        tr["y2"] -= oy
    for via in layout["vias"]:
        via["x"] -= ox
        via["y"] -= oy
    for zone in layout["zones"]:
        zone["polygon"] = [[x - ox, y - oy] for x, y in zone["polygon"]]
        for fill in zone["filled"]:
            fill["pts"] = [[x - ox, y - oy] for x, y in fill["pts"]]


def parse_layout(path: str | Path) -> dict:
    doc = parse(Path(path).read_text(encoding="utf-8"))
    outline = parse_outline(doc)
    min_x, min_y, max_x, max_y = outline_bbox(outline)
    layout = {
        "origin": {"x": round(min_x, 4), "y": round(min_y, 4)},
        "size": {"w": round(max_x - min_x, 4), "h": round(max_y - min_y, 4)},
        "outline": outline,
        "footprints": parse_footprints(doc),
        "tracks": parse_tracks(doc),
        "vias": parse_vias(doc),
        "zones": parse_zones(doc),
    }
    _shift(layout, min_x, min_y)
    return layout


DEFAULT_PCB = r"C:/Users/pratham/Documents/PCBs/STM32/STM32/STM32.kicad_pcb"


if __name__ == "__main__":
    import sys

    lay = parse_layout(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_PCB)
    print(f"footprints {len(lay['footprints'])}")
    print(f"pads       {sum(len(f['pads']) for f in lay['footprints'])}")
    print(f"segments   {len(lay['tracks'])}")
    print(f"vias       {len(lay['vias'])}")
    print(f"zones      {len(lay['zones'])}")
    print(f"outline    {len(lay['outline'])} items, bbox {lay['size']['w']} x {lay['size']['h']} mm")
    print(f"origin     {lay['origin']}")

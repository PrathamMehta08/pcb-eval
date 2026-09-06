"""Placed-symbol positions from a `.kicad_sch`, for the schematic overlay.

The schematic view embeds KiCad's own SVG export, which is a picture and cannot
be edited. Markers are drawn on top of it instead, so all that is needed here is
where each component sits on the sheet and how big its body is.

KiCad writes schematic coordinates in millimetres on the paper, and the SVG
export carries `viewBox="0 0 297.0022 210.0072"` for A4 — one unit per
millimetre, same origin. So these coordinates drop straight into the overlay.

Symbol Y is inverted between the library frame and the sheet frame; KiCad draws
library geometry with Y up and sheets with Y down. `_transform` handles it.
"""

from __future__ import annotations

import math
from pathlib import Path

from extract.sexpr import child, children, num, parse, tag, value

PAPER = {
    "A4": (297.0, 210.0),
    "A3": (420.0, 297.0),
    "A2": (594.0, 420.0),
    "A": (279.4, 215.9),
    "B": (431.8, 279.4),
}


def _lib_bbox(sym) -> tuple[float, float, float, float]:
    """Bounding box of a library symbol's graphics, in library millimetres."""
    xs: list[float] = []
    ys: list[float] = []

    def visit(node):
        for item in node[1:]:
            if not isinstance(item, list):
                continue
            t = tag(item)
            if t == "rectangle":
                xs.extend([num(value(item, "start", 1)), num(value(item, "end", 1))])
                ys.extend([num(value(item, "start", 2)), num(value(item, "end", 2))])
            elif t in ("polyline", "bezier"):
                pts = child(item, "pts")
                for p in children(pts or [], "xy"):
                    xs.append(num(p[1]))
                    ys.append(num(p[2]))
            elif t == "circle":
                cx, cy = num(value(item, "center", 1)), num(value(item, "center", 2))
                r = num(value(item, "radius", 1))
                xs.extend([cx - r, cx + r])
                ys.extend([cy - r, cy + r])
            elif t == "arc":
                for key in ("start", "mid", "end"):
                    xs.append(num(value(item, key, 1)))
                    ys.append(num(value(item, key, 2)))
            elif t == "pin":
                px, py = num(value(item, "at", 1)), num(value(item, "at", 2))
                xs.append(px)
                ys.append(py)
            elif t == "symbol":
                visit(item)

    visit(sym)
    if not xs:
        return -2.54, -2.54, 2.54, 2.54
    return min(xs), min(ys), max(xs), max(ys)


def _transform(x: float, y: float, rot_deg: float, mirror: str) -> tuple[float, float]:
    """Library frame (Y up) to sheet frame (Y down), with rotation and mirror."""
    if mirror == "x":
        y = -y
    elif mirror == "y":
        x = -x
    a = math.radians(rot_deg)
    ca, sa = math.cos(a), math.sin(a)
    rx = x * ca - y * sa
    ry = x * sa + y * ca
    return rx, -ry


def parse_schematic(path: str | Path) -> dict:
    doc = parse(Path(path).read_text(encoding="utf-8"))

    lib: dict[str, tuple[float, float, float, float]] = {}
    for sym in children(child(doc, "lib_symbols") or [], "symbol"):
        if len(sym) > 1:
            lib[str(sym[1])] = _lib_bbox(sym)

    symbols = []
    for sym in children(doc, "symbol"):
        ref = ""
        for prop in children(sym, "property"):
            if len(prop) > 2 and str(prop[1]) == "Reference":
                ref = str(prop[2])
        if not ref or ref.startswith("#"):
            continue  # power and ground flags are not components
        at = child(sym, "at") or []
        x = num(at[1]) if len(at) > 1 else 0.0
        y = num(at[2]) if len(at) > 2 else 0.0
        rot = num(at[3]) if len(at) > 3 else 0.0
        mirror = str(value(sym, "mirror", default="") or "")
        lib_id = str(value(sym, "lib_id", default="") or "")
        bx0, by0, bx1, by1 = lib.get(lib_id, (-2.54, -2.54, 2.54, 2.54))
        corners = [
            _transform(cx, cy, rot, mirror)
            for cx, cy in ((bx0, by0), (bx1, by0), (bx1, by1), (bx0, by1))
        ]
        cxs = [c[0] for c in corners]
        cys = [c[1] for c in corners]
        symbols.append(
            {
                "ref": ref,
                "uuid": str(value(sym, "uuid", default="") or ""),
                "lib_id": lib_id,
                "x": round(x, 4),
                "y": round(y, 4),
                "rot": rot,
                "bbox": [
                    round(x + min(cxs), 3),
                    round(y + min(cys), 3),
                    round(x + max(cxs), 3),
                    round(y + max(cys), 3),
                ],
            }
        )

    paper = str(value(doc, "paper", default="A4") or "A4")
    w, h = PAPER.get(paper, PAPER["A4"])
    return {"paper": paper, "width": w, "height": h, "symbols": symbols}


DEFAULT_SCH = r"C:/Users/pratham/Documents/PCBs/STM32/STM32/STM32.kicad_sch"


if __name__ == "__main__":
    import sys

    data = parse_schematic(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SCH)
    print(f"paper {data['paper']} {data['width']} x {data['height']} mm")
    print(f"symbols {len(data['symbols'])}")
    for s in data["symbols"][:5]:
        print(" ", s["ref"], s["x"], s["y"], s["rot"], s["bbox"])

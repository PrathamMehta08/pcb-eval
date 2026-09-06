"""Board -> the text a reviewer actually reads.

The raw netlist export is 98 KB of XML and the extracted board is 520 KB of
JSON. Neither is worth sending: most of it is coordinates, UUIDs and fill
polygons that no reviewer reasons about. This produces a few thousand tokens
that keep everything a review needs and drop everything it does not.

What survives, and why:

- every component with its value, package and — for anything that is not a
  two-terminal passive — the one-line description out of the symbol library,
  which is where part context comes from for free;
- every net with its nodes, each carrying the chip's own pin name and the pin's
  electrical type, because that is what makes datasheet-level checks writable;
- a copper summary per net: island count, track lengths and widths, vias,
  pours. Without this the ground defect is invisible, and that defect is the
  whole argument for the tool.

Unconnected nets collapse into one section. Twenty-five copies of
`unconnected-(U2-PA10-Pad31)` cost about four hundred tokens and say exactly
what `U2.31 (PA10)` says.
"""

from __future__ import annotations

import math
import re

from harness.checks import base_type, copper_items, islands

PROMPT_VERSION = "distill-1"

#: Package names are long and the informative part is a fragment of the middle.
_PACKAGE_TAIL = re.compile(r"^[^:]*:")
_METRIC_IMPERIAL = re.compile(r"^[RCLD](?:_LED)?_(\d{4})_\d+Metric$")
_HEADER = re.compile(r"^PinHeader_(\d+x\d+)_P([\d.]+)mm.*$")
_LIB_BOILERPLATE = re.compile(
    r"(,?\s*script generated.*$)|(^Generic connector,\s*)|(\s*\(kicad-library-utils.*\)$)",
    re.I,
)


def approx_tokens(text: str) -> int:
    """Real token count where tiktoken is installed, characters over four where not."""
    try:
        import tiktoken

        return len(tiktoken.get_encoding("o200k_base").encode(text))
    except Exception:
        return math.ceil(len(text) / 4)


def _package(footprint: str) -> str:
    """`Capacitor_SMD:C_0805_2012Metric` is twelve tokens to say `0805`."""
    tail = _PACKAGE_TAIL.sub("", footprint or "")
    imperial = _METRIC_IMPERIAL.match(tail)
    if imperial:
        return imperial.group(1)
    header = _HEADER.match(tail)
    if header:
        return f"{header.group(1)}hdr{header.group(2)}mm"
    tail = re.sub(r"_[\d.]+x[\d.]+mm.*$", "", tail)
    tail = re.sub(r"^MountingHole_", "M-hole ", tail)
    return tail or "-"


def _short(text: str, words: int = 12) -> str:
    """Trim library boilerplate, then cap the length.

    Eleven headers each carrying "Generic connector, single row, 01x04, script
    generated (kicad-library-utils/...)" is two hundred tokens of nothing.
    """
    parts = _LIB_BOILERPLATE.sub("", text or "").strip(" ,").split()
    if len(parts) <= words:
        return " ".join(parts)
    return " ".join(parts[:words]) + "…"


def _node(node: dict) -> str:
    """`U3.1(I1,in)` — ref, pin, the chip's name for it, and its type."""
    function = node.get("function") or ""
    # `I1_1` is the pin name with the pin number stuck on; drop the repetition.
    function = re.sub(r"_%s$" % re.escape(node["pin"]), "", function)
    if function.lower() in ("", f"pin_{node['pin']}", node["pin"]):
        function = ""
    # `passive` and `bidirectional` are the two defaults on this board — 130 of
    # 180 pins — so naming them costs tokens and carries no information.
    kind = {
        "power_in": "pwr-in",
        "power_out": "pwr-out",
        "open_collector": "oc",
        "bidirectional": "",
        "input": "in",
        "output": "out",
        "passive": "",
        "tri_state": "tri",
        "unspecified": "?",
    }.get(base_type(node.get("type", "")), base_type(node.get("type", "")))
    inner = ",".join(p for p in (function, kind) if p)
    return f"{node['ref']}.{node['pin']}" + (f"({inner})" if inner else "")


def _components_section(board: dict) -> list[str]:
    """Actives one per line; identical passives grouped the way a BOM groups them."""
    lines = ["COMPONENTS  ref(s), value, package, description"]
    grouped: dict[tuple[str, str], list[str]] = {}
    order: list[tuple[str, str]] = []
    for comp in sorted(board["components"], key=lambda c: (c["ref"][0], len(c["ref"]), c["ref"])):
        package = _package(comp["footprint"])
        if comp["ref"].startswith(("R", "C", "L", "H", "TP")):
            key = (comp["value"] or "-", package)
            if key not in grouped:
                order.append(key)
                grouped[key] = []
            grouped[key].append(comp["ref"])
            continue
        row = f"{comp['ref']} {comp['value'] or '-'} {package}"
        description = _short(comp.get("description", ""))
        if description:
            row += f"  {description}"
        lines.append(row)
    for key in order:
        value, package = key
        lines.append(f"{','.join(grouped[key])} {value} {package}")
    return lines


def _nets_section(board: dict) -> list[str]:
    lines = [
        "NETS  name: ref.pin(pin name, type) ...  Type is omitted for passive "
        "and bidirectional pins, which are the two defaults."
    ]
    unconnected: list[str] = []
    for net in sorted(board["nets"], key=lambda n: n["name"]):
        if net["name"].startswith("unconnected-"):
            unconnected += [_node(n) for n in net["nodes"]]
            continue
        nodes = " ".join(_node(n) for n in sorted(net["nodes"], key=lambda n: (n["ref"], n["pin"])))
        lines.append(f"{net['name']}: {nodes}")
    if unconnected:
        lines.append(
            "UNCONNECTED (each is its own single-pin net, named "
            "unconnected-(REF-PINNAME-PadNUM)):"
        )
        lines.append(" ".join(sorted(unconnected)))
    return lines


def _length(track: dict) -> float:
    return math.dist((track["x1"], track["y1"]), (track["x2"], track["y2"]))


def _copper_section(board: dict) -> list[str]:
    layout = board["layout"]
    groups = islands(board)
    pads_by_net: dict[str, int] = {}
    for item in copper_items(board):
        if item["kind"] == "pad" and item["net"]:
            pads_by_net[item["net"]] = pads_by_net.get(item["net"], 0) + 1

    tracks: dict[str, list[dict]] = {}
    for track in layout["tracks"]:
        tracks.setdefault(track["net"], []).append(track)
    vias: dict[str, int] = {}
    for via in layout["vias"]:
        vias[via["net"]] = vias.get(via["net"], 0) + 1
    pours: dict[str, list[str]] = {}
    for zone in layout["zones"]:
        if not zone.get("disabled"):
            pours.setdefault(zone["net"], []).append(zone["layer"])

    size = layout["size"]
    lines = [
        f"COPPER  board {size['w']:.0f} x {size['h']:.0f} mm, two layers: F.Cu top, B.Cu bottom",
        "columns: net, pads, copper islands, total track mm, narrowest track mm, vias, pour layers",
    ]
    for net in sorted(set(pads_by_net) | set(tracks) | set(vias) | set(pours)):
        if not net or net.startswith("unconnected-"):
            continue
        segs = tracks.get(net, [])
        total = sum(_length(t) for t in segs)
        narrowest = min((t["width"] for t in segs), default=0.0)
        island_count = len([g for g in groups.get(net, []) if any(i["kind"] == "pad" for i in g)])
        lines.append(
            " ".join(
                [
                    net,
                    str(pads_by_net.get(net, 0)),
                    str(island_count),
                    f"{total:.0f}" if segs else "none",
                    f"{narrowest:.2f}" if segs else "-",
                    str(vias.get(net, 0)),
                    "+".join(sorted(pours[net])) if pours.get(net) else "none",
                ]
            )
        )
    return lines


def _placement_section(board: dict, refs: list[str]) -> list[str]:
    """Positions, but only for the parts a layout edit actually touched.

    Sending all 53 placements costs about six hundred tokens to say what nobody
    asked. Sending the edited part and everything within 8 mm of it is what a
    placement question is actually about.
    """
    if not refs:
        return []
    fps = {f["ref"]: f for f in board["layout"]["footprints"]}
    focus = [fps[r] for r in refs if r in fps]
    if not focus:
        return []
    near: dict[str, float] = {}
    for fp in board["layout"]["footprints"]:
        distance = min(math.dist((fp["x"], fp["y"]), (f["x"], f["y"])) for f in focus)
        if distance <= 8.0:
            near[fp["ref"]] = distance
    lines = ["PLACEMENT near the edited parts  ref (x, y) mm, rotation, layer, distance"]
    for ref, distance in sorted(near.items(), key=lambda kv: kv[1]):
        fp = fps[ref]
        lines.append(
            f"  {ref} ({fp['x']:.1f}, {fp['y']:.1f}) {fp['rot']:g} deg {fp['layer']}.Cu"
            + (f", {distance:.1f} mm away" if distance else ", edited")
        )
    return lines


def distill(board: dict, focus_refs: list[str] | None = None) -> str:
    meta = board["meta"]
    blocks = [
        [
            f"BOARD {meta['name']}",
            f"{len(board['components'])} components, {len(board['nets'])} nets, "
            f"{len(board['layout']['footprints'])} footprints on a "
            f"{board['layout']['size']['w']:.0f} x {board['layout']['size']['h']:.0f} mm two-layer board.",
        ],
        _components_section(board),
        _nets_section(board),
        _copper_section(board),
        _placement_section(board, focus_refs or []),
    ]
    return "\n\n".join("\n".join(block) for block in blocks if block)


if __name__ == "__main__":
    import json
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from console import utf8

    utf8()
    root = Path(__file__).resolve().parent.parent
    board = json.loads((root / "boards" / "stm32-good.json").read_text(encoding="utf-8"))
    text = distill(board)
    if "--print" in sys.argv:
        print(text)
    print(f"\n{approx_tokens(text)} tokens, {len(text)} characters", file=sys.stderr)

"""Assemble `boards/stm32-good.json`, the single source of truth.

Joins the netlist to the layout on UUID, never on the reference designator: the
PCB `Reference` fields on this board hold silkscreen labels like `LIN REG` and
`BUCK`, so a designator match silently drops eleven parts. Each footprint
carries `(path "/<uuid>")` and each netlist `<comp>` carries `<tstamps>`.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from extract.layout import DEFAULT_PCB, parse_layout
from extract.netlist import parse_netlist
from extract.schematic import DEFAULT_SCH, parse_schematic

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_NET = ROOT / "boards" / "stm32-good.net.xml"
DEFAULT_OUT = ROOT / "boards" / "stm32-good.json"


class JoinError(RuntimeError):
    pass


def round_floats(obj, places: int = 4):
    """KiCad writes six decimals of a nanometre-quantised value. Four is plenty
    at 0.1 um, and it takes about a third off the JSON."""
    if isinstance(obj, float):
        return round(obj, places)
    if isinstance(obj, dict):
        return {k: round_floats(v, places) for k, v in obj.items()}
    if isinstance(obj, list):
        return [round_floats(v, places) for v in obj]
    return obj


def build(net_xml: Path, pcb: Path, sch: Path, name: str = "stm32-good") -> dict:
    netlist = parse_netlist(net_xml)
    layout = parse_layout(pcb)
    schematic = parse_schematic(sch)

    by_uuid = {c["uuid"]: c for c in netlist["components"] if c["uuid"]}
    unresolved = []
    for fp in layout["footprints"]:
        comp = by_uuid.get(fp["uuid"])
        if comp is None:
            unresolved.append(fp["silk"] or fp["fp_uuid"])
            fp["ref"] = ""
        else:
            fp["ref"] = comp["ref"]
    if unresolved:
        raise JoinError(
            f"{len(unresolved)} of {len(layout['footprints'])} footprints did not "
            f"resolve to a netlist component: {unresolved[:5]}"
        )

    sch_by_ref = {s["ref"]: s for s in schematic["symbols"]}
    for comp in netlist["components"]:
        sym = sch_by_ref.get(comp["ref"])
        if sym:
            comp["sheet"] = {"x": sym["x"], "y": sym["y"], "bbox": sym["bbox"]}

    # Sort footprints by designator so the JSON diffs cleanly between revisions.
    layout["footprints"].sort(key=lambda f: (f["ref"][:1], len(f["ref"]), f["ref"]))

    # Stable ids. Tracks, vias and zones have no designator of their own, and
    # array indices stop being stable the moment an edit deletes one, so the
    # edit log needs an id that survives deletion and undo.
    for i, track in enumerate(layout["tracks"]):
        track["id"] = f"t{i}"
    for i, via in enumerate(layout["vias"]):
        via["id"] = f"v{i}"
    for i, zone in enumerate(layout["zones"]):
        zone["id"] = f"z{i}"

    return {
        "meta": {
            "name": name,
            "source": netlist["source"],
            "pcb": str(pcb),
            "schematic": str(sch),
            "extracted": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "sheet": {
                "paper": schematic["paper"],
                "width": schematic["width"],
                "height": schematic["height"],
            },
        },
        "components": netlist["components"],
        "nets": netlist["nets"],
        "layout": layout,
    }


def summarise(board: dict) -> str:
    lay = board["layout"]
    pads = sum(len(f["pads"]) for f in lay["footprints"])
    return (
        f"{len(board['components'])} components, {len(board['nets'])} nets, "
        f"{len(lay['footprints'])} footprints, {pads} pads, "
        f"{len(lay['tracks'])} tracks, {len(lay['vias'])} vias, "
        f"{len(lay['zones'])} zones, "
        f"board {lay['size']['w']} x {lay['size']['h']} mm"
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--netlist", type=Path, default=DEFAULT_NET)
    ap.add_argument("--pcb", type=Path, default=Path(DEFAULT_PCB))
    ap.add_argument("--sch", type=Path, default=Path(DEFAULT_SCH))
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--name", default="stm32-good")
    args = ap.parse_args()

    board = round_floats(build(args.netlist, args.pcb, args.sch, args.name))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(board, indent=1), encoding="utf-8")
    compact = args.out.with_suffix(".min.json")
    compact.write_text(json.dumps(board, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {compact} ({compact.stat().st_size / 1024:.0f} KB)")
    size_kb = args.out.stat().st_size / 1024
    print(summarise(board))
    print(f"wrote {args.out} ({size_kb:.0f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Parse a kicad-cli `kicadxml` netlist export into components and nets.

Only the standard library is used. The netlist is the canonical source for
component identity: `ref` is the designator, `tstamps` is the UUID that the
`.kicad_pcb` footprints carry as `(path "/<uuid>")`.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path


def _text(node, tag, default=""):
    found = node.find(tag)
    if found is None or found.text is None:
        return default
    return found.text.strip()


def _field(comp, name, default=""):
    """Read a <field name="..."> value, which is where KiCad hides datasheets."""
    for field in comp.iterfind("./fields/field"):
        if field.get("name") == name:
            return (field.text or "").strip() or default
    return default


def parse_components(root: ET.Element) -> list[dict]:
    components = []
    for comp in root.iterfind("./components/comp"):
        datasheet = _text(comp, "datasheet") or _field(comp, "Datasheet")
        if datasheet == "~":
            datasheet = ""
        components.append(
            {
                "ref": comp.get("ref", ""),
                "value": _text(comp, "value"),
                "footprint": _text(comp, "footprint"),
                "description": " ".join(_text(comp, "description").split()),
                "datasheet": datasheet,
                "uuid": _text(comp, "tstamps"),
            }
        )
    components.sort(key=lambda c: _ref_sort_key(c["ref"]))
    return components


def _ref_sort_key(ref: str):
    """Sort R2 before R10, and keep letter prefixes grouped."""
    head = ref.rstrip("0123456789")
    tail = ref[len(head):]
    return (head, int(tail) if tail else 0)


def parse_nets(root: ET.Element) -> list[dict]:
    nets = []
    for net in root.iterfind("./nets/net"):
        nodes = []
        for node in net.iterfind("node"):
            nodes.append(
                {
                    "ref": node.get("ref", ""),
                    "pin": node.get("pin", ""),
                    "function": node.get("pinfunction", ""),
                    "type": node.get("pintype", ""),
                }
            )
        nodes.sort(key=lambda n: (_ref_sort_key(n["ref"]), n["pin"]))
        nets.append(
            {
                "name": net.get("name", ""),
                "code": int(net.get("code", "0")),
                "nodes": nodes,
            }
        )
    nets.sort(key=lambda n: n["name"])
    return nets


def parse_netlist(path: str | Path) -> dict:
    root = ET.parse(str(path)).getroot()
    source = _text(root.find("./design"), "source") if root.find("./design") is not None else ""
    return {
        "source": source,
        "components": parse_components(root),
        "nets": parse_nets(root),
    }


if __name__ == "__main__":
    import sys

    data = parse_netlist(sys.argv[1] if len(sys.argv) > 1 else "boards/stm32-good.net.xml")
    print(f"components: {len(data['components'])}")
    print(f"nets:       {len(data['nets'])}")
    for net in data["nets"]:
        if net["name"] == "/FB":
            print("/FB:", ", ".join(f"{n['ref']}.{n['pin']}" for n in net["nodes"]))

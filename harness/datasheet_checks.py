"""Rules that need a datasheet, kept apart from the ones that do not.

`harness/checks.py` takes a board and nothing else, which is what lets the page
run the identical rules in a browser with no network. These need a second input
- what the part's datasheet says - so they live here rather than widening that
signature and stranding the browser copy.

The point of the research agent is this file. A design brief pasted into a
reviewer's context is more surface to invent against; a datasheet number that
becomes a yes-or-no question about the netlist is free, exact, and right every
time. Every finding here carries the sentence from the datasheet that justifies
it, so the claim can be checked against the document rather than believed.
"""

from __future__ import annotations

from harness.checks import finding


def _nets_of_pin(board: dict, ref: str, function_prefix: str) -> list[str]:
    """Which nets the pins of `ref` whose library name starts with a prefix sit on."""
    out = []
    for net in board["nets"]:
        for node in net["nodes"]:
            if node["ref"] != ref:
                continue
            function = (node.get("function") or "").upper()
            if function.startswith(function_prefix.upper()):
                out.append(net["name"])
    return out


def _value_uf(value: str) -> float | None:
    """`0.1u` and `100n` in microfarads, or None when it is not a capacitance."""
    text = str(value or "").strip().lower().replace("µ", "u")
    for suffix, scale in (("u", 1.0), ("n", 1e-3), ("p", 1e-6)):
        if text.endswith(suffix):
            try:
                return float(text[:-1]) * scale
            except ValueError:
                return None
    try:  # a bare number in a capacitor's value field means microfarads
        return float(text)
    except ValueError:
        return None


def check_bootstrap_cap(board: dict, brief: dict) -> list[dict]:
    """The bootstrap capacitor the switcher's datasheet asks for, by value.

    The TPS563208 pin table says VBST is the "Supply input for the high-side
    NFET gate drive circuit. Connect 0.1 uF capacitor between" VBST and SW. That
    is a question about this netlist: is there a capacitor of that value with one
    pin on the part's VBST net and the other on its SW net?

    Quiet on the board as manufactured, where C4 is 0.1u bridging VBST and /SW.
    """
    out = []
    for ref, record in brief.items():
        fact = record.get("facts", {}).get("bootstrap_cap")
        if not fact:
            continue
        want_uf = fact["value"]["value_uf"]
        boot_nets = _nets_of_pin(board, ref, "VBST") or _nets_of_pin(board, ref, "BOOT")
        sw_nets = _nets_of_pin(board, ref, "SW")
        if not boot_nets or not sw_nets:
            continue

        values = {c["ref"]: c.get("value", "") for c in board["components"]}
        bridging = []
        for net in board["nets"]:
            if net["name"] not in boot_nets:
                continue
            for node in net["nodes"]:
                if not node["ref"].startswith("C"):
                    continue
                # The same capacitor, on one of the part's SW nets.
                for other in board["nets"]:
                    if other["name"] not in sw_nets:
                        continue
                    if any(n["ref"] == node["ref"] for n in other["nodes"]):
                        bridging.append(node["ref"])

        matched = [c for c in bridging if _value_uf(values.get(c, "")) == want_uf]
        if matched:
            continue

        if bridging:
            wrong = bridging[0]
            title = (
                f"{wrong} bridges {ref} VBST and SW but is {values.get(wrong, '?')}, "
                f"not the {want_uf} uF the datasheet asks for"
            )
            why = (
                f"The {record['part']} datasheet specifies the bootstrap capacitor value. "
                "Too small and the high-side gate drive collapses at duty cycles near "
                "maximum; too large and the rail takes longer to come up than the soft start."
            )
        else:
            title = f"{ref} has no bootstrap capacitor between VBST and SW"
            why = (
                f"The {record['part']} datasheet requires one. Without it the high-side "
                "NFET has no gate drive supply and the converter cannot switch."
            )
        out.append(
            finding(
                "datasheet-bootstrap-cap",
                title,
                f"{why} Datasheet says: \"{fact['quote'][:110]}\"",
                refs=[ref] + ([bridging[0]] if bridging else []),
                nets=sorted(set(boot_nets + sw_nets)),
                severity="critical",
                fix=f"Fit a {want_uf} uF capacitor between {ref} VBST and {ref} SW.",
            )
        )
    return out


DATASHEET_RULES = (check_bootstrap_cap,)


def run_datasheet_checks(board: dict, brief: dict) -> list[dict]:
    """Every datasheet-backed finding. Empty when no datasheet was readable."""
    if not brief:
        return []
    out = []
    for check in DATASHEET_RULES:
        out.extend(check(board, brief))
    return out

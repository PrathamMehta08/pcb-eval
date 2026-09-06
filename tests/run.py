"""The acceptance checks from PLAN.md section 10, one function per build step.

Run everything:            python -m tests.run
Run one step:              python -m tests.run 4
Run a range:               python -m tests.run 1-6

A step is not done until its check passes. This file is the contract the QA
agent runs; it is deliberately free of test-framework dependencies so it works
with nothing but the KiCad Python that ships with the board tools.
"""

from __future__ import annotations

import json
import math
import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from console import utf8  # noqa: E402

utf8()

BOARD_JSON = ROOT / "boards" / "stm32-good.json"
NET_XML = ROOT / "boards" / "stm32-good.net.xml"

_STEPS: dict[int, tuple[str, callable]] = {}


def step(number: int, title: str):
    def wrap(fn):
        _STEPS[number] = (title, fn)
        return fn

    return wrap


class Check:
    """Collects assertions so one failure does not hide the next."""

    def __init__(self) -> None:
        self.failures: list[str] = []
        self.notes: list[str] = []

    def that(self, ok: bool, message: str) -> bool:
        if not ok:
            self.failures.append(message)
        return ok

    def equals(self, got, want, label: str) -> bool:
        return self.that(got == want, f"{label}: got {got!r}, want {want!r}")

    def near(self, got: float, want: float, tol: float, label: str) -> bool:
        return self.that(
            abs(got - want) <= tol, f"{label}: got {got}, want {want} +/- {tol}"
        )

    def note(self, message: str) -> None:
        self.notes.append(message)


def load_board() -> dict:
    return json.loads(BOARD_JSON.read_text(encoding="utf-8"))


# --------------------------------------------------------------------------- 1


@step(1, "extract/netlist.py round-trips the real export")
def check_netlist(c: Check) -> None:
    from extract.netlist import parse_netlist

    data = parse_netlist(NET_XML)
    c.equals(len(data["components"]), 53, "component count")
    c.equals(len(data["nets"]), 62, "net count")

    fb = [n for n in data["nets"] if n["name"] == "/FB"]
    if c.equals(len(fb), 1, "/FB exists"):
        nodes = {f"{n['ref']}.{n['pin']}" for n in fb[0]["nodes"]}
        c.equals(nodes, {"R2.2", "R3.1", "S1.4"}, "/FB nodes")
        s1 = [n for n in fb[0]["nodes"] if n["ref"] == "S1"][0]
        c.equals(s1["function"], "VFB_4", "S1.4 pinfunction")

    by_ref = {comp["ref"]: comp for comp in data["components"]}
    c.equals(by_ref["S1"]["value"], "TPS563208DDCR", "S1 value")
    c.equals(by_ref["U2"]["value"], "STM32F103C8T6", "U2 value")
    c.that(all(comp["uuid"] for comp in data["components"]), "every component has a uuid")
    c.equals(len({comp["uuid"] for comp in data["components"]}), 53, "uuids are unique")
    c.that(
        "step-down" in by_ref["S1"]["description"],
        f"S1 description carried through: {by_ref['S1']['description'][:60]!r}",
    )
    c.note(f"{len(data['components'])} components, {len(data['nets'])} nets")


# --------------------------------------------------------------------------- 2


@step(2, "extract/layout.py parses the board geometry")
def check_layout(c: Check) -> None:
    from extract.layout import DEFAULT_PCB, parse_layout

    lay = parse_layout(DEFAULT_PCB)
    c.equals(len(lay["footprints"]), 53, "footprints")
    c.equals(sum(len(f["pads"]) for f in lay["footprints"]), 199, "pads")
    c.equals(len(lay["tracks"]), 400, "segments")
    c.equals(len(lay["vias"]), 63, "vias")
    c.equals(len(lay["zones"]), 5, "zones")
    c.near(lay["size"]["w"], 61.0, 0.1, "outline width mm")
    c.near(lay["size"]["h"], 46.0, 0.1, "outline height mm")

    # Board-relative: nothing may sit outside the outline box by more than a
    # footprint's own silkscreen overhang.
    xs = [f["x"] for f in lay["footprints"]]
    ys = [f["y"] for f in lay["footprints"]]
    c.that(min(xs) > -2 and max(xs) < lay["size"]["w"] + 2, "footprints inside board X")
    c.that(min(ys) > -2 and max(ys) < lay["size"]["h"] + 2, "footprints inside board Y")

    gnd_vias = [v for v in lay["vias"] if v["net"] == "GND"]
    c.that(len(gnd_vias) > 0, "GND vias exist on the good board")
    nets_on_tracks = {t["net"] for t in lay["tracks"]}
    c.that("GND" in nets_on_tracks, "GND is routed")
    c.note(
        f"origin {lay['origin']}, {len(gnd_vias)} GND vias, "
        f"{len(nets_on_tracks)} nets carry copper"
    )


# --------------------------------------------------------------------------- 3


@step(3, "extract/build.py writes boards/stm32-good.json")
def check_build(c: Check) -> None:
    from extract.build import DEFAULT_NET, build, round_floats
    from extract.layout import DEFAULT_PCB
    from extract.schematic import DEFAULT_SCH

    if not c.that(BOARD_JSON.exists(), f"{BOARD_JSON} exists"):
        return

    # Run the join for real. Reading the committed JSON alone would pass even
    # with `build()` sabotaged to raise on its first line.
    fresh = round_floats(build(DEFAULT_NET, Path(DEFAULT_PCB), Path(DEFAULT_SCH)))
    board = load_board()
    for key in ("components", "nets", "layout"):
        c.equals(
            json.dumps(fresh[key], sort_keys=True),
            json.dumps(board[key], sort_keys=True),
            f"committed JSON is current for {key} (rerun: python -m extract.build)",
        )
    c.equals(len(board["components"]), 53, "components")
    c.equals(len(board["nets"]), 62, "nets")

    fps = board["layout"]["footprints"]
    c.equals(len(fps), 53, "footprints")
    resolved = [f for f in fps if f.get("ref")]
    c.equals(len(resolved), 53, "footprints resolved to a netlist ref")

    refs = {comp["ref"] for comp in board["components"]}
    c.equals({f["ref"] for f in fps}, refs, "footprint refs match component refs")

    # The gotcha this join exists for: silkscreen labels are not designators.
    renamed = [f for f in fps if f["silk"] != f["ref"]]
    c.that(
        len(renamed) >= 10,
        f"the silkscreen-label trap is real: {len(renamed)} footprints renamed",
    )

    for comp in board["components"]:
        if comp["ref"].startswith(("R", "C", "U", "S", "J")):
            if not c.that("sheet" in comp, f"{comp['ref']} has schematic coordinates"):
                break
    c.note(f"{len(renamed)} footprints carry a silkscreen label, not a designator")

    # place() is the transform every view and every copper check rests on.
    # These are KiCad's own plotted pad centres out of layer-F_Cu.svg, in
    # board-relative millimetres.
    from extract.layout import place

    golden = {
        ("U1", "1"): (48.100, 31.100),
        ("U1", "2"): (45.800, 31.100),
        ("U1", "3"): (43.500, 31.100),
        ("C2", "1"): (51.300, 36.100),
        ("R1", "1"): (55.210, 30.200),
        ("Y1", "1"): (19.500, 10.950),
    }
    fp_by_ref = {f["ref"]: f for f in fps}
    for (ref, pin), (want_x, want_y) in golden.items():
        fp = fp_by_ref[ref]
        pad = next((p for p in fp["pads"] if p["num"] == pin), None)
        if not c.that(pad is not None, f"{ref} has a pad {pin}"):
            continue
        dx, dy = place(pad["x"], pad["y"], fp["rot"])
        got = (fp["x"] + dx, fp["y"] + dy)
        c.that(
            math.dist(got, (want_x, want_y)) <= 0.02,
            f"place() puts {ref}.{pin} at {got[0]:.3f}, {got[1]:.3f}; "
            f"KiCad plots it at {want_x}, {want_y}",
        )


# --------------------------------------------------------------------------- 4


@step(4, "harness/ops.py applies and reverses every preset")
def check_ops(c: Check) -> None:
    from harness.ops import apply_edits, board_hash, undo
    from harness.presets import PRESETS, edits_for

    board = load_board()
    original = board_hash(board)
    c.equals(len(PRESETS), 7, "preset count")

    for preset in PRESETS:
        work = json.loads(json.dumps(board))
        edits = edits_for(preset, work)
        c.that(len(edits) > 0, f"{preset['id']}: has at least one edit")
        log = apply_edits(work, edits)
        c.equals(len(log), len(edits), f"{preset['id']}: every edit applied")
        changed = board_hash(work)
        c.that(changed != original, f"{preset['id']}: board hash changed")
        while log:
            undo(work, log)
        c.equals(board_hash(work), original, f"{preset['id']}: undo restores the board")


# --------------------------------------------------------------------------- 5


@step(5, "harness/checks.py trips on every preset and stays quiet on the clean board")
def check_detectors(c: Check) -> None:
    from harness.checks import run_checks
    from harness.ops import apply_edits
    from harness.presets import PRESETS, edits_for

    clean = load_board()
    findings = run_checks(clean)
    c.equals(
        [f["rule"] for f in findings], [], f"clean board trips nothing: {findings}"
    )

    for preset in PRESETS:
        work = json.loads(json.dumps(clean))
        apply_edits(work, edits_for(preset, work))
        rules = {f["rule"] for f in run_checks(work)}
        c.that(
            preset["rule"] in rules,
            f"{preset['id']}: expected rule {preset['rule']!r}, got {sorted(rules)}",
        )


# --------------------------------------------------------------------------- 6


@step(6, "harness/distill.py fits the budget without losing anything")
def check_distill(c: Check) -> None:
    from harness.distill import approx_tokens, distill

    board = load_board()
    text = distill(board)
    tokens = approx_tokens(text)
    c.that(tokens < 3000, f"distilled board is {tokens} tokens, want < 3000")

    for comp in board["components"]:
        if not c.that(comp["ref"] in text, f"{comp['ref']} present in distilled board"):
            break
    for net in board["nets"]:
        if net["name"].startswith("unconnected-"):
            # These collapse into one section: the net name is derivable from
            # the pin, and 25 of them cost 400 tokens to say nothing.
            node = net["nodes"][0]
            ok = c.that(
                f"{node['ref']}.{node['pin']}" in text,
                f"unconnected pin {node['ref']}.{node['pin']} present",
            )
        else:
            ok = c.that(net["name"] in text, f"net {net['name']} present")
        if not ok:
            break
    for ref in ("TPS563208DDCR", "STM32F103C8T6", "AMS1117-3.3"):
        c.that(ref in text, f"value {ref} present")
    c.note(f"{tokens} tokens, {len(text)} characters")


# --------------------------------------------------------------------------- 8


@step(8, "site/ops.js and site/distill.js match the Python on the shared fixtures")
def check_ops_parity(c: Check) -> None:
    import shutil
    import subprocess

    fixture = ROOT / "tests" / "fixtures" / "ops.json"
    if not c.that(
        fixture.exists(),
        "tests/fixtures/ops.json exists (regenerate: python -m tests.fixture)",
    ):
        return

    from harness.ops import apply_edits, board_hash

    cases = json.loads(fixture.read_text(encoding="utf-8"))
    board = load_board()
    for case in cases["cases"]:
        work = json.loads(json.dumps(board))
        apply_edits(work, case["edits"])
        c.equals(board_hash(work), case["hash"], f"python {case['id']} hash")

    node = shutil.which("node") or r"C:\Program Files\nodejs\node.exe"
    if not Path(node).exists():
        c.note("node not found; skipped the browser half of the parity check")
        return
    for script in ("ops_parity.mjs", "distill_parity.mjs"):
        proc = subprocess.run(
            [node, str(ROOT / "tests" / script)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            cwd=str(ROOT),
        )
        report = (proc.stdout + proc.stderr).strip()
        if c.that(proc.returncode == 0, f"{script}:\n{report}"):
            c.note(report.splitlines()[-1] if report else f"{script} ok")


# ---------------------------------------------------------------------------


def run(numbers: list[int]) -> int:
    failed = 0
    for number in numbers:
        if number not in _STEPS:
            print(f"  ?  step {number}: no check defined yet")
            continue
        title, fn = _STEPS[number]
        c = Check()
        try:
            fn(c)
        except Exception:
            c.failures.append("raised:\n" + traceback.format_exc())
        mark = "PASS" if not c.failures else "FAIL"
        print(f"[{mark}] step {number}  {title}")
        for note in c.notes:
            print(f"       . {note}")
        for failure in c.failures:
            print(f"       x {failure}")
        failed += bool(c.failures)
    print()
    print(f"{len(numbers) - failed}/{len(numbers)} steps pass")
    return 1 if failed else 0


def parse_selection(args: list[str]) -> list[int]:
    if not args:
        return sorted(_STEPS)
    out: list[int] = []
    for arg in args:
        if "-" in arg:
            lo, hi = arg.split("-")
            out += [n for n in range(int(lo), int(hi) + 1) if n in _STEPS]
        else:
            out.append(int(arg))
    return out


if __name__ == "__main__":
    raise SystemExit(run(parse_selection(sys.argv[1:])))

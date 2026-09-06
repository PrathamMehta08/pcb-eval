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
import re
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


@step(6, "harness/distill.py fits the budget on every board without losing anything")
def check_distill(c: Check) -> None:
    from harness.distill import approx_tokens, distill
    from harness.ops import apply_edits
    from harness.presets import PRESETS, edits_for

    clean = load_board()
    boards = [("clean", clean)]
    for preset in PRESETS:
        work = json.loads(json.dumps(clean))
        apply_edits(work, edits_for(preset, work))
        boards.append((preset["id"], work))

    # Every board in the corpus, not one board with the default arguments: the
    # earlier version of this measured a string nothing ever sent, and six of
    # the eight the harness really sent were over the cap.
    worst = 0
    for name, board in boards:
        text = distill(board)
        tokens = approx_tokens(text)
        worst = max(worst, tokens)
        c.that(tokens < 3000, f"{name} distils to {tokens} tokens, want under 3000")

    text = distill(clean)
    for comp in clean["components"]:
        if not c.that(has_token(text, comp["ref"]), f"{comp['ref']} present in the distilled board"):
            break
        if not c.that(has_token(text, comp["value"]), f"{comp['ref']}'s value {comp['value']!r} present"):
            break
    for net in clean["nets"]:
        if net["name"].startswith("unconnected-"):
            node = net["nodes"][0]
            ok = c.that(
                has_token(text, f"{node['ref']}.{node['pin']}"),
                f"unconnected pin {node['ref']}.{node['pin']} present",
            )
        else:
            ok = c.that(has_token(text, net["name"]), f"net {net['name']} present")
        if not ok:
            break

    # And prove the containment test can fail. A plain `in` could not: "C1" is a
    # substring of "C11", so a board that had lost C1 entirely still passed.
    for haystack, needle, want, why in (
        ("C11,C12,C13 100n 0402", "C1", False, "C1 is not found inside C11"),
        ("GND: C1.2 C11.2", "C1", True, "C1 is found as the owner of pad C1.2"),
        ("+3.3VA 4 1 13 0.30", "+3.3V", False, "+3.3V is not found inside +3.3VA"),
        ("/STEPPER_IN1: R8.2", "/STEPPER_IN1", True, "a net name is found whole"),
        ("/STEPPER_IN12: R8.2", "/STEPPER_IN1", False, "and not as a prefix of a longer one"),
    ):
        c.equals(has_token(haystack, needle), want, why)
    c.note(f"worst board {worst} tokens, {len(boards)} boards measured")


def has_token(text: str, token: str) -> bool:
    """`C1` must not be found inside `C11`, and `+3.3V` not inside `+3.3VA`."""
    if not token:
        return True
    return bool(
        re.search(
            r"(?<![A-Za-z0-9_.])" + re.escape(token) + r"(?![A-Za-z0-9_])",
            text,
        )
    )


# --------------------------------------------------------------------------- 8


@step(8, "the browser modules match the Python: ops, distiller, and the KiCad reader")
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

    # The Python half only proves the committed fixture is current — it was
    # generated by this same code, so it cannot check the hash is right. What
    # makes it a parity test is the node run below, which is an independent
    # implementation reading the same fixture.
    cases = json.loads(fixture.read_text(encoding="utf-8"))
    board = load_board()
    for case in cases["cases"]:
        work = json.loads(json.dumps(board))
        log = apply_edits(work, case["edits"])
        c.equals(board_hash(work), case["hash"], f"{case['id']}: fixture is stale, rerun tests.fixture")
        c.equals(
            [entry["label"] for entry in log],
            case["labels"],
            f"{case['id']}: edit-log labels match the fixture",
        )

    run_node(c, "ops_parity.mjs", "distill_parity.mjs", "kicad_parity.mjs")


def run_node(c: Check, *scripts: str) -> None:
    """Run browser-side checks under node and fold their output into this one."""
    import shutil
    import subprocess

    node = shutil.which("node") or r"C:\Program Files\nodejs\node.exe"
    if not Path(node).exists():
        c.note("node not found; skipped the browser-side checks")
        return
    for script in scripts:
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


def built_page(c: Check) -> str | None:
    page = ROOT / "dist" / "pcb-eval.html"
    if not c.that(page.exists(), "dist/pcb-eval.html exists (build: python tools/build_site.py)"):
        return None
    return page.read_text(encoding="utf-8")


# --------------------------------------------------------------------------- 7


@step(7, "site/render.js draws all three views from the board, on KiCad's own geometry")
def check_render(c: Check) -> None:
    run_node(c, "render_parity.mjs")

    page = built_page(c)
    if page is None:
        return
    for marker, label in (
        ('data-view="schematic"', "the schematic tab"),
        ('data-view="layout"', "the layout tab"),
        ('data-view="routing"', "the routing tab"),
        ("renderSchematic", "the schematic renderer"),
        ("renderBoard", "the layout and routing renderer"),
        ("attachPanZoom", "pan and zoom"),
    ):
        c.that(marker in page, f"the built page carries {label}")

    # The schematic view is KiCad's own plot nested inside ours, so the plot
    # has to actually be in the file rather than merely referenced.
    paths = page.count("<path")
    c.that(paths > 15000, f"KiCad's schematic plot is inlined: {paths} paths")

    board = load_board()
    c.that(
        f'"{board["layout"]["tracks"][0]["id"]}"' in page,
        "the board data is inlined, with the track ids the edit log needs",
    )
    size = len(page.encode("utf-8")) / 1024 / 1024
    c.that(size < 16, f"the page is {size:.2f} MB, under the 16 MB artifact budget")
    c.note(f"{size:.2f} MB, {paths} schematic paths")


# --------------------------------------------------------------------------- 9


@step(9, "the editing UI records every change and undo restores the board")
def check_editing(c: Check) -> None:
    # edit_cycle.mjs drives the three edits this step names through the modules
    # the page calls. pointer.mjs drives the event sequence a browser sends,
    # because the two are not the same thing: every operation had a control and
    # none of them could be reached, since pointer capture retargeted the click
    # to the SVG root and the selection was cleared in the same gesture.
    run_node(c, "edit_cycle.mjs", "pointer.mjs", "divergence.mjs")


# -------------------------------------------------------------------------- 10


@step(10, "site/review.js returns findings, caches them, and enforces the limits")
def check_review(c: Check) -> None:
    run_node(c, "review_limits.mjs")

    page = built_page(c)
    if page is None:
        return
    # Requirement four from PLAN.md section 5.4: never on load. The only call
    # site must be the button's handler.
    c.that(
        page.count("sample.json(") == 1,
        "there is exactly one place that calls Claude",
    )
    c.that(
        'id("go").addEventListener("click", runReview)' in page.replace("$(", "id("),
        "the only path to it is an explicit click",
    )
    c.that("getSample()" in page, "the capability is resolved, not assumed")


# -------------------------------------------------------------------------- 11


@step(11, "the built page is publishable as an Artifact")
def check_publishable(c: Check) -> None:
    page = built_page(c)
    if page is None:
        return

    # The host wraps the file in its own doctype, head and body, so the file
    # must not bring those.
    for tag in ("html", "head", "body"):
        c.that(
            not re.search(rf"<{tag}(?:\s|>)", page, re.I),
            f"the file does not carry its own <{tag}> tag",
        )
    c.that("<!doctype" not in page.lower(), "and no doctype")
    c.that("<title>" in page, "it has a <title>, which names it in the gallery")
    size = len(page.encode("utf-8")) / 1024 / 1024
    c.that(size < 16, f"{size:.2f} MB, under the 16 MB budget")

    # The artifact CSP blocks every external host but a short list, and blocks
    # stylesheets and fetches even on the allowed ones. Everything this page
    # needs beyond the Google Fonts stylesheet is inlined.
    external = set(re.findall(r'(?:src|href)="(https?://[^"]+)"', page))
    allowed = ("https://fonts.googleapis.com/",)
    for url in external:
        c.that(url.startswith(allowed), f"external reference not on the CSP allowlist: {url}")
    c.that(
        "fonts.googleapis.com" in page,
        "the one external reference is the Google Fonts stylesheet",
    )
    # Other http:// strings do appear — SVG namespaces, and the datasheet URLs
    # the netlist carries for each part. Neither is fetched; they are inert text
    # inside the board data, which is why this looks at src and href only.

    # The capability the review needs, and the promise that nothing calls it on
    # load. Both are the difference between a page that costs a viewer nothing
    # to open and one that does not.
    c.that('claude.use("sample")' in page, "it resolves the sample capability")
    c.that(page.count("sample.json(") == 1, "there is exactly one call site")
    c.note(f"{size:.2f} MB, {len(external)} external references")


# -------------------------------------------------------------------------- 12


class StubClient:
    """A Claude that says what the test tells it to, and counts the asking.

    The graph's wiring, its gate and its contradiction check are all decidable
    without a network. Only the quality of the findings needs a real model, and
    that is what harness/run.py measures.
    """

    def __init__(self, replies: dict) -> None:
        self.replies = replies
        self.labels: list[str] = []

    def json(self, prompt: str, label: str = "", system: str = ""):
        self.labels.append(label)
        node = label.split("/")[0]
        return self.replies.get(node, {"findings": []}), {
            "tokens_in": 0, "tokens_out": 0, "seconds": 0.0, "cached": False, "text": "",
        }


@step(12, "the review graph runs end to end, and the gate stops on measurements")
def check_graph(c: Check) -> None:
    from graph.build import MAX_PASSES, run_graph
    from harness.ops import apply_edits
    from harness.presets import BY_ID, edits_for

    clean = load_board()

    # A clean board gives the rules nothing to chase, so one pass and stop.
    client = StubClient({})
    state = run_graph(json.loads(json.dumps(clean)), client)
    c.equals(state["stopped"], "stop:nothing-to-chase", "clean board stops immediately")
    c.equals(state["passes"], 1, "and does it in one pass")
    c.equals(
        [label.split("/")[0] for label in client.labels],
        ["datasheet", "connections", "layout"],
        "every reviewer node ran",
    )

    broken = json.loads(json.dumps(clean))
    apply_edits(broken, edits_for(BY_ID["ground-stranded"], broken))

    # A rule fires and nothing the model says accounts for it: loop, then give up
    # rather than declare the board fine. The gate must never take the model's
    # word for being finished.
    client = StubClient({"datasheet": {"findings": [
        {"title": "unrelated", "refs": ["R4"], "nets": [], "severity": "minor", "why": ""}
    ]}})
    state = run_graph(json.loads(json.dumps(broken)), client)
    c.equals(state["stopped"], "stop:passes-spent", "an unaccounted rule sends it round again")
    c.equals(state["passes"], MAX_PASSES, f"and it stops after {MAX_PASSES} passes")

    # A finding that overlaps the rule's own refs and nets ends it after one.
    client = StubClient({"layout": {"findings": [
        {"title": "GND is in pieces", "refs": [], "nets": ["GND"], "severity": "critical", "why": ""}
    ]}})
    state = run_graph(json.loads(json.dumps(broken)), client)
    c.equals(state["stopped"], "stop:rules-accounted-for", "a matching finding ends the loop")
    c.equals(state["passes"], 1, "in one pass")

    # And the board throws out what it can refute, with no model consulted.
    client = StubClient({"datasheet": {"findings": [
        {"title": "U9 is wrong", "refs": ["U9"], "nets": [], "severity": "major", "why": ""},
        {"title": "GND is stranded", "refs": [], "nets": ["GND"], "severity": "critical", "why": ""},
        {"title": "+3.3V is stranded", "refs": [], "nets": ["+3.3V"], "severity": "major", "why": ""},
    ]}})
    state = run_graph(json.loads(json.dumps(broken)), client)
    dropped = {item["title"]: item["dropped"] for item in state["dropped"]}
    c.that("U9 is wrong" in dropped, f"a part that does not exist is refuted: {dropped}")
    c.that(
        "+3.3V is stranded" in dropped,
        "a net the copper says is one piece is refuted",
    )
    c.that(
        "GND is stranded" not in dropped,
        "and the one the copper agrees with survives",
    )
    c.note(f"gate reasons exercised: nothing-to-chase, passes-spent, rules-accounted-for")


# -------------------------------------------------------------------------- 13


@step(13, "harness/run.py leaves a result stamped with all three hashes")
def check_sweep(c: Check) -> None:
    from graph.prompts import prompt_hash
    from harness.grade import corpus_hash, schema_hash
    from harness.run import corpus
    from harness.ops import board_hash

    latest = ROOT / "results" / "latest.json"
    if not c.that(latest.exists(), "results/latest.json exists (run: python -m harness.run)"):
        return
    result = json.loads(latest.read_text(encoding="utf-8"))

    for key in ("prompt_hash", "schema_hash", "corpus_hash"):
        c.that(bool(result.get(key)), f"the result carries a {key}")
    c.equals(result["prompt_hash"], prompt_hash(), "prompt hash is current (prompts changed since the sweep?)")
    c.equals(result["schema_hash"], schema_hash(), "schema hash is current")

    cases = corpus()
    c.equals(len(cases), 8, "eight boards: one clean and seven seeded")
    c.equals(
        result["corpus_hash"],
        corpus_hash([board_hash(case["board"]) for case in cases] * 2),
        "corpus hash is current (the seeded boards changed since the sweep?)",
    )

    detectors = {row["detector"] for row in result["rows"]}
    c.equals(detectors, {"single", "graph"}, "both detectors ran")
    c.equals(len(result["rows"]), 16, "eight boards times two detectors")
    for row in result["rows"]:
        if not c.that("grade" in row, f"{row['board']} was graded"):
            break
    clean_rows = [r for r in result["rows"] if not r["defects"]]
    c.equals(len(clean_rows), 2, "the clean board was run under both detectors")

    # The refutation count is the one number here that needs no judgement, so
    # it has to be present rather than optional.
    for row in result["rows"]:
        if not c.that(
            "refuted_reported" in row and "refuted_proposed" in row,
            f"{row['detector']}/{row['board']} was checked against the copper "
            "(rerun: python -m harness.run)",
        ):
            break
    c.note(
        " · ".join(
            f"{name} {t['caught']}/{t['of']}, {t['false_alarms_on_clean']} on clean"
            for name, t in result["totals"].items()
        )
        + " · "
        + " ".join(
            f"{name} refutes {t['refuted_reported']}/{t['refuted_proposed']}"
            for name, t in result["totals"].items()
        )
        + f" · ${result['cost']['dollars']} cold"
    )


# -------------------------------------------------------------------------- 14


@step(14, "the README quotes the sweep that is actually in the repository")
def check_readme(c: Check) -> None:
    readme = ROOT / "README.md"
    if not c.that(readme.exists(), "README.md exists"):
        return
    # Emphasis markers sit between the number and the cell wall, so compare
    # against the prose rather than the markup.
    text = readme.read_text(encoding="utf-8").replace("*", "").replace("`", "")
    latest = ROOT / "results" / "latest.json"
    if not c.that(latest.exists(), "results/latest.json exists"):
        return
    result = json.loads(latest.read_text(encoding="utf-8"))

    # A README carrying last week's numbers is worse than one carrying none.
    for key in ("prompt_hash", "schema_hash", "corpus_hash"):
        c.that(result[key] in text, f"the README quotes the result's {key} ({result[key]})")
    for name, t in result["totals"].items():
        c.that(
            f"{t['caught']} of {t['of']}" in text or f"| {t['caught']} |" in text,
            f"the README quotes {name}'s recall, {t['caught']} of {t['of']}",
        )
        c.that(
            f"{t['refuted_reported']} |" in text or f"reported {t['refuted_reported']}" in text,
            f"the README quotes {name}'s refuted-and-reported count, {t['refuted_reported']}",
        )
    c.that("what a netlist cannot see" in text.lower(), "the README says what a netlist cannot see")
    dollars = result["cost"]["dollars"]
    c.that(
        any(form in text for form in (str(dollars), f'{dollars:.3f}', f'{dollars:.2f}')),
        f'the README quotes what a run costs (${dollars})',
    )


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

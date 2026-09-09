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
    from harness.generators import GENERATORS, defects_for
    from harness.ops import apply_edits, board_hash, undo

    from harness.run import BOARDS, _load

    c.equals(len(GENERATORS), 10, "ten defect generators")

    presets = [
        (name, defect)
        for name in BOARDS
        for defect in defects_for(_load(name), name)
    ]
    c.that(presets, "the generators produce at least one defect")
    for name, preset in presets:
        board = _load(name)
        original = board_hash(board)
        work = json.loads(json.dumps(board))
        edits = preset["edits"]
        c.that(len(edits) > 0, f"{preset['id']}: has at least one edit")
        log = apply_edits(work, edits)
        c.equals(len(log), len(edits), f"{preset['id']}: every edit applied")
        changed = board_hash(work)
        c.that(changed != original, f"{preset['id']}: board hash changed")
        while log:
            undo(work, log)
        c.equals(board_hash(work), original, f"{preset['id']}: undo restores the board")


# --------------------------------------------------------------------------- 5


@step(5, "harness/checks.py stays silent on boards that are not broken")
def check_detectors(c: Check) -> None:
    """The contract is silence on a clean board, and nothing more.

    It used to be two-sided: every preset had to trip a named rule of its own.
    That pairing is what made the rules an answer key rather than a detector, so
    the requirement is gone and what is left is a measurement. The seeded
    defects here were chosen without reference to any rule, and how many the
    rules happen to catch is reported rather than asserted.
    """
    from harness.checks import run_checks
    from harness.run import corpus

    cases = corpus()
    clean = [case for case in cases if not case["defects"]]
    c.equals(len(clean), 2, "two clean boards, from two different designers")
    for case in clean:
        findings = run_checks(case["board"])
        c.equals(
            [f["rule"] for f in findings],
            [],
            f"{case['id']} trips nothing: {[f['title'] for f in findings]}",
        )

    # The count is not asserted. Defects are generated by searching each board
    # for a site, so the corpus size is a property of the boards rather than a
    # number to pin. What is asserted is that every board contributed something
    # and that every generator that fired produced a distinct case.
    seeded = [case for case in cases if case["defects"]]
    c.that(len(seeded) >= len(clean), f"every board yields at least one defect ({len(seeded)})")
    c.equals(len({case["id"] for case in seeded}), len(seeded), "defect ids are unique")
    from harness.generators import GENERATORS

    fired = {case["defects"][0]["generator"] for case in seeded}
    c.that(
        fired <= {g["id"] for g in GENERATORS},
        "every seeded defect came from a registered generator",
    )
    c.note(f"{len(seeded)} defects from {len(fired)} of {len(GENERATORS)} generators")
    hit = [case["id"] for case in seeded if run_checks(case["board"])]
    c.note(
        f"rules fire on {len(hit)} of {len(seeded)} held-out defects"
        + (f": {', '.join(hit)}" if hit else "")
    )


# --------------------------------------------------------------------------- 6


@step(6, "harness/distill.py fits the budget on every board without losing anything")
def check_distill(c: Check) -> None:
    from harness.distill import approx_tokens, distill
    from harness.ops import apply_edits

    from harness.run import corpus

    boards = [(case["id"], case["board"]) for case in corpus()]

    # Every board in the corpus, not one board with the default arguments: the
    # earlier version of this measured a string nothing ever sent, and six of
    # the eight the harness really sent were over the cap.
    worst = 0
    for name, board in boards:
        text = distill(board)
        tokens = approx_tokens(text)
        worst = max(worst, tokens)
        c.that(tokens < 3000, f"{name} distils to {tokens} tokens, want under 3000")

    clean = load_board()
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


@step(7, "site/render.js draws the board from KiCad's own geometry")
def check_render(c: Check) -> None:
    run_node(c, "render_parity.mjs")

    page = built_page(c)
    if page is None:
        return
    for marker, label in (
        ('data-view="routing"', "the board tab"),
        ('data-view="review"', "the review tab"),
        ("renderBoard", "the board renderer"),
        ("attachPanZoom", "pan and zoom"),
    ):
        c.that(marker in page, f"the built page carries {label}")

    # There were three views. The schematic was KiCad's own 1.2 MB plot, which
    # cannot be produced for a board someone uploads, and the bare layout was
    # the routing view with the copper switched off. Both are gone, and the
    # renderers with them — so assert their absence, or they creep back.
    for gone, why in (
        ("renderSchematic", "the schematic renderer"),
        ('data-view="layout"', "the bare layout tab"),
    ):
        c.that(gone not in page, f"{why} is gone, not merely unreachable")

    board = load_board()
    c.that(
        f'"{board["layout"]["tracks"][0]["id"]}"' in page,
        "the board data is inlined, with the track ids the edit log needs",
    )
    size = len(page.encode("utf-8")) / 1024 / 1024
    c.that(size < 16, f"the page is {size:.2f} MB, under the 16 MB artifact budget")
    c.note(f"{size:.2f} MB")


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


@step(11, "the built page stands on its own as a hosted file")
def check_publishable(c: Check) -> None:
    page = built_page(c)
    if page is None:
        return

    # It began life as an Artifact, where the host supplied the document shell
    # and the file had to bring none of it. Hosted, nothing supplies it, and a
    # file without a charset is served as whatever the host guesses — which
    # turns every arrow and middle dot in the interface to mojibake.
    c.that(page.lstrip().lower().startswith("<!doctype html>"), "it opens with a doctype")
    for tag in ("html", "head", "body"):
        c.that(re.search(rf"<{tag}(?:\s|>)", page, re.I), f"it carries its own <{tag}> tag")
    c.that(
        re.search(r'<meta\s+charset=["\']?utf-8', page, re.I),
        "it declares utf-8, so the box-drawing and arrows survive",
    )
    c.that("<title>" in page, "it has a <title>")
    size = len(page.encode("utf-8")) / 1024 / 1024
    c.that(size < 16, f"{size:.2f} MB")

    # Everything but the font stylesheet is inlined, so the page holds up on a
    # slow link and has nothing to leak a visitor to.
    external = set(re.findall(r'(?:src|href)="(https?://[^"]+)"', page))
    allowed = ("https://fonts.googleapis.com/",)
    for url in external:
        c.that(url.startswith(allowed), f"unexpected external reference: {url}")
    c.that(
        "fonts.googleapis.com" in page,
        "the one external reference is the Google Fonts stylesheet",
    )
    # Other http:// strings do appear — SVG namespaces, and the datasheet URLs
    # the netlist carries for each part. Neither is fetched; they are inert text
    # inside the board data, which is why this looks at src and href only.

    # The review reaches the model through the serverless proxy, never directly.
    # A key in this file would be readable by anyone who opened it.
    c.that('fetch("/api/review"' in page, "the review calls the proxy")
    c.that("window.claude" not in page, "nothing depends on the artifact runtime")
    c.that(
        not re.search(r"\b(gsk_|sk-)[A-Za-z0-9]{16}", page),
        "no API key is baked into the page",
    )
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
    # The page runs its own copy of the graph, because only the browser holds
    # the board as the visitor just broke it. Both are checked here, against the
    # same four situations, so the two cannot drift on the thing that matters:
    # what makes the loop go round, and what makes it stop.
    run_node(c, "graph_browser.mjs")

    # No prompt may name anything that belongs to one board.
    #
    # The prompts used to open with "a two-layer STM32F103 controller for a pill
    # dispenser: a TPS563208 buck converter..." and the reviewer jobs named the
    # exact conventions two seeded defects break - a servo lead's pin order, an
    # HC-SR04's pin order - plus the buck's 3 A rating. That is teaching to the
    # test, and it was also simply wrong for anyone reviewing their own board on
    # the page. Everything a review needs about a board now arrives in the
    # distilled board itself, so this asserts the prompts stay empty of it.
    from graph.prompts import (
        BOARD_SLOT,
        circuit_prompt,
        physical_prompt,
        single_prompt_template,
    )

    board = load_board()
    heads = {
        "single": single_prompt_template().split(BOARD_SLOT)[0],
        "circuit": circuit_prompt(BOARD_SLOT).split(BOARD_SLOT)[0],
        "physical": physical_prompt(BOARD_SLOT).split(BOARD_SLOT)[0],
    }
    # Values, refs and net names from this board. Short tokens are skipped:
    # "IN" and "SW" are real net names here and ordinary English elsewhere.
    board_words = {c["value"] for c in board["components"] if len(c["value"]) >= 4}
    board_words |= {n["name"].lstrip("/") for n in board["nets"] if len(n["name"].lstrip("/")) >= 4}
    # Part families that named this design rather than any design.
    board_words |= {"HC-SR04", "STM32", "pill dispenser", "barrel jack", "servo lead"}
    # Designators are short - S1, R4, U2 - so a length cutoff misses them, and
    # the first version of this check did: the schema's own example carried
    # "S1" and "/FB" straight from this board. They are distinctive enough to
    # match on a word boundary instead, at any length.
    refs = {c["ref"] for c in board["components"]}
    short_nets = {n["name"].lstrip("/") for n in board["nets"] if len(n["name"].lstrip("/")) < 4}
    for name, head in heads.items():
        leaked = sorted(w for w in board_words if w.lower() in head.lower())
        leaked += sorted(
            w for w in refs | short_nets if re.search(rf"{re.escape(w)}", head)
        )
        c.that(not leaked, f"the {name} prompt names nothing board-specific: {sorted(set(leaked))}")

    # The typed claim, its subject, and the critic that reads them.
    from graph.state import normalise_subject
    from graph.verify import facts, verify
    from harness.distill import distill

    # Reviewers name pins, not parts: `S1.4`, `S1.6(VBST)`, `U3.8`. Read
    # literally those are parts that do not exist, and the critic throws the
    # finding out for a formatting habit. That is not hypothetical - it deleted
    # the real defect on vfb-vbst-swap the first time this field was wired up.
    for raw, want in (
        ("S1.4", "S1"),
        ("S1.6(VBST)", "S1"),
        ("U2.44(BOOT0,in)", "U2"),
        ("S1", "S1"),
        ("/FB", "/FB"),
        ("GND", "GND"),
        # A real net name that contains brackets has to survive whole.
        ("unconnected-(J12-Pad3)", "unconnected-(J12-Pad3)"),
    ):
        c.equals(normalise_subject(raw), want, f"subject {raw!r} normalises to {want!r}")

    clean = load_board()
    f = facts(clean)
    distilled = distill(clean)
    real_line = "R3,R4,R8,R9,R10,R11 10k 0402"
    c.that(real_line in distilled, "the evidence line used below is really in the board")

    for label, item, refuted in (
        (
            "a net the copper says is one piece",
            {"claim": "net_split", "subject": "GND", "nets": ["GND"], "title": "GND is in pieces", "evidence": real_line},
            True,
        ),
        (
            "a value that can be ordered",
            {"claim": "value_unbuildable", "subject": "R4", "refs": ["R4"], "title": "R4 has no value", "evidence": real_line},
            True,
        ),
        (
            "a part claimed missing that is present",
            {"claim": "missing_component", "subject": "U2", "refs": ["U2"], "title": "U2 is absent from the board", "evidence": real_line},
            True,
        ),
        (
            "a subject that is not on the board",
            {"claim": "pin_miswired", "subject": "U9", "refs": ["U9"], "title": "U9 miswired", "evidence": real_line},
            True,
        ),
        (
            "evidence that appears nowhere in the board",
            {"claim": "pin_miswired", "subject": "S1", "refs": ["S1"], "title": "FB on VBST", "evidence": "S1 pin 4 measured 3.7 V under load"},
            True,
        ),
        (
            "a kind no measurement settles",
            {"claim": "pin_floating", "subject": "U3", "refs": ["U3"], "title": "U3.4 floats", "evidence": real_line},
            False,
        ),
    ):
        why = verify(item, f, distilled)
        c.that(bool(why) == refuted, f"the critic {'refutes' if refuted else 'passes'} {label}: {why or 'passed'}")

    # The critic and the grader must not be the same function. If a stricter
    # critic also graded, a new architecture would beat the old one by moving
    # the ruler rather than by finding more.
    import graph.verify as V
    from harness.grade import refuted as graded
    c.that(V.verify is not V.contradiction, "the critic is not the grader")
    c.that(callable(graded), "grading still goes through harness.grade.refuted")

    # Manufacturability is measured, and silent on a board that is buildable.
    from harness.dfm import run_dfm
    c.equals(len(run_dfm(clean)), 0, "no DFM finding on the board as manufactured")

    from graph.build import MAX_PASSES, run_graph
    from graph.prompts import REVIEWERS
    from harness.ops import apply_edits
    from harness.generators import defects_for

    clean = load_board()

    # A clean board gives the rules nothing to chase, so one pass and stop.
    client = StubClient({})
    state = run_graph(json.loads(json.dumps(clean)), client, inputs={})
    c.equals(state["stopped"], "stop:nothing-to-chase", "clean board stops immediately")
    c.equals(state["passes"], 1, "and does it in one pass")
    c.equals(
        [label.split("/")[0] for label in client.labels],
        sorted(REVIEWERS),
        "with no assumptions, only the always-on reviewers run",
    )

    # A board with a copper defect, taken from the generators rather than
    # written out here, and the net it actually breaks read back from the rule
    # that fires. Naming a net directly is what made this block fail the moment
    # a generator picked a different site.
    from harness.checks import run_checks

    broken = json.loads(json.dumps(clean))
    reversed_part = next(
        d for d in defects_for(broken, "stm32-good") if d["generator"] == "part-reversed"
    )
    apply_edits(broken, reversed_part["edits"])
    islands_found = [f for f in run_checks(broken) if f["rule"] == "net-island"]
    if not c.that(islands_found, "the copper defect trips net-island"):
        return
    # Every net the rules named. The gate stops only when nothing is left
    # unaccounted for, so a stub that covers one of two still loops - which is
    # the gate behaving correctly and the test being wrong about it.
    broken_nets = sorted({n for f in islands_found for n in f["nets"]})

    # A rule fires and nothing the model says accounts for it: loop, then give up
    # rather than declare the board fine. The gate must never take the model's
    # word for being finished.
    client = StubClient({"circuit": {"findings": [
        {"title": "unrelated", "refs": ["R1"], "nets": [], "severity": "minor", "why": ""}
    ]}})
    state = run_graph(json.loads(json.dumps(broken)), client, inputs={})
    c.equals(state["stopped"], "stop:passes-spent", "an unaccounted rule sends it round again")
    c.equals(state["passes"], MAX_PASSES, f"and it stops after {MAX_PASSES} passes")

    # A finding that overlaps the rule's own refs and nets ends it after one.
    client = StubClient({"physical": {"findings": [
        {
            "title": f"{net} is in pieces",
            "refs": [],
            "nets": [net],
            "severity": "critical",
            "why": "",
        }
        for net in broken_nets
    ]}})
    state = run_graph(json.loads(json.dumps(broken)), client, inputs={})
    c.equals(state["stopped"], "stop:rules-accounted-for", "a matching finding ends the loop")
    c.equals(state["passes"], 1, "in one pass")

    # And the board throws out what it can refute, with no model consulted.
    client = StubClient({"circuit": {"findings": [
        {"title": "U9 is wrong", "refs": ["U9"], "nets": [], "severity": "major", "why": ""},
        {"title": "GND is stranded", "refs": [], "nets": ["GND"], "severity": "critical", "why": ""},
        {
            # This one is true on this board: it is the net the defect broke.
            "title": f"{broken_nets[0]} is stranded",
            "refs": [],
            "nets": [broken_nets[0]],
            "severity": "major",
            "why": "",
        },
    ]}})
    state = run_graph(json.loads(json.dumps(broken)), client, inputs={})
    dropped = {item["title"]: item["dropped"] for item in state["dropped"]}
    c.that("U9 is wrong" in dropped, f"a part that does not exist is refuted: {dropped}")
    c.that(
        "GND is stranded" in dropped,
        f"a net the copper says is one piece is refuted: {sorted(dropped)}",
    )
    c.that(
        f"{broken_nets[0]} is stranded" not in dropped,
        "and the claim the copper agrees with survives",
    )
    c.note(f"gate reasons exercised: nothing-to-chase, passes-spent, rules-accounted-for")


# -------------------------------------------------------------------------- 13


@step(13, "harness/run.py leaves a result stamped with all three hashes")
def check_sweep(c: Check) -> None:
    from graph.prompts import prompt_hash
    from harness.grade import corpus_hash, pipeline_hash, schema_hash
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
    c.equals(
        result.get("pipeline_hash"),
        pipeline_hash(),
        "pipeline hash is current (an evaluator was added or removed since the sweep; "
        "rerun: python -m harness.run --trials 5 --tpm 40000 --concurrency 2)",
    )

    cases = corpus()
    c.that(len(cases) >= 4, f"the corpus has clean boards and seeded ones ({len(cases)} cases)")
    seeded_now = [case for case in cases if case["defects"]]
    clean_now = [case for case in cases if not case["defects"]]
    c.equals(
        result["corpus_hash"],
        corpus_hash(sorted({board_hash(case["board"]) for case in cases})),
        "corpus hash is current (the seeded boards changed since the sweep?)",
    )

    # A single run cannot be told apart from noise, so the committed sweep is
    # repeated and the README quotes a median and a range. One trial is still a
    # valid sweep; it just cannot say anything about spread.
    trials = result.get("trials", 1)
    c.that(trials >= 5, f"the committed sweep repeats the corpus ({trials} trials)")

    detectors = {row["detector"] for row in result["rows"]}
    c.equals(detectors, {"single", "graph"}, "both detectors ran")
    c.equals(
        len(result["rows"]),
        2 * len(cases) * trials,
        "every case ran under both detectors, every trial",
    )
    c.that(
        all("trial" in row for row in result["rows"]),
        "every row says which trial it came from",
    )
    for detector in ("single", "graph"):
        seen = {row["trial"] for row in result["rows"] if row["detector"] == detector}
        c.equals(seen, set(range(1, trials + 1)), f"{detector} ran every trial")
    for row in result["rows"]:
        if not c.that("grade" in row, f"{row['board']} was graded"):
            break
    clean_rows = [r for r in result["rows"] if not r["defects"]]
    c.equals(
        len(clean_rows),
        2 * len(clean_now) * trials,
        "every clean board ran under both detectors",
    )

    # The spread is the point of repeating, so it has to be in the record
    # rather than recomputed by whoever reads it.
    for detector in ("single", "graph"):
        s = result.get("spread", {}).get(detector, {})
        if not c.that(s, f"the result carries {detector}'s spread across trials"):
            break
        for metric in ("caught", "false_alarms_on_clean", "refuted_reported"):
            got = s.get(metric, {}).get("values", [])
            c.equals(len(got), trials, f"{detector}/{metric} has one value per trial")

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


# -------------------------------------------------------------------------- 15


@step(15, "the evidence pack is the only board information a model receives")
def check_evidence_boundary(c: Check) -> None:
    """The seam between measurement and reasoning, asserted rather than assumed.

    A reviewer can only report on what it was shown, so the pack is the real
    control on what a model is able to say. These checks are the reason it
    stays one.
    """
    from graph.build import ingest
    from graph.prompts import REVIEWERS
    from harness.generators import GENERATORS
    from harness.packs import PACK_VERSION, build_packs

    #: The heading every pack uses to declare what measurement already covers.
    HANDLED_HEADING = "HANDLED BY MEASUREMENT"
    from harness.run import corpus

    c.that(bool(PACK_VERSION), "packs carry a version, so a result says which shape produced it")

    for case in corpus()[:2]:
        board = case["board"]
        state = ingest({"board": board})
        packs = state.get("packs") or {}
        # The two always-on packs, plus whichever gated ones this board has the
        # inputs for. Which is which is asserted below rather than here.
        if not c.that(
            {"circuit", "physical"} <= set(packs),
            f"{case['id']}: both always-on packs exist, got {sorted(packs)}",
        ):
            return

        # Determinism: the same board must produce the same bytes, or a scored
        # run cannot be reproduced from its own record.
        again = ingest({"board": board})["packs"]
        for name in packs:
            c.equals(packs[name], again[name], f"{case['id']}: {name} pack is deterministic")

        circuit, physical = packs["circuit"], packs["physical"]

        # The circuit reviewer has no geometry to speculate about.
        for marker in ("COPPER", "DECOUPLING", "copper islands", "narrowest"):
            c.that(marker not in circuit, f"{case['id']}: circuit pack withholds {marker!r}")

        # The physical reviewer has no pin semantics to duplicate.
        for marker in ("COMPONENTS ", "NETS  ", "pinfunction"):
            c.that(marker not in physical, f"{case['id']}: physical pack withholds {marker!r}")

        # Neither pack may name a seeded defect.
        for name, pack in packs.items():
            leaked = sorted(g["id"] for g in GENERATORS if g["id"] in pack)
            c.that(not leaked, f"{case['id']}: {name} pack names no seeded defect: {leaked}")

        c.note(
            f"{case['id']}: circuit {len(circuit)} chars, physical {len(physical)} chars"
        )

    # The block that tells a reviewer what is already measured must be a
    # constant, byte for byte, across every board in the corpus.
    #
    # This is the leak that made a sweep meaningless once, and it has now been
    # closed twice. The block first listed each deterministic finding with its
    # refs and nets, so a seeded circuit pack read "S1 pin 1 (GND_1) is on
    # /ECHO, not GND" - the planted defect, and exactly what the grader matches.
    # Recall on those defects was double the rest. That was narrowed to naming
    # only the checks that fired, which is still a description of this board: a
    # corpus board carries one seeded defect, so "net-island fired" is nearly
    # "the defect is a split net", and a reviewer given that hunts around the
    # split copper and turns up its neighbours as apparent discoveries.
    #
    # Comparing the blocks instead of searching them for planted words is the
    # whole point. A search can only catch the leaks someone thought of; two
    # identical strings cannot differ in any way at all, thought of or not.
    blocks: dict[str, set[str]] = {}
    for case in corpus():
        for name, pack in (ingest({"board": case["board"]}).get("packs") or {}).items():
            start = pack.find(HANDLED_HEADING)
            c.that(start >= 0, f"{case['id']}: the {name} pack declares what is measured")
            if start < 0:
                continue
            stop = pack.find(chr(10) * 2, start)
            blocks.setdefault(name, set()).add(pack[start : stop if stop > 0 else len(pack)])
    for name, seen in sorted(blocks.items()):
        c.that(
            len(seen) == 1,
            f"the {name} pack says the same thing about measurement on every board"
            + ("" if len(seen) == 1 else f" ({len(seen)} different blocks)"),
        )
    c.note(f"one measurement block per pack, over {len(list(corpus()))} boards")

    # Every reviewer maps to exactly one pack, and only to packs that exist.
    mapping = {name: pack for name, (_, pack) in REVIEWERS.items()}
    c.that(
        set(mapping.values()) <= {"circuit", "physical"},
        f"every reviewer maps to a real pack: {mapping}",
    )
    c.equals(len(set(mapping.values())), len(mapping), "no two reviewers share a pack")

    # The board itself never reaches a model. `make_node` reads state["packs"];
    # if it ever reads the board or the whole distilled text again, this fails.
    source = (ROOT / "graph" / "nodes" / "review.py").read_text(encoding="utf-8")
    for forbidden in ('state["board"]', 'state["distilled"]'):
        c.that(forbidden not in source, f"reviewer nodes never read {forbidden}")

    # The catalogue is what runs, so a check that exists must be declared. A
    # rule added to the deterministic layer and left out of the block is a rule
    # the reviewer will keep spending its answer on.
    packs = build_packs(load_board(), {})
    from harness.evaluate import EVALUATORS, NEEDS_INPUTS

    from harness.packs import CIRCUIT_RULES, GEOMETRY_RULES, THERMAL_RULES

    every = set(EVALUATORS.values()) | set(NEEDS_INPUTS)
    split = set(CIRCUIT_RULES) | set(GEOMETRY_RULES) | set(THERMAL_RULES)
    c.equals(
        sorted(every - split), [],
        "every deterministic check falls into some pack's catalogue",
    )
    c.equals(
        sorted(split - every), [],
        "and no catalogue names a check that does not exist",
    )
    # The block a reviewer actually reads is drawn from that catalogue, so it
    # says what runs rather than what fired.
    body = packs["circuit"][packs["circuit"].find(HANDLED_HEADING) :]
    c.that(
        all(f"- {name}" in body for name in CIRCUIT_RULES),
        "the circuit pack declares every check its catalogue names",
    )

    # A check that could not run must say so. A skipped check and a passing one
    # look identical in a report unless one of them is labelled, and the whole
    # point of gating is that an unassessed domain is not a clean one.
    from harness.evaluate import evaluate, unassessed
    from harness.research import brief

    board = load_board()
    bare = evaluate(board, brief(board, offline=True), None)
    missing = unassessed(bare["coverage"])
    c.that(
        "junction_temp" in missing and "rail_within_input_range" in missing,
        f"checks without inputs are skipped, with a reason: {missing}",
    )
    c.that(
        all(reason for reason in missing.values()),
        "every skip states what was missing",
    )
    c.that(
        not any(f["rule"] in ("junction_temp", "rail_within_input_range") for f in bare["findings"]),
        "a skipped check produces no finding at all",
    )

    supplied = evaluate(
        board,
        brief(board, offline=True),
        {"ambient_c": 25.0, "dissipation_w": {"S1": 1.7}, "rails": {"/IN": 12.0}},
    )
    c.that(
        "rail_within_input_range" not in unassessed(supplied["coverage"]),
        "supplying rail voltages lets the rail check run",
    )
    # Ambient and a dissipation are not enough on their own: the thermal
    # resistance comes from a datasheet, and reporting "ran" with nothing to
    # compute from would read as a pass.
    no_theta = evaluate(
        board,
        brief(board, offline=True),
        {"ambient_c": 25.0, "dissipation_w": {"R1": 0.1}},
    )
    c.that(
        "junction_temp" in unassessed(no_theta["coverage"]),
        "the thermal check skips for a part no datasheet gives a theta_JA for",
    )

    # And a figure read out of a multi-column package table is a column chosen
    # rather than a value measured, so it is refused rather than computed from.
    low = evaluate(
        board,
        brief(board, offline=True),
        {"ambient_c": 25.0, "dissipation_w": {"U3": 1.0}},
    )
    reason = unassessed(low["coverage"]).get("junction_temp", "")
    c.that(
        "multi-column" in reason,
        f"a low-confidence thermal reading is refused, not computed from: {reason!r}",
    )

    # With a trustworthy figure it does compute, and the finding carries the
    # inputs it used so the number can be checked.
    hot = evaluate(
        board,
        brief(board, offline=True),
        {"ambient_c": 25.0, "dissipation_w": {"S1": 1.7}},
    )
    tj = [f for f in hot["measured"] if f["rule"] == "junction_temp"]
    c.that(tj, "a trustworthy theta_JA and a dissipation give a junction temperature")
    if tj:
        c.that(
            "92.6" in tj[0]["why"] and "25.0" in tj[0]["why"],
            f"the estimate states its inputs: {tj[0]['why'][:70]}",
        )
    c.note(f"unassessed on a bare board: {sorted(missing)}")

    # Gating. A conditional specialist is not built at all without its inputs,
    # so a domain nobody can assess costs no call and cannot produce a finding.
    from harness.assumptions import enabled as gates_for
    from harness.assumptions import load as load_assumptions
    from harness.packs import build_packs as packs_for

    facts = brief(board, offline=True)
    bare_gates = gates_for(None, facts)
    c.equals(
        sorted(k for k, v in bare_gates.items() if not v),
        [],
        "with no assumptions, no conditional specialist is enabled",
    )
    c.that(
        all(bare_gates.values()),
        f"and each one says what it is missing: {bare_gates}",
    )
    bare_packs = packs_for(board, facts, None)
    c.equals(
        sorted(bare_packs), ["circuit", "physical"],
        "a disabled specialist gets no pack at all, rather than an empty one",
    )

    # Thermal needs three things from two places: ambient and a dissipation from
    # the assumptions file, and a junction-to-ambient resistance from a
    # datasheet. Two of the three is not enough to reason about this board.
    two_thirds = gates_for({"ambient_c": 25, "dissipation_w": {"R1": 0.1}}, {})
    c.that(
        "junction-to-ambient" in two_thirds["thermal"],
        f"thermal stays off without a theta_JA: {two_thirds['thermal']!r}",
    )
    # And a theta read from a multi-column table does not count as having one.
    low_only = {"U3": {"facts": {"thermal": {"value": {}, "confidence": "low"}}}}
    c.that(
        gates_for({"ambient_c": 25, "dissipation_w": {"U3": 1.0}}, low_only)["thermal"],
        "a low-confidence theta_JA does not enable the thermal reviewer",
    )

    supplied_inputs = load_assumptions("stm32-good")
    if c.that(supplied_inputs, "the sample board carries an assumptions file"):
        gates = gates_for(supplied_inputs, facts)
        c.that(not gates["thermal"], f"real inputs enable thermal: {gates['thermal']!r}")
        c.that(gates["signal_integrity"], "signal integrity stays off without a stackup")
        c.that(gates["power_integrity"], "power integrity stays off without a stackup")
        with_thermal = packs_for(board, facts, supplied_inputs)
        c.that("thermal" in with_thermal, "an enabled specialist gets a pack")
        c.that(
            "SUPPLIED INPUTS" in with_thermal["thermal"],
            "and the pack labels supplied figures as supplied, not measured",
        )
        c.note(f"enabled with assumptions: {sorted(with_thermal)}")

    # The page has the same boundary and no research layer, so it asks a person
    # for the facts instead. Its triage has to pick the same parts this one
    # would research, or the badges on the board describe a review that would
    # never have happened.
    run_node(c, "datasheets.mjs")


# -------------------------------------------------------------------------- 16


@step(16, "cross-domain findings must genuinely span two reviewers")
def check_cross_domain(c: Check) -> None:
    """The rule is enforced in code, not asked for in the prompt.

    Asked for cross-domain findings, a model will rewrite one specialist's
    finding with two domain names in it. That is the path of least resistance
    rather than a risk to be prompted away, so `enforce` throws out anything
    that does not cite two findings from two different reviewers - before the
    finding exists, where no wording can get past it.
    """
    from graph.nodes.cross_domain import MIN_PRODUCERS, enforce

    by_id = {
        "F001": {"id": "F001", "source": "circuit", "title": "a circuit finding"},
        "F002": {"id": "F002", "source": "physical", "title": "a physical finding"},
        "F003": {"id": "F003", "source": "circuit", "title": "another circuit finding"},
    }

    cases = [
        ("two reviewers", ["F001", "F002"], True, ""),
        ("one source only", ["F001"], False, "at least 2"),
        ("two from one reviewer", ["F001", "F003"], False, "one reviewer"),
        ("an id that does not exist", ["F001", "F999"], False, "at least 2"),
        ("no sources at all", [], False, "at least 2"),
    ]
    for label, sources, should_keep, expect in cases:
        item = {"claim": "x", "title": "t", "sources": list(sources)}
        kept, rejected = enforce([item], by_id)
        if should_keep:
            c.equals(len(kept), 1, f"a finding citing {label} is kept")
            if kept:
                c.equals(
                    kept[0]["domains"],
                    ["circuit", "physical"],
                    "and it records which domains it spans",
                )
        else:
            c.equals(len(kept), 0, f"a finding citing {label} is rejected")
            c.that(
                rejected and expect in rejected[0][1],
                f"and says why: {rejected[0][1] if rejected else 'no reason given'}",
            )

    c.equals(MIN_PRODUCERS, 2, "two producers is the threshold")

    # Unknown ids are dropped from the citation list rather than carried, so a
    # finding cannot claim support it does not have.
    kept, _ = enforce(
        [{"claim": "x", "title": "t", "sources": ["F001", "F002", "F404"]}], by_id
    )
    if c.equals(len(kept), 1, "a mostly-valid citation list survives"):
        c.equals(kept[0]["sources"], ["F001", "F002"], "with the unknown id removed")

    # The node does not call a model at all when there is nothing to combine.
    from graph.nodes.cross_domain import make_cross_domain

    class Refuses:
        def json(self, *a, **k):
            raise AssertionError("the model was called with nothing to combine")

    node = make_cross_domain(Refuses())
    out = node({"confirmed": [{"id": "F001", "source": "circuit", "title": "only one"}]})
    c.that(
        "skipped" in out.get("coverage", {}).get("cross_domain", ""),
        f"one reviewer means no call and a coverage note: {out.get('coverage', {}).get('cross_domain')}",
    )
    c.that(not out.get("cross_domain"), "and no findings")


# -------------------------------------------------------------------------- 17


@step(17, "the critic runs in two stages, and the second one cannot add findings")
def check_critic(c: Check) -> None:
    """Arithmetic first, judgement second, and neither doing the other's job."""
    import json as _json

    from graph.nodes.critic import apply_verdicts
    from graph.verify import duplicates, facts, invented_quantity, verify
    from harness.packs import build_packs
    from harness.research import brief

    board = load_board()
    f = facts(board)
    pack = build_packs(board, brief(board, offline=True))["circuit"]

    # --- stage one: exact, free, and first ---------------------------------
    stage_one = [
        (
            "a subject that is not on this board",
            {"claim": "x", "subject": "U9", "refs": ["U9"], "title": "U9 is wrong", "why": ""},
            "not on this board",
        ),
        (
            "evidence that is not a line it was given",
            {
                "claim": "x",
                "subject": "S1",
                "refs": ["S1"],
                "title": "t",
                "why": "",
                "evidence": "S1 measured 3.7 V under load on the bench",
            },
            "not a line",
        ),
        (
            "a quantity nothing supplied",
            {"claim": "x", "subject": "S1", "refs": ["S1"], "title": "the rail carries 7.5 A", "why": ""},
            "appears nowhere",
        ),
    ]
    for label, item, expect in stage_one:
        why = verify(item, f, pack)
        c.that(expect in why, f"stage one rejects {label}: {why!r}")

    # A quantity that IS in the pack is a quotation, not an invention.
    c.that(
        not invented_quantity({"title": "the part is rated 3 A", "why": ""}, pack),
        "a quantity present in the evidence is allowed",
    )
    # And one attributed to a datasheet is not an invention either.
    c.that(
        not invented_quantity(
            {"title": "above the 17 V the datasheet gives", "why": ""}, ""
        ),
        "a quantity attributed to a datasheet is allowed",
    )

    # Duplicates: a measurement outranks prose about the same subject.
    measured = {
        "origin": "deterministic",
        "refs": ["U2"],
        "nets": [],
        "title": "U2 ground pin lifted",
        "claim": "ground",
    }
    llm = {"claim": "ground", "subject": "U2", "refs": ["U2"], "nets": [], "title": "same thing"}
    c.that(
        "deterministic check already reports" in duplicates(llm, [measured]),
        "a finding duplicating a measurement is rejected",
    )
    other = {"id": "F001", "origin": "llm", "claim": "floating", "refs": ["U2"], "nets": []}
    c.that(not duplicates(llm, [other]), "a different claim about the same part is allowed")

    # --- stage two: judgement, and nothing else ----------------------------
    findings = [
        {"id": "F001", "source": "circuit", "severity": "critical", "title": "one", "why": ""},
        {"id": "F002", "source": "physical", "severity": "major", "title": "two", "why": ""},
        {"id": "F003", "source": "circuit", "severity": "major", "title": "three", "why": ""},
    ]
    kept, rejected = apply_verdicts(
        findings,
        [
            {"id": "F001", "verdict": "correct", "severity": "minor", "reason": "overstated"},
            {"id": "F002", "verdict": "reject", "reason": "the evidence does not support it"},
            {"id": "F003", "verdict": "downgrade", "reason": "not actionable"},
            # The one thing this node may not do.
            {"id": "F999", "verdict": "accept", "reason": "a finding it invented"},
        ],
    )
    ids = {item["id"] for item in kept}
    c.equals(ids, {"F001", "F003"}, "a rejected finding is removed and an invented id ignored")
    c.equals(len(rejected), 1, "the rejection is kept with its reason")
    c.that(rejected and rejected[0][1], f"and the reason survives: {rejected[0][1]!r}")

    by_id = {item["id"]: item for item in kept}
    c.equals(by_id["F001"]["severity"], "minor", "a corrected severity is applied")
    c.equals(by_id["F003"]["severity"], "informational", "a downgrade becomes informational")

    # Silence is not a rejection: an unmentioned finding keeps what it had.
    kept, rejected = apply_verdicts(findings, [])
    c.equals(len(kept), 3, "findings the critic did not mention survive unchanged")
    c.equals(kept[0]["severity"], "critical", "and keep their own severity")

    # A malformed verdict is ignored rather than obeyed.
    kept, _ = apply_verdicts(findings, [{"id": "F001", "verdict": "obliterate"}])
    c.equals(len(kept), 3, "an unrecognised verdict changes nothing")

    # The node makes no call when nothing survived stage one.
    from graph.nodes.critic import make_critic

    class Refuses:
        def json(self, *a, **k):
            raise AssertionError("the critic was called with nothing to verify")

    out = make_critic(Refuses())({"confirmed": [], "cross_domain": []})
    c.that(
        "skipped" in out.get("coverage", {}).get("critic", ""),
        "with nothing to verify the critic does not run",
    )


# -------------------------------------------------------------------------- 18


@step(18, "aggregation and scoring are arithmetic, and coverage is printed")
def check_report(c: Check) -> None:
    """The last place a number could be invented, so it is the last one checked."""
    from harness.report import build, classify, merge, render, score

    det = lambda sev: {"rule": "net-island", "origin": "deterministic", "severity": sev,
                       "refs": ["U2"], "nets": [], "title": f"measured {sev}"}
    llm = lambda sev, **kw: {"source": "circuit", "severity": sev, "confidence": "high",
                             "refs": ["U2"], "nets": [], "title": f"argued {sev}", **kw}

    # --- classes -----------------------------------------------------------
    c.equals(classify(det("critical")), "confirmed_violation", "a measurement is confirmed")
    c.equals(classify(llm("major")), "probable_issue", "an accepted model finding is probable")
    c.equals(
        classify(llm("major", confidence="low")), "engineering_concern",
        "low confidence makes it a concern",
    )
    c.equals(
        classify(llm("major", assumption="assumes 1 A")), "engineering_concern",
        "resting on an assumption makes it a concern",
    )
    c.equals(
        classify(llm("informational")), "informational", "an observation is informational"
    )

    # --- weights -----------------------------------------------------------
    c.equals(score([det("critical")])["score"], 90, "a confirmed critical costs 10")
    c.equals(score([det("medium")])["score"], 98, "a confirmed medium costs 2")
    c.equals(score([det("low")])["score"], 99, "a confirmed low costs 1")

    # A concern and an observation are reported and cost nothing.
    zero = score([llm("critical", confidence="low"), llm("critical", severity="informational")])
    c.equals(zero["score"], 100, "concerns and observations do not move the score")

    # --- the cap -----------------------------------------------------------
    # Halved, then capped at the confirmed total, so prose can at most double
    # the damage evidence already did.
    capped = score([det("low"), llm("critical"), llm("critical")])
    c.equals(capped["probable"], 10.0, "two critical probables are worth 10 before the cap")
    c.equals(capped["probable_capped_to"], 1.0, "and are capped at the 1 confirmed")
    c.equals(capped["score"], 98, "so the score moves by 2, not 11")

    # The edge this rule has, asserted so it is deliberate rather than noticed
    # later: with nothing confirmed, the model half cannot move the number.
    unbacked = score([llm("critical"), llm("critical"), llm("critical")])
    c.equals(
        unbacked["score"], 100,
        "with no confirmed violation, probable issues are capped to zero",
    )
    c.note("a board no rule fires on scores 100 however much the reviewers say")

    # --- merging -----------------------------------------------------------
    same = merge([
        {"claim": "net_split", "subject": "GND", "source": "physical", "title": "prose",
         "refs": ["U2"], "nets": []},
        {"claim": "net_split", "subject": "GND", "rule": "net-island", "title": "measured",
         "refs": ["U2"], "nets": [], "origin": "deterministic"},
    ])
    c.equals(len(same), 1, "one finding per (subject, claim)")
    if same:
        c.equals(same[0]["title"], "measured", "and the measurement's wording wins")
        c.equals(len(same[0]["found_by"]), 2, "while recording everything that found it")

    apart = merge([
        {"claim": "net_split", "subject": "GND", "source": "physical", "title": "a", "refs": [], "nets": []},
        {"claim": "pin_floating", "subject": "GND", "source": "circuit", "title": "b", "refs": [], "nets": []},
    ])
    c.equals(len(apart), 2, "different claims about one subject stay separate")

    # --- coverage in the output -------------------------------------------
    report = build(
        [det("low")],
        {"thermal": "skipped: no load current", "junction_temp": "skipped: no ambient",
         "net_islands": "ran"},
    )
    c.equals(
        sorted(report["unassessed"]), ["junction_temp", "thermal"],
        "only skipped checks are listed as unassessed",
    )
    text = render(report)
    c.that("NOT ASSESSED" in text, "the report says what it did not check")
    c.that("no load current" in text, "and why")
    c.that(
        "not the same as passing" in text,
        "and says plainly that unassessed is not passing",
    )

    # A skipped check must never improve the score: the same findings score the
    # same whether or not other domains were assessed.
    with_gaps = build([det("low")], {"thermal": "skipped: no load current"})
    without = build([det("low")], {"thermal": "ran"})
    c.equals(
        with_gaps["score"]["score"], without["score"]["score"],
        "a skipped domain does not change the score",
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

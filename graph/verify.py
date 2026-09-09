"""The critic, and it asks the board rather than a model.

The architecture this replaces put a model in this seat: show it the finding and
ask whether the evidence supports it. The measured objection to that is that a
model asked to check its own claim is doing the same reasoning that produced it,
from the same context. The findings actually worth deleting looked like

    "the GND net is split into 28 separate copper islands"

on a board where GND is one connected piece. A model that just wrote that will
very likely stand behind it. A union-find over the copper settles it in
microseconds and cannot be argued with.

So the critic is deterministic wherever the claim is decidable, which is what
the typed `claim` field is for: it says which measurement settles this finding.
Kinds nothing can settle are passed through rather than guessed at; refuting on
a hunch would be the model-critic failure in deterministic clothing.

WHAT THE FIRST VERSION GOT WRONG, TWICE

It listed `pin_floating` as undecidable. That was a misreading of this codebase -
`harness/checks.py` decides it already, and anything the rules can decide the
critic can decide. Then the first attempt at deciding it asked whether the
*part* reached a rail, which is true of every powered IC on the board and would
have deleted a real floating-input defect outright. Held-ness belongs to the
net: a part is never floating as a whole, only one of its pins is.

It also offered `trace_undersized` in the vocabulary. On the clean board the
reviewers filed twelve of them - a third of everything they reported there -
each resting on a current the board data does not contain, and so on a number
the model supplied itself. That kind is gone, because a vocabulary is a prompt
and offering a category is an instruction to fill it.

WHY THIS IS NOT `contradiction()`

`harness/grade.py` scores every detector with `contradiction()`, so that function
is the measuring stick and is frozen. If the critic and the grader were the same
code, a stricter critic would move the scores by moving the ruler, and the new
architecture would beat the old one by redefining the metric. They are separate
on purpose: `contradiction()` grades, `verify()` works, and the sweep compares
architectures on a ruler neither of them can touch.
"""

from __future__ import annotations

from graph.nodes.adjudicate import contradiction
from harness.checks import _reaches_rail, is_ground, is_rail, islands

#: A claim is free text now, so the critic cannot dispatch on a closed set of
#: kinds - it reads the tag and the finding's own words for the substrings that
#: say which measurement applies. A model that writes `floating_input`,
#: `pin_floating` or `input floats` all land on the same check, and one that
#: writes something nothing here recognises is passed through rather than
#: guessed at.
CHECKABLE = {
    "split": ("split", "island", "isolat", "not connected", "unconnected", "disconnect"),
    "value": ("value", "unbuildable", "unorderable", "non-numeric"),
    # Deliberately narrow. "missing" alone matched a free-text tag like
    # `missing_output_connection` and refuted it with "S1 is on this board" -
    # a finding about an absent *connection* thrown out because the *part*
    # exists. The check only applies when the claim is that the part itself is
    # not there.
    "missing": (
        "is missing",
        "is absent",
        "not populated",
        "not fitted",
        "no such component",
        "component missing",
        "part missing",
    ),
    "floating": ("float", "no pull", "undriven", "high impedance", "no driver"),
}


def _kinds(item: dict) -> set:
    """Which checks this finding's own words invite."""
    text = " ".join(str(item.get(k) or "") for k in ("claim", "title", "why")).lower()
    # An underscored tag is one word to a model and several to a reader.
    text = text.replace("_", " ")
    kinds = {name for name, words in CHECKABLE.items() if any(w in text for w in words)}
    # A claim about a connection is never a claim that the part is absent, and
    # the two were being conflated whenever a tag happened to contain "missing".
    if "connect" in text or "net" in text:
        kinds.discard("missing")
    return kinds


def facts(board: dict) -> dict:
    """Everything the critic can measure, computed once per board."""
    counts, pads = {}, {}
    for net, groups in islands(board).items():
        with_pads = [g for g in groups if any(i["kind"] == "pad" for i in g)]
        name = net.upper().lstrip("/")
        counts[name] = len(with_pads)
        pads[name] = sum(1 for g in groups for i in g if i["kind"] == "pad")

    # Which *nets* something holds at a level. Held-ness belongs to the net, not
    # to the part: the first version of this marked a part held if any of its
    # pins reached a rail, which makes every powered IC permanently "not
    # floating" and would have deleted a real floating-input defect outright.
    #
    # A pull resistor or an inductor to a rail holds a net; a capacitor does
    # not, because it does not conduct at DC and leaves the input floating just
    # the same. That is `_reaches_rail`'s rule, reused so the critic and the
    # deterministic rule cannot disagree.
    held = set()
    for net in board["nets"]:
        name = net["name"].upper().lstrip("/")
        if is_rail(net["name"]) or is_ground(net["name"]):
            held.add(name)
            continue
        for node in net["nodes"]:
            if _reaches_rail(board, node, net["name"]):
                held.add(name)
                break

    return {
        "refs": {c["ref"].upper() for c in board["components"]},
        "nets": {n["name"].upper().lstrip("/") for n in board["nets"]},
        "islands": counts,
        "pads": pads,
        "values": {c["ref"].upper(): c["value"] for c in board["components"]},
        "held": held,
    }


def _norm(name: str) -> str:
    return str(name or "").strip().upper().lstrip("/")


def _known(subject: str, f: dict) -> bool:
    s = _norm(subject)
    return bool(s) and (s in f["refs"] or s in f["nets"])


def verify(item: dict, f: dict, distilled: str) -> str:
    """Why this finding fails, or "" if nothing measurable contradicts it.

    Four gates, cheapest first. The first two are about the finding being
    well-formed at all; the last two are about the board disagreeing with it.
    """
    # 1. A subject that is not on this board. The single strongest signal there
    #    is: the finding is about a different design.
    subject = item.get("subject") or ""
    if subject and not _known(subject, f):
        return f"its subject {subject} is not on this board"

    # 2. Evidence that is not in the board data. A reviewer that cannot copy a
    #    line supporting its claim did not read one. Compared on a squeezed
    #    string so whitespace and case differences do not count as fabrication.
    evidence = str(item.get("evidence") or "").strip()
    if evidence and len(evidence) > 12:
        squeeze = lambda s: " ".join(s.split()).upper()
        if squeeze(evidence) not in squeeze(distilled):
            return f"its evidence is not a line in the board data: {evidence[:60]!r}"

    # 3. Whatever measurement the finding's own words invite.
    for kind in _kinds(item):
        reason = _by_kind(kind, item, f, subject)
        if reason:
            return reason

    # 4. The frozen existence and phrasing checks, so an untyped or "other"
    #    finding is still held to the old floor rather than getting a free pass.
    return contradiction(item, f)


def _by_kind(kind: str, item: dict, f: dict, subject: str) -> str:
    s = _norm(subject)

    if kind == "split":
        # Claimed in pieces; the copper says one piece.
        for name in [s] + [_norm(n) for n in item.get("nets", [])]:
            if f["islands"].get(name, 0) == 1 and f["pads"].get(name, 0) >= 2:
                return (
                    f"{name} is one connected piece of copper across all "
                    f"{f['pads'][name]} of its pads"
                )

    elif kind == "value":
        for ref in [s] + [_norm(r) for r in item.get("refs", [])]:
            value = f["values"].get(ref, "")
            if value and any(ch.isdigit() for ch in value):
                return f"{ref} has the value {value}, which can be ordered"

    elif kind == "missing":
        # "R9 is missing" on a board that has an R9 is a misread, not a defect.
        if s in f["refs"]:
            return f"{s} is on this board"

    elif kind == "floating":
        # Claimed floating, on a net something holds. Judged on the nets the
        # finding names, because held-ness is a property of the net: a part is
        # never "floating" as a whole, only one of its pins is. A finding whose
        # subject is a part and which names no net is left alone — there is
        # nothing here to decide it with.
        for name in [s] + [_norm(n) for n in item.get("nets", [])]:
            if name in f.get("held", ()):
                return f"{name} is held at a level by a resistor or inductor to a rail"

    return ""

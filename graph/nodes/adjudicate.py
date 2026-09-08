"""Merge the three reviews, then let the measurements throw findings out.

Two stages, and the order matters. The model merges duplicate wordings, because
that is a judgement about language and it is good at it. Then the board itself
refutes claims that are simply false — a part that does not exist, a net that
does not exist, a net claimed to be split whose copper is one piece. That half
never asks a model anything.

This is the whole shape of the thing: LLM nodes propose, deterministic checks
dispose. A reviewer that cannot be contradicted is a reviewer whose output
cannot be trusted, and the board is the only thing here that cannot be argued
with.
"""

from __future__ import annotations

import re

from graph.prompts import SYSTEM, adjudicate_prompt
from graph.state import ReviewState, claim_key, key
from harness.checks import islands

#: Words that make a finding a claim about connectivity that copper can settle.
_SPLIT_CLAIM = re.compile(
    r"\b(strand|island|isolat|not connected|unconnected|disconnect|floating "
    r"copper|no return|open circuit|separate piece)", re.I
)
_NO_VALUE_CLAIM = re.compile(r"\b(no value|missing value|unspecified value|value is missing)", re.I)


def board_facts(board: dict) -> dict:
    """The measurements a finding can be checked against."""
    counts = {}
    pads = {}
    for net, groups in islands(board).items():
        with_pads = [g for g in groups if any(i["kind"] == "pad" for i in g)]
        counts[net.upper().lstrip("/")] = len(with_pads)
        pads[net.upper().lstrip("/")] = sum(
            1 for g in groups for i in g if i["kind"] == "pad"
        )
    return {
        "refs": {c["ref"].upper() for c in board["components"]},
        "nets": {n["name"].upper().lstrip("/") for n in board["nets"]},
        "islands": counts,
        "pads": pads,
        "values": {c["ref"].upper(): c["value"] for c in board["components"]},
    }


def contradiction(item: dict, facts: dict) -> str:
    """Why the board says this finding is wrong, or "" if it does not.

    Identity is judged on the whole finding, not on each name in it. A reviewer
    that names S1 correctly and writes the net name slightly wrong has still
    found something; only a finding where *nothing* it names exists is talking
    about a board that is not this one.
    """
    named = [r for r in item.get("refs", [])] + [n for n in item.get("nets", [])]
    if named:
        known = [r for r in item.get("refs", []) if r.upper() in facts["refs"]]
        known += [n for n in item.get("nets", []) if n.upper().lstrip("/") in facts["nets"]]
        if not known:
            return f"nothing it names is on this board: {', '.join(named)}"

    text = f"{item.get('title', '')} {item.get('why', '')}"
    if _SPLIT_CLAIM.search(text):
        for net in item.get("nets", []):
            name = net.upper().lstrip("/")
            if facts["islands"].get(name, 0) == 1 and facts["pads"].get(name, 0) >= 2:
                return f"{net} is one connected piece of copper across all {facts['pads'][name]} of its pads"
    if _NO_VALUE_CLAIM.search(text):
        for ref in item.get("refs", []):
            value = facts["values"].get(ref.upper(), "")
            if any(ch.isdigit() for ch in value):
                return f"{ref} has the value {value}"
    return ""


def dedupe(items: list[dict]) -> list[dict]:
    """Same defect, same subject: one finding. Keep the most severe wording.

    Identity is the typed claim where the reviewer gave one - a kind plus the
    thing it is about. Two reviewers finding the same defect used to collide
    only if their ref and net lists happened to intersect, so one problem in
    two wordings survived as two findings and both went to the merge call.
    Untyped findings fall back to the old ref-and-net identity.
    """
    rank = {"critical": 0, "major": 1, "minor": 2}
    best: dict = {}
    order: list = []
    for item in items:
        k = claim_key(item)
        if k is None:
            k = key(item) or frozenset([f"t:{item['title'].lower()}"])
        if k not in best:
            best[k] = item
            order.append(k)
        elif rank.get(item["severity"], 3) < rank.get(best[k]["severity"], 3):
            best[k] = item
    return [best[k] for k in order]


def _numbered(items: list[dict]) -> str:
    return "\n".join(
        f"{i}. [{item['source']}/{item['severity']}] {item['title']}"
        f" (refs {', '.join(item['refs']) or '-'}; nets {', '.join(item['nets']) or '-'})"
        f"\n   {item['why']}"
        for i, item in enumerate(items)
    )


def make_adjudicate(client):
    def adjudicate(state: ReviewState) -> dict:
        findings = dedupe(state.get("findings", []))
        # The critic's facts, not the grader's: `verify` measures things
        # `board_facts` does not carry, and `board_facts` stays frozen because
        # it is what `harness/grade.py` scores every detector with.
        from graph.verify import facts as critic_facts

        facts = critic_facts(state["board"])
        calls = list(state.get("calls", []))

        # A model merges wordings; that is a language judgement, not a measurement.
        kept = findings
        if len(findings) > 1:
            parsed, info = client.json(
                adjudicate_prompt(_numbered(findings), state["distilled"]),
                label=f"adjudicate/pass{state.get('passes', 0) + 1}",
                system=SYSTEM,
            )
            wanted = parsed.get("keep")
            if isinstance(wanted, list) and wanted:
                picks = sorted({int(i) for i in wanted if isinstance(i, (int, float)) and 0 <= int(i) < len(findings)})
                if picks:
                    kept = [findings[i] for i in picks]
            calls.append({**info, "node": "adjudicate", "found": len(kept)})

        # Then the critic, which asks the board rather than a model. Imported
        # here because graph.verify imports `contradiction` from this module.
        from graph.verify import verify

        confirmed, dropped = [], []
        for item in kept:
            reason = verify(item, facts, state["distilled"])
            if reason:
                dropped.append({**item, "dropped": reason})
            else:
                confirmed.append(item)

        # Manufacturability findings are measurements, so they join the report
        # already verified. They are appended rather than adjudicated: there is
        # nothing for a model to merge, and nothing for the critic to doubt.
        confirmed = confirmed + list(state.get("dfm", [])) + list(state.get("datasheet", []))

        return {
            "findings": findings,
            "confirmed": confirmed,
            "dropped": dropped,
            "passes": state.get("passes", 0) + 1,
            "calls": calls,
        }

    return adjudicate

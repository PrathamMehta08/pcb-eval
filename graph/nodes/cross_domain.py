"""The one node that looks at every specialist at once.

A specialist sees its own slice by construction - that is what the evidence
packs are for - so a defect that exists only in the interaction between two
slices is invisible to both. The circuit reviewer knows a part is polarised and
cannot see its copper; the physical reviewer sees the broken copper and does not
know the part is a diode. Neither can report that the diode is fitted backwards.

THE FAILURE MODE THIS NODE HAS

Asked for cross-domain findings, a model will happily rewrite one specialist's
finding with two domain names in it and call that an interaction. That is not a
risk to be prompted away - it is the path of least resistance, and this project
has already measured what happens when a model is given a category it can always
satisfy: three quarters of everything it said fell into the two easiest ones.

So the constraint is structural rather than instructed. Every finding must cite
at least two source findings from at least two different producers, and the node
throws out anything that does not - in code, before the finding exists. A model
cannot talk its way past a set intersection.

WHEN IT RUNS AT ALL

Only when at least two specialists actually produced something. One list of
findings has no interactions in it, and asking anyway would spend a call to be
told so - or worse, to be told about one.
"""

from __future__ import annotations

from graph.prompts import SYSTEM, cross_domain_prompt
from graph.state import ReviewState, normalise

#: A cross-domain finding must span this many distinct producers.
MIN_PRODUCERS = 2


def _numbered(findings: list[dict]) -> str:
    """The specialists' findings, with the ids the model must cite."""
    lines = []
    for item in findings:
        refs = ", ".join(item.get("refs") or []) or "-"
        nets = ", ".join(item.get("nets") or []) or "-"
        lines.append(
            f"{item['id']}  [{item['source']}/{item['severity']}] {item['title']}"
            f"\n     refs {refs}; nets {nets}"
            f"\n     {item.get('why', '')}"
        )
    return "\n".join(lines)


def enforce(items: list[dict], by_id: dict[str, dict]) -> tuple[list[dict], list[tuple]]:
    """Keep only findings that genuinely span two specialists.

    Checked here rather than asked for in the prompt, because the prompt asking
    is what a model routes around. A finding citing one source, or two sources
    from the same reviewer, or an id that does not exist, is not a cross-domain
    finding whatever it says about itself.
    """
    kept, rejected = [], []
    for item in items:
        cited = [str(s).strip() for s in (item.get("sources") or [])]
        known = [s for s in cited if s in by_id]
        producers = {by_id[s]["source"] for s in known}
        if len(known) < 2:
            rejected.append((item, f"cites {len(known)} known findings, needs at least 2"))
            continue
        if len(producers) < MIN_PRODUCERS:
            rejected.append(
                (item, f"all its sources come from one reviewer ({', '.join(sorted(producers))})")
            )
            continue
        item["sources"] = known
        item["domains"] = sorted(producers)
        kept.append(item)
    return kept, rejected


def make_cross_domain(client):
    def cross_domain(state: ReviewState) -> dict:
        findings = list(state.get("confirmed", []))
        producers = {f.get("source") for f in findings if f.get("source")}
        if len(producers) < MIN_PRODUCERS:
            # Nothing to combine. Not a failure and not worth a call.
            return {
                "coverage": {
                    **state.get("coverage", {}),
                    "cross_domain": (
                        f"skipped: only {len(producers)} reviewer produced findings, "
                        "so there is no interaction to look for"
                    ),
                }
            }

        by_id = {f["id"]: f for f in findings if f.get("id")}
        parsed, info = client.json(
            cross_domain_prompt(_numbered([f for f in findings if f.get("id")])),
            label=f"cross-domain/pass{state.get('passes', 1)}",
            system=SYSTEM,
        )
        raw = normalise(parsed.get("findings"), "cross_domain")
        # `normalise` drops unknown keys, so the citations are carried across by
        # position from what the model actually returned.
        for item, original in zip(raw, parsed.get("findings") or []):
            item["sources"] = (original or {}).get("sources") or []

        kept, rejected = enforce(raw, by_id)
        return {
            "cross_domain": kept,
            "rejected": [
                {"finding": item, "because": why, "stage": "cross-domain"}
                for item, why in rejected
            ],
            "calls": [{**info, "node": "cross_domain", "found": len(kept)}],
            "coverage": {**state.get("coverage", {}), "cross_domain": "ran"},
        }

    return cross_domain

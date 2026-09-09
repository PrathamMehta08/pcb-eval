"""The reviewing nodes. One pack each, and nothing else.

Two rather than three, and two rather than seven. A specialist earns its call by
holding evidence no other specialist holds, and there are exactly two disjoint
bodies of evidence on a board extracted from KiCad: what the netlist says the
circuit is, and what the copper says the board is. Splitting further would mean
handing two agents the same evidence and hoping they disagree usefully, which is
how the previous three reviewers produced one defect in three wordings.

The client is bound into each node's closure rather than carried in the state:
it holds a socket, a semaphore and a rolling token budget, none of which belong
in something a checkpointer might serialise.
"""

from __future__ import annotations

from graph.prompts import ALL_REVIEWERS, REVIEWERS, SYSTEM
from graph.state import ReviewState, normalise


def make_node(name: str, client):
    """One reviewer, reading only its own pack.

    Reading `state["packs"][pack]` rather than the board is the whole point of
    the evidence boundary: what this model can say is bounded by what was put in
    front of it, and that is asserted in `tests.run 15`.
    """
    build_prompt, pack_name = ALL_REVIEWERS[name]

    def node(state: ReviewState) -> dict:
        pack = state["packs"][pack_name]
        parsed, info = client.json(
            build_prompt(pack),
            label=f"{name}/pass{state.get('passes', 0) + 1}",
            system=SYSTEM,
        )
        found = normalise(parsed.get("findings"), name)
        # Only this node's own output. The channels accumulate.
        return {
            "proposed": found,
            "calls": [{**info, "node": name, "found": len(found)}],
        }

    node.__name__ = name
    return node


def reviewers(client, enabled=None) -> dict:
    """The reviewers this board has the inputs for, bound to one client."""
    names = list(REVIEWERS) if enabled is None else list(enabled)
    return {name: make_node(name, client) for name in names}

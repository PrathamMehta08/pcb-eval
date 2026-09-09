"""The three reviewing nodes. One job each, the whole board each time.

The client is bound into each node's closure rather than carried in the state:
it holds a socket, a semaphore and a rolling token budget, none of which belong
in something a checkpointer might try to serialise.

Both this client and the page's `sample` are memory-less between calls, so every
node sends the distilled board whole. That is the cost of decomposition, and
whether it buys anything is the question the eval answers.
"""

from __future__ import annotations

from graph.prompts import SYSTEM, connections_prompt, datasheet_prompt, layout_prompt
from graph.state import ReviewState, normalise


#: Which pack each reviewer is given. The circuit reviewers see parts, nets and
#: pin meaning; the layout reviewer sees copper and placement. Neither sees the
#: other's, which is what stops one speculating about measurements it does not
#: hold and the other repeating a finding that is not its job.
PACK_FOR = {"datasheet": "circuit", "connections": "circuit", "layout": "physical"}


def make_node(name: str, build_prompt, client):
    def node(state: ReviewState) -> dict:
        pack = state["packs"][PACK_FOR[name]]
        parsed, info = client.json(
            build_prompt(pack),
            label=f"{name}/pass{state.get('passes', 0) + 1}",
            system=SYSTEM,
        )
        found = normalise(parsed.get("findings"), name)
        return {
            "findings": list(state.get("findings", [])) + found,
            "calls": list(state.get("calls", [])) + [
                {**info, "node": name, "found": len(found)}
            ],
        }

    node.__name__ = name
    return node


def reviewers(client) -> dict:
    """The three nodes, bound to one client."""
    return {
        "datasheet": make_node("datasheet", datasheet_prompt, client),
        "connections": make_node("connections", connections_prompt, client),
        "layout": make_node("layout", layout_prompt, client),
    }

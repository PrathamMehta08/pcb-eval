"""The review graph: ingest, three reviewers, adjudicate, gate.

    ingest        deterministic: distil, run the rule checks
      |
    datasheet     pin function against what the pin is wired to
      |
    connections   connector pinouts, floating inputs, power and ground
      |
    layout        placement and routing: width against current, ground return
      |
    adjudicate    dedupe, then let the board refute what it can
      |
    gate          back to datasheet, or stop

Sequential, not parallel. Parallel fan-out needs reducer annotations on every
list in the state and is not worth the debugging time for three nodes.

**The gate never asks the model whether it is finished.** If the loop exits when
the reviewers agree the board looks fine, it always exits, and the harness
launders bad boards as checked. It stops on measurements instead: nothing for
the rules to find, or nothing they found still unaccounted for, or the pass
budget is spent.
"""

from __future__ import annotations

from langgraph.graph import END, StateGraph

from graph.nodes.adjudicate import make_adjudicate
from graph.nodes.review import reviewers
from graph.state import ReviewState, key
from harness.checks import run_checks
from harness.distill import distill

MAX_PASSES = 2


def ingest(state: ReviewState) -> dict:
    """Everything here is measured. No model has been asked anything yet."""
    board = state["board"]
    return {
        "distilled": distill(board),
        "deterministic": run_checks(board),
        "findings": [],
        "confirmed": [],
        "calls": [],
        "gates": [],
        "passes": 0,
    }


def unaccounted(state: ReviewState) -> list[dict]:
    """Rule findings no confirmed LLM finding overlaps, by ref or net."""
    covered = set()
    for item in state.get("confirmed", []):
        covered |= key(item)
    return [item for item in state.get("deterministic", []) if not (key(item) & covered)]


def gate(state: ReviewState) -> str:
    if not state.get("deterministic"):
        return "stop:nothing-to-chase"
    if state.get("passes", 0) >= MAX_PASSES:
        return "stop:passes-spent"
    if not unaccounted(state):
        return "stop:rules-accounted-for"
    return "again"


def route(state: ReviewState) -> str:
    return "datasheet" if gate(state) == "again" else END


def stamp(state: ReviewState) -> dict:
    """Record the gate's decision, and why, before acting on it.

    The loop is the part of this worth reading, so it is written down rather
    than inferred from a call count: which pass, what the rules had found, what
    the reviewers had accounted for, and what was still outstanding.
    """
    decision = gate(state)
    left = unaccounted(state)
    return {
        "stopped": decision,
        "gates": list(state.get("gates", []))
        + [
            {
                "pass": state.get("passes", 0),
                "decision": decision,
                "rules": [item["rule"] for item in state.get("deterministic", [])],
                "unaccounted": [item["rule"] for item in left],
                "confirmed": len(state.get("confirmed", [])),
                "proposed": len(state.get("findings", [])),
                "why": _why(decision, state, left),
            }
        ],
    }


def _why(decision: str, state: ReviewState, left: list[dict]) -> str:
    if decision == "stop:nothing-to-chase":
        return "The rule checks found nothing, so there is nothing for another pass to chase."
    if decision == "stop:passes-spent":
        names = ", ".join(item["rule"] for item in left) or "nothing"
        return (
            f"{MAX_PASSES} passes are the budget and they are spent. Still "
            f"unaccounted for: {names}. This is reported as a miss, not as a "
            "clean board."
        )
    if decision == "stop:rules-accounted-for":
        return (
            "Every rule the deterministic checks fired has been matched by a "
            "confirmed finding, on refs or nets. Nothing is left to chase."
        )
    names = ", ".join(item["rule"] for item in left)
    return (
        f"The rule checks found {names}, and no confirmed finding overlaps it. "
        "Round again — the model is not asked whether it is finished."
    )


def build_graph(client):
    nodes = reviewers(client)
    graph = StateGraph(ReviewState)
    graph.add_node("ingest", ingest)
    graph.add_node("datasheet", nodes["datasheet"])
    graph.add_node("connections", nodes["connections"])
    graph.add_node("layout", nodes["layout"])
    graph.add_node("adjudicate", make_adjudicate(client))
    graph.add_node("stamp", stamp)

    graph.set_entry_point("ingest")
    graph.add_edge("ingest", "datasheet")
    graph.add_edge("datasheet", "connections")
    graph.add_edge("connections", "layout")
    graph.add_edge("layout", "adjudicate")
    graph.add_edge("adjudicate", "stamp")
    graph.add_conditional_edges("stamp", route, {"datasheet": "datasheet", END: END})
    return graph.compile()


def run_graph(board: dict, client) -> ReviewState:
    graph = build_graph(client)
    return graph.invoke({"board": board}, {"recursion_limit": 50})


if __name__ == "__main__":
    import json
    import sys
    from pathlib import Path

    root = Path(__file__).resolve().parent.parent
    sys.path.insert(0, str(root))
    from console import utf8
    from harness.llm import Client
    from harness.ops import apply_edits
    from harness.presets import BY_ID, edits_for

    utf8()
    board = json.loads((root / "boards" / "stm32-good.json").read_text(encoding="utf-8"))
    preset_id = sys.argv[1] if len(sys.argv) > 1 else None
    if preset_id:
        preset = BY_ID[preset_id]
        apply_edits(board, edits_for(preset, board))
        print(f"board: {preset_id} — {preset['title']}")
    else:
        print("board: clean")

    client = Client()
    result = run_graph(board, client)
    print(f"\nstopped: {result['stopped']}  passes: {result['passes']}")
    print(f"rules found {len(result['deterministic'])}: "
          + ", ".join(f["rule"] for f in result["deterministic"]))
    print(f"\nconfirmed {len(result['confirmed'])} of {len(result['findings'])} proposed")
    for item in result["confirmed"]:
        print(f"  [{item['severity']:<8} {item['source']:<11}] {item['title']}")
    for item in result.get("dropped", []):
        print(f"  dropped: {item['title']}\n           because {item['dropped']}")
    print(f"\nusage {client.usage.as_dict()}")

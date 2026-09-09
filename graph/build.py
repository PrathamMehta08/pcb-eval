"""The review graph: ingest, three reviewers, adjudicate, gate.

    ingest        deterministic: distil, rule checks, manufacturability checks,
                  datasheet checks, and the evidence packs the reviewers read
      |
    circuit  ─┐   parts, nets, pin meaning, researched facts
    physical ─┘   copper, placement, distances          (parallel, disjoint packs)
      |
    adjudicate    dedupe on typed claims, then the critic
      |
    cross-domain  what is only true of two reviewers' findings together.
                  Skipped when fewer than two of them found anything.
      |
    critic        deterministic, inside adjudicate: per claim kind, the board
                  answers. No model reviews another model's work.
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
from graph.nodes.cross_domain import make_cross_domain
from graph.nodes.review import reviewers
from graph.prompts import REVIEWERS
from graph.state import ReviewState, key
from harness.assumptions import enabled as gates_for
from harness.assumptions import load as load_assumptions
from harness.evaluate import evaluate
from harness.research import brief
from harness.distill import distill
from harness.packs import build_packs

MAX_PASSES = 2


def ingest(state: ReviewState) -> dict:
    """Everything here is measured. No model has been asked anything yet."""
    board = state["board"]
    facts = brief(board, offline=True)
    inputs = state.get("inputs") or load_assumptions(board["meta"]["name"]) or {}
    # One layer, one record of what it could and could not do. `coverage` says
    # which evaluators ran and why the rest did not, and travels to the report:
    # a domain that was not assessed is not a domain that passed.
    result = evaluate(board, facts, inputs)
    deterministic = result["findings"]
    coverage = dict(result["coverage"])
    for domain, why in gates_for(inputs, facts).items():
        coverage[domain] = "ran" if not why else f"skipped: {why}"
    return {
        "coverage": coverage,
        "measured": result["measured"],
        "distilled": distill(board),
        "deterministic": deterministic,
        # The seam. Built here, from measurements only, and handed to the
        # reviewers instead of the board.
        "inputs": inputs,
        "packs": build_packs(board, facts, deterministic + result["measured"], inputs),
        # The fourth evaluator, and the only one that is pure geometry. It does
        # not feed the gate: a DFM finding is already complete, and looping the
        # reviewers over it would spend calls to be told what the board said.
        "findings": [],
        "confirmed": [],
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
    """Back to the reviewers, or done. The gate decides on measurements."""
    from graph.prompts import REVIEWERS

    return next(iter(REVIEWERS)) if gate(state) == "again" else END


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


def build_graph(client, enabled_agents=None):
    nodes = reviewers(client, enabled_agents)
    graph = StateGraph(ReviewState)
    graph.add_node("ingest", ingest)
    for name, node in nodes.items():
        graph.add_node(name, node)
    graph.add_node("adjudicate", make_adjudicate(client))
    graph.add_node("cross_domain", make_cross_domain(client))
    graph.add_node("stamp", stamp)

    graph.set_entry_point("ingest")
    # The reviewers fan out from ingest and back into adjudicate. They share no
    # state and hold disjoint packs, so there is nothing to order them by.
    for name in nodes:
        graph.add_edge("ingest", name)
        graph.add_edge(name, "adjudicate")
    graph.add_edge("adjudicate", "cross_domain")
    graph.add_edge("cross_domain", "stamp")
    graph.add_conditional_edges(
        "stamp", route, {**{n: n for n in nodes}, END: END}
    )
    return graph.compile()


def run_graph(board: dict, client, inputs: dict | None = None) -> ReviewState:
    """Run the review. Which specialists exist is decided before the graph is.

    A gated specialist is not built at all rather than built and skipped: a node
    that exists is a node that can be called, and the point of gating is that a
    domain nobody can assess costs nothing and shows up as unassessed.
    """
    inputs = inputs if inputs is not None else (load_assumptions(board["meta"]["name"]) or {})
    # The gate needs the research too: thermal wants a theta_JA, and that comes
    # from a datasheet rather than from the assumptions file.
    facts = brief(board, offline=True)
    enabled_agents = list(REVIEWERS) + [
        name for name, why in gates_for(inputs, facts).items() if not why
    ]
    graph = build_graph(client, enabled_agents)
    return graph.invoke(
        {"board": board, "inputs": inputs, "enabled_agents": enabled_agents},
        {"recursion_limit": 50},
    )


if __name__ == "__main__":
    import json
    import sys
    from pathlib import Path

    root = Path(__file__).resolve().parent.parent
    sys.path.insert(0, str(root))
    from console import utf8
    from harness.llm import Client
    from harness.ops import apply_edits
    from harness.generators import defects_for

    utf8()
    board = json.loads((root / "boards" / "stm32-good.json").read_text(encoding="utf-8"))
    wanted = sys.argv[1] if len(sys.argv) > 1 else None
    if wanted:
        defect = next(
            d for d in defects_for(board, "stm32-good") if d["generator"] == wanted
        )
        apply_edits(board, defect["edits"])
        print(f"board: {wanted} — {defect['title']}")
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

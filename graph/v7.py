"""V7: one reviewer with the whole board, and everything else deterministic.

    analyse    measure the board. No model is asked anything.
      |
    review     one call, the whole board, findings out
      |
    validate   arithmetic and string comparison: does the subject exist, is the
               evidence in the pack, is this a duplicate, was this quantity
               invented, does the board itself contradict it
      |
    aggregate  merge the reviewer's surviving findings with what was measured,
               rank, score. No model involved.

THERE IS NO LLM CRITIC, AND THAT IS A RESULT

There was one, and it was measured three ways. Wired as written it rejected 409
of 409 findings across five trials, because it was told to be strictest about
whether quoted evidence supports a claim and this schema carries no quoted
evidence - every finding reached it reading "evidence: (none quoted)". Recall
fell to exactly the defects the deterministic rules catch.

Rewritten to judge what is actually there, and told the asymmetry - a defect
rejected is gone, a doubtful finding kept costs a minute of reading - it went
the other way and rejected almost nothing: six of two hundred and twenty-nine
for V7. Over five trials it cost two rule-silent defects, 33 against 35, and
saved one finding on a clean board.

So it is gone, on this project's own rule: a component earns its place by
improving recall, and this one spent a call per board to reduce it. The thing it
was meant to do is already done by `validate`, which is arithmetic and string
comparison rather than a second opinion - and which is why both V7 and V8 report
zero findings the board contradicts while the baseline reports six.

The guiding principle it was tested against, and failed: if what would refute a
node's output is a measurement, build the measurement; if the answer is another
model, the node is probably unnecessary.

WHY THIS SHAPE

V1 through V6 pushed in the other direction - five specialists, cross-domain
reasoning, a supervisor - and the measurements were consistent and unkind. More
specialists did not find more defects. Splitting the board between them found
fewer, because a reviewer holding half a board speculates about the other half.
Cross-domain reasoning produced nothing at all across forty-four runs. What did
work was the deterministic layer, which beat every model on anything that could
be measured, and the critic, which cut findings the board refutes.

So V7 keeps the two things that worked and removes everything that did not. One
reviewer, because one reviewer with the whole board was never beaten by any
arrangement of several with pieces of it. One pass, because the loop existed to
give reviewers another go at what the rules had already found, and telling them
what the rules found is the leak this project spent two fixes closing.

WHAT IT IS MEASURED AGAINST

`baseline.single_prompt`, which is one call with the same distilled board and
the same job text. Not merely similar - identical, through the same builder, so
at temperature zero the two reviewers return the same answer and the difference
between the detectors is only what is built around it.

That control was worth the trouble. The first version added a catalogue of the
deterministic checks to the pack and a note not to spend the answer on what they
cover, and it cost five points of rule-silent recall: the reviewer took "these
are handled" to mean whole categories rather than the named checks, and stopped
reporting a swapped regulator and an oversized companion capacitor that no rule
had fired on. Both were things the baseline caught.

THE LEAK, WHICH IS THE WHOLE RISK

Recall on a seeded corpus is only worth reading if the system was not told where
to look. Three things could tell it, and all three are closed here:

The pack is the distilled board and nothing else - the same bytes the baseline
gets. Nothing is appended that could describe this board in particular, because
nothing is appended at all.

The reviewer is given the board and the baseline's job text. Neither names a
part, a net or a convention belonging to any board; `tests.run 12` asserts that
mechanically.

The critic sees the findings and nothing else - no defect list, no rule output.
It may only judge what the reviewer already said.

Four of the thirteen seeded defects are also caught by a deterministic rule, and
three of those are a rule and a generator written from the same condition. A
recall number over all thirteen therefore measures the rules on those three as
much as it measures anything, so the headline is recall on the nine no rule
fires on. Both are reported.
"""

from __future__ import annotations

import operator
from typing import Annotated, TypedDict

from langgraph.graph import END, StateGraph

from graph.prompts import (
    SYSTEM,
    conservative_critic_prompt,
    second_look_prompt,
    single_prompt,
)
from graph.state import key, normalise
from graph.verify import facts as board_facts
from graph.verify import verify
from graph.nodes.critic import apply_verdicts
from harness.assumptions import load as load_assumptions
from harness.distill import distill
from harness.evaluate import evaluate
from harness.packs import reviewer_pack
from harness.report import build
from harness.research import brief


class PCBState(TypedDict, total=False):
    """One state for the whole run. Every node reads it and adds to it."""

    board: dict
    inputs: dict

    #: Measured before any model is asked anything.
    distilled: str
    deterministic: list[dict]
    measured: list[dict]
    coverage: dict

    #: The single thing any model is shown about this board.
    pack: str

    #: What the one reviewer said, and what survived each gate after it.
    reviewer_findings: list[dict]
    validated: list[dict]
    rejected: list[dict]
    verified: list[dict]

    #: The system's answer: what was measured, plus what the reviewer said that
    #: survived. This is what the grader reads.
    confirmed: list[dict]
    report: dict

    calls: Annotated[list[dict], operator.add]
    passes: int
    stopped: str


def analyse(state: PCBState) -> dict:
    """Measure the board and build the one pack. No model is involved."""
    board = state["board"]
    research = brief(board, offline=True)
    inputs = state.get("inputs") or load_assumptions(board["meta"]["name"]) or {}
    result = evaluate(board, research, inputs)
    return {
        "distilled": distill(board),
        "deterministic": result["findings"],
        "measured": result["measured"],
        "coverage": dict(result["coverage"]),
        "inputs": inputs,
        "pack": reviewer_pack(board, research),
        "passes": 1,
    }


def make_review(client):
    """One call, the whole board, findings out."""

    def review(state: PCBState) -> dict:
        parsed, info = client.json(
            single_prompt(state["pack"]), label="v7:review", system=SYSTEM
        )
        found = normalise(parsed.get("findings"), "reviewer")
        return {
            "reviewer_findings": found,
            "calls": [{**info, "node": "review", "found": len(found)}],
        }

    return review


def _numbered_titles(items: list[dict]) -> str:
    if not items:
        return "Nothing was reported."
    return "\n".join(
        f"- {item['title']} (refs {', '.join(item.get('refs') or []) or '-'};"
        f" nets {', '.join(item.get('nets') or []) or '-'})"
        for item in items
    )


def make_second_look(client):
    """One more call, asked what the first pass missed.

    The measurement that produced this node: two runs of the same reviewer, on
    the same prompt, at temperature zero, caught different defects - seven and
    eleven of thirteen - and between them covered twelve. A single sample is not
    the reviewer's ability, it is one draw from it, and the gap between one draw
    and two was larger than the gap between any two architectures measured so
    far.

    Asking the same model what it missed is the cheap way to take a second draw.
    It costs one call and it cannot be told anything the first pass did not
    already say, because the only thing added to its prompt is the first pass's
    own findings.
    """

    def second_look(state: PCBState) -> dict:
        first = state.get("reviewer_findings") or []
        parsed, info = client.json(
            second_look_prompt(state["pack"], _numbered_titles(first)),
            label="v8:second-look",
            system=SYSTEM,
        )
        more = normalise(parsed.get("findings"), "second-look")
        # Union, not replacement. The deduplication that matters happens in
        # `validate`, which already refuses a finding that repeats one it has
        # kept - so a second pass that restates the first costs nothing but the
        # call, and one that finds something new keeps it.
        return {
            "reviewer_findings": first + more,
            "calls": [{**info, "node": "second_look", "found": len(more)}],
        }

    return second_look


def _with_ids(items: list[dict]) -> list[dict]:
    """Give every finding an id before the critic is asked about it.

    `apply_verdicts` matches a verdict to a finding by id, and discards a
    verdict for an id it did not send - which is right, because an invented id
    is the shape an added finding would take and the critic may not add. But
    findings off `normalise` carry no id, so the lookup was empty, every verdict
    was discarded as unrecognised, and the critic kept everything it was handed.
    It was a call spent for no effect, and the numbers V8 first published were
    measured with it inert.
    """
    return [{**item, "id": f"F{i + 1:03d}"} for i, item in enumerate(items)]


def validate(state: PCBState) -> dict:
    """The deterministic gate, and the only one that cannot be argued with.

    `verify` is the critic this project already had: it refuses a finding whose
    subject is not on the board, whose evidence is not in what the model was
    shown, that repeats another finding, or that rests on a quantity nobody
    supplied. It is deliberately not `contradiction()` from the adjudicate node -
    that function is what the grader scores every detector with, and a validator
    that shared it would be moving the ruler rather than finding more.
    """
    f = board_facts(state["board"])
    pack = state.get("pack", "")
    kept: list[dict] = []
    rejected: list[dict] = []
    for item in state.get("reviewer_findings") or []:
        why = verify(item, f, pack, kept)
        if why:
            rejected.append({**item, "dropped": why})
        else:
            kept.append(item)
    return {"validated": _with_ids(kept), "rejected": rejected}


def _for_critic(items: list[dict]) -> str:
    """The findings as the critic sees them: what this schema actually holds.

    Deliberately without an `evidence:` line. The graph's formatter prints one,
    and against the baseline's schema - which has no evidence field - every
    finding arrived reading "evidence: (none quoted)". The critic rejected four
    hundred and nine of them across five trials, the entire reviewer output, for
    failing to supply a field nothing had asked them for.
    """
    nl = chr(10)
    return nl.join(
        f"{item['id']}  [{item.get('severity', 'major')}] {item['title']}"
        + nl + f"     refs {', '.join(item.get('refs') or []) or '-'};"
        + f" nets {', '.join(item.get('nets') or []) or '-'}"
        + nl + f"     why: {item.get('why', '')}"
        + nl + f"     fix: {item.get('fix', '')}"
        for item in items
    )


def make_critic(client):
    """Judgement on what arithmetic could not settle. It may not add findings."""

    def critic(state: PCBState) -> dict:
        items = state.get("validated") or []
        if not items:
            return {"verified": [], "calls": []}
        parsed, info = client.json(
            conservative_critic_prompt(_for_critic(items)),
            label="v7:critic",
            system=SYSTEM,
        )
        kept, dropped = apply_verdicts(items, parsed.get("verdicts") or [])
        # `apply_verdicts` returns (finding, reason) pairs; `validate` returns
        # findings carrying `dropped`. One shape reaches the record, so they are
        # made to agree here rather than by whoever reads the result.
        return {
            "verified": kept,
            "rejected": (state.get("rejected") or [])
            + [{**item, "dropped": reason} for item, reason in dropped],
            "calls": [{**info, "node": "critic", "found": len(kept)}],
        }

    return critic



def aggregate(state: PCBState) -> dict:
    """Merge what was measured with what survived, rank, score.

    Measured findings never went to a model, so they never faced the critic and
    do not need to: they carry their own evidence. They go in first, so that
    where a rule and the reviewer describe the same defect the merge keeps the
    measured one - a number beats a sentence about the number.
    """
    measured = list(state.get("deterministic") or []) + list(state.get("measured") or [])
    # `validated` is what the deterministic gate kept. It was `verified` while a
    # critic sat after that gate and rewrote the list; removing the critic left
    # nothing writing `verified`, so the report silently became the rule
    # findings alone and recall read 4 of 13 - exactly the defects the rules
    # catch, which is the shape this failure always takes.
    verified = list(state.get("verified") or state.get("validated") or [])

    covered: set = set()
    for item in measured:
        covered |= key(item)
    survivors = [item for item in verified if not (key(item) & covered)]

    confirmed = measured + survivors
    return {
        "confirmed": confirmed,
        "report": build(confirmed, state.get("coverage") or {}),
        "stopped": "stop:one-pass",
    }


def build_graph(client, second_look: bool = False):
    """V7 is the chain without the second look; V8 is the chain with it."""
    graph = StateGraph(PCBState)
    graph.add_node("analyse", analyse)
    graph.add_node("review", make_review(client))
    graph.add_node("validate", validate)
    graph.add_node("aggregate", aggregate)

    graph.set_entry_point("analyse")
    graph.add_edge("analyse", "review")
    if second_look:
        graph.add_node("second_look", make_second_look(client))
        graph.add_edge("review", "second_look")
        graph.add_edge("second_look", "validate")
    else:
        graph.add_edge("review", "validate")
    graph.add_edge("validate", "aggregate")
    graph.add_edge("aggregate", END)
    return graph.compile()


def run_v7(board: dict, client, inputs: dict | None = None, second_look: bool = False) -> PCBState:
    state = build_graph(client, second_look).invoke(
        {"board": board, "inputs": inputs or {}, "calls": []}
    )
    # The runner reads these names from every detector.
    state["findings"] = state.get("reviewer_findings") or []
    state["dropped"] = state.get("rejected") or []
    state["packs"] = {"reviewer": state.get("pack", "")}
    state["enabled_agents"] = ["reviewer", "second_look"] if second_look else ["reviewer"]
    return state

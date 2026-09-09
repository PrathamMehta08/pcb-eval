"""The second critic: judgement, on what arithmetic could not settle.

Stage one has already run. Every finding here has a subject that exists on this
board, evidence that is a real line from its own pack, no quantity it invented,
and nothing the copper or the netlist contradicts. Those are cheap, exact and
free, which is why they run first: there is no sense paying a model to consider
a claim about a part that is not on the board.

What is left is genuinely a judgement. Does the quoted line actually establish
the problem, or merely relate to it? Does the inference from it hold? Is
`critical` warranted or is it a reviewer reaching? Could an engineer act on this
without further investigation? None of that is computable and all of it decides
whether a report is worth reading.

WHAT THIS NODE MAY NOT DO

Add findings. A critic that also looks for defects is a fourth reviewer with a
different prompt, and its findings would arrive having skipped every gate the
others passed through. Verdicts are matched back by id and anything the critic
returns for an id that was not sent is discarded.
"""

from __future__ import annotations

from graph.prompts import SYSTEM, critic_prompt
from graph.state import ReviewState

VERDICTS = {"accept", "correct", "downgrade", "reject"}
SEVERITIES = {"critical", "major", "minor", "informational"}
CONFIDENCES = {"high", "medium", "low"}


def _numbered(findings: list[dict]) -> str:
    lines = []
    for item in findings:
        refs = ", ".join(item.get("refs") or []) or "-"
        nets = ", ".join(item.get("nets") or []) or "-"
        lines.append(
            f"{item['id']}  [{item.get('source', '?')}/{item.get('severity', 'major')}] "
            f"{item['title']}"
            f"\n     refs {refs}; nets {nets}"
            f"\n     why: {item.get('why', '')}"
            f"\n     evidence: {item.get('evidence', '') or '(none quoted)'}"
        )
    return "\n".join(lines)


def apply_verdicts(findings: list[dict], verdicts: list[dict]) -> tuple[list, list]:
    """Fold the critic's judgement back in, ignoring anything it invented.

    A verdict for an id that was not sent is dropped rather than trusted: it is
    the shape an added finding would take, and the one thing this node may not
    do. A finding the critic did not mention keeps its own severity - silence is
    not a rejection.
    """
    by_id = {item["id"]: item for item in findings if item.get("id")}
    seen: dict[str, dict] = {}
    for raw in verdicts or []:
        if not isinstance(raw, dict):
            continue
        fid = str(raw.get("id") or "").strip()
        if fid not in by_id or fid in seen:
            continue
        verdict = str(raw.get("verdict") or "").strip().lower()
        if verdict not in VERDICTS:
            continue
        seen[fid] = raw

    kept, rejected = [], []
    for item in findings:
        raw = seen.get(item.get("id"))
        if raw is None:
            kept.append(item)
            continue
        verdict = raw["verdict"].strip().lower()
        reason = str(raw.get("reason") or "").strip()
        if verdict == "reject":
            rejected.append(({**item, "verdict": verdict}, reason or "rejected by the critic"))
            continue
        severity = str(raw.get("severity") or "").strip().lower()
        confidence = str(raw.get("confidence") or "").strip().lower()
        updated = {**item, "verdict": verdict}
        if severity in SEVERITIES:
            updated["severity"] = severity
        if confidence in CONFIDENCES:
            updated["confidence"] = confidence
        if verdict == "downgrade":
            updated["severity"] = "informational"
        if reason:
            updated["verdict_reason"] = reason
        kept.append(updated)
    return kept, rejected


def make_critic(client):
    def critic(state: ReviewState) -> dict:
        findings = [
            item
            for item in list(state.get("confirmed", [])) + list(state.get("cross_domain", []))
            if item.get("id")
        ]
        if not findings:
            return {
                "verified": [],
                "coverage": {**state.get("coverage", {}), "critic": "skipped: nothing survived"},
            }

        parsed, info = client.json(
            critic_prompt(_numbered(findings)),
            label="critic",
            system=SYSTEM,
        )
        kept, rejected = apply_verdicts(findings, parsed.get("verdicts"))
        return {
            "verified": kept,
            "rejected": [
                {"finding": item, "because": why, "stage": "critic"} for item, why in rejected
            ],
            "calls": [{**info, "node": "critic", "found": len(kept)}],
            "coverage": {**state.get("coverage", {}), "critic": "ran"},
        }

    return critic

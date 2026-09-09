"""Match findings to injected defects by overlap, never by wording.

**Read the limitation before the numbers.** Overlap cannot tell a finding that
identified a defect from a finding that merely mentioned one of the parts the
defect touches. On this corpus that is not hypothetical: a single flat prompt
scored six of seven, and three of those six were a trace-width observation that
happened to name S1, a power rail observation that happened to name +5V, and a
reset-pin observation that happened to name the MCU. Every catch therefore
records `via`, the identifier the match rested on, and `breadth`, how many names
the finding threw at the board. A reader can then see which catches are real.

Grading exactly would need findings to carry a machine-checkable claim — the
kind of defect, and the specific pin or net it is about — rather than a sentence
plus a bag of references. That is the change the schema needs, and it is the
main thing this corpus has to say about how to score a review.

A finding matches a defect when their component refs or their net names
intersect. Nothing here reads a sentence, because grading on wording would make
the score a measure of how the prompt phrases things.

Three outcomes, and the third is the one that keeps the other two honest:

- **caught** — a finding overlapped the defect;
- **missed** — nothing did;
- **other** — findings that matched no defect. On the clean board every finding
  is one of these, and that number is what decides whether the recall number
  means anything at all. A reviewer that flags everything catches every defect.

`site/review.js` grades the same way in the browser.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
import json


def norm(value: str) -> str:
    return str(value or "").strip().upper().lstrip("/")


def shared(finding: dict, defect: dict) -> list[str]:
    """The identifiers a finding and a defect have in common, if any."""
    refs = {norm(r) for r in defect.get("refs", [])}
    nets = {norm(n) for n in defect.get("nets", [])}
    if not refs and not nets:
        return []
    hit = sorted(refs & {norm(r) for r in finding.get("refs", [])})
    hit += sorted(nets & {norm(n) for n in finding.get("nets", [])})
    return hit


def overlaps(finding: dict, defect: dict) -> bool:
    return bool(shared(finding, defect))


def grade(findings: list[dict], defects: list[dict]) -> dict:
    """One finding can only account for one defect, so a scattergun scores once."""
    claimed: set[int] = set()
    caught, missed = [], []
    for defect in defects:
        hit = next(
            (
                i
                for i, finding in enumerate(findings)
                if i not in claimed and overlaps(finding, defect)
            ),
            None,
        )
        if hit is None:
            missed.append(defect["id"])
        else:
            claimed.add(hit)
            # `via` is what the match rested on. It is recorded because overlap
            # cannot tell "found this defect" from "mentioned this part", and
            # the only way to see which one happened is to read the pair.
            caught.append(
                {
                    "defect": defect["id"],
                    "finding": findings[hit]["title"],
                    "via": shared(findings[hit], defect),
                    "breadth": len(findings[hit].get("refs", [])) + len(findings[hit].get("nets", [])),
                }
            )
    other = [f["title"] for i, f in enumerate(findings) if i not in claimed]
    return {
        "caught": caught,
        "missed": missed,
        "other": other,
        "recall": round(len(caught) / len(defects), 3) if defects else None,
        "false_alarms": len(other),
    }


def refuted(findings: list[dict], board: dict) -> list[dict]:
    """Findings the board itself contradicts, measured rather than judged.

    This is the sharpest number here, because it needs no opinion: a finding
    that says a net is split into islands, on a net whose copper is one piece,
    is wrong and the geometry says so. It is run over both detectors and over
    both what each proposed and what it reported, so the graph gets no credit
    for a stage the baseline does not have — the difference between those two
    columns *is* that stage.
    """
    from graph.nodes.adjudicate import board_facts, contradiction

    facts = board_facts(board)
    out = []
    for finding in findings:
        why = contradiction(finding, facts)
        if why:
            out.append({"title": finding["title"], "because": why})
    return out


def totals(rows: list[dict]) -> dict:
    """The headline: recall over the seeded boards, false alarms on the clean one."""
    seeded = [r for r in rows if r["defects"]]
    clean = [r for r in rows if not r["defects"]]
    caught = sum(len(r["grade"]["caught"]) for r in seeded)
    total = sum(len(r["defects"]) for r in seeded)
    return {
        "boards": len(rows),
        "caught": caught,
        "of": total,
        "recall": round(caught / total, 3) if total else None,
        "false_alarms_on_clean": sum(r["grade"]["false_alarms"] for r in clean),
        "extra_findings_on_seeded": sum(r["grade"]["false_alarms"] for r in seeded),
        "refuted_proposed": sum(len(r.get("refuted_proposed", [])) for r in rows),
        "refuted_reported": sum(len(r.get("refuted_reported", [])) for r in rows),
    }


def corpus_hash(board_hashes: list[str]) -> str:
    """A score that outlives the corpus it measured is worse than no score."""
    return hashlib.sha256("|".join(sorted(board_hashes)).encode("utf-8")).hexdigest()[:12]


def pipeline_hash() -> str:
    """Which detectors ran, so a score cannot outlive the pipeline either.

    `prompt_hash` catches a changed prompt and `corpus_hash` a changed board,
    but adding a whole evaluator moved none of them - the research agent went in
    and every hash stayed identical while the graph's output changed. A sweep
    that silently stops describing the system is the exact failure the other two
    hashes exist to prevent, so the deterministic side gets one too.

    It was a list of rule names, which is not behaviour, and it failed the same
    way it was written to prevent: two sweeps an hour apart reported V8 at 55 of
    65 and at 20 under the same hash, because the report had begun reading a
    field nothing wrote. It now covers the detectors' own code as well.
    """
    from graph.prompts import CLAIM_KINDS
    from harness.checks import RULES
    from harness.datasheet_checks import DATASHEET_RULES
    from harness.dfm import DFM_RULES

    blob = json.dumps(
        {
            "rules": sorted(name for name, _ in RULES),
            "dfm": sorted(fn.__name__ for fn in DFM_RULES),
            "datasheet": sorted(fn.__name__ for fn in DATASHEET_RULES),
            "claims": sorted(CLAIM_KINDS),
            "detectors": _detector_logic(),
        },
        sort_keys=True,
    )
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:12]


#: The modules that turn a board into findings. A change in any of them changes
#: what a sweep measured, whatever the rule names still say.
DETECTOR_SOURCES = (
    "graph/v7.py",
    "graph/build.py",
    "baseline/single_prompt.py",
    "harness/evaluate.py",
)


def _detector_logic() -> dict[str, str]:
    """A fingerprint of each detector's code, ignoring how it is written.

    Names of rules were the whole of this hash, and names are not behaviour.
    Two sweeps an hour apart reported V8 at 55 of 65 and at 20, and carried the
    same pipeline hash, because between them the report had started reading a
    field nothing wrote - a change no list of rule names can see. One of those
    tables was then read as a result, which is the exact failure this hash is
    described as preventing.

    It hashes the parsed syntax rather than the text, with docstrings dropped,
    so rewriting a comment or a docstring does not invalidate a sweep while
    changing a single expression does. Comments never reach the tree at all.
    """
    import ast

    out = {}
    for name in DETECTOR_SOURCES:
        path = ROOT / name
        if not path.exists():
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            body = getattr(node, "body", [])
            if (
                body
                and isinstance(body[0], ast.Expr)
                and isinstance(body[0].value, ast.Constant)
                and isinstance(body[0].value.value, str)
            ):
                body.pop(0)
        out[name] = hashlib.sha256(ast.dump(tree).encode("utf-8")).hexdigest()[:12]
    return out


def schema_hash() -> str:
    """The finding shape plus the operation signatures the corpus was built from."""
    from graph.prompts import SCHEMA
    from harness.ops import OPS

    signature = {name: sorted(fn.__code__.co_varnames[1 : fn.__code__.co_argcount]) for name, fn in OPS.items()}
    blob = SCHEMA + json.dumps(signature, sort_keys=True)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:12]

// The review graph, in the browser. The mirror of graph/build.py.
//
//   ingest        deterministic: distil, run the rule checks. No model asked.
//     |
//   datasheet     what each pin is for, against what it is wired to
//     |
//   connections   the wiring between parts, and off the board
//     |
//   layout        placement and copper
//     |
//   adjudicate    merge the three, then let the board refute what it can
//     |
//   gate          stop, or go round again
//
// Sequential, because the nodes are cheap to reason about in order and the
// interesting part is the loop.
//
// **The gate never asks the model whether it is finished.** If it did, the
// answer would always be yes, and a board with a rule still firing would be
// reported as reviewed. It stops on measurements: nothing for the rules to
// find, or nothing they found still unaccounted for, or the pass budget spent.
//
// One honest difference from the harness. The Groq client keeps the model's own
// `reasoning` alongside its answer; the `sample` capability does not expose
// that, so what this can show is the answer as it streams, what each node
// proposed, and every decision the graph made — but not the private thinking.

import { boardFacts, runChecks, verify } from "./checks.js";
import { approxTokens, distill } from "./distill.js";
import {
  adjudicatePrompt,
  nodePrompt,
  SYSTEM_PROMPT,
} from "./review.js";

export const MAX_PASSES = 2;
export const REVIEWERS = ["datasheet", "connections", "layout"];

export const ROLES = {
  ingest: "Distil the board and run the rule checks. No model is asked anything.",
  datasheet: "What each pin is for, against what it is wired to.",
  connections: "The wiring between parts, and off the board.",
  layout: "Placement and copper.",
  adjudicate: "Merge the three reviews, then let the board refute what it can.",
  gate: "Stop, or go round again — decided on measurements, never on the model's say-so.",
};
export const MEASURED = new Set(["ingest", "gate"]);

/** Coerce whatever came back into the finding shape, dropping junk. */
function normalise(items, source) {
  const out = [];
  for (const item of items || []) {
    if (!item || typeof item !== "object") continue;
    const title = String(item.problem || item.title || "").trim();
    if (!title) continue;
    out.push({
      source,
      severity: ["critical", "major", "minor"].includes(item.severity) ? item.severity : "major",
      ...tidy(item.refs, item.nets),
      title,
      why: String(item.why || "").trim(),
      fix: String(item.fix || "").trim(),
      claim: String(item.claim || "").trim(),
      subject: normaliseSubject(item.subject),
      evidence: String(item.evidence || "").trim(),
    });
  }
  return out;
}

const DESIGNATOR = /^[A-Za-z]{1,3}\d+$/;
const NODE_REF = /^([A-Za-z]{1,3}\d+)\.[A-Za-z0-9_]+/;

/**
 * `S1.4` and `S1.6(VBST)` mean pin 4 and pin 6 of S1. The subject is S1.
 *
 * The same habit `tidy` exists for. Left literal, a subject of `S1.4` is a part
 * that is not on the board, and the critic throws the finding out for a
 * formatting convention — which is exactly what it did to the real defect on
 * `vfb-vbst-swap` the first time this field was wired up.
 */
function normaliseSubject(value) {
  const text = String(value ?? "").trim();
  const node = NODE_REF.exec(text);
  if (node) return node[1];
  const head = text.split("(")[0].trim();
  // Never inside a net name like `unconnected-(J12-Pad3)`, which is real.
  if (DESIGNATOR.test(head)) return head;
  return text.replace(/,$/, "");
}

/**
 * Sort the model's refs and nets into refs and nets.
 *
 * Reviewers write `D2.2` when they mean pin 2 of D2, and put whole node strings
 * in the nets list. Taken literally both look like something that does not
 * exist — which is exactly what the refutation check is for, so without this it
 * throws out correct findings for a formatting habit.
 */
function tidy(rawRefs, rawNets) {
  const refs = [];
  const nets = [];
  const addRef = (value) => {
    let v = String(value).trim();
    const node = NODE_REF.exec(v);
    if (node) v = node[1];
    v = v.split("(")[0].trim();
    if (DESIGNATOR.test(v) && !refs.includes(v)) refs.push(v);
  };
  for (const raw of rawRefs || []) addRef(raw);
  for (const raw of rawNets || []) {
    const value = String(raw).trim().replace(/,$/, "");
    // A net name can contain brackets — `unconnected-(J12-Pad3)` is one — so
    // nothing is stripped here beyond whitespace.
    if (NODE_REF.test(value) || DESIGNATOR.test(value)) {
      addRef(value);
    } else if (value && !nets.includes(value)) {
      nets.push(value);
    }
  }
  return { refs, nets };
}

/** What two findings must share to be the same finding. */
function key(item) {
  return new Set([
    ...(item.refs || []).map((r) => `r:${r.toUpperCase()}`),
    ...(item.nets || []).map((n) => `n:${n.replace(/^\//, "").toUpperCase()}`),
  ]);
}

const overlaps = (a, b) => [...a].some((v) => b.has(v));

/** The typed identity: the same kind of defect about the same thing. */
function claimKey(item) {
  const claim = String(item.claim || "").trim().toLowerCase();
  const subject = String(item.subject || "").trim().toUpperCase().replace(/^\//, "");
  if (!claim || !subject || claim === "other") return "";
  return `c:${claim}|${subject}`;
}

/**
 * Same defect, same subject: one finding. Keep the most severe wording.
 *
 * Two reviewers finding one defect used to collide only if their ref and net
 * lists happened to intersect, so one problem in two wordings survived as two.
 */
function dedupe(items) {
  const rank = { critical: 0, major: 1, minor: 2 };
  const best = new Map();
  for (const item of items) {
    const k =
      claimKey(item) || [...key(item)].sort().join("|") || `t:${item.title.toLowerCase()}`;
    const current = best.get(k);
    if (!current || (rank[item.severity] ?? 3) < (rank[current.severity] ?? 3)) {
      best.set(k, item);
    }
  }
  return [...best.values()];
}

function numbered(items) {
  return items
    .map(
      (item, i) =>
        `${i}. [${item.source}/${item.severity}] ${item.title}` +
        ` (refs ${item.refs.join(", ") || "-"}; nets ${item.nets.join(", ") || "-"})\n   ${item.why}`
    )
    .join("\n");
}

/** Rule findings no confirmed finding overlaps, by ref or net. */
function unaccounted(rules, confirmed) {
  const covered = new Set();
  for (const item of confirmed) for (const k of key(item)) covered.add(k);
  return rules.filter((rule) => !overlaps(key(rule), covered));
}

function gateDecision(rules, confirmed, passes) {
  if (!rules.length) {
    return {
      decision: "stop:nothing-to-chase",
      why: "The rule checks found nothing, so there is nothing for another pass to chase.",
    };
  }
  const left = unaccounted(rules, confirmed);
  if (!left.length) {
    return {
      decision: "stop:rules-accounted-for",
      why: "Every rule that fired has been matched by a confirmed finding, on refs or nets.",
    };
  }
  if (passes >= MAX_PASSES) {
    return {
      decision: "stop:passes-spent",
      why:
        `${MAX_PASSES} passes are the budget and they are spent. Still unaccounted for: ` +
        `${left.map((r) => r.rule).join(", ")}. Reported as a miss, not as a clean board.`,
      left,
    };
  }
  return {
    decision: "again",
    why:
      `The rules found ${left.map((r) => r.rule).join(", ")}, and no confirmed finding ` +
      "overlaps it. Round again — the model is not asked whether it is finished.",
    left,
  };
}

/**
 * Run the graph.
 *
 * `onStep(step)` is called as each one starts and again when it finishes, so
 * the page can show the pipeline moving. `ask(prompt, {onText, signal})` is the
 * one thing this needs from outside — normally `sample.json`.
 */
export async function runGraph(board, ask, { onStep, signal } = {}) {
  const distilled = distill(board);
  const rules = runChecks(board);
  const facts = boardFacts(board);
  const steps = [];

  const emit = (step) => {
    steps.push(step);
    onStep?.(step, steps);
    return step;
  };
  const update = (step, patch) => {
    Object.assign(step, patch, { running: false });
    onStep?.(step, steps);
  };

  emit({
    node: "ingest",
    pass: 0,
    measured: true,
    running: false,
    summary:
      `Distilled the board to about ${approxTokens(distilled)} tokens. ` +
      (rules.length
        ? `${rules.length} rule check${rules.length === 1 ? "" : "s"} fired: ${rules
            .map((r) => r.rule)
            .join(", ")}.`
        : "No rule check fired."),
    rules,
  });

  let proposed = [];
  let confirmed = [];
  let dropped = [];
  let passes = 0;

  for (;;) {
    passes += 1;
    for (const node of REVIEWERS) {
      if (signal?.aborted) throw Object.assign(new Error("cancelled"), { code: "cancelled" });
      const step = emit({ node, pass: passes, measured: false, running: true, stream: "" });
      const answer = await ask(nodePrompt(node, distilled), {
        system: SYSTEM_PROMPT,
        signal,
        onText: ({ text }) => {
          step.stream = text.slice(-600);
          onStep?.(step, steps);
        },
      });
      const found = normalise(answer?.findings, node);
      proposed = proposed.concat(found);
      update(step, { found, stream: "" });
    }

    // Merge: a model judges the wording, because that is a language question.
    const merged = dedupe(proposed);
    const adjudicating = emit({
      node: "adjudicate",
      pass: passes,
      measured: false,
      running: true,
      stream: "",
    });
    let kept = merged;
    if (merged.length > 1) {
      const answer = await ask(adjudicatePrompt(numbered(merged), distilled), {
        system: SYSTEM_PROMPT,
        signal,
        onText: ({ text }) => {
          adjudicating.stream = text.slice(-600);
          onStep?.(adjudicating, steps);
        },
      });
      const picks = Array.isArray(answer?.keep)
        ? [...new Set(answer.keep.map(Number))].filter((i) => i >= 0 && i < merged.length).sort()
        : [];
      if (picks.length) kept = picks.map((i) => merged[i]);
    }

    // Then the board refutes what it can, with no model consulted.
    confirmed = [];
    dropped = [];
    for (const item of kept) {
      const why = verify(item, facts, distilled);
      if (why) dropped.push({ ...item, dropped: why });
      else confirmed.push(item);
    }
    update(adjudicating, { confirmed, dropped, merged: merged.length, stream: "" });

    const gate = gateDecision(rules, confirmed, passes);
    emit({
      node: "gate",
      pass: passes,
      measured: true,
      running: false,
      ...gate,
      rules: rules.map((r) => r.rule),
      unaccounted: (gate.left || []).map((r) => r.rule),
      proposed: proposed.length,
      reported: confirmed.length,
    });
    if (gate.decision !== "again") {
      return { steps, rules, findings: confirmed, dropped, proposed, passes, stopped: gate.decision };
    }
  }
}

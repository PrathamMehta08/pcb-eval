// V8 in the browser. The mirror of graph/v7.py.
//
//   analyse       deterministic: distil the board, run the rule checks.
//     |           No model is asked anything.
//   review        one call, the whole distilled board, findings out
//     |
//   second look   one call: the board again, plus the first pass's own list,
//     |           asked what that list is missing
//   validate      deterministic: is the subject on this board, does the board
//     |           refute it, is it a repeat of one already kept
//   aggregate     deterministic: merge with what the rules measured, rank, score
//
// WHY THIS AND NOT THE SPECIALISTS
//
// The page used to run the shape the harness ran before V7: an ingest, a
// circuit reviewer, a physical reviewer, an adjudicator and a gate that could
// send the reviewers round again. Five sweeps said that arrangement was worse
// than one reviewer holding the whole board. Splitting a board between
// reviewers loses recall, because a reviewer holding half of one speculates
// about the other half.
//
// There is no LLM critic either, and its absence is a measurement rather than
// an omission. Written strictly it rejected every finding it was given; written
// leniently it rejected almost none and still cost two defects across five
// trials. What it was meant to do is done by `validate`, which is string
// comparison against the board rather than a second opinion about it.
//
// THE LEAK, WHICH IS THE POINT OF THE SHAPE
//
// The reviewer is given the distilled board and nothing appended. The second
// look is given the board and the first pass's own findings - never the rule
// findings, never a defect list. A second pass told where the deterministic
// layer already looked is a second pass being handed the answer.

import { boardFacts, runChecks, verify } from "./checks.js";
import { approxTokens, distill } from "./distill.js";
import { reviewerPack } from "./packs.js";
import { buildPrompt, secondLookPrompt, SYSTEM_PROMPT } from "./review.js";

/** One pass. The loop went with the gate that drove it. */
export const MAX_PASSES = 1;

/** The nodes, in the order they run, and what each is for. */
export const NODES = ["analyse", "review", "second_look", "validate", "aggregate"];

/** Which nodes ask a model something. The rest are arithmetic. */
export const ASKS_MODEL = new Set(["review", "second_look"]);

export const ROLES = {
  analyse:
    "Distil the board and run the deterministic checks. No model is asked " +
    "anything, and whatever the rules find is already a finding.",
  review:
    "One reviewer, the whole board. The same prompt the flat-prompt baseline " +
    "is given, so the difference between them is everything around this call.",
  second_look:
    "The same reviewer, shown its own list and asked what it missed. Two draws " +
    "of one reviewer covered more than either alone - that is why this exists.",
  validate:
    "Refuse a finding whose part or net is not on this board, that repeats one " +
    "already kept, or that the copper itself contradicts. No model involved.",
  aggregate:
    "Merge what the reviewer said with what the rules measured, rank, score. " +
    "A measured finding wins a tie: a number beats a sentence about the number.",
};

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
 * Left literal, a subject of `S1.4` is a part that is not on the board, and the
 * validator throws the finding out for a formatting convention.
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
 * exist, which is what the refutation check is for - so without this it throws
 * out correct findings for a formatting habit.
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
    // A net name can contain brackets - `unconnected-(J12-Pad3)` is one - so
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

/**
 * Is this finding one already kept, in other words?
 *
 * V8 unions two passes, and the second is asked not to repeat the first. Asked
 * is not the same as does: with the same board in front of it, the same
 * observation comes back worded differently often enough that the union has to
 * settle it rather than the instruction. Two findings are the same when they
 * make the same typed claim about the same subject, or when their titles are
 * the same words - which is the case the model produces when it restates
 * itself verbatim.
 */
function repeats(item, kept) {
  const claim = String(item.claim || "").trim().toLowerCase();
  const subject = String(item.subject || "").trim().toUpperCase().replace(/^\//, "");
  const title = squeezeTitle(item.title);
  for (const other of kept) {
    if (squeezeTitle(other.title) === title) return `already reported: "${other.title}"`;
    if (!claim || !subject || claim === "other") continue;
    const theirs = String(other.subject || "").trim().toUpperCase().replace(/^\//, "");
    if (claim === String(other.claim || "").trim().toLowerCase() && subject === theirs) {
      return `the same claim about ${subject} was already reported`;
    }
  }
  return "";
}

const squeezeTitle = (text) =>
  String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The first pass's findings, as the second look is shown them. */
function alreadyReported(items) {
  if (!items.length) return "Nothing was reported.";
  return items
    .map(
      (item) =>
        `- ${item.title} (refs ${item.refs.join(", ") || "-"};` +
        ` nets ${item.nets.join(", ") || "-"})`
    )
    .join("\n");
}

/**
 * Run the graph.
 *
 * `onStep(step, steps)` is called as each node starts and again when it
 * finishes, so the page can draw the traversal rather than a spinner.
 * `ask(prompt, {onText, signal})` is the one thing this needs from outside.
 */
export async function runGraph(board, ask, { onStep, signal } = {}) {
  // The board, plus whatever any attached datasheet was read to say. The
  // harness runs offline and its pack is the board alone; the page can do
  // better, and that is the point of attaching a document to a part.
  const distilled = reviewerPack(board);
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
  const stop = () => {
    if (signal?.aborted) throw Object.assign(new Error("cancelled"), { code: "cancelled" });
  };

  emit({
    node: "analyse",
    measured: true,
    running: false,
    summary:
      `Distilled the board to about ${approxTokens(distilled)} tokens. ` +
      (rules.length
        ? `${rules.length} deterministic check${rules.length === 1 ? "" : "s"} fired.`
        : "No deterministic check fired, which is not the same as the board being correct."),
    rules,
  });

  // --- review -------------------------------------------------------------
  stop();
  const first = emit({ node: "review", measured: false, running: true, stream: "" });
  const firstAnswer = await ask(buildPrompt(distilled), {
    system: SYSTEM_PROMPT,
    signal,
    onText: ({ text }) => {
      first.stream = text.slice(-600);
      onStep?.(first, steps);
    },
  });
  const proposed = normalise(firstAnswer?.findings, "review");
  update(first, { found: proposed, stream: "" });

  // --- second look --------------------------------------------------------
  stop();
  const again = emit({ node: "second_look", measured: false, running: true, stream: "" });
  const moreAnswer = await ask(secondLookPrompt(distilled, alreadyReported(proposed)), {
    system: SYSTEM_PROMPT,
    signal,
    onText: ({ text }) => {
      again.stream = text.slice(-600);
      onStep?.(again, steps);
    },
  });
  const more = normalise(moreAnswer?.findings, "second-look");
  update(again, { found: more, stream: "" });

  // --- validate -----------------------------------------------------------
  const all = proposed.concat(more);
  const confirmed = [];
  const dropped = [];
  for (const item of all) {
    const why = repeats(item, confirmed) || verify(item, facts, distilled);
    if (why) dropped.push({ ...item, dropped: why });
    else confirmed.push(item);
  }
  emit({
    node: "validate",
    measured: true,
    running: false,
    confirmed,
    dropped,
    merged: all.length,
  });

  // --- aggregate ----------------------------------------------------------
  // Measured findings go in first, so where a rule and the reviewer describe
  // one defect the merge keeps the measured one.
  const covered = new Set();
  for (const rule of rules) for (const k of key(rule)) covered.add(k);
  const survivors = confirmed.filter((item) => !overlaps(key(item), covered));
  const findings = rules.concat(survivors);

  emit({
    node: "aggregate",
    measured: true,
    running: false,
    reported: findings.length,
    fromRules: rules.length,
    fromReviewer: survivors.length,
    summary:
      `${findings.length} reported: ${rules.length} measured, ` +
      `${survivors.length} from the reviewer.`,
  });

  return {
    steps,
    rules,
    findings,
    dropped,
    proposed: all,
    passes: 1,
    stopped: "stop:one-pass",
  };
}

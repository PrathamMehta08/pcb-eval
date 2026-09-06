// The review: ask Claude about the board as it stands, then grade the answer.
//
// The page calls Claude through the artifact `sample` capability, so no API key
// is embedded and the viewer's own account pays. That is also why all four
// limits below are enforced rather than one:
//
//   1. a cache on the board hash, which removes most repeat spending because
//      visitors re-review the same edit;
//   2. one review per ten seconds;
//   3. 25 per viewer, in localStorage;
//   4. never on load. `sample` asks the viewer for consent on the first call,
//      so an automatic one is both rude and wasteful.
//
// Grading is by overlap of component refs and net names, never by wording. A
// finding matches an edit when their refs or nets intersect. Running against
// the untouched board matters as much as running against a broken one: a
// reviewer that flags everything catches every defect and is worth nothing.

import { distill, PROMPT_VERSION } from "./distill.js";
import { boardHash } from "./ops.js";

export const PROMPT_ID = `review-1/${PROMPT_VERSION}`;
export const MIN_INTERVAL_MS = 10_000;
export const SESSION_CAP = 25;

const CACHE_KEY = "pcb-eval.reviews.v1";
const COUNT_KEY = "pcb-eval.reviewCount.v1";

const SCHEMA = `{"findings": [{
  "severity": "critical" | "major" | "minor",
  "refs": ["S1"],
  "nets": ["/FB", "VBST"],
  "title": "one line naming the defect",
  "why": "one sentence on the consequence"
}]}`;

export function buildPrompt(distilled) {
  return `You are reviewing a two-layer hobby PCB before it is manufactured. It is a
real board: an STM32F103 controller for a pill dispenser, with a TPS563208 buck
converter, an AMS1117 3.3 V LDO, a ULN2003 stepper driver, three servo headers,
an HC-SR04 ultrasonic header and a USB micro-B connector.

Report only defects you can support from the data below. Weigh three things:

1. Connectivity. Pins wired to the wrong net, connectors whose pin order does
   not match the module that plugs into them, inputs with nothing holding them
   at reset, power pins with no source.
2. Parts. Values that cannot be ordered, parts that cannot supply the current
   asked of them.
3. Copper. A net whose pads sit on more than one island is not connected,
   whatever the net list says. Trace width against the current a rail carries,
   at roughly 0.5 mm per amp on 1 oz outer copper for a 20 C rise. Ground
   return and pour coverage.

Do not report style, silkscreen, aesthetics, or anything you would have to
guess at. An empty findings list is the right answer for a board with no
defects, and inventing one is worse than missing one.

Reply with JSON only, no prose around it, in exactly this shape:

${SCHEMA}

Use the exact ref and net strings from the board below in "refs" and "nets", so
findings can be matched to parts of the design. Here is the board.

${distilled}`;
}

// ------------------------------------------------------------------- limits

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A private window or blocked site data. The page works without a cache;
    // it just costs the viewer a call it could have replayed.
  }
}

export const reviewCache = {
  key(hash) {
    return `${PROMPT_ID}|${hash}`;
  },
  get(hash) {
    return readJSON(CACHE_KEY, {})[this.key(hash)] || null;
  },
  put(hash, verdict) {
    const all = readJSON(CACHE_KEY, {});
    all[this.key(hash)] = verdict;
    // Keep the store small enough that a long session cannot fill the quota.
    const keys = Object.keys(all);
    if (keys.length > 60) for (const key of keys.slice(0, keys.length - 60)) delete all[key];
    writeJSON(CACHE_KEY, all);
  },
  size() {
    return Object.keys(readJSON(CACHE_KEY, {})).length;
  },
};

export const budget = {
  used() {
    return Number(readJSON(COUNT_KEY, 0)) || 0;
  },
  left() {
    return Math.max(0, SESSION_CAP - this.used());
  },
  spend() {
    writeJSON(COUNT_KEY, this.used() + 1);
  },
};

// The interval lives in localStorage rather than in a module variable, so a
// reload does not hand the viewer a fresh ten seconds — and so two open copies
// of the page share one clock.
const LAST_KEY = "pcb-eval.lastReview.v1";

export function coolingDownMs() {
  const last = Number(readJSON(LAST_KEY, 0)) || 0;
  return Math.max(0, Math.min(MIN_INTERVAL_MS, MIN_INTERVAL_MS - (Date.now() - last)));
}

// -------------------------------------------------------------------- grading

const norm = (value) => String(value || "").trim().toUpperCase().replace(/^\//, "");

/**
 * Match findings to edits by overlap of refs and nets, never by wording.
 *
 * `expected` is a list of {id, title, refs, nets} taken from what was actually
 * edited, so this grades a preset and a hand-made edit the same way.
 */
export function grade(findings, expected) {
  const caught = [];
  const missed = [];
  const claimed = new Set();

  for (const want of expected) {
    const refs = new Set((want.refs || []).map(norm));
    const nets = new Set((want.nets || []).map(norm));
    const hit = findings.findIndex((finding, i) => {
      if (claimed.has(i)) return false;
      const fRefs = (finding.refs || []).map(norm);
      const fNets = (finding.nets || []).map(norm);
      return fRefs.some((r) => refs.has(r)) || fNets.some((n) => nets.has(n));
    });
    if (hit >= 0) {
      claimed.add(hit);
      caught.push({ expected: want, finding: findings[hit] });
    } else {
      missed.push(want);
    }
  }
  const other = findings.filter((_, i) => !claimed.has(i));
  return { caught, missed, other };
}

// --------------------------------------------------------------------- the call

/** Resolve the capability once. Null means hide the review affordance. */
export async function getSample() {
  if (typeof window === "undefined" || !window.claude?.use) return null;
  try {
    return await window.claude.use("sample");
  } catch {
    return null;
  }
}

export class ReviewUnavailable extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Review the board as it stands.
 *
 * Returns {findings, cached, hash, tokens}. Throws ReviewUnavailable with a
 * code the caller turns into copy: `cooldown`, `capped`, `unavailable`, or one
 * of the capability's own codes.
 */
export async function review(sample, board, { onText, signal } = {}) {
  const hash = await boardHash(board);
  const cached = reviewCache.get(hash);
  if (cached) return { ...cached, cached: true, hash };

  if (!sample) throw new ReviewUnavailable("unavailable", "Claude is not available here.");
  const cooling = coolingDownMs();
  if (cooling > 0) {
    throw new ReviewUnavailable("cooldown", `Another review in ${Math.ceil(cooling / 1000)}s.`);
  }
  if (budget.left() <= 0) {
    throw new ReviewUnavailable(
      "capped",
      `This browser has used its ${SESSION_CAP} live reviews. Presets already reviewed still load from cache.`
    );
  }

  const distilled = distill(board);
  writeJSON(LAST_KEY, Date.now());
  budget.spend();

  let answer;
  try {
    answer = await sample.json(buildPrompt(distilled), {
      modelTier: "default",
      cache: true,
      onText,
      signal,
    });
  } catch (error) {
    throw new ReviewUnavailable(error?.code || "upstream_error", error?.message || String(error));
  }

  const findings = Array.isArray(answer?.findings) ? answer.findings : [];
  const verdict = {
    findings: findings.map((finding) => ({
      severity: ["critical", "major", "minor"].includes(finding.severity)
        ? finding.severity
        : "major",
      refs: Array.isArray(finding.refs) ? finding.refs.map(String) : [],
      nets: Array.isArray(finding.nets) ? finding.nets.map(String) : [],
      title: String(finding.title || "").trim() || "(untitled finding)",
      why: String(finding.why || "").trim(),
    })),
    prompt: PROMPT_ID,
    chars: distilled.length,
    at: new Date().toISOString(),
  };
  reviewCache.put(hash, verdict);
  return { ...verdict, cached: false, hash };
}

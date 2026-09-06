# QA reports

Each build step in `PLAN.md` section 10 is verified by an adversarial reviewer
that reads the spec, measures against the real KiCad source files rather than
against this code's own output, and tries to break what it finds. The role is
defined in [`.claude/agents/pcb-qa.md`](../.claude/agents/pcb-qa.md).

The reports are kept as written, including findings that have since been fixed —
what a review found is worth more than a clean file.

| report | steps | verdict at the time | outcome |
|---|---|---|---|
| [step-1-3.md](step-1-3.md) | extraction | pass with defects | all 8 findings fixed |
| [step-4-8.md](step-4-8.md) | ops, rules, distiller, parity | 1 fail, 2 pass-with-defects | all 15 findings fixed |
| [step-7-11.md](step-7-11.md) | the page | see the report | |

## What it found that a green test suite did not

`python -m tests.run` reported every step passing at each point below.

- **Step 3's check never called the function it tested.** It read the committed
  JSON off disk, and passed with `build()` sabotaged to raise on its first line.
- **`place()` had no test at all** — the one transform every view and every
  copper check rests on. It is now pinned to six pad centres read out of KiCad's
  own plot, in both languages.
- **The review prompt named the part that had just been broken.** The distiller
  took a list of "focus" refs from the edit log and printed the geometry around
  them, ending with the literal word `edited`. Seeded boards were handed the
  answer and the clean board was handed nothing, so neither number in the first
  scored sweep meant anything.
- **Three deterministic rules were pattern-matching the seeded defect.** The
  ultrasonic pinout rule fired only because the designer happened to name the
  nets `/TRIG` and `/ECHO`; rename them and the identical defect passed. The
  servo rule condemned a correct three-wire sensor header. The floating-input
  rule was satisfied by a capacitor, which holds nothing.
- **One edit hashed to two different boards.** Python's `round()` is banker's
  rounding and JavaScript's `Math.round` is half-up, so a five-decimal track
  width diverged — and the board hash is the review cache key.
- **A coverage assertion passed with a component deleted**, because `C1` is a
  substring of `C11`.

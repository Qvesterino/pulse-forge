# Cross-Component Contracts Audit — KYX / Pulse Forge

**Date:** 2026-10-23
**Scope:** the contracts *between* the major subsystems of the DAW — not the behaviour inside any one of them.
**Tree:** `main` at the start of the wave, shared with several concurrent agent sessions.

---

## 0. What this wave is, and what it is not

The previous wave audited the **editor** — what a gesture does to a document. This wave
audits the **seams**: the agreements two subsystems make with each other, where a rule
is written down twice and the two copies can drift apart.

Seven boundaries were examined:

| # | Boundary | The question it answers |
| - | --------- | ------------------------ |
| 1 | UI ↔ project state | Does what the user sees and touches agree with what the document says? |
| 2 | project state ↔ audio engine | Does the engine play what the document describes? |
| 3 | audio engine ↔ plugin host | Does a plugin receive the parameters the model declared? |
| 4 | track ↔ mixer | Does the mixer sum and route what the tracks say? |
| 5 | timeline ↔ transport | Does musical time mean the same thing on both sides? |
| 6 | persistence ↔ runtime model | Does a reloaded project mean the same thing as the one that was saved? |
| 7 | worker ↔ main thread | Does a worker answer the question the main thread asked? |

For each boundary the audit records, per contract: **inputs, outputs, ownership,
lifecycle, nullability, ordering assumptions, error semantics** — and then asks the
question the wave is really about: *do the two sides agree?*

The hunt is for two shapes of problem:

- **Contract drift** — one rule, two computations, and they disagree on some reachable path.
- **Duplicated definitions** — the same rule written in two modules. Drift is then a
  matter of time, not of luck.

### Method

1. **Map first.** The contracts on each boundary were inventoried, with both sides
   named by `file:line`.
2. **Hunt for duplication.** Every rule that appeared twice was compared field by field,
   value by value — units, defaults, clamps, rounding, order of operations.
3. **Check the guards.** The repository already guards a number of these contracts
   (`docs/AGENT-MAP.md` §3, the invariant register). Those were read and their guard
   specs executed, so that "already protected" is a measurement, not an assumption.
4. **Reproduce, then fix.** Every confirmed defect got a failing test first, a minimal
   fix, a regression suite, and a **revert check** — the fix was undone to prove the new
   test actually fails without it.
5. **Stop when the area is healthy.** A boundary with no confirmed defect is reported as
   verified, with the contracts that were checked named. No work was manufactured.

### Rules this wave worked under

- Intended product behaviour is preserved; a change is only made where a defect is
  demonstrated, and then as small, local and reversible a change as possible.
- No test, type, validation, error handling or assertion was weakened to make a check
  pass.
- No unrelated features, no broad rewrites.
- After every meaningful change, the relevant suites were re-run.

---

# SEAM COVERAGE — the ledger

**Date:** 2026-10-15 · **Target:** KYX (`pulse-forge`) · **Rev:** `31cc20ad`+
**Machine-readable form:** `tests/seam-manifest.json` · **Gate:** `scripts/check-seam-coverage.mjs`

---

## Why this exists

Between 2026-10-13 and 2026-10-15, five corrections in KYX were all the same shape: **work that was believed complete, and was not.** Not sloppy work — green, reviewed, merged work.

| Commit     | What was believed                             | What was true                                                                                                               |
| ---------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `e25d7cad` | EQ curve drag worked (16/16 green)            | Tests covered `hitEqBand`/`eqPointToDb` — pure math. The defect was in `onPointerDown`: a click with no drag wrote −1.09 dB |
| `21524e1d` | Reaction bridge fed the ledger                | Tests shaped rows with hand-built docs. The **caller** fed it nothing, so the rows were content-free                        |
| `9d315e41` | Dead-parameter column was measuring the thing | _"was measuring the instrument, not the wiring"_                                                                            |
| `b7c1919c` | Model grammar was pinned                      | The **shipped artifact** no longer loaded                                                                                   |
| `5b551d53` | Manifest matched the build                    | Manifest and validation report had drifted apart                                                                            |

The common shape is a test that asserts a behavior while the defect lives in a **seam the test never enters**. Green tells you the assertion held. It does not tell you the assertion was pointed at the thing that broke.

Note the codebase already _half_ knew this. `scripts/verify-essential-kit.mjs` opens with:

> _"Unit tests prove the slot table and the command. This proves the SURFACE."_

The distinction was understood, written down, and then not applied consistently. This document makes it a ledger with a gate.

---

## The two properties a seam test must have

1. **ENTER** — drive the real entry point (the gesture handler, the dispatcher, the runtime artifact), not an inner pure function.
2. **ASSERT THE NEGATIVE** — prove the _no-op_. A gesture test that only proves the happy path cannot catch "click without drag commits something".

The reference implementation is `tests/eq-curve-gesture.test.tsx`: of 12 specs, **8 are negative** — _"writes nothing while the pointer is still down"_, _"a press and release with no movement writes nothing"_, _"a press that misses every band starts no gesture at all"_, _"a cancelled gesture does not commit"_.

A third property fell out of the mapping and is worth stating:

3. **TRAVERSAL IS NOT ASSERTION.** `tests/ui/IntentPanel.test.tsx` clicks DO IT, so `routeAndExecute` genuinely runs — but it never installs a reaction ledger, so the call no-ops. The test walks the seam and says nothing about it. Passing proves the path exists, not that it works.

---

## The ledger — 16 seams

| Seam                      | Entry point                       | Status                              |
| ------------------------- | --------------------------------- | ----------------------------------- |
| EQ curve gesture          | `EqCurveCanvas.tsx:248`           | ✅ COVERED (9 negative)             |
| Step sequencer paint      | `StepGridEditor.tsx:78`           | ✅ COVERED (5 negative)             |
| Piano roll move/create    | `PianoRoll.tsx:1984`              | ✅ COVERED (3 negative)             |
| Arrangement trim          | `ArrangementPanel` left-trim zone | ✅ COVERED (3 negative)             |
| Arrangement split         | cut tool                          | ✅ COVERED (7 negative)             |
| Model artifact ↔ schema   | shipped manifest vs live grammar  | ✅ COVERED (8 negative)             |
| MCP dispatch              | `tools.ts:2197 executeMcpTool`    | ✅ COVERED (41 files, 145 negative) |
| Arrangement clip move     | clip body drag                    | ⚠️ COVERED_NO_NEGATIVE              |
| Mixer fader               | `controls.tsx:459` shared Slider  | ⚠️ COVERED_NO_NEGATIVE              |
| Piano roll resize         | `PianoRoll.tsx:692` right edge    | ❌ OPEN                             |
| Arrangement fade handles  | fade hit zones                    | ❌ OPEN                             |
| Mixer mute/solo buttons   | `Mixer.tsx:604/615`               | ❌ OPEN                             |
| **Automation point drag** | `ModPanel.tsx:885`                | ❌ **OPEN — largest gap**           |
| Reaction ledger wiring    | `IntentPanel.tsx:4720`            | ❌ OPEN                             |
| Model loader path ↔ disk  | `model-loader.ts:73`              | ❌ OPEN                             |
| MCP → real ProjectStore   | `tools.ts` → store                | ❌ OPEN                             |

**7 COVERED · 2 honest admissions · 7 OPEN.**

### The three that matter most

**`automation-point-drag`** — the only surface in scope with _no pointer dispatch of any kind_. `ModPanel.test.tsx` has four `fireEvent` calls and zero `pointerDown`. It is the gesture most analogous to the EQ defect that shipped broken. _(Recommendation, not implemented — this audit changed no product code.)_

**`reaction-ledger-panel-wiring`** — `tests/reaction-bridge.test.ts` guards the `IntentPanel` call site with a **source-text substring check** (`readFileSync(...IntentPanel.tsx)` + `includes(...)`). A text guard cannot prove behavior: it passes whether or not the call ever fires. Its own header admits this.

**`model-loader-path-vs-disk`** — `intent-model-artifact.test.ts` genuinely compares the shipped manifest to the live grammar. But nothing asserts `MANIFEST_PATH` (`model-loader.ts:73`) resolves to a file that exists. If the constant drifts from the committed filename, the artifact test stays green and the app 404s. **UNKNOWN, not proven broken.**

---

## The gate

```bash
node scripts/check-seam-coverage.mjs     # exit 0 = no false coverage claim
```

A seam may be declared `COVERED` only when all three are true, and the gate verifies each:

- `spec` — the file (or glob) that enters the seam, and it exists
- `seamEvent` — a token that must appear in it (the gesture/call proving entry)
- `negativeSpec` — a substring of the no-op/refusal spec title

`COVERED_NO_NEGATIVE` and `OPEN` are **honest admissions and never fail the gate**. The gate's only job is to stop a _false claim_ of coverage. A gate that demands new work gets disabled; a gate that catches lying stays.

### The gate was falsified before it was trusted

Three rounds, because the first two drafts were wrong:

| Round | Mutation                                                                 | Result                                                                                                                                                            |
| ----- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Declared `automation-point-drag` COVERED, pointed at `ModPanel.test.tsx` | ❌ **EXIT 0 — the gate was fooled.** It counted negative specs _anywhere_ in a file whose tests never dispatch a pointer event. Measuring the file, not the seam. |
| 2     | Re-ran the same mutation after adding `seamEvent`                        | ✅ EXIT 1, naming the right reason: _"never contains ointer — the spec does not enter this seam"_                                                                 |
| 3     | Pointed `negativeSpec` at a phrase in no spec file                       | ✅ EXIT 1, naming the right reason                                                                                                                                |

Round 1 is the one that matters: **had I shipped the first draft, it would have shipped false assurance — the exact disease it was built to prevent.** A mutation had to kill it before I could claim it had teeth.

A fourth round caught me again, and it is worth recording: my first edit broke the manifest's JSON, and the gate went red **for the wrong reason** (a parse error, not the seam check). A gate that is red for the wrong reason is nearly as bad as one that is green for the wrong reason. Fixed and re-run before the result was believed.

---

## What this gate cannot do

**HONEST SCOPE.** It checks naming and file presence. It cannot prove a spec genuinely enters its seam, and it cannot tell a real no-op assertion from a decorative one. A spec could contain `pointerDown` and a title containing "nothing" while asserting nothing meaningful.

The gate bounds _false claims about coverage_. It does not verify behavior. Only a **mutation** does that — deliberately break the production code and confirm the named spec turns red. `eq-curve-gesture.test.tsx` is the model: the auditor temporarily restored the old code and watched exactly two specs go red, which is what makes "12/12 green" mean something there.

---

## How to use it

1. Fixing a seam? Change its status, add the three declarations, run the gate.
2. Cannot cover a seam? Declare it `OPEN`. That is the honest move and the gate is designed to accept it.
3. Covered the seam but have no no-op case? Declare `COVERED_NO_NEGATIVE` and add the case when you can.
4. Adding a new user-facing gesture? Add it to the manifest in the same commit as the feature. The gate only knows about seams someone declared — **a seam nobody lists is a seam nobody checks.**

That last line is the gate's real limit: it is a ledger, and a ledger only knows what has been written down.

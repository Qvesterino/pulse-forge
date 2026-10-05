# AI Strategy — 2026-10-05

The strategic layer. Not another roadmap — this is the layer that decides what
the other roadmaps are _for_. `docs/intent-killer-feature-plan.md` remains the
engineering plan; this document says which game we are playing.

---

## 1. The decision

**Quality is the game.** Control is necessary but not sufficient: we have to
reach SUNO's level or a competitor does it for us. The 30-second film of the
three killer moments, in order, is the spine everything is built to make pass.

Accepted cost: this is the expensive path. The plan's current deprioritisation
of W1/W2 (melody quality) is **reversed** — they are the critical path.

## 2. The hard constraint, stated as arithmetic

Not opinion. Facts:

| Fact                                                  | Number                                | Source                               |
| ----------------------------------------------------- | ------------------------------------- | ------------------------------------ |
| Intent slot-filler model in the browser today         | **6.6 MB**                            | `public/models/intent-model-v1.onnx` |
| Browser budget for ALL lazy AI runtimes               | **650 KB**                            | `AGENTS.md` §4 bundle budgets        |
| A note-level music transformer that sounds like music | **10–100 M params** (~50–200 MB int8) | —                                    |
| SUNO-class audio model                                | **10⁹+ params**                       | —                                    |

**A quality model does not fit in a browser tab. That is arithmetic, not a
roadmap choice.** Any plan that promises SUNO-level quality from a 650 KB lazy
budget is promising something it cannot deliver.

### Therefore

The quality tier is a **local companion process on the user's own GPU** — the
MRT2 path that already exists (`native/mrt2-host/`, `companion/mrt2-windows/`,
`src/generative/providers/mrt2/`, ADR 0012/0013). Not cloud. Not an account.
Still local. A 100 M-param model is a rounding error on any consumer GPU.

This **reconciles** the two things the repo currently keeps in tension: "no
cloud, ever" (anti-goal in the killer-feature plan) and "reach SUNO's level"
(this document). They are compatible only if the heavy model runs on user
hardware.

## 3. The one change that makes it work: note frames must be bidirectional

This is the highest-leverage finding in the audit, and it is structural rather
than incremental.

Today the generative pipeline is strictly one-directional:

```text
notes ──noteStateAtFrame()──▶ GenerativeNoteFrame[] ──wire──▶ companion ──▶ GeneratedAudio
       (conditioning.ts:51,124)                                    (types.ts)   (Float32Array)
```

`noteFrames` appears **only on the input side** — in `conditioning.ts` (built),
`validation.ts` and `protocol.ts` (validated), `mock-provider.ts` and
`companion-provider.ts:254` (read). The sole output type is `GeneratedAudio`
with a `Float32Array`. `GenerativeCapabilities` has seven booleans
(`types.ts:85-91`) and **not one of them says the provider can return notes**.

### Why this is fatal to the "quality" goal

The moment a note becomes audio, editability dies. Tempo is baked into the
sample. Notes become un-addressable. Re-arranging means re-generating. **That is
Suno.** Winning on quality while emitting audio means you lose the only thing
that was ever yours, and you lose it _by construction_.

### The change

Make the note-frame contract bidirectional:

1. `GenerativeNoteFrame` becomes part of the **output**, not only the input.
2. A capability flag `supportsNoteOutput`, mirroring `supportsNoteConditioning`.
3. `framesToNotes()` — the exact inverse of the `noteStateAtFrame()` that already
   exists. Onset (`pitchState === 2`) starts a `NoteEvent`; sustain (`=== 1`)
   extends it; the provider's own choice is `3`.
4. A sibling to `capture.ts`: `captureNotes()` creates instrument tracks and
   patterns through the command layer, instead of `addAudioClip` on a WAV blob.

Why this is tractable rather than research: the forward map is 20 lines and
already shipped, the wire format already carries 128-value frames, and the
inverse of an onset/sustain decoder is a well-defined algorithmic problem. **The
expensive part was never the plumbing — it was that nobody had asked for notes
back.**

### Why this is also the quality strategy

A note-level autoregressive transformer is the cheapest route to musical
quality that does not destroy editability:

- 10–100 M params instead of 10⁹ — trainable, and runnable on a consumer GPU;
- it emits notes, so tempo, arrangement and instrumentation stay live;
- it is compatible with KYX's 22 instruments, groove packs and effect chain,
  which a raw audio model would bypass entirely.

Audio diffusion in the browser is not on the table and should stop being
discussed as if it were. Note-level generation is the lane.

## 4. What has to beat 50 % vs random

W1 failed honestly: the melodic prior v3 scored **chord-tone hit 50.0 % against
random 53.1 %** — worse than a coin flip. The diagnosis on record is that a
per-slot MLP on reconstructed chord context is too weak. Three consequences:

1. **Do not grow the per-slot MLP.** The measurement already answered that.
2. **Sequence model, not per-slot classifier.** A transformer over note tokens
   with full left context is the class that actually models music; per-slot MLP
   cannot see what precedes the note it is predicting.
3. **The gate may itself be miscalibrated — verify this first, it is cheap.**
   The gate compares against a _uniform random_ baseline. The corpus's own most
   frequent degree is very likely well above 53 %, in which case a model scoring
   50 % is not necessarily worse than the data it imitates. Re-measure the
   published model against (a) the corpus degree distribution and (b) the
   always-predict-root baseline. If the model clears either, W1 was mis-graded,
   not merely bad — and that is a completely different follow-up.

`chord-snap.ts` is the safety net that makes this survivable regardless: even a
mediocre model cannot emit a wrong chord tone after snapping. Keep it, and treat
it as the guarantee rather than the aspiration.

## 5. The 30-second film

Three moments, in this order. The order is the argument.

| #   | Moment                                                                                     | What must be true                                             | Status            |
| --- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | ----------------- |
| 1   | _Change the tempo by 4 BPM and the whole mix rebalances itself_                            | the tempo change must reach generated **notes**, not a sample | **blocked on §3** |
| 2   | _One sentence → a finished track → the engine tells you what's wrong → one click fixes it_ | SUNO MODE + section diagnosis + `reviseSection`               | shipped (W0.2)    |
| 3   | _It learns you in 30 seconds_                                                              | A/B → personal ranker, entirely in-app                        | shipped (W3)      |

Moment 1 goes first because it is the proof of the thesis. It is not a feature
among many; it is the assertion that generated content is a live project. It is
also the only one of the three that is currently impossible — which is why it
is first and why §3 is the whole plan.

**Turn each moment into a failing gate, not a demo script.** If moment 1 cannot
be expressed as a test, we do not know whether it is true.

## 6. Kill list

- **No bigger browser ONNX model.** The budget is 650 KB. Arithmetic.
- **No new rule-based verb handlers.** The rule explosion is what produced
  `artists.ts` at 169 KB and `text-parser.ts` at 68 KB. Breadth of demo is not
  generality; it is maintenance debt with a demo attached.
- **No audio diffusion in the browser.** Not a stretch goal — it does not fit.
- **No new roadmap documents.** 33 plan files and 859 KB already. New work lands
  in the existing plan or not at all; see `docs/ROADMAP.md`.
- **Do not break determinism for speed.** Any change to `seed → content hash`
  needs an engine version, as the killer-feature plan's invariant 2 already says.

## 7. How we know

| Metric                                   | Now                                    | Gate                                       |
| ---------------------------------------- | -------------------------------------- | ------------------------------------------ |
| Generated content is note-addressable    | 0 % — all audio                        | frames→notes path exists and round-trips   |
| Companion realtime factor                | p95 35.98 ms, 9 overruns; not promoted | passes the RTX 3060 Laptop 600 s soak      |
| Melodic prior vs a _meaningful_ baseline | 50 % vs uniform random (mis-graded?)   | beats corpus frequency **and** always-root |
| The 30-second film                       | 2 of 3 moments shippable               | all three, in a real browser, recorded     |

## 8. The honest risk

If note-level generation in a local companion does not reach musical quality in
roughly two quarters, "quality is the game" was the wrong bet and the moat is
control alone. **The moment 1 gate is the early-warning instrument**: build it
first, at small scale, and it will tell us early whether the quality tier is
real or aspirational. If it is not working by the time the companion is running
real note output, that is the signal to revisit §1 — not later, and not quietly.

---

_2026-10-05. Facts cited with `file:line` against the working tree. Companion
status from ADR 0012/0013 and the 2026-09-25 RTX 3060 soak. Update this document
when §1 changes — it is the layer that invalidates the others._

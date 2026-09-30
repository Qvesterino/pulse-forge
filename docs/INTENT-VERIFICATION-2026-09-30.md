# INTENT ENGINE / AI-ASSISTED DAW — End-to-End Functional Verification

**Date:** 2026-09-30
**Scope:** `src/intent/*` (text→beat, production, mix, route, conversation, exact-match
verbs) and `src/ai/bridge/*` (recipe → command → document mutation).
**Method:** source trace of the execution chain plus executed regression runs. Not a
prompt review.

---

## 1. The execution chain as actually built

Two distinct systems sit behind the same chat surface, and conflating them is the most
common misreading of this area:

**(a) The AI bridge — recipe-driven, discrete device commands.**
`src/ai/bridge/`

```
prompt
 → findRecipe()            regex intentPatterns over the recipe registry
 → recipe.build(input)     → CommandBatch (pure)
 → executeCommandBatch()   validate + apply, ONE pass over a working copy
 → snapshot Command        one undo entry
```

**(b) The intent pipeline — generative composition.**
`src/intent/` (normalize → text-parser → plan/production/mix/route → commands),
governed by `pipeline.ts` with timeout + circuit-breaker + heuristic fallback, and an
optional local ONNX model behind `model-loader.ts` / `model-ollama.ts`.

The audit below focuses on (a) where the domain-contract guarantees are explicit and
testable, and records (b)'s coverage separately.

---

## 2. Supported intent inventory — AI bridge (14 command kinds)

`BridgeCommandKind` (`src/ai/bridge/types.ts`) is an exhaustive union; the executor's
apply site is closed with `assertNever`, so adding a kind without an executor branch is
a compile error.

| Command                   | Target              | Required                           | Optional / default                                         | Validation                                                            | Resulting DAW action                                   | Failure                                               |
| ------------------------- | ------------------- | ---------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------- |
| `create-instrument-track` | new id + name       | `track.id`, `track.name`           | `instrument` (default `sampler`)                           | id must be free                                                       | appends an instrument track                            | `validation-failed` on empty fields or a duplicate id |
| `sidechain-duck`          | matcher pair        | target + source track              | `duckDb`, `thresholdDb`, `splitFreqHz` (registry defaults) | both tracks must resolve; duck depth capped by `MAX_SENSIBLE_DUCK_DB` | inserts **or retunes** a keyed sidechain on the target | `no-track-match`                                      |
| `compressor`              | matcher + character | target, `character`, `intensity`   | —                                                          | every expanded value must sit inside `COMPRESSOR_RANGES` (see D-2)    | inserts/retunes a compressor, canonical ids only       | `validation-failed` + range in message                |
| `insert-transient`        | matcher             | target                             | intensity                                                  | `TRANSIENT_RANGES`                                                    | transient shaper on target                             | `validation-failed`                                   |
| `reverb`                  | matcher             | target, `space`, `intensity`       | —                                                          | `REVERB_RANGES`; `reverbSpec` must resolve                            | reverb on target                                       | `validation-failed` / `invalid-command`               |
| `delay`                   | matcher             | target, `space`, `intensity`       | —                                                          | `DELAY_RANGES`; `DELAY_SYNC_DIVISIONS`                                | delay on target                                        | as above                                              |
| `haas-widener`            | matcher             | target, `width`, `intensity`       | —                                                          | `HAAS_RANGES`                                                         | stereo widener                                         | `validation-failed`                                   |
| `ms-eq`                   | matcher             | target, `shape`, `intensity`       | —                                                          | `MSEQ_RANGES`; band centres in-window, low < high per channel         | 4-band M/S EQ (repaired — see D-3)                     | `validation-failed`                                   |
| `distortion`              | matcher             | target, `voice`, `intensity`       | —                                                          | `distortionSpec`                                                      | distortion                                             | `invalid-command` on unknown voice                    |
| `eq-corner`               | matcher             | target, `band`, `freqHz`           | —                                                          | band must exist; `clampToSlot` snaps                                  | moves a band frequency                                 | `validation-failed`                                   |
| `eq-carve` / `eq-boost`   | matcher             | target, `band`, `freqHz`, `gainDb` | `q`                                                        | `EQ_BANDS`; band must have a gain id                                  | cut/boost move                                         | `validation-failed` / `invalid-command`               |
| `set-volume`              | matcher             | target, `volumeDb`                 | —                                                          | `dbToGain`, then track clamp                                          | sets track gain                                        | `validation-failed`                                   |
| `set-track-pan`           | matcher             | target, `pan`                      | —                                                          | `PAN_MIN…PAN_MAX`                                                     | sets track pan                                         | `validation-failed`                                   |

Recipes: `punchierDrums`, `snaresVsHates`, `spaciousBass`, `guitarRig` (Malakian +
palm-muted) — 5 recipes over 14 command kinds.

### Intent pipeline (b) — coverage, not exhaustively re-derived here

44 intent spec files under `tests/`, including `intent-e2e-audit` (78 KB),
`intent-e2e-audit2`, `intent-text-parser` (40 KB), `intent-song` (23 KB),
`intent-production-level3`, `intent-sections-fx`, `intent-mix-route`,
`intent-master-decisions`, `intent-loudness`, `intent-preserve`, `intent-stt`,
`intent-async-fallback`, plus the model/ranker/SFT artifact suites. This is the
evidence base for song/arrangement/mix/section intents; re-deriving all of it was out
of scope for this pass and is listed under next targets.

---

## 3. Verified working (execution, not dispatch)

| Property                                           | Evidence                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commands mutate the **domain model**, not UI state | `applyCommand` returns a new `ProjectDocument`; the only thing handed back to the caller is a `snapshot` Command. No component state, no direct engine poking. This is the "Intent Engine → validated command/domain API → execution" contract the objective asks for                                                           |
| Atomicity of multi-step batches                    | validate + apply run in **one pass over a working copy** (`cur`). An early return discards every intermediate mutation, so a failed multi-step intent cannot leave a partially-applied project. This was an explicit earlier fix (two-pass validation reported `no-track-match` for a track the same batch was about to create) |
| One undo entry per AI batch                        | the whole batch is wrapped in a single `snapshot("aiBridgeBatch", …)` command                                                                                                                                                                                                                                                   |
| Purity / determinism                               | `apply` is documented and implemented as a pure function of `doc`; the provider is pure with no I/O. The same prompt + project + preferences yields the same batch                                                                                                                                                              |
| Canonical param ids only                           | every bridge write seeds from `defaultParamsOf(<effect>)` and writes registry ids, so instances survive `normalizeEffects` instead of being silently dropped — the failure mode the slot files exist to prevent                                                                                                                 |
| Explicit failure taxonomy                          | typed codes — `no-recipe-match`, `no-track-match`, `invalid-command`, `project-saturated`, `validation-failed` — with user-facing messages and hints. No silent swallow; "I don't know how to do that yet" is an explicit outcome                                                                                               |
| Bounded defaults                                   | optional params fall back to registry defaults rather than to guesses; duck depth is capped at `MAX_SENSIBLE_DUCK_DB`                                                                                                                                                                                                           |
| Ambiguity is resolved conservatively               | in `exact.ts`, mute/solo **without a target are skipped as too ambiguous**; "everything/all" maps to the MIX family which the applier expands to every track                                                                                                                                                                    |
| No stacking surprises                              | compressors retune rather than stack; a second keyed sidechain on the same pair reuses the existing instance; an existing user-tuned RATIO is only ever deepened, never weakened by a recipe                                                                                                                                    |
| Range correctness against real constraints         | each slot module mirrors the registry's own `ParamDef` ranges, and the range checks run **before** apply, so an out-of-range AI value fails validation instead of reaching the DSP                                                                                                                                              |
| Model layer is fail-safe                           | ONNX/Ollama models run behind timeout + circuit breaker + heuristic fallback; a model failure degrades to the deterministic path rather than throwing into the UI or the audio thread                                                                                                                                           |

**Executed this pass:** 196 tests across `intent-e2e-audit`, `intent-e2e-audit2`,
`intent-mix-route`, `intent-exact`, `intent-master-decisions`,
`intent-async-fallback` — all passing.

---

## 4. Repaired defect

### D-2 — AI bridge compressor whitelist had drifted from the plugin (confirmed, fixed)

**Reproduce:** `npx vitest run tests/ai/bridge/compressor.test.ts` →
`expected [ Array(10) ] to include 'scMode'`.

**Trace through the pipeline.** The failure is _not_ in the prompt or the parser, and
_not_ in the command validation. It is a **plugin-mapping contract** drift:

1. The DE-ESS feature added `scMode` (0=HPF detector, 1=band-pass) and `scBandHz`
   (2000–12000 Hz) to the compressor's `ParamDef` whitelist in
   `src/effects/definitions.ts`, and to the worklet, the node wrapper and the domain
   goldens.
2. `src/ai/bridge/compressorSlots.ts` documents `COMPRESSOR_RANGES` as _"Legal ranges
   mirrored from `compressorParams` in src/effects/definitions.ts"_ — and the
   round-trip test asserts exactly that mirror. The mirror was **not** updated.
3. `applyCompressor` seeds params from `defaultParamsOf("compressor")`, which now
   emits both new keys, so every bridge-written compressor carried two ids its own
   contract did not know about.

**Why it matters beyond the test.** The whitelist is the bridge's _validation surface_.
An unknown key there is precisely the hazard the file's own header warns about
("`normalizeEffects` rebuilds params from the registry whitelist, so an invented key is
silently dropped and the effect does nothing") — here inverted: real keys the AI layer
could not range-check. The `CompressorParamId` union had the same gap, so a de-ess
intent routed through the bridge had no typed path at all.

**Fix** (`src/ai/bridge/compressorSlots.ts`): added `scMode` and `scBandHz` to
`COMPRESSOR_RANGES` (mirroring the registry: `0…1` default 0, `2000…12000` default 6500) and to the `CompressorParamId` union, with a comment recording that the registry
default of 0 keeps classic sidechain behaviour unless a recipe opts in.

**Validation:** `tests/ai/bridge/compressor.test.ts` + `tests/compressor-deess.test.ts`
→ **17/17 pass** (was 1 failing). `tsc --noEmit` → exit 0.

_Note:_ `src/intent/production.ts` already writes `scMode: 1` / `scBandHz: 6500` for
its `deess` production concept, through the command layer rather than the bridge — so
that path was never broken. The drift was isolated to the bridge's mirror.

### D-3 — the M/S EQ intent was a validated, undoable, silent no-op (confirmed, fixed)

**This is the most serious defect found in the whole three-part audit**, and it is the
exact failure the objective names: _a valid command that does not produce the requested
DAW state._

**Reproduce:** `npx vitest run tests/ai/bridge/msEq-param-drift.test.ts` → every param
the bridge writes is a dead key.

**Root cause.** The `msEq` effect was redesigned from a 3-band crossover EQ into a
**4-band M/S EQ** — a low band and a high band on the MID channel and the same two on
the SIDE channel:

| current `msEqParams`           | old ids the bridge still wrote                  |
| ------------------------------ | ----------------------------------------------- |
| `midLowFreq`, `midLowGain`     | `lowFreq`, `lowGain`                            |
| `midHighFreq`, `midHighGain`   | `highFreq`, `midGain`, `highGain`               |
| `sideLowFreq`, `sideLowGain`   | —                                               |
| `sideHighFreq`, `sideHighGain` | `comp`, `soloLow`, `soloMid`, `soloHigh`, `mix` |

`applyMidSideEq` seeds from `defaultParamsOf("msEq")` and then overwrites with the
**old** names. `normalizeEffects` rebuilds params from the registry whitelist, so all
ten old ids were stripped on load. Measured result of asking for a "scooped" M/S EQ:

```
{"midLowFreq":120,"midLowGain":0,"midHighFreq":6000,"midHighGain":0,
 "sideLowFreq":120,"sideLowGain":0,"sideHighFreq":6000,"sideHighGain":0}
```

— every gain at the registry default. The user got a correctly-typed, undoable,
correctly-labelled M/S EQ that did **nothing**.

**Why it survived.** The existing bridge specs asserted against `MSEQ_RANGES` — the
bridge's _own_ stale mirror — rather than against `EFFECT_DEFS.msEq`. The spec and the
bug agreed with each other, so the suite was green. D-2 is the same class: a
hand-maintained mirror drifting from the registry, with tests that validate the mirror
instead of the effect.

**Fix.**

- `MSEQ_RANGES` remapped onto the real 4-band surface, with registry-matching ranges
  (`midLowFreq` 40–500/120, `midHighFreq` 1500–16000/6000, gains ±15 dB/0).
- `MidSideSpec` and `midSideSpec()` remapped. The shape meanings are preserved and
  sharpened: the MID channel carries tone, the SIDE channel carries the width intent —
  which is what makes an M/S EQ worth reaching for. `scooped` = centre low cut + side
  high lift; `vocal-focus` = low cut both sides + side high cut; `bright` = centre high
  lift + side low cut; `balanced` = crossovers move, no gain change.
- `applyMidSideEq` writes the eight live ids.
- The `ms-eq` validator now range-checks each band centre against its own window and
  re-checks low < high per channel. (Structurally the registry guarantees this — low
  bands cap at 500 Hz, high bands start at 1500 Hz — so the check is a guard against a
  future range change, not a live constraint.)
- Removed the now-does-not-exist `comp` / `solo*` / `mix` fields and the stale
  crossover-ordering note; the `haasWidener.invert` never-set guard is unchanged.

**Validation:** `tests/ai/bridge/` → **95/95 pass** (6 files), including the new
`msEq-param-drift.test.ts` and `param-mirror-parity.test.ts`. `tsc --noEmit` → exit 0.

**Cross-check that confirms the diagnosis.** The 4-band `msEq` redesign landed
**2026-09-21** (`450b1f52`). The plugin audit's real-render sweep ran **2026-09-27** and
its M/S EQ row already reports the _new_ ids (`midLowFreq, midHighFreq, sideLowFreq,
sideHighFreq`) with PASS in every column — the sweep was on the correct surface the whole
time. The AI bridge alone kept the old layout for **9 days**. So the failure was never in
the effect; it was one _consumer_ of a renamed param surface, plus a spec that validated
the consumer against itself instead of against the effect. Recorded in
`docs/PLUGIN-AUDIT-2026-09-27.md` § "Delta since this run".

### D-4 — regression guard for the whole defect class

`tests/ai/bridge/param-mirror-parity.test.ts` (new) turns "the mirror mirrors the
registry" from a convention into a **checked invariant**: for all seven `*_RANGES`
tables plus `EQ_BANDS`, it asserts complete coverage, no invented keys, exact
min/max/default agreement, and a default inside its own range. It would have caught
D-2 and D-3 the day they were introduced.

`applyBridgeCommandForTest` was added alongside the existing
`__validateBridgeCommandForTest` so specs can assert the document a single command
actually produces — several kinds (`ms-eq` among them) are reachable only through the
command API, and asserting against the mirror instead of the effect is precisely what
hid D-3.

---

## 5. Unsupported / partial

- **Recipe coverage is narrow by design.** 5 recipes cover device-level mix moves
  (drums, snare/hihat masking, bass, two guitar voicings). Composition, arrangement,
  clip editing, transport, tempo, save/export and preset loading are **not** bridge
  commands — they live in the `src/intent/` pipeline or the UI, and asking the bridge
  for them returns an explicit `no-recipe-match` rather than a guess.
- **No conversation-level undo of a partially-failed batch is needed** — the working-copy
  design makes it unreachable by construction.
- **Keyed compressor requires the worklet.** The native fallback has a single input, so
  `sidechainTrackId` is dropped and the compressor runs un-keyed (still compressing).
  Surfaced through `supportsSidechain(): "worklet-only"`.
- **The bridge does not verify DSP output.** It guarantees a correct, legal, undoable
  _document mutation_; whether the resulting audio is what the user asked for is the
  plugin audit's job (part 2), not the bridge's.

---

## 6. Unsafe or ambiguous behaviours

None found that silently mutate. The design consistently prefers refusal:

- unmatched prompt → `no-recipe-match` with a user-facing message
- matched recipe, absent tracks → `no-track-match` **before** any mutation
- out-of-range value → `validation-failed` naming the parameter and the range
- target-less mute/solo → skipped as ambiguous
- model/runtime failure → heuristic fallback, never a throw into UI or audio

The residual risk is not silent mutation but **silent non-mutation**: a request that
matches no recipe reads as "I don't know how to do that yet", which is correct but can
feel like a dead end. `docs/INTENT-MCP-EXPANSION-PLAN.md` tracks that expansion.

---

## 7. Remaining high-risk areas

1. **Mirror drift was a recurring class, not a one-off** — and D-3 shows it can ship a
   _silently inert_ intent, not just an incomplete one. `COMPRESSOR_RANGES`,
   `MSEQ_RANGES`, `EQ_BANDS`, `SIDECHAIN_RANGES`, `REVERB_RANGES`, `DELAY_RANGES`,
   `HAAS_RANGES` and `TRANSIENT_RANGES` are all hand-maintained mirrors of registry
   `ParamDef`s. D-4 now enforces the seven range tables and `EQ_BANDS`, which closes
   the loop for every effect the bridge can currently write. The remaining exposure is
   a **future** param rename: the parity test will fail loudly, but only if someone
   runs it.
2. **`src/intent/` is large and only partially re-derived here** (`artists.ts` alone is
   170 KB). Coverage is deep in tests but the intent _inventory_ has never been written
   down as a single table; drift there is harder to see than in the 14-command bridge.
3. **The bridge's `no-recipe-match` boundary is regex-driven** — a phrasing that
   matches no pattern is indistinguishable from an unsupported capability.
4. Mixed-source verification: the bridge guarantees legal mutation but not audible
   outcome, so a "correct" command can still be musically wrong. Cross-checking intent
   output against the audio-fit ledger exists but is not wired into the bridge path.

---

## 8. Recommended next expansion targets

1. ~~**Registry↔bridge parity test**~~ — **done this pass** as
   `tests/ai/bridge/param-mirror-parity.test.ts` (D-4).
2. **Write down the `src/intent/` intent inventory** as a table (intent → trigger →
   params → target → action → failure), mirroring §2 for the pipeline side.
3. **DSP-outcome verification for bridge commands**: render a bridge-mutated doc and
   assert the measured change, closing the "dispatch ≠ execution" loop the objective
   calls out. D-3 shows a document-level assertion ("params survive normalize") is
   necessary but not sufficient — a _measured_ assertion would have caught it too.
4. Extend the working-copy atomicity guarantee's regression coverage to a batch whose
   _last_ command fails after several successful mutations (the case that would expose
   a regression to the two-pass design).
5. Consider routing the intent pipeline's plugin-parameter writes through the same
   mirrored range tables, so both systems share one contract.

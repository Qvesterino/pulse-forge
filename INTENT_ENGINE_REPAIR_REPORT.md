# Intent Engine Repair Report

**Task:** Execution-path unification, ONNX integration & reliability repair (architecture-preserving).
**Date:** 2026-09-18 · **Repo:** KYX (`pulse-forge`) · **Scope:** Intent Engine only — no feature expansion, no schema changes, no Audiotool work.

---

## Executive summary

The audit's central hypothesis was confirmed: **the ONNX ranker participated in zero product paths.** The only code that consults the model — `LocalDeterministicProvider.generate()` (async) — had no production caller; every product surface went through `generateSync()` (heuristic-only). The async path existed, was hardened (worker, timeouts, circuit breaker, fallback), and was dead code.

Three further confirmed defects:

1. **IntentPanel generated everything twice** — once in the UI (its own `planGeneration` + `generatePattern` + private invariant check), then again inside `generatePatternCommand`. The validated pattern and the applied pattern could legitimately differ (the command applies the candidate-bank winner, the UI validated candidate 0 only).
2. **Preview and Apply were identical only by determinism.** GenerateDialog and Dice previewed a result, then *regenerated* at Apply. Any doc change between preview and click silently committed different content than the user approved.
3. **Dice's locked path recorded a stale `outputContentHash`** — the provenance hash described pre-lock content, violating the reproducibility contract.

All were repaired with minimal, architecture-preserving changes (7 source files, 5 new test files, 1 e2e helper fix). The canonical interactive path now runs `candidate generation → hard invariants → deterministic repair → heuristic score → ONNX ranking (off/shadow/active) → deterministic fallback`, previews exactly what Apply commits, and cannot race, hang, or degrade when the model is absent.

---

## Root causes and fixes

### 1. ONNX ranker unused by interactive generation

* **Symptom:** `pf:intent-ranker=active` (the default) had no effect on any user-facing generation; only `browser-checks.ts` touched the model.
* **Root cause:** the sole async entry, `LocalDeterministicProvider.generate()` (`src/intent/providers/local.ts`), was never called; `src/intent/pipeline.ts` exposed only the sync path, and every UI/command caller used it.
* **Fix:** new canonical entry `generateAsyncResult()` / `generateAsyncResultFromOptions()` (`src/intent/pipeline.ts`) which runs the async provider path. Product preview/apply surfaces (IntentPanel, GenerateDialog) migrated to it. The sync path remains — documented and deliberate — for direct generate-and-apply flows with no preview (AI Flip), single-candidate surfaces where the async wrapper is a provable no-op (Dice, `candidateCount=1` short-circuits to `generateSync` inside the provider), and offline tooling (golden baselines, datasets, benchmarks) that must stay ONNX-independent.
* **Why architecture-preserving:** same provider, same candidate bank, same invariant/repair gates; the ranker remains optional, worker-isolated, timeout-bounded, behind the circuit breaker; nothing loads the model until the user actually generates.
* **Performance:** the model is consulted only when `candidateCount ≥ 2` and mode ≠ `off`; IntentPanel requests 3 candidates. Node-side candidate-core medians are 3.3–4.9 ms (16/32/64 steps, budget 250 ms); ranker inference is bounded by the existing 400 ms score timeout in a worker, so the interactive path stays off the main thread.

### 2. Duplicate generation in IntentPanel

* **Symptom:** one click ran two full generations; the invariant check validated content that was then thrown away.
* **Root cause:** `src/ui/IntentPanel.tsx` re-implemented `normalizeIntent → planGeneration → generatePattern → inspectPatternInvariants`, then called `generatePatternCommand`, which generated again.
* **Fix:** the panel now parses the text (its only engine-adjacent job) and calls `generateAsyncResult(doc, input, { mode: "apply", signal })`; the returned `GenerationResult` is applied directly via `applyGenerationResultCommand` (below). The status label reads `rankerMode()` from the engine (previously it read `localStorage` directly and reported the wrong default).
* **Why architecture-preserving:** UI orchestrates; all generation/ranking/provenance logic stays behind the Intent Engine boundary; one undo step preserved.

### 3. Preview/apply divergence

* **Symptom:** `Apply` regenerated; identity relied on the doc being unchanged since preview.
* **Root cause:** `generatePatternCommand` generates internally by design; the dialog and dice previewed via a different call.
* **Fix:** new `applyGenerationResultCommand(doc, result, patternName?)` (`src/commands/commands.ts`) installs an **already-generated** `GenerationResult` — no generation inside the command factory or `execute()`. It copies (never mutates) the previewed pattern, applies the same groove/BPM project updates from `result.plan`, and builds the same delta-based `snapshot(...)` command as before (one coherent undo step, collab-safe id-anchored deltas). `generatePatternCommand` now delegates to the same builder — one apply implementation for both flows. IntentPanel and GenerateDialog apply the exact result the user saw.
* **Why architecture-preserving:** commands stay pure and synchronous; undo/redo and serialization semantics unchanged; the pattern object is copied so callers keep owning their preview state.

### 4. Async race exposure

* **Symptom/risk:** moving preview generation to async could let an older request overwrite a newer preview or apply a stale result.
* **Fix:** GenerateDialog's preview runs in an effect guarded by a monotonic request token + `AbortController`; a superseded completion is ignored, a superseded controller is aborted, unmount aborts. The GENERATE button is disabled while a preview is pending or while the previewed options object differs from the current one (reference identity of the memoized options), so a stale result cannot be committed. IntentPanel keeps its busy gate, aborts on unmount, and ignores completions after abort.
* **Why architecture-preserving:** plain request-identity — no global state, no new abstractions.

### 5. Provenance correctness

* **Symptom:** Dice's locked path committed `generation.outputContentHash` computed from **pre-lock** content (the `applyDiceLocks` post-patch path), and there was no guard against a ranker-side *unexpected* exception (feature extraction ran unguarded — a throw there would have rejected generation entirely, violating "model failure never breaks generation").
* **Fix:** (a) the dice preview refreshes the locked pattern's hash through the engine's own `refreshPatternOutputHash` (`src/ui/DiceContext.tsx`, `src/intent/quality.ts`), and the apply path commits that exact pattern; (b) `provider.generate` wraps `rankCandidatesWithModel` — any unexpected model-path exception falls back to the deterministic heuristic bank ranking and records a `ranker-pipeline-error:<reason>` warning (`src/intent/providers/local.ts`, optional `fallbackReason` on `RankerRanking` in `src/ai/ranking/rank-candidates.ts`).
* **Why architecture-preserving:** provenance fields unchanged; the fallback reuses the existing ranking contract; new diagnostics are warnings, not log noise.

### Files changed

| File | Change |
|---|---|
| `src/intent/pipeline.ts` | canonical async entry points + sync-path documentation |
| `src/commands/commands.ts` | `applyGenerationResultCommand`; `generatePatternCommand` delegates to shared apply builder |
| `src/intent/providers/local.ts` | model-path exception → heuristic fallback + truthful warning |
| `src/ai/ranking/rank-candidates.ts` | optional `fallbackReason` on `RankerRanking` |
| `src/ui/IntentPanel.tsx` | canonical path, no duplicate generation, abort/stale guards, engine-API ranker label |
| `src/ui/GenerateDialog.tsx` | async canonical preview, race protection, apply-previewed-result, pending/rejected visibility |
| `src/ui/DiceContext.tsx` | apply reuses previewed result; locks-path hash refresh |
| `tests/e2e/_helpers.ts` | seed `pf-onboarded` in `openHouseTemplate` (repairs pre-existing spec breakage — see "Remaining known limitations") |

---

## Canonical generation path (final, real)

```text
IntentPanel / GenerateDialog (preview + apply surfaces)
    ↓ IntentInput | GenerateOptions
generateAsyncResult()                    [src/intent/pipeline.ts]
    ↓ normalizeIntent → IntentSpec → planGeneration → GenerationPlan
LocalDeterministicProvider.generate()    [src/intent/providers/local.ts]
    ├─ candidateCount ≤ 1 or mode off → generateSync (heuristic; identical content)
    └─ collectCandidates: per-seed generatePattern → attachProvenance
       → inspectPatternInvariants (hard gates) → repairGeneratedPattern (deterministic)
       → refreshPatternQuality
    ↓ rankCandidatesWithModel            [src/ai/ranking/rank-candidates.ts]
       heuristic rankCandidateBank (dedupe + stable sort)
       ├─ off / <2 survivors → heuristic order (source "off"/"fallback")
       └─ feature extraction → worker ONNX (timeouts + circuit breaker)
            ├─ scores ok → shadow: heuristic order (source "model", no influence)
            │              active: 0.6·heuristic + 0.4·model, stable tie-breaks
            └─ any failure → heuristic order (source "fallback")
    ↓ GenerationResult (pattern + provenance + diagnostics)
applyGenerationResultCommand()           [src/commands/commands.ts]
    ↓ snapshot delta command (one undo step)
ProjectStore.execute → normalizeProject → ProjectDocument
```

**Assist (VARY/BUILD/FILL/REPLACE) is intentionally NOT migrated:** it uses its own pure patch pipeline (`src/assist/pipeline.ts`) with its own provenance contract (`PatternAssist`), and deterministic transforms have no model to consult. Dice stays on the sync single-candidate path (identical output; keeps its session/locks/jitter semantics synchronous and race-free).

## Sync vs async behavior

Sync generation still exists, in exactly three places, by design:

1. `generateLocalResult` / `generateLocalResultFromOptions` — the documented single-candidate fast path (used by Dice's live preview and `generatePatternCommand`).
2. `generatePatternCommand` — direct generate-and-apply with **no preview** (ArrangementPanel AI-Flip: `generatePatternCommand` → `stealGrooveIntoPattern` as sequential commands) and scripts/tests.
3. Offline tooling (`ai-baseline`, dataset generation, golden review packs, `ai:performance`) — deterministic and ONNX-independent by requirement.

All preview/apply product surfaces (IntentPanel, GenerateDialog) use the async canonical path. For `candidateCount = 1` (GenerateDialog's current default) the async path provably returns the sync result — the dialog still uses the async entry so the architecture, provenance, and abort semantics are uniform.

## ONNX ranker behavior (verified end-to-end)

| Condition | Behavior | Provenance written |
|---|---|---|
| `off` | model never consulted; heuristic winner | **no `ranker` field** |
| `shadow` | model executes; heuristic winner unchanged | `ranker { mode: "shadow", source: "model" }` (or `source: "fallback"` on failure) |
| `active` | `0.6·heuristic + 0.4·model`, stable sort (score ↓, candidateIndex ↑, hash ↑) | `ranker { mode: "active", source: "model", featureVersion, rankerVersion, modelHash, selectedIndex }` |
| missing model / manifest / worker, timeout, invalid scores, hash mismatch, pipeline exception | heuristic winner, generation never breaks | `ranker { mode, source: "fallback", modelHash: null }` + diagnostics warning (`ranker:fallback:<mode>`, optionally `ranker-pipeline-error:<reason>`) |
| candidate bank dedupes/gate-filters to <2 survivors | heuristic order without consulting the model | `source: "fallback"` (never implies participation) |

The 0.6/0.4 weighting and stable tie-breaking were already pinned by `tests/rank-candidates.test.ts` — unchanged. jsdom always exercises the fallback contract (no Worker); real-model participation is verified in Chromium by `verify-browser.mjs` (ranker check + the now-rank-backed generation flow).

## Preview/apply semantics

Identity is structural, not deterministic-by-convention: the **same `GenerationResult` object** that rendered the preview is handed to `applyGenerationResultCommand`, which installs that pattern (same uid — a regenerated pattern would carry a fresh id). Guards: GENERATE is disabled while the preview is pending or `previewed.options !== currentOptions`. Committed content equals previewed content (pinned at canonical-hash level; `store.execute`'s `normalizeProject` may zero-fill pad rows to the grid — the test compares through the same normalization). One accepted generation = one undo step (delta snapshot; verified).

## Race protection

* **Request identity:** monotonic token per preview/generation request; completions compare tokens and drop stale ones.
* **Cancellation:** `AbortController` per request; provider rejects with `AbortError` before any work; UI aborts in-flight requests on supersede/unmount; aborted completions never touch state or the store.
* **Engine-level determinism:** candidate order derives from `plan.candidateSeeds` and positional score arrays — never promise completion order; overlapping async generations produce identical winners (tested under interleaving).
* **Dice:** remains synchronous (single-candidate ⇒ no model involvement); history order, locks, favorites, jitter and seed chains unchanged; rapid rolls recompute the preview synchronously and Apply reads the latest rendered preview via ref.

## Provenance recorded per path

Every accepted/repaired/fallback proposal carries `generation`: engine id/version, seed, genre/style, grooveId, stepCount, control weights, `inputContentHash`, `outputContentHash`, `intentHash`, normalized `intent` snapshot, `candidateCount` (>1), resolved BPM (when requested), quality diagnostics — plus `ranker { featureVersion, rankerVersion, modelHash, selectedIndex, mode, source }` whenever the ranker path ran. `source` truthfully distinguishes `"model"` from `"fallback"`; `mode: "off"` records nothing. Dice's locked patterns now record a hash of the locked content.

## Tests added / changed

| File | Purpose |
|---|---|
| `tests/intent-async-pipeline.test.ts` (9) | canonical-path determinism; sync≡async for 1 candidate; interleaved-promise stability; **preview/apply identity (same uid, same hashes, no regeneration)**; replace-mode identity through store normalization; one-undo-step; AbortError; provenance off/fallback truthfulness |
| `tests/intent-ranker-active.test.ts` (4) | active mode with controlled model scores (neutral scores preserve heuristic winner; boosted selection deterministic across reruns); shadow mode winner-unchanged; **ranker-pipeline exception degrades to heuristic + truthful warning** |
| `tests/intent-async-fallback.test.ts` (1) | total generator failure through the canonical path → deterministic fallback pattern, `fallbackReason`, no rejection |
| `tests/ui/GenerateDialog.race.test.tsx` (2) | older preview resolving later cannot overwrite newer; pending GENERATE cannot commit stale; apply commits the newer preview exactly once |
| `tests/ui/IntentDiceIdentity.test.tsx` (3) | Dice apply commits the exact previewed pattern (id + hashes); locks path commits previewed locked pattern with truthful hash; IntentPanel end-to-end on a real `ProjectStore`: one undoable command, engine provenance committed, undo restores |
| `tests/e2e/_helpers.ts` | seed `pf-onboarded` so fresh-context specs reach the project browser (repairs pre-existing breakage from the landing-page gate; no behavior assertions changed) |

No existing test was weakened, deleted, or skipped; golden baselines untouched (they target the deterministic generator, which did not change).

## Validation performed (exact commands)

| Command | Result |
|---|---|
| `npx tsc --noEmit` | 0 errors |
| `npx prettier --write <changed files>` | applied |
| `npx vitest run` (full suite) | **287 files · 2804 passed · 0 failures** (109 pre-existing skips; 1 pre-existing unhandled-rejection warning from `tests/ui/JamGate.test.tsx` — files untouched by this task, all 4 of its tests pass; reproduces in isolation) |
| Targeted: intent/dice/ranker/AI/assist/commands/UI suites (19 files) | all pass, incl. 209 pre-existing + 19 new tests |
| `npm run test:browser` (real Chromium, audio + UI + collab) | **231/232 checks passed**; the single FAIL is the boot scenario's *post-export groove sub-check* (persisted EXPORT dock panel intercepts a step right-click after reload) — a script/layout overlap issue after generation, export and reload-preservation had already passed; unrelated to the Intent Engine |
| `npx playwright test 01 03 04` | 01 pass; 03/04 failed only due to the missing `pf-onboarded` seed (proven with a throwaway seeded spec, then fixed in the helper) → **03 and 04 pass** |
| `npm run build` | `tsc` + `vite build` + PWA generation succeed; the final **bundle-size gate fails on `core worklets: 137 > 120 KB` — pre-existing at HEAD** (the kaskada worklet DSP landed in `public/core-worklet.js` = 135.6 KiB at commit `258a342`; no worklet source or import path is touched by this task) |
| `npm run ai:performance` (budget 250 ms) | median 4.9 ms @16 steps · 3.3 ms @32 · 3.9 ms @64 (max 47 ms) |

## §24 self-check (final reliability sweep)

Two competing generation paths? No — one canonical async entry for preview/apply; sync confined to documented no-preview/single-candidate/tooling call sites; one shared apply builder. Preview/Apply divergence? Impossible — the same object is committed. Stale overwrite? Token + abort; deterministic engine under interleaving. ONNX failure into UI? Provider catches; ranker client never throws. False model participation? `source`/`mode` explicit; `off` records nothing. Promise-order selection? Ruled out structurally and by tests. Mutation before acceptance? Generation is pure; only `store.execute` writes. Determinism/invariants weakened? No — hash-equality and invariant tests pin both; `normalizeProject` still gates every commit. Musical output changed without understanding? Dialog and Dice outputs are byte-identical to before; IntentPanel's applied winner was already the bank winner — the only behavioral delta is that the configured ranker can now actually participate, which is the point of the repair. Unnecessary architecture? Two functions, one command factory, one interface field. Scope expansion? One e2e helper seed line, required to make the suite executable.

## Remaining known limitations

* **Bundle-size gate is red at HEAD** (`core worklets 137 > 120 KB`, from `258a342` kaskada worklet growth) — `npm run build` exits non-zero on the final check despite a successful compile/bundle. Out of scope here; needs a worklet-side decision (budget bump or DSP split).
* `tests/ui/JamGate.test.tsx` emits a pre-existing unhandled rejection (async teardown); tests themselves pass. Untouched.
* `verify-browser.mjs` boot scenario leaves the EXPORT dock panel open before its groove sub-check; the persisted panel can intercept pointer events depending on viewport. Script/layout hygiene, pre-existing.
* `y-indexeddb` remains an unused dependency; collab rooms remain server-memory-only (out of scope).
* The async ranker path aborts *result consumption* on `AbortSignal`, but a worker inference already in flight completes inside its own 400 ms bound (bounded waste, no effect on correctness).
* IntentPanel's status label reports the configured ranker *mode*; when the model itself is unavailable, the pattern's provenance (and the `— heuristic fallback` suffix on generation-fallback) is the authoritative record.

## Future work (documented only — NOT implemented)

Dedicated async preview debounce tuning if model-backed candidate banks grow; surfacing `GenerationDiagnostics` warnings in the dialog UI; a fine-grained engine event feed (per-candidate diagnostics for telemetry); persisted collab rooms; multilingual parser v2 / features.v2 / ranker v2 per `docs/intent-engine-roadmap.md`.

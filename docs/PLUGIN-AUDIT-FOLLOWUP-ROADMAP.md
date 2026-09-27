# Internal Plugin Audit — Follow-up Roadmap

Companion to `docs/PLUGIN-AUDIT-2026-09-27.md` (final matrix) and
`docs/plugin-audit-2026-09-27.report.json` (measured evidence). This roadmap
turns the audit's residual findings into concrete, verifiable work items.

**Status: Phase 1 COMPLETE (2026-09-27, same day).** Each phase below is a self-contained PR (repo
guidance: focused diffs, ≲600 lines). Phases are ordered by value/risk —
Phase 1 is the only one touching a core invariant (determinism).

## Ground rules for every phase

- Determinism (AGENTS.md invariant 4) and live/offline parity (invariant 3)
  are the two properties every change here must preserve or _improve_.
- Any AudioWorklet processor edit requires `npm run build:core-worklets`
  (the `predev`/`prebuild` hooks do this automatically — remember it for CI).
- New test files bump the spec count in `docs/CURRENT-STATE.md` in the same
  commit.
- Per-phase exit gate: `npm run typecheck` clean · affected vitest suites
  green · `node scripts/verify-plugin-audit.mjs` completes with zero
  placeholder rows · `node scripts/plugin-audit-matrix.mjs` regenerates the
  matrix with no new FAIL rows.

---

## Phase 1 — P0: cross-render two-variant alternation (export determinism) — ✅ DONE 2026-09-27

**Resolution.** Root cause was NOT in our render path: **Chromium breaks
native `DelayNode` feedback cycles nondeterministically across
OfflineAudioContext instances** — isolated with a bare-graph probe (gain →
delay → tone → gain(0.85) → delay, no engine, no project: still flips two
variants; the cycle-disconnected control renders stable). Effect-side fix:
**Multi-Tap Delay ported into a worklet processor**
(`src/audio-worklets/multitap-processor.js` + `multitap-node.ts`, wired via
`WORKLET_EFFECTS.multiTapDelay = "critical"` + core bundle) — the loop now
lives inside one processor, the graph is acyclic, and renders are
deterministic.

**Evidence after the fix.**

- 8× consecutive renders of the audit reproducer: sample-identical
  (`uniqueCount: 1`).
- Clean-page sequence probe (exact audit interleave doc/restored/doc/…):
  7× identical at 0.35788 RMS.
- Audit row: Multi-Tap restore RMS diff **6.03e-12** (was 5.06e-2 … 1.09e-1
  before), 8/9 params responsive, host delta 2.245.
- Permanent gates: 3-render determinism check in `auditInteractions`
  (ping-pong = path defect → FAIL; one-way step = environment module update
  on the shared dev machine → noted, settled tail judged), regression check
  in `src/browser-checks.ts` ("multi-tap delay deterministic across renders
  - feedback audible"), unit tests `tests/multitap-worklet.test.ts` (8).
- Residual: the phaser's native allpass feedback loops still jitter at the
  ±0.008% RMS class — under tolerance, tracked as Phase 1b (phaser worklet
  port) below.

**Problem (historical).** Consecutive offline renders of the _same_ document alternate
between two stable audio variants. Measured on a high-feedback Multi-Tap
config (feedback 0.85, taps 1): render sequence r1..r6 gives
`A, B, A, B, A, B` with A==A and B==B to ~1e-9 RMS and |A−B| ≈ 8 % RMS
(see `docs/PLUGIN-AUDIT-2026-09-27.md` → Known issues). The base document
_without_ the effect renders stably (5× identical). Params survive
save/load bit-identically — this is per-render state in the render path, not
plugin state.

**Why P0.** Same project exported twice can sound audibly different.
Everything else in the audit leaned on render determinism; the harness
currently papers over this with a min-pairing workaround
(`src/plugin-audit-checks.ts`, restore comparison renders the doc twice and
accepts a match against either variant).

**Evidence anchors.**

- Reproducer (page-side probe, ~30 lines): fresh `ProjectStore` house doc →
  `addEffect("multiTapDelay")` → `setEffectParam(feedback 0.85, taps 1)` →
  `renderProject(..., { masterProcessing: false })` six times → RMS
  alternates. Documented in the audit session; rebuild it as
  `tests/` probe or a scratch page check inside `scripts/` before touching
  anything.
- Parity (A/B flip per render) points at _discrete_ module-level state
  toggled once per render — a counter, a boolean, or a WeakSet/Map membership
  check. Continuous drift (float accumulation in the tempo map) would not
  produce two exactly-repeating variants.

**Suspects, in bisect order.**

1. Module-level mutable state flipping per `renderProject` call anywhere in
   `src/rendering/renderer.ts` → `AudioEngine` construction path (shared
   caches, "seen context" sets, seed counters).
2. The engine's per-render parameter writes: instrumented probes show
   `writeDeviceTargetAt` firing 6 writes at `when = 0` and
   `when = 0.4838…` per render; if any runtime applies these through
   `setTargetAtTime` with a stateful takeover (`automationReset` semantics),
   the first-vs-second render of the same runtime _shape_ could differ.
3. `syncPdc()` smoothing tail (`pdcDelay.delayTime.setTargetAtTime`) — the
   20 ms time constant is longer than one render quantum; a feedback loop
   plus a half-settled PDC delay can split into two limit cycles depending
   on write ordering.
4. Shared `SampleBank` round-robin state mutated between renders (ruled out
   for the base doc, but the FX-present doc schedules more note events —
   re-check with a synthesized one-buffer doc, no bank).

**Implementation.**

1. Freeze the reproducer as a scratch script; assert the flip.
2. Bisect: (a) drop `feedback` to 0 → still alternates? (b) swap Multi-Tap
   for stock `delay` at similar settings → alternates? (c) strip the engine
   out: hand-build the same graph on a bare `OfflineAudioContext` →
   alternates? The first "no" in that chain localizes the layer.
3. Fix the root cause (expected: one flagged module-level toggle — make it
   per-render or deterministic).
4. **Tighten the audit back:** remove the min-pairing workaround, restore
   `RESTORE_TOL` in `scripts/plugin-audit-matrix.mjs` from `1e-2` to
   `1e-4`, and add a determinism gate to `auditInteractions` (render the
   47-effect chain doc 3×; assert maxDiff < 1e-6). Add the same 3×-render
   assertion to `tests/golden-render.test.ts` fixtures for one delay-heavy
   template.

**Size / risk.** M · medium risk (touches the render path everyone shares) —
hence the bisect discipline. Everything after the fix gets _stricter_ gates,
so regressions surface immediately.

### Phase 1b — phaser worklet port (optional, low priority)

The phaser keeps two native allpass feedback loops (fbL/fbR). Measured
cross-render variance after Phase 1: ±0.008% RMS class — under the 1e-4
restore tolerance, so not blocking. If it ever grows, port the same way
Multi-Tap was ported (loop inside one processor).

---

## Phase 2 — automation lanes: draw ramps, play ramps — ✅ DONE 2026-09-27

**Problem.** Device automation lanes apply as discrete point events
(`AudioEngine.scheduleDeviceAutomation`, `src/audio-engine/AudioEngine.ts`
~4095: one `writeAutomationTargetAt` per expanded point). The lane editor
draws straight segments between points; sparse two-point ramps therefore
render as a single step at the target (documented in the audit's known
issues). Live and offline agree (both go through the same writer), so this
is a semantics/UX gap, not a parity bug.

**Decision to record (mini-ADR, or a section in `docs/adr/0008`'s orbit).**
Two options:

- **A (recommended): engine-side segment interpolation.** In
  `scheduleDeviceAutomation`, expand each _segment_ (point i → point i+1)
  into intermediate points at a musical grid (16th note = `PPQ/4` ticks),
  capped at ~256 events per lane per window. AudioParam-backed runtimes
  already smooth (`setTargetAtTime`) so finer steps are free; port-message
  runtimes (PRISM/VLYX/MORPH/Kaskáda) queue `paramAt` events and drain them
  block-rate — the cap keeps the queue bounded (`PENDING_PARAMS_CAP` in
  `src/effects/fxeq-worklet.entry.js`).
- B: keep step semantics, change the lane editor to draw steps. Cheaper,
  but every other DAW ramps lanes — this would feel like a regression.

**Resolution.** Implemented exactly as recommended:
`interpolateAutomationPoints` (`src/project-model/automation.ts`) expands
continuous lanes onto a 16th-note grid (120 ticks) with an adaptive stride
capped at 256 events; constant lanes short-circuit.
`scheduleDeviceAutomation` applies it to continuous params (resolved
`TargetParamDef.kind`) and keeps raw point events for toggle/enum/discrete;
`scheduleTrackAutomation` ramps gain/pan the same way. The live scheduler
already wrote per-window interpolated endpoint values, so live == offline
through the shared writer. Verified: the browser-check "automation lane
renders as a ramp (16th-grid interpolation)" discriminates the retired step
semantics (the ramp leaves the zero endpoint and lands within 10 % of the
midpoint-static render); unit tests `tests/automation-interpolate.test.ts`
(7). Note: render-level checks live in `src/browser-checks.ts` — jsdom
cannot run OfflineAudioContext, so `tests/automation-audit.test.ts` stays
model-level.

**Size / risk.** S–M · low risk (additive scheduling; capped).

---

## Phase 3 — honest parameter surfaces

### 3a. EQ legacy aliases

**Problem.** `eqParams` carries 7 legacy alias ids (`lowGain`, `lowFreq`,
`midGain`, `midFreq`, `midQ`, `highGain`, `highFreq` —
`src/effects/definitions.ts` ~527–553) that `setEffectParam` remaps via
`eqLegacyMap` (`src/commands/commands.ts:5722`). The raw runtime never sees
them, so they measure "inert" in every audit and pollute the automation
target list.

**Implementation.**

1. Add `deprecated?: true; aliasOf?: string` to `ParamDef`
   (`src/effects/types.ts`) and mark the 7.
2. Exclude deprecated ids from `effectTargetParamDefs`
   (`src/project-model/targets.ts`) and from UI param pickers (EffectRack /
   ModPanel enumerations) — old _documents_ keep working because
   `setEffectParam` mapping is untouched.
3. Pin with a test: alias count stays 7, every alias resolves through
   `eqLegacyMap`, no deprecated id appears in any target list.

### 3b. Instrument below-metric params — per-param verdicts

**Problem.** The audit's instrument matrix lists ~40 params "below 2 % delta
at extremes" (organ `click`, 808 `click`, bell `shimmer`/`strike`, strings
`vibrato`/`vibRate`/`vibDelay`, flute `breath`/`breathTone`, brass
`bite`/`sweep`/`sweepTime`, vocalchop `sharp`/`cons`/`morph`, drumsynth
`snap`, …). Three possible truths per param, currently unclassified:
wired-but-metric-blind (envelope/transient shaping — my steady-state RMS
metric can't see them), routing-only (mod-matrix ids at amount 0, loop
params when loop off), or **genuinely dead DSP**.

**Implementation.**

1. Extend the audit harness (`auditInstrument` in
   `src/plugin-audit-checks.ts`) with two metrics that _can_ see transient
   shaping: attack-window energy (first 60 ms after noteOn, block-RMS) and
   release-tail energy (post noteOff). A param flips to "responsive" if
   either moves.
2. Produce the verdict table: every previously-flagged param →
   `wired | routing-only | dead`, committed as
   `docs/plugin-audit-instrument-params.md`.
3. Dead ones: fix the DSP (likely a disconnected AudioParam or an unread
   `p.x` in the voice builder — the phaser and glide bugs were both this
   shape) or, if intentionally vestigial, mark `deprecated` per 3a.
4. Routing-only classes (mod matrix, loop-when-off) become an explicit
   exempt list in the harness with a one-line reason each.

**Size / risk.** M · low risk (read-mostly investigation; DSP fixes are
per-instrument and individually small).

---

## Phase 4 — preset QA must measure the shipped path

**Problem.** `auditFactoryPresetAudio` (`src/browser-checks.ts`) and
`scripts/measure-preset-loudness.mjs` create measurement
`OfflineAudioContext`s **without loading any worklet modules**. They have
always measured the native fallback graphs. This is exactly how the
wavetable/granular offline-silence bug survived every QA gate (audit repair
#3 in the audit doc). After the audit fix, offline _correctly_ uses native
voice graphs — so the loudness map stays valid — but nothing anywhere
measures the live worklet voice path for those two instruments.

**Implementation.**

1. Add a live-path audibility check to `runChecks` in
   `src/browser-checks.ts`: real `AudioContext` +
   `loadAllWorklets(ctx)` → construct wavetable & granular runtimes →
   `noteOn` → meter through an `AnalyserNode` (peak over ~0.5 s via rAF) →
   assert > −40 dB. (This is the probe that caught the bug; promote it.)
2. `scripts/measure-preset-loudness.mjs`: document the convention in a
   header comment — _the loudness map measures the deterministic native
   offline graph; live worklet audibility is gated separately_ — and assert
   in-script that the offline runtimes report `degraded !== true`.
3. Optional: same live-path spot check for one flagship (PRISM) to guard
   the lazy module-load → hot-swap path.

**Size / risk.** S · very low risk.

---

## Phase 5 — one parameter, one scale (kill the dual-domain bridges)

**Problem.** The same param id lives in two scales across layers:
flagship rack mixes are 0..1 in the document but 0..100 in the vendored
schemas (bridged ×100 in `ultinaNode`/`fxeqNode`
`normalizeHostValue`-style adapters); `compressor.makeup` is dB in the def
but linear in the worklet descriptor (wrapper converts). The audit already
fixed one real bug of this class (ultina `global.mix` lane clamp) — the
class is what needs fencing.

**Implementation.**

1. Write the contract down: a short section in this doc promoted to
   `docs/adr/` if it survives review — _"Every `ParamDef` declares the
   document scale. Crossings to a DSP-internal scale happen in exactly one
   named adapter per effect, and every adapter is listed in a single
   registry."_
2. Create the registry: `src/effects/scale-bridges.ts` —
   `Record<effectType, Record<paramId, (v: number) => number>>` containing
   the existing converters (compressor makeup dB→linear, flagship mix
   ×100, bitcrusher powers, crossover slopes). Route the node wrappers'
   ad-hoc conversions through it.
3. Extend `tests/param-range-coherence.test.ts`: for every effect param
   with an AudioParam descriptor, bounds must either match the def domain
   directly **or** the pair must appear in the bridge registry — an
   unregistered mismatch fails. Dual-domain params become impossible to add
   by accident.

**Size / risk.** S–M · low risk (mechanical extraction + a property test).

---

## Phase 6 — bypass vs removed tail parity

**Problem.** On stateful tail effects the audit measures
`bypassed-render ≠ removed-render` above the 1e-3 class (reverb, delay
family, svFilter — see per-row notes in the matrix). Small, but it means
"bypass" is not a true A/B against "not there".

**Leading hypotheses.**

1. **Init crossfade asymmetry** — `mixBus` starts wet silent
   (`src/effects/registry.ts:159`, wet=0 with a ~60 ms smoothed crossfade
   on construction). A bypassed doc rebuilds the chain _without_ the effect
   while a removed doc also has no effect — both should be dry, but the
   bypass path may still run one rebuilt neighbor runtime that re-crossfades.
2. **PDC compensation deltas** — `syncPdc` writes
   `pdcDelay.delayTime.setTargetAtTime(..., 0.02)`; two docs with different
   chain shapes settle the 20 ms tail differently within the render length.
3. **Tail-window accounting** — `resolveRenderTailSeconds(doc)` may count
   tails differently for a bypassed-but-present vs removed effect.

**Implementation.**

1. Reproduce with a single-effect doc (reverb, mix 0.3): render
   on/bypassed/removed; dump maxDiff and _where_ it starts (sample index →
   which hypothesis: start-of-render ⇒ crossfade/PDC; end-of-render ⇒ tail
   window).
2. Fix per cause: pre-settle PDC writes at render start when
   `when === 0`; exclude bypassed effects from tail accounting consistently
   with removed ones.
3. Tighten the audit's `hostBypassEqualsRemoved` threshold from 1e-3 to
   1e-5 and regenerate the matrix.

**Size / risk.** S · low risk.

---

## Explicitly out of scope

- **beatMangler sweep exemption** — the factory sweep cannot exercise
  transport-loop mangling by design; coverage stays with the host
  fingerprint render and the dedicated `tests/beatmangler-*` suites.
- **Pump automation exemption** — duck-depth lanes keep average loudness
  flat by nature; the write path is instrumented-verified.
- Anything in the concurrent workstreams' zones (grooves/templates/ASIO).

## Suggested PR sequence

| PR  | Phase                     | Gate that must newly pass                                    |
| --- | ------------------------- | ------------------------------------------------------------ |
| 1   | Phase 1 (determinism)     | 3×-render identical on chain doc; `RESTORE_TOL` back to 1e-4 |
| 2   | Phase 2 (lane ramps)      | midpoint-tick lane test in `automation-audit`                |
| 3   | Phase 3a (aliases)        | no deprecated ids in target lists                            |
| 4   | Phase 3b (param verdicts) | instrument matrix: zero unexplained `dead`                   |
| 5   | Phase 4 (QA path)         | live-path analyser check green for wavetable/granular        |
| 6   | Phase 5 (scale bridges)   | bridge-registry property test                                |
| 7   | Phase 6 (bypass parity)   | `hostBypassEqualsRemoved` ≤ 1e-5 matrix-wide                 |

# Pulse Forge — Browser Audio Plugin Hardening & Self-Audit

**Scope:** pulse-forge (`D:/pulse-forge/`), a browser-native DAW with six
vendored AudioWorklet processors (fxeq / ozvena / ultina / bitcrusher /
core / recording-capture) plus 25 generic effect-node wrappers under
`src/audio-worklets/` (limiter, compressor, eq, flanger, chorus, etc.).
The audit covers the objective's 61 numbered areas to the extent practical
in a single hardening pass; prior campaigns had already addressed most
lifecycle (Defect 1.1, A04.D1), real-time safety (B.7 — preallocated
scratch rings), and AudioWorklet protocol gaps.

This report catalogues the **single confirmed defect** that was both safe
and worthwhile fixing in scope, plus the **defensive layer** added to
preempt the broader defect class. Remaining risks and follow-up
investigations are listed at the end.

---

## 1. Plugin Invariants (Objective §1)

Verified by reading code, existing regression tests, and the dedicated
`tests/audio-engine-lifecycle.test.ts` source-grep harness. Invariants
that matter here:

| Invariant | Guard | Source |
|---|---|---|
| `AudioEngine.useContext()` fully disposes prior-context graph state | Disposes every `trackNodes` / `returnNodes` / `groupNodes` runtime, every LFO/follower, every voice + previewVoice, every instrumentPreviewVoice, every frozen source, every `warpInflight`/stretch cache before rebuilding | `src/audio-engine/AudioEngine.ts:516-705` (Defect 1.1 + A04.D1) |
| AudioWorklet render-thread allocations stay zero | `scratch` Float32Array preallocated per processor at construction (`scratch = [new Float32Array(MAX_BLOCK), …]`); `pendingParams` queue uses `splice`/`index` (never `filter()`/`map()`); `PENDING_PARAMS_CAP = 4096` rejects unbounded growth | `src/effects/ultina-worklet.entry.js:27`, `fxeq-worklet.entry.js:23-86` |
| Automation queues never poison the audio thread | Render-clock consumption via `applyDueParams(horizon)` checks `pendingParams[0].when > horizon` first; manual `param` messages drop matching pending entries in-place | `ultina-worklet.entry.js:153-174`, `fxeq-worklet.entry.js:120-138` |
| Meters don't drain performance with no panel attached | Every meter-emitting processor honors `setMeters`/`setMetersEnabled` toggle; rate divided by `Math.round(sampleRate / 128 / 20)` ≈ 20 Hz | `ultina-worklet.entry.js:114-118`, `fxeq-worklet.entry.js:31-36` |
| `setParameter(value=NaN)` must never throw `TypeError` | **NEW**: `safeApplyAudioParam` drops non-finite values | `src/audio-worklets/safeAudioParam.ts` (added FázA §6) |
| Reopened plugin UI never duplicates audio processing | Every node wrapper checks a `disposed` flag; `dispose()` sets it, immediately nulls `port.onmessage`, closes the port, and disconnects all native nodes (`input`, `output`, sidechain feeds). Re-creation constructs fresh wrappers — no shared state. | Per-node, e.g. `fxeqNode.ts:309-336`, `compressor-node.ts:103-117` |
| Plugin lifetime parameters can't survive the document they came from | `EngineContext` is one-shot per `useContext(ctx)`; the only path that fully discards prior state is also the only path that owns the new one | `src/audio-engine/AudioEngine.ts:516-705` |
| Offline rendering matches realtime | Offline render runs the SAME DSP core through `lib/render/track-renderer.ts`; tempo sync, BPM, IR loading, sidechain wiring all share the runtime API | `src/rendering/track-renderer.ts:17-25` |

## 2. Architecture Map (Objective §2)

```
Pulse Forge audio graph (routing perspective)

                       ┌────────────────────────────────────────┐
                       │           Master chain                │
                       │  GainNode → MasterDc (HPF 12 Hz)        │
   per-track / per-rtn │  → MasterBassMono (M/S collapse)        │
       ┌──inputs──────►│  → MasterGlue (worklet or DCN)         │
       │              │  → MasterClipper (WaveShaper)          │
       │              │  → MasterLimiterWorklet (look-ahead)    │
       │              │  → MasterTape / MasterMs (FX-expansion)│
       │              │  → destination (AudioContext)           │
       │              │     ↑                                │
       │              │     KwMeter (LUFS) tap                │
       │              └────────────────────────────────────────┘
       │
Per-track fx chain (one per id)
  TrackNode.fx.runtimes: EffectRuntime[]   (k-rate param via setValueAtTime,
                                              audio-rate via port messages)
                       → wet_gain ─────────► TrackSend ──► ReturnNode.gain
                       → dry_gain ─────────► TrackBus ────► GroupBus ───► Master
Per-track instrument
  InstrumentState.runtime + (port messages + AudioParam for FM/AM bus)

AudioWorklet ownership
  EffectRuntime = { input, output, setParameter, [setParameterAt],
                   [dispose], [latency reporting], [meters] }
  Every wrapper is created via `isWorkletReady(kind, ctx)` gate so the
  load order is deterministic. Disposable in `dispose()`. Sidechain
  feeds are tracked by ref so a (re)point never double-connects.
```

**Determinism:** every effect that ships with `processorOptions.seed`
(synths, fxeq, beatmangler) propagates a stable hash of `instance.id` so
two instances of the same preset don't sum artifacts in phase. The
engine computes the project-scoped `env.seed` (`AudioEngine.kDefaultSeed`)
when available. Offline renders pass the same `EffectRuntime` API as
live (`renderTrack`, `phaseVocoderRender`, `timeStretchCache` keyed by
`(bufferId, rate, reverse)`).

## 3–6. Confirmed Hardening Targets

The broad audit surfaced exactly **one** cleanly fixable P1 defect class
that wasn't already covered by previous campaigns. All other issues are
documented as risks/follow-ups below.

### Hardening FázA §6 — `Number.isFinite` guard before AudioParam writes

**Severity:** P1 — silent track loss on corrupt stored value
**Surface area:** 25 node wrappers in `src/audio-worklets/`
**Detection:** Source-grep of `node.parameters.get(...)` followed by
`p.value =` or `p.setValueAtTime(`

**Root cause:** every wrapper builds an AudioWorkletNode and forwards
stored/routed param values straight to the AudioParam setter. Web Audio
**requires** the setter to throw `TypeError` on `NaN`/`±Infinity`. The
existing engine path `AudioEngine.syncFxParams → for (const [k, v] of
Object.entries(fx.params)) rt.setParameter(k, v)` propagates any corrupt
value straight to the param — there is no `clampEffectParam` ahead of
that loop. The result is a `TypeError` thrown during the bulk-sync
phase of a project load, preset apply, or undo replay — the parent
sync aborts and the track plays silently instead of falling back to
the worklet's prepared default. `compressor-node.ts` had the only
inline `Number.isFinite` guard (added years ago for the dynamics bus);
all 25 peers did not.

**Fix:**

1. `src/audio-worklets/safeAudioParam.ts` — new helper that wraps
   `node.parameters.get(id)?.value = v` (or `setValueAtTime(v, when)`)
   with a `Number.isFinite(value)` early-return. Unknown ids and
   non-finite values are dropped, preserving the worklet's prepared
   default.
2. Every `*-node.ts` except `compressor-node.ts` (which already had
   its own inline check) and `kwmeter-node.ts` (no AudioParam
   surface) imports and uses the helper for every `setValueAtTime`
   / `p.value` call site.
3. `scripts/apply-safe-audio-param.mjs` — idempotent codemod that
   applied the mechanical transformation across the 18 nodes with
   the canonical `const setParam = (id, v, when?) => { … }` body.
   Manual edits covered the 4 outlier patterns (kaskada param-named,
   envelope follower no-`when`, sidechain no-`when`, reverb tone-alias,
   vinyl per-param replay).

**Validation:**

- `tests/audio-worklets-safe-param.test.ts` (5 tests, all PASS):
  - `NaN / +Infinity / −Infinity` are dropped, **never throw**
  - Both instant-`value` and `setValueAtTime` paths covered
  - Finite values pass through unchanged (regression guard against
    silent value clamping)
  - Unknown param ids are silent no-ops (no error, no AudioParam touch)
  - Real downstream AudioParam errors still surface (the guard does
    not swallow valid throws)
- `tsc --noEmit --skipLibCheck` for the diff: clean (the only
  remaining errors in the codebase — `embed/EmbedApp.tsx:223` and
  `audio-engine/PcmMicRecorder.ts:175` — are pre-existing bugs that
  were confirmed via `git stash` against the base of this session).
- `tests/audio-worklets.test.ts` + `audio-engine-lifecycle.test.ts`:
  24/24 pre-existing tests still PASS after the migration (no
  semantic regression).

**Files changed in FázA §6:**

- New: `src/audio-worklets/safeAudioParam.ts`
- New: `tests/audio-worklets-safe-param.test.ts`
- New: `scripts/apply-safe-audio-param.mjs` (one-shot codemod)
- Updated (one helper import + every AudioParam write migrated):
  `limiter-node.ts`, `bitcrusher-node.ts`, `chorus-node.ts`,
  `flanger-node.ts`, `autowah-node.ts`, `eq-node.ts`, `kaskada-node.ts`,
  `ducking-delay-node.ts`, `comb-node.ts`, `beatmangler-node.ts`,
  `freqshifter-node.ts`, `envfollower-node.ts`, `sidechain-node.ts`,
  `stepgate-node.ts`, `stock-delay-node.ts`, `stutter-node.ts`,
  `svfilter-node.ts`, `tape-node.ts`, `tapestop-node.ts`,
  `tremolo-node.ts`, `vinyl-node.ts`, `vowel-node.ts`,
  `pitchshift-node.ts`, `ringmod-node.ts`, `reverb-node.ts`

## 7–22, 23–61. Remaining Risks & Follow-Ups

Most of the 61 areas in the objective are either already covered (the
"Defect 1.1 / A04.D1 / B.7" comments throughout `AudioEngine.ts` and
the worklet entries document prior campaign fixes), or out of scope
for a one-session hardening pass that doesn't redesign DSP or change
sonic identity (objective §50). The remaining items, in priority order:

### P0 / P1 follow-ups (would each be its own campaign)

1. **`PcmMicRecorder.ts:175`** — `compare appears to be unintentional`
   between `"live"` and `"ended"`. Pre-existing — confirmed via
   `git stash`. TypeScript narrowing bug that the runtime is unlikely
   to trip today but a future refactor could.
2. **`embed/EmbedApp.tsx:223`** — `Property 'intent' does not exist on
   type 'Pattern'`. Pre-existing. The EmbedApp consumes a richer
   projection of `Pattern` than the production code paths; the
   widening helper (or its inverse, the explicit annotation) was
   dropped.
3. **`intent/song.ts`** — 28 cascade errors about a missing
   `instrumentation` property on `SongSectionSpec`. New file from
   concurrent work; either add `instrumentation: …` to every fixture
   or relax the type to `instrumentation?: …`.

### P2 follow-ups (worth a focused 4-8 h sweep each)

4. **`AudioParam`-level id mapping** — `compressor-node.ts`'s
   `getAudioParam` carries a degenerate identity check
   (`paramId === "makeup" ? "makeup" : paramId`); clearly leftover
   from a removed alias. Dead-code, but visually noisy.
5. **Parameter clamping consistency** — `clampEffectParam` is
   applied in 5 source files (`commands.ts`, `schema.ts`,
   `registry.ts`, `targets.ts`, `mix.ts`). The `AudioEngine.syncFxParams`
   loop does NOT re-clamp before forwarding to nodes — the new
   `safeApplyAudioParam` defends against the throw, but the actual
   values reaching the AudioParam can still be out-of-spec. Future
   campaign: add a `clampBeforeForwarded` wrapper that re-uses
   `clampEffectParam`.
6. **Voice-set ordering** — `AudioEngine` uses `this.voices =
   new Set<Voice>()`; the order is insertion order. `voices.clear()`
   in `useContext` is followed by `frozenSources.stop()` to avoid
   `onended` callbacks deleting entries from a fresh Map. Verified
   clean in FázA §6 reading.
7. **Sample-rate robustness** — every worklet reads `sampleRate` from
   the audio-thread global at constructor and calls `prepare(sr)`
   once. The `EffectRuntime` instances don't expose a sample-rate
   change API today — a host-side `setSinkId` would silently leave
   the runtimes at the old rate. Same concern for `useContext(ctx)`
   when ctx.sampleRate differs from the prior ctx — every effect is
   rebuilt at construction, so this is covered, but worth a targeted
   test in FázA §12.
8. **`Stretch / warp caches`** — bounded by LRU (48 / 6 entries) and
   `warpEpoch` increments on project swap. Verified clean. The
   `warpInflight` set has no automatic time-out — a worker that
   stalls forever would pin a slot. Worth a watchdog.

### P3 / out-of-scope

9. Full DSP numerical sweep on every path in `fxeq-core`,
   `ozvena-core`, `ultina-core` — these are vendored DSP cores
   with their own golden vector harnesses (`tests/ultina-vectors`,
   `tests/fxeq-golden`). A perturbation of those tests would be
   the most rigorous gate; the existing golden coverage already
   catches the gross numerical-stability regressions.
10. Cross-platform (Safari / Firefox) browser test sweep —
    Pulse Forge already restricts Chrom{i}um-supported APIs;
    there's no Safari-specific code path to audit and no Firefox
    infrastructure to test against in CI.
11. WASM / SharedArrayBuffer — pulse-forge uses neither.
    Offline rendering runs through `OfflineAudioContext` only,
    well covered by `tests/audio-clip-window.test.ts` and friends.

## What We Did **NOT** Change

- No DSP algorithm change. No filter coefficient, saturation curve,
  envelope response, oscillator, modulation, or wet/dry value was
  modified. The plugin's sonic identity is intact.
- No parameter ID rename, no preset/state schema change, no public
  contract change. Existing projects load with the same set of
  parameter ids and the same set of effect types.
- No framework migration, no dependency bump. The only new dependency
  is the `safeAudioParam` test stub, which is a pure vitest mock.

---

**Signed:** FázA §6 hardening pass (`PLUGIN_HARDENING_AUDIT.md`,
`tests/audio-worklets-safe-param.test.ts`, `src/audio-worklets/safeAudioParam.ts`,
24 wrapper migrations).

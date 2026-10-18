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

## Round 4 (2026-09-22) — worklet processors & node wrappers

A re-run of the same goal prompt (4 parallel read-only sweeps over the
~40 non-vendored processors + all 30 wrappers, every candidate
hand-verified) found and fixed a further defect cluster the earlier
rounds predated or missed. Full detail in `AGENT_WORK_LOG.md`
(HARDENING R4); summary:

- **P1** ducking-delay `pingpong`/`loopHpfHz` were advertised knobs with
  no `parameterDescriptors` entry — the runtime never delivered them, so
  the controls were silently dead (and the crossfeed loop they arm has an
  fb·1.7 eigenvalue that diverges at the knob max; now capped). Autowah
  Chamberlin SVF diverged at legal settings (no `f·q` stability scaling —
  svfilter had it, autowah didn't); the ±8 clamps masked it as a harsh
  limit cycle. Beatmangler mismatched step lanes produced permanent NaN
  audio.
- **P2** wtvoice `param` allowlist + note-event validation (render-thread
  TypeError, wedged event queue); granular-voice rate-corrected sample
  playback (44.1 kHz uploads played ~+8.8 % sharp — the stored
  `sampleRate` was never applied) + malformed-event boundary validation;
  bitcrusher per-channel hold phase/state (L/R hold grids were offset)
  + NaN-latch guard; flanger/comb rings sized from the runtime sample
  rate; granularfreeze grain positions to Float64; ducking-delay node
  SYNC interception; limiter NaN-latency PDC guard; bitcrusher/chorus
  native AudioParam write guards.
- **P3** gate look-ahead ring flush + mono→stereo mirrors, align-phase
  NaN coercion (stutter/stepgate), vinyl seed 0, per-block closure
  hoists (limiter/chorus), sample-loop `exp` hoists, kwmeter restore-state
  validation.
- **Tests:** `tests/worklet-hardening-r4.test.ts`, 21 regression pins —
  including a true-pitch granular pin (440 Hz ±5 %) that fails both the
  original code AND the first (inverted-ratio) fix attempt, and a
  ping-pong stability soak that discriminates the divergence class.
- **Recorded, not fixed (sonic-change class, needs a listening
  verdict):** reverb allpass delays not sr-scaled (comb delays are);
  compressor RMS detector's hardcoded 0.006 coefficient (~3.8 ms @44.1k
  vs the documented ~8 ms intent).

---

## Round 5 (2026-10-18) — Vocoder DSP boundary + SIBILANCE transfer function

Scope: `src/audio-worklets/vocoder-processor.js` (core-worklet bundle) and the
2-input wrapper, re-audited against the 61 objective areas. Two defects were
reproduced headlessly before any change:

- **P1 — non-finite input poisoned every recursive state permanently.** The 32
  bandpass biquads (carrier + modulator), 32 envelope followers and the
  sibilance chain had no graph-boundary guard. One NaN/Infinity block latched
  them; the next 40 blocks rendered NaN, so the track stayed silent for the rest
  of its life (measured: 128/128 non-finite samples in the last of 40
  post-poison blocks). Fix: per-sample boundary sanitization, matching the
  kaskada/skrutka precedent; a short input array (`undefined` reads) is treated
  as silence too.
- **P2 — SIBILANCE advertised a 500 Hz high-pass that was not one.** The
  recurrence fed back the previous OUTPUT without subtracting the previous LP
  input (`hp[n] = lp[n] − (1−c)·hp[n−1]`), so DC and 60 Hz passed at ~0.52 and
  the top octave was boosted. This leaked low-mid modulator content into the wet
  signal. The correct direct form is the one already used by
  `vinyl-processor.js`: `hp[n] = (1−c)·(hp[n−1] + lp[n] − lp[n−1])`. Measured
  before → after: DC peak 0.2065 → 0.0000; 60 Hz 0.1752 → 0.0338; 18 kHz
  0.1482 → 0.1026; 2 kHz 0.1867 → ~0.35 (the sibilance region is now actually
  passed). The chain also ran only while the knob was above 0.001, so a muted
  passage froze its state and re-enabling replayed it (measured 0.1126 peak);
  it now always tracks the modulator, the output contribution is multiplied by
  the knob, and a modulator disconnect clears it. The sonic change is the
  intended one; no parameter id, range, preset or state schema changed.
- **P2 — k-rate parameter jumps stepped the wet path.** MIX, LEVEL and
  SIBILANCE are block-rate AudioParams, so a knob or automation jump changed the
  whole wet gain in one sample. Measured transition steps: MIX 0→1 0.5000;
  LEVEL 0→+12 dB 0.8336; SIBILANCE 0→1 0.2678. They now glide with a
  per-sample 8 ms one-pole. The same class existed in the coefficient layout:
  Q / BAND / FOCUS / STEREO changes rebuilt the bank in one quantum. Those
  controls now glide with a per-block 15 ms one-pole (STEREO rebuilds only the
  pan fan), and snap to the target when settled so the filterbank stops
  rebuilding. Post-fix transition steps are below 0.02 / 0.15 / 0.08
  respectively; the steady-state endpoints are unchanged (MIX 0 is still
  bit-exact dry). BANDS stays intentionally discrete/immediate.
- **P3 — per-quantum string allocation removed.** Layout detection compared a
  template string built with six `toFixed()` calls on every render quantum
  (~375 short-lived strings/s at 48 kHz). It now compares the number state
  stored on the instance; the filterbank rebuilds only when a smoothed value
  actually moves (pinned).

Tests: `tests/vocoder-hardening.test.ts` (15 specs). Falsifiability: **8 of the
15 went red against the pre-fix processor** (the four invariants plus the three
new transition specs stayed green); against the pre-smoothing processor, the
three de-click specs **and** the layout-glide spec go red. Sibling sweep: the
broken recurrence occurs only in
the vocoder; vinyl's identical chain is the positive reference. The missing
non-finite input guard is still present in most other generic worklets (see
remaining risks) — this pass fixed the vocoder only.

Verification executed: `npx vitest run tests/vocoder-hardening.test.ts
tests/vocoder.test.ts` (25/25), the adjacent suite set
(`tests/plugin-functional-audit.test.ts`, `tests/audio-engine-audit12.test.ts`,
`tests/audio-worklets.test.ts`, `tests/drift-check.test.ts`,
`tests/status-report.test.ts`) (237/237 including the vocoder files), a scoped
strict typecheck and Prettier check (clean; the full-repo gates were blocked by
concurrent untracked specs), `npm run drift:check` (pass), `npx vite build`
(pass, 41.6 s), and `npm run build:core-worklets` (shipped
`public/core-worklet.js` regenerated; 155,849 → 157,203 bytes, +1.35 KB for the
smoothing state). A probe of the SHIPPED bundle measured the MIX 0→1 step at
**0.0013** (0.5 before smoothing). The bundle-size gate still fails on
pre-existing concurrent growth (core worklets 155 > 150 KB; boot path
2267 > 2200 KB).

## Round 6 (2026-10-18) — Generic worklet NaN boundary + BANDS crossfade

### 6.1 Systemic input boundary

The Round 5 finding (one NaN block latches recursive state) was not
vocoder-specific. A sweep of the generic effect fleet found the same missing
guard at the **audio input boundary** of every delay, filter, modulation and
dynamics processor. Each now sanitizes the samples it reads: non-finite values
become 0 before they can enter a ring, biquad memory, envelope follower or LFO
phase. This is a boundary guard, not an output clamp, and it also makes a short
input array (`undefined` reads) behave as silence.

Covered: `apeks`, `autowah`, `bass-harmonic`, `bassbuss-sub`, `beatmangler`,
`capture`, `chorus`, `comb`, `compressor`, `ducking-delay`, `envfollower`, `eq`,
`flanger`, `freqshifter`, `gate`, `granularfreeze`, `kwmeter`, `limiter`,
`multitap`, `pitchcorrect`, `pitchshift`, `prud`, `reverb`, `reverseswell`,
`ringmod`, `sidechain`, `sirka`, `stepgate`, `stock-delay`, `stutter`, `svfilter`, `tape`,
`tapestop`, `transient`, `tremolo`, `vinyl`, `vowel`, `wowflutter`.

Evidence: against the pre-sweep `stock-delay`, a single poisoned block produced
non-finite output from **block 139** onward (139 × 128 / 48 kHz ≈ 370 ms, i.e.
when the 375 ms delay line read the poison). After the guard, the same scenario
runs 220 blocks (~587 ms) with every output sample finite. The shipped
`public/core-worklet.js` and `public/bass-harmonic-worklet.js` bundles were
probed directly and behave the same.

### 6.2 BANDS crossfade

`BANDS` was the last discrete layout control that stepped: 16→8 dropped eight
bands (and changed the band fan and `1/√n` gain) in one sample. It now runs two
complete filterbanks:

- the incoming bank is built from the new count and starts from zero state;
- it runs **silently for 20 ms** so its biquads and envelope followers settle;
- a 25 ms smoothstep crossfade then blends old → new;
- the bank swap happens at the render-quantum boundary;
- a second BANDS change arriving mid-transition is deferred until the first
  fade completes, then fades again (no mid-fade state swap).

The second bank is preallocated and reused, so repeated BANDS changes allocate
nothing on the audio thread. CPU is 2× only for the ~45 ms transition.
Other layout controls (LO/HI/Q/FOCUS/STEREO) keep the Round 5 glides; the
crossfade rebuilds the incoming bank each block so it follows simultaneous
automation.

Tests: `tests/vocoder-hardening.test.ts` now has **18 specs**. The three
crossfade specs prove: one bank per sample in steady state vs two during the
change, the new bank warms before the audible blend, the swap completes after
20 blocks, 8→16 stays finite while the new bands warm, and 16→8→12 defers the
second target instead of swapping mid-fade. `tests/worklet-nan-boundary.test.ts`
adds **36 specs** (one per audio-emitting swept processor; CAPTURE and KWMETER
are guarded too, but have no output channel to assert).

Verification executed on this round: the 8-file targeted suite **276/276**, the
adjacent worklet/parameter set **161/161**, the changed test files typecheck
clean (the full-repo typecheck is currently blocked by concurrent edits in
`src/project-model/schema.ts` and `tests/referential-integrity.test.ts`),
Prettier clean, `npm run drift:check` (pass), both worklet bundles rebuilt and
probed, and `npx vite build` (pass). The bundle-size gate remains red: core
worklets grew to **162,950 bytes (the gate reports 160 KB)** against the 150 KB
budget, of which ~5.7 KB is this sweep + crossfade; the boot path (2268 KB) is
unrelated concurrent growth. That is a deliberate reliability-over-bytes
tradeoff and needs an owner decision (lazy seam or a conscious budget change),
not a silent raise.

Not covered here: instrument voice processors (`wtvoice`, `granular-voice`) and
thread-fed source processors (`pcm-playback`) are outside the generic-effect
boundary; no real-browser or manual listening pass was run.

Bookkeeping: `tests/worklet-nan-boundary.test.ts` is a new spec file. The
commit that adds it must bump the committed spec-file count in
`docs/CURRENT-STATE.md` (and the generated `docs/STATUS.md` / `status.json`)
from 1068 to 1069 — the drift gate counts `git ls-files`, so the working-tree
count stays 1068 until then.

## Round 7 (2026-10-18) — Worklet lazy seam (core budget paid, not raised)

The hardening rounds pushed the core worklet bundle to **162,950 bytes** (gate:
160 KB) against its 150 KB budget. Raising the cap would have hidden the debt;
the worklet is a startup asset, so the correct move was a real seam.

**What moved:** eleven rare/heavy creative effects now live in one on-demand
bundle, `public/fx-extra-worklet.js`: VOCODER, VINYL, BEAT MANGLER, FREQ
SHIFTER, PITCH CORRECT, PITCH SHIFT, REVERSE SWELL, GRANULAR FREEZE, WOW &
FLUTTER, TAPE STOP and STUTTER. They are useful, but no everyday EQ / comp /
delay / reverb chain needs them, and together they were the largest optional
block in core.

**Loader contract:** `LAZY_MODULE_GROUPS` maps each effect type to a physical
module. Requesting any one of the eleven calls `addModule` for
`fx-extra-worklet.js` exactly once (inflight is keyed by module, not type);
success marks **every** type that module registers ready, and `isWorkletReady`
falls back to the module set if a per-type set is ever partial. A project that
never references one of these effects never fetches the 50 KB bundle.

**Latent bug exposed and fixed:** WOW & FLUTTER's factory gated on
`isWorkletReady("tapeSat")` because the type was never in the loader's lists.
That happened to work while both lived in core; with WOW & FLUTTER moved it
would have constructed an `AudioWorkletNode` before its module landed. The
gate is now `"wowFlutter"`, and the type is registered in the loader.

**Measured result (production build):**

| Bundle | Before | After | Budget |
|---|---:|---:|---:|
| core worklets (`bitcrusher` + `core`) | 160 KB | **111 KB** | 150 KB |
| `fx-extra-worklet.js` (lazy) | — | **50 KB** | 64 KB |
| generative player | 3 KB | 3 KB | 4 KB |

`core-worklet.js` is 112,189 bytes; `fx-extra-worklet.js` is 50,948 bytes.
A shipped-bundle probe confirms the seam is real: `core` registers
stock-delay/eq but **not** vocoder/vinyl/wowflutter; `fx-extra` registers all
eleven moved processors, and `dist/fx-extra-worklet.js` is emitted.

**Tests:** `tests/audio-worklets.test.ts` (27) now includes the group contract
(two effects → ONE extra `addModule`, both ready, unrelated types still not
ready) and a structural seam pin (the moved processors are absent from
`core-processor.js` and present in `fx-extra-processor.js`). `loadAllWorklets`
derives its module count from `LAZY_MODULE_GROUP_COUNT`, so a new physical
module updates the assertion instead of rotting it.

**Verification:** `npm run build:core-worklets` (both bundles), `npx vite
build`, `npx vitest run tests/audio-worklets.test.ts` (27/27; the
`oncontextrestored` spec needs more than its 20 s timeout when the dynamic
`AudioEngine` import runs under heavy concurrent load — it passed at 60 s with
no code change), the targeted hardening/loader suites, scoped typecheck and
Prettier, and the bundle probe. The **core worklet gate is now green**
(111/150). The remaining size-gate failure is the **studio boot path**
(2270 > 2200 KB), which is JS anchor debt (App/curated-layer/ledger) and cannot
be paid by a worklet seam; it needs the separate eager-diet work.

Bookkeeping: the committed spec-file count is now 1080 (concurrent waves took
it from 1068). Three specs are still untracked — `tests/worklet-nan-boundary.test.ts`,
`tests/mobile-profile.test.ts` and `tests/mobile-packaging.test.ts`; the commit
that adds them must bump 1080 → 1083.

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

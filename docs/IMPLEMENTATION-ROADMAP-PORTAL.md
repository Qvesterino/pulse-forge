# PORTAL — Spectral Delay / Resonator

**Status:** `IMPLEMENTED — see accepted ADR 0038 and the current source/tests`
**Type:** implementation roadmap
**Display name:** `PORTAL` (collision-checked 2026-10-11 against all 54 effect names — free)
**Area:** new core effect, AudioWorklet DSP, lazy worklet packaging
**Prepared:** 2026-10-11
**Planning baseline:** `cc7e3409`

> This is the historical implementation handoff. The four decisions listed in
> §12 were resolved in `docs/adr/0038-portal-spectral-delay.md`; that ADR and
> the source/tests are authoritative for shipped behavior. The proposed values
> and F0–F5 sequence below are retained as design history, not pending work.

---

## 0. What this is

A new first-party AudioWorklet effect: a **streaming STFT spectral delay / resonator**.
Audio is decomposed into overlapping frames, each bin is delayed and fed back
independently in the frequency domain, and the result is resynthesised with
overlap-add.

Working name **PORTAL** follows the in-house brand convention
(PRISM, VLYX, VOID, RYFT, MORPH, SKRUTKA, KOREŃ, ZENIT, PRED, ŠRKA, APEKS, SIRKA, PRÚD).

This document is the **handoff**: every file, every gate, and every known trap is
named here. A future session should be able to execute F0–F5 from this file alone.

---

## 1. Measurement first — what already exists

The starting premise was _"FFT infra already exists (kaskada/ozvena), it's CPU-heavy and niche."_
**That premise was measured and it is wrong in two of three places.** This section is the
evidence, because the plan below is built on the corrected picture.

| Candidate           | What the premise assumed | What it actually is                                                                                                                                   | Verdict                    |
| ------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| **kaskada** (RYFT)  | an FFT delay             | 43.5 KB **time-domain** ring buffer: dual ring buffers, cubic-Hermite fractional read, per-channel biquad EQ cascade, tanh drive with 2× oversampling | **No FFT anywhere**        |
| **ozvena** (VOID)   | spectral DSP             | `ozvena-core/dsp/fftPartitioned.ts` = uniform-partitioned **convolution** (Gardner 1994) for IR reverb. FFT yes — but convolution, not STFT-frame DSP | FFT, wrong shape           |
| **ultina** `fft.ts` | a full FFT               | `// @ts-nocheck`, vendored, **magnitude-spectrum only** for analysis. No IFFT                                                                         | Not reusable for synthesis |

### 1.1 What IS reusable

Two assets, both real, both already proven in this codebase:

1. **`src/effects/ozvena-core/dsp/fft.ts`** — a complete radix-2 FFT **with IFFT**
   (conjugate trick), precomputed bit-reversal + twiddle tables, `hannWindow()`,
   allocation-free at steady state, with a plan cache.

   It is **vendored** — `Do not edit by hand`, reconcile via `scripts/vendor-ozvena.mjs`.
   **But it is importable, and the precedent already exists:**
   `src/audio-engine/phase-vocoder.ts:33` imports `fft, hannWindow, isPow2` from it directly.
   Importing it (not copying it) is what keeps golden vectors consistent across the repo.

2. **`src/audio-engine/phase-vocoder.ts`** — Laroche–Dolson STFT: `princarg`,
   Catmull-Rom fractional frame read, hop control, overlap-add with
   **sum-of-squares normalisation**.

   This is the skeleton of a spectral delay. What it does **not** have:
   realtime streaming, any spectral-domain operation, or per-bin feedback.

### 1.2 The corrected statement

> STFT analysis + synthesis with overlap-add **exists** — but as an
> **offline full-buffer utility running in a Web Worker**, not as realtime
> worklet DSP.

That is not "we already have the infra". That is **half** of it. The missing half is
the realtime streaming path and the spectral-domain operation itself.

---

## 2. Packaging: why this CANNOT go in the core bundle

Measured 2026-10-11 against `scripts/check-bundle-size.mjs`:

```
bitcrusher-worklet.js    1,0 KB
core-worklet.js        147,8 KB
                     ─────────
total                 148,8 KB   of   150 KB   (CORE_WORKLET_BUDGET_KB, :241)
free space              1,2 KB
```

**1,2 KB of headroom.** A spectral processor needs FFT plans, window tables,
OLA ring buffers and a per-bin delay array — orders of magnitude more than that.

And there is a precedent in the repo's own history:
`check-bundle-size.mjs:235-240` records that **kaskada's 32-band spectral DSP is what
forced the core budget from 120 → 150 KB**. Spectral DSP has already filled this
bundle once. There is no third time.

### 2.1 Decision: LAZY worklet

PORTAL ships as its own lazy worklet, following the MORPH / KOREŃ / SKRUTKA pattern:

- own esbuild entry → own `public/spectral-worklet.js`
- own `scripts/build-spectral-worklet.mjs`
- new `LazyWorkletType` in `LAZY_WORKLET_TYPES` + a `LAZY_MODULE_URLS` entry
  (both must be edited together or `tsc` fails)
- own budget row in `check-bundle-size.mjs`

Existing per-worklet budget rows to copy the shape from:
`tsar` 48 KB (`:384`), `bass-harmonic` 24 KB (`:400`), `kopa` 32 KB (`:418`),
`skrutka` 16 KB (`:434`).

---

## 3. Duplication guard — PORTAL vs Shimmer

**`shimmer` is the closest neighbour and it is a hard overlap risk.** It is checked
here explicitly because the failure mode is shipping two effects that do the same job.

**Shimmer is a pure native Web Audio graph** (`src/effects/registry.ts:2342-2372`):
highpass + `WaveShaper` saturation + `DelayNode(0.11 s)` + feedback gain + lowpass +
a fixed pitch shift. **No FFT, no worklet.** Its `SHIFT` param is ±12 **st**, constant.

|                    | Shimmer (existing)                            | PORTAL (proposed)                    |
| ------------------ | --------------------------------------------- | ------------------------------------ |
| Mechanism          | native delay + fixed pitch shift + saturation | STFT, per-bin delay + feedback       |
| Frequency tracking | none — shift is uniform                       | per-bin, follows the material        |
| Partial behaviour  | smeared octave halo                           | individually tuned, ringing partials |
| Selectivity        | no — TONE is a single highpass/lp pair        | per-bin resonance, band-focusable    |
| DSP boundary       | native graph                                  | AudioWorklet (ADR 0004)              |

**Rule for the panel copy and the ADR:** PORTAL must never be describable as
"Shimmer, but better". If the pitch cannot be stated as _selective, partial-level
control_, it is a duplicate and should not be built.

---

## 4. File layout (new, first-party)

Modelled on `src/effects/morph-dynamics-core/`.

```
src/effects/spectral-core/
  contracts/parameterIds.ts        typed param id constants
  contracts/parameterSchema.ts     ParamDef-compatible schema, single source
  contracts/state.ts               serialisable processor state
  contracts/meters.ts              meter frame contract
  dsp/SpectralProcessor.ts         streaming STFT engine (public surface)
  dsp/stft.ts                      framing, windowing, OLA, latency accounting
  dsp/spectralDelay.ts             per-bin delay lines + feedback
  dsp/resonator.ts                 per-bin complex one-pole resonance
  dsp/dspUtils.ts                  denormal + non-finite guards
src/effects/spectral-worklet.entry.js        → public/spectral-worklet.js
src/audio-worklets/spectral-node.ts         main-thread wrapper (EffectRuntime)
scripts/build-spectral-worklet.mjs
src/ui/PortalPanel.tsx                      optional, see §9
tests/spectral-golden.test.ts
tests/spectral-soak.test.ts
docs/adr/00XX-portal-spectral-delay.md
```

FFI to the vendored FFT: `import { fft, hannWindow, isPow2 } from "../ozvena-core/dsp/fft.js"`
— the same import line `phase-vocoder.ts:33` already uses.

---

## 5. Proposed parameters

Draft values. `ParamDef` lives in `src/effects/types.ts:3-21` (NOT in `definitions.ts`).
Formatters `formatMs / formatHz / formatDb / formatPct / formatSec` at `definitions.ts:32-46`.

| id           | label        | min |   max | default | unit  | taper | note                                                                                     |
| ------------ | ------------ | --: | ----: | ------: | ----- | ----- | ---------------------------------------------------------------------------------------- |
| `mode`       | `MODE`       |   0 |     2 |       0 | —     | —     | enum: `DELAY` / `RESONATOR` / `FREEZE`                                                   |
| `time`       | `TIME`       |  20 |  2000 |     320 | `ms`  | `log` | spectral delay length                                                                    |
| `sync`       | `SYNC`       |   0 |     5 |       0 | —     | —     | enum: off, 1/4, 1/8, 1/8T, 1/16, 1/16T                                                   |
| `feedback`   | `FDBK`       |   0 |     1 |    0.55 | —     | —     | **hard-clamped, see §6.5**                                                               |
| `decay`      | `DECAY`      |   0 |     1 |     0.5 | —     | —     | per-bin envelope time constant                                                           |
| `resonance`  | `RESO`       |   0 |     1 |    0.35 | —     | —     | resonator Q, mode-gated (label aligned to the 3 other `resonance` params in the catalog) |
| `focus`      | `FOCUS`      |  20 | 18000 |    1200 | `Hz`  | `log` | band the resonator concentrates on                                                       |
| `focusWidth` | `WIDTH`      | 0.1 |     4 |       1 | `oct` | —     | octaves around focus                                                                     |
| `shift`      | `SHIFT`      | -24 |    24 |       0 | `st`  | —     | pitch region fed back; positive shifts raise the repeats                                 |
| `diffuse`    | `DIFF`       |   0 |     1 |     0.3 | —     | —     | per-bin random phase drift seed                                                          |
| `freeze`     | `DELAY HOLD` |   0 |     1 |       0 | —     | —     | discrete ON/OFF latch for DELAY mode; FREEZE mode holds automatically                    |
| `drive`      | `DRIVE`      |   0 |     1 |       0 | —     | —     | post saturation                                                                          |
| `tone`       | `TONE`       | -24 |    24 |       0 | `dB`  | —     | post tilt                                                                                |
| `mix`        | `MIX`        |   0 |     1 |    0.35 | —     | —     | wet/dry                                                                                  |

`diffuse` must not call `Math.random()` directly — see §6.7.

---

## 6. DSP traps specific to this effect

`docs/NEW-EFFECT-CHECKLIST.md` exists because the audit found shipped bugs of exactly
this shape. The generic five are in that file. These are the ones a spectral delay
adds on top:

### 6.1 Overlap-add normalisation

Sum-of-squares normalisation, as in `phase-vocoder.ts`. Without it: wobble and
pumping that no parameter sweep will explain.

### 6.2 Latency is real and must be declared

Report the STFT engine's measured latency, `fftSize - hop`, and post it to the
main thread, as `morph-dynamics-worklet.entry.js` does (`postLatency()`). Delay
PORTAL's dry path by the same number of samples so dry/wet blends stay aligned;
the host can then compensate the rest of the project through PDC. Do not report
only the hop size or hide the latency.

### 6.3 Frame-size-changing parameters are k-rate only

A parameter that changes FFT size or hop must be applied **once per block**, never
per sample. PORTAL reads each control once per render quantum, so each descriptor
must explicitly declare `automationRate: "k-rate"`; the Web Audio default is
`a-rate`. Per-sample application of a block-rate coefficient is checklist bug #4
(vowel/svfilter glides ran ~100× slow).

### 6.4 Denormals in per-bin feedback

A per-bin recursive state with feedback is the exact shape of the `multitap`
incident. **Flush the recursive state BEFORE storing it.** Checklist bug #4, second
paragraph.

### 6.5 Non-finite guard on the feedback path

Spectral feedback is the ideal place for an explosion — a single Inf in one bin
poisons every bin through the delay ring. Clamp per bin every frame, and treat
`feedback` as a bounded, contractive value (§5 marks it hard-clamped).

### 6.6 Bypass must preserve source samples and declared latency

An AudioWorklet that outputs silence at `mix = 0` is the phaser wet-chain incident
(checklist bug #1). PORTAL's dry path is latency-aligned with the STFT, so the
expected bypass is zeroes for the declared latency followed by bit-exact source
samples. Test that contract in both the source processor and shipped bundle.

### 6.7 Determinism

No `Math.random()` outside `hashString(doc.id|ownerId|fx.id|<prefix>-dsp-v1)`.
Changing the seed formula re-rolls the random DSP of every saved project — read
`tests/seed-stability.test.ts` before touching it.

### 6.8 Offline port-message delivery

Chromium does not pump processor message queues mid-render. If any parameter arrives
via `postMessage`, it renders **silent offline**. Either schedule up front in
`processorOptions` or gate the worklet path behind `!offlineRenderContext(ctx)`.

---

## 7. Phases and gates

Each phase has a gate that must pass before the next one starts.

### F0 — ADR

**Gate:** ADR merged in `docs/adr/`.
Records: lazy-worklet decision (§2), category decision (§12.1), FFT reuse (§1.1),
and the Shimmer boundary (§3). Mirrors the structure of ADR 0037 (which established
that the `EffectType` union is additive and needs no `SCHEMA_VERSION` bump).

### F1 — DSP core + golden vectors

**Gate:** `tests/spectral-golden.test.ts` green.
Port the OLA skeleton from `phase-vocoder.ts`, implement `stft.ts`, then
`spectralDelay.ts` and `resonator.ts`. Golden vectors are **bit-exact** expectations,
in the shape of `tests/skrutka-golden.test.ts` / `tests/bass-harmonic-golden.test.ts`.
Run these **before** any UI exists — this is where the DSP is honest.

### F2 — Worklet wrapper + build

**Gate:** `npm run build:spectral` produces `public/spectral-worklet.js`;
`npm run build` budgets pass; add the new budget row.
Mirror `morph-dynamics-worklet.entry.js` — block copying, parameter messaging
(immediate + time-stamped automation queue, `PENDING_PARAMS_CAP = 4096`),
meter posting, latency posting.

### F3 — Registration

**Gate:** `npm run typecheck` EXIT 0; `npm run test` green; `npm run goldens:capture` run.
See §8 for the surface. **Run the golden capture here, not in F5** — the aggregate
`effectDefaults` case fails the moment the effect is registered, and finding that out
after five phases is wasted time.

### F4 — Panel (optional)

**Gate:** `npm run test:browser` green.
PORTAL gets a usable generic editor **for free** (§9). A bespoke panel is a
deliberate upgrade, not a registration requirement.

### F5 — QA + docs

**Gate:** soak green, `npm run drift:check` EXIT 0, `npm run format:check` clean,
`npm run test:expectations` EXIT 0, `docs/CURRENT-STATE.md` updated.

---

## 8. Registration surface

### 8.1 Hard failures — these will break the build

| #   | Surface                                         | Location                             | Failure if missed                                                                             |
| --- | ----------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------- |
| 1   | `EffectType` union                              | `src/project-model/types.ts:19-72`   | TS: `Record<EffectType,…>` unsatisfied                                                        |
| 2   | `EFFECT_META` entry                             | `src/effects/definitions.ts:2585`    | `plugin-functional-audit.test.ts:57-60`                                                       |
| 3   | `EFFECT_DEFS` entry                             | `src/effects/registry.ts:3751`       | `plugin-functional-audit.test.ts:57-60`                                                       |
| 4   | `CORE_EFFECT_ORDER`                             | `src/effects/definitions.ts:266`     | `plugin-functional-audit.test.ts:62-72` — effect exists but is **undiscoverable in the menu** |
| 5   | `LAZY_WORKLET_TYPES` + `LAZY_MODULE_URLS`       | `src/audio-worklets/loader.ts:32,35` | `tsc` — const array and `Record` must be edited together                                      |
| 6   | display name globally unique                    | —                                    | `plugin-functional-audit.test.ts:92`                                                          |
| 7   | param ids + labels unique within the effect     | —                                    | `plugin-functional-audit.test.ts:165-166`                                                     |
| 8   | `docs/CURRENT-STATE.md` → `**Effects**` 54 → 55 | `:17`                                | `npm run drift:check` — bold number is machine-parsed                                         |
| 9   | golden recapture                                | `npm run goldens:capture`            | `domain-goldens.test.ts:42` — `effectDefaults` becomes 55 entries                             |

**Not required:**

- **`SCHEMA_VERSION` bump** — ADR0037 establishes the `EffectType` union is additive
  and effect instances normalize against `EFFECT_META`.
- `src/ui/effectEditorRegistry.ts` — see §9.
- `src/ui/dockLayout.ts` — see §9.

### 8.2 Opt-in lists — the quiet failure mode

Two test files use **hand-maintained lists**. An effect missing from them is
**not** flagged — CI is green and the effect is untested.

| File                                        | List                | Currently                                                                |
| ------------------------------------------- | ------------------- | ------------------------------------------------------------------------ |
| `tests/param-range-coherence.test.ts:53-90` | `EFFECT_PROC_PAIRS` | 36 pairs                                                                 |
| `tests/fallback-graph-knobs.test.ts:28`     | `FALLBACK_TYPES`    | 7 entries (reverb, compressor, sidechain, chorus, delay, bitcrusher, eq) |

Extend both deliberately. Buying false confidence here is the same defect shape as
`try/catch` around a missing export — a green guard that hides a real absence.

### 8.3 Contract details worth knowing

- `EffectDefinitionMeta` (`definitions.ts:2577-2582`) is exactly
  `type / name / category / params`. There is **no blurb field**.
- `category` union is `"tone" | "dynamics" | "character" | "space" | "movement"`.
- Param clamp contract (`plugin-functional-audit.test.ts:304-317`): min/max clamp to
  themselves, out-of-range clamps to bounds, and **`NaN` / `±Infinity` → `p.default`**.
- `WORKLET_EFFECTS` (`registry.ts:202-256`) declares severity separately
  (`"critical" | "degraded"`) — declare PORTAL `"degraded"`.
- Factory pattern (`registry.ts:3736-3747`):
  ```ts
  factory(ctx, instance) {
    if (isWorkletReady("portal", ctx)) return createPortalNode(ctx, instance);
    return bypassRuntime(ctx, "AudioWorklet unavailable — PORTAL bypassed (1:1 signal)");
  }
  ```
  `bypassRuntime`'s reason string is load-bearing: `fallback-graph-knobs:173-180`
  requires `degraded === true` **and** a non-empty reason.

---

## 9. What PORTAL does NOT need to touch

Both of these were initially assumed to be mandatory. Neither is.

- **`src/ui/effectEditorRegistry.ts`** — a 43-line _opt-in override map_ that only
  curates the first page of knobs. `effectEditorSpec(type)` returns a usable editor
  for every effect by default (`:41-43`). PORTAL works without an entry; add one
  only to reorder knobs.
- **`src/ui/dockLayout.ts`** — the bottom-dock layout store
  (`DockState { height, slotA, slotB }`), not a panel registry.

Real panel wiring lives in **`src/ui/EffectRack.tsx`**: a `lazy(() => import(...))`
at lines 50-55 plus an `fx.type === "…"` render branch (e.g. `:1117-1121`).
Only needed for a bespoke panel.

---

## 10. QA obligations

| Obligation                  | Source                                        | Why                                                                                                                                          |
| --------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Golden vectors (bit-exact)  | `tests/skrutka-golden.test.ts` pattern        | DSP honesty before UI                                                                                                                        |
| 300 s soak                  | `tests/skrutka-soak.test.ts` pattern          | heap ≤ 6 MB, drift ≤ 0.003 dB, **zero non-finite samples** — mandatory for a feedback path                                                   |
| Worklet-loaded probe        | checklist #6                                  | must call `loadAllWorklets(ctx)`; otherwise you measure the native fallback and the effect looks healthy while broken                        |
| Live-path audibility        | checklist #7, `src/browser-checks.ts`         | offline determinism never covers live worklet port delivery                                                                                  |
| Two-variant determinism     | checklist #10                                 | three renders, consecutive must be sample-identical; ping-pong is a render-path defect                                                       |
| Extreme param sweep         | checklist #5 / `fallback-graph-knobs:183-195` | every param at min and max must not throw                                                                                                    |
| Param responsiveness        | checklist #13                                 | **min AND max must move a measured metric** — a `peak > 0` check proves nothing; phaser shipped a full-spectrum pass with a silent wet chain |
| `npm run drift:check`       | §8.1 row 8                                    | derivable artifacts                                                                                                                          |
| `npm run test:expectations` | `suite-expectations.json`                     | failure set must match exactly — no new reds, no silent cures                                                                                |

`suite-expectations.json` currently holds 18 entries, all in unrelated families
(ai-baseline, asio-host vendor gate, creative-task-contract…). **Nothing about effect
registration is currently expected-red**, so a new effect must not land red.

---

## 11. Counts to bump in `docs/CURRENT-STATE.md`

`scripts/drift-check.ts:51-57` parses the **bold number in the second column** of the
row whose label is bold, and checks exactly four labels: `Effects`, `Instruments`,
`Project templates`, `Vitest spec files`.

| Row                           | Line  | Current |                                                     After |
| ----------------------------- | ----- | ------: | --------------------------------------------------------: |
| `**Effects**`                 | `:17` |  **54** |                                 **55** ← machine-enforced |
| └─ native/core effects        | `:18` |      49 |       50 ← not enforced, but factually wrong if untouched |
| └─ primary Add Effect choices | `:19` |      32 |                    33 ← `CORE_EFFECT_ORDER`, not enforced |
| └─ flagship plugin suites     | `:20` |       5 | 5 ← unchanged unless PORTAL joins `FLAGSHIP_EFFECT_ORDER` |

**Order array arithmetic:** 32 core + 5 flagship = 37 of 54. The remaining 17 land in
`ADDITIONAL_EFFECT_GROUPS` (`registry.ts:3838-3842`). Adding PORTAL to
`CORE_EFFECT_ORDER` moves it from the "MORE" groups into the primary menu.

---

## 12. DECISIONS REQUIRED

**PORTAL does not start F1 until these four are answered.** Each changes the design.

### 12.1 New category, or `space`?

`category` is a closed 5-member union (`src/effects/types.ts:185`). A new category means
changing the union, `CORE_EFFECT_GROUP_ORDER` (`registry.ts:3817`),
`CORE_EFFECT_GROUP_LABELS`, CSS, and any test that counts groups.

**Recommendation: no — use `space`.** Two reasons: `ADDITIONAL_EFFECT_GROUPS` already
exists as an escape hatch, and _"spectral"_ is a **technique, not a function**. A user
wants an echo, not an STFT. Granular Freeze already lives in `space` for the same reason.
Open the category only when 3+ spectral effects exist and the UX asks for it.

### 12.2 Reuse the vendored FFT, or copy it?

**Recommendation: import `src/effects/ozvena-core/dsp/fft.ts`.** It is vendored and must
not be edited, but `phase-vocoder.ts:33` already imports it — so this is established
practice, not a loophole. A copy would drift from the oracle and break the shared golden
vectors that `tests/ozvena-golden.test.ts` depends on.

### 12.3 Scope — one effect with modes, or three effects?

**Recommendation: one effect, `mode` param with DELAY / RESONATOR / FREEZE.**
Three effects would mean three full registration surfaces, three panels and three sets of
golden vectors for what is one FFT engine with three parameter paths. Revisit only if
usage shows they are genuinely separate instruments.

### 12.4 Safety limiter on day one?

**Recommendation: yes.** Spectral feedback has no natural bound the way
`kaskada`'s contractive tanh drive does. A hard ceiling on per-bin feedback and a
non-finite sweep per frame is cheap insurance. Shipping an effect that can explode the
audio graph is not a reversible mistake for the user — they will have to reload.

---

## 13. Deliberately out of scope

- **WASM / Rust DSP** — ADR 0005. AudioWorklet is the realtime boundary.
- **`SCHEMA_VERSION` bump** — not needed for an additive effect type (ADR0037).
- **Core bundle** — 1.2 KB free, and spectral DSP filled it once already (§2).
- **Native fallback DSP** — a spectral effect has no honest native approximation;
  `bypassRuntime` with a real reason string is the correct fallback.
- **Retiring or replacing Shimmer** — separate decision, see §3.

---

## 14. Cross-references

- `docs/NEW-EFFECT-CHECKLIST.md` — the five ways a parameter goes silently dead
- `docs/adr/0004-audioworklet-boundary.md` — the DSP boundary
- `docs/adr/0005-rust-wasm-dsp-policy.md` — why no WASM
- `docs/adr/0037-skrutka-phase-dispersion.md` — the newest effect ADR, closest structural model
- `docs/CURRENT-STATE.md` — counts
- `src/audio-engine/phase-vocoder.ts` — the OLA skeleton to port
- `src/effects/morph-dynamics-core/` — the lazy first-party packaging template
- `scripts/build-skrutka-worklet.mjs` — the build-script template
- `AGENTS.md` §5 — "Adding a new core effect"

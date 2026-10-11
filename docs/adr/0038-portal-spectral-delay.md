# 0038 — PORTAL: spectral delay / resonator as a first-party lazy worklet

- **Status:** Accepted
- **Date:** 2026-10-11
- **Decision owners:** project direction (D. Hatala), implementation (Mavis)
- **Baseline:** `cc7e3409`
- **Planning doc:** `docs/IMPLEMENTATION-ROADMAP-PORTAL.md`

---

## Context

A new effect was proposed under the name **Spectral FX (Portal)** — a spectral
delay / resonator, described as "a new category; the FFT infrastructure already
exists (kaskada/ozvena), but it is CPU-heavy and niche."

The premise was measured before anything was designed. **It is wrong in two of
three places**, and the correction changes the architecture.

### What the candidates actually are

| Candidate | Assumed | Measured | Source |
|---|---|---|---|
| `kaskada` (RYFT) | an FFT delay | 43.5 KB **time-domain** dual ring buffer with cubic-Hermite fractional read, per-channel biquad EQ, tanh drive with 2× oversampling. **No FFT.** | `src/audio-worklets/kaskada-processor.js:1-30` |
| `ozvena` (VOID) | spectral DSP | `fftPartitioned.ts` is uniform-partitioned **convolution** (Gardner 1994) for IR reverb. FFT, but convolution — not STFT-frame DSP | `src/effects/ozvena-core/dsp/fftPartitioned.ts:17-31` |
| `ultina` `fft.ts` | a full FFT | `// @ts-nocheck`, vendored, **magnitude spectrum only**, no IFFT | `src/effects/ultina-core/dsp/fft.ts:15-19,29-90` |

### What is actually reusable

Two assets, both proven in-tree:

1. **`src/effects/ozvena-core/dsp/fft.ts`** — complete radix-2 FFT **with IFFT via
   the conjugate trick**, precomputed bit-reversal + twiddle tables
   (`fftPlan`, cached per size), `hannWindow()`, allocation-free at steady state.

   It is **vendored** and must not be edited — reconciled by
   `scripts/vendor-ozvena.mjs`. **It is importable, and the precedent already
   exists:** `src/audio-engine/phase-vocoder.ts:33` imports
   `{ fft, hannWindow, isPow2 }` from it directly.

2. **`src/audio-engine/phase-vocoder.ts`** — Laroche–Dolson STFT: `princarg`,
   Catmull-Rom fractional frame read, hop control, overlap-add with
   **sum-of-squares normalisation** (`:177-191`).

The corrected statement:

> STFT analysis + synthesis with overlap-add **exists** — as an **offline
> full-buffer utility running in a Web Worker**, not as realtime worklet DSP.

That is half the problem. The missing half is the realtime streaming path and
the spectral-domain operation itself. Neither exists.

### The packaging constraint is hard

```
bitcrusher-worklet.js    1,0 KB
core-worklet.js        147,8 KB
                     ─────────
total                 148,8 KB   of   150 KB   (CORE_WORKLET_BUDGET_KB)
free space              1,2 KB
```

`scripts/check-bundle-size.mjs:235-240` records that **kaskada's 32-band spectral
DSP is what forced the core budget from 120 → 150 KB**. Spectral DSP has already
filled this bundle once. A spectral processor needs FFT plans, window tables,
overlap-add ring buffers and a per-bin delay array — orders of magnitude beyond
1,2 KB.

---

## Decisions

### D1 — PORTAL ships as a LAZY worklet, not a core-bundle processor

Own esbuild entry → own `public/spectral-worklet.js`, own build script, a new
`LazyWorkletType` in `LAZY_WORKLET_TYPES` + `LAZY_MODULE_URLS`, and its own budget
row. Follows the MORPH / KOREŃ / SKRUTKA first-party pattern.

*Rationale:* forced by the 1,2 KB headroom; confirmed by the kaskada precedent;
a beat that never uses PORTAL must not pay for it (AGENTS.md §4).

### D2 — Import the vendored FFT; do not copy it

`import { fft, hannWindow, isPow2 } from "../ozvena-core/dsp/fft.js"`.

*Rationale:* `phase-vocoder.ts:33` establishes this as existing practice, not a
loophole. A copy would drift from the upstream oracle and break the shared golden
vectors that `tests/ozvena-golden.test.ts` and `tests/ultina-vectors.test.ts`
depend on. Importing keeps one FFT implementation in the repo.

### D3 — One effect with a `MODE` selector, not three effects

`MODE`: `DELAY` / `RESONATOR` / `FREEZE` — one FFT engine with three parameter paths.

*Rationale:* three effects would mean three full registration surfaces, three
panels and three golden-vector sets for one engine. Revisit only if usage shows
they behave as genuinely separate instruments.

### D4 — Category `space`; no new category

*Rationale:* `category` is a closed 5-member union (`src/effects/types.ts:185`);
a new category changes the union, `CORE_EFFECT_GROUP_ORDER`, the group labels,
CSS, and any test counting groups. **"Spectral" is a technique, not a function** —
a user wants an echo, not an STFT. Granular Freeze already lives in `space` for
the same reason. Reopen only when 3+ spectral effects exist and the UX asks for it.

### D5 — Hard safety ceiling on spectral feedback, from day one

Per-bin feedback clamped to a contractive bound, plus a per-frame non-finite sweep
that zeroes any poisoned bin.

*Rationale:* spectral feedback has no natural bound the way kaskada's contractive
tanh drive does. One `Infinity` in one bin poisons the whole delay ring through
every subsequent frame. A user who loses their audio graph has to reload — that is
not a reversible mistake.

### D6 — PORTAL is explicitly not a better Shimmer

`shimmer` is the closest existing effect and a real duplication risk. It is a
**pure native Web Audio graph** (`src/effects/registry.ts:2342-2372`): highpass +
`WaveShaper` + `DelayNode(0.11 s)` + feedback + lowpass + a **constant** ±12 st
pitch shift. No FFT, no worklet.

| | Shimmer (existing) | PORTAL |
|---|---|---|
| Mechanism | native delay + constant shift + saturation | STFT, per-bin delay + feedback |
| Frequency tracking | none — the shift is uniform | per-bin, follows the material |
| Partial behaviour | smeared octave halo | individually tuned, ringing partials |

*Rationale:* if PORTAL cannot be described as **selective, partial-level control**,
it is a duplicate and should not be built. This constraint binds the ADR, the
panel copy and `docs/CURRENT-STATE.md`.

---

## Consequences

- The `EffectType` union grows additively. **No `SCHEMA_VERSION` bump** — per
  ADR 0037, the union is additive and effect instances normalise against
  `EFFECT_META`.
- `tests/domain-goldens/param-math.json` gains a 55th entry in the aggregate
  `effectDefaults` case; the golden must be recaptured (`npm run goldens:capture`),
  or `tests/domain-goldens.test.ts:42` fails.
- `docs/CURRENT-STATE.md` `**Effects**` 54 → 55 is machine-enforced by
  `scripts/drift-check.ts:51-57`.
- Two test files use **hand-maintained opt-in lists** — `EFFECT_PROC_PAIRS`
  (`tests/param-range-coherence.test.ts:53-90`, 36 pairs) and `FALLBACK_TYPES`
  (`tests/fallback-graph-knobs.test.ts:28`, 7 entries). An effect absent from them
  is **not flagged**: CI is green and the effect is untested. Both must be extended
  deliberately.

---

## Alternatives considered

| Option | Rejected because |
|---|---|
| Add PORTAL to `core-processor.js` | 1,2 KB free; spectral DSP already filled this bundle once (kaskada). |
| Own copy of the FFT in `spectral-core` | Duplicates the vendored oracle; drift against shared golden vectors. |
| Three separate effects | 3× registration surface, panels and golden sets for one engine. |
| New `spectral` category | Technique masquerading as function; broadens a closed union for one member. |
| Native-graph fallback for the effect | A spectral effect has no honest native approximation; `bypassRuntime` with a real reason string is the correct fallback. |

---

## References

- `docs/IMPLEMENTATION-ROADMAP-PORTAL.md` — the implementation roadmap
- `docs/NEW-EFFECT-CHECKLIST.md` — the five ways a parameter goes silently dead
- `docs/adr/0004-audioworklet-boundary.md` — the realtime DSP boundary
- `docs/adr/0005-rust-wasm-dsp-policy.md` — why there is no WASM path
- `docs/adr/0037-skrutka-phase-dispersion.md` — newest effect ADR, additivity rule
- `src/audio-engine/phase-vocoder.ts:33` — the vendored-FFT import precedent
- `scripts/check-bundle-size.mjs:235-241` — the kaskada precedent and the budget

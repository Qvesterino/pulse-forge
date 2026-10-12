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

| Candidate         | Assumed      | Measured                                                                                                                                         | Source                                                |
| ----------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `kaskada` (RYFT)  | an FFT delay | 43.5 KB **time-domain** dual ring buffer with cubic-Hermite fractional read, per-channel biquad EQ, tanh drive with 2× oversampling. **No FFT.** | `src/audio-worklets/kaskada-processor.js:1-30`        |
| `ozvena` (VOID)   | spectral DSP | `fftPartitioned.ts` is uniform-partitioned **convolution** (Gardner 1994) for IR reverb. FFT, but convolution — not STFT-frame DSP               | `src/effects/ozvena-core/dsp/fftPartitioned.ts:17-31` |
| `ultina` `fft.ts` | a full FFT   | `// @ts-nocheck`, vendored, **magnitude spectrum only**, no IFFT                                                                                 | `src/effects/ultina-core/dsp/fft.ts:15-19,29-90`      |

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

_Rationale:_ forced by the 1,2 KB headroom; confirmed by the kaskada precedent;
a beat that never uses PORTAL must not pay for it (AGENTS.md §4).

### D2 — Import the vendored FFT; do not copy it

`import { fft, hannWindow, isPow2 } from "../ozvena-core/dsp/fft.js"`.

_Rationale:_ `phase-vocoder.ts:33` establishes this as existing practice, not a
loophole. A copy would drift from the upstream oracle and break the shared golden
vectors that `tests/ozvena-golden.test.ts` and `tests/ultina-vectors.test.ts`
depend on. Importing keeps one FFT implementation in the repo.

### D3 — One effect with a `MODE` selector, not three effects

`MODE`: `DELAY` / `RESONATOR` / `FREEZE` — one FFT engine with three parameter paths.

_Rationale:_ three effects would mean three full registration surfaces, three
panels and three golden-vector sets for one engine. Revisit only if usage shows
they behave as genuinely separate instruments.

### D4 — Category `space`; no new category

_Rationale:_ `category` is a closed 5-member union (`src/effects/types.ts:185`);
a new category changes the union, `CORE_EFFECT_GROUP_ORDER`, the group labels,
CSS, and any test counting groups. **"Spectral" is a technique, not a function** —
a user wants an echo, not an STFT. Granular Freeze already lives in `space` for
the same reason. Reopen only when 3+ spectral effects exist and the UX asks for it.

### D5 — Hard safety ceiling on spectral feedback, from day one

Per-bin feedback clamped to a contractive bound, plus a per-frame non-finite sweep
that zeroes any poisoned bin.

_Rationale:_ spectral feedback has no natural bound the way kaskada's contractive
tanh drive does. One `Infinity` in one bin poisons the whole delay ring through
every subsequent frame. A user who loses their audio graph has to reload — that is
not a reversible mistake.

### D6 — PORTAL is explicitly not a better Shimmer

`shimmer` is the closest existing effect and a real duplication risk. It is a
**pure native Web Audio graph** (`src/effects/registry.ts:2342-2372`): highpass +
`WaveShaper` + `DelayNode(0.11 s)` + feedback + lowpass + a **constant** ±12 st
pitch shift. No FFT, no worklet.

|                    | Shimmer (existing)                         | PORTAL                               |
| ------------------ | ------------------------------------------ | ------------------------------------ |
| Mechanism          | native delay + constant shift + saturation | STFT, per-bin delay + feedback       |
| Frequency tracking | none — the shift is uniform                | per-bin, follows the material        |
| Partial behaviour  | smeared octave halo                        | individually tuned, ringing partials |

_Rationale:_ if PORTAL cannot be described as **selective, partial-level control**,
it is a duplicate and should not be built. This constraint binds the ADR, the
panel copy and `docs/CURRENT-STATE.md`.

### D7 — Modes keep distinct signal paths and honest latency

In DELAY, positive SHIFT transposes feedback upward: output bin `k` samples the
delayed complex spectrum at `k / 2^(shift/12)`, linearly interpolating between
adjacent bin centers for fractional semitone shifts; integer-bin mappings remain
exact. Out-of-range reads produce silence. In RESONATOR, the delay bank may keep
recording the input so a mode switch has recent material, but its delayed read
does not feed the audible resonator path. Every mode therefore has only the
declared STFT latency (`fftSize - hop`); SHIFT remains a delay-feedback control.
Upward shifts divide output and recirculated magnitudes by the bin expansion
factor, and feedback remains below unity even when the rack control is at 100%.
Factory presets store only controls active in their selected mode. RESONATOR
presets do not carry hidden delay values, and the FREEZE mode does not store the
FREEZE amount because selecting that mode already holds the spectrum.

_Rationale:_ routing the delay read into RESONATOR added a hidden hop and made
SHIFT appear to control the resonator only because the wrong signal path was
audible. Mode-specific controls must affect the mode they name, and reported PDC
must include every sample of actual latency. An octave expansion duplicates each
source bin across more output bins; the gain correction keeps that frequency
mapping from creating level growth or turning maximum feedback into a runaway.

### D8 — Resonator poles follow each bin's measured STFT phase advance

Each active bin measures the phase difference between adjacent input spectra
and rotates its complex pole by that amount. The last valid advance is held as
the input fades, so the tail keeps the partial's actual frequency. Phase
history clears on bypass and while another PORTAL mode runs; it does not erase
the resonator tail. A shared phase rotation, or a rotation based only on the
bin center, can comb or attenuate off-bin partials.

_Rationale:_ a focused resonator must preserve a steady partial at its focus and
control how long it rings after the source stops, including tones between FFT
bin centers. The measured phasor advance lets the per-bin decay radius shape
the tail without imposing a frequency-grid pitch shift. `tests/spectral-golden.test.ts`
pins focused tones both on and between bin centers.

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

| Option                                 | Rejected because                                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Add PORTAL to `core-processor.js`      | 1,2 KB free; spectral DSP already filled this bundle once (kaskada).                                                     |
| Own copy of the FFT in `spectral-core` | Duplicates the vendored oracle; drift against shared golden vectors.                                                     |
| Three separate effects                 | 3× registration surface, panels and golden sets for one engine.                                                          |
| New `spectral` category                | Technique masquerading as function; broadens a closed union for one member.                                              |
| Native-graph fallback for the effect   | A spectral effect has no honest native approximation; `bypassRuntime` with a real reason string is the correct fallback. |

---

## References

- `docs/IMPLEMENTATION-ROADMAP-PORTAL.md` — the implementation roadmap
- `docs/NEW-EFFECT-CHECKLIST.md` — the five ways a parameter goes silently dead
- `docs/adr/0004-audioworklet-boundary.md` — the realtime DSP boundary
- `docs/adr/0005-rust-wasm-dsp-policy.md` — why there is no WASM path
- `docs/adr/0037-skrutka-phase-dispersion.md` — newest effect ADR, additivity rule
- `src/audio-engine/phase-vocoder.ts:33` — the vendored-FFT import precedent
- `scripts/check-bundle-size.mjs:235-241` — the kaskada precedent and the budget

## Addendum (2026-10-12) — continuous-control glide

Continuous controls now glide with a 20 ms one-pole at the audio-block boundary:
TIME, FEEDBACK, DECAY, RESO, FOCUS, WIDTH and DIFF join the existing MIX, TONE,
DRIVE and SHIFT smoothing. TIME, FOCUS and WIDTH use logarithmic interpolation;
the other controls use linear interpolation. This keeps automation and live
control movement from stepping the spectral banks while retaining stable,
perceptual movement for time and frequency controls.

MODE, SYNC and FREEZE remain discrete choices. `prepare()` / `reset()` seed the
smoothers from the saved parameter values, so static presets start at their
authored settings. The log smoother returns an unchanged target exactly; a
static delay on a half-frame boundary must not round to the neighbouring delay
frame because of floating-point noise.

Validation: `tests/spectral-golden.test.ts` checks partial progress for every
smoothed spectral control, exact preset seeding and unchanged DELAY / FREEZE
goldens; `tests/spectral-soak.test.ts` keeps the existing bounded, finite and
denormal-free guarantees.

## Addendum (2026-10-12) — explicit DELAY HOLD switch

The `freeze` parameter is a binary latch in DELAY mode: the delay bank captures
the current spectrum at `0.5` and holds it until released. It is not a continuous
amount. The rack now presents it as a discrete `DELAY HOLD` ON/OFF control.
Selecting the separate FREEZE mode still holds the input spectrum by definition;
the DELAY HOLD switch is ignored there, as the existing mode hint explains.

The saved numeric values `0` and `1`, preset data and DSP path do not change.
This corrects the control model without a project migration and removes the
previous 0–100% slider positions that could not produce distinct sound.

Validation: the source and shipped-bundle parameter tests compare OFF vs ON on
a swept input and require a measurable output difference. The PORTAL soak now
holds maximum DELAY feedback for 300 seconds, compares phase-aligned loudness
windows after the transient has settled, and retains the per-mode boundedness
checks for DELAY, RESONATOR and FREEZE.

## Addendum (2026-10-12) — sample-rate-accurate spectrum axis

The processor divides its 64 display bands logarithmically from 20 Hz to the
active context's Nyquist frequency. Meter frames now carry that context sample
rate, and the PORTAL panel uses it for band centres, the FOCUS / SHIFT markers,
and the frequency axis. The previous fixed 24 kHz endpoint only matched a 48 kHz
context; at 44.1 kHz it spread the upper bins across frequencies the processor
never assigned to them.

Validation: `tests/portal-panel.test.tsx` checks band and axis geometry at 32,
44.1, 48 and 96 kHz, including the Nyquist endpoint.

## Addendum (2026-10-12) — input sanitization before dry/wet paths

Incoming stereo samples are now sanitized once before entering either PORTAL
path. Non-finite values become silence, and finite peaks are bounded at ±8
(+18 dBFS), preserving generous float headroom while containing corrupted
samples before they enter the dry ring or recursive state. The same sanitized samples feed the latency-aligned dry ring and
the MID/SIDE STFT inputs, so `MIX = 0` cannot leak a corrupted sample and a
bad sample cannot contaminate successive analysis frames.

Validation compares both `MIX = 0` and `MIX = 1` renders containing NaN,
infinities and extreme finite values against equivalent renders with those
samples replaced by silence or the safety ceiling. The source processor and
the committed lazy-worklet bundle must match exactly.

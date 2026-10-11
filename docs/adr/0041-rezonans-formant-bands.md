# ADR 0041 - REZONANS v2: formant bands (articulation) + a visible vocal tract

- **Status:** accepted (2026-10-11)
- **Supersedes:** nothing. Amends `0040-rezonans-vocal-formant-harmonizer.md`.
- **Owner:** Daniel
- **A5 gate:** PASSED. The owner listened to v1 on a real vocal and moved on. The
  stop condition in ADR 0040 ("if phase locking cannot clean consonants, fall
  back to the cascade") did not fire, so the spectral architecture stands.

---

## Context

v1 warps the vocal tract with a single scalar:

```
E'(f) = E(f / α),    α = 2^(semitones/12)
```

That is _physically correct for size_. A vocal tract of length L resonates at
c·n/2L, so shortening the tube moves every formant by the same ratio. v1 can
therefore make a voice bigger or smaller, and nothing else.

But a real singer's formant structure is **articulatory**, not just tubular:
F1 tracks mouth opening, F2 tongue position, F3 lip rounding. A singer can
say "open mouth, tongue forward" without changing size at all. A single α
cannot express that — every formant moves together, so the _relative_
spacing is preserved and the result reads as "the same voice, shifted" rather
than "a different singer".

**The diagnosis, stated precisely:** v1 has a SIZE control and no ARTICULATION
controls. That, and not the harmonic solver or the cepstral estimator, is what
keeps it from being first-class.

Three facts make this cheap rather than a rewrite:

1. `FormantWarp` already builds a `(idx, frac)` sampling table per output bin.
   A piecewise α uses the same table shape; only `j = k / α(k)` replaces
   `j = k / α`.
2. The cepstral envelope is already computed once per frame and shared by all
   four voices (`voice.ts:116`). Peak-picking it for F1/F2/F3 costs one linear
   pass per hop, not per voice.
3. The panel already draws a formant curve. Today that curve is an
   illustration; once it carries the _real_ envelope and real formant markers
   it becomes the control.

---

## Decision

### 1. Band edges belong to the singer; shifts belong to the voice

F1/F2/F3 are detected **once per frame** in `RezonansProcessor` and handed to
every `HarmonyVoice`. Each voice carries its own three semitone offsets.

Rationale: the formant structure is a property of the singer's vocal tract at
that instant, not of a harmony voice. Recomputing it per voice would make four
voices disagree about where the singer's mouth is, and four different warp
grids for one mouth is both expensive and wrong.

### 2. Detection peak-picks the cepstral envelope; it does not solve LPC

Fixed search bands in **absolute Hz** — F1 200–1000, F2 700–2500,
F3 2200–3500 — pick the strongest local maximum, refined by parabolic
interpolation on the log-envelope.

LPC would be more accurate on noisy frames. It is rejected for three reasons:
it needs an all-pole solve per frame that we would be adding to the hot path;
its accuracy advantage does not matter when the result is only ever used as a
_warping target_; and it would give the panel a different envelope than the DSP
uses, which is exactly the "instrument that lies to the user" defect ADR 0040
decision 19 forbids.

Absolute bands, not f0-relative ones: making them relative would make one patch
behave differently for a bass and a soprano. Accepting that limitation is
deliberate — this is a target that reads "adult vocal tract". F3 is
**optional**: when no peak clears the floor, the F2/F3 boundary falls back to a
fixed edge rather than snapping to a noise peak.

### 3. Formant centres are temporally smoothed

A 3-frame median over the detected centres, then a one-pole toward it
(15 ms, matching `HarmonyVoice.FORMANT_SMOOTHING_SECONDS`). Un-smoothed centres
move the band edges every hop, and the warp audibly warbles — a new artifact
class in exchange for the old one.

### 4. The warp is piecewise constant with a narrow crossfade at each boundary

Band edges sit at the log-frequency midpoint between neighbouring formants.
Across a boundary of 1/6 octave the two neighbouring warps crossfade linearly.

Rationale: a hard edge would put a step discontinuity in the warped envelope,
which is audible as a click or a zipper on note attacks. A _smooth_ blend over
the whole band would smear the formant peaks and defeat the purpose — the point
is that the bands move independently. A 1/6-octave crossfade is narrow enough
to preserve the peaks and wide enough to kill the step.

### 5. Size stays; articulation is additive

`formant` remains the global SIZE control and keeps its existing meaning and
range. `articulation.f1`, `.f2`, `.f3` are new, each ±12 semitones, each
defaulting to 0.

This is additive on purpose: every v1 patch, preset and scene keeps its
meaning, and a patch that sets only SIZE behaves exactly as before.

### 6. Identity is bit-exact

With all three articulation offsets at 0, the output is **sample-identical**
to v1 for the same input. This is the acceptance test for the refactor, not a
nicety: it is the only thing that proves the piecewise warp did not quietly
perturb the path that was already verified.

### 7. The phase-lock shortcut widens

`voice.ts:197` skips peak locking when `ratio === 1 && alpha === 1`. With three
band alphas the condition becomes "identity AND every band at 1", so a
SIZE-1 / F1+4 patch is still correctly locked.

### 8. Telemetry carries the real envelope

`RezMeters` gains `envelopeDb: Float32Array` (48 log-spaced points between
70 Hz and 11 kHz, rebuilt only while `metersOn`) and `formants: Float32Array`
(3 frequencies, `-1` when not found).

48 points at the existing ~20 Hz cadence is ~960 floats/s across a
MessagePort — negligible. The panel validates the payload defensively on read
and renders "no envelope" rather than throwing on a malformed frame. **The
panel must draw the envelope the DSP used**, not a re-derivation, per decision
19 of ADR 0040.

### 9. Consonant band crossfade is explicitly deferred, not committed

v1 routes unvoiced frames to the latency-matched dry source via one scalar
gain (`rezonansProcessor.ts:419`). v2 _could_ make that blend frequency-
dependent — sibilants live above ~4 kHz and have no formant structure to warp.

It is **not** in the committed v2 scope. The owner judged v1's consonant
behaviour acceptable, and this is a behavioural change to a path that passed
A5. It is recorded here so the option is not lost, and it activates only if a
listening pass finds sibilance problems.

---

## Consequences

- REZONANS gains 3 parameters (`formant` unchanged), not 10. The panel draws
  three draggable markers on a real envelope, which is the depth without the
  parameter bloat.
- **v1 presets and scenes keep working unchanged** — a consequence of decision 5
  and the reason that decision reads as conservative rather than minimal.
- The per-frame cost of detection is one linear pass over the half spectrum
  (~2048 bins at Fine) — negligible next to the cepstrum's two transforms.
  Per-voice cost is unchanged: same table, same shape, one extra branch per
  bin to select the band.
- The panel gains a genuine, honest visualisation. It also gains a new way to
  _lie_: if the drawn envelope ever diverges from the one the warp sampled,
  the panel becomes worse than the abstract line it replaces. Decision 8 pins
  the source to `logEnv` for exactly this reason.

## Validation contract

1. **Identity** — `articulation.* = 0` reproduces v1 sample-for-sample.
2. **Independence** — F1 +6 with F2/F3 at 0 raises the F1 centroid region by
   > 15 % while the F3 region moves < 3 %.
3. **Stability** — detected F1 centre jitter (RMS over a sustained vowel)
   < 15 Hz. Guards decision 3.
4. **No zipper** — a ±6 st F1 sweep over 2 s produces no sample-to-sample jump
   in the warped envelope exceeding the unwarped maximum.
5. **CPU** — 4 voices @ fine stays within 15 % of the v1 ratio (fastest of 3).
6. **UI honesty** — the envelope the panel draws equals the envelope the warp
   sampled, asserted on the meter payload itself.

Non-negotiable invariants: deterministic (no RNG in the signal path), live and
offline bit-parity, no allocation after `prepare()`.

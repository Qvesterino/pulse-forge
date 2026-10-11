# REZONANS v2 - Formant bands (articulation) + a visible vocal tract

- **ADR:** `docs/adr/0041-rezonans-formant-bands.md`
- **Amends:** `docs/adr/0040-rezonans-vocal-formant-harmonizer.md` (does not supersede)
- **A5:** PASSED 2026-10-11 — owner listened, spectral architecture stands.
- **Status:** planned. Phases are ordered; each one ships with its own gate.

---

## 0. What this is

v1 can change a voice's **size** (`formant`, one scalar α applied to the whole
vocal tract). It cannot change its **articulation** — and articulation is what
makes a voice sound like a different person rather than a shifted recording.

v2 adds three independent formant bands on top of the existing size control,
and replaces the panel's abstract warp line with the **real** vocal tract the
DSP is actually using.

## Non-goals (v2)

- **Note entry** per voice (`C3`, `G#3` instead of scale degrees). Real need,
  separate solver branch — not this pass.
- **Latency modes** below N/2 = 1024 samples. A 2048 window would halve it but
  costs frequency resolution exactly where formants live.
- **Per-voice spectral tilt.** Cheap, but it is a tone control, not a formant
  control.
- **Consonant band crossfade** — recorded in ADR 0041 decision 9, deferred.
- Any new **goldens for v1 behaviour that do not already exist**.

---

## 1. Verified ground truth (measured, not assumed)

Read from the committed tree at `ac7e0edf`+:

| Fact                                                                              | Where                                                     |
| --------------------------------------------------------------------------------- | --------------------------------------------------------- |
| The warp is `E'(f) = E(f/α)` — one scalar for the whole tract                     | `cepstrum.ts:11`, `FormantWarp.renderInto`                |
| The per-bin sampling table `(idx, frac)` already exists                           | `cepstrum.ts:196-218`                                     |
| The envelope is computed once per frame and shared by all voices                  | `voice.ts:116` signature, `rezonansProcessor.renderFrame` |
| `setTargets(ratio, alpha)` takes exactly one α                                    | `voice.ts:91`                                             |
| The identity shortcut skips the warp entirely                                     | `voice.ts:141`                                            |
| Peak locking is skipped only at full identity                                     | `voice.ts:197`                                            |
| Consonants reach the dry path through one scalar gain                             | `rezonansProcessor.ts:419`                                |
| Meters post at ~20 Hz, skipped when the host gate is off                          | `rezonans-worklet.entry.js:17,151`                        |
| v1 measured: centroid drift 3.4 % at α=1, latency 1024 @48 kHz, 1.3–2.8× realtime | `tests/rezonans-golden/rezonans-golden.test.ts`           |

## 2. Reusable assets

Nothing to vendor. `FormantWarp`'s table, the cepstral envelope, the existing
`RezMeters` channel and the panel's canvas all carry over. This is an
amendment, not a rebuild.

---

## 3. DSP architecture

### 3.1 Band detection — `dsp/formantBands.ts` (new)

Per frame, over the half spectrum:

1. Peak-pick `logEnv` inside each absolute band (F1 200–1000, F2 700–2500,
   F3 2200–3500 Hz), taking the strongest local maximum.
2. Parabolic interpolation on the log-envelope for sub-bin precision.
3. Floor guard: a "peak" below the envelope's own 60th-percentile level is not
   a formant. Without this, silence and noise pick plausible-looking values.
4. 3-frame median, then a one-pole (15 ms) toward the median.
5. Band edges = log-frequency midpoint between neighbouring accepted centres;
   F3 missing → fixed fallback edge.

Owns its scratch buffers; allocates nothing after `prepare()`.

### 3.2 Piecewise warp — `cepstrum.ts` (modified)

`FormantWarp.update()` takes a band table instead of one α:

```
j = k / α_band(f_k)          // was: j = k / α
```

Plus a per-bin band index table, and a 1/6-octave linear crossfade at each
boundary. Cache invalidation now compares three values instead of one.

**The identity fast path must survive**: `alphaSm === 1` today skips
`renderInto` entirely and reuses `envLin`. With articulation, that shortcut
must additionally require all three band offsets to be 0 — otherwise a
SIZE-1/F1+4 patch would silently render unwarped.

### 3.3 Per-voice targets — `voice.ts` (modified)

`setTargets(ratio, sizeAlpha, f1Shift, f2Shift, f3Shift)`.

Each voice glides its three shifts in semitone space exactly as it already
glides α today (same 15 ms constant). Band **edges** are passed in from the
processor, not recomputed.

Phase-lock gate widens to "identity in ratio, size, and all three bands".

### 3.4 Telemetry — `rezonansProcessor.ts` (modified)

`RezMeters` gains `envelopeDb: Float32Array` (48 log-spaced points, 70 Hz –
11 kHz) and `formants: Float32Array` (3 entries, `-1` = not found). Rebuilt
only when `metersOn`; reuses one buffer.

---

## 4. Parameters (doc scale — one scale everywhere, unchanged)

| id                   | range       | def | notes                                          |
| -------------------- | ----------- | --- | ---------------------------------------------- |
| `formant`            | −12 … 12 st | 0   | **unchanged** — still SIZE                     |
| `articulation.f1`    | −12 … 12 st | 0   | new                                            |
| `articulation.f2`    | −12 … 12 st | 0   | new                                            |
| `articulation.f3`    | −12 … 12 st | 0   | new                                            |
| `formant.voiceScale` | 0 … 1       | 1   | unchanged — scales SIZE into per-voice offsets |

`articulation.*` are **global**, not per-voice. Per-voice formant already
exists as `voice{n}.formant`; the two compose (band shift × voice offset),
which keeps the parameter count at +3 rather than +12.

Unit `"st"`, no taper (semitones are already logarithmic in perception).
Adding a Hz param here would trip `slider-taper` — none is added.

---

## 5. Determinism

No RNG anywhere. Band detection reads the frame counter and the same `logEnv`
the warp reads. The median buffer is fixed-length and index-addressed, not
sliced, so it cannot depend on allocation order.

## 6. File plan

**New**

- `src/effects/rezonans-core/dsp/formantBands.ts`
- `tests/rezonans-golden/rezonans-articulation.test.ts`

**Modified**

- `src/effects/rezonans-core/dsp/cepstrum.ts` — piecewise `update`
- `src/effects/rezonans-core/dsp/voice.ts` — `setTargets`, lock gate, fast path
- `src/effects/rezonans-core/dsp/rezonansProcessor.ts` — detection call, meter
- `src/effects/rezonans-core/contracts/parameters.ts` — 3 params
- `src/effects/definitions.ts` — `rezonansParams` labels + units
- `src/ui/RezonansPanel.tsx` — envelope + markers + drag
- `src/styles/21-device-panel.css`
- `src/effects/presets.ts` — 3 new articulation presets
- `src/effects/preset-loudness.generated.ts` — regenerated
- `tests/domain-goldens/param-math.json` — re-blessed
- `docs/CURRENT-STATE.md`, `docs/adr/0040…` (decision pointer)
- `docs/PLUGIN-NAMING-INVENTORY.md`

**Not modified:** `AudioEngine.ts`, `harmonyContext.ts`, `loader.ts`,
`rezonansNode.ts` (the telemetry shape rides the existing meter channel).

---

## 7. Phases

### P1 — Detection + telemetry

New `formantBands.ts`; processor calls it per frame; meter carries centres and
the 48-point envelope. **No change to the audio path yet** — the warp still
ignores the bands.

Gate: jitter < 15 Hz RMS on a sustained vowel; envelope in the meter equals
`logEnv`; three consecutive renders sample-identical; tsc clean; panel shows
the real envelope (read-only) with markers.

_Ship decision:_ if detection cannot hold jitter < 15 Hz on a real vowel
without the median, **stop** — the whole v2 rests on stable band edges.

### P2 — Piecewise warp

`FormantWarp.update()` generalised; `setTargets` widened; fast path and lock
gate corrected.

Gate: **identity golden** (`articulation.* = 0` ≡ v1, sample-for-sample);
independence (F1 +6 → F1 region > 15 %, F3 region < 3 %); no zipper under a
swept F1; CPU within 15 % of v1.

_Ship decision:_ if identity is not bit-exact, **stop** — the refactor changed
a verified path for no reason.

### P3 — Parameters + panel

3 params, labels, units; panel draws the real envelope with three draggable
markers. Dragging a marker moves that band for **all** voices; the SIZE line
stays as the global.

Gate: every new parameter appears exactly once in `EFFECT_META`; drag is
undoable in one frame; `slider-taper` and `param-range-coherence` green;
prettier; the panel's drawn envelope is asserted equal to the meter's.

### P4 — Presets, docs, integration

3 new presets (open mouth, nasal, small-but-bright), re-bless
`param-math.json` (verify the diff is rezonans-only before committing — v1
lesson), regenerate `preset-loudness.generated.ts`, update `CURRENT-STATE.md`
and the naming inventory.

Gate: full `drift:check`; repo merge gates (`test`, `test:expectations`,
`format:check`); attribute every remaining red to a named owner.

### P5 — Deferred (ADR 0041 decision 9)

Consonant band crossfade, **only** if a listening pass finds sibilance
problems. Not started without that trigger.

---

## 8. Order discipline

Merge gates run at **every phase boundary**, not at the end. On v1 the
equivalent surfaces stayed "green" through P0–P3 and P5 found two registration
defects that had been there since P3. P1 of v2 ships no audio change, so there
is no excuse to defer its gates.

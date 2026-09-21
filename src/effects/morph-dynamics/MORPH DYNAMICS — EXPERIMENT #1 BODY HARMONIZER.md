# MORPH DYNAMICS — EXPERIMENT #1: BODY HARMONIZER

Implement a **BODY-only harmonizer** inside the existing MORPH Dynamics plugin.

This is an experimental signature module, not a generic harmonizer bolted onto the plugin.

## Core product idea

MORPH Dynamics follows the principle:

**Dynamics are not merely processed. Dynamics become control signals.**

The BODY Harmonizer extends that principle by applying pitch-based harmony specifically to the tonal BODY component of the signal while preserving transient clarity and texture.

The intended conceptual signal flow is:

```
INPUT  │  ▼TRANSIENT / BODY / TEXTURE DECOMPOSITION  │  ├── TRANSIENT ─────────────────────────────┐  │                                          │  ├── BODY → BODY HARMONIZER ────────────────┤  │            │                             │  │            ├── Voice A                   │  │            ├── Voice B                   ├──→ RECOMBINE  │            ├── Voice C                   │  │            └── Voice D                   │  │                                          │  └── TEXTURE ───────────────────────────────┘
```

The crucial invariant is:

**Do not pitch-shift the complete input signal. Harmonization must primarily operate on the BODY component.**

Transient and texture components should retain their original timing and character unless an existing MORPH architecture explicitly requires otherwise.

---

# 1. INVESTIGATE BEFORE IMPLEMENTING

First inspect the existing MORPH Dynamics implementation and determine:

- current signal flow

- existing Transient / Body / Texture analysis or decomposition

- detector architecture

- modulation system

- realtime DSP constraints

- parameter/state architecture

- preset/state serialization

- UI parameter binding

- TS/native implementation structure if both paths exist

- existing oversampling/latency infrastructure

- test conventions

- existing pitch-shifting utilities anywhere in the repository that can be safely reused

Do not duplicate infrastructure that already exists.

Do not redesign MORPH Dynamics around this feature.

Preserve the existing architecture.

If BODY extraction already exists, integrate with it.

If BODY is currently represented as a control signal rather than a reconstructable audio component, investigate the smallest architecture-preserving way to obtain a usable tonal-body signal.

---

# 2. PRIMARY EXPERIMENT

We need to answer one question:

> Does harmonizing only the tonal BODY of a signal sound cleaner, more musical, or more interesting than harmonizing the entire signal?

Everything in V0 should serve this experiment.

Avoid feature creep.

---

# 3. BODY EXTRACTION

Use the existing MORPH Transient / Body / Texture model wherever possible.

The BODY path should favor:

- tonal energy

- sustained harmonic content

- voiced material

- stable spectral regions

It should suppress or avoid excessive processing of:

- sharp attacks

- plosives

- consonant attacks

- clicks

- percussion spikes

- broadband noise

- cymbal-like texture

- breath/noise components where possible

Do not introduce heavy source separation or ML merely for this feature.

Prefer deterministic realtime-safe DSP.

BODY extraction does not have to be mathematically perfect.

It must be:

- musically useful

- stable

- low-artifact

- realtime-safe

- phase-conscious

- suitable for recombination with the untouched portions

---

# 4. HARMONIZER ENGINE

Implement up to **four harmony voices**.

Each voice should support:

```
EnabledIntervalLevelPanFine Detune
```

Initial useful interval range:

```
-12-7-5-4-3+3+4+5+7+12 semitones
```

Do not limit the internal architecture unnecessarily if arbitrary semitone values are easy to support.

Fine detune:

```
approximately ±50 cents
```

The pitch engine must operate independently enough from playback speed that the output remains synchronized with the dry signal.

Choose the pitch-shifting technique based on the architecture and realtime constraints already present in the repository.

Possible strategies include:

- phase vocoder

- granular pitch shifting

- delay-line pitch shifting

- PSOLA-style processing where appropriate

- reuse of an existing proven pitch engine in the codebase

Do not choose an algorithm merely because it is easy to implement.

Evaluate:

- latency

- transient smearing

- modulation artifacts

- CPU usage

- phase coherence

- stereo behavior

- vocal quality

- synth quality

---

# 5. FORMANT ARCHITECTURE

V0 does not require a sophisticated formant engine.

However, DO NOT design the harmonizer in a way that prevents future support for:

```
Formant PreserveFormant ShiftPitch Shift independent from Formant Shift
```

Provide a clean future extension point.

If the repository already contains reliable formant-preservation infrastructure, it may be reused, but do not expand scope unnecessarily.

---

# 6. REQUIRED PARAMETERS

Keep V0 intentionally small.

At minimum expose:

```
BODY HARMONIZERBody AmountHarmony MixVoice A  Enabled  Interval  Level  Pan  DetuneVoice B  Enabled  Interval  Level  Pan  DetuneVoice C  Enabled  Interval  Level  Pan  DetuneVoice D  Enabled  Interval  Level  Pan  Detune
```

Parameter smoothing is mandatory where discontinuities could click or zipper.

Do not allow parameter updates to generate unstable states.

---

# 7. DRY / BODY / HARMONY RECOMBINATION

Be especially careful here.

We want approximately:

```
original transient character+original / reconstructed texture+original body+harmonized body voices
```

Avoid:

- obvious comb filtering

- unexpected gain explosions

- double-counting BODY energy

- phase collapse

- mono incompatibility

- dry signal latency mismatch

- harmony appearing noticeably late

- large loudness jumps when Harmony Mix changes

Account for pitch-engine latency.

If required, delay the appropriate parallel paths so recombination remains coherent.

Do not hide latency.

Report it correctly through the existing plugin latency infrastructure.

---

# 8. GAIN AND SAFETY

Four pitch-shifted voices can create substantial gain.

Implement sensible gain management.

The harmonizer must not produce uncontrolled output simply because several voices are enabled.

Investigate:

- energy normalization

- per-voice scaling

- wet-bus headroom

- output safety

- interaction with MORPH saturation/compression stages

Do not add aggressive limiting merely to mask bad gain staging.

Fix gain staging at the source.

---

# 9. PHASE I — STATIC BODY HARMONIZER

First make the module work without dynamics-driven modulation.

Required initial behavior:

```
BODY signal→ pitch voices→ harmony mix→ recombination
```

Validate this before integrating it into the MORPH modulation system.

We need a stable baseline for comparison.

---

# 10. PHASE II — HARMONIC BLOOM HOOK

After the static BODY Harmonizer works correctly, expose it to the existing MORPH modulation system.

The first modulation relationship should be:

```
BODY ENERGY → HARMONY MIX
```

Meaning:

```
low BODY energy    → little/no harmonymedium BODY energy → subtle harmonyhigh BODY energy   → stronger harmony
```

This behavior will later become part of a higher-level interaction concept tentatively called:

**HARMONIC BLOOM**

Do not hardcode Harmonic Bloom deeply into the DSP.

The harmonizer should remain a reusable DSP module while MORPH's modulation matrix controls it externally.

Architectural separation:

```
BODY HARMONIZER = DSP moduleHARMONIC BLOOM = modulation / interaction model
```

Preserve this distinction.

---

# 11. FUTURE MODULATION DESTINATIONS

Do not necessarily implement all of these now, but design parameter exposure cleanly enough that MORPH can later modulate:

```
Harmony MixVoice LevelVoice SpreadFine DetuneInterval selection/morphingFormantSaturationDiffusionStereo Width
```

No special-case spaghetti routing.

Use the existing modulation architecture.

---

# 12. REALTIME SAFETY

Follow the repository's realtime audio rules strictly.

The audio callback must avoid:

- dynamic allocation where prohibited

- blocking locks

- filesystem access

- network access

- JSON parsing

- logging storms

- AI/ML inference

- expensive object construction

- unpredictable work

Preallocate buffers where practical.

Keep CPU behavior deterministic.

Investigate to root cause before making performance shortcuts.

Prefer small, architecture-preserving fixes.

---

# 13. TEST MATERIAL

Test at minimum with:

### Vocal

Check:

- vowel sustain

- consonant clarity

- sibilance

- breath

- plosives

- low and high vocal registers

- ±12 semitone shifts

- dense four-voice configuration

Expected goal:

The harmony should emerge primarily from the tonal vocal body without turning consonants and breath into an obvious pitch-shifted cloud.

### Synth

Check:

- plucks

- pads

- leads

- bass synths

Expected goal:

Attack remains articulate while sustained tonal material blooms into harmony.

### Bass

Check:

- monophonic bass

- bass with strong transient

- saturated bass

Watch low-frequency phase and gain carefully.

### Drum loop

This is intentionally a stress test.

Expected goal:

BODY detection should avoid turning every transient and cymbal into pitched artifacts.

It is acceptable for this source to demonstrate that the feature is less appropriate for some percussion material.

Do not tune the algorithm destructively merely to make every possible source sound good.

---

# 14. A/B VALIDATION

Where practical, add a development/test comparison between:

```
A: Full-signal harmonizerB: BODY-only harmonizer
```

This does not have to become a user-facing feature.

It exists to validate the hypothesis.

Listen/measure for:

- attack preservation

- intelligibility

- noise multiplication

- transient artifacts

- spectral smearing

- perceived clarity

- musicality

- latency

- CPU usage

The point of this experiment is not to prove BODY-only is superior.

The point is to find out whether it actually provides a meaningful sonic advantage.

If it does not, report that clearly.

---

# 15. UI

Do not redesign the MORPH Dynamics UI.

Integrate the module into the existing visual system.

Keep the default surface restrained.

Suggested high-level controls:

```
HARMONYBodyMix

[Voice controls / advanced section]
```

If the plugin already uses collapsed advanced panels, use that pattern.

Do not expose implementation complexity unnecessarily.

---

# 16. PRESETS

Do not build a huge preset library yet.

Add only a few useful development presets if the current architecture requires presets for testing.

Examples:

```
Subtle Vocal BloomWide FifthsOctave BodySynthetic ChoirDark Body Stack
```

These are primarily test/reference states.

---

# 17. TESTS

Add appropriate tests covering:

- parameter bounds

- disabled-state transparency

- Harmony Mix = 0 behavior

- voice enable/disable

- interval changes

- detune stability

- pan behavior

- deterministic output where expected

- silence handling

- NaN/Inf prevention

- extreme parameter combinations

- state serialization/deserialization

- latency reporting

- sample-rate changes

- block-size changes

- mono input if supported

- stereo input

- module bypass

- realtime-safety expectations where existing infrastructure supports them

If there is a TS/native dual implementation for MORPH Dynamics, maintain parity according to the established repository conventions.

Do not weaken existing tests to make the implementation pass.

---

# 18. PERFORMANCE

Measure CPU cost rather than guessing.

Test representative configurations:

```
1 voice2 voices4 voices44.1 kHz48 kHz96 kHz where supportedcommon realtime block sizes
```

Identify the expensive portions.

Do not prematurely optimize at the cost of correctness.

But do not ship an obviously pathological algorithm into the realtime path.

---

# 19. DO NOT DO

Do NOT:

- turn MORPH Dynamics into a generic pitch plugin

- harmonize the whole signal by default

- add AI

- add automatic chord detection yet

- add scale detection yet

- add MIDI harmony yet

- add 20 parameters because they are available

- build a full choir engine

- rewrite the existing decomposition architecture unnecessarily

- bypass existing modulation/state systems

- introduce a parallel plugin architecture

- silently alter existing MORPH behavior

- break existing presets

- break serialized state

- break latency reporting

- weaken realtime constraints

- weaken tests

---

# 20. SUCCESS CRITERIA

The experiment is successful if:

1. BODY-only harmony works reliably in realtime.

2. Original attack/transient character remains noticeably cleaner than naive full-signal harmonization on suitable material.

3. Vocal consonants and noisy components are less unnaturally pitch-shifted.

4. Synth attacks remain articulate.

5. Harmonized BODY recombines naturally with the original signal.

6. Four voices remain stable and gain-safe.

7. Latency is correctly compensated/reported.

8. CPU cost is reasonable for a production plugin.

9. The module integrates cleanly into MORPH's existing modulation architecture.

10. BODY ENERGY can control Harmony Mix without special-case architectural hacks.

11. Existing MORPH behavior and tests remain intact.

Most importantly:

**The result should feel as though harmony grows out of the tonal center of the sound, rather than as though four pitch-shifted copies were simply layered over the entire input.**

---

# 21. IMPLEMENTATION APPROACH

Work incrementally.

Use this sequence:

```
1. Inspect existing architecture.2. Identify/reuse BODY extraction.3. Prototype one BODY pitch voice.4. Validate latency and recombination.5. Add multi-voice architecture.6. Add gain management.7. Add parameter/state integration.8. Add UI controls.9. Add tests.10. Compare BODY-only vs full-signal processing.11. Measure performance.12. Connect BODY ENERGY → Harmony Mix through the existing modulation system.13. Run regression tests.14. Report findings.
```

At the end, provide:

- files changed

- architecture used

- pitch-shifting algorithm chosen and why

- latency introduced

- CPU/performance observations

- BODY extraction strategy

- tests added

- A/B observations

- known artifacts/limitations

- whether BODY-only processing genuinely appears worthwhile

- recommendations for the next experiment

Do not claim success based only on tests.

This is an audio feature.

**Evaluate the sonic hypothesis as well as the software implementation.**

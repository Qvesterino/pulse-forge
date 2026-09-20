# MORPH DYNAMICS — DSP ARCHITECTURE

## 1. Architecture Goals

The DSP architecture must support a low-latency, deterministic, automatable dynamics-driven morph processor suitable for modern plugin formats such as VST3/AU and extensible to additional formats.

Primary goals:

- stable real-time operation
- musically meaningful control signals
- predictable latency
- bounded CPU use
- click-free parameter changes
- robust automation
- optional oversampling where nonlinear processing requires it
- no allocation or locking on the real-time audio thread
- graceful bypass and state restoration

## 2. High-Level Signal Flow

```text
INPUT
  |
  +-----------------------> Analysis Tap
  |                              |
  |                       Feature Extraction
  |                              |
  |                    Reactive Control Engine
  |                              |
  |                     Modulation Matrix
  |                              |
  v                              v
Dynamics -> Character -> Motion -> Space -> Safety -> Mix -> OUTPUT
```

The analysis/control path and audible processing path are intentionally separated.

The control engine observes audio and generates normalized modulation sources. The audio engine consumes those sources.

## 3. Input Stage

Responsibilities:

- input trim
- stereo/mono topology detection
- optional mid/side analysis signals
- DC protection if required
- input peak/RMS monitoring
- analysis tap generation

Input metering must not alter the audio path.

## 4. Feature Extraction

Feature extraction converts incoming audio into smoothed descriptors suitable for real-time modulation.

Candidate features:

- peak envelope
- RMS/energy envelope
- crest factor
- spectral flux
- spectral centroid
- spectral flatness
- band-limited energy estimates
- zero-crossing behavior where useful
- stereo correlation
- mid/side energy
- tonality/noisiness estimate
- transient probability/strength
- sustained/body energy
- texture/noise energy

Not every descriptor needs to ship in v1. The architecture should permit extension without changing preset semantics.

### Analysis Windows

Use multiple timescales rather than one universal envelope:

- fast detector for transients
- medium detector for musical dynamics
- slow detector for density/context

All analysis must be bounded and deterministic.

## 5. Transient / Body / Texture Control Model

The initial implementation should treat these as **soft control masks**, not hard source-separated stems.

### Transient Score

Derived from combinations of:

- rapid energy increase
- spectral flux
- fast/slow envelope divergence
- crest behavior

Output:

`transient ∈ [0, 1]`

### Body Score

Derived from combinations of:

- sustained energy
- tonal stability
- medium/slow envelope presence
- reduced transient probability

Output:

`body ∈ [0, 1]`

### Texture Score

Derived from combinations of:

- spectral flatness/noisiness
- diffuse high-frequency energy
- low tonal stability
- residual/sustained detail

Output:

`texture ∈ [0, 1]`

Scores may overlap. They are descriptors, not mutually exclusive classes.

This is important for musical continuity and avoids artifacts associated with aggressive hard separation.

## 6. Dynamics Detector

The dynamics subsystem should expose several normalized modulation sources in addition to applying gain reduction.

Potential sources:

- input level
- gain reduction
- positive envelope delta
- negative envelope delta
- above-threshold amount
- transient energy
- body energy
- texture energy
- short-term density
- stereo correlation

### Core Compression Controls

- threshold
- ratio
- attack
- release
- knee
- detector blend (peak/RMS or equivalent)
- sidechain filtering
- optional auto-release
- makeup/output compensation

The compressor should be useful independently of the creative processing. This provides a solid production foundation.

## 7. Reactive Control Engine

The control engine converts raw descriptors into stable modulation signals.

Each source should support:

- normalization
- sensitivity
- attack smoothing
- release smoothing
- optional curve shaping
- polarity
- clamp/range

Conceptually:

```text
raw feature
 -> normalize
 -> sensitivity
 -> envelope smoothing
 -> response curve
 -> clamp
 -> modulation source
```

The control engine must prevent noisy parameter chatter.

## 8. Modulation Matrix

The matrix is the central architectural subsystem.

### Sources

Initial candidates:

- Gain Reduction
- Input Energy
- Transient
- Body
- Texture
- Density
- Spectral Flux
- Stereo Correlation
- Macro PRESSURE

Future sources may include tempo-synced modulators, external sidechain features or MIDI/envelope sources.

### Destinations

Examples:

- compressor threshold/ratio bias
- saturation drive
- saturation tone
- clip amount
- harmonic balance
- phaser depth
- phaser feedback
- movement rate
- filter position
- stereo width
- diffusion
- reverb send
- reverb size
- reverb decay
- dry/wet relationships

### Route Definition

Each route should conceptually contain:

```text
source
destination
amount [-1, +1]
curve
smoothing
optional range constraint
```

Negative routing is a first-class feature.

Example:

```text
Transient -> Reverb Send = -0.65
Body      -> Drive       = +0.40
Texture   -> Width       = +0.55
```

### Modulation Safety

Destinations must define safe ranges. Modulation must not push parameters into invalid or unstable regions.

## 9. PRESSURE Macro Architecture

PRESSURE is not a global wet/dry control.

It should scale a curated set of internal behaviors, potentially including:

- dynamics intensity
- modulation route depth
- harmonic generation
- transient/body/texture contrast
- motion depth
- spatial reaction

The mapping should be nonlinear and carefully tuned.

One possible conceptual mapping:

```text
Pressure P ∈ [0,1]

compression contribution = f1(P)
character contribution   = f2(P)
motion contribution      = f3(P)
space contribution       = f4(P)
```

where each `f` has a different response curve.

This allows PRESSURE to reveal new behavior progressively rather than simply increasing everything equally.

## 10. Dynamics Processing Stage

Responsibilities:

- primary compression
- optional parallel compression topology
- transient preservation or enhancement
- optional upward/downward behavior in future versions

PUNCH should influence the relationship between transient detection and gain reduction rather than acting as a generic EQ boost.

Potential techniques:

- transient-weighted detector behavior
- transient bypass/blend path
- attack adaptation
- short parallel transient path

Any transient manipulation must be phase-safe and tested on drums, vocals and bass.

## 11. Character Stage

Character handles nonlinear timbral transformation.

Candidate modules:

- soft saturation
- asymmetric saturation
- soft clipping
- harmonic emphasis
- tone/tilt around nonlinear stages

### Oversampling

Nonlinear stages should support internal oversampling where beneficial.

Recommended design:

- Eco: minimal/no oversampling
- Normal: 2x where needed
- High: 4x
- optional render/offline higher mode if justified

Do not oversample the entire plugin blindly. Oversample nonlinear subgraphs only where the audible benefit warrants CPU and latency cost.

## 12. Motion Stage

Motion provides reactive temporal/phase movement.

Potential v1 primitives:

- phaser/all-pass network
- subtle frequency-dependent phase motion
- modulation filter
- stereo movement

The Motion module must support both extremely subtle animation and aggressive creative processing.

Reactive modulation should generally be prioritized over a conventional always-running LFO, although an LFO may be added as a secondary source later.

## 13. Space Stage

Space handles controlled ambience and stereo transformation.

Candidate components:

- early reflection/diffusion network
- algorithmic reverb or compact FDN
- stereo width
- pre-delay
- decay/damping

A critical use case is **transient ducking of space**:

```text
Transient ↑ -> Space Send ↓
Transient releases -> Space returns
```

This produces clear attacks followed by expanding ambience.

Spatial modules require strict gain and feedback safety.

## 14. Routing Topology

V1 should avoid unrestricted arbitrary module routing.

Recommended audible path:

```text
Dynamics -> Character -> Motion -> Space
```

Allow carefully chosen parallel paths where musically important.

The modulation matrix provides complexity without forcing users to manage arbitrary audio graphs.

Future versions may expose limited reordering if measurements demonstrate meaningful value.

## 15. Dry/Wet and Parallel Integrity

Dry/wet behavior must be phase-conscious.

Requirements:

- latency-compensated dry path
- equal-power or perceptually tuned mixing where appropriate
- no comb filtering caused by unaccounted processing latency
- consistent bypass behavior

## 16. Stereo Strategy

Support:

- linked stereo dynamics by default
- adjustable stereo linking if justified
- mid/side analysis internally
- width modulation with mono compatibility safeguards

Low-frequency stereo expansion should be constrained by design.

## 17. Sidechain

External sidechain should be architecturally supported even if deferred from the first MVP.

Potential future use:

- external signal drives dynamics
- external signal drives Transient/Body/Texture analysis
- hybrid internal/external modulation

## 18. Latency

Latency must be explicit and deterministic.

Potential latency sources:

- lookahead
- FFT/spectral analysis
- oversampling filters
- linear-phase operations if ever introduced

Prefer time-domain or low-latency analysis for the primary product experience.

If FFT analysis is used, it should not automatically force the audible path through a large-latency spectral processor.

## 19. Parameter Smoothing

Every automatable DSP parameter that can cause discontinuities requires smoothing.

Use appropriate smoothing strategies for:

- gain
- frequency
- feedback
- delay/reverb coefficients
- drive
- modulation depth

Avoid one smoothing constant for every parameter class.

## 20. Real-Time Safety

The audio callback must avoid:

- heap allocation
- mutex locks
- file I/O
- logging
- UI communication that can block
- model loading
- unpredictable system calls

Analysis data sent to the UI should use lock-free or wait-free communication patterns appropriate to the framework.

## 21. Numerical Safety

Every recursive or nonlinear subsystem requires:

- finite-value checks during development
- bounded feedback
- denormal protection
- parameter range validation
- output limiting/safety strategy

Debug builds should aggressively detect NaN/Inf propagation.

## 22. Quality Modes

Suggested modes:

### ECO

Lowest CPU, reduced analysis resolution/oversampling.

### NORMAL

Default production mode.

### HIGH

Higher-quality nonlinear processing and analysis.

Quality changes must not unexpectedly alter preset character beyond reasonable tolerances.

## 23. CPU Budget Philosophy

Spend CPU where it creates audible value.

Priority:

1. stable dynamics
2. control analysis
3. nonlinear quality
4. motion
5. spatial complexity
6. visualization

The UI must never compromise the audio thread.

## 24. MVP DSP Scope

The first proof should contain only enough DSP to validate the thesis:

1. input/output and metering
2. reliable compressor
3. transient/body/texture control signals
4. modulation matrix
5. saturation/clip character stage
6. simple phaser/motion stage
7. compact diffusion/reverb stage
8. PRESSURE macro
9. safe dry/wet/output stage

If this prototype does not sound compelling, adding more modules is not the solution.

## 25. Architecture Invariant

Every major DSP feature should answer one question:

> How can the behavior of the incoming sound meaningfully control this processing?

If a module cannot answer that question, it should not automatically become part of MORPH DYNAMICS.

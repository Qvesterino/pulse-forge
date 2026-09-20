# MORPH DYNAMICS — PRESET SYSTEM

## 1. Purpose

Presets in MORPH DYNAMICS are not static collections of knob positions. They encode **reactive behaviors**.

A good preset defines how a particular type of sound should cause the processor to respond.

The preset system must therefore store both audible parameters and the relationships between analysis sources and processing destinations.

## 2. Preset Philosophy

A preset should communicate an intent.

Good names:

- Lead Vocal Density
- Breath Bloom
- Snare Opens Space
- Drum Bus Pressure
- Bass Harmonic Push
- Synth Reactive Orbit

Weak names:

- Preset 037
- Big Sound
- Cool FX 2

## 3. Preset Data

A preset should be capable of storing:

### Global

- schema version
- preset ID
- name
- author
- category
- tags
- description
- intended source
- intended intensity

### Main Controls

- Pressure
- Punch
- Body
- Texture
- Motion
- Space
- Input/Output where appropriate
- Mix

### Dynamics

- threshold
- ratio
- attack
- release
- knee
- detector configuration
- sidechain filtering

### Analysis

- transient sensitivity
- body sensitivity
- texture sensitivity
- detector smoothing/response settings

### DSP Modules

- character settings
- motion settings
- space settings
- quality-independent module configuration

### Modulation Routes

Each route:

```text
source
destination
amount
curve
attack/release override if present
range constraints if present
```

## 4. Preset Versioning

Preset files require explicit schema versioning from day one.

Example:

```json
{
  "schemaVersion": 1,
  "product": "MORPH_DYNAMICS",
  "presetId": "..."
}
```

Future migrations must preserve old projects and user presets whenever technically possible.

Never silently reinterpret an old route because a parameter ID changed.

## 5. Stable Parameter IDs

Parameter IDs are persistent API contracts.

Rules:

- never derive IDs from display order
- avoid renaming internal IDs after release
- deprecated parameters remain migratable
- UI labels may change without changing parameter identity

## 6. Categories

Primary source categories:

- Vocal
- Drums & Beats
- Bass
- Synth
- Guitar & Instruments
- Bus
- Creative

Secondary functional tags:

- Clean
- Punch
- Dense
- Warm
- Aggressive
- Wide
- Motion
- Space
- Texture
- Experimental
- Subtle
- Extreme

## 7. Intensity Metadata

Presets should optionally expose an intensity class:

- Subtle
- Moderate
- Strong
- Extreme

This helps users navigate a processor capable of both mixing and sound design.

## 8. Vocal Preset Families

### Clean Control

Goal: serious vocal dynamics with minimal obvious coloration.

Typical behavior:

- moderate compression
- high transient/consonant preservation
- low reactive saturation
- restrained texture handling
- minimal motion
- subtle space

### Dense Lead

Goal: vocal grows denser as performance intensity increases.

Typical routes:

```text
Body -> Drive       +
GR   -> Harmonics   +
Transient -> Space  -
Texture -> Width    +small
```

### Breath Bloom

Goal: breath/air activates controlled ambience and width.

```text
Texture -> Diffusion +
Texture -> Width     +
Transient -> Reverb  -
```

### Aggressive Vocal

Goal: forward, compressed, harmonically animated sound.

High PRESSURE tolerance with output safety.

## 9. Drum & Beat Preset Families

### Punch Preserve

- moderate body compression
- strong transient protection
- light clipping
- low space

### Drum Bus Pressure

- glue compression
- body-driven saturation
- transient-driven space ducking
- texture-driven width

### Smash & Bloom

```text
GR        -> Drive       +strong
Transient -> Space Send  -strong
Texture   -> Diffusion   +
Body      -> Motion      +moderate
```

### Hat Texture

Designed for high-frequency rhythmic material without requiring low/mid-band logic.

## 10. Bass Preset Families

### Solid Core

- stable fundamental
- body compression
- upper harmonic enhancement tied to energy
- minimal stereo low-end processing

### Harmonic Push

- performance-sensitive saturation
- transient preservation
- controlled motion above the low fundamental region

### Reactive Growl

Creative mode with stronger Body → Character and Body → Motion relationships.

## 11. Synth Preset Families

### Reactive Orbit

- Body → Motion
- Texture → Width
- Transient → Space ducking

### Static to Alive

Designed to make simple sustained patches respond dynamically without conventional LFO-heavy modulation.

### Bloom

Increasing sustained energy expands harmonic richness and space.

## 12. Bus Preset Families

Bus presets must be conservative by default.

### Glue

- low PRESSURE
- gentle dynamics
- subtle character
- minimal movement

### Cohesion + Air

- body stabilization
- texture-sensitive width/diffusion
- strict gain control

### Creative Bus

Clearly tagged as strong/experimental.

## 13. Creative Presets

Creative presets demonstrate the outer edge of the architecture.

Families might include:

- Melt
- Pulse
- Bloom
- Fracture
- Orbit
- Collapse
- Ghost
- Reactor

Names should describe a recognizable behavior, not compensate for a weak sound.

## 14. Macro Mapping Per Preset

PRESSURE mappings can differ between preset families.

For a Clean Vocal preset, increasing PRESSURE may primarily deepen compression and harmonics.

For a Creative Synth preset, increasing PRESSURE may progressively introduce motion and spatial transformation.

This means PRESSURE is a **semantic macro**, not a fixed list of parameter multipliers shared identically by every preset.

## 15. Preset Authoring Mode

Internal/advanced authoring should make it possible to:

- edit all base values
- edit modulation routes
- edit macro mappings
- set safe ranges
- audition at multiple input levels
- attach tags/description
- validate preset integrity

## 16. Preset Validation

Before factory inclusion, test each preset with:

- silence
- low-level material
- nominal material
- hot input
- mono source
- stereo source where relevant
- 44.1/48/96 kHz
- multiple buffer sizes

Check:

- no runaway gain
- no NaN/Inf
- no unstable feedback
- no excessive output jumps
- no unintended pumping
- no broken automation ranges

## 17. Loudness Bias

Factory presets should avoid winning comparisons solely through output gain.

Where possible:

- normalize perceived output sensibly
- provide output trim
- consider optional audition level matching

## 18. Preset Browser UX

Recommended filters:

```text
Source      Vocal / Drums / Bass / Synth / Instrument / Bus / Creative
Intent      Clean / Punch / Dense / Motion / Space / Texture / Extreme
Intensity   Subtle / Moderate / Strong / Extreme
Favorites   Yes/No
Author      Factory/User
```

Search should cover names, descriptions and tags.

## 19. User Presets

Users must be able to:

- save
- rename
- duplicate
- delete
- favorite
- export/import

User content should remain separate from factory content so updates cannot overwrite it.

## 20. Factory Preset Standard

A factory preset should demonstrate a clear reason to use MORPH DYNAMICS instead of a conventional compressor or static multi-FX.

If a preset would sound essentially identical with static effects and no reactive relationships, reconsider whether it belongs in the launch library.

## 21. Golden Presets

During development, maintain a small set of **Golden Presets** used as regression references.

Suggested set:

1. Clean Vocal Control
2. Dense Vocal
3. Drum Bus Pressure
4. Smash & Bloom
5. Solid Bass
6. Reactive Synth
7. Subtle Bus Glue
8. Extreme Creative

These should be tested after significant DSP changes to detect behavioral drift.

## 22. Preset System North Star

A MORPH DYNAMICS preset is a reusable answer to the question:

> **When this sound behaves this way, how should the processor respond?**

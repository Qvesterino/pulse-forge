# VISION.md

# Pulse Forge
### A focused production-grade beat and scene-score workstation

> Create music quickly. Shape it deeply. Connect it to motion.

---

## 1. Product Vision

Pulse Forge is a focused music production workstation designed for creating:

- production-ready electronic beats,
- rhythmic loops,
- instrumental arrangements,
- short-form musical cues,
- adaptive scene accompaniment,
- stems and synchronized audio assets for the wider Qvester ecosystem.

It is not intended to become a traditional full-scale DAW.

Pulse Forge deliberately avoids the complexity of:

- vocal recording,
- multitrack studio recording,
- VST/AU plugin hosting,
- ASIO/device-driver management,
- advanced audio warping,
- spectral restoration,
- large-scale mixing workflows,
- external plugin ecosystems.

Instead, Pulse Forge provides a carefully designed closed production environment containing everything necessary to create excellent electronic instrumental music.

The core idea is simple:

> A producer should be able to open Pulse Forge with nothing, create a complete beat using only the built-in instruments, samples and effects, export it, and feel no immediate need to leave the application.

At the same time, music created in Pulse Forge should be able to become a temporal and expressive layer inside other Qvester tools.

Pulse Forge therefore sits between two worlds:

**music production**

and

**visual / interactive scene composition.**

---

# 2. Why Pulse Forge Exists

The Qvester ecosystem already contains tools for:

- visual synthesis,
- shaders,
- procedural motion,
- audio visualization,
- signal analysis,
- generative graphics,
- cinematic scenes,
- atmosphere,
- texture,
- timing,
- BPM and key analysis,
- vocal production.

What is missing is the musical center of that ecosystem.

A system capable of producing:

```text
rhythm
+
bass
+
harmony
+
texture
+
movement
+
arrangement
```

and turning those elements into a finished audio asset.

Pulse Forge fills that gap.

It should become the primary environment for creating instrumental music and rhythmic accompaniment for Qvester projects.

---

# 3. Product Identity

Pulse Forge is:

### A beat workstation

Fast enough to sketch an idea in seconds.

### A sound design instrument

Deep enough to create original basses, drums, synths and textures.

### A production environment

Capable of producing polished, usable audio.

### A scene scoring tool

Able to create music around visual timing and scene events.

### A Qvester ecosystem component

Designed for interoperability with other Qvester applications.

Pulse Forge is **not** a stripped-down imitation of Ableton Live, FL Studio, Logic or Bitwig.

It should develop its own workflow.

---

# 4. Core Philosophy

## 4.1 Focus beats feature count

Pulse Forge should contain fewer systems than a traditional DAW.

Those systems should be exceptionally useful.

The question should never be:

> "How many features can we add?"

The question should be:

> "What does someone repeatedly need while making a great beat?"

If a feature does not meaningfully improve:

- composition,
- sound design,
- rhythm,
- arrangement,
- mixing,
- modulation,
- export,
- or scene integration,

it probably does not belong in the core product.

---

# 4.2 Closed ecosystem, deep capabilities

Pulse Forge intentionally does not rely on external plugins.

Instead, the application contains a high-quality collection of native:

- instruments,
- samplers,
- synthesizers,
- modulation systems,
- effects,
- processors,
- utilities,
- mastering tools.

The built-in toolset must be capable enough that external VST support does not feel necessary for the intended workflow.

This constraint is a feature.

It allows Pulse Forge to remain:

- deterministic,
- portable,
- stable,
- easier to test,
- easier to persist,
- easier to automate,
- easier to integrate with other Qvester tools.

---

# 4.3 Quality over quantity

Twenty excellent processors are more valuable than one hundred mediocre ones.

Four excellent synthesizers are more useful than twenty unfinished synth engines.

A curated bank of excellent drums is more important than thousands of random samples.

Pulse Forge should prioritize:

```text
character
clarity
musicality
control
```

over raw numbers.

---

# 5. The First Principle of Sound

Pulse Forge must sound good immediately.

The default state of the application matters.

The first:

- kick,
- snare,
- bass preset,
- synth patch,
- compressor,
- saturation setting,
- reverb,

must inspire confidence.

Users should not have to repair poor defaults before creating music.

Therefore:

> Factory content is part of the product, not auxiliary content.

The sample and preset library must be treated with the same seriousness as the audio engine itself.

---

# 6. Sound Library Vision

Pulse Forge should ship with a carefully curated factory library.

It should cover the essential vocabulary of modern electronic production.

## Drums

- kicks
- snares
- claps
- closed hi-hats
- open hi-hats
- cymbals
- rides
- rims
- toms
- percussion
- shakers
- clicks
- foley percussion

## Bass

- sub bass
- 808
- house bass
- techno bass
- Reese bass
- FM bass
- acid bass
- distorted bass
- plucked bass

## Tonal Content

- plucks
- stabs
- chords
- pads
- keys
- bells
- leads
- drones
- textures

## FX

- impacts
- risers
- sweeps
- noise
- transitions
- glitches
- drops
- atmospheric elements

Factory content should be searchable through meaningful musical metadata rather than filenames alone.

Example:

```text
Type: Kick
Style: House
Character: Punchy
Length: Short
Brightness: 65
Weight: 82
```

Browsing sounds should feel like browsing musical intent.

---

# 7. Instruments

Pulse Forge should initially focus on a small family of purpose-built instruments.

---

## 7.1 Drum Rack

The central rhythmic instrument.

A pad-based sampler designed specifically for drums and percussion.

Each pad should support:

- sample loading,
- gain,
- pan,
- tuning,
- sample start/end,
- envelopes,
- filtering,
- velocity,
- choke groups,
- reverse,
- drive,
- output routing.

The Drum Rack should feel immediate.

Loading or replacing a sound must require minimal interaction.

---

## 7.2 General Sampler

A flexible instrument for tonal and non-tonal samples.

Designed for:

- one-shots,
- textures,
- stabs,
- melodic samples,
- experimental sound design.

It should remain simpler than traditional heavyweight samplers.

---

## 7.3 Analog Synth

A general-purpose subtractive synthesizer.

Capable of creating:

- leads,
- pads,
- plucks,
- basses,
- stabs,
- arpeggios.

It should expose enough synthesis depth for advanced users while remaining approachable through macros and semantic controls.

---

## 7.4 Bass Synth

A specialized synthesizer optimized for modern low-frequency sounds.

Primary targets:

- house,
- techno,
- electronic,
- bass music.

Its primary controls should describe musical outcomes:

```text
BODY
SUB
PUNCH
GRIT
MOVEMENT
WIDTH
```

Advanced synthesis controls may exist underneath.

---

## 7.5 808 Synth

A specialized instrument for synthesized 808-style bass.

Core capabilities:

- pitch envelope,
- decay,
- glide,
- saturation,
- harmonics,
- transient click,
- tone shaping,
- distortion,
- slide notes.

The instrument should produce useful results without requiring sample packs.

---

## 7.6 Texture Synth

A Qvester-oriented instrument for:

- atmospheric beds,
- drones,
- evolving textures,
- cinematic layers,
- noise structures,
- ambient movement.

Primary conceptual controls:

```text
COLOR
MOTION
SPACE
DENSITY
TEXTURE
CHAOS
```

This instrument is particularly important for Scene Mode.

---

# 8. Sequencing Philosophy

The sequencer is the heart of Pulse Forge.

It should support two complementary composition models.

## Step Sequencing

Optimized for:

- drums,
- percussion,
- rhythmic synth sequences,
- fast beat construction.

Core features should eventually include:

- velocity,
- probability,
- ratchets,
- microtiming,
- swing,
- per-step modulation,
- step length,
- accents.

## Piano Roll

Optimized for:

- bass,
- synths,
- melodies,
- chords,
- melodic percussion.

The piano roll must prioritize fluid editing rather than feature density.

---

# 9. Patterns, Scenes and Arrangement

Pulse Forge should use a hierarchical composition model.

```text
NOTES / STEPS
      ↓
PATTERN
      ↓
SCENE
      ↓
ARRANGEMENT
```

A Pattern represents musical content.

A Scene represents a musical state or section.

Example:

```text
INTRO
GROOVE
BUILD
DROP
BREAK
DROP B
OUTRO
```

The Arrangement combines scenes and patterns into a complete timeline.

This workflow allows both:

- traditional beat production,
- scene-oriented soundtrack creation.

---

# 10. Scene Mode

Scene Mode is one of the defining capabilities of Pulse Forge.

Traditional music tools primarily think in:

```text
bars
beats
tracks
clips
```

Pulse Forge must additionally understand:

```text
time
events
intensity
transitions
visual synchronization
```

A user may define:

```text
Scene Duration: 32 seconds
Tempo: 120 BPM
Key: D minor
```

and compose directly against that duration.

Scene markers may represent:

```text
0s    INTRO
8s    BUILD
16s   PEAK
24s   RELEASE
32s   END
```

These markers can later become synchronization points for other Qvester applications.

---

# 11. Scene Intensity

Pulse Forge should eventually support a normalized scene intensity signal.

Example:

```text
0.0 ───────────────────────────── 1.0
calm                              maximum intensity
```

Intensity may drive musical parameters such as:

- filter cutoff,
- percussion density,
- distortion,
- synth layers,
- bass presence,
- reverb,
- modulation depth,
- rhythmic complexity.

This gives music a high-level semantic control surface.

Instead of automating twenty unrelated parameters manually, a producer may create a single meaningful musical dimension.

---

# 12. Modulation as a First-Class System

Modulation should not belong exclusively to synthesizers.

It should be a universal capability across Pulse Forge.

Potential modulation sources include:

- LFO,
- envelope,
- envelope follower,
- velocity,
- note position,
- random,
- step modulator,
- macro,
- scene intensity.

Potential targets include almost any compatible parameter.

Example:

```text
LFO 1
 ├─ Filter cutoff
 └─ Reverb mix

Velocity
 └─ Saturation drive

Scene Intensity
 ├─ Percussion density
 ├─ Bass filter
 └─ Texture amount
```

A unified modulation system prevents each instrument from implementing isolated modulation logic.

---

# 13. Macro System

Complexity should be accessible without requiring constant micro-management.

Pulse Forge should therefore support reusable macro controls.

Example:

```text
DIRT
```

may simultaneously affect:

```text
Saturation Drive     +40%
Filter Cutoff        -12%
Compression          +15%
Noise                 +8%
```

Macros allow advanced sound design to become musically expressive automation.

Every major instrument and effect rack should be able to expose meaningful macro controls.

---

# 14. Native Effects

Pulse Forge should provide a focused native effect suite.

Initial target family:

## Dynamics

- Compressor
- Punch Compressor
- Transient Shaper
- Gate
- Pump / Sidechain
- Limiter

## Tone

- Parametric EQ
- Tilt EQ
- Filter
- Saturation
- Distortion
- Clipper

## Space

- Reverb
- Creative Space Reverb
- Delay

## Modulation

- Chorus
- Phaser
- Flanger

## Utility

- Gain
- Pan
- Stereo Width
- Mono Bass
- Channel Utility

## Specialized

- Drum Buss
- Bass Buss
- Master Processor

Effects should share coherent interaction patterns.

Controls that mean similar things should behave similarly across processors.

---

# 15. Sidechain and Pumping

Sidechain-style movement is fundamental to modern electronic music.

Pulse Forge should provide two approaches.

### Audio-triggered ducking

Example:

```text
Kick → Bass Compressor
```

### Tempo-synchronized volume shaping

Example:

```text
1/4 pumping curve
```

This allows rhythmic pumping even when no explicit trigger track exists.

The second system should support editable curves.

---

# 16. Mixing

The mixer should provide everything necessary for beat production without attempting to become a large studio console.

Each channel should support:

- volume,
- pan,
- mute,
- solo,
- metering,
- inserts,
- sends,
- routing.

Core bus concepts:

```text
DRUMS
BASS
MUSIC
FX
MASTER
```

should be easy to create and manage.

Routing must remain predictable.

---

# 17. Mastering Philosophy

Pulse Forge does not aim to replace dedicated mastering software.

It should, however, allow users to produce a finished and controlled output.

The master stage should provide:

- tonal shaping,
- glue compression,
- saturation / soft clipping,
- limiting,
- loudness metering,
- peak metering.

The master system should never pretend that mastering is a single magical button.

It should provide sensible defaults while remaining transparent.

---

# 18. Intuitive Parameter Design

Pulse Forge should expose parameters at two conceptual levels.

## Immediate Layer

Musically understandable controls:

```text
PUNCH
BODY
AIR
DIRT
MOVEMENT
SPACE
WIDTH
```

## Advanced Layer

Technical controls:

```text
attack
release
threshold
ratio
Q
frequency
envelope depth
oscillator shape
feedback
```

Beginners should be able to shape sound by intent.

Advanced users should still be able to understand exactly what the engine is doing.

There should be no hidden magic required for good results.

---

# 19. Preset Philosophy

Presets should communicate musical purpose.

Avoid meaningless lists such as:

```text
Preset 001
Preset 002
Preset 003
```

Prefer semantic organization:

```text
HOUSE
 ├─ Deep
 ├─ Rolling
 ├─ Organ
 ├─ Rubber
 └─ Dirty

TECHNO
 ├─ Driving
 ├─ Acid
 ├─ Industrial
 └─ Rumble
```

Presets may additionally expose character dimensions:

```text
Warm     ←──────→ Bright
Soft     ←──────→ Aggressive
Clean    ←──────→ Dirty
Static   ←──────→ Moving
```

The preset system should encourage exploration rather than menu archaeology.

---

# 20. Production-Ready Definition

For Pulse Forge, "production-ready" means:

A user can create an instrumental beat entirely inside the application and export an audio result suitable for:

- release workflows,
- video,
- games,
- social media,
- visual art,
- Qvester projects,
- further mixing or mastering elsewhere.

Production-ready does **not** mean reproducing every capability of a professional recording studio.

The target is narrower and more achievable:

> Excellent electronic instrumental production inside a controlled environment.

---

# 21. Export

Export is a core feature, not an afterthought.

Pulse Forge should ultimately support:

## Master

```text
master.wav
```

## Stems

```text
drums.wav
bass.wav
music.wav
textures.wav
fx.wav
```

Potential future exports:

- MIDI,
- project package,
- scene metadata,
- automation data,
- waveform analysis,
- synchronization markers.

Offline rendering should prioritize deterministic high-quality output.

Realtime playback limitations should never unnecessarily reduce export quality.

---

# 22. Qvester Score Package

A future interoperable format may package music and scene information together.

Example:

```text
NeonRain.scorepack
│
├─ audio/
│  ├─ master.wav
│  ├─ drums.wav
│  ├─ bass.wav
│  └─ atmosphere.wav
│
├─ score.json
├─ markers.json
└─ automation.json
```

The package may contain:

- BPM,
- musical key,
- duration,
- loop regions,
- scene markers,
- stems,
- intensity data,
- automation,
- synchronization events.

This allows other Qvester applications to consume music as structured temporal information rather than merely an audio file.

---

# 23. Ecosystem Integration

Pulse Forge should eventually integrate naturally with:

## QFX Composer

Music, markers and intensity can drive visual events.

## Audio Canvas

Stems and rhythmic information can become visual inputs.

## Signal Lab

Tracks can be analyzed and visualized.

## BPM Analyzer

Imported samples may receive tempo and key metadata.

## Atmosphere / Shader / Motion systems

Scene intensity and timing may control visual parameters.

## VocalForge

Pulse Forge may export instrumental stems for later vocal production.

The applications should remain independently usable.

Integration must never become a requirement for basic functionality.

---

# 24. Local-First Philosophy

Pulse Forge should be designed as a local-first application.

Core creation must not depend on:

- remote servers,
- cloud accounts,
- AI providers,
- network availability,
- subscriptions.

Projects and user-created assets should remain under user control.

The basic production workflow must continue working offline.

Cloud services may eventually provide optional capabilities, but they must never become foundational dependencies of the audio engine.

---

# 25. Determinism

Projects must reopen predictably.

The same saved project should reconstruct:

- instruments,
- effect chains,
- routing,
- samples,
- modulation,
- automation,
- arrangement,
- timing,

without silent changes.

Random systems should support explicit seeds where appropriate.

Preset versions and project schemas must be versioned.

Audio behavior should not unexpectedly change because internal implementations were modified.

Long-lived project compatibility is a product requirement.

---

# 26. Architecture Direction

Pulse Forge should maintain a strict separation between:

```text
UI
PROJECT MODEL
MUSIC MODEL
TRANSPORT
SCHEDULER
AUDIO ENGINE
DSP
RENDERING
PERSISTENCE
```

The UI must never become the source of truth for audio state.

Audio logic must not be embedded throughout React components.

The long-term engine direction is:

```text
Application UI
      ↓
Project / Command Layer
      ↓
Sequencer + Transport
      ↓
Qvester Audio Engine
      ↓
Web Audio API
      ↓
AudioWorklet / DSP
```

Offline rendering should use the same project model and as much shared audio logic as practical.

The architecture must leave room for future WASM DSP without requiring it prematurely.

---

# 27. Technology Philosophy

Pulse Forge should use the browser/audio runtime where it is strong.

Native C++ infrastructure should not be introduced merely because traditional DAWs use it.

The initial platform should rely on technologies such as:

- TypeScript,
- modern web UI,
- Web Audio API,
- AudioWorklet,
- IndexedDB or equivalent local persistence,
- offline audio rendering,
- optional WASM for genuinely justified DSP workloads.

Every lower-level technology must earn its complexity.

The project should begin with the simplest architecture capable of satisfying its real audio requirements.

---

# 28. Performance Philosophy

Audio correctness has higher priority than visual flourish.

Priority order:

```text
1. audio stability
2. timing correctness
3. project integrity
4. interaction responsiveness
5. visual polish
```

The UI may drop frames before the audio engine is allowed to break timing.

Expensive visualizations must never interfere with audio processing.

Meters, scopes and animations should operate as observers of the engine rather than participants in its timing.

---

# 29. Non-Goals

Pulse Forge deliberately does not target the following.

## No VST / AU Hosting

The native effect and instrument ecosystem is the product.

## No ASIO Management

Pulse Forge is not intended to compete with native recording studios.

## No Vocal Production

VocalForge owns that domain.

## No Large Multitrack Recording

Recording is not the core workflow.

## No Melodyne-Style Editing

Pitch correction and advanced vocal manipulation are outside scope.

## No Massive Audio Warping System

Basic sample timing features may exist, but rebuilding Ableton Warp is not a priority.

## No Video Editor

Pulse Forge may synchronize with scenes but should not become another visual editor.

## No Feature-Parity Arms Race With DAWs

Pulse Forge wins through focus and workflow, not checkbox count.

---

# 30. UX Principles

## Immediate creation

The user should be able to produce sound within seconds of opening the application.

## Minimal modal friction

Core actions should not constantly interrupt flow with dialogs.

## Direct manipulation

Drag, drop, turn, draw and play wherever appropriate.

## Musical language

Prefer:

```text
Punch
Warmth
Movement
Space
```

when technically appropriate.

Expose engineering terminology when precision is necessary.

## Progressive depth

Simple first.

Advanced when requested.

## Predictability

Controls must not produce unexplained behavior.

## Fast auditioning

Sounds and presets should be extremely quick to compare.

## Reversible actions

Creative experimentation should be safe.

Undo/redo must become a foundational system.

---

# 31. The Creative Loop

The ideal Pulse Forge session looks like this:

```text
choose sound
     ↓
make rhythm
     ↓
add bass
     ↓
shape sound
     ↓
add movement
     ↓
create variation
     ↓
arrange
     ↓
mix
     ↓
export
```

No stage should require unnecessary setup.

The application should continuously encourage forward creative momentum.

---

# 32. MVP Vision

The first serious version should prove one thing:

> Can someone make a genuinely good electronic beat without leaving Pulse Forge?

The initial product should therefore prioritize:

### Instruments

- Drum Rack
- Sampler
- Analog Synth
- Bass Synth
- 808 Synth

### Composition

- Step Sequencer
- Piano Roll
- Patterns
- Scenes
- Arrangement

### Processing

- EQ
- Compressor
- Transient Shaper
- Saturation
- Clipper
- Filter
- Pump / Sidechain
- Reverb
- Delay
- Chorus

### Modulation

- LFO
- automation
- basic macros

### Mixing

- mixer
- sends
- buses
- master processing

### Export

- WAV
- stems

### System

- local project persistence
- undo / redo
- deterministic project model
- reliable transport
- reliable offline rendering

Scene Mode can grow on top of this foundation once the production workflow is trustworthy.

---

# 33. Success Criteria

Pulse Forge succeeds when:

### Creative success

A blank project can become an enjoyable beat quickly.

### Sound success

Factory instruments and sounds do not feel like placeholders.

### Production success

Exports can actually be used.

### Workflow success

Common actions require very little friction.

### Technical success

Playback remains stable during normal production workloads.

### Project success

Saved sessions reopen correctly.

### Ecosystem success

Pulse Forge can eventually provide meaningful audio and timing information to other Qvester tools.

### Identity success

The application feels like Pulse Forge rather than a browser clone of another DAW.

---

# 34. Long-Term Direction

Pulse Forge may eventually grow toward:

- advanced groove extraction,
- intelligent sample matching,
- semantic sound search,
- generative rhythm tools,
- generative MIDI,
- chord and scale assistance,
- deeper modulation,
- advanced synth engines,
- scene-adaptive arrangements,
- cross-application automation,
- shared Qvester timing protocols,
- structured score packages,
- reusable production templates,
- instrument and effect preset ecosystems.

These capabilities should grow around the original product identity.

They must never bury it.

---

# 35. North Star

Pulse Forge should eventually make this workflow possible:

```text
I need music for this.

↓


Open Pulse Forge.

↓


Build the rhythm.

↓


Shape the bass.

↓


Add musical layers.

↓


Give it movement.

↓


Arrange the scene.

↓


Mix it.

↓


Export master + stems + timing.

↓


Use it anywhere.
```

And inside the Qvester ecosystem:

```text
MUSIC
  │
  ├── rhythm
  ├── structure
  ├── intensity
  ├── events
  └── automation
        │
        ▼
      SCENE
        │
        ▼
     VISUALS
```

The long-term goal is not merely to make another tool that creates audio.

The goal is to create a **musical engine for the Qvester ecosystem**.

A place where rhythm, sound, modulation, arrangement and visual time finally share the same language.
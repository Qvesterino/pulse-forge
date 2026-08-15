# FEATURES.md

# Pulse Forge
## Product Feature Specification

---

# 1. Purpose

This document defines the product feature set of Pulse Forge.

It translates the product vision and technical architecture into concrete user-facing capabilities.

Pulse Forge is a focused browser-first beat and scene-score workstation designed for:

- beat production,
- electronic music composition,
- sound design,
- arrangement,
- mixing,
- export,
- visual-scene synchronization.

This document intentionally separates:

- core features,
- advanced features,
- future features,
- explicit non-goals.

The purpose is to prevent uncontrolled scope growth.

---

# 2. Product Pillars

Pulse Forge is built around six feature pillars:

1. **Sound**
2. **Rhythm**
3. **Composition**
4. **Processing**
5. **Arrangement**
6. **Export and Ecosystem Integration**

Every major feature should strengthen at least one of these pillars.

---

# 3. Core Workflow

The primary workflow should be:

```text
CREATE PROJECT
    ↓
CHOOSE SOUNDS
    ↓
BUILD RHYTHM
    ↓
ADD BASS / MUSIC
    ↓
SHAPE SOUND
    ↓
CREATE VARIATIONS
    ↓
ARRANGE
    ↓
MIX
    ↓
EXPORT
```

The application should minimize friction between these stages.

---

# 4. Project Management

## Core Features

- Create new project
- Rename project
- Duplicate project
- Delete project
- Autosave
- Manual save
- Load recent projects
- Project recovery
- Project schema versioning
- Import project
- Export project package

## Project Metadata

Each project may contain:

- name,
- BPM,
- key,
- time signature,
- author,
- creation date,
- modification date,
- tags,
- optional notes.

---

# 5. Transport

The transport is always accessible.

## Controls

- Play
- Pause
- Stop
- Restart
- Loop
- Metronome
- Count-in
- Tempo
- Tap tempo
- Position display
- Bar / beat display
- Time display

## Tempo

Initial range:

```text
20 BPM → 300 BPM
```

Support:

- manual tempo entry,
- tap tempo,
- BPM Analyzer integration,
- future tempo automation.

---

# 6. Time Signature

Initial support:

- 4/4
- 3/4
- 6/8

Advanced:

- custom numerator,
- custom denominator.

Time signature support must not complicate the core beatmaking workflow.

---

# 7. Global Musical Key

Projects may optionally define:

```text
ROOT NOTE
+
SCALE
```

Example:

```text
D
Minor
```

Supported scale types may include:

- Major
- Natural Minor
- Harmonic Minor
- Melodic Minor
- Dorian
- Phrygian
- Mixolydian
- Pentatonic Major
- Pentatonic Minor

---

# 8. Scale Lock

The piano roll may support scale highlighting.

Optional features:

- hide out-of-scale notes,
- snap notes to scale,
- transpose pattern to project key.

Scale assistance must remain optional.

---

# 9. Track Types

Initial track types:

- Drum Track
- Instrument Track
- Sampler Track
- Audio / One-Shot Track
- Bus Track
- Return Track

Future:

- Scene Control Track
- Modulation Track

---

# 10. Track Controls

Every track should support:

- name,
- icon,
- volume,
- pan,
- mute,
- solo,
- arm state where relevant,
- output routing,
- insert effects,
- send levels,
- color or visual identity.

---

# 11. Drum Rack

The Drum Rack is one of the central features of Pulse Forge.

## Pads

Initial target:

```text
16 pads
```

Potential future expansion:

```text
24 / 32 pads
```

Each pad supports:

- sample selection,
- gain,
- pan,
- pitch,
- fine tune,
- sample start,
- sample end,
- attack,
- hold,
- decay,
- release,
- filter cutoff,
- resonance,
- drive,
- reverse,
- velocity sensitivity,
- mute,
- solo,
- choke group,
- output routing.

---

# 12. Drum Rack Pad Actions

- Drag sample onto pad
- Replace sample
- Duplicate pad
- Clear pad
- Copy pad settings
- Paste pad settings
- Preview sample
- Normalize preview level
- Randomize selected parameters
- Reset parameters

---

# 13. Drum Choke Groups

Pads may belong to choke groups.

Example:

```text
Closed Hat → Choke Group 1
Open Hat   → Choke Group 1
```

Triggering one pad stops another pad in the same group.

---

# 14. General Sampler

The General Sampler handles:

- one-shots,
- melodic samples,
- textures,
- stabs,
- sound effects.

Features:

- waveform display,
- sample start/end,
- loop region,
- reverse,
- pitch,
- fine tune,
- gain,
- pan,
- ADSR,
- filter,
- velocity sensitivity.

---

# 15. Sample Root Note

Tonal samples may define a root note.

Example:

```text
Root: C3
```

The sampler transposes relative to that root.

---

# 16. Sample Looping

Loop modes:

- Off
- Forward
- Ping-Pong

Loop controls:

- start,
- end,
- crossfade.

Crossfade may be added after the initial implementation.

---

# 17. Analog Synth

A general-purpose subtractive synthesizer.

## Oscillators

- Oscillator A
- Oscillator B
- Sub Oscillator
- Noise

Waveforms:

- sine,
- triangle,
- saw,
- square,
- pulse.

---

# 18. Analog Synth Controls

- oscillator pitch,
- detune,
- octave,
- mix,
- pulse width,
- unison,
- spread,
- noise level,
- filter cutoff,
- resonance,
- filter drive,
- amp envelope,
- filter envelope,
- velocity amount.

---

# 19. Bass Synth

Specialized bass-oriented synthesizer.

Primary semantic controls:

```text
SUB
BODY
PUNCH
GRIT
MOVEMENT
WIDTH
```

Advanced controls may expose:

- oscillators,
- filter,
- envelopes,
- distortion,
- sub oscillator,
- modulation.

---

# 20. 808 Synth

Dedicated synthesized 808 instrument.

Features:

- fundamental pitch,
- decay,
- pitch envelope,
- glide,
- slide notes,
- transient click,
- saturation,
- harmonics,
- tone,
- distortion,
- output level.

---

# 21. Texture Synth

Designed for:

- pads,
- drones,
- atmospheres,
- evolving textures,
- cinematic beds.

Primary controls:

```text
COLOR
MOTION
SPACE
DENSITY
TEXTURE
CHAOS
```

Potential engine components:

- oscillators,
- filtered noise,
- modulation,
- granular processing,
- delay,
- reverb.

Granular processing may be deferred until later.

---

# 22. Instrument Presets

All instruments support presets.

Preset categories should be musical.

Example:

```text
Bass Synth

HOUSE
TECHNO
TRAP
BASS MUSIC
AMBIENT
EXPERIMENTAL
```

---

# 23. Preset Character Tags

Presets may expose tags such as:

- Warm
- Bright
- Dark
- Clean
- Dirty
- Soft
- Aggressive
- Static
- Moving
- Wide
- Mono
- Punchy
- Deep

---

# 24. Sample Library

The factory sample library is a major product feature.

The application should ship with or provide access to curated sounds in categories such as:

## Drums

- Kicks
- Snares
- Claps
- Closed Hats
- Open Hats
- Rides
- Cymbals
- Toms
- Rims
- Percussion
- Shakers

## Bass

- Sub
- 808
- House Bass
- Techno Bass
- Reese
- FM Bass
- Acid Bass

## Tonal

- Plucks
- Stabs
- Chords
- Keys
- Bells
- Leads
- Pads

## FX

- Risers
- Impacts
- Drops
- Sweeps
- Noise
- Glitches
- Transitions
- Atmospheres

---

# 25. Sample Browser

The browser should support:

- search,
- category filtering,
- tag filtering,
- favorite sounds,
- recent sounds,
- preview,
- keyboard navigation,
- drag and drop,
- sorting.

---

# 26. Sample Metadata

Factory assets may expose:

```text
Type
Style
Character
Length
Key
Root Note
Brightness
Weight
Punch
Stereo Width
```

Not every field is required for every asset.

---

# 27. Similar Sounds

Future feature:

A sound may expose:

```text
Find Similar
```

Similarity may use:

- metadata,
- spectral analysis,
- embeddings,
- perceptual features.

This feature is not required for MVP.

---

# 28. Downloadable Sound Packs

Factory content may be distributed in packs.

Examples:

- Core Drums
- House Essentials
- Techno Essentials
- 808 Collection
- Percussion
- Atmospheres
- FX and Transitions

Packs may be downloadable for offline use.

---

# 29. Step Sequencer

The Step Sequencer is optimized for rapid rhythmic composition.

Default:

```text
16 steps
```

Expandable to:

- 32,
- 64,
- custom pattern length.

---

# 30. Step Controls

Each step may support:

- active / inactive,
- velocity,
- probability,
- microtiming,
- ratchet count,
- accent,
- step length,
- per-step parameter lock.

Some advanced step controls may be introduced incrementally.

---

# 31. Velocity Editing

Velocity should be editable:

- directly on steps,
- through a velocity lane,
- through mouse drag,
- numerically.

---

# 32. Probability

Each step may define:

```text
0% → 100%
```

Probability must use deterministic seeded randomness during playback and export.

---

# 33. Ratchets

A step may retrigger multiple times.

Example:

```text
1x
2x
3x
4x
```

Future:

- custom ratchet spacing,
- velocity decay.

---

# 34. Microtiming

Steps may be shifted slightly:

```text
EARLY ← 0 → LATE
```

Microtiming should not visually destroy grid readability.

---

# 35. Swing

Global swing:

```text
0% → 100%
```

Patterns may eventually override global swing.

---

# 36. Groove Templates

Future feature.

Grooves may encode:

- timing offsets,
- velocity patterns,
- accent patterns.

Potential examples:

- MPC-style grooves,
- house grooves,
- shuffled hats,
- custom extracted grooves.

---

# 37. Piano Roll

The piano roll handles melodic and harmonic sequencing.

Core features:

- create note,
- move note,
- resize note,
- duplicate note,
- delete note,
- multi-select,
- copy/paste,
- velocity,
- grid snap,
- zoom,
- scroll.

---

# 38. Piano Roll Editing

Editing tools:

- Select
- Draw
- Erase

Future:

- Split
- Glue
- Paint
- Stretch

The UI should remain simple.

---

# 39. Note Properties

Each note may include:

- pitch,
- start,
- duration,
- velocity,
- probability,
- microtiming.

Future:

- note expression,
- per-note modulation.

---

# 40. Slide Notes

The 808 Synth should support slide / glide behavior through note metadata.

Example:

```text
C2 ─────
       D2 ↗
```

---

# 41. Pattern System

Patterns are reusable musical units.

Features:

- create,
- rename,
- duplicate,
- delete,
- resize,
- copy,
- paste.

Pattern types may include:

- drum,
- melodic,
- automation.

---

# 42. Pattern Length

Patterns may use:

```text
1 bar
2 bars
4 bars
8 bars
custom
```

---

# 43. Pattern Variations

Useful workflow:

```text
Pattern A
Pattern A2
Pattern B
Fill
Break
```

Users should be able to duplicate and modify patterns quickly.

---

# 44. Scene System

Scenes combine patterns across tracks.

Example:

```text
INTRO
GROOVE
BUILD
DROP
BREAK
OUTRO
```

A scene may determine which pattern each track uses.

---

# 45. Scene Launching

Future performance-oriented mode:

Scenes may be launched live.

Optional launch behavior:

- immediate,
- next beat,
- next bar,
- next 4 bars.

This is not required for early MVP.

---

# 46. Arrangement

The Arrangement converts patterns and scenes into a linear composition.

Features:

- timeline,
- scene blocks,
- pattern blocks,
- duplicate,
- move,
- resize,
- loop selection,
- markers.

---

# 47. Arrangement Markers

Markers may identify:

```text
Intro
Build
Drop
Break
Outro
Custom
```

Markers may later be exported for Qvester scene integration.

---

# 48. Automation

Automation should be available for most continuous parameters.

Examples:

- volume,
- pan,
- cutoff,
- resonance,
- drive,
- effect mix,
- synth macros,
- send levels.

---

# 49. Automation Editing

Features:

- create point,
- move point,
- delete point,
- multi-select,
- curve interpolation,
- copy/paste.

Initial interpolation:

- Step
- Linear

Future:

- Bezier
- Exponential
- Custom

---

# 50. Automation Recording

Future feature:

Moving a control during playback may record automation.

Modes may include:

- Read
- Touch
- Write

Not required for initial release.

---

# 51. Modulation

Modulation is separate from arrangement automation.

Sources:

- LFO
- Envelope
- Envelope Follower
- Random
- Step Modulator
- Velocity
- Macro
- Scene Intensity

---

# 52. LFO

LFO waveforms:

- sine,
- triangle,
- square,
- saw up,
- saw down,
- random,
- sample and hold.

Rate modes:

- Hz,
- tempo synchronized.

---

# 53. LFO Sync Values

Examples:

```text
1/1
1/2
1/4
1/8
1/16
1/32

Dotted
Triplet
```

---

# 54. Step Modulator

Future feature.

Editable modulation sequence:

```text
▁ ▃ █ ▂ ▆ ▅ ▁ █
```

Useful for:

- filter rhythm,
- pitch modulation,
- FX movement,
- gating.

---

# 55. Envelope Follower

Future / advanced feature.

Maps signal amplitude to another parameter.

Example:

```text
Kick amplitude
      ↓
Filter cutoff
```

---

# 56. Macro Controls

Each instrument or effect rack may expose macros.

Example:

```text
DIRT
SPACE
MOVEMENT
PUNCH
```

A macro may control multiple parameters.

---

# 57. Macro Mapping

Users may define:

- target,
- amount,
- polarity,
- minimum,
- maximum.

Example:

```text
DIRT

Saturation Drive   +50
Filter Cutoff      -20
Compression        +15
```

---

# 58. Mixer

The mixer should provide a compact production-focused workflow.

Each channel:

- volume fader,
- pan,
- mute,
- solo,
- meter,
- inserts,
- sends,
- output routing.

---

# 59. Mixer Views

Potential views:

- Compact
- Full

Compact emphasizes:

- fader,
- pan,
- mute,
- solo,
- meter.

Full exposes:

- inserts,
- sends,
- routing.

---

# 60. Buses

Users may route tracks into buses.

Common examples:

```text
DRUMS
BASS
MUSIC
FX
```

---

# 61. Return Tracks

Shared effects may live on return tracks.

Typical:

```text
Reverb Return
Delay Return
```

Each source track may send adjustable signal levels.

---

# 62. Effect Rack

Each track may contain an ordered effect chain.

Example:

```text
EQ
↓
Compressor
↓
Saturation
↓
Reverb
```

Users should be able to:

- add,
- remove,
- reorder,
- bypass,
- duplicate effects.

---

# 63. Q-EQ

Primary equalizer.

Target:

```text
6 bands
```

Band types:

- Low Cut
- Low Shelf
- Bell
- High Shelf
- High Cut
- Notch

Features:

- gain,
- frequency,
- Q,
- spectrum display,
- bypass per band.

---

# 64. Tilt EQ

Simple tone control:

```text
DARK ←─────●─────→ BRIGHT
```

Useful for fast tone shaping.

---

# 65. Compressor

Controls:

- threshold,
- ratio,
- attack,
- release,
- knee,
- makeup gain,
- mix.

Visuals may include:

- gain reduction meter,
- transfer curve.

---

# 66. Punch Compressor

Simplified musical compressor.

Controls:

```text
PUNCH
BODY
GLUE
MIX
```

Optimized for quick beat production.

---

# 67. Transient Shaper

Controls:

```text
ATTACK
SUSTAIN
OUTPUT
```

Primary use:

- drums,
- percussion,
- bass attacks.

---

# 68. Gate

Controls:

- threshold,
- attack,
- hold,
- release,
- range.

---

# 69. Pump / Sidechain

Two modes:

## Audio Trigger

Example:

```text
Kick → Bass
```

## Tempo Curve

Example:

```text
1/4 pump
```

Controls:

- amount,
- attack,
- release,
- curve,
- sync.

---

# 70. Filter

Modes:

- Low Pass
- High Pass
- Band Pass
- Notch

Potential future:

- Comb
- Formant

Controls:

- cutoff,
- resonance,
- drive,
- mix.

---

# 71. Saturation

Modes may include:

- Warm
- Tape
- Tube
- Soft Clip
- Digital
- Crunch

Controls:

- drive,
- tone,
- bias,
- mix,
- output.

---

# 72. Distortion

Modes:

- Overdrive
- Fuzz
- Hard Clip
- Fold
- Bitcrush
- Waveshape

Controls vary by algorithm but should share consistent UX.

---

# 73. Clipper

Controls:

```text
DRIVE
CEILING
SOFTNESS
OUTPUT
```

Advanced:

- oversampling.

---

# 74. Bitcrusher

Controls:

- bit depth,
- sample rate reduction,
- mix.

Useful for:

- drums,
- texture,
- experimental sound design.

---

# 75. Reverb

Standard reverb.

Controls:

- size,
- decay,
- pre-delay,
- damping,
- width,
- mix.

---

# 76. Space Reverb

Creative reverb.

Controls:

```text
SIZE
DIFFUSION
COLOR
MODULATION
SHIMMER
FREEZE
MIX
```

Some features may arrive after MVP.

---

# 77. Delay

Modes:

- Stereo
- Ping Pong
- Tape

Controls:

- time,
- sync,
- feedback,
- filter,
- width,
- mix.

---

# 78. Ducking Delay

Future feature.

Delay output automatically ducks while the dry signal is active.

Useful for:

- melodic synths,
- leads,
- busy mixes.

---

# 79. Chorus

Controls:

- rate,
- depth,
- spread,
- feedback,
- mix.

---

# 80. Phaser

Controls:

- rate,
- depth,
- stages,
- feedback,
- stereo phase,
- mix.

---

# 81. Flanger

Controls:

- rate,
- depth,
- feedback,
- delay,
- mix.

---

# 82. Stereo Utility

Controls:

- width,
- balance,
- mono,
- left/right swap,
- polarity,
- gain.

---

# 83. Mono Bass

Maintains mono compatibility below a chosen crossover frequency.

Example:

```text
Mono below 120 Hz
```

---

# 84. Drum Buss

Specialized drum processor.

Primary controls:

```text
PUNCH
GLUE
DRIVE
BODY
AIR
MIX
```

Internally may combine:

- compression,
- saturation,
- transient shaping,
- EQ.

---

# 85. Bass Buss

Specialized bass processor.

Controls:

```text
SUB
WEIGHT
GRIT
PUNCH
WIDTH
```

Potential features:

- sub mono management,
- saturation,
- tone shaping.

---

# 86. Master Processor

Mastering-oriented finishing chain.

Primary controls:

```text
TONE
GLUE
PUNCH
WIDTH
LOUDNESS
```

Advanced panel may expose:

- EQ,
- compression,
- soft clipping,
- limiter,
- loudness target.

---

# 87. Limiter

Controls:

- ceiling,
- release,
- input gain.

Future:

- true peak mode,
- lookahead settings.

---

# 88. Metering

Track meters:

- peak,
- RMS.

Master:

- peak,
- RMS,
- LUFS,
- stereo correlation.

Future:

- true peak.

---

# 89. Spectrum Analyzer

Spectrum display may be available:

- inside EQ,
- master analyzer,
- optional track analyzer.

Visualization must not interfere with realtime audio.

---

# 90. Undo / Redo

Core creative operations must support undo/redo.

Examples:

- notes,
- patterns,
- sample changes,
- parameter edits,
- routing,
- automation,
- effects,
- tracks.

---

# 91. History

Future feature:

A history panel may expose recent commands.

Example:

```text
Add Kick
Change BPM
Move Note
Add Reverb
Adjust Cutoff
```

---

# 92. Keyboard Shortcuts

Essential shortcuts:

```text
Space       Play/Pause
Ctrl+Z      Undo
Ctrl+Y      Redo
Ctrl+S      Save
Delete      Delete selection
Ctrl+C      Copy
Ctrl+V      Paste
Ctrl+D      Duplicate
```

Further shortcuts should remain consistent across editors.

---

# 93. Drag and Drop

Drag/drop should support:

- samples → pads,
- samples → sampler,
- presets → instruments,
- effects → rack,
- patterns → arrangement.

---

# 94. Context Menus

Right-click menus may provide:

- duplicate,
- delete,
- rename,
- copy,
- paste,
- reset,
- freeze where relevant.

Core actions must remain accessible without context menus.

---

# 95. Search

Global search may eventually locate:

- samples,
- presets,
- instruments,
- effects,
- projects.

Initial implementation may focus on sample/preset search only.

---

# 96. Favorites

Users may favorite:

- samples,
- presets,
- effects,
- sound packs.

---

# 97. Recent Items

Track recently used:

- sounds,
- presets,
- projects.

This significantly improves iteration speed.

---

# 98. Audio Import

Supported initial input:

```text
WAV
MP3
OGG
```

Additional formats may depend on browser decoding support.

---

# 99. Imported Sample Analysis

Potential automatic analysis:

- duration,
- sample rate,
- channel count,
- peak,
- waveform.

Future integration:

- BPM,
- key,
- root pitch.

---

# 100. BPM Analyzer Integration

Pulse Forge may integrate the existing BPM Analyzer logic.

Imported loops may receive:

```text
Detected BPM
Detected Key
Confidence
```

The user may override results.

---

# 101. Time Stretching

Not required for initial MVP.

Future basic support may include:

- loop tempo adaptation,
- stretch ratio.

Pulse Forge should not attempt to recreate a complete Ableton-style warp system.

---

# 102. Pitch Shifting

Basic pitch shifting may be supported by sampler playback rate.

Higher-quality independent pitch shifting may be implemented later using DSP/WASM.

---

# 103. Offline Render

Projects can be rendered offline.

Options:

- full arrangement,
- loop region,
- selected range.

---

# 104. WAV Export

Canonical export format:

- WAV 16-bit
- WAV 24-bit
- WAV 32-bit float

Sample rates:

- 44.1 kHz
- 48 kHz

Potential future:

- 96 kHz

---

# 105. Master Export

Export:

```text
master.wav
```

Options may include:

- normalize,
- limiter enabled,
- tail duration,
- include effects tails.

---

# 106. Stem Export

Supported logical stems:

```text
drums.wav
bass.wav
music.wav
textures.wav
fx.wav
```

Advanced mode:

- one stem per track.

---

# 107. Loop Export

Export a selected pattern or loop.

Options:

- exact musical length,
- include effect tail,
- seamless loop mode.

---

# 108. Scene Mode

Scene Mode provides a workflow for composing against visual or interactive scenes.

It may define:

```text
Duration
Tempo
Key
Markers
Intensity
```

---

# 109. Absolute Time View

In Scene Mode, the timeline may display:

```text
seconds
milliseconds
```

alongside:

```text
bars
beats
```

---

# 110. Scene Markers

Markers may identify visual events.

Example:

```text
0.0s   INTRO
8.0s   BUILD
16.0s  DROP
27.5s  FLASH
32.0s  END
```

---

# 111. Scene Intensity

Scene Mode may expose:

```text
INTENSITY
0.0 → 1.0
```

Intensity can become a modulation source.

Possible mappings:

- percussion density,
- filter cutoff,
- bass drive,
- texture amount,
- reverb,
- distortion.

---

# 112. Scene Event Export

Future export:

```json
{
  "time": 16,
  "type": "DROP"
}
```

These events may be consumed by QFX and other visual tools.

---

# 113. Score Package

Future structured export:

```text
project.scorepack
│
├─ audio/
├─ score.json
├─ markers.json
├─ automation.json
└─ manifest.json
```

---

# 114. QFX Integration

Potential integrations:

- timeline markers,
- BPM,
- beat grid,
- stems,
- intensity,
- scene events,
- automation curves.

Pulse Forge and QFX must remain independently usable.

---

# 115. Audio Canvas Integration

Possible exports:

- master audio,
- individual stems,
- beat markers,
- waveform metadata.

---

# 116. Signal Lab Integration

Potential workflows:

```text
Track / Stem
      ↓
Signal Lab
```

for:

- waveform,
- spectrum,
- stereo analysis,
- visual experiments.

---

# 117. VocalForge Integration

Pulse Forge does not implement vocal production.

Instead:

```text
Pulse Forge
    ↓
Instrumental / stems
    ↓
VocalForge
```

This keeps product boundaries clean.

---

# 118. Local-First Operation

Core features must work offline once required sound assets are present.

Offline capabilities:

- project creation,
- sequencing,
- synthesis,
- sampling,
- mixing,
- effects,
- automation,
- saving,
- rendering,
- WAV export.

---

# 119. Asset Cache

Downloaded factory assets should be locally cached.

Users should be able to see:

- cached,
- online only,
- downloaded pack.

---

# 120. Storage Management

Future settings may show:

```text
Projects        120 MB
Factory Packs   1.4 GB
User Samples    680 MB
Waveform Cache   90 MB
```

Users may clear caches without deleting projects.

---

# 121. Diagnostics

Advanced diagnostics panel:

- audio context state,
- sample rate,
- scheduler state,
- active voices,
- loaded samples,
- worklet state,
- cache size,
- render status.

---

# 122. Performance Mode

Future feature.

Potential options:

```text
Balanced
High Quality
Low CPU
```

Any quality tradeoff must be explicit.

---

# 123. Visual Performance

Heavy visual features may be disabled independently:

- spectrum animation,
- waveform animation,
- decorative effects,
- advanced meters.

Audio quality should remain prioritized.

---

# 124. Accessibility

Core controls should support:

- keyboard navigation,
- readable labels,
- focus states,
- tooltips,
- numerical value entry.

Color alone should not communicate critical state.

---

# 125. Touch Support

Pulse Forge should aim for usable touch interaction where practical.

High-value touch targets:

- drum pads,
- sequencer,
- knobs,
- faders,
- scene launch controls.

Desktop browser remains the primary initial target.

---

# 126. Responsive Design

Primary target:

```text
Desktop / Laptop
```

Secondary:

```text
Large Tablet
```

Phones may support limited use later but should not constrain the desktop workflow.

---

# 127. AI Features

AI is not required for core music creation.

Potential future optional capabilities:

- semantic sound search,
- preset suggestions,
- beat variation suggestions,
- pattern generation,
- mix suggestions,
- sound description search.

AI features must not make project playback dependent on a remote model.

---

# 128. Generative Rhythm Tools

Future deterministic tools:

- Fill Generator
- Hat Generator
- Percussion Variation
- Euclidean Rhythm Generator
- Velocity Humanizer
- Probability Generator

Generated output should become editable project data.

---

# 129. Randomization

Randomization should support:

```text
Randomize
Humanize
Mutate
```

with undo support.

Randomization affecting playback must support project seeds.

---

# 130. Preset Morphing

Future feature.

Interpolate between compatible presets:

```text
Preset A ←────●────→ Preset B
```

Useful for:

- synths,
- effects,
- macros.

---

# 131. Snapshot System

Future feature.

Capture a track or device state.

Example:

```text
Clean
Dirty
Break
Drop
```

Snapshots may later integrate with scenes.

---

# 132. Freeze

Future optimization feature.

A heavy instrument/effect chain may be rendered to temporary audio.

Benefits:

- lower CPU,
- stable playback.

Not required for MVP.

---

# 133. Bounce in Place

Future feature.

Render:

```text
instrument + effects
```

into:

```text
audio asset
```

while retaining undo/recovery options.

---

# 134. MIDI Input

Future feature.

Browser MIDI support may allow:

- keyboard input,
- pad controller input,
- knob/fader control.

MIDI hardware is optional and not required for basic operation.

---

# 135. MIDI Learn

Future feature.

Map external MIDI controls to:

- macros,
- mixer,
- synth parameters,
- effect parameters.

---

# 136. Computer Keyboard Performance

The computer keyboard may act as:

- piano keyboard,
- drum pad trigger.

Useful for users without MIDI hardware.

---

# 137. Metronome

Features:

- on/off,
- volume,
- accent first beat,
- custom sound future option.

---

# 138. Count-In

Potential options:

```text
1 bar
2 bars
```

Useful for live note input.

---

# 139. Recording

Pulse Forge may support limited MIDI-style performance recording.

Possible:

- note recording,
- drum pad recording,
- automation recording.

Audio recording is not a core feature.

---

# 140. Quantization

Supported values:

```text
1/4
1/8
1/16
1/32
triplets
```

Quantize amount may later support partial strength.

---

# 141. Humanize

Humanize may affect:

- timing,
- velocity.

Controls:

```text
Timing
Velocity
Seed
```

---

# 142. Duplicate Workflow

Fast duplication is critical.

Users should quickly duplicate:

- notes,
- patterns,
- scenes,
- tracks,
- effects,
- pads.

---

# 143. Templates

Future factory templates:

- House
- Techno
- Trap
- Ambient
- Experimental
- Scene Score

Templates may preconfigure:

- tracks,
- buses,
- returns,
- master chain.

---

# 144. Empty Project

The empty project should remain genuinely empty enough for advanced users.

Factory templates must not become mandatory.

---

# 145. Starter Project

A default starter project may contain:

```text
Drums
Bass
Synth
Texture
Reverb Return
Delay Return
Master
```

This may be optional during project creation.

---

# 146. Onboarding

Onboarding should teach through interaction.

Example:

```text
1. Pick a kick
2. Add four steps
3. Press Play
4. Add bass
```

Avoid long tutorial dialogs.

---

# 147. Tooltips

Technical controls should explain themselves.

Example:

```text
Resonance
Emphasizes frequencies around the filter cutoff.
```

---

# 148. Semantic Controls

Where useful, Pulse Forge should expose controls such as:

```text
Punch
Body
Weight
Air
Warmth
Grit
Movement
Space
```

These should map predictably to underlying parameters.

---

# 149. Advanced Panels

Simple controls may reveal advanced settings.

Example:

```text
Bass Synth

BODY
GRIT
PUNCH

[ Advanced ]
```

Advanced users retain precise control.

---

# 150. Feature Tiers

## Tier 1: Core MVP

Required to prove the product.

### Creation

- Drum Rack
- General Sampler
- Analog Synth
- Bass Synth
- 808 Synth

### Sequencing

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
- Pump
- Reverb
- Delay
- Chorus

### System

- Mixer
- Buses
- Returns
- Automation
- LFO
- Presets
- Sample Browser
- Project persistence
- Undo/Redo
- Offline WAV export
- Stem export

---

# 151. Tier 2: Production Expansion

Adds depth after the core workflow is stable.

- Texture Synth
- Distortion
- Bitcrusher
- Phaser
- Flanger
- Drum Buss
- Bass Buss
- Master Processor
- Step Modulator
- richer automation curves
- downloadable sound packs
- detailed loudness metering
- MIDI input
- templates
- loop export.

---

# 152. Tier 3: Advanced Creative Systems

- Envelope Follower
- Granular synthesis
- Advanced reverb
- Groove extraction
- Preset morphing
- Snapshots
- Freeze
- Bounce in place
- high-quality pitch shifting
- basic time stretching
- live scene launch
- advanced MIDI mapping.

---

# 153. Tier 4: Ecosystem Integration

- Scene Mode
- Scene Intensity
- scene events
- QFX synchronization
- score packages
- Audio Canvas integration
- Signal Lab integration
- BPM Analyzer metadata pipeline
- VocalForge stem workflow.

---

# 154. Tier 5: Optional Intelligence

- semantic sample search
- intelligent sample recommendations
- deterministic pattern generation
- mix assistance
- preset suggestions
- AI-assisted sound discovery.

AI remains optional.

---

# 155. Explicit Non-Goals

Pulse Forge does not aim to provide:

- VST hosting,
- AU hosting,
- ASIO management,
- full multitrack audio recording,
- vocal production,
- pitch correction,
- Melodyne-style editing,
- professional orchestral scoring,
- massive sample-library streaming,
- full video editing,
- advanced spectral repair,
- mastering-suite parity,
- complete Ableton-style warp,
- complete traditional DAW parity.

---

# 156. MVP Definition of Success

The MVP succeeds if a user can:

```text
open Pulse Forge
      ↓
choose drums
      ↓
build a groove
      ↓
write bass
      ↓
add a synth
      ↓
process tracks
      ↓
arrange a full beat
      ↓
mix it
      ↓
export a clean WAV
```

without requiring another music application.

---

# 157. Production Definition of Success

A production-ready Pulse Forge project should be capable of producing:

- stable playback,
- musically accurate timing,
- polished drums,
- controlled bass,
- useful synth sounds,
- musical automation,
- coherent arrangement,
- clean stereo output,
- reproducible offline renders.

---

# 158. Factory Content Definition of Success

Factory content succeeds when users can create strong results without importing external sound packs.

The built-in library should feel:

```text
curated
modern
musical
usable
consistent
```

not merely large.

---

# 159. UX Definition of Success

A user unfamiliar with Pulse Forge should be able to create the first usable rhythm within minutes.

A knowledgeable producer should discover deeper control without feeling constrained by beginner-oriented simplification.

---

# 160. Final Feature Principle

Pulse Forge should not win because it has the most features.

It should win because the important features feel unusually coherent.

The desired experience is:

```text
I know what I want to hear.
        ↓
Pulse Forge lets me get there quickly.
        ↓
When I want more control, it is available.
        ↓
When I am finished, I can actually use the result.
```

Every future feature should protect that experience.
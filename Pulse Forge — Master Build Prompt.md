# Pulse Forge — Master Build Prompt

Build **Pulse Forge**, a serious browser-first electronic music production workstation focused on beatmaking, instrumental composition, sound design, arrangement, mixing, and high-quality export.

This is **not** a toy beat sequencer and **not** an attempt to recreate Ableton Live, FL Studio, Logic, or Bitwig feature-for-feature.

The goal is narrower and more deliberate:

> Build a focused browser-native workstation where a user can create a genuinely usable electronic beat from scratch using only the built-in instruments, samples, sequencing tools, effects, mixer, automation, and export pipeline.

Pulse Forge must feel like a coherent instrument, not a collection of disconnected widgets.

The project must be architected for long-term development.

Do not optimize for the fastest possible demo.

Optimize for:

- architectural clarity,

- deterministic behavior,

- timing correctness,

- stable audio execution,

- maintainable DSP boundaries,

- local-first operation,

- production-quality UX,

- future Rust/WASM DSP expansion,

- future scene synchronization with the wider Qvester ecosystem.

---

# 1. Product Identity

Pulse Forge is:

- a beat workstation,

- an electronic composition environment,

- a sound design tool,

- a compact production environment,

- a future scene-scoring engine.

Primary musical use cases:

- house,

- techno,

- electronic,

- trap,

- ambient,

- cinematic electronic,

- experimental beats,

- short scene accompaniment.

The core user workflow is:

```text
CREATE PROJECT
    ↓
CHOOSE SOUNDS
    ↓
BUILD RHYTHM
    ↓
ADD BASS / SYNTH
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

Everything in the application should support this loop.

---

# 2. Explicit Non-Goals

Do NOT build:

- VST hosting,

- AU hosting,

- ASIO integration,

- native audio-driver management,

- vocal recording,

- vocal comping,

- pitch correction,

- Melodyne-style editing,

- large multitrack recording,

- orchestral sample streaming,

- advanced spectral restoration,

- full Ableton-style warping,

- video editing,

- server-required audio rendering,

- cloud-dependent project playback.

Do not introduce complexity for capabilities that the product intentionally does not need.

---

# 3. Platform Strategy

Pulse Forge is **browser-first**.

Primary target:

```text
Modern desktop Chromium-class browser
```

Secondary future targets:

- large tablets,

- PWA,

- desktop wrapper.

Do not architect the product around Electron, Tauri, C++, or native audio APIs.

The browser implementation is the primary product, not a prototype.

---

# 4. Technology Stack

Use:

- React,

- TypeScript,

- modern CSS,

- Web Audio API,

- AudioWorklet,

- IndexedDB,

- OPFS where appropriate,

- Web Workers for non-realtime heavy processing.

Allow future use of:

- Rust,

- WebAssembly.

Rust/WASM must be introduced only behind explicit DSP boundaries.

Do not make Rust responsible for application logic, project state, React state, routing, or UI.

---

# 5. Architectural North Star

Use this architecture:

```text
            PULSE FORGE
                 │
                 ▼
        React / TypeScript UI
                 │
                 ▼
          Command System
                 │
                 ▼
           Project Model
                 │
       ┌─────────┴─────────┐
       ▼                   ▼
   Sequencer            Automation
       │                   │
       └─────────┬─────────┘
                 ▼
             Transport
                 │
                 ▼
             Scheduler
                 │
                 ▼
        Q Audio Engine
                 │
          ┌──────┴──────┐
          ▼             ▼
     Web Audio       AudioWorklet
       Nodes              │
                          ▼
                     DSP Modules
                          │
                     ┌────┴────┐
                     ▼         ▼
                     TS       WASM
```

This separation is mandatory.

---

# 6. Critical Architectural Rules

## Rule A: React does not own audio execution

Never make React state the authoritative source of realtime audio behavior.

Do not build core logic such as:

```ts
useEffect(() => {
  audioNode.frequency.value = cutoff;
}, [cutoff]);
```

as the primary architecture.

Instead:

```text
UI
↓
Command
↓
Project Model
↓
Engine Synchronization
↓
Audio Runtime
```

UI represents intent.

The audio engine executes intent.

---

## Rule B: UI timers are not musical clocks

Do not use:

```ts
setInterval(...)
```

or

```ts
requestAnimationFrame(...)
```

to determine when notes should sound.

Use:

```text
Musical Time
↓
Transport
↓
Lookahead Scheduler
↓
AudioContext Time
```

Schedule events ahead against the Web Audio clock.

The visual playhead follows audio timing.

Audio timing must never follow the visual playhead.

---

## Rule C: Persisted state is pure data

Project documents must never contain:

- AudioNodes,

- AudioParams,

- DOM objects,

- React objects,

- worklet instances,

- browser handles.

Runtime audio state must always be reconstructable from serializable project data.

---

## Rule D: AudioWorklet owns custom realtime DSP

Heavy or timing-sensitive realtime audio processing must never run on the main thread.

Use AudioWorklet for custom processors.

---

## Rule E: Rust/WASM is optional, not foundational

Simple DSP may initially use Web Audio or TypeScript AudioWorklet logic.

Rust/WASM may later replace expensive processors such as:

- oversampled clipping,

- saturation,

- custom compression,

- transient processing,

- advanced filters,

- granular DSP,

- advanced reverb.

Use an adapter boundary so the rest of the application does not know whether a processor is TypeScript or WASM.

---

# 7. Repository Structure

Prefer a modular structure similar to:

```text
pulse-forge/
│
├─ apps/
│  └─ web/
│
├─ packages/
│  ├─ project-model/
│  ├─ commands/
│  ├─ transport/
│  ├─ scheduler/
│  ├─ sequencer/
│  ├─ automation/
│  ├─ audio-engine/
│  ├─ audio-worklets/
│  ├─ instruments/
│  ├─ effects/
│  ├─ mixer/
│  ├─ persistence/
│  ├─ rendering/
│  ├─ sample-library/
│  ├─ presets/
│  ├─ waveform/
│  ├─ shared/
│  └─ ui/
│
├─ crates/
│  └─ dsp-core/
│
├─ docs/
│
└─ tests/
```

Do not over-split prematurely if the project tooling makes this unnecessarily difficult.

The responsibility boundaries matter more than exact folder names.

---

# 8. Project Model

Create a canonical versioned Pulse Forge project schema.

Conceptually:

```ts
interface PulseForgeProject {
  schemaVersion: number;
  id: string;
  name: string;

  bpm: number;
  timeSignature: TimeSignature;

  tracks: Track[];
  patterns: Pattern[];
  scenes: Scene[];
  arrangement: ArrangementItem[];

  buses: Bus[];
  returns: ReturnTrack[];
  automation: AutomationLane[];

  master: MasterConfig;
  assets: AssetReference[];
}
```

All IDs must be stable.

Use explicit schema versioning from day one.

---

# 9. Command System

All meaningful project mutations should go through commands.

Examples:

```text
CreateTrack
DeleteTrack
RenameTrack
SetTempo
CreatePattern
DuplicatePattern
ToggleStep
SetStepVelocity
SetTrackVolume
SetTrackPan
AddEffect
RemoveEffect
SetParameter
CreateAutomationPoint
MoveAutomationPoint
```

Commands should make future support for the following possible:

- undo,

- redo,

- command history,

- automation,

- macros,

- collaboration,

- scripting,

- agent control.

Implement proper undo/redo early.

---

# 10. Transport

Create a central Transport service.

It owns:

- play,

- pause,

- stop,

- BPM,

- position,

- loop state,

- loop range,

- bar/beat conversion.

Separate:

```text
Musical Time
Audio Time
UI Time
```

Musical timing should use an internal tick or pulse representation with enough resolution for:

- microtiming,

- swing,

- ratchets,

- automation.

Do not use floating-point seconds as the only canonical representation of musical position.

---

# 11. Scheduler

Implement a lookahead scheduler.

The scheduler should periodically inspect a short future window and schedule events using AudioContext timing.

Support at minimum:

- sample trigger,

- note-on,

- note-off,

- step velocity,

- loop wrap,

- stop,

- seek.

Design the scheduler so future support is possible for:

- microtiming,

- swing,

- ratchets,

- probability,

- automation.

Do not attempt all advanced sequencing features immediately.

---

# 12. First Vertical Slice

The first functional milestone must be intentionally small.

Build this first:

```text
Create Project
↓
Drum Track
↓
16-Step Sequencer
↓
Kick Sample
↓
4-on-the-floor Pattern
↓
Play
↓
Stable Timing
↓
Stop
↓
Save
↓
Reload
↓
Same Pattern Still Plays
```

This milestone is more important than building a visually complete application.

Do not build ten instruments before this works reliably.

---

# 13. Drum Rack

Implement a 16-pad Drum Rack.

Each pad should support at least:

- sample reference,

- gain,

- pan,

- pitch,

- sample start,

- sample end,

- attack,

- release,

- reverse,

- mute,

- solo.

Prepare the data model for:

- choke groups,

- filtering,

- drive,

- output routing.

Do not necessarily implement all of those immediately.

---

# 14. Sample Playback

Use a dedicated sample playback abstraction.

Do not scatter raw AudioBufferSourceNode creation throughout the application.

Provide something conceptually like:

```ts
sampleEngine.trigger({
  assetId,
  time,
  gain,
  pitch,
  start,
  duration
});
```

Centralize:

- decoding,

- caching,

- triggering,

- disposal.

---

# 15. Step Sequencer

Initial sequencer:

- 16 steps,

- one row per drum pad,

- toggle step,

- velocity,

- current-step indication.

Then expand to:

- 32 steps,

- 64 steps,

- probability,

- ratchets,

- microtiming,

- accent,

- per-step parameter values.

Grid interaction must be fast.

---

# 16. Piano Roll

After the Drum Rack and scheduler are reliable, add Piano Roll support for instrument tracks.

Required:

- note create,

- note move,

- note resize,

- note delete,

- multi-select,

- velocity,

- grid snap,

- zoom.

Do not build a giant MIDI editor initially.

---

# 17. Patterns

Patterns should be reusable.

Support:

- create,

- rename,

- duplicate,

- delete,

- resize.

Typical musical workflow:

```text
A
A2
B
Fill
Break
```

Duplicating and varying patterns must be extremely fast.

---

# 18. Scenes

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

A scene should reference patterns rather than duplicate their data.

Scene launching does not need to be implemented in the first milestone.

---

# 19. Arrangement

Provide a linear arrangement timeline.

Users must be able to:

- place scenes,

- duplicate them,

- move them,

- reorder them,

- define arrangement length,

- loop regions.

Do not build an overly complicated DAW timeline.

The arrangement should remain focused on pattern/scene composition.

---

# 20. Factory Sound Library Architecture

Do not bundle a giant audio library into the main application.

Build a manifest-driven library.

Conceptually:

```text
Library Manifest
      │
      ▼
Search / Filter
      │
      ▼
Preview Request
      │
      ▼
Fetch Asset
      │
      ▼
Decode
      │
      ▼
Cache
```

Support metadata such as:

```text
id
name
category
subCategory
tags
style
character
duration
rootNote
key
fileUrl
previewUrl
```

---

# 21. Initial Sound Categories

Prepare categories for:

```text
DRUMS

Kick
Snare
Clap
Closed Hat
Open Hat
Ride
Cymbal
Percussion
Shaker
Rim
Tom


BASS

Sub
808
House
Techno
Reese
FM
Acid


TONAL

Pluck
Stab
Chord
Keys
Bell
Lead
Pad


FX

Impact
Riser
Sweep
Drop
Noise
Glitch
Transition
Atmosphere
```

The initial repository does not need hundreds of final production samples.

Use a small legal development bank first.

The architecture must support a much larger library later.

Do not use copyrighted or questionable sample assets.

---

# 22. Sample Browser UX

Create a polished sample browser with:

- category navigation,

- text search,

- tags,

- favorites,

- recent items,

- preview,

- drag-and-drop.

Sample names must not be the only discovery method.

The long-term experience should be based on musical intent.

---

# 23. Instruments

The target instrument family is:

```text
Drum Rack
General Sampler
Analog Synth
Bass Synth
808 Synth
Texture Synth
```

Do not implement every instrument simultaneously.

Recommended order:

1. Drum Rack

2. General Sampler

3. Analog Synth

4. Bass Synth

5. 808 Synth

6. Texture Synth

---

# 24. Analog Synth

Implement a compact subtractive synth with:

```text
OSC A
OSC B
SUB
NOISE
↓
FILTER
↓
AMP
```

Minimum controls:

- waveform,

- octave,

- detune,

- mix,

- cutoff,

- resonance,

- filter envelope,

- amp ADSR,

- master gain.

Do not overbuild the first synth.

It should sound clean and musical.

---

# 25. Bass Synth

Bass Synth should provide two levels of control.

Primary UI:

```text
SUB
BODY
PUNCH
GRIT
MOVEMENT
WIDTH
```

Advanced UI may expose actual oscillator/filter/envelope parameters.

Semantic controls must produce predictable results.

Do not fake them with meaningless random parameter changes.

---

# 26. 808 Synth

Implement a dedicated synthesized 808 instrument.

Target features:

- sine-based body,

- pitch drop envelope,

- amp decay,

- transient click,

- glide,

- saturation,

- harmonics,

- tone,

- output.

Later support:

- slide notes.

---

# 27. Texture Synth

Do not make Texture Synth part of the earliest milestone.

Long-term it should target:

- pads,

- drones,

- atmosphere,

- evolving noise,

- cinematic texture.

Potential future architecture may include granular DSP.

Do not introduce granular processing until the audio foundation is stable.

---

# 28. Shared Parameter System

All instruments and effects should use a common parameter definition.

Conceptually:

```ts
interface ParameterDefinition {
  id: string;
  label: string;
  min: number;
  max: number;
  defaultValue: number;
  unit?: string;
  scale?: "linear" | "log" | "exp";
}
```

Parameters should be addressable using stable IDs.

Example:

```text
instrument.filter.cutoff
effect.drive
track.volume
send.reverb
```

This is required for:

- automation,

- modulation,

- macros,

- preset serialization.

---

# 29. Automation

Automation is a core product feature.

Initial support:

- volume,

- pan,

- filter cutoff,

- effect parameters,

- macro controls.

Minimum interpolation:

- step,

- linear.

Automation data must live in the project model.

It must not live inside UI widgets.

---

# 30. LFO System

Implement reusable LFO modulation.

Waveforms:

- sine,

- triangle,

- square,

- saw up,

- saw down,

- random,

- sample and hold.

Modes:

- free Hz,

- tempo sync.

Targets should use the shared parameter system.

---

# 31. Modulation Matrix

Architect for:

```text
SOURCE
↓
TARGET
↓
AMOUNT
```

Example:

```text
LFO 1 → Filter Cutoff → +50%
Velocity → Saturation → +20%
```

Do not hardwire individual modulation relationships directly into instrument UI.

---

# 32. Macro System

Provide macro controls.

Example:

```text
DIRT
SPACE
MOVEMENT
PUNCH
```

One macro may control multiple underlying parameters.

Macros must be declarative and serializable.

---

# 33. Mixer

Create a compact production mixer.

Each channel should support:

- volume,

- pan,

- mute,

- solo,

- peak meter,

- insert effects,

- send levels,

- output bus.

Avoid recreating a giant analog console.

---

# 34. Buses and Returns

Support:

- user-created buses,

- return tracks,

- master.

Useful initial factory returns:

```text
Reverb
Delay
```

Potential default buses:

```text
DRUMS
BASS
MUSIC
FX
```

Do not hardcode these as permanent architectural identities.

---

# 35. Effect Rack

Each track should support ordered inserts.

Users must be able to:

- add,

- remove,

- reorder,

- bypass,

- reset effects.

The rack UI should use a common device shell.

---

# 36. Initial Effects

Implement the first production set in roughly this order:

## Tone

- Parametric EQ

- Filter

## Dynamics

- Compressor

- Transient Shaper

## Character

- Saturation

- Clipper

## Space

- Reverb

- Delay

## Modulation

- Chorus

## Movement

- Pump / Sidechain Volume Shaper

Do not implement 25 mediocre effects before these are usable.

---

# 37. Parametric EQ

Target eventually:

- 6 bands,

- filter graph,

- spectrum overlay.

Initial version may begin with fewer bands if necessary.

Band types:

- low cut,

- low shelf,

- bell,

- high shelf,

- high cut.

---

# 38. Compressor

Controls:

```text
Threshold
Ratio
Attack
Release
Knee
Makeup
Mix
```

Provide useful defaults.

Visualize gain reduction.

---

# 39. Transient Shaper

Primary controls:

```text
ATTACK
SUSTAIN
OUTPUT
```

Design it specifically for drums and bass.

---

# 40. Saturation

Provide a musical saturation processor.

Minimum controls:

```text
DRIVE
TONE
MIX
OUTPUT
```

Start with one reliable algorithm.

Prepare architecture for multiple modes later.

---

# 41. Clipper

Provide:

```text
DRIVE
CEILING
SOFTNESS
OUTPUT
```

Design the DSP boundary so future oversampling can be implemented in Rust/WASM.

Do not build oversampling prematurely if it delays the vertical slice.

---

# 42. Reverb

Start with a practical production reverb.

Controls:

- size,

- decay,

- damping,

- pre-delay,

- width,

- mix.

A creative Space Reverb may come later.

---

# 43. Delay

Support:

- tempo sync,

- free time,

- feedback,

- filtering,

- stereo,

- ping-pong,

- wet/dry.

---

# 44. Chorus

Controls:

- rate,

- depth,

- width/spread,

- mix.

---

# 45. Pump / Sidechain

This is an important beatmaking feature.

Implement tempo-synchronized volume shaping independently from compressor sidechaining.

Controls:

```text
AMOUNT
ATTACK
HOLD
RELEASE
CURVE
SYNC
```

Target workflows:

- house bass pumping,

- pad ducking,

- rhythmic movement.

Audio-triggered sidechain can be added later.

---

# 46. Future Effects

Prepare the device architecture for:

```text
Tilt EQ
Punch Compressor
Gate
Distortion
Bitcrusher
Phaser
Flanger
Stereo Utility
Mono Bass
Drum Buss
Bass Buss
Master Processor
Limiter
Space Reverb
```

Do not implement all of these initially.

---

# 47. Master Chain

Initial master should support:

```text
metering
↓
optional tone shaping
↓
optional clipping
↓
limiting
```

The first version should avoid fake "one-button mastering".

Prioritize transparency.

---

# 48. Metering

Implement:

- track peak meters,

- master peak meter,

- RMS if practical.

Later:

- LUFS,

- stereo correlation,

- true peak.

Meter visual refresh must be throttled.

Do not send audio-rate data to React.

---

# 49. Web Workers

Use Web Workers for:

- waveform generation,

- audio analysis,

- metadata extraction,

- project packaging,

- non-realtime heavy computation.

Do not use them as a substitute for AudioWorklet realtime DSP.

---

# 50. AudioWorklet

Create AudioWorklet infrastructure early even if the first processors are simple.

Define:

- processor registration,

- lifecycle,

- parameter transport,

- messaging,

- disposal,

- diagnostics.

The first custom processor can be minimal.

The important goal is proving the architecture.

---

# 51. Rust/WASM DSP Boundary

Create a placeholder or experimental Rust DSP workspace after the TypeScript/Web Audio foundation is stable.

Recommended first Rust/WASM proof:

```text
simple saturator
```

or:

```text
clipper
```

The test should prove:

```text
AudioWorklet
↓
WASM module
↓
block processing
↓
audio output
```

Do not move production-critical DSP to Rust until this path is measured and understood.

---

# 52. WASM Rules

Never call WASM once per individual sample from JavaScript.

Pass blocks or operate directly on worklet buffers.

Avoid unnecessary copying.

Keep the JS/WASM boundary coarse.

---

# 53. Persistence

Use IndexedDB for:

- project documents,

- project metadata,

- presets,

- application settings,

- library metadata.

Use OPFS when appropriate for:

- user samples,

- cached sound packs,

- rendered files,

- waveform cache,

- larger binary data.

Implement storage through repository/service abstractions.

Do not scatter IndexedDB calls throughout UI components.

---

# 54. Autosave

Implement debounced autosave.

Requirements:

- project dirty tracking,

- visible save status,

- no blocking of audio playback,

- recovery after refresh/crash where practical.

---

# 55. Asset Identity

Samples must use stable asset IDs.

Do not store temporary blob URLs as canonical project references.

Example:

```text
factory.kick.house.deep.001
```

or:

```text
user.asset.<uuid>
```

---

# 56. Asset Missing State

If a referenced user asset cannot be found:

- do not crash,

- mark it missing,

- preserve its metadata,

- allow relinking.

Never silently substitute another sound.

---

# 57. Waveforms

Generate lightweight peak data for samples.

Cache waveform data.

Do not repeatedly decode entire files just to draw them.

---

# 58. Presets

Presets must be data.

Support presets for:

- instruments,

- effects,

- device chains later.

Preset files should store:

- device type,

- version,

- parameters,

- metadata.

---

# 59. Factory Preset UX

Avoid:

```text
Preset 001
Preset 002
```

Use categories and musical names.

Example:

```text
Bass Synth

HOUSE
  Deep
  Rolling
  Rubber

TECHNO
  Driving
  Acid
  Industrial
```

---

# 60. Export

Offline export is mandatory for the production milestone.

Use a shared graph-building model for:

```text
AudioContext
```

and:

```text
OfflineAudioContext
```

Do not create a completely separate DSP implementation for rendering.

---

# 61. WAV Export

Canonical format:

```text
WAV
```

Target:

- 44.1 kHz,

- 48 kHz,

- 16-bit PCM,

- 24-bit PCM,

- optional 32-bit float.

Implement a reliable WAV encoder.

---

# 62. Stem Export

Support:

- master,

- drums,

- bass,

- music,

- FX,

or one stem per track.

Render stems using the same project state.

---

# 63. Render Tail

Allow effect tails after arrangement end.

Examples:

- reverb,

- delay.

Do not cut effects abruptly at export.

---

# 64. UI Layout

Create a professional workstation layout.

Suggested structure:

```text
┌────────────────────────────────────────────────────────────┐
│ Top Transport / Project Bar                               │
├───────────────┬───────────────────────────────┬────────────┤
│ Browser       │ Main Workspace                │ Inspector  │
│               │                               │            │
│ Samples       │ Sequencer / Piano Roll        │ Device     │
│ Instruments   │ Arrangement                   │ Controls   │
│ Effects       │                               │            │
├───────────────┴───────────────────────────────┴────────────┤
│ Mixer / Device Rack / Bottom Panel                        │
└────────────────────────────────────────────────────────────┘
```

Do not clone Ableton pixel-for-pixel.

Create an original Pulse Forge identity.

---

# 65. Visual Direction

Pulse Forge should feel:

- precise,

- dark,

- modern,

- technical,

- musical,

- clean,

- dense without being cluttered.

Avoid:

- neon overload,

- giant gradients everywhere,

- excessive glassmorphism,

- oversized rounded mobile cards,

- toy-like drum machine aesthetics.

Use restrained visual hierarchy.

The UI should look like software people can work inside for hours.

---

# 66. Interaction Philosophy

Prioritize:

- direct manipulation,

- drag-and-drop,

- keyboard shortcuts,

- fast auditioning,

- minimal modal dialogs,

- quick duplication,

- reversible actions.

Users should rarely need to leave the main workspace.

---

# 67. Knobs and Sliders

Create reusable musical control components.

Requirements:

- mouse drag,

- double-click reset,

- numerical display,

- fine adjustment modifier,

- keyboard accessibility,

- parameter tooltip,

- optional manual value entry.

Do not tie controls directly to Web Audio objects.

---

# 68. Semantic Controls

For specialized devices, allow simplified controls such as:

```text
PUNCH
BODY
GRIT
SPACE
MOVEMENT
WIDTH
```

Provide advanced views where useful.

The simplified controls must map consistently to real underlying parameters.

---

# 69. Keyboard Shortcuts

At minimum:

```text
Space       Play/Pause
Ctrl+Z      Undo
Ctrl+Y      Redo
Ctrl+S      Save
Ctrl+C      Copy
Ctrl+V      Paste
Ctrl+D      Duplicate
Delete      Delete selected
```

Design shortcuts centrally.

Do not sprinkle keyboard listeners throughout components.

---

# 70. Performance Priority

Use this priority order:

```text
1. audio stability
2. timing correctness
3. project integrity
4. editing responsiveness
5. visual polish
```

If visual animation becomes expensive, reduce visual work first.

Never sacrifice audio stability to preserve decorative animation.

---

# 71. Realtime Safety

AudioWorklet DSP must avoid:

- frequent allocations,

- blocking calls,

- network access,

- file access,

- large object creation,

- unpredictable garbage.

Prefer:

- typed arrays,

- reusable buffers,

- stable data structures.

---

# 72. Diagnostics

Create a hidden or developer diagnostics panel.

Expose:

- AudioContext state,

- sample rate,

- scheduler horizon,

- scheduled events,

- active voices,

- loaded samples,

- worklet status,

- render status,

- cache size.

This will be critical during development.

---

# 73. Error Handling

If an effect or instrument runtime fails:

- preserve the project,

- isolate the failing device,

- bypass where possible,

- report diagnostics,

- do not crash the entire application.

---

# 74. Deterministic Randomness

Probability, humanization, and future generative features must support seeded randomness.

The same project should produce the same render when the seed is unchanged.

---

# 75. Project Compatibility

Never silently change how old projects sound.

Version:

- project schema,

- instrument presets,

- effect presets,

- major DSP behavior where necessary.

Provide migrations.

---

# 76. Testing

Implement tests from the beginning.

## Unit tests

For:

- transport math,

- commands,

- project model,

- pattern operations,

- automation interpolation,

- migrations.

## Audio tests

Use OfflineAudioContext where practical.

Test:

- sample triggering,

- timing,

- gain,

- loop behavior,

- effect output.

## E2E

Critical flow:

```text
Create project
Create drum pattern
Play
Save
Reload
Play
Export
```

---

# 77. Golden Audio Tests

For custom DSP, add deterministic audio reference tests when possible.

Use known input buffers.

Compare output with tolerance.

Especially important for future Rust/WASM DSP.

---

# 78. Do Not Fake Features

Do not create UI controls that do nothing.

Do not simulate audio analysis with random data.

Do not display fake meters.

Do not create placeholder buttons that look production-ready unless clearly marked as unavailable.

If a feature is not implemented, either:

- omit it,

- disable it clearly,

- mark it as planned.

The product should never lie about capabilities.

---

# 79. Build Order

Follow this approximate progression.

## Phase 0 — Foundation

- project schema,

- command system,

- undo/redo,

- transport,

- audio engine shell,

- persistence,

- diagnostics.

## Phase 1 — First Sound

- scheduler,

- sample cache,

- Drum Rack,

- 16-step sequencer,

- stable playback.

## Phase 2 — Beat Core

- velocities,

- multiple drum pads,

- pattern management,

- mixer,

- mute/solo,

- gain/pan.

## Phase 3 — Processing

- EQ,

- compressor,

- saturation,

- clipper,

- reverb,

- delay,

- pump.

## Phase 4 — Melodic Core

- General Sampler,

- Piano Roll,

- Analog Synth,

- Bass Synth,

- 808 Synth.

## Phase 5 — Composition

- scenes,

- arrangement,

- automation,

- LFO,

- macros.

## Phase 6 — Production

- buses,

- returns,

- master processing,

- offline render,

- WAV export,

- stem export.

## Phase 7 — Advanced DSP

- AudioWorklet expansion,

- Rust/WASM proof,

- selective migration of expensive DSP.

## Phase 8 — Scene Systems

- absolute-time scene mode,

- scene markers,

- scene intensity,

- Qvester score metadata.

---

# 80. Immediate Implementation Scope

For the initial implementation pass, focus on:

```text
Foundation
+
First Sound
+
minimal Beat Core
```

Do NOT attempt the entire specification in one giant uncontrolled pass.

The initial build should result in a visible and functioning application that can:

1. create/load a project,

2. show a professional workstation shell,

3. load a small development drum library,

4. display a 16-pad Drum Rack,

5. display a 16-step sequencer,

6. toggle drum steps,

7. play them using a real scheduler,

8. control BPM,

9. start/stop playback,

10. edit track gain,

11. save automatically,

12. reload the project correctly,

13. show basic engine diagnostics.

This is the first quality gate.

---

# 81. First Quality Gate

Before adding more instruments, verify:

```text
Does timing remain stable?

Does changing React state cause audio glitches?

Does playback continue smoothly while interacting with UI?

Does stop always stop?

Does seek behave predictably?

Does project reload reproduce the same beat?

Are samples decoded/cached correctly?

Does the scheduler survive loop boundaries?

Are runtime objects disposed correctly?
```

Fix these before expanding the product.

---

# 82. Second Quality Gate

Before introducing Rust/WASM, verify:

- Web Audio graph ownership is clean,

- AudioWorklet infrastructure works,

- DSP interfaces are stable,

- worklet lifecycle is reliable,

- no DSP implementation leaks into UI code.

Then create one isolated WASM DSP prototype.

Do not convert working systems simply because WASM exists.

---

# 83. Sound Quality Principle

Pulse Forge must sound good before it becomes large.

Do not prioritize:

```text
more devices
```

over:

```text
better devices
```

A good:

- kick,

- bass,

- EQ,

- compressor,

- saturation,

- reverb,

matters more than twenty unfinished plugins.

---

# 84. Factory Content Principle

Treat factory sound content as part of the product.

Eventually Pulse Forge should ship with a curated modern library capable of producing beats without external sample packs.

During early development use legally safe temporary assets.

Do not delay architecture waiting for the final sound bank.

---

# 85. Scene Mode Future Compatibility

Do not build Scene Mode initially.

However, ensure the underlying timeline and parameter systems can eventually support:

```text
absolute seconds
+
musical bars/beats
+
markers
+
normalized intensity
```

Scene Mode must reuse existing systems.

Do not build a second sequencer later.

---

# 86. Future Qvester Integration

Pulse Forge should eventually export structured metadata such as:

```json
{
  "bpm": 124,
  "key": "D minor",
  "duration": 32,
  "markers": [
    {
      "time": 0,
      "name": "intro"
    },
    {
      "time": 16,
      "name": "drop"
    }
  ]
}
```

This may later drive:

- QFX,

- visual effects,

- shaders,

- motion,

- scene intensity.

Keep these future integrations schema-driven.

Do not directly couple applications together.

---

# 87. Code Quality

Use strict TypeScript.

Avoid:

- giant components,

- giant stores,

- implicit any,

- circular dependencies,

- hidden global audio state,

- duplicate domain models.

Prefer:

- small domain services,

- explicit interfaces,

- adapters,

- pure project transformations,

- clear module boundaries.

---

# 88. Documentation

Maintain:

```text
VISION.md
ARCHITECTURE.md
FEATURES.md
```

Add ADRs for important architectural decisions.

Suggested initial ADRs:

```text
0001-browser-first.md
0002-audio-clock-scheduling.md
0003-project-model-runtime-separation.md
0004-audioworklet-boundary.md
0005-rust-wasm-dsp-policy.md
```

---

# 89. Comments

Do not comment obvious code.

Use comments to explain:

- realtime constraints,

- timing decisions,

- architectural invariants,

- unusual DSP math,

- browser-specific workarounds.

---

# 90. Development Safety

When modifying core audio systems:

- run typecheck,

- run tests,

- verify playback,

- verify project reload,

- verify no console errors.

Do not perform large blind refactors across multiple architecture layers without validation.

---

# 91. No Half-Wired UI

Do not build an enormous polished workstation interface first and leave the engine disconnected.

Prefer:

```text
small working surface
```

over:

```text
large fake product
```

Every visible core control should have real behavior.

---

# 92. UX Quality Bar

The first usable version should already feel deliberate.

Pay attention to:

- spacing,

- hierarchy,

- selected states,

- hover states,

- active transport state,

- readable numbers,

- consistent device controls,

- smooth drag interactions,

- professional typography.

Do not leave the interface looking like a generic admin dashboard.

---

# 93. Accessibility

Use:

- semantic controls,

- keyboard focus,

- accessible labels,

- visible focus states,

- tooltips.

Critical application state must not rely on color alone.

---

# 94. Responsive Policy

Optimize primarily for:

```text
1366×768 and above
```

Ensure good scaling at:

```text
1920×1080
2560×1440
```

Do not compromise the desktop workstation to make it phone-first.

---

# 95. Completion Requirement for Initial Build

At the end of the first implementation pass:

- run the application,

- run TypeScript typecheck,

- run available tests,

- inspect runtime console,

- verify actual audio playback,

- verify save/reload.

Do not stop with an unverified code dump.

If something cannot be completed, leave the repository in a coherent state and explicitly document:

- what works,

- what does not,

- exact next steps.

Do not pretend incomplete features are finished.

---

# 96. Final Product Principle

Pulse Forge should eventually make this possible:

```text
Open browser
↓
Choose a kick
↓
Build groove
↓
Add bass
↓
Add synth
↓
Shape sound
↓
Arrange
↓
Mix
↓
Export WAV
```

with no plugin installation, no DAW setup ritual, no backend dependency, and no sacrifice of architectural discipline.

The long-term goal is:

> A focused, production-capable browser-native beat workstation with a strong internal audio architecture, excellent built-in instruments and effects, and a clean path from TypeScript/Web Audio into AudioWorklet and Rust/WASM DSP where additional performance or audio quality is genuinely required.

Build the foundation for that product.

Do not build a disposable demo.

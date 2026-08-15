# ARCHITECTURE.md

# Pulse Forge
## Browser-First Hybrid Audio Architecture

---

# 1. Purpose

This document defines the technical architecture of Pulse Forge.

It exists to protect the project from architectural drift as the application grows from a focused beat workstation into a deeper browser-native music production environment.

Pulse Forge must remain:

- browser-first,
- local-first,
- deterministic,
- modular,
- production-oriented,
- testable,
- extensible,
- independent of external plugin ecosystems.

The architecture is designed around a strict principle:

> The UI describes intent.  
> The project model stores truth.  
> The transport defines musical time.  
> The scheduler plans audio events.  
> The audio engine executes them.  
> DSP processes sound.

No layer should silently absorb responsibilities belonging to another.

---

# 2. Architectural North Star

The primary architecture is:

```text id="4h7kxu"
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

This architecture is intentionally hybrid.

It does not force every subsystem into one language or runtime.

Instead:

- React owns interface rendering.
- TypeScript owns application logic and musical structures.
- Web Audio owns platform-level audio graph execution.
- AudioWorklet owns custom realtime processing.
- Rust/WASM owns advanced DSP only where justified.

---

# 3. Core Architectural Principles

## 3.1 Browser-First

Pulse Forge is designed to run as a serious browser-native application.

The browser is not treated as a prototype environment.

Core production must work without:

- native installers,
- C++ runtimes,
- system audio drivers,
- VST hosting,
- server-side processing.

The architecture may later support desktop packaging, but desktop-specific requirements must not contaminate the core design prematurely.

---

## 3.2 Local-First

Core creative work must not depend on a server.

The following must remain available offline once required assets are present:

- project loading,
- sequencing,
- synthesis,
- sampling,
- mixing,
- automation,
- playback,
- editing,
- rendering,
- export.

Cloud services may provide optional capabilities such as:

- asset delivery,
- preset distribution,
- backups,
- collaboration,
- analytics,
- account synchronization.

They must never become mandatory for basic music creation.

---

## 3.3 Audio Is Not UI State

React must never become the source of truth for realtime audio execution.

This architecture is forbidden:

```text id="folz7o"
React Component
      │
      ▼
setState()
      │
      ▼
AudioNode mutation
```

This pattern causes:

- timing instability,
- hidden coupling,
- difficult testing,
- lifecycle bugs,
- unpredictable synchronization.

Instead:

```text id="bba86p"
UI Interaction
      │
      ▼
Command
      │
      ▼
Project Model
      │
      ▼
Engine Projection
      │
      ▼
Audio Runtime
```

React renders state.

React does not define audio truth.

---

# 4. Repository Structure

A recommended high-level structure:

```text id="4238sa"
pulse-forge/
│
├─ apps/
│  └─ web/
│
├─ packages/
│  ├─ project-model/
│  ├─ commands/
│  ├─ transport/
│  ├─ sequencer/
│  ├─ automation/
│  ├─ audio-engine/
│  ├─ audio-worklets/
│  ├─ dsp-core/
│  ├─ instruments/
│  ├─ effects/
│  ├─ mixer/
│  ├─ rendering/
│  ├─ persistence/
│  ├─ sample-library/
│  ├─ presets/
│  ├─ waveform/
│  ├─ shared/
│  └─ ui/
│
├─ crates/
│  ├─ dsp-core/
│  ├─ dsp-saturation/
│  ├─ dsp-clipper/
│  ├─ dsp-compressor/
│  ├─ dsp-transient/
│  └─ dsp-utils/
│
├─ public/
│
├─ tests/
│
└─ docs/
```

The exact directory names may evolve.

The separation of responsibilities should not.

---

# 5. Application Layer

The application layer is implemented primarily in TypeScript.

It contains:

- project orchestration,
- commands,
- editing logic,
- undo/redo,
- selection state,
- arrangement operations,
- session lifecycle,
- import/export coordination.

This layer should not know implementation details of low-level DSP.

It should express intent in domain language.

Example:

```ts id="8rc6vf"
setTrackVolume(trackId, -6);
setInstrumentParameter(instrumentId, "filter.cutoff", 4200);
movePattern(patternId, targetBar);
```

Not:

```ts id="5t5td2"
gainNode.gain.value = 0.501;
biquad.frequency.value = 4200;
```

The engine adapter performs that translation.

---

# 6. Command System

All meaningful project mutations should pass through a command system.

Example:

```text id="ei7nwf"
USER ACTION
    │
    ▼
COMMAND
    │
    ├─ validate
    ├─ execute
    ├─ serialize
    └─ undo
```

Commands may include:

```text id="m0at83"
CreateTrack
DeleteTrack
RenameTrack
SetTrackVolume
AddInstrument
AddEffect
RemoveEffect
SetParameter
CreatePattern
DeletePattern
MoveNote
ResizeNote
SetStepVelocity
CreateAutomationPoint
MoveAutomationPoint
SetTempo
CreateScene
MoveScene
```

Benefits:

- undo/redo,
- deterministic mutations,
- easier testing,
- future collaboration,
- macros,
- scripting,
- AI control,
- automation interoperability.

---

# 7. Project Model

The Project Model is the canonical persisted representation of a Pulse Forge project.

It must not contain:

- React state,
- Web Audio nodes,
- AudioWorklet instances,
- browser object references,
- DOM state.

It should contain serializable domain data only.

Example:

```ts id="6tf7vb"
interface PulseForgeProject {
  schemaVersion: number;
  id: string;
  name: string;

  tempoMap: TempoMap;
  tracks: Track[];
  scenes: Scene[];
  arrangement: Arrangement;
  automation: AutomationLane[];
  buses: Bus[];
  master: MasterConfig;

  assets: AssetReference[];
}
```

---

# 8. Runtime State vs Persisted State

The architecture must distinguish:

```text id="swj9xd"
Persisted Project State
```

from:

```text id="jtbi7r"
Runtime Engine State
```

Example:

Project state:

```json id="dc2z4k"
{
  "cutoff": 4200
}
```

Runtime state may additionally contain:

- AudioParam instances,
- DSP buffers,
- worklet nodes,
- decoded sample buffers,
- render caches,
- internal smoothing state.

Runtime objects must always be reconstructable from the project model.

---

# 9. Transport

The Transport owns musical time.

It is responsible for:

- BPM,
- play state,
- pause,
- stop,
- loop region,
- musical position,
- bar/beat conversion,
- time signature,
- tempo changes.

The Transport is authoritative for musical position.

It does not directly generate sound.

Example conceptual API:

```ts id="z3o3rz"
transport.play();
transport.pause();
transport.stop();

transport.seek({
  bar: 12,
  beat: 1,
  tick: 0
});
```

---

# 10. Musical Time

Pulse Forge must distinguish at least three time domains.

## Musical Time

```text id="zmsm6s"
bars / beats / ticks
```

Used by:

- notes,
- steps,
- patterns,
- arrangement,
- automation.

## Audio Time

```text id="dr8vvv"
AudioContext.currentTime
```

Used for precise audio scheduling.

## Wall/UI Time

```text id="p4jwcf"
performance.now()
requestAnimationFrame()
```

Used only for rendering and interaction.

These domains must never be treated as interchangeable.

---

# 11. Scheduler

The scheduler converts musical events into precisely timed audio events.

The UI must never trigger musical events directly.

Forbidden:

```ts id="d2r1yz"
setInterval(playNextStep, 125);
```

Correct model:

```text id="5xhmlo"
Sequencer
    │
    ▼
Scheduler
    │
    ▼
lookahead window
    │
    ▼
AudioContext timeline
```

The scheduler should operate using lookahead scheduling.

Example:

```text id="knxe0q"
current audio time
      │
      ├───────────────┐
      ▼               ▼
   now            now + horizon
```

Events inside that horizon are scheduled ahead of actual playback.

---

# 12. Scheduler Requirements

The scheduler must support:

- note-on,
- note-off,
- sample trigger,
- parameter automation,
- pattern changes,
- scene changes,
- loops,
- swing,
- probability,
- ratchets,
- microtiming,
- tempo-aware timing.

It must remain independent of visual frame rate.

---

# 13. Sequencer

The Sequencer transforms project musical data into event streams.

It owns:

- patterns,
- step sequences,
- piano-roll notes,
- probabilities,
- velocity,
- note lengths,
- ratchets,
- swing offsets,
- microtiming.

Example:

```text id="aqxb2e"
Pattern
   │
   ├─ Step
   ├─ Note
   ├─ Note
   └─ Step
        │
        ▼
Scheduled Musical Events
```

The sequencer produces intent.

The scheduler decides when it executes.

---

# 14. Patterns

Patterns should remain reusable musical structures.

A pattern may reference:

- drum steps,
- MIDI-style notes,
- automation fragments,
- modulation values.

Patterns should not directly own Web Audio state.

They are pure musical data.

---

# 15. Scenes

A Scene represents a coordinated musical section.

Examples:

```text id="03dr3v"
INTRO
VERSE
BUILD
DROP
BREAK
OUTRO
```

A Scene may activate:

- specific patterns,
- track states,
- automation,
- macro positions,
- scene-level intensity.

Scenes are not duplicated audio state.

They reference musical structures.

---

# 16. Arrangement

The Arrangement defines the linear structure of the composition.

Example:

```text id="dqh356"
INTRO
  ↓
GROOVE
  ↓
BUILD
  ↓
DROP
  ↓
BREAK
  ↓
DROP B
  ↓
OUTRO
```

Arrangement data must remain serializable and deterministic.

---

# 17. Automation System

Automation must be implemented as a first-class engine capability.

It must not be tied to UI widgets.

Each automation lane references a target.

Example:

```ts id="7em9md"
interface AutomationTarget {
  entityId: string;
  parameterId: string;
}
```

An automation lane:

```ts id="ffbij0"
interface AutomationLane {
  id: string;
  target: AutomationTarget;
  points: AutomationPoint[];
}
```

Automation must support interpolation strategies such as:

```text id="w3utqy"
STEP
LINEAR
CURVE
```

Future:

```text id="aczapg"
EXPONENTIAL
BEZIER
CUSTOM
```

---

# 18. Parameter Model

All modulatable values should use a shared parameter abstraction.

A parameter should define:

```ts id="qorocy"
interface ParameterDefinition {
  id: string;
  min: number;
  max: number;
  defaultValue: number;
  unit?: string;
  scale?: "linear" | "log" | "exp";
}
```

Runtime parameter state may combine:

```text id="u99yw1"
BASE VALUE
   +
AUTOMATION
   +
MODULATION
   +
MACRO OFFSET
   ↓
FINAL VALUE
```

The engine should calculate the final value predictably.

---

# 19. Parameter Smoothing

Realtime audio parameters should not jump abruptly unless intentionally discrete.

Continuous parameters should support smoothing.

Examples:

```text id="cq0ox0"
filter cutoff
gain
pan
drive
reverb mix
modulation depth
```

Potential strategies:

- linear ramp,
- exponential ramp,
- one-pole smoothing,
- custom DSP smoothing.

Smoothing belongs to the audio layer.

Not the UI.

---

# 20. Modulation System

Modulation must be a shared system across instruments and effects.

Possible sources:

```text id="2nkl6f"
LFO
Envelope
Envelope Follower
Velocity
Random
Step Modulator
Macro
Scene Intensity
```

Possible targets:

```text id="e4u0sw"
Filter Cutoff
Pitch
Gain
Pan
Drive
Reverb Mix
Delay Feedback
Oscillator Shape
```

Route structure:

```ts id="82eu4c"
interface ModulationRoute {
  sourceId: string;
  targetId: string;
  amount: number;
}
```

---

# 21. Modulation Matrix

The modulation matrix should remain engine-centric.

UI representation:

```text id="frgrh7"
SOURCE       TARGET             AMOUNT

LFO 1    →   Filter Cutoff      +42
Velocity →   Saturation         +18
Macro A  →   Reverb Mix         -22
```

Underneath, routes should remain generic.

This avoids hardcoding modulation inside individual instruments.

---

# 22. Macro System

Macros provide higher-level musical control.

A macro maps one control onto multiple parameters.

Example:

```text id="vsot79"
MACRO: DIRT
    │
    ├─ Saturation Drive   +40
    ├─ Filter Cutoff      -12
    ├─ Compression        +15
    └─ Noise               +8
```

Macros should be represented declaratively.

Example:

```ts id="05h9tu"
interface MacroMapping {
  targetId: string;
  amount: number;
}
```

---

# 23. Q Audio Engine

The Q Audio Engine is the central runtime abstraction.

It owns audio execution.

It is responsible for:

- graph construction,
- graph destruction,
- track routing,
- buses,
- instruments,
- effects,
- sample playback,
- runtime parameter updates,
- worklet lifecycle,
- render preparation.

The engine must expose domain APIs.

Example:

```ts id="5iwlbj"
audioEngine.loadProject(project);

audioEngine.createTrack(track);
audioEngine.removeTrack(trackId);

audioEngine.setParameter({
  entityId,
  parameterId,
  value
});
```

The UI must never operate directly on internal nodes.

---

# 24. Audio Graph

A typical track graph may look like:

```text id="in76nj"
Instrument
   │
   ▼
Insert FX 1
   │
   ▼
Insert FX 2
   │
   ▼
Track Gain
   │
   ▼
Pan
   │
   ├────────► Send A
   │
   ├────────► Send B
   │
   ▼
Track Output
   │
   ▼
Bus
   │
   ▼
Master
```

Graph configuration must be reconstructable from project state.

---

# 25. Web Audio Layer

Web Audio should be used wherever the platform already provides appropriate high-quality primitives.

Candidate native nodes:

```text id="l3ymrz"
GainNode
StereoPannerNode
BiquadFilterNode
DelayNode
ConvolverNode
DynamicsCompressorNode
AnalyserNode
OscillatorNode
AudioBufferSourceNode
```

Native nodes should not be avoided purely for ideological reasons.

The architecture should favor:

```text id="zhelnt"
best available primitive
```

not:

```text id="rxdsvz"
custom everything
```

---

# 26. AudioWorklet Layer

Custom realtime DSP belongs in AudioWorklet.

AudioWorklet processors may implement:

- custom saturation,
- custom distortion,
- clipping,
- transient processing,
- custom compression,
- granular processing,
- advanced modulation,
- meters,
- analyzers,
- specialized synthesis.

Architecture:

```text id="wwfrqy"
Main Thread
    │
    ▼
AudioWorkletNode
    │
    ▼
Audio Rendering Thread
    │
    ▼
AudioWorkletProcessor
```

Heavy realtime DSP must never execute on the main thread.

---

# 27. AudioWorklet Communication

Main-thread communication with worklets must remain controlled.

Use message passing for:

- initialization,
- presets,
- non-audio-rate settings,
- analysis data,
- lifecycle events.

Use AudioParam-style values where appropriate for realtime parameter control.

Avoid high-frequency message spam.

---

# 28. DSP Module Interface

Custom DSP processors should expose a consistent interface.

Conceptual example:

```ts id="4o1mt6"
interface DspProcessor {
  prepare(sampleRate: number): void;
  reset(): void;
  process(
    input: Float32Array,
    output: Float32Array
  ): void;
}
```

Actual realtime implementations may require multi-channel structures.

The key requirement is consistency.

---

# 29. TypeScript DSP

TypeScript DSP is acceptable when:

- computational cost is low,
- complexity is low,
- realtime safety is understood,
- implementation remains maintainable.

Examples may include:

- simple waveshapers,
- low-cost modulation,
- basic signal utilities,
- control-rate processing.

TypeScript must not be used dogmatically for all DSP.

---

# 30. Rust/WASM DSP

Rust/WASM should be introduced where it provides clear value.

Potential candidates:

```text id="4hyvzv"
oversampled saturation
clipper
custom compressor
transient detector
transient shaper
advanced filters
granular DSP
advanced reverb
pitch processing
time stretching
spectral processing
```

Rust/WASM is not a default requirement.

It is an optimization and DSP-quality tool.

---

# 31. Rust/WASM Boundary

The JavaScript/WASM boundary must remain coarse-grained.

Avoid designs such as:

```text id="m7xqkl"
JS
↓
call WASM
↓
process one sample
↓
return
```

This creates excessive overhead.

Prefer:

```text id="ys0ycb"
JS / AudioWorklet
       │
       ▼
WASM processor
       │
       ▼
process entire audio block
```

DSP blocks should remain inside WASM as long as practical.

---

# 32. Rust DSP Crate Structure

Potential layout:

```text id="cmeq3i"
crates/
│
├─ dsp-core/
│
├─ dsp-utils/
│
├─ dsp-saturation/
│
├─ dsp-clipper/
│
├─ dsp-compressor/
│
├─ dsp-transient/
│
└─ dsp-reverb/
```

`dsp-core` may contain:

- sample types,
- stereo frames,
- smoothing,
- math utilities,
- oversampling interfaces,
- filters,
- envelope utilities.

---

# 33. WASM Integration Rule

The TypeScript application must not know implementation details of Rust processors.

Use an adapter.

Example:

```text id="2x6h9y"
Q Audio Engine
     │
     ▼
DSP Adapter
     │
 ┌───┴────┐
 ▼        ▼
TS DSP   WASM DSP
```

This allows processors to migrate between implementations.

---

# 34. Instruments Architecture

Every instrument should conform to a common runtime contract.

Conceptual:

```ts id="98h4m9"
interface InstrumentRuntime {
  noteOn(event: NoteOnEvent): void;
  noteOff(event: NoteOffEvent): void;
  setParameter(id: string, value: number): void;
  reset(): void;
}
```

Sampler-style instruments may additionally support sample triggering.

---

# 35. Drum Rack

The Drum Rack should consist of pads.

```text id="7yh8zd"
Drum Rack
│
├─ Pad 1 → Kick
├─ Pad 2 → Snare
├─ Pad 3 → Hat
├─ Pad 4 → Clap
└─ ...
```

Each pad may own:

- asset reference,
- playback configuration,
- envelope,
- filter,
- tuning,
- choke group,
- output routing.

Pads should remain independent voices.

---

# 36. Sampler

The sampler must separate:

```text id="jzwi3w"
Sample Asset
```

from:

```text id="6jrg0f"
Sample Playback Configuration
```

This prevents asset duplication.

Example:

```ts id="tsw9nd"
interface SampleReference {
  assetId: string;
}
```

Playback settings:

```ts id="8isvgy"
interface SamplePlaybackSettings {
  start: number;
  end: number;
  reverse: boolean;
  pitch: number;
  gain: number;
}
```

---

# 37. Voice Management

Polyphonic instruments require a shared voice management strategy.

Possible policies:

```text id="9nxh70"
oldest
quietest
lowest
highest
```

Voice stealing must be deterministic.

Instrument runtime should not leak voices indefinitely.

---

# 38. Synth Architecture

Synths should be composed from reusable DSP building blocks where practical.

Example:

```text id="tgcs9v"
OSC
 │
OSC
 │
SUB
 │
NOISE
 │
 ▼
MIX
 │
 ▼
FILTER
 │
 ▼
AMP
 │
 ▼
FX
```

The architecture should encourage reuse without forcing every synth into identical signal topology.

---

# 39. Effect Architecture

Effects should use a standard descriptor.

Conceptual:

```ts id="4lz3z9"
interface EffectDefinition {
  id: string;
  name: string;
  parameters: ParameterDefinition[];
  runtimeFactory: EffectRuntimeFactory;
}
```

Runtime:

```ts id="i3a3ys"
interface EffectRuntime {
  input: AudioNode;
  output: AudioNode;

  setParameter(id: string, value: number): void;
  dispose(): void;
}
```

This allows effects to be inserted generically.

---

# 40. Mixer

The mixer owns logical routing.

It should support:

- tracks,
- buses,
- sends,
- returns,
- master.

The mixer model must exist independently from instantiated audio nodes.

Example:

```text id="o7nj44"
Track
  │
  ├─ inserts
  ├─ sends
  └─ output bus
```

---

# 41. Bus Architecture

Initial logical buses may include:

```text id="k6wrqm"
DRUMS
BASS
MUSIC
FX
MASTER
```

These should not be hardcoded as permanent system identities.

Users may create their own buses.

---

# 42. Sidechain Routing

Sidechain routing must be modeled explicitly.

Example:

```text id="majbu8"
Kick Track
    │
    └────────────► Sidechain Input
                         │
                         ▼
                 Bass Compressor
```

Sidechain signals must not rely on hidden global references.

---

# 43. Pump / Volume Shaper

Tempo-synchronized pumping should exist independently from compressor sidechaining.

Example:

```text id="di1epw"
Transport
    │
    ▼
Phase Generator
    │
    ▼
Editable Curve
    │
    ▼
Gain Modulation
```

This system belongs naturally in AudioWorklet or parameter automation infrastructure.

---

# 44. Sample Library

The factory sample library must not be bundled entirely with the application.

Instead:

```text id="hrd54y"
Library Manifest
     │
     ▼
Asset Request
     │
     ▼
Fetch
     │
     ▼
Decode
     │
     ▼
Cache
     │
     ▼
Playback
```

The library should support:

- categories,
- tags,
- tonal metadata,
- character metadata,
- file size,
- duration,
- preview information.

---

# 45. Asset Identity

Every asset should have a stable identifier.

Example:

```text id="srfk8a"
kick.house.deep.014
```

Project files should reference asset IDs rather than fragile browser URLs.

---

# 46. Asset Cache

Downloaded factory assets may be cached locally.

Potential strategy:

```text id="7l5vwt"
CDN
 ↓
fetch
 ↓
OPFS
 ↓
decoded memory cache
```

Decoded AudioBuffers should not be persisted unnecessarily.

Raw encoded audio can remain on disk.

---

# 47. Persistence

Persistence should use multiple storage technologies according to responsibility.

Recommended:

```text id="x2vup6"
IndexedDB
│
├─ project metadata
├─ project documents
├─ presets
├─ library index
├─ settings
└─ cache metadata

OPFS
│
├─ user samples
├─ downloaded assets
├─ rendered files
├─ waveform cache
└─ temporary processing files
```

---

# 48. Project Serialization

Projects must use explicit schema versions.

Example:

```json id="npvj35"
{
  "schemaVersion": 3
}
```

Every breaking project change must provide a migration strategy.

Project persistence must never silently rely on current runtime structure.

---

# 49. Project Migration

Recommended model:

```text id="uczu7j"
v1
 ↓ migrate
v2
 ↓ migrate
v3
```

Each migration should be deterministic and testable.

---

# 50. Autosave

Autosave should capture project state without blocking realtime audio.

Potential flow:

```text id="kf9be9"
Command executed
      │
      ▼
Project becomes dirty
      │
      ▼
debounced persistence
      │
      ▼
IndexedDB
```

Autosave must never serialize heavy audio buffers.

---

# 51. Undo / Redo

Undo/redo belongs at the command/project layer.

It should not attempt to reverse low-level Web Audio node mutations directly.

Correct:

```text id="ud52vk"
Undo Command
     │
     ▼
Project State
     │
     ▼
Engine Synchronization
```

---

# 52. Offline Rendering

Offline rendering must use the same project representation as realtime playback.

Architecture:

```text id="lty4x3"
Project
   │
   ▼
Render Graph Builder
   │
   ▼
OfflineAudioContext
   │
   ▼
Rendered AudioBuffer
   │
   ▼
Encoder
```

The realtime engine and render engine should share:

- instrument definitions,
- effect definitions,
- routing rules,
- automation interpretation.

---

# 53. Realtime vs Offline Engine

The project must avoid maintaining completely separate audio implementations.

Preferred:

```text id="8lzsg3"
           Project
              │
       ┌──────┴──────┐
       ▼             ▼
Realtime Graph   Offline Graph
       │             │
AudioContext   OfflineAudioContext
```

Common graph-building abstractions should reduce divergence.

---

# 54. WAV Export

WAV is the canonical guaranteed export.

Target support:

```text id="ye0beq"
44.1 kHz
48 kHz

16-bit PCM
24-bit PCM
32-bit float
```

Internal processing should generally use floating-point audio.

---

# 55. Stem Export

Stem export may render logical groups individually.

Example:

```text id="zcpwk5"
master.wav
drums.wav
bass.wav
music.wav
textures.wav
fx.wav
```

Stem rendering should use the same project state and automation.

---

# 56. Waveform Generation

Waveform visualization must not repeatedly decode full assets on the UI thread.

Waveforms should be cached.

Potential format:

```text id="ubhcwm"
asset
  │
  ▼
waveform worker
  │
  ▼
peak cache
```

The UI consumes lightweight peak data.

---

# 57. Worker Strategy

Web Workers may be used for non-realtime CPU-heavy tasks.

Examples:

- waveform generation,
- audio analysis,
- asset processing,
- project compression,
- metadata extraction,
- export packaging.

Realtime audio processing belongs in AudioWorklet.

This distinction must remain clear.

---

# 58. Thread Responsibility

```text id="4fipux"
MAIN THREAD

React
UI
commands
project editing
interaction

──────────────

WEB WORKERS

analysis
waveforms
file processing
heavy non-realtime tasks

──────────────

AUDIO THREAD

AudioWorklet
realtime DSP
sample-accurate processing
```

---

# 59. Analysis Layer

Meters and analyzers must observe audio.

They must not control audio timing.

Potential analyzers:

- peak,
- RMS,
- LUFS approximation,
- spectrum,
- waveform,
- stereo correlation.

Analysis data should be throttled before reaching UI.

---

# 60. UI Architecture

React is used for:

- layout,
- controls,
- editors,
- timelines,
- browsers,
- meters,
- visualization.

State should be divided by responsibility.

Suggested categories:

```text id="wbmy8t"
project state
selection state
view state
engine status
transport view state
temporary interaction state
```

Temporary UI state must not leak into the persisted project.

---

# 61. UI Update Rate

Visual updates should be decoupled from audio updates.

Meters may update at:

```text id="dnkgew"
30–60 Hz
```

Audio processing operates at audio block/sample rate.

Never attempt to synchronize audio by visual frame rate.

---

# 62. Timeline Rendering

Large timelines should use virtualization where needed.

Potential technologies:

- Canvas,
- WebGL,
- DOM virtualization.

The choice is an implementation detail.

The timeline must not become part of the audio timing system.

---

# 63. Piano Roll Rendering

The piano roll should use an interaction model independent of note scheduling.

Edits affect project data.

Playback reads the updated project through the sequencer.

This avoids coupling pointer events directly to playback runtime.

---

# 64. Previewing Sounds

Library preview playback should use a dedicated preview bus.

```text id="9funms"
Sample Browser
     │
     ▼
Preview Player
     │
     ▼
Preview Bus
     │
     ▼
Master
```

Preview audio must not modify the current project.

---

# 65. Presets

Presets should be pure data.

Example:

```json id="fqf7za"
{
  "instrument": "bass-synth",
  "version": 2,
  "parameters": {
    "body": 0.72,
    "grit": 0.31
  }
}
```

Presets must be versionable.

---

# 66. Instrument Versioning

Project files should store instrument implementation version where required.

Example:

```text id="10okko"
BassSynth v1
```

If DSP behavior changes significantly, migrations or compatibility modes may be required.

Old projects must not silently sound different.

---

# 67. Deterministic Randomness

Any musical randomization affecting project playback should support seeded randomness.

Examples:

- probability,
- humanization,
- generative pattern variation.

Project:

```json id="sexorn"
{
  "seed": 129482
}
```

This allows repeatable playback and export.

---

# 68. Realtime Safety

Realtime code must avoid:

- excessive allocations,
- blocking operations,
- file access,
- network requests,
- large object creation,
- unpredictable loops,
- garbage-heavy patterns.

AudioWorklet processors should use preallocated buffers wherever practical.

---

# 69. Garbage Collection

Garbage collection pressure must be treated as an audio risk.

Critical realtime paths should avoid frequent creation of:

- arrays,
- objects,
- closures,
- strings.

Reusable typed arrays and stable structures are preferred.

---

# 70. Sample Rate

DSP must not assume a fixed sample rate.

Processors must receive runtime sample rate.

Supported environments may include:

```text id="yzte08"
44.1 kHz
48 kHz
96 kHz
```

Even if initial testing focuses on 44.1/48 kHz.

---

# 71. Channel Layout

Initial focus:

```text id="n54swp"
mono
stereo
```

Internal APIs should avoid unnecessary assumptions that prevent future multi-channel support.

---

# 72. Oversampling

Oversampling should be implemented selectively.

Useful for:

- clipping,
- saturation,
- nonlinear distortion,
- some synthesis algorithms.

Avoid applying oversampling globally.

It is expensive.

---

# 73. Metering

Master and track metering should distinguish:

- instantaneous peak,
- RMS,
- loudness,
- true peak where implemented.

Meters must remain observers.

---

# 74. Error Boundaries

Audio runtime errors must not crash the entire UI.

Subsystem boundaries should include graceful failure handling.

Example:

```text id="gy12a1"
Effect fails
    │
    ▼
Bypass effect
    │
    ▼
Report diagnostics
```

Project recovery is more important than preserving a failed processor.

---

# 75. Diagnostics

Pulse Forge should expose an internal diagnostics system.

Potential metrics:

```text id="gm1xpn"
AudioContext state
sample rate
output latency
scheduler horizon
scheduled events
worklet status
active voices
CPU load estimate
dropped UI frames
cache usage
asset decode time
```

Diagnostics should be available without polluting the normal production UI.

---

# 76. Engine Health

The engine should expose status:

```text id="yj2ooa"
INITIALIZING
READY
RUNNING
SUSPENDED
ERROR
```

UI components consume this status.

They do not infer engine health from random node behavior.

---

# 77. Browser Lifecycle

The architecture must account for browser audio restrictions.

For example:

```text id="jyfi6a"
initial user interaction
        │
        ▼
AudioContext.resume()
```

Audio initialization should be handled centrally.

---

# 78. Visibility Changes

When the tab becomes hidden:

- audio playback policy must be explicit,
- transport state must remain coherent,
- UI updates may reduce frequency,
- background behavior must remain predictable.

---

# 79. Device Changes

Initial device support may remain minimal.

Pulse Forge should not become a hardware-routing workstation.

Output changes should use browser-supported mechanisms where available.

Complex device management is out of scope.

---

# 80. Security

User-imported assets must be treated as untrusted input.

Validate:

- file type,
- decoded audio,
- metadata,
- project schema,
- imported preset data.

Never execute code from imported project files.

---

# 81. Testing Strategy

Testing should occur at multiple levels.

## Unit Tests

For:

- project mutations,
- transport math,
- timing conversion,
- automation interpolation,
- modulation math,
- command behavior,
- migrations.

## DSP Tests

For:

- deterministic output,
- expected gain,
- filter behavior,
- clipping boundaries,
- saturation behavior,
- compressor envelopes.

## Integration Tests

For:

- graph creation,
- playback lifecycle,
- project reconstruction,
- effect chains,
- asset loading.

## E2E Tests

For:

- create project,
- create beat,
- save,
- reload,
- export.

---

# 82. Golden Audio Tests

Important DSP processors should support reference output tests.

Example:

```text id="6qgmb4"
known input
    │
    ▼
processor
    │
    ▼
known expected output
```

Tolerance-based comparison may be necessary.

This is especially important for Rust/WASM DSP.

---

# 83. Offline Render Tests

OfflineAudioContext should be used extensively for automated audio tests.

Benefits:

- deterministic timing,
- faster-than-realtime rendering,
- reproducible output.

---

# 84. Performance Tests

Performance tests should measure:

- voices,
- sample playback,
- simultaneous effects,
- worklet CPU usage,
- scheduling stability,
- large arrangements,
- asset decode performance.

The project should define realistic target sessions.

---

# 85. Baseline Performance Scenario

An initial benchmark session may include:

```text id="jb3jmi"
16 drum voices
8 melodic voices
4 synth tracks
2 bass tracks
8 insert chains
3 return effects
automation
master processing
```

Playback should remain stable on reasonable modern hardware.

---

# 86. Graceful Degradation

If hardware is insufficient:

Pulse Forge should degrade non-critical systems first.

Potential order:

```text id="9pvj8l"
reduce visualization rate
↓
reduce analyzer detail
↓
disable expensive previews
↓
warn about heavy DSP
```

Audio timing should be protected as long as possible.

---

# 87. No Silent Quality Reduction

Pulse Forge must not secretly lower:

- sample rate,
- oversampling,
- render quality,
- effect quality.

If quality changes for performance reasons, it must be explicit.

---

# 88. Future Desktop Packaging

Desktop packaging may later use:

```text id="hv9yrw"
PWA
Tauri
Electron
```

The core application must remain browser-compatible.

Desktop packaging should initially add:

- filesystem convenience,
- native windowing,
- local asset access.

Not rewrite the audio architecture.

---

# 89. Future Native Bridge

If a genuine native requirement eventually appears, it should exist behind an adapter.

Example:

```text id="210m5j"
Q Audio Engine
     │
     ▼
Platform Adapter
     │
 ┌───┴────┐
 ▼        ▼
Web     Native
```

This prevents native code from leaking through the application.

---

# 90. Backend Independence

The core audio engine must never require a backend.

Backend functionality may eventually support:

- accounts,
- cloud projects,
- preset sharing,
- library distribution,
- collaboration.

But this architecture remains valid without any server.

---

# 91. Scene Integration

Scene Mode should consume the same musical systems.

It should not create a second sequencer.

```text id="kluqrs"
Transport
    │
    ├─ musical time
    └─ absolute scene time
```

Scene events may map to:

- markers,
- macros,
- intensity,
- pattern changes,
- automation.

---

# 92. Scene Intensity

Scene intensity should be represented as a normalized modulation source.

```text id="vz3y1x"
0.0 → 1.0
```

It should pass through the same modulation architecture as:

- LFO,
- macro,
- automation.

This avoids implementing a separate special-case system.

---

# 93. Qvester Interoperability

Future Qvester integrations should exchange data through explicit schemas.

Avoid direct runtime coupling between applications.

Preferred:

```text id="4vyezc"
Pulse Forge
    │
    ▼
exported structured data
    │
    ▼
QFX / Audio Canvas / others
```

Potential exchanged data:

- BPM,
- markers,
- stems,
- intensity,
- automation,
- scene timing.

---

# 94. Score Package

Potential future structure:

```text id="9j63et"
project.scorepack
│
├─ audio/
│  ├─ master.wav
│  ├─ drums.wav
│  └─ bass.wav
│
├─ score.json
├─ markers.json
├─ automation.json
└─ manifest.json
```

The package should be a transport format.

Not an internal runtime dependency.

---

# 95. Dependency Policy

Dependencies should be evaluated based on:

- maintenance,
- bundle size,
- runtime control,
- architectural lock-in,
- browser compatibility.

Avoid libraries that attempt to own the entire audio engine lifecycle.

---

# 96. Tone.js Policy

Tone.js may be used for:

- experimentation,
- reference,
- prototypes,
- isolated utilities if justified.

It should not become the architectural foundation of Pulse Forge.

Pulse Forge must own:

- transport semantics,
- scheduling semantics,
- project model,
- instrument definitions,
- DSP interfaces,
- routing model.

---

# 97. Design System Boundary

Visual component architecture should remain independent from audio architecture.

A knob component should understand:

```text id="pf45s9"
value
min
max
format
onChange
```

It should not know what an AudioParam is.

---

# 98. Feature Development Rule

When implementing a new feature, ask:

```text id="4kw0ir"
Is this PROJECT DATA?
Is this APPLICATION LOGIC?
Is this MUSICAL LOGIC?
Is this SCHEDULING?
Is this AUDIO EXECUTION?
Is this DSP?
Is this UI?
```

The answer determines where it belongs.

Do not place code wherever it is convenient.

Place it where its responsibility belongs.

---

# 99. Architectural Red Flags

The following should trigger immediate review.

```text id="ye7ma7"
AudioNode stored in React state

AudioParam accessed directly from UI

setInterval used as musical clock

samples bundled into initial app package

project files storing runtime objects

effect logic embedded in components

audio processing on main thread

WASM called per individual sample from JS

server required for playback

duplicate realtime and offline DSP implementations

unversioned project schema

unseeded playback-affecting randomness
```

---

# 100. Architectural Decision Record

Important architectural decisions should be captured as ADRs.

Example:

```text id="ixdqyf"
docs/adr/

0001-browser-first.md
0002-web-audio-engine.md
0003-audioworklet-dsp.md
0004-rust-wasm-boundary.md
0005-project-schema.md
```

Each ADR should contain:

- context,
- decision,
- consequences,
- rejected alternatives.

---

# 101. Initial Implementation Order

Recommended order:

```text id="195bu4"
PHASE 0

Project model
Command system
Transport
Audio engine shell
Persistence


PHASE 1

Scheduler
Sample playback
Drum Rack
Step sequencer


PHASE 2

Mixer
Buses
Basic effects
Automation


PHASE 3

Sampler
Piano roll
Synth architecture


PHASE 4

Analog Synth
Bass Synth
808 Synth


PHASE 5

AudioWorklet DSP
Advanced native effects


PHASE 6

Rust/WASM DSP modules


PHASE 7

Offline rendering
WAV export
Stem export


PHASE 8

Scene Mode
Qvester integration
```

Rust/WASM should not delay the first audible prototype.

The architecture must support it early.

Implementation should introduce it when the DSP requires it.

---

# 102. First Technical Milestone

The first architectural milestone should prove:

```text id="k8w0mc"
Create Project
      ↓
Create Drum Track
      ↓
Load Kick
      ↓
Create 4-on-the-floor pattern
      ↓
Press Play
      ↓
Stable scheduled playback
      ↓
Stop
      ↓
Save Project
      ↓
Reload
      ↓
Play same pattern
```

Nothing more is required for the first engine proof.

But every layer used in that proof should already respect the final architecture.

---

# 103. Second Technical Milestone

```text id="opk4nt"
Kick
Snare
Hat
Bass Synth
      ↓
Mixer
      ↓
EQ
Saturation
Compressor
      ↓
Arrangement
      ↓
Offline WAV Render
```

At this point Pulse Forge becomes a real production prototype.

---

# 104. Architectural Definition of Done

A feature is architecturally complete only when:

- its state has an explicit owner,
- persisted data is serializable,
- runtime objects are disposable,
- UI is not coupled to DSP,
- timing is transport/scheduler driven,
- errors are handled,
- undo behavior is defined where relevant,
- offline rendering behavior is defined where relevant,
- tests exist for critical logic.

---

# 105. Long-Term Architecture

The architecture should be capable of evolving into:

```text id="0nzbmu"
Browser Application
       │
       ▼
Q Audio Engine
       │
 ┌─────┼────────────┐
 ▼     ▼            ▼
Web   WASM      Native Bridge
Audio  DSP        optional
```

without replacing:

- the project model,
- the command system,
- the sequencer,
- the arrangement model,
- the automation model.

The upper architecture should remain stable while lower execution layers evolve.

---

# 106. Final Principle

Pulse Forge should never become difficult to evolve because the first implementation was convenient.

The architectural direction is therefore:

```text id="6cerdq"
React
   ↓
Commands
   ↓
Project Model
   ↓
Musical Systems
   ↓
Transport
   ↓
Scheduler
   ↓
Q Audio Engine
   ↓
Web Audio / AudioWorklet
   ↓
TypeScript DSP / Rust WASM DSP
```

Each layer has one job.

Each boundary is explicit.

Each runtime dependency can be replaced without rewriting the product above it.

That is the foundation Pulse Forge should grow on.
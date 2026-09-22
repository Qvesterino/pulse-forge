# ADR 0012 — Provider-backed generative tracks

Date: 2026-09-22  
Status: Accepted

## Context

KYX should be able to use Magenta RealTime 2 as a musical collaborator: the
model receives style and note context, produces an accompaniment stem, and the
producer can capture that stem into normal KYX audio material. MRT2 Small is an
optional, platform-specific runtime rather than a browser-native Web Audio
instrument. Its upstream implementation uses Python/JAX or MLX and a C++
streaming engine; realtime support is primarily documented for Apple Silicon.

The project already has a schema-versioned project model, command-based
mutations, a shared live/offline AudioEngine, AudioClips, durable audio stores,
and AudioWorklet boundaries. A generative feature must project onto those
systems instead of creating a second audio clock or a React-owned runtime.

## Decisions

### 1. MRT2 is a provider, not an `InstrumentKind`

MRT2 is represented behind a provider-neutral `GenerativeAudioProvider`
contract. It is not registered as a local instrument because its model state,
platform support, latency, and streaming lifecycle do not match a native KYX
instrument runtime.

The first persisted product shape is a dedicated `GenerativeTrack`, subject to
the schema migration and normalizer rules. The track stores only serializable
recipe/config data. Provider sessions, sockets, PCM queues, model paths,
AudioBuffers and host capabilities remain runtime state.

### 2. Capture is the reproducibility boundary

Live provider output is not assumed to be bit-deterministic. A successful
capture writes durable audio bytes plus provenance and then inserts a normal
KYX `AudioClip`. Once captured, playback and offline export use the existing
AudioEngine/renderer path and no longer depend on MRT2 being installed.

The live provider may expose a pre-render operation, but `OfflineAudioContext`
must never call an external provider from an audio callback. Export either
uses a captured asset or explicitly performs a provider prepass before the
shared renderer runs.

### 3. Control plane and audio plane are separate

Provider commands (start, stop, style, note frames, status) use a typed control
contract. PCM chunks use a bounded audio contract and are delivered to the
AudioEngine/AudioWorklet boundary. React may describe intent and display
status, but it does not own session state or realtime audio execution.

### 4. Unsupported providers degrade explicitly

A project with an unavailable MRT2 provider must still boot, load, edit,
playback and export its captured clips. The UI reports capability state instead
of silently switching to a different model or sending project audio to a
remote service.

### 5. Product macros are wrapper semantics

`Energy`, `Density`, `Variation` and `Texture` are KYX-level macros. They must
be mapped through a provider capability/profile and must not be presented as
native MRT2 parameters unless the provider contract proves that they are
supported.

### 6. Model and code licensing is release data

The MRT2 upstream model card documents Apache 2.0 code and CC-BY 4.0 model
weights, together with output-use responsibilities. Any native adapter,
model distribution, attribution and update policy must be recorded in release
documentation before shipping MRT2 assets.

## Consequences

- The browser bundle stays free of model weights and native ML dependencies.
- A deterministic mock provider can cover project and UI development on every
  platform.
- Apple Silicon can receive a native realtime integration without making the
  Windows/browser KYX experience depend on it.
- The project schema gains a real provider-backed track and therefore requires
  a migration, normalizer coverage, collab tests and a missing-provider path.
- Capture/freeze is a first-class production workflow, not a debug export.

## Rejected alternatives

- **Register MRT2 as a sampler/instrument:** hides provider lifecycle and would
  make a non-native runtime look like a local AudioEngine instrument.
- **Run MRT2 inside an AudioWorklet:** the upstream MLX/C++ runtime and model
  footprint do not fit the browser AudioWorklet boundary.
- **Store live PCM in `ProjectDocument`:** violates serializability, creates
  large project payloads and cannot guarantee deterministic reload behavior.
- **Use a silent cloud fallback:** violates the offline-first product contract
  and would make provider availability and user audio privacy ambiguous.

## References

- [MRT2 repository](https://github.com/magenta/magenta-realtime)
- [MRT2 model card](https://huggingface.co/google/magenta-realtime-2)
- `docs/IMPLEMENTATION-ROADMAP-MRT2-GENERATIVE-TRACKS.md`
- `docs/adr/0003-project-model-runtime-separation.md`
- `docs/adr/0004-audioworklet-boundary.md`
- `docs/adr/0009-offline-render-export.md`

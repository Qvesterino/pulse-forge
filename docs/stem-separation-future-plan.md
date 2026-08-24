# Future Stem Separation — Implementation To-do

Status: parked / future research project

This document describes a possible future feature for Pulse Forge. It is not a
current sprint commitment and should not block the browser-first production
roadmap.

## Product Scope

The intended use case is **full beat or music mix -> useful musical parts**.
The goal is to let a producer take a beat and turn it into editable material
for Pulse Forge: drums, bass, and the remaining musical content.

This is not primarily a karaoke or vocal-removal feature. A standard model may
still compute a vocal source internally, but the first Pulse Forge UI should
not be built around selling or exposing vocal separation. The first output
contract should be one of:

- `drums`, `bass`, `other` for beat-focused material
- `drums`, `bass`, `music` where `music` is the non-drum/non-bass remainder
- optional standard `vocals` output later, only if it proves useful

The exact output contract must be decided during the model benchmark before
the UI is designed.

## Important Terminology

There are three different things that are easy to confuse:

- **Model size**: the downloaded neural-network weights, for example an
  approximately 172 MB HTDemucs browser model.
- **Inference chunking**: splitting a long song into short overlapping audio
  windows so the model fits in memory. This does not make the model smaller.
- **Source-specific model files**: some model families, such as Spleeter,
  provide one model per source. Four files of roughly 20 MB each are not the
  same thing as splitting HTDemucs into four small modules.

## Recommended Direction

Build a backend-neutral separation layer first, then choose the best runtime
after measuring real quality and speed.

```text
SeparationController
  -> SeparationBackend interface
      -> BrowserOnnxBackend
      -> NativeDesktopBackend (future)
      -> RemoteBackend (optional future fallback)
```

The first implementation should be a small standalone proof of concept, not a
large change to the editor. It should prove that one short audio fixture can be
decoded, separated, reconstructed, previewed, and exported without freezing
the application.

## Model Candidates

### Candidate A — HTDemucs / Demucs-style browser model

Pros:

- best alignment with the original "wow factor" idea
- strong quality for drums, bass, other, and vocals
- browser implementations already demonstrate ONNX Runtime Web and WebGPU/WASM

Cons:

- large initial download, roughly 172 MB for one browser-oriented model
- high peak memory during model loading and inference
- requires careful segmenting and overlap-add reconstruction
- WebGPU, WASM, worker, and cross-origin-isolation deployment issues
- model and weight licensing must be checked before redistribution

This is the quality target, not necessarily the MVP target.

### Candidate B — Spleeter 4-stem ONNX

Pros:

- smaller independent FP16 model files
- simpler spectrogram -> model -> mask -> inverse spectrogram pipeline
- easier to benchmark and run on WASM
- useful as a technical browser spike

Cons:

- older separation quality than HTDemucs
- more leakage and artifacts on difficult material
- four-source output is still more computation than the beat-focused UI may need

This is the most sensible candidate for an early browser proof of concept if
the benchmark shows acceptable sound quality.

### Candidate C — MDX / Open-Unmix / other ONNX model

Keep this as a comparison slot. Some models may offer a better quality-to-size
ratio for vocals or instrumental separation, but the model contract, license,
input shape, STFT convention, and browser operator support must be verified
individually.

### Candidate D — Native desktop model

For a future downloadable tool, native inference may be the most reliable path:

- Python/Demucs CLI: fastest route to a working high-quality offline tool
- Rust/WASM/native backend: better path for a polished cross-platform product
- packaged desktop app: can use more memory and a larger model without hurting
  the main Pulse Forge browser bundle

This should remain a separate backend or companion tool. It should not force a
native dependency into the browser-first application.

## Architecture To-do

### Phase 0 — Freeze Scope and Constraints

- [ ] Decide whether the first output is `drums/bass/other` or
      `drums/bass/music`.
- [ ] Explicitly exclude vocal-removal UX from the first release.
- [ ] Set an initial duration limit, for example 30–60 seconds for the spike.
- [ ] Decide whether separation results are temporary, browser-local, or
      project-importable.
- [ ] Create a small CC0/reference fixture set: clean beat, dense mix, stereo
      mix, mono mix, silence, clipped audio, and unsupported/corrupt input.
- [ ] Record model license, weight license, attribution, source URL, version,
      and checksum before shipping any model.

### Phase 1 — Model Benchmark

- [ ] Obtain one candidate model from each viable family.
- [ ] Confirm exact input requirements: sample rate, channels, normalization,
      tensor shape, STFT window, hop size, padding, and output stem order.
- [ ] Export or convert models to ONNX only when a reproducible conversion path
      exists.
- [ ] Build a Python/native golden-output script for the same fixtures.
- [ ] Compare browser output against golden output with numerical tolerances.
- [ ] Measure model download size, initialization time, peak memory, and time per
      30 seconds of audio.
- [ ] Measure WebGPU and WASM separately on desktop Chromium.
- [ ] Measure a no-WebGPU WASM fallback on a slower laptop.
- [ ] Listen for musical failure modes: vocal/drum bleed, bass pumping,
      transient smearing, phasing, silence gaps, and chunk boundary clicks.
- [ ] Reject candidates that cannot pass parity, license, or memory checks.

### Phase 2 — Browser Runtime Spike

- [ ] Add `onnxruntime-web` as a lazy-loaded dependency, not part of the initial
      app boot path.
- [ ] Configure WASM assets and workers explicitly for Vite production builds.
- [ ] Try WebGPU first where supported, then fall back to WASM.
- [ ] Keep inference in a Web Worker; do not run long inference on the React
      main thread or the realtime AudioWorklet.
- [ ] Define a `SeparationJob` state machine: queued, loading-model,
      decoding, separating, reconstructing, complete, cancelled, failed.
- [ ] Add cancellation that terminates or resets the worker and releases model
      tensors and temporary buffers.
- [ ] Add progress reporting by model load, segment count, and reconstruction.
- [ ] Cache model files locally after the first download.
- [ ] Detect and report missing WebGPU, insufficient memory, unsupported model
      operators, failed model download, and worker crashes.
- [ ] Decide whether cross-origin isolation headers are acceptable for the
      hosted app. SharedArrayBuffer-based acceleration may require
      `COOP: same-origin` and `COEP: require-corp`.
- [ ] Verify service worker, embedded mode, collaboration mode, and external
      asset hosting under those headers.

### Phase 3 — Audio Pipeline

- [ ] Reuse the existing audio import/decode path from
      `src/ui/DropZone.tsx`.
- [ ] Convert input to the model's required sample rate and stereo layout.
- [ ] Preserve source duration and avoid accidental loudness normalization.
- [ ] Implement model-specific padding and segment windows.
- [ ] Implement overlap-add or crossfade reconstruction.
- [ ] Preserve exact output length and sample rate metadata.
- [ ] Add a reconstruction check: sum or compare outputs against the input
      using a model-appropriate tolerance.
- [ ] Create `AudioBuffer` results only after inference has completed, so the
      realtime engine never sees half-written buffers.
- [ ] Release source arrays, intermediate tensors, and unused channels as soon
      as each stage completes.

### Phase 4 — Pulse Forge Integration

- [ ] Add a separate `STEM LAB` or `SEPARATE AUDIO` surface; do not bury this
      inside the MIDI panel or normal sample browser.
- [ ] Support drag/drop and file-picker input using the formats already accepted
      by the app.
- [ ] Show model download state separately from separation progress.
- [ ] Show a clear warning that separation is an estimate and may contain
      artifacts.
- [ ] Provide per-stem preview, solo, mute, and level controls.
- [ ] Provide WAV download for each result.
- [ ] Save generated stem bytes through the existing
      `UserSampleRepository` when the user chooses to keep them.
- [ ] Reuse existing sampler `sampleId` support to create sampler tracks.
- [ ] Make "Add stems to project" one undoable operation.
- [ ] Ensure project JSON, share links, and collaboration do not silently embed
      large audio buffers or model weights.
- [ ] Decide whether the original source file is kept or deleted after the
      separation job.
- [ ] Add cleanup for abandoned jobs and unused generated samples.

### Phase 5 — Desktop / Downloadable Variant

- [ ] Define the same input/output contract as the browser backend.
- [ ] Prototype a Python/Demucs command-line backend first, because it is the
      fastest way to validate quality and long-song UX.
- [ ] Evaluate a Rust/native backend only after the product flow is proven.
- [ ] Decide between a companion CLI, downloadable desktop app, or future
      Tauri/Electron shell.
- [ ] Keep model download, license notices, progress, cancellation, and output
      naming identical across browser and desktop.
- [ ] Add a backend selector only when two backends are production-quality.

## UX Contract

The first usable version should communicate the following states:

- `DROP AUDIO`
- `CHECKING MODEL`
- `DOWNLOADING MODEL`
- `SEPARATING SEGMENT 3 / 12`
- `RECONSTRUCTING STEMS`
- `READY — ADD TO PROJECT`
- `CANCELLED`
- `NOT ENOUGH MEMORY`
- `MODEL DOWNLOAD FAILED`
- `BROWSER TOO SLOW — TRY DESKTOP VERSION`

The UI should never imply that the result is multitrack-quality isolation. The
feature is an editing aid for extracting useful musical material, not a promise
of perfect forensic separation.

## Performance and Memory Rules

- [ ] Establish a hard input duration and file-size limit for the browser MVP.
- [ ] Never keep source, all intermediate tensors, and all output copies alive
      longer than needed.
- [ ] Process segments sequentially by default; parallel segments multiply RAM.
- [ ] Do not start separation while the realtime engine is rendering a project
      unless the browser benchmark proves it does not cause glitches.
- [ ] Keep the UI responsive during the whole job.
- [ ] Make the first model download opt-in and visible.
- [ ] Add a model cache invalidation path when the model version changes.

## Testing To-do

### Pure Tests

- [ ] Model manifest validation and checksum handling.
- [ ] Sample-rate conversion and channel mapping.
- [ ] Segment boundaries, padding, overlap, and output length.
- [ ] Cancellation state transitions.
- [ ] Reconstruction tolerance on deterministic fixtures.
- [ ] Corrupt model, corrupt audio, unsupported format, and empty input.
- [ ] Persistence and cleanup of generated user samples.

### Browser Tests

- [ ] Chromium with WebGPU enabled.
- [ ] Chromium with WebGPU unavailable and WASM fallback.
- [ ] Short mono WAV.
- [ ] Stereo MP3 with resampling.
- [ ] Long input rejected before allocation.
- [ ] Cancel during model download.
- [ ] Cancel during inference.
- [ ] Reload after model cache.
- [ ] Reload after importing generated stems into a project.
- [ ] No main-thread freeze visible during separation.
- [ ] No worker, tensor, AudioBuffer, or object URL leak after completion/cancel.

## Definition of Done

The browser version is not ready until all of these are true:

- [ ] A reference CC0 beat can be separated locally without uploading audio.
- [ ] The result is useful enough to edit, not merely technically non-empty.
- [ ] Browser output is within the agreed tolerance of the golden output.
- [ ] The UI stays responsive and exposes real progress and cancellation.
- [ ] Memory and duration limits fail clearly instead of crashing the tab.
- [ ] Generated stems can be previewed, downloaded, and optionally added to a
      project through existing sampler/sample persistence.
- [ ] The feature does not modify the project schema unless a later product
      decision proves that project-local stem jobs are necessary.
- [ ] Model license and attribution are shipped with the feature.
- [ ] A desktop/native path is documented if the browser cannot meet the quality
      or speed target.

## Current Decision

Do not implement this feature now. Keep this document as a parked backlog item.

When the project has enough quota and the core editor is stable, start with
**Phase 0 and Phase 1 only**. The first deliverable should be a benchmark and a
small worker-based demo, not a full editor integration.

## Reference Material

- [ONNX Runtime Web overview](https://onnxruntime.ai/docs/tutorials/web/)
- [ONNX Runtime Web deployment and model caching](https://onnxruntime.ai/docs/tutorials/web/deploy.html)
- [Meta/Facebook Demucs repository and model notes](https://github.com/facebookresearch/demucs)
- [Browser HTDemucs proof of concept](https://github.com/timcsy/demucs-web)
- [Spleeter 4-stem ONNX model card](https://huggingface.co/Best-Practice/spleeter-4stems-onnx)
- [Transformers.js supported tasks](https://huggingface.co/docs/transformers.js/)

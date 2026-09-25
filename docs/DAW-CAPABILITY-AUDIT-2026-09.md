# KYX full-DAW capability audit — 2026-09-25

This is a working-tree audit for the expanded product direction in ADR 0014.
“Already present” describes code that exists; “partial” means the core exists
but a professional workflow or platform guarantee is missing. It is not a
release certification. The current Windows desktop build is still a thin
Electron shell around Web Audio, and this workspace also contains unrelated
uncommitted recording/warp/AI work that must be reviewed before any release
claim.

## Snapshot

KYX is already a substantial local-first music workstation: a shared live and
offline audio engine, MIDI and piano-roll composition, linear arrangement,
AudioClips, a broad built-in instrument/effect set, routing, automation,
collaboration, durable project storage and export. It is not starting from a
blank canvas.

It is not yet a professional multitrack recording studio. It can record an
instrument such as guitar **today** if the audio interface presents the chosen
input as a browser `audioinput`: the current capture path requests a specific
device, disables echo cancellation/noise suppression/automatic gain control,
captures Float32 PCM in AudioWorklet blocks, and can place the take on an armed
track. The arrangement UI now describes this as audio-input recording; older
internal identifiers such as `PcmMicRecorder` remain for compatibility.

## Capability matrix

| Area                                     | Current evidence                                                                                                                                                                                                                                                     | Gap to the full-DAW bar                                                                                                                                                                                                                                 | Priority            |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Project/audio foundation                 | Serializable schema-versioned document; command/undo; AudioClip assets; shared live/offline AudioEngine; WAV/stem export                                                                                                                                             | Keep this as the common project and render contract while adding native runtimes                                                                                                                                                                        | Foundation          |
| Composition, MIDI and arrangement        | Piano roll, sequencer, scenes, song arrangement, Web MIDI, automation, groove, mixer groups/sends and native DSP                                                                                                                                                     | Broader project workflow still needs regression coverage as audio tracks become first-class; don't fork a second document model                                                                                                                         | P1                  |
| Single-source recording                  | `PcmMicRecorder`, chosen `audioinput`, raw PCM worklet capture, meter/trim, dry monitor, alignment setting, IndexedDB chunk recovery; UI reports worklet-confirmed PCM channels/rate and available browser track settings/channel range                              | Verify reported channel layout and end-to-end browser path on physical hardware; no per-hardware-channel routing                                                                                                                                        | P0                  |
| Simultaneous recording and input routing | Recorder is guarded by one module-level `activeCapture`; Arrangement UI stores one `armedTrackId`; one selected input device is saved as a browser-local preference                                                                                                  | Arm several tracks at once; route distinct physical channels/devices to mono/stereo tracks; expose and validate channel layout                                                                                                                          | P0                  |
| Monitoring and latency                   | Dry input can go directly to `AudioContext.destination`; latency calibration and manual recording alignment exist. A metadata-only WASAPI query on the present Volt 276 reports a 10 ms shared period and 3 ms minimum exclusive device period; no stream was opened | No selectable native device backend; dry-only monitor bypasses the track FX path; no per-track input/output matrix or measured hardware round-trip latency; the reported periods are capability data only                                               | P0                  |
| Punch, loop takes and comping            | Transport loop and count-in exist; recording recovery is unusually robust                                                                                                                                                                                            | No take-lane data model/UX, loop-pass take preservation, punch-in/out workflow or comp audition/commit                                                                                                                                                  | P0                  |
| Audio editing                            | AudioClip supports trim, gain, fades, split/consolidate, reverse, looping, resample/pitch-preserving stretch and warp-marker representation                                                                                                                          | Verify the in-progress warp UI separately; complete sample-accurate editing/selection, crossfades and take comping without destructive edits                                                                                                            | P1                  |
| Device I/O / desktop                     | Windows Electron package exists; MRT2 has separately tiered helpers                                                                                                                                                                                                  | Electron currently reuses browser Web Audio. No dedicated device setup page, buffer/sample-rate configuration, hardware channel matrix, device-loss recovery tier, or proven native callback backend. macOS/Linux desktop are not released              | P0                  |
| Third-party plugins                      | Strong built-in effects and flagships; on-demand AudioWorklet loading                                                                                                                                                                                                | No VST3/AU host, plugin scan/cache/blacklist, crash isolation, plug-in state/automation contract or native UI bridge                                                                                                                                    | P1, Studio          |
| Mix / master / export                    | Sends, groups, sidechain, PDC mechanisms, master processors, meters/LUFS, offline render and stem exports                                                                                                                                                            | Need reference monitoring, inter-sample true-peak/meter conformance gates, loudness target workflow, project-wide export presets and hardware loopback listening gates                                                                                  | P1                  |
| AI producer                              | Deterministic local generator, candidate/ranker and symbolic priors, audio-reference analysis, optional semantic/audio models, SUNO compose, MRT2 provider tiers                                                                                                     | Current tiny ONNX files rank or condition symbolic candidates; they are not general-purpose music-composition models. Ranker teacher labels are heuristic (`favoriteGroups: 0`); song-level A/B and independently human-rated quality gates remain open | P0, product quality |
| Platform/release                         | Browser Chromium verifier and Windows package pipeline exist                                                                                                                                                                                                         | Current automated browser verifier is Chromium; Firefox/Edge and manual Safari/iOS are separate gates. No released macOS/Linux Studio hardware matrix                                                                                                   | P1                  |

## Professional workflow comparison

There is no single DAW certification checklist. This audit uses observable
workflows from current vendor manuals rather than feature-count marketing.

- Ableton documents per-track mono/stereo external input selection, channel
  configuration, input meters, monitoring modes, multi-track arm, punch in/out,
  loop recording that retains passes, take lanes and comp creation.
- Logic's low-latency guidance treats interface/input/output latency and
  plug-in delay as parts of the monitored path, with a low-latency mode that
  bypasses high-latency processing on record-enabled channels.
- Microsoft exposes a native shared-mode low-period interface on Windows via
  `IAudioClient3`, as well as exclusive mode. Exclusive mode can silence other
  system audio, so a pro host needs an explicit mode/fallback and device-release
  policy.
- Web Audio latency is cumulative across input hardware, browser buffering,
  DSP and output hardware. `channelCount` is not baseline across major
  browsers; a browser-only DAW must report observed settings and avoid promising
  arbitrary interface channel routing.

Sources: [Ableton recording](https://www.ableton.com/en/manual/recording-new-clips/),
[Ableton routing](https://www.ableton.com/en/manual/routing-and-i-o/),
[Ableton comping](https://www.ableton.com/en/live-manual/11/comping/),
[Apple Logic low-latency mode](https://support.apple.com/guide/logicpro-ipad/record-with-low-latency-monitoring-mode-lpip828e667e/3.3/ipados/26),
[W3C Web Audio 1.1](https://www.w3.org/TR/webaudio/),
[W3C Media Capture](https://www.w3.org/TR/mediacapture-streams/),
[MDN channelCount support note](https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackSettings/channelCount),
[Microsoft IAudioClient3](https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nn-audioclient-iaudioclient3),
[Microsoft exclusive-mode caveats](https://learn.microsoft.com/en-us/windows/win32/coreaudio/exclusive-mode-streams).

## Hard gaps before claiming “professional multitrack recording”

1. **Channel-aware I/O:** identify every input and output channel; select mono or
   stereo pairs per track; display the signal from the selected channel; support
   interface hot-unplug/reconnect without silently switching sources.
2. **Multi-arm capture:** capture several channels concurrently with bounded
   realtime buffers, no channel swaps, no dropped/duplicated frames, and no
   unbounded UI-thread copies.
3. **Monitoring:** explicit Off / Input / Auto modes; direct and software
   monitoring labels; actual measured latency; track-FX monitoring only where
   the live path meets a tested budget; clear feedback warnings.
4. **Latency and timing:** record sample rate, channel map and calibrated input
   offset as take metadata; compensate placement reproducibly; measure
   round-trip latency with loopback rather than relying only on a manual slider.
5. **Performance recording:** count-in, punch-in/out, loop-pass preservation,
   named takes, audition, non-destructive comp ranges, crossfades and undo.
6. **Data safety:** per-channel durable staging, quota preflight and actionable
   failure; interrupted-session recovery; a multi-hour soak; project swap,
   shutdown and update behavior while recording.
7. **Host proof:** test a published matrix of Windows builds, interfaces,
   drivers, sample rates and buffer sizes. A code-level mock is not hardware
   validation.

## AI quality and model policy

The shipped ONNX ranker/prior models are approximately 18–25 KB each. Their
small size is useful for lazy delivery but reflects compact score/prior models,
not a general audio model. Optional multilingual text and audio embedding
models are much larger (roughly 118 MB and 87 MB in the documented fetch path)
and must stay opt-in/lazy. MRT2 is a separate native/companion provider with
platform-specific performance tiers.

Before describing KYX as an AI producer, separate these evaluation axes:

- intent extraction and hard-constraint adherence;
- deterministic and undo-safe project mutation;
- symbolic validity and arrangement coherence;
- sound-render technical validity;
- blind human preference against the existing baseline;
- latency, memory and bundle/download footprint;
- licensing, attribution, privacy and offline fallback.

No trained model should become the sole author of project truth. A model
proposal must pass exact constraints, be auditionable in the user's project,
and apply through one explicit, reversible command.

## Definition of the product bar

Do not call the expanded DAW complete until the roadmap's release gates prove:

- multichannel real-hardware capture with explicit routing and no lost PCM;
- repeated long-form recording with recovery and the recording workflows above;
- measured low-latency monitoring on a declared desktop device/backend matrix;
- plugin state, automation, PDC and offline/freeze behavior for each supported
  third-party format;
- live/offline/export parity for built-in and supported hosted processing;
- cross-browser web smoke plus Windows Studio installation/update/device tests;
- AI quality evaluation that includes human blind listening rather than only
  agreement with a heuristic teacher.

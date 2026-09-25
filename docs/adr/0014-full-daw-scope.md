# ADR 0014 — Expand KYX to a full production DAW

Date: 2026-09-25  
Status: Accepted — product direction explicitly confirmed by the owner

## Context

The original product charter intentionally excluded vocal and multitrack
recording, hardware-driver management and third-party plug-in hosting. That
boundary no longer matches the owner's goal: KYX must grow into a serious
production DAW that can record real instruments, arrange and mix complete
projects, and compete on essential studio workflows rather than remain a
browser-only beat workstation.

The working product already has more audio-recording infrastructure than the
old charter admits: a selected `audioinput` can be captured as Float32 PCM in
bounded AudioWorklet blocks, a take can be placed on an arrangement track,
committed blocks are recoverable, input trim and dry monitoring exist, and
recording alignment can be calibrated. This is a **single-device, one-take / one
armed track path**, not professional multichannel studio I/O. The UI's
microphone/vocal wording obscures that an instrument such as a guitar can
already be recorded through an audio-interface input.

Browser capture is useful and remains supported, but browser APIs do not expose
uniform per-channel hardware routing or guarantee device-period / round-trip
latency. Electron currently packages the same Web Audio application in a thin
shell; it does not turn that path into an ASIO/Core Audio host.

## Decision

### 1. Product scope

KYX is now a full production DAW target. Instrument and microphone recording,
simultaneous multitrack input, take management, comping, professional editing,
hardware I/O, third-party plug-ins and AI-assisted production are in scope.
The existence of a roadmap item is not evidence that a capability ships; all
release claims must match tested builds and supported hardware.

### 2. Two runtime profiles

- **KYX Web** remains a first-class, local-first creation environment. It keeps
  the existing offline project, sequencing, built-in DSP, rendering and export
  paths. Browser input capture remains a capability-driven convenience path;
  the UI must disclose the actual device/channel/latency settings and must not
  promise low-latency multichannel support where the browser cannot verify it.
- **KYX Studio (desktop)** is the pro-audio target, initially Windows because
  that is the shipped desktop platform. It must gain a native audio-device
  backend for configurable inputs/outputs, sample rate, buffer period, channel
  mapping, monitoring and measured round-trip latency. The current Electron
  shell is not that backend. macOS/Linux targets remain unclaimed until their
  device, packaging and hardware tests pass.

The backend technology and the boundary between native device callbacks and
the shared project/engine are **not selected by this ADR**. A follow-up audio
I/O ADR must compare measured WASAPI shared/exclusive modes, an ASIO option
subject to licensing, and the cost of preserving live/offline render parity.
No native audio backend is added by assuming IPC is sample-accurate.

### 3. Recording contract

The target recording workflow includes per-track input selection and arming,
multiple simultaneous mono/stereo inputs, visible input meters and clipping,
monitor modes, latency measurement/compensation, count-in, punch-in/out,
loop-recorded takes, non-destructive take lanes/comping, undo, and crash/quota
recovery. Guitar, bass, synth hardware, microphones and other line-level sources
are all audio inputs; the workflow is not named or limited to vocals.

Recording remains raw, recoverable audio until the user chooses processing or
commit. Any audio written into the project is a normal editable media clip with
provenance; the persisted project model stays serializable and mutations stay
command/undo based.

### 4. Plug-in ecosystem

Third-party plug-in hosting is in scope for KYX Studio. VST3 is the first
desktop format to evaluate and implement; macOS Audio Units follow only with a
real macOS host and test matrix. VST2 is not a target. Hosting must address
scan isolation, crash containment, state/preset persistence, parameter
automation, channel layouts, latency/PDC, bypass and offline render/freeze
parity before it is called production-ready. Built-in KYX effects remain
available in Web and offline projects.

The VST 3.8 SDK is MIT-licensed; retain its copyright/license terms and follow
the trademark rules if the VST mark is used. Steinberg currently offers the
ASIO SDK under GPLv3 or a proprietary license. The follow-up ADR must select a
route compatible with KYX's actual distribution model before including the SDK
or making ASIO support claims. `package.json`'s `private: true` flag is not a
product license. Until the route is chosen, Windows native I/O work should
benchmark Windows audio APIs and state exactly which devices and latency tiers
pass.

### 5. AI and model distribution

The local deterministic composition engine remains the always-available
fallback. Small ONNX models may ship or be lazily downloaded as versioned,
hash-verified optional model packs after model-quality, license, memory and
latency gates pass. Large models must be explicitly size-labelled and opt-in;
they must not inflate the boot bundle. User audio and projects are never sent
to a remote inference service without a separate explicit user action.

MRT2 stays an optional provider/performer behind its existing platform
capability tiers. A provider is not declared realtime because it has an
adapter; it must pass the measured host benchmark. AI suggestions must cite
project/audio evidence, be auditionable and apply through normal undoable
commands. Technical signal proxies are not presented as musical-quality truth.

### 6. Architectural invariants retained

- One serializable project model, one command/undo path and explicit schema
  migrations.
- The browser engine and offline renderer retain their parity contract.
- Native I/O and plug-in runtimes sit behind typed platform boundaries; they
  cannot leak device handles, plug-in objects, AudioNodes or PCM buffers into
  persisted project documents.
- Realtime work never moves onto React or an unbounded main-thread task.
- Optional model/provider failure cannot prevent ordinary project boot,
  editing, playback of captured audio or export.
- Support claims are capability- and evidence-based, with browser, OS,
  interface, driver and buffer settings recorded in the test matrix.

## Consequences

- ADR 0001's "browser is the only core platform" direction and the recording,
  ASIO and plug-in non-goals in `VISION.md` are superseded by this product
  decision. Browser-first remains a web distribution strategy, not a limit on
  the desktop Studio target.
- The current product must be described honestly as having useful single-input
  recording but not yet full studio I/O, multitrack takes/comping or a native
  plug-in host.
- Native audio I/O and plug-in hosting are substantial, separately gated
  initiatives. They require follow-up ADRs, a representative hardware lab,
  licensing review, soak tests and release packaging; this ADR does not claim
  those capabilities already exist.
- `docs/DAW-CAPABILITY-AUDIT-2026-09.md` is the point-in-time gap register and
  `docs/ROADMAP-FULL-DAW.md` owns phases and exit gates.

## References

- `docs/adr/0001-browser-first.md`
- `docs/adr/0002-audio-clock-scheduling.md`
- `docs/adr/0003-project-model-runtime-separation.md`
- `docs/adr/0009-offline-render-export.md`
- `docs/adr/0010-desktop-packaging.md`
- `docs/adr/0012-mrt2-generative-tracks.md`
- `docs/adr/0013-windows-generative-companion.md`
- [W3C Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/)
- [W3C Web Audio API 1.1](https://www.w3.org/TR/webaudio/)
- [Ableton Live 12 — Recording New Clips](https://www.ableton.com/en/manual/recording-new-clips/)
- [Ableton Live 12 — Routing and I/O](https://www.ableton.com/en/manual/routing-and-i-o/)
- [Ableton Live 11 — Comping](https://www.ableton.com/en/live-manual/11/comping/)
- [Microsoft — IAudioClient3](https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nn-audioclient-iaudioclient3)
- [Microsoft — WASAPI exclusive-mode streams](https://learn.microsoft.com/en-us/windows/win32/coreaudio/exclusive-mode-streams)
- [Steinberg — VST 3 licensing](https://steinbergmedia.github.io/vst3_dev_portal/pages/FAQ/Licensing.html)
- [Steinberg — third-party developer licensing options](https://www.steinberg.net/developers/)
- [Steinberg — VST 3.8 SDK license](https://steinbergmedia.github.io/vst3_dev_portal/pages/VST%2B3%2BLicensing/VST3%2BLicense)
- [ONNX Runtime Web deployment and execution providers](https://onnxruntime.ai/docs/tutorials/web/)

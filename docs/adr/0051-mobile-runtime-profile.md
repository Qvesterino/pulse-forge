# ADR 0051 — Mobile runtime profile: PWA-first, sketching before tracking

- **Date:** 2026-10-18
- **Status:** Accepted — product direction for KYX Mobile (Android first)
- **Scope:** the browser runtime on phones/tablets, the Android packaging path,
  and the boundary between KYX Web, KYX Mobile and a future native audio host
- **Related:** ADR 0001 (browser-first), ADR 0010 (desktop packaging),
  ADR 0014 (full-DAW scope), ADR 0050 (Windows audio I/O direction)

## Context

KYX Web is a local-first browser DAW: React UI, project model + commands,
Web Audio + AudioWorklet DSP, IndexedDB persistence and offline rendering. The
desktop target is a thin Electron shell around the same engine (ADR 0010). There
is no mobile runtime profile today: the PWA manifest exists and some touch
sizing rules exist, but the product does not state what a phone is expected to
do, what it is not expected to do, or how it reaches the Play Store.

Android changes the constraints in ways that a desktop wrapper does not:

- **Latency.** Web Audio on Android Chrome/WebView typically reports 20–40 ms of
  output latency depending on device and route. Bluetooth adds 100–200 ms.
  There is no Web Audio API for a user-selectable hardware period or a measured
  round-trip time. This is usable for composition, sequencing, mixing and
  export; it is not a low-latency tracking path.
- **MIDI.** Chrome on Android does not expose Web MIDI. USB/BLE MIDI input
  requires a native bridge. On-screen instruments and the existing MIDI-file
  import/export path do not.
- **Background audio.** A browser tab / WebView is suspended when it is hidden.
  Reliable background playback needs a foreground service in a native shell;
  Media Session metadata alone is not a guarantee.
- **Play Store.** A pure WebView wrapper can be rejected as a webview-only app.
  A Trusted Web Activity (TWA) is the compliant packaging for a real PWA and
  requires HTTPS, a web manifest and Digital Asset Links.
- **Touch.** Hover, small hit targets, pointer-only drags and dense desktop
  panels do not become usable by shrinking the viewport.

Flutter is a UI toolkit, not an audio engine. A Flutter port would still need a
native audio backend (Oboe/AAudio + C++ DSP), a plugin host, a new project model
integration and a second test suite. It would not reuse the existing Web Audio
engine, effects, instrument DSP, command system or golden vectors. The useful
shared boundary for a native product is the **project schema, command semantics
and DSP algorithms/golden vectors**, not the React UI.

## Decision

### 1. KYX Mobile v1 is a PWA/TWA for sketching and mixing — not tracking

KYX Mobile v1 ships the same web app as an installable PWA and, when packaged
for Google Play, as a TWA. Its supported promise is:

| Capability                                          | v1 contract                              |
| --------------------------------------------------- | ---------------------------------------- |
| Sequencing, arrangement, automation, mixing         | Supported, touch-first                   |
| Built-in instruments/effects, offline render/export | Supported                                |
| On-screen keyboard/pads, MIDI-file import/export    | Supported                                |
| IndexedDB projects, offline app shell               | Supported                                |
| Live microphone/instrument monitoring               | **Best-effort, not a low-latency claim** |
| USB/BLE MIDI input                                  | **Not in v1** (needs a native bridge)    |
| Background playback while the app is hidden         | **Not guaranteed**                       |
| Third-party plug-in hosting                         | **Not in v1**                            |

The UI must state the measured/declared latency and the unsupported features
instead of implying desktop-class tracking.

### 2. PWA first; TWA is packaging, not a second app

- The PWA manifest is the single source of identity (name, icons, scope,
  start URL, display, colors). The TWA config is generated from the deployed
  origin and the same identity values.
- Play Store delivery uses **TWA (Bubblewrap)** with Digital Asset Links. A
  bare WebView shell is not the plan.
- A native shell (Capacitor or equivalent) is allowed **only** for specific
  platform gaps — USB/BLE MIDI, SAF document access, foreground service/audio
  focus, wake lock — and each addition needs its own decision record. The web
  app remains the source of truth for UI, project state and commands.

### 3. A native audio engine is a separate product decision

If device measurements show that tracking/monitoring is a product requirement,
the response is a **KYX Studio Android** host with an Oboe/AAudio stream and a
C++ DSP core — not a Flutter rewrite and not the Web Audio graph pretending to
be real-time. That host must share the project schema and the DSP golden
vectors, and its live/offline parity must be proven with the same discipline as
the web engine. Until that ADR exists, no low-latency Android claim is made.

### 4. Mobile profile is a capability profile, not a user-agent switch

The runtime classifies the device from capabilities:

- coarse primary pointer or a narrow touch viewport → mobile profile,
- `maxTouchPoints` / `any-pointer: coarse` distinguishes a touch laptop,
- no user-agent sniffing for behavior.

The profile controls touch sizing/gesture hygiene and, where measured, optional
quality choices. It must never change project state or silently change a
render. The DSP remains sample-rate and block-size driven; no mobile-only audio
path is introduced.

## Consequences

- The existing React app, commands, project model, effects and worklets are
  reused. No Flutter codebase, no second UI.
- Touch targets, safe areas, sticky-hover removal and gesture ownership become
  first-class CSS/TS work, not a wrapper afterthought.
- The PWA install and TWA package depend on a deployed HTTPS origin and a
  release-generated asset-links file; neither can be validated fully in the
  repository alone.
- Web MIDI is explicitly unavailable on Android Chrome until a native bridge
  exists; on-screen input and MIDI files are the v1 paths.
- Latency and background behavior are disclosed, not promised. Bluetooth
  monitoring is outside the support matrix.
- Bundle discipline matters more on mobile: the core worklet lazy seam
  (`fx-extra-worklet.js`) and the existing route/feature lazy loads are part of
  the mobile boot budget, not optional polish.

## Alternatives rejected

1. **Flutter rewrite.** New UI + new engine + new tests; no reuse of the
   Web Audio/AudioWorklet surface; still needs a native audio backend for
   tracking.
2. **WebView-only APK.** Play Store risk, no PWA install/update semantics, and
   no benefit over TWA for the v1 feature set.
3. **Native audio engine now.** Large second-engine project without a measured
   product need; defer until device data justifies it.
4. **Force landscape / desktop layout.** A phone is not a small desktop; the
   touch profile and responsive rules are the contract.

## Verification and follow-ups

Repository-level gates for this ADR:

- PWA manifest identity/icons/scope/start URL and mounted-base behavior
  (`tests/pwa.test.ts`),
- mobile profile classification and touch CSS contract
  (`tests/mobile-profile.test.ts`),
- TWA manifest + asset-links generation with HTTPS/package/fingerprint
  validation (`tests/mobile-packaging.test.ts`).

Owner gates that remain outside CI: install on representative Android
Chrome/WebView devices, measure `baseLatency`/`outputLatency` and xruns per
device, verify TWA install/launch and Digital Asset Links against the real
domain and signing certificate, verify background behavior on a foreground
service build, and run a real USB/BLE MIDI bridge spike before claiming MIDI.

Follow-up decisions: Capacitor/native bridge (if MIDI/background is scheduled),
Oboe/AAudio engine (only if tracking is scheduled), and a mobile device matrix
with measured latency, thermals and memory.

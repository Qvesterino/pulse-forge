# ADR 0052 — Android native shell boundary (MIDI, SAF, foreground service, audio focus)

- **Date:** 2026-10-18
- **Status:** Accepted — optional shell contract; the shell itself is not bundled
- **Scope:** the `window.kyxNative` bridge used by KYX Mobile when a
  Capacitor/WebView shell is present
- **Related:** ADR 0051 (mobile runtime profile / PWA-first), ADR 0010
  (desktop thin shell), ADR 0014 (full-DAW scope)

## Context

ADR 0051 makes KYX Mobile v1 a PWA/TWA and explicitly rejects a Flutter port
and a native audio engine. Four Android gaps cannot be closed by a pure PWA:

1. **USB/BLE MIDI** — Chrome on Android does not expose Web MIDI.
2. **Storage Access Framework (SAF)** — large exports and document import are
   more reliable through Android's document picker than a blob anchor or a
   `<input type=file>` chooser.
3. **Foreground service** — a hidden WebView is suspended; reliable background
   playback/recording needs a service with a notification.
4. **Audio focus** — the shell must request/abandon focus so other apps duck or
   stop instead of fighting KYX.

Adding a shell is only justified when one of these is actually scheduled. The
shell must not become a second UI, a second project model, or a second audio
engine.

## Decision

### 1. One optional, same-app bridge

A shell may inject exactly one object as `window.kyxNative`:

```ts
interface KyxNativeBridge {
  version?: number;
  platform: "android" | "ios" | string;
  midi?: NativeMidiBridge;
  files?: NativeFilesBridge;
  audioSession?: NativeAudioSessionBridge;
}
```

It is injected by the app's own shell (Capacitor plugin or
`WebView.addJavascriptInterface`), never by a page/URL parameter and never by a
remote frame. The web layer validates every method shape and treats an
incomplete bridge as absent. The bridge never owns project state, commands or
DSP state.

### 2. Web MIDI wins; the shell is the fallback

- If `navigator.requestMIDIAccess` exists, it is used unchanged.
- If it is absent and `window.kyxNative.midi` is valid, `installNativeMidiShim()`
  defines the Web MIDI surface backed by the shell. `MidiInput` and
  `MidiOutput` keep their existing code path.
- The shim accepts only bounded integer byte arrays (≤ 64 bytes per event),
  ignores unknown input ids, and exposes no sysex unless the shell explicitly
  supports it later.
- Device add/remove flows through `onStateChange`; the existing reconnect and
  stuck-note recovery in `MidiInput` stay authoritative.

### 3. SAF is the save boundary, not a new file system

- `downloadBlob` is the single artifact-save boundary. When the shell provides
  `files.saveDocument`, it is used; user cancel/failure falls back to the
  browser download. Without a bridge the current anchor download is unchanged.
- `files.pickDocuments` is available for explicit SAF import (large packs,
  folder-like flows). A WebView file chooser is still acceptable for the
  ordinary `<input type=file>` path.
- The shell returns document bytes and names; it does not expose raw paths or
  persistent URI permissions to the web app.

### 4. Foreground service and audio focus are refcounted reasons

`acquire("playback" | "recording")` and `release(...)` are called only on the
first/last holder of each reason. The web layer binds them to:

- `Transport.subscribePlaying` for playback,
- `subscribeSessionRecordingState` (recording state) for capture.

The native side maps the first acquire to a foreground service (media playback
or microphone type, with the required notification) and an audio-focus request;
the last release abandons focus and stops the service. Overlapping playback and
recording keep the service alive until both release.

Without a shell, the web layer uses the Screen Wake Lock API where available
and re-acquires it after tab visibility changes. Audio-focus loss is exposed as
`subscribeMobileAudioFocus`; pausing the transport on focus loss is a product
decision for the shell phase, not an implicit web behavior.

### 5. No native audio engine in this decision

The shell does not replace Web Audio/AudioWorklet. Low-latency tracking (Oboe/
AAudio + C++ DSP) remains a separate product decision as described in ADR 0051.
Plugin hosting remains out of scope.

## Consequences

- The web app builds and tests with no shell; every bridge path has a fallback.
- A shell can be added later without changing project schema, commands, DSP,
  effects or UI ownership.
- The shell must keep a stable contract and a version bump when shapes change;
  the web side is deliberately tolerant of extra fields.
- MIDI sysex, MPE over BLE, background recording policy and focus-loss pausing
  remain explicit shell decisions, not accidental behavior.
- Android build, signing, notification permission, foreground-service type
  declarations and real-device MIDI/BLE testing remain owner gates; none of
  them can be validated by a repository test.

## Alternatives rejected

1. **Do nothing.** Loses USB/BLE MIDI and reliable background audio on Android.
2. **Flutter shell.** Adds a second UI/toolkit with no audio benefit.
3. **Native audio engine now.** Large second-engine project without a measured
   tracking need; ADR 0051 keeps it separate.
4. **Remote/URL-provided bridge.** A page-controlled bridge would be an
   injection surface; the bridge is same-app only.

## Verification

Repository gates: `tests/mobile-native-bridge.test.ts` covers bridge shape
validation, the MIDI shim (inputs/outputs, note dispatch, send, device change,
Web MIDI preference), SAF save/fallback, and audio-session refcounting/wake-lock
fallback. Existing `download.ts` and MIDI suites remain the behavior gates.

Owner gates: Android shell build, `addJavascriptInterface`/Capacitor plugin
wiring, notification permission, foreground-service manifest types, real USB
and BLE MIDI controllers, audio-focus duck/pause behavior, and a 30-minute
background/recording soak.

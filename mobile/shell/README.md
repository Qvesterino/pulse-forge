# KYX Android shell — Capacitor spike (not shipped)

This directory is a **spike**, not a working Android app. No APK was built or
verified. Nothing here changes the web app or claims MIDI/SAF/background/focus
support until a real device test passes.

The web side already expects the optional contract in
[`docs/MOBILE-SHELL.md`](../../docs/MOBILE-SHELL.md) /
[`ADR 0052`](../../docs/adr/0052-android-native-shell-boundary.md):

```ts
window.kyxNative = { platform: "android", midi?, files?, audioSession? };
```

Without it, KYX runs as the PWA and every feature falls back (Web MIDI when
present, anchor download, wake lock).

## What is in this spike

- `capacitor.config.ts` — app id/name and the repo `dist/` as `webDir`.
- `web/kyx-native-adapter.js` — maps a Capacitor `KyxNative` plugin to the
  `window.kyxNative` contract. It must run **before** the app boots.
- `android/KyxNativePlugin.kt` — method skeleton only. Every method rejects as
  unimplemented; it is a boundary checklist, not a plugin.
- `package.json` — isolated Capacitor deps so the root app does not grow a
  mobile toolchain.

## Prerequisites (owner gate)

- Android Studio / SDK, JDK 17+, a signing keystore.
- The deployed PWA or a local `npm run dev` origin reachable from the device.
- A real USB-MIDI and BLE-MIDI controller for the MIDI acceptance run.
- A device with a wired loopback for the latency report (ADR 0053).

## Build the spike

```bash
# from the repo root: produce dist/
npm run build

cd mobile/shell
npm install
npx cap add android
npx cap sync android
npx cap open android
```

Then implement `KyxNativePlugin.kt` and inject the adapter before the first app
script. Capacitor's plugin proxy is async; the adapter is deliberately a bridge,
not a second UI.

## Must be implemented before any claim

| Surface | Native work |
| --- | --- |
| MIDI | `MidiManager` USB + BLE MIDI GATT, hot-plug, note-off flush, one output thread per port |
| SAF | `ACTION_OPEN_DOCUMENT` / `ACTION_CREATE_DOCUMENT`, chunked binary transfer, no raw paths to the page |
| Foreground service | media-playback / microphone service types, notification permission, start/stop on refcount |
| Audio focus | `AUDIOFOCUS_GAIN`, abandon on last release, `subscribeFocus` on loss |
| Manifest | `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK`, `FOREGROUND_SERVICE_MICROPHONE`, `POST_NOTIFICATIONS`, `RECORD_AUDIO` as applicable |

## Acceptance (do not skip)

- Web MIDI absent → adapter installs; USB/BLE note on/off, sustain, pitch bend,
  CC, hot-unplug during a held note, reconnect, no stuck notes.
- Export WAV/MP3/ZIP/JSON/MIDI → SAF save; cancel → browser fallback.
- Large WAV import → SAF, memory does not double.
- Play → notification + focus; pause/stop → service stops.
- Record while stopped → microphone service + focus; stop → both release.
- Play + record overlap → service survives until both release.
- Incoming call / other player → `subscribeFocus(false)`; policy is explicit.
- 30-minute background/recording soak: no orphan service or wake lock.
- Device Health (Diagnostics → Device) shows the bridge as available and the
  worklet/core readiness truthfully.

If any of these fail, fix the shell or leave the feature absent. The web
fallback is the product contract.

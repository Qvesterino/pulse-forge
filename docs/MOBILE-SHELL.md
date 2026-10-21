# KYX Android native shell — bridge contract

Decision record: [ADR 0052](./adr/0052-android-native-shell-boundary.md).
PWA/runtime profile: [ADR 0051](./adr/0051-mobile-runtime-profile.md) and
[MOBILE.md](./MOBILE.md).

The shell is **optional and not built by this repository**. KYX Web works
without it. Add a shell only when USB/BLE MIDI, SAF document flows, a foreground
service or audio focus are actually scheduled. A Capacitor/WebView shell is the
intended implementation; Flutter is not.

## Injection

The shell injects one same-app object before the page's first script runs:

```ts
window.kyxNative = {
  version: 1,
  platform: "android",
  midi: { ... },
  files: { ... },
  audioSession: { ... },
};
```

Rules:

- Same-app only (`addJavascriptInterface` or a Capacitor plugin). Never accept a
  bridge from a URL, postMessage, remote frame or user content.
- The object may contain extra fields; the web side ignores them.
- An incomplete surface is treated as absent: the PWA fallback stays active.
- The bridge must not expose project state, raw filesystem paths, secrets, or
  an `eval`/code-loading surface.

## MIDI (USB/BLE)

Web MIDI is preferred when `navigator.requestMIDIAccess` exists. On Chrome
Android it does not, so `installNativeMidiShim()` exposes the Web MIDI slice the
app already uses, backed by:

```ts
interface NativeMidiBridge {
  listInputs(): Promise<Array<{ id: string; name?: string; manufacturer?: string }>>;
  listOutputs(): Promise<Array<{ id: string; name?: string; manufacturer?: string }>>;
  send(outputId: string | null, data: number[]): void | Promise<void>;
  subscribe(listener: (event: { inputId: string; data: number[] }) => void): () => void;
  onStateChange?(listener: () => void): () => void;
}
```

- `data` is a bounded integer byte array; the web side accepts at most 64 bytes
  per event and ignores malformed/out-of-range bytes.
- `subscribe` may be called more than once (input and output each create their
  own access object); the shell must fan out or support multiple listeners.
- `onStateChange` fires after a device is added/removed; the shim re-lists ports
  and emits `connected`/`disconnected` so the existing stuck-note recovery in
  `MidiInput` runs.
- `send` is called by `MidiOutput`; the shell owns the actual USB/BLE transport.
- Sysex is not claimed. If added later, extend the contract and the shim behind
  an explicit capability flag.

Android sketch: `MidiManager` for USB, `BluetoothGatt`/MIDI-BLE service for
wireless, one output thread per port, note-off flushing on disconnect. Keep the
bridge callback off the audio thread; it only feeds the existing parser.

## SAF (documents)

```ts
interface NativeFilesBridge {
  pickDocuments(options?: {
    mimeTypes?: string[];
    multiple?: boolean;
  }): Promise<Array<{ name: string; mimeType?: string; bytes: Uint8Array }>>;
  saveDocument(payload: {
    name: string;
    mimeType?: string;
    bytes: Uint8Array;
  }): Promise<{ saved: boolean; name?: string }>;
}
```

- `saveDocument` is used by `downloadBlob`, the single artifact-save boundary
  (project JSON, WAV, MP3, MIDI, packs). Implement it with
  `ACTION_CREATE_DOCUMENT`; return `{ saved:false }` on user cancel so the web
  fallback can still run.
- `pickDocuments` is the explicit SAF import helper for large packs and
  folder-like flows. Ordinary `<input type=file>` may continue through the
  WebView file chooser, which the shell should route through SAF.
- Never return a raw path or a persisted URI permission to the page; return
  bytes/name only.
- Large files: stream/chunk in the plugin if the bridge serialization would
  duplicate the whole buffer; the web helper reads one Blob at a time.

## Foreground service and audio focus

```ts
interface NativeAudioSessionBridge {
  acquire(reason: "playback" | "recording"): void | Promise<void>;
  release(reason: "playback" | "recording"): void | Promise<void>;
  subscribeFocus?(listener: (focused: boolean) => void): () => void;
}
```

The web layer calls these only on the first/last holder of each reason:

- `playback` — `Transport.subscribePlaying`;
- `recording` — arrangement recording state (`subscribeSessionRecordingState`).

Native behaviour:

- `acquire("playback")` → start a media-playback foreground service, request
  `AUDIOFOCUS_GAIN`, show the required notification.
- `acquire("recording")` → start a microphone-type foreground service (declare
  `FOREGROUND_SERVICE_MICROPHONE`, request `RECORD_AUDIO` before acquire).
- Both can be held at once; stop the service and abandon focus only after both
  release.
- `subscribeFocus(false)` tells the web UI the app lost focus. Pausing the
  transport on loss is a product policy; hook it explicitly, not implicitly.

Without a shell, the web layer uses the Screen Wake Lock API and re-acquires it
after visibility changes. That keeps the display awake; it does not provide a
foreground service.

## Capacitor shape

If Capacitor is chosen, one plugin can expose all four surfaces:

```ts
// capacitor.config.ts (template; not built in this repo)
import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "app.kyx.studio",
  appName: "KYX",
  webDir: "dist",
  server: { androidScheme: "https" },
  android: { allowMixedContent: false },
};
export default config;
```

The plugin injects `window.kyxNative` from `load()` (or registers the bridge
before `super.loadUrl`). Build/sign/upload remains the owner gate described in
`MOBILE.md`.

## Repository integration points

| Gap              | Web-side entry point                                                         |
| ---------------- | ---------------------------------------------------------------------------- |
| MIDI             | `src/midi/nativeMidi.ts` (`installNativeMidiShim`, `createNativeMidiAccess`) |
| SAF save         | `src/export/download.ts` → `src/mobile/nativeFiles.ts`                       |
| SAF import       | `src/mobile/nativeFiles.ts` (`pickNativeFiles`)                              |
| Foreground/focus | `src/mobile/audioSession.ts`, wired in `src/services.ts`                     |
| Shape validation | `src/mobile/nativeBridge.ts`                                                 |

## Acceptance checklist

- Web MIDI present → shim refuses to install; existing path unchanged.
- No bridge → MIDI returns false, anchor download works, no wake-lock error.
- USB keyboard: note on/off, sustain, pitch bend, CC, hot-unplug during a held
  note (no stuck note), reconnect.
- BLE keyboard: same, plus connection loss during a held note.
- Export a WAV/MP3/ZIP/JSON/MIDI → SAF create-document; cancel → fallback.
- Import a large WAV through SAF; memory does not double.
- Play → foreground notification + focus; pause/stop → service stops.
- Record while stopped → microphone service + focus; stop → both release.
- Play + record overlap → service stays until both release.
- Incoming call / another player takes focus → `subscribeFocus(false)`;
  behavior is the chosen policy, not a surprise pause.
- 30-minute background/recording soak; no orphan service or wake lock.

## Non-goals

- Replacing Web Audio/AudioWorklet with a native engine.
- Third-party plug-in hosting.
- Flutter.
- Background playback guarantees beyond what the foreground service provides.

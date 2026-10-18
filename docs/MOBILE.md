# KYX Mobile — runtime profile and TWA packaging

Decision record: [ADR 0051](./adr/0051-mobile-runtime-profile.md).

KYX Mobile v1 is the **same web app** as KYX Web, installed as a PWA and, for
Google Play, packaged as a Trusted Web Activity (TWA). It is a sketching,
arrangement and mixing target. It is **not** a low-latency tracking product, and
there is no Flutter port.

## Feature contract (v1)

| Capability | Status |
| --- | --- |
| Sequencing, arrangement, automation, mixing | Supported, touch-first |
| Built-in instruments/effects, offline render/export | Supported |
| On-screen keyboard/pads, MIDI-file import/export | Supported |
| IndexedDB projects, offline app shell | Supported |
| Live mic/instrument monitoring | Best effort; latency disclosed, no low-latency claim |
| USB/BLE MIDI | Not in v1 (needs a native bridge) |
| Background playback while hidden | Not guaranteed |
| Third-party plug-ins | Not in v1 |

Web Audio output latency on Android is typically 20–40 ms and depends on the
device and route; Bluetooth adds 100–200 ms. Use the existing latency
calibration/readout rather than quoting a number as a guarantee.

## Mobile profile

`src/shared/mobileProfile.ts` classifies the device from capabilities, not a
user-agent string:

- coarse primary pointer → mobile,
- narrow viewport + touch → mobile,
- wide viewport + fine pointer → desktop even when a touchscreen is present.

It sets `data-mobile-profile` / `data-input-mode` on `<html>` before React
paints and keeps them correct across rotation or pointer changes.
`src/styles/55-mobile-profile.css` is the touch layer:

- 44 px targets on touch for buttons, selects, drag numbers, dock tabs;
- `touch-action: none` on faders/clip handles so a drag does not scroll the
  panel under it;
- sticky hover transforms removed on `hover: none` devices;
- text selection disabled on transport/pads (inputs stay selectable).

Desktop is untouched: every rule is behind a coarse-pointer or narrow-touch
media query.

## PWA

The PWA is already built by `vite-plugin-pwa` (`src/pwa.ts`):

- manifest identity, icons, scope/start URL follow `STUDIO_APP_BASE`;
- prompt-mode updates so a running session never loses its precache;
- the app shell and curated samples are precached; optional runtimes are not.

Verify after a production build:

```bash
npm run build
npx serve dist
```

Check `manifest.webmanifest` in DevTools → Application and confirm the install
prompt. On Android Chrome, install to the home screen and verify offline boot.

## TWA (Google Play)

TWA needs a deployed **HTTPS** origin and Digital Asset Links between the site
and the Android signing certificate.

1. Deploy the PWA and confirm `https://YOUR_ORIGIN/manifest.webmanifest` loads.
2. Obtain the SHA-256 fingerprint of the Play signing certificate (Play Console →
   App integrity, or `keytool -list -v -keystore ...`).
3. Generate the packaging inputs:

   ```bash
   KYX_DEPLOY_URL=https://YOUR_ORIGIN \
   KYX_ANDROID_SHA256=AA:BB:... \
   npm run mobile:twa
   ```

   Optional: `KYX_ANDROID_PACKAGE_ID` (default `app.kyx.studio`),
   `KYX_ANDROID_VERSION_NAME`, `KYX_ANDROID_VERSION_CODE`.

   PowerShell:

   ```powershell
   $env:KYX_DEPLOY_URL="https://YOUR_ORIGIN"
   $env:KYX_ANDROID_SHA256="AA:BB:..."
   npm run mobile:twa
   ```

   This writes:
   - `android/twa-manifest.json` — Bubblewrap input;
   - `public/.well-known/assetlinks.json` — deploy this at the site root.

   Both are gitignored: they contain the real origin/fingerprint and must be
   generated per release, never committed as placeholders.

   For a subpath build (`STUDIO_APP_BASE=/kyx/`), publish the generated
   `assetlinks.json` at the **origin root** (`https://YOUR_ORIGIN/.well-known/assetlinks.json`),
   not under `/kyx/`; Digital Asset Links are verified at the origin.

4. Build the Android project:

   ```bash
   npx @bubblewrap/cli init --manifest android/twa-manifest.json
   npx @bubblewrap/cli build
   ```

5. Deploy `/.well-known/assetlinks.json` and verify it with the Play Console /
   Google statement-list check. Without a matching fingerprint the TWA opens
   with browser chrome (or fails verification).
6. Upload the signed AAB/APK. Do not use a bare WebView wrapper; Play may reject
   it as webview-only.

## Device verification (owner gate)

Fill this in with real measurements; do not claim a device is supported from an
emulator run.

| Device / Android | Browser or TWA | baseLatency | outputLatency | xruns | Notes |
| --- | --- | --- | --- | --- | --- |
| Pixel-class, Android 14+ | Chrome stable | | | | |
| Mid-range, Android 12–13 | Chrome stable | | | | |
| Samsung Internet | latest | | | | |
| TWA build | Play internal track | | | | |

Checklist: install/launch, offline reload, project save/reload, export, touch
drag on a fader/clip, rotation, background/foreground, screen lock during
recording, 30-minute session memory/thermals.

## Known limits and follow-ups

- **Web MIDI is absent on Chrome Android.** A native bridge (Capacitor plugin
  or a dedicated shell) is required before claiming USB/BLE MIDI.
- **Background audio** needs a foreground service in a native shell; the PWA
  alone does not guarantee it.
- **Native audio** (Oboe/AAudio + C++ DSP) is only justified if measured
  tracking latency blocks the product. It is a separate ADR/product, not this
  packaging path, and it must share the project schema and DSP golden vectors.
- **iOS/Safari** is not covered by this document; the same PWA may install, but
  AudioWorklet/Safari behavior and background audio need their own verification.

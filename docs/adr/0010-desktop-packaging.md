# ADR 0010 — Desktop packaging via a thin Electron shell

Date: 2026-09-18
Status: Accepted

KYX ships as a downloadable Windows app, wrapped by a minimal Electron shell (`desktop/`) around the **unmodified** production `dist/` build. ADR 0001 explicitly carved this out: "Desktop packaging may come later but must not contaminate the core design." This ADR defines the shape that packaging takes.

## Decision

The shell registers a custom `app://` scheme as **standard + secure** (with fetch API and stream support) before app ready, and serves `dist/` at `app://bundle/...` via `protocol.handle`. Because the scheme is standard, every root-absolute URL in the web app — the AudioWorklet bundles (`/core-worklet.js`, `/bitcrusher-worklet.js`, `/fxeq-worklet.js`, `/ultina-worklet.js`, `/ozvena-worklet.js`), the ONNX ranker assets (`/models/...`), curated samples (`/samples/...`) and Vite's `/assets/...` chunks — resolves against the `app://bundle` origin exactly as it does against an https origin. **No source changes are needed in the audio engine, persistence, or worklet loaders.**

`file://` is rejected on purpose: root-absolute fetches resolve to the filesystem root there, and Chromium storage (IndexedDB/localStorage) has no stable origin. The `app://` scheme is secure, so IndexedDB projects, user samples and UI prefs persist under `%APPDATA%/KYX` and survive restarts *and app updates*.

The shell adds exactly four browser-provided affordances:

1. **Permissions** — `media` (microphone) and `midi` are granted silently via the session permission request/check handlers; everything else is denied.
2. **Downloads** — `will-download` bridges the app's anchor-download exports (WAV/MP3/MIDI/project JSON) to a native Save-As dialog.
3. **No service worker** — the PWA precache/update banner is a browser-distribution feature; `KYX_DESKTOP=1` builds `dist/` without the `vite-plugin-pwa` layer (the existing `virtual:pwa-register` stub alias covers the orphaned import), and `initSwUpdate` no-ops off http(s).
4. **Desktop flag** — the sandboxed preload exposes `window.kyxDesktop.isDesktop`, which the app uses to boot straight into the studio (the marketing landing page is a browser first-run experience).

## Consequences

- **One web build, two shells.** The PWA remains the browser distribution; `npm run desktop:build` produces the Windows NSIS installer + portable exe via electron-builder. Packaging never touches `src/` beyond the three tiny guards above.
- **Collab/gallery stay web features.** The desktop build bundles no server; `CollabPanel`'s manual server URL still works for opting in, and the default derivation degrades to a harmless DISCONNECTED badge.
- **Auto-update is deferred** until the web deploy host (and thus an update feed URL) is decided — electron-updater would need that feed.
- **macOS/Linux targets and code signing are deferred**; the electron-builder config takes new targets as a few lines when the time comes.

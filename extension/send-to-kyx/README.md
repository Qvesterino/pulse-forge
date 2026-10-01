# Send to KYX — browser extension

Right-click any audio on the web → **Send to KYX** → the sound lands in your
studio's sample bank (INTENT panel → SAMPLES → 📡 SENT TO KYX → → SAMPLE).
Local-only: bytes go to YOUR collab server's intake endpoint, never to a cloud.

## Install (Chrome/Edge, unpacked)

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this folder (`extension/send-to-kyx`)
3. Start the KYX side: `npm run collab` (port 1234) + the studio open in a tab
4. Optional: right-click the extension icon → Options → set the intake URL
   (default `http://127.0.0.1:1234/api/intake`)

## Use

- Right-click an `<audio>` element, a sound link, or a page → **Send to KYX**
- Badge feedback: `…` working → `✓` delivered → `✗` failed (details in the
  extension console / icon tooltip)
- In the studio: SAMPLES browser shows the 📡 tray → **→ SAMPLE** decodes it
  into your user sample bank (same path as drag-and-drop: playable, persisted,
  BPM-probed)

## Limits

- 6 MB per clip (decoded PCM is 5–10× the file — same budget as the studio
  DropZone)
- The extension fetches with ITS OWN permissions (bypasses page CORS); sites
  that require login/DRM won't yield audio bytes
- The intake FIFO holds the last 50 clips server-side; the studio removes
  entries it imports

## Where the code lives

- Endpoint: `server/collab-server.mjs` (`/api/intake*`, IntakeStore)
- Studio tray: `src/ui/IntakeTray.tsx` + `src/ui/sample-import.ts`

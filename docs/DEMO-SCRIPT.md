# KYX — Competition Demo Script (timed rehearsal)

A 90-second core walkthrough + a 60-second bonus block, rehearsed against the
real UI. Every step below is wired and verified today — nothing aspirational.
Fallbacks for the two things that can go wrong on stage are at the bottom.

## Before you go on stage (checklist)

- [ ] Demo machine: `npm run dev` already up, tab open on the landing page,
      **fresh profile** (so the landing shows: clear `localStorage["pf-onboarded"]`
      or use a guest profile).
- [ ] Audio: speakers/headphones plugged, system volume at ~70 %, no Bluetooth.
- [ ] Close every other app that makes sound (Discord, Spotify, browsers).
- [ ] Do the walkthrough once end-to-end before the audience arrives — the first
      run builds worklets and warms IndexedDB caches.
- [ ] Know your browser: Chromium/Edge is the rehearsed path; Safari works
      (graceful No-Web-Audio screen if the OS blocks audio — see fallbacks).
- [ ] Offline variant (if you demo it): load the app once, then flip the machine
      to airplane mode — the PWA serves itself and audio keeps working.

## Core walkthrough — 90 seconds

**0:00–0:15 — the pitch sentence, then let the landing forge.**
"KYX is a browser DAW: you describe a beat, it makes real audio — fully
offline, nothing leaves your machine."
Type into the landing prompt: `dark phonk beat at 145 with a sliding 808` →
**forge**. The studio opens with the beat already playing material and the
INTENT panel pre-filled (the landing handoff).

**0:15–0:30 — it's a real DAW underneath.**
`SPACE` to play/stop. Point at the step sequencer: 16 steps, swing, per-step
velocity. Click one pad in the drum rack — immediate sound, no loading.

**0:30–0:50 — describe sound changes in words.**
Open the FX panel (topbar `DEV`). In the intent bar under the panel header
type `more space` → Enter. The assistant adds and tunes a Reverb on the drums
in one undo step — say "one Ctrl+Z takes it back, watch:" → `Ctrl+Z` →
`Ctrl+Shift+Z`.
Then the whole-mix route: topbar `INTENT` → `make the bass deeper` → the
production planner re-lands the bass-chain effects. Mention: EN and SK both
work ("bass hlbšie").

**0:50–1:10 — the flagship: reactive dynamics.**
Add **MORPH DYNAMICS** on the master (FX → ✚ ADD FX → flagship row). Push the
PRESSURE macro up — the ring lights with transient/body/texture activity.
Fire morph scene **D (Destroyed)** — the whole engine glides over half a
second. Say: "PRESSURE is one knob driving curated nonlinear mappings — the
sound becomes the modulator."

**1:10–1:30 — deterministic export, the proof of parity.**
EXPORT panel → WAV render. While it renders: "the export uses the same audio
engine as live playback — one engine, two clocks; what you heard is byte-what
you get." Play a few seconds of the rendered file from the downloads list.

## Bonus block — 60 seconds (only if the room wants more)

- **Hum a melody**: HUM panel → hum into the mic → TO BEAT turns it into
  notes on the grid. (Rehearse this one twice — mic permission on a stage
  machine is the riskiest step of the whole demo.)
- **Spectrogram**: open it on the master, flip to M/S view, make a small
  spectral selection and ERASE NOISE. One sentence: "spectral editing in a
  browser."
- **Genres are first-class**: new project → PHONK / DRILL / JERSEY / DNB —
  grooves, kits and mix character swap per genre.
- **Command palette**: `Ctrl+K`, type "bounce" — everything is reachable.

## Fallbacks (know these cold)

1. **No sound on stage** → check the topbar meters. If audio never starts:
   the browser blocked audio — reload the tab, click once, press SPACE
   (autoplay policies need a gesture). If the machine itself is the problem,
   switch to the downloaded desktop build — same project opens in both.
2. **A judge asks "does it work on my Mac?"** → Safari 14.1+ is supported;
   AudioWorklet is the realtime DSP path everywhere; if Web Audio is missing
   or OS-blocked (iOS Low Power Mode), KYX shows an actionable guidance
   screen instead of failing silently. Be honest: live-collab and the gallery
   need the companion server — the DAW itself is fully local.
3. **The live render takes too long on stage** → pattern-length renders are
   seconds; say "same engine, offline clock" and keep talking over it.

## Not in the demo (on purpose)

Collab bandmate sessions and the community gallery need the relay server
running — demo them only if the server is verified on the venue network, or
show the gallery read-only from the deployed site.

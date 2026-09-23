# MOBILE READINESS

> **Cross-platform readiness campaign — GOAL 10 deliverable** (2026-09-22).
> Audit of assumptions that break on Android/iOS tablets and phones, with
> the campaign classification: **already portable / requires UI adaptation
> (fixed where small) / requires native implementation / architecture
> blocker**. Context: KYX is a beat-making DAW — pads + piano roll on a
> tablet is a real primary use-case. Companion: `docs/PORTABILITY_MAP.md`,
> `docs/FAULT-CONTAINMENT.md`.

**Headline: zero architecture blockers.** The audio/lifecycle core already
survives mobile-style suspension, the PWA boots offline, and a large share
of touch sizing existed before this audit. What was missing was touch-drag
hygiene on two main surfaces, right-click-only workflows on iOS, storage
persistence, and constrained-device defaults.

---

## 1. Already portable (verified, do not re-audit)

- **Audio session lifecycle**: context suspension (background/Siri/call) →
  scheduler gates windows and re-anchors on resume with no reload and no
  burst (`getContextState` gate + suspended→running re-anchor);
  `oncontextlost/restored` rebuild the graph; recording interruption stops
  the take to recovery with explicit UX (iOS `interrupted` resume hang is
  bounded by a 10 s timeout). Visible-tab interruptions defer to the
  AudioUnlock "TAP TO ENABLE AUDIO" banner (700 ms poll) — an iOS
  requirement anyway.
- **Background throttle**: 25 ms scheduler interval throttled to ~1 s hidden
  is safe (the gate skips while suspended); meters ride the single shared
  rAF (browser-paused); collab awareness is event-driven.
- **Touch basics already present**: pointer events era, `pointer: coarse`
  sizing in Sequencer/FxEq/ModPanel (22–24 px hit radii, 46 px rows),
  44 px pads with two-finger finger-drumming, long-press menus on the step
  grid/piano-roll notes/pads/sliders, `touch-action: manipulation` global,
  body `user-select: none`, XY pads with inline `touch-action: none`.
- **Rotation/resize**: no fixed-width landmines; Sequencer re-windows on
  `(max-width: 760px)` changes; phones get a bottom sheet + single-column
  workspace + fullscreen piano-roll toggle; dock uses container queries;
  `viewport-fit=cover` + safe-area on floating-plugin surfaces.
- **Offline boot**: worklets + curated samples + shell precached by the SW
  (4 MiB/file cap); synth bank needs no network; prompt SW updates protect
  long sessions.
- **Export on touch**: anchor download with the 5 s Safari-safe revoke;
  > 4 GB RIFF guard fires before the render wastes; video prefers
  > MP4→WebM with graceful unavailability.
- **No hover-gated controls** (~95 `:hover` rules are decoration only); no
  keyboard-gated primary flows; `mousedown` uses are backdrop-closes.

## 2. Requires UI adaptation — FIXED (GOAL 07/10, small and safe)

1. **Piano roll drag/scroll fight** — `.pianoroll-grid/.pr-note/
.pr-velocity-lane/.pr-vel-bar` had no `touch-action`: note and velocity
   drags were hijacked by the roll's scroll. → `touch-action: none` +
   `user-select: none` (children of the scroll — empty space still pans).
2. **Arrangement drag/scroll fight** — `.arr-clip/.arr-audio-clip/.arr-ruler`
   inside the horizontal lane scroll → same fix (lane keeps panning on
   empty space). `.auto-canvas` → `touch-action: none`.
3. **Untouchable targets** — `.pr-note` is 10 px tall, `.pr-vel-bar` 8 px
   wide → invisible inset hit pads via `::before` on coarse pointers
   (pattern already used by `.step-amount-track`).
4. **Notch/home-indicator** — base shell had no safe-area padding (only the
   floating plugin had it) → `.topbar` / `.statusbar` get
   `env(safe-area-inset-*)`.
5. **iOS IndexedDB eviction (~7-day rule)** — `navigator.storage.persist()`
   was never called → best-effort `persist()` at project boot
   (`services.ts`); InstallPrompt copy now carries the data-safety line
   ("your projects stay on this device — installing protects them from
   cleanup"). The prompt itself never fires on iOS Safari (no
   `beforeinstallprompt`) — the copy travels wherever it renders.
6. **118 MB semantic model default-ON on constrained devices** —
   `semanticMode()` now defaults **off** when `navigator.connection.saveData`
   or `deviceMemory ≤ 4`; explicit `pf:semantic-embed=on` still wins.
   Offline/mobile users silently keep the keyword parser (existing fallback).

## 3. Requires UI adaptation — QUEUED (not a redesign, needs a session)

Ranked by lost workflow on touch:

1. **Right-click-only workflows are dead on iOS** (Android long-press fires
   `contextmenu`; iOS never does here): audio-clip menu (reverse/loop/gain/
   spectral edit/warp-pin), delete arrangement clip + markers + automation
   points, piano-roll marquee multi-select (shift/right-drag). The recipe is
   in-repo: `useLongPress` is generic and already powers the step-grid,
   note, pad and slider menus — reuse it on the arrangement clips, ruler
   markers and automation canvases.
2. **Add-marker is shift+click only** — needs a tappable "+ marker" control
   in the arrangement ruler header (calls `addMarker` at the playhead).
3. **Collab offline wording** — `syncPhase` has no UI consumer; the status
   pill shows DISCONNECTED but there is no "offline — edits stay local"
   line for flaky mobile radios (the 8 s degrade + pre-adopt snapshot
   safety net already work).
4. **Diagnostics heap row** is `performance.memory` (Chromium-only, renders
   "?" on Safari) — label it as such; the low-quota warning stays buried in
   the Diagnostics memory tab (acceptable).

## 4. Requires native implementation

- Web MIDI is absent on some iOS versions — feature detection degrades
  silently (correct); BLE-MIDI assumptions: none found.
- True data safety beyond `storage.persist()` (the eviction rule applies to
  Safari tabs; installed PWAs are safer) — the install prompt is the
  mitigation, which iOS never shows → a manual "Add to Home Screen" hint
  for iOS is the queued native-adjacent step.

## 5. Architecture blockers

**None.** No mobile finding requires restructuring; every gap is CSS, a
one-line JS default, or queued UI adaptation.

## 6. Memory notes (mobile-relevant)

Boot residents: synthesized factory bank (eager, 69 assets + RR variants —
deferral candidate), curated layer (lazy ✓), semantic model (118 MB — now
constrained-device-gated ✓), frozen buffers (per-project restore ✓).
`performance.memory` is Chromium-only (see §3.4).

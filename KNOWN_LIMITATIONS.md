# Known Limitations

Honest list of what Pulse Forge does **not** (yet) do, or does with caveats.
Each item notes the practical impact and, where relevant, the intended fix.
Tracked in [`RELEASE_ROADMAP.md`](./RELEASE_ROADMAP.md).

## Export & rendering

- **Scene intensity is scheduled into exports.** Live and offline both resolve
  `source: "intensity"` through the same AudioEngine macro writer. The live
  scheduler is still control-rate driven (25 ms look-ahead), so a scene seam
  can differ from the offline sample-exact timeline by up to one scheduler
  tick; the scene-tempo caveat below describes the same class of boundary
  residual.
- **Scene-tempo timing.** Since the tempo-seam fix, live playback applies a
  scene BPM change within one scheduler tick (≤ 25 ms) of the clip boundary,
  and exports apply it exactly at the boundary. Events within ±25 ms of the
  boundary may therefore differ by a few milliseconds between live and export.
- **Automation near a scene-tempo boundary.** Project automation writes follow
  the tempo map now, but the engine's smoothing window can still straddle a
  boundary by up to one window (~120 ms) during a tempo change.
- **Marker cue one-shots are not part of the master WAV export.** Bounce-zone
  and scorepack exports deliberately exclude them; the master export follows
  the same rule. Live playback does fire them.
- **32-bit float WAV export hard-clips at ±1.0.** The 16/24-bit paths use a
  soft knee + dither; if the limiter is off and the master runs hot, float
  exports can clip where the other formats would not.
- **fxeq "random"-wave LFOs are not seeded.** With a random-wave LFO in the
  fxeq plugin, two exports of the same project can differ slightly (all other
  DSP is deterministically seeded).
- **Offline render of a stage cannot be interrupted.** The CANCEL button stops
  between stages (stems/tracks) and during MP3 encoding or video recording;
  the initial offline render of the current stage runs to completion.
- **Video export for clips shorter than one second** records one second of
  (mostly silent) video — `seconds` is clamped to a 1 s minimum.

## Sound & mixer

- **Group tracks cannot be frozen.** Freeze renders a single track's own
  chain; a group has no generators, so its buffer would be silence. Freeze
  the child tracks instead. Per-track export also skips groups.
- **Sidechain sources outside the rendered selection are silent.** In stems/
  track exports/freeze, a sidechain input coming from an excluded track is
  disconnected (no ducking) rather than pulling the whole source in.
- **Track gain automation range.** Automation and scene lanes can drive track
  gain to 0…2, while the mixer fader and automation catalog clamp to 0…1.5 —
  drawn automation above 1.5 still plays.

## Collaboration

- **Undo is local.** Remote collaborators' edits never enter your undo stack
  (deliberate — CRDT merges cannot be inverted locally). A remote pattern
  switch also does not: undoing past it may leave you in the other scene.
- **Collab session undo history is unbounded.** Very long jam sessions grow
  the in-memory undo stack (yjs has no safe truncation); reload resets it.
- **Custom collab servers are trusted by design.** The server URL entered in
  the collab panel is used as-is (self-hosted relays). `?server=` links are
  restricted to the app's own host.

## Platform

- **AudioWorklet-less environments degrade audibly.** Without worklet support
  the master tape and look-ahead limiter fall back to simpler native nodes —
  quieter, cleaner, but not the same algorithm. All modern Chromium/Firefox/
  Safari builds ship worklets.
- **MIDI clock master output uses timer scheduling.** External gear synced as
  slave may see a few milliseconds of jitter (the internal audio path uses
  sample-accurate look-ahead; MIDI clock cannot).
- **Import size caps.** Audio samples: 25 MB per file; project JSON: 10 MB.
  Larger files are rejected with a clear message instead of risking a tab OOM.
- **Automated testing covers Chromium.** The CI browser suite (197 checks)
  runs in Chromium; Firefox and Safari are smoke-tested manually. iOS Safari
  audio unlock and `pagehide` saving are hardened but not automatically tested.
- **Development dependency advisory.** The esbuild dev-server advisory nested
  under vitest 2 is deferred consciously (dev machines only; production
  bundles use the patched esbuild). See `RELEASE_ROADMAP.md` § 2.5.

## Deferred by decision

- Vitest 5 + Vite 8 migration (see above).
- `bounceStemsToAudioClip` command exists and is tested but has no UI wiring.
- Cancel for offline *renders* (see "Exports" above).

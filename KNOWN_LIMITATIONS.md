# Known Limitations

Honest list of what KYX does **not** (yet) do, or does with caveats.
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
  the same rule. Live playback does fire them. The Export panel shows this
  policy before export and points to SCOREPACK for cue assets and markers.
- **WAV overflow is intentionally soft-kneed, not transparent.** The 24/32-bit
  paths run finite samples through the shared soft-knee policy; the 16-bit path
  quantizes with deterministic dither. This prevents an accidental hard clip,
  but a very hot master is still audibly limited. The limiter remains the
  correct place to control a release mix rather than relying on export repair.
- **Standalone FXEQ callers that omit a seed retain the deterministic fallback.**
  KYX's PRISM host path now derives a stable seed from the project, owner and
  effect identity, so separate instances no longer share the same random S&H
  sequence and live/offline renders agree. Direct/core callers that omit the
  optional seed intentionally keep the legacy fixed sequence for compatibility.
- **Offline render of a stage cannot be interrupted.** The CANCEL button stops
  between master/stem/track stages, between SCOREPACK stages and during MP3
  encoding or video recording; the initial offline render of the current stage
  runs to completion. The Export panel makes this boundary visible before a
  render starts.
- **Very short video export duration is codec/frame-granular.** The exporter
  accepts sub-second ranges down to 10 ms, but MediaRecorder/container timing
  can add a small amount of tail or quantize the final duration to available
  frames. Verify the final file duration for stingers and one-shots. The
  Export panel displays this caveat when VIDEO is selected.

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

### Ultina vendored core (current residual)

The Sculptor sparse-spectrum guard, stereo T/S state isolation, crossover
re-prepare invalidation and Phase Time Shift dry/delta capacity are now fixed
in `D:/VocalForge_DAW/plugins/ultina`, mirrored into
`src/effects/ultina-core/**`, rebuilt into `public/ultina-worklet.js`, and
covered by `tests/ultina-core-hardening.test.ts`. The vendored core remains
locked to the upstream golden vectors (`tests/ultina-vectors.test.ts`).

- **Mix assist / reference match use a dedicated host-side worker.** The
  worker receives copied channel buffers as transferables, keeping the
  editor responsive on long tracks; the UI exposes staged busy text, CANCEL
  and a recoverable error when workers are unavailable. Copying the buffers
  creates a temporary second set of channel storage, and the worker is
  currently one-shot per operation (it is terminated after the result).
  Analysis still uses the upstream v1 simplified K-weighting approximation
  rather than a full BS.1770 implementation, but its integrated estimate now
  uses sample-rate-derived 400 ms blocks. This affects the proposal's level
  heuristic, not UI responsiveness or DSP live/offline parity.

### Ozvena vendored core (known caveats, 2026-09 audit)

The 2026-09 ozvena hardening audit (three rounds) fixed what was safely
fixable in place — user-IR length cap, pre-delay ring-growth continuity and
then prepare-time full-range reservation, `reset()` scalar state, plate-engine
hot-loop allocation, the safety-limiter stale-lookahead replay on quality
switches, true-stereo factory-IR interleaving, and the whole IR-load FFT
pipeline moved off the audio thread: generation AND the per-partition FFT
batch now run on the main thread, and the worklet receives PRECOMPUTED
frequency-domain partitions as transferables
(`precomputeConvolverSpectra` → `loadIrPrecomputed`; bit-identical to the
time-domain path, proven in `tests/ozvena-ir-spectra.test.ts`).
See `tests/ozvena-hardening.test.ts` + `tests/ozvena-worklet-entry.test.ts`.
All reconciled fixes are marked "(Reconciled from Pulse Forge …)" and have
been synced upstream via `scripts/sync-ozvena-upstream.mjs`;
`scripts/vendor-ozvena.mjs` now ABORTS a re-vendor that would silently
drop reconciled markers the upstream snapshot lacks. The remaining caveat is
the bounded memory footprint of the prepare-time delay reservation:

- **Pre-delay reserves its maximum supported range at `prepare()`.** This
  removes runtime ring growth/copy from live delay and tempo changes, at the
  cost of approximately 37 MB for one stereo instance at 48 kHz (about 74 MB
  at 96 kHz and 147 MB at 192 kHz). Multiple high-rate VØID instances should
  therefore be included in device-memory QA before enabling them by default.
- **Factory IR reloads use fresh mutable input rings by design.** Immutable
  main-thread IR spectra are reused, while each worklet delivery receives its
  own write-before-read ring; this prevents cross-instance state sharing and
  avoids cache-hit allocation on the audio thread.

## Collaboration

- **Undo is local.** Remote collaborators' edits never enter your undo stack
  (deliberate — CRDT merges cannot be inverted locally). A remote pattern
  switch also does not: undoing past it may leave you in the other scene.
- **Collab session undo history is unbounded.** Very long jam sessions grow
  the in-memory undo stack (yjs has no safe truncation); reload resets it.
- **Custom collab servers are trusted by design.** The server URL entered in
  the collab panel is used as-is (self-hosted relays). `?server=` links are
  restricted to the app's own host.
- **Production relay configuration is explicit.** The collab server refuses a
  wildcard CORS policy when production-config enforcement is enabled;
  deployments must provide an explicit `CORS_ORIGIN` allowlist and an
  operational moderation token when the public gallery is enabled.

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
- **Automated testing covers Chromium-family browsers.** The browser suite
  runs at 198 checks in Playwright Chromium and also passes against the
  installed Microsoft Edge executable; Firefox and Safari are smoke-tested
  manually. iOS Safari audio unlock and `pagehide` saving are hardened but not
  automatically tested.
- **Development dependency advisory.** The esbuild dev-server advisory nested
  under vitest 2 is deferred consciously (dev machines only; production
  bundles use the patched esbuild). See `RELEASE_ROADMAP.md` § 2.5.

## Deferred by decision

- Vitest 5 + Vite 8 migration (see above).
- `bounceStemsToAudioClip` command exists and is tested but has no UI wiring.
- Cancel for offline _renders_ (see "Exports" above).

## Mod matrix (main-thread fallback vs wtvoice worklet)

- Fallback MORPH route je room-clamped wobble na zachytenom frame páre; worklet posúva pozíciu ±2 páry s wrapom. Semantická (nie bit) parita.
- Fallback AMP route nemá worklet floor `max(0.1, 1+mod)` — pri amount blízko −1 s ENV/LFO plne otvoreným môže stagflux ticho prestáť (fázový flip namiesto flooru).
- Destination DETUNE (2) je rezervovaná a neimplementovaná na oboch cestách (worklet ani fallback); UI možnosť je zatiaľ mŕtva.
- Mod parametre menia bežiace hlasy až od novej noty na fallbacke (worklet číta p per-sample — žije okamžite); PRESS zdroj je živý na oboch.
- Rollout na ďalšie syntetizátory (keys, pluck, 808, texture, logdrum, spectral, granular, vocalchop, sampler) je mechanický cez `modMatrixParams(false)` + `scheduleVoiceModMatrix` — pozri `scratch/modmatrix-check.mjs` ako overovaciu šablónu.

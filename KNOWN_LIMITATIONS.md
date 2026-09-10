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
  the same rule. Live playback does fire them.
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
  between stages (stems/tracks) and during MP3 encoding or video recording;
  the initial offline render of the current stage runs to completion.
- **Very short video export duration is codec/frame-granular.** The exporter
  accepts sub-second ranges down to 10 ms, but MediaRecorder/container timing
  can add a small amount of tail or quantize the final duration to available
  frames. Verify the final file duration for stingers and one-shots.

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

- **Mix assist / reference match analyze the whole song synchronously on the
  main thread.** `featureExtractor` walks the full rendered buffer (5 typed-
  array allocations per 1024-sample hop) in one blocking call — a multi-
  second freeze plus GC churn on long tracks. The same file computes
  "integrated LUFS" from 40 %-of-buffer blocks instead of 400 ms blocks, so
  the INSUFFICIENT_LEVEL rule's input-gain proposal runs off a rough
  estimate. Upstream fix: chunk the analysis (or move it to a worker) and
  derive the loudness blocks from the sample rate.

### Ozvena vendored core (known caveats, 2026-09 audit)

The 2026-09 ozvena hardening audit (three rounds) fixed what was safely
fixable in place — user-IR length cap, pre-delay ring-growth continuity
(with the growth copy bounded by the reachable read distance), `reset()`
scalar state, plate-engine hot-loop allocation, the safety-limiter
stale-lookahead replay on quality switches, and the whole IR-load FFT
pipeline moved off the audio thread: generation AND the per-partition FFT
batch now run on the main thread, and the worklet receives PRECOMPUTED
frequency-domain partitions as transferables
(`precomputeConvolverSpectra` → `loadIrPrecomputed`; bit-identical to the
time-domain path, proven in `tests/ozvena-ir-spectra.test.ts`).
See `tests/ozvena-hardening.test.ts` + `tests/ozvena-worklet-entry.test.ts`.
All reconciled fixes are marked "(Reconciled from Pulse Forge …)" and have
been synced upstream via `scripts/sync-ozvena-upstream.mjs`;
`scripts/vendor-ozvena.mjs` now ABORTS a re-vendor that would silently
drop reconciled markers the upstream snapshot lacks. These remain:

- **Re-loading a cached factory IR allocates its input-block spectra ring
  on the audio thread.** The convolver's mutable input-block ring is
  handed over once per delivery; cache-hit re-selections (and second
  instances sharing the worklet cache) allocate a fresh zeroed ring
  instead — up to ~1 ms for a 3 s IR, once per load, below one render
  quantum for typical IRs. The ring is write-before-read, so any initial
  content is correct.
- **Pre-delay ring growth still allocates on the audio thread.** Delay-time
  sweeps that cross a power-of-two capacity boundary zero + allocate the
  new ring in the message handler. The history copy is bounded by the
  reachable read distance (a 10→400 ms sweep copies ≤ ~19 k samples), and
  the whole pass stays well under one render quantum for the documented
  0–500 ms range; only extreme tempo-synced delays (many seconds) pay a
  ms-scale one-time cost.

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
- Cancel for offline _renders_ (see "Exports" above).

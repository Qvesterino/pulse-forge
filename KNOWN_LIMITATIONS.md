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

### Ultina vendored core (upstream defects, fix in VocalForge_DAW then re-vendor)

Verified during the 2026-09 ultina hardening audit. The vendored core is a
byte-faithful copy locked to the upstream golden vectors
(`tests/ultina-vectors.test.ts`), so these must be fixed upstream in
`VocalForge_DAW/plugins/ultina` and re-vendored via
`scripts/vendor-ultina.mjs` — not patched here.

- **Sculptor drags every active band down when any band is silent.** The
  per-band average level includes silent bands at their −200 dB floor while
  the per-band correction skips them (`sculptorModule.ts`, avg loop vs the
  `envFollowers[b] < 1e-6` skip). A source with an empty high band (bass,
  low-passed material) inside the sculptor boundaries pulls `avgDb` so low
  that all active bands clamp to the maximum −12 dB cut. Upstream fix: skip
  silent bands in the average as well.
- **Transient/Sustain stereo mode leaks L into R.** The stereo T/S path runs
  both channels through `processBands` with a single-channel view, so both
  filter through the same biquad state slot — L's ringing tail seeds R's
  filtering every block (`multiband.ts` splitLr4 cascades loop on
  `channelCount` instead of the active `chCount`). Block-rate inter-channel
  crosstalk in every multiband module's T/S mode with 2+ bands. The same
  loop also keeps filtering stale channel-1 work buffers in M/S passes
  (wasted CPU, no output effect).
- **Re-preparing an existing Ultina instance resets the LR4 crossover to
  identity.** `CrossoverNetwork.prepare` rebuilds its biquads as passthrough
  and the modules' cached band/crossover values skip the redesign, so bands
  stop separating and sum to +6/+9.5 dB until a crossover knob moves. No
  Pulse Forge code path re-prepares a live instance today (each
  AudioWorkletNode prepares once); latent for any host that re-prepares on
  sample-rate changes. Upstream fix: invalidate the crossover caches in each
  module's `prepare()` (the hybrid FIR path already does this).
- **Phase Time Shift beyond ~4 ms mis-compensates mix/delta.** The module's
  dry/wet compensation ring is sized `maxBlockSize + 64` samples while the
  Time Shift parameter allows ±50 ms, so the dry copy is clamped far short
  of the wet delay (`dryDelay.ts` prepare vs `phaseModule`'s 50 ms buffer).
  At mix < 100 % or in delta listen, shifts past the ring size comb against
  a wrongly delayed dry copy. Upstream fix: prepare the mixer with the
  module's full 50 ms delay budget.
- **Mix assist / reference match analyze the whole song synchronously on the
  main thread.** `featureExtractor` walks the full rendered buffer (5 typed-
  array allocations per 1024-sample hop) in one blocking call — a multi-
  second freeze plus GC churn on long tracks. The same file computes
  "integrated LUFS" from 40 %-of-buffer blocks instead of 400 ms blocks, so
  the INSUFFICIENT_LEVEL rule's input-gain proposal runs off a rough
  estimate. Upstream fix: chunk the analysis (or move it to a worker) and
  derive the loudness blocks from the sample rate.

### Ozvena vendored core (known caveats, 2026-09 audit)

The 2026-09 ozvena hardening audit fixed what was safely fixable in place
(user-IR length cap, pre-delay ring-growth continuity, `reset()` scalar
state, plate-engine hot-loop allocation — see `tests/ozvena-hardening.test.ts`).
These remain, all inside the vendored core, so fix upstream in
`VocalForge_DAW/plugins/ozvena` and re-vendor via `scripts/vendor-ozvena.mjs`
(the audit's reconciled edits would be overwritten by a blind re-vendor —
sync them upstream first):

- **First selection of each factory IR runs on the audio thread.** Picking a
  factory convolution IR generates it (up to 3 s × 4 channels at the host
  rate) plus the partition FFTs inside the worklet's message handler — a
  few-millisecond dropout risk exactly once per (IR, sample rate); cached
  afterwards (bounded cache, 24 entries). Upstream fix: pre-generate on the
  main thread and post the IR as a transferable.
- **Safety-limiter quality switches replay ≤ 2 ms of stale lookahead audio.**
  `setOversampleFactor` swaps to a preallocated channel set whose ring still
  holds audio from when that factor was last active; the lookahead window
  (2 ms) can re-emit a sliver of it. Zeroing the ring on switch was
  deliberately avoided (~0.5 MB alloc/zero on the audio thread); upstream
  fix would be a stale-flag that mutes the first lookahead window instead.
- **Pre-delay ring growth still allocates on the audio thread.** Delay-time
  sweeps that cross a power-of-two capacity boundary allocate + copy the
  ring in the message handler (bounded, history-preserving since the audit;
  a full 0→500 ms sweep triggers ~6 grows).

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

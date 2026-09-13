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
  currently contains 218 checks in Playwright Chromium and has also passed
  against the installed Microsoft Edge executable; the latest current-worktree
  rerun was 217/218 because one `.preset-browser` bootstrap selector timed out.
  Firefox and Safari are smoke-tested manually. iOS Safari audio unlock and
  `pagehide` saving are hardened but not automatically tested.
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
- Rollout je dokončený (analog, bass, keys, pluck, 808, texture, logdrum, spectral, sampler, vocalchop + wavetable). **Granular je zámerne vynechaný** — jeho modulačný príbeh tvoria vlastné POSITION/SCAN/JITTER/RATE parametre a voice-worklet nemá mod routy.
- PRESS zdroj žije len na nástrojoch s `polyPressure`: na 808 (monofónny), texture a vocalchop zostáva PRESS zdroj na 0, kým ich polyPressure nepridá.
- Vocalchop neponúka CUTOFF cieľ (formant banka nemá per-voice lowpass) — dst options sú OFF/AMP.

## Granular voice worklet (live playhead)

- Offline rendre prichádzajú port messages do workletu až PO rendri — inicializácia (sample/params/bpm) preto ide cez `processorOptions` a render musí mať medzi engine sync a `startRendering()` aspoň jeden task-turn (reálny renderer ich má; testy pridávajú 60 ms yield).
- Live zmeny POSITION/SCAN/JITTER/RATE/SIZE počas noty fungujú len na worklete; fallback cloud ich berie od novej noty (zostáva deterministický upfront scheduler).
- AMP envelope vo worklete je one-pole aproximácia fallback exponentialRamp/`setTargetAtTime` krivky — zvukovo takmer identický, nie bit-identický s fallback cloudom (nový engine, nie parity fork).

## Environment-citlivé QA checky (2026-09)

- **Prism determinizmus (`maxDiff < 1e-4`)** a **fxeq morph gate (`< 2.4×`)** a **render budgety** sú
  validné, ale margínovo citlivé na súčasnú záťaž stroja: pri CPU ~100 % (paralelné sessiony/buildy)
  prism maxDiff kolíše 7e-7…1.1e-4 a morph ratio 2.18–2.58×. Na pokojnom stroji všetky prechádzajú
  (217/217, Sep 2026). Ak niečo z toho padne: re-run solo/na pokojnom stroji pred akýmkoľvek
  "fixovaním" — výsledky pod záťažou nie sú regresný signál.
- Budgety zámerne NEslabujeme kvôli záťažovým flakeom — to by skrylo reálne regresie.
- **2026-09-12 stabilizácia (mierou, nie oslabením):** tri absolute-time gaty prešli na
  load-imúnne meranie bez zmeny prahov sledovaného javu —
  (1) ultina vitest "audio budget" je teraz **ratio gate** (hq full-graph vs passthrough
  baseline meraná v tom istom procese, best-of-3 mediany; kalibrácia: idle 18.5×, 6-hog
  CPU oversubscription 34.7×, budget 40×) — starý absolútny `< 5 ms` flakoval na 10.5 ms
  pri paralelnej záťaži pričom idle meria ~0.3 ms; nový gate prešiel idle aj pod 6-hog
  záťažou a chytá ≥2.2× regresiu loaded pathy (starý mal chytať "10×+");
  (2) browser-check `fxeq: CPU budget` a (3) `ultina: CPU budget` používajú **min-of-3
  samplov** namiesto medianu/jedného okna — cena DSP je dolne ohraničená, šum (preemption)
  len približuje, takže najmenej narušený vzor je najlepší odhad skutočnej ceny
  (Firefox 2026-09-12: zdravý 1413 µs sample pohrebný dvoma záťažovými 3268/3332 µs →
  falošný FAIL medianom). Prahy (2902 µs, resp. 60 % pre ultinu) zostávajú nezmenené.

## Kontrolný audit ultina-core (2026-09-13, druhý priechod)

- **DSP-inertné schémové parametre (vendor-rezervované):**
  `comp.autoLearnThreshold`, `transient.crossoverLearn` a
  `clipper.crossoverLearn` nikto v DSP nečíta — ani upstream VocalForge
  (overené grepom). Sú to rezervy vendor schémy; ich implementácia patrí
  samostatnému upstream DSP návrhu.
- **Pre-Emphasis už nie je inertný:** `exciter.preEmphasisMode` je od
  `173f5ce` implementovaný v upstream zrkadle aj vo vendored worklete. Hodnota
  0 zostáva `flat`/no-op kvôli spätnej kompatibilite, hodnoty 1..3 sú zámerne
  počuteľné a menia existujúce presety, ktoré mali uloženú nenulovú hodnotu.
  Matching source/test commit je `D:/VocalForge_DAW:c0a549d`; lokálny vendor
  script dirty source defaultne odmietne.
- **Zámerne NEopravené (produktové rozhodnutia, nie defekty):** manuálny dotyček parametra
  nepreberá už-DUE automation eventy v rovnakom quantume (preberie až budúce; samo sa
  opraví ďalším dragom — Web Audio "scheduled event wins" flavor); EQ LEARN APPLY robí
  4 samostatné undo kroky namiesto 1 (ostatné assistant gesty sú 1-krokové);
  `effectProcessorStatus` hlási "ok" aj pre bypassnutý flagship (bez konzumenta dnes).
- **Opravené v tomto priechode:** duplicitné meno "Vocal Warmth" (EQ + density) spôsobovalo,
  že panel vždy aplikoval EQ verziu — lookup teraz beží podľa preset ID; meters cadence
  je rate-derived (~20 Hz aj na 96/192 kHz, predtým ~47/94 Hz); automation queue má cap
  4096 (patologické `when=1e300` držal v rade navždy) vo všetkých troch entry; input-copy
  fallback krátkeho vstupu fill-uje nulou namiesto kopírovania hlavy (duplex audio do
  neskorších chunkov); `validateState` clampuje hodnoty podľa vlastnej hlavičky;
  `extractFeatures` odmieta sampleRate <= 0/NaN (kompletná kontaminácia analýzy + ~200 MB
  akumulátor pre 10-min buffer). Všetko zmirrorované do upstreamu.

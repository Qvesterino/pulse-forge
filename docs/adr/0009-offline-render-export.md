# ADR 0009 — Offline rendering, master chain and export

Date: 2026-08-15
Status: Accepted

**Shared engine for export.** Offline rendering reuses the exact `AudioEngine` that drives realtime playback. The engine accepts any `BaseAudioContext` via `useContext(ctx)`, so the renderer hands it an `OfflineAudioContext` and the identical graph (tracks, inserts, instruments, returns, sends, automation, LFOs, macros, master chain) is built. Only the event driver differs: instead of the realtime lookahead scheduler, the renderer pre-schedules every drum step, note and automation event deterministically before calling `startRendering()`. This is the single guarantee that an export sounds exactly like the project — there is no separate "render DSP".

**Deterministic scheduling.** Because `OfflineAudioContext` renders in one async burst (no event loop ticks), events cannot be scheduled incrementally. The renderer computes the full timeline in tick space: pattern mode = one active-pattern pass; song mode = each arrangement clip mapped to its scene's pattern (short patterns loop inside longer clips). Automation is applied as exact `linearRampToValueAtTime` for track volume/pan and as timed `setParameterAt` for effect/instrument params (added to both runtime interfaces for this purpose).

**Master chain.** `gain → soft-clipper → limiter → analyser`. The limiter is a glue-style `DynamicsCompressorNode` (transparent safety, not a brick-wall); the clipper is a tanh soft-clipper that provides the true ceiling. Both are toggleable and bypass by neutral settings (ratio 1 / null curve), never by graph rewiring — so toggling is click-free and render-safe. This follows the mastering philosophy in `VISION.md`: honest, transparent processors rather than a fake one-button master.

**Stems.** Grouped stems (Drums / Bass / Music) render from filtered copies of the project with solo disabled, so stems sum predictably. A one-stem-per-track mode is also provided.

**WAV.** A hand-written RIFF/WAVE encoder emits 16/24-bit PCM and 32-bit float; header layout and interleaving are covered by unit tests, and end-to-end render→encode is covered by the browser checks.

Consequence: export is a pure function of the project document + sample bank, so future formats (stem-per-bus, MP3, score packages) reuse the same renderer without touching the realtime path.

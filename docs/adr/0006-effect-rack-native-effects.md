# ADR 0006 — Effect rack and native effect runtimes

Date: 2026-08-15
Status: Accepted

Effects are pure data in the project model (`EffectInstance` on each track) and runtimes in the audio engine. A registry maps `EffectType` to an `EffectDefinition` (parameter metadata + factory). The engine diffs the serializable effect list against the live chain: structural changes (add/remove/reorder) rebuild runtimes; parameter tweaks are applied via `setParameter` with audio-rate smoothing. Phase-sensitive and tempo-sensitive runtimes (Pump) receive `syncBpm` and `onTransportStarted(beatPhase)` hooks.

> **Amended by ADR 0068 (2026-10-26) — bypass is no longer a structural change.** The paragraph
> above originally listed _bypass_ among the structural changes. A bypassed effect now **stays** in
> the chain and in the signature; the bypass is a wet/dry crossfade — a parameter write, not a
> rebuild — so toggling one insert no longer disposes and re-creates every other runtime on the
> track. See `docs/adr/0068-bypass-is-a-parameter-write.md` (performance-cliff finding **C-5**).

All first seven effects (EQ, Compressor, Saturation, Clipper, Reverb, Delay, Pump) use native Web Audio nodes — no AudioWorklet is required yet. Verification runs real offline renders in headless Chromium (`npm run test:browser`), which is also the harness for future golden audio tests.

Consequence: factories accept `BaseAudioContext`, so the same runtimes will work inside a future OfflineAudioContext export path unchanged.

# ADR 0006 — Effect rack and native effect runtimes

Date: 2026-08-15
Status: Accepted

Effects are pure data in the project model (`EffectInstance` on each track) and runtimes in the audio engine. A registry maps `EffectType` to an `EffectDefinition` (parameter metadata + factory). The engine diffs the serializable effect list against the live chain: structural changes (add/remove/reorder/bypass) rebuild runtimes; parameter tweaks are applied via `setParameter` with audio-rate smoothing. Phase-sensitive and tempo-sensitive runtimes (Pump) receive `syncBpm` and `onTransportStarted(beatPhase)` hooks.

All first seven effects (EQ, Compressor, Saturation, Clipper, Reverb, Delay, Pump) use native Web Audio nodes — no AudioWorklet is required yet. Verification runs real offline renders in headless Chromium (`npm run test:browser`), which is also the harness for future golden audio tests.

Consequence: factories accept `BaseAudioContext`, so the same runtimes will work inside a future OfflineAudioContext export path unchanged.

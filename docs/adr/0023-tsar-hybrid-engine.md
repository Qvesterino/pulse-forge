# ADR 0023 — TSAR hybrid sample+synthesis engine

**Status:** accepted; implemented in TSAR T0–T7 · **Date:** 2026-10-07
**Companions:** `docs/TSAR-ROADMAP.md`, `docs/TSAR-PRODUCT-DIRECTION.md`, ADR 0004 (AudioWorklet boundary), ADR 0003 (project model ↔ runtime)

## Context

KYX ships 22 verified instruments (docs/INSTRUMENT-VERIFICATION-2026-10-03.md)
but none is a destination instrument. The pieces for a hybrid engine exist:
`wtvoice-processor.js` proves per-sample voice DSP in an AudioWorklet,
`extractWavetable` converts any sample into a mipmapped wavetable,
`autoMapVelocityLayers` and `trackPitch` cover sample mapping and root
detection, and `modmatrix.ts` defines the shared modulation contract.

Two constraints shape the design:

1. **Live ↔ offline parity (invariant #3).** `wtvoice` deliberately uses a
   native Web Audio fallback offline because Chromium does not pump worklet
   message queues during `OfflineAudioContext` renders — but a fallback would
   make an export sound DIFFERENT from live. For a flagship engine that is
   not acceptable.
2. **Boot cost.** `ensureWorkletsForDoc` loads only plugin EFFECT modules on
   demand; instrument worklets live in the boot core bundle. A ~160 KB TSAR
   worklet must not inflate every boot.

## Decision

1. **TSAR is a per-sample AudioWorklet engine.** The wrapper is
   `src/tsar-worklet.entry.js`; the typed first-party DSP core is
   `src/tsar/dsp/tsarProcessor.ts` (the `morph-dynamics-core` pattern).
   No main-thread graph for the voice path.
2. **Offline parity via a pre-seeded event queue.** The renderer knows every
   note before `startRendering()`; the runtime buffers note/param events and,
   in `prepareOfflineRender()`, creates the worklet node with
   `processorOptions.events`. The worklet interprets port messages and the
   seeded queue through ONE `applyEvent` path. Live = port, offline = queue,
   identical DSP.
3. **Dual-source patch, no multitimbral.** One track = Source A + Source B +
   Sub + Noise. Layers across tracks use existing group tracks. TSAR adds an
   optional `sampleIdB` on `InstrumentTrack`; it was introduced in schema
   v13. Later schema increments belong to unrelated project changes.
4. **Lazy worklet load.** A `TSAR_WORKLET_TYPES` / instrument-worklet path
   mirrors the plugin-effect lazy loader; projects without a TSAR track never
   fetch `public/tsar-worklet.js`.
5. **Forge decisions are deterministic DSP**, not ML: pitch via the shared
   tracker, character via attack/sustain + periodicity. Unmeasurable input
   yields an explicit "unknown" — never an invented root.

## Consequences

- The offline event queue can later be generalized to `wtvoice`/`grainVoice`
  (separate wave + ADR amendment).
- `renderProject` preloads the TSAR instrument worklet for projects that use it.
- The TSAR worklet is measured at about 22 KB; its bundle budget is 48 KB.
- TSAR is the 23rd registered instrument. Current counts live in
  `docs/CURRENT-STATE.md`.

## Alternatives considered

- **Native-graph engine with scheduled params** — cannot express per-sample
  mod matrix or morph without hundreds of nodes per voice; rejected.
- **Offline fallback (wtvoice pattern)** — violates live↔offline parity for
  the flagship; rejected.
- **8-part multitimbral in v1** — large schema/UI cost; deferred behind a
  future ADR.

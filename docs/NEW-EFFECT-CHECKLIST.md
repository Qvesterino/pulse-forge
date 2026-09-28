# New Effect / Instrument Checklist

Mandatory review list for anyone adding an internal effect or instrument.
Every item on this list exists because the audit
(`docs/PLUGIN-AUDIT-2026-09-27.md` + `docs/plugin-audit-instrument-params.md`)
found a shipped bug of exactly this shape. "It renders sound" is not on the
list — that was never the failure mode.

## The five ways a parameter goes silently dead

Every "the knob moves but nothing happens" bug we shipped was one of these.
Check each before merging:

1. **Blanket disconnect** — a cleanup/reconnect helper calls
   `node.disconnect()` on a chain node and also severs the _internal_
   sub-path links. Phaser's wet chain was silent for its whole life because
   `connectStages()` reconnected inputs/outputs but not
   `stages[i] → stages[i+1]`. After any disconnect, relink every internal
   edge — including the ones built in a different helper.
2. **Stop callback cancels the scheduled release** — voice-manager
   `stop(when)` callbacks that `cancelScheduledValues(t)` + hard-gate
   (`setTargetAtTime(0.0001, t, 0.01)`) wipe the release envelope the noteOn
   scheduled. The RELEASE knob then works only when the note self-releases.
   Make the stop release-aware: tau = `release / 4` (or your spec's
   `releaseTauDiv`), node stops at `t + release * 3 + 0.1`. (Eleven synths
   shipped this; fixed 2026-09-27.)
3. **Dual-scale parameter without a registered bridge** — the document
   stores 0..1, the DSP wants percent (or dB vs linear gain). Register the
   crossing in `src/effects/scale-bridges.ts` and let the coherence test
   check it; an unregistered dual-domain param WILL get clamped or
   automated on the wrong scale (ultina `global.mix` shipped this).
4. **Per-sample constant applied per-block** — a smoothing blend like
   `1 - exp(-1 / (tc * sr))` is a per-_sample_ coefficient. If you apply it
   once per 128-sample block, the time constant inflates by the block
   length (vowel/svfilter glides ran ~100× slow). Use
   `1 - exp(-blockLen / (tc * sr))` for block-rate application.
   Related trap: **flush the recursive state BEFORE storing it** — a
   denormal guard that flushes `toneOut` _after_ `y1 = toneOut` leaves
   subnormals living in the filter state, taxing every following sample
   (multitap shipped this; caught by its soak,
   `tests/multitap-soak.test.ts`).
5. **Port messages are not delivered during OfflineAudioContext renders** —
   Chromium does not pump processor message queues mid-render. Event-queue
   worklets (noteOn/noteOff via `postMessage`) render SILENT offline
   (wavetable/granular shipped this). Either schedule everything up front
   in `processorOptions` + construction-time state, or gate the worklet
   path behind `!offlineRenderContext(ctx)` (see
   `src/instruments/registry.ts`) so offline uses the native graph.

## QA obligations (the harnesses that must run your path)

6. **Worklet-loaded probe** — any check that constructs its own
   `OfflineAudioContext` must call `loadAllWorklets(ctx)` (or explicitly
   document that it measures the native fallback). The loudness map
   measured fallbacks for years and never noticed the worklet paths were
   broken.
7. **Live-path gate for port-message DSP** — offline determinism checks
   don't cover live worklet delivery. If your effect/instrument consumes
   port messages, add a real-`AudioContext` + `AnalyserNode` audibility
   check (pattern: "live worklet-path audibility" in
   `src/browser-checks.ts`).
8. **noteOff in the sweep** — envelope/release parameters are invisible to
   a probe that never sends noteOff (release window 0.42–0.70 s after a
   0.05 s noteOn/0.40 s off). Conversely, skip noteOff for percussive
   one-shots — an explicit noteOff chokes their decay through the stop
   gate (808 decay was invisible for this reason).

## Determinism contract

9. **Random DSP seeds derive from persisted ids** via `hashString`
   (`doc.id|ownerId|fx.id|fx-dsp-v1`). Don't change `hashString`, the
   formula, or id prefixes without reading
   `tests/seed-stability.test.ts` — a change re-rolls the random DSP of
   every saved project (vinyl crackle, sampler spreads, granular grains).
10. **Two-variant alternation check** — render the same doc (or chain)
    three times; consecutive renders must be sample-identical. A ping-pong
    (r1==r3 ≠ r2) is a render-path defect (see the native DelayNode cycle
    history); a one-way step is environment noise (HMR on a shared dev
    machine).

## Registration surface

11. **Every id appears on all five surfaces**: `EffectType`/`InstrumentKind`
    union, the meta record (`EFFECT_META`/`INSTRUMENT_META`), the order
    array (`EFFECT_ORDER`/`INSTRUMENT_ORDER`), the engine dispatch, and the
    worklet loader (`CORE_TYPES` + bundle import in
    `scripts/build-core-worklets.mjs` if DSP is in a worklet). A missing
    entry on any surface means undiscoverable, unautomatable, or
    unserializable.
12. **Rebuild the bundle** — worklet DSP edits are invisible until
    `npm run build:core-worklets` (or the matching per-plugin build) runs.
    The audit measures the bundle, not your source file.
13. **Update `docs/CURRENT-STATE.md` counts** in the same commit, and add
    at least one per-parameter responsiveness assertion (the audit sweep
    in `src/plugin-audit-checks.ts` is the template — min AND max must move
    a measured metric; a peak > 0 check proves nothing, phaser shipped a
    full-spectrum "peak > 0" pass while its wet chain was silent).

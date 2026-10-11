/**
 * PORTAL — audit-facing source entry for the `portal` processor.
 *
 * The processor itself lives with its DSP, in
 * `src/effects/spectral-worklet.entry.js`, and that file is also the esbuild
 * entry point for `public/spectral-worklet.js` (see
 * `scripts/build-spectral-worklet.mjs`). That split is deliberate: the DSP is
 * typed TypeScript under `spectral-core/`, while everything else in this
 * directory is plain-JS processors.
 *
 * This file exists so the repository's audit tooling - which discovers
 * processors by importing `src/audio-worklets/<name>-processor.js` and reading
 * the `parameterDescriptors` the module registers - can reach PORTAL without
 * knowing about the `src/effects/` entry. `tests/param-range-coherence.test.ts`
 * uses it to pin every descriptor range against `EFFECT_META.portal`, and
 * `tests/spectral-worklet-params.test.ts` uses it to prove the AudioParam
 * surface actually reaches the DSP.
 *
 * It adds no behaviour: the `registerProcessor("portal", ...)` call happens in
 * the imported module, which is exactly what the bundle does too.
 */
import "../effects/spectral-worklet.entry.js";

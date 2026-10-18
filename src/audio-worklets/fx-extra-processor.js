/**
 * KYX on-demand "FX extras" AudioWorklet bundle.
 *
 * These effects are useful but not part of the everyday EQ/comp/delay/reverb
 * chain, and together they are the largest optional block in the old core
 * bundle. They load as ONE module the first time a project references any of
 * them (`LAZY_WORKLET_TYPES` → `fxExtras` group in loader.ts), so a beat that
 * never uses a vocoder/pitch/tape effect does not download or parse them at
 * studio startup.
 *
 * The processors gate themselves through `isWorkletReady(type, ctx)` in
 * `EFFECT_DEFS`; until this module lands the runtime keeps the honest bypass
 * and the engine hot-swaps the real chain after `addModule` resolves.
 */
import "./beatmangler-processor.js";
import "./freqshifter-processor.js";
import "./granularfreeze-processor.js";
import "./pitchcorrect-processor.js";
import "./pitchshift-processor.js";
import "./reverseswell-processor.js";
import "./stutter-processor.js";
import "./tapestop-processor.js";
import "./vinyl-processor.js";
import "./vocoder-processor.js";
import "./wowflutter-processor.js";

/**
 * GROW AudioWorklet entry — bundled by
 * scripts/build-bass-harmonic-worklet.mjs into a single classic-script file
 * (public/bass-harmonic-worklet.js) that the loader feeds to
 * AudioWorklet.addModule() on demand (LAZY_WORKLET_TYPES).
 *
 * Thin wrapper: ALL DSP lives in bass-harmonic-processor.js (plain JS,
 * house pattern for lazy effect bundles). This file exists so the build
 * script has a stable, documented entry point.
 */
import "./bass-harmonic-processor.js";

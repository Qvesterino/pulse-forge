/**
 * TWIST AudioWorklet entry — bundled by scripts/build-skrutka-worklet.mjs
 * into a single classic-script file (public/skrutka-worklet.js) that the
 * loader feeds to AudioWorklet.addModule() on demand (LAZY_WORKLET_TYPES).
 *
 * Thin wrapper: ALL DSP lives in skrutka-processor.js (plain JS, house
 * pattern for lazy effect bundles). This file exists so the build script has
 * a stable, documented entry point.
 */
import "./skrutka-processor.js";

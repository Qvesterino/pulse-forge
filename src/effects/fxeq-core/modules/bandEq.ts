// ═══════════════════════════════════════════════════════════
// FXEQ — Band equalizer module (quality roadmap Q3)
//
// Per-band parametric EQ at the HEAD of the module chain
// (eq → sat → dyn → lofi → mod → delay → rev): one low shelf,
// two peaking bands, one high shelf. Fills the "EQ" promise of
// the plugin name — the paint editor can now shape tone per band,
// not just drive creative effects.
//
// Zero-latency IIR (RBJ cookbook sections on the shared biquad
// primitive). Coefficients are retuned only when a parameter
// changes (dirty flag) — never per block. enabled = 0 (the
// default) makes process() a true no-op, so every existing preset
// and golden fixture renders bit-identically.
// ═══════════════════════════════════════════════════════════

import type { FxEqParamDef, ModuleProcessor } from "../dsp/types.js";
import {
  type BiquadState,
  createBiquad,
  setLowShelf,
  setPeaking,
  setHighShelf,
  resetBiquad,
  processBiquad,
} from "../dsp/biquad.js";
import { createParamStore } from "./moduleHelpers.js";
import { assertAudioBlock } from "../dsp/audioBlockContract.js";

export const BANDEQ_TYPE_ID = "bandEq";

const PARAM_DEFS: readonly FxEqParamDef[] = [
  { id: "enabled", name: "Enabled", defaultValue: 0, minValue: 0, maxValue: 1, automatable: false },
  { id: "lowFreq", name: "Low Freq", defaultValue: 120, minValue: 20, maxValue: 500, unit: "Hz", logScale: true, automatable: true },
  { id: "lowGainDb", name: "Low Gain", defaultValue: 0, minValue: -24, maxValue: 24, unit: "dB", automatable: true },
  { id: "peak1Freq", name: "Peak 1 Freq", defaultValue: 800, minValue: 200, maxValue: 5000, unit: "Hz", logScale: true, automatable: true },
  { id: "peak1GainDb", name: "Peak 1 Gain", defaultValue: 0, minValue: -24, maxValue: 24, unit: "dB", automatable: true },
  { id: "peak1Q", name: "Peak 1 Q", defaultValue: 0.7, minValue: 0.1, maxValue: 10, automatable: true },
  { id: "peak2Freq", name: "Peak 2 Freq", defaultValue: 3500, minValue: 1000, maxValue: 18000, unit: "Hz", logScale: true, automatable: true },
  { id: "peak2GainDb", name: "Peak 2 Gain", defaultValue: 0, minValue: -24, maxValue: 24, unit: "dB", automatable: true },
  { id: "peak2Q", name: "Peak 2 Q", defaultValue: 0.7, minValue: 0.1, maxValue: 10, automatable: true },
  { id: "highFreq", name: "High Freq", defaultValue: 8000, minValue: 2000, maxValue: 20000, unit: "Hz", logScale: true, automatable: true },
  { id: "highGainDb", name: "High Gain", defaultValue: 0, minValue: -24, maxValue: 24, unit: "dB", automatable: true },
] as const;

/** Filter order inside the chain: shelf → peak → peak → shelf. */
const FILTERS_PER_CHANNEL = 4;

export function createBandEqModule(params?: Record<string, number>): ModuleProcessor {
  const store = createParamStore(PARAM_DEFS, params);
  let prepared = false;
  let sampleRate = 44100;
  let preparedMaxBlockSize = 1;
  /** One BiquadState per filter; each carries per-channel state arrays. */
  let filters: BiquadState[] = [];
  let dirty = false;

  function retune(): void {
    setLowShelf(filters[0].coeffs, store.get("lowFreq"), store.get("lowGainDb"), sampleRate);
    setPeaking(
      filters[1].coeffs,
      store.get("peak1Freq"),
      store.get("peak1Q"),
      store.get("peak1GainDb"),
      sampleRate,
    );
    setPeaking(
      filters[2].coeffs,
      store.get("peak2Freq"),
      store.get("peak2Q"),
      store.get("peak2GainDb"),
      sampleRate,
    );
    setHighShelf(filters[3].coeffs, store.get("highFreq"), store.get("highGainDb"), sampleRate);
  }

  return {
    get typeId() {
      return BANDEQ_TYPE_ID;
    },
    get parameterDefs() {
      return PARAM_DEFS;
    },

    prepare(sr, channelCount, maxBlockSize) {
      sampleRate = sr;
      preparedMaxBlockSize = Math.max(1, maxBlockSize);
      const cc = Math.max(1, channelCount);
      filters = Array.from({ length: FILTERS_PER_CHANNEL }, () => createBiquad(cc));
      dirty = true;
      prepared = true;
    },

    process(channels, frameCount) {
      if (!prepared) return;
      assertAudioBlock(channels, frameCount, preparedMaxBlockSize, "band EQ", filters[0]?.z1.length ?? 0);
      if (frameCount === 0) return;
      // Default-off is a true no-op: existing presets and golden fixtures
      // render bit-identically.
      if (store.get("enabled") < 0.5) return;
      if (dirty) {
        retune();
        dirty = false;
      }
      for (const f of filters) processBiquad(f, channels, frameCount);
    },

    reset() {
      for (const f of filters) resetBiquad(f);
    },

    getLatencySamples() {
      return 0;
    },

    setParameter(id, value) {
      store.set(id, value);
      dirty = true;
    },
    getParameter(id) {
      return store.get(id);
    },
    getParameters() {
      return store.all();
    },
    loadParameters(p) {
      store.load(p);
      dirty = true;
    },
  };
}

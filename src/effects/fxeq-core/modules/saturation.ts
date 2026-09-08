/* eslint-disable */
// @ts-nocheck
/**
 * VENDORED from VocalForge_DAW/plugins/fxeq. Do not edit by hand — this is a
 * byte-faithful copy of the upstream DSP oracle so Pulse Forge and VocalForge
 * validate against the SAME golden fixtures (tests/fxeq-golden/). Fix DSP
 * issues upstream, then re-vendor via scripts/vendor-fxeq.mjs.
 *
 * Applied transforms (mechanical, semantics-preserving):
 *  - type-only specifiers marked with "type" for verbatimModuleSyntax
 *    (Pulse Forge tsconfig is stricter than upstream).
 */
// ═══════════════════════════════════════════════════════════
// FXEQ — Saturation module (oversampled)
//
// Sample-by-sample waveshaper with optional polyphase oversampling for
// nonlinear modes. Drive → shape (8 modes) → output trim → dry/wet.
//
// P3.1 oversampling:
//   - eco: 1× always
//   - standard: 1× for mild modes, 2× for aggressive ones at >6 dB drive
//   - high: 2× or 4× based on drive
//   - render: 4× when beneficial
//
// The shape function runs at 2× or 4× the host rate inside the wrapper;
// the rest of the chain stays at the host rate. The wrapper reports
// added latency for PDC.
// ═══════════════════════════════════════════════════════════

import type { FxEqParamDef, ModuleProcessor } from "../dsp/types.js";
import { clamp } from "../dsp/mathUtils.js";
import { createParamStore } from "./moduleHelpers.js";
import { createOversampledSaturation } from "../dsp/oversampledSaturation.js";
import { assertAudioBlock } from "../dsp/audioBlockContract.js";

export const SAT_TYPE_ID = "saturation";

const PARAM_DEFS: readonly FxEqParamDef[] = [
  { id: "enabled", name: "Enabled", defaultValue: 0, minValue: 0, maxValue: 1, automatable: false },
  {
    id: "driveDb",
    name: "Drive",
    defaultValue: 6,
    minValue: 0,
    maxValue: 24,
    unit: "dB",
    automatable: true,
  },
  {
    id: "tiltDb",
    name: "Tilt",
    defaultValue: 0,
    minValue: -12,
    maxValue: 12,
    unit: "dB",
    automatable: true,
  },
  { id: "mode", name: "Mode", defaultValue: 0, minValue: 0, maxValue: 7, automatable: false },
  {
    id: "mix",
    name: "Mix",
    defaultValue: 100,
    minValue: 0,
    maxValue: 100,
    unit: "%",
    automatable: true,
  },
  {
    id: "outputDb",
    name: "Output",
    defaultValue: 0,
    minValue: -12,
    maxValue: 12,
    unit: "dB",
    automatable: true,
  },
] as const;

export function createSaturationModule(params?: Record<string, number>): ModuleProcessor {
  const store = createParamStore(PARAM_DEFS, params);
  let prepared = false;
  let sampleRate = 44100;
  const tiltLowState: number[] = [];
  const wrapper = createOversampledSaturation();
  // Quality cache: the previous code reached into a hidden property
  // every block with a cast. Mirror the value on the closure so the
  // hot path is a single load (Audit #N1).
  let qualityCached: "eco" | "standard" | "high" | "render" = "standard";
  let preparedMaxBlockSize = 1;

  // De-click smoothing for the hot gains (drive/output/mix). Block-rate
  // one-pole toward the current targets: the alpha is a per-sample value
  // applied ONCE PER BLOCK, so each block moves ~0.35% of the remaining
  // gap — a block-boundary step far below audible, which is exactly what
  // removes the zipper crackle on automation. (The full glide therefore
  // takes ~0.7 s; that slowness IS the de-click mechanism — do not
  // "fix" the alpha to the documented 12 ms without redesigning the
  // glide as per-sample.) The smoothers PRIME at the first processed
  // block after prepare/reset, so static settings render bit-identically
  // to the unsmoothed path (golden parity).
  let driveSm = 0;
  let outputSm = 0;
  let wetSm = 0;
  let paramSmPrimed = false;
  let paramSmAlpha = 1;

  return {
    get typeId() {
      return SAT_TYPE_ID;
    },
    get parameterDefs() {
      return PARAM_DEFS;
    },

    prepare(sr, cc, maxBs) {
      sampleRate = sr;
      preparedMaxBlockSize = Math.max(1, maxBs);
      tiltLowState.length = 0;
      for (let c = 0; c < cc; c++) tiltLowState.push(0);
      wrapper.prepare(sr, cc, maxBs);
      paramSmAlpha = 1 - Math.exp(-1 / (0.012 * sampleRate));
      paramSmPrimed = false;
      prepared = true;
    },

    process(channels, frameCount) {
      if (!prepared) return;
      assertAudioBlock(channels, frameCount, preparedMaxBlockSize, "saturation", tiltLowState.length);
      if (frameCount === 0) return;
      if (store.get("enabled") < 0.5) return;

      const driveDb = clamp(store.get("driveDb"), 0, 24);
      const tilt = clamp(store.get("tiltDb"), -12, 12) / 12;
      const outputDb = clamp(store.get("outputDb"), -12, 12);
      const mode = Math.round(store.get("mode"));
      const wetTarget = clamp(store.get("mix"), 0, 100) / 100;
      const quality = qualityCached;

      if (!paramSmPrimed) {
        driveSm = driveDb;
        outputSm = outputDb;
        wetSm = wetTarget;
        paramSmPrimed = true;
      } else {
        driveSm += paramSmAlpha * (driveDb - driveSm);
        outputSm += paramSmAlpha * (outputDb - outputSm);
        wetSm += paramSmAlpha * (wetTarget - wetSm);
      }
      // The wrapper expects dB and derives its own linear drive internally.
      const outputLinear = Math.pow(10, outputSm / 20);
      const wetGain = wetSm;

      // A gentle complementary low/high tilt before the waveshaper. This is
      // intentionally stateful so Tilt changes the actual tone, not only the
      // UI label: positive values emphasize air, negative values emphasize body.
      if (Math.abs(tilt) > 1e-4) {
        const alpha = 1 - Math.exp((-2 * Math.PI * 320) / sampleRate);
        const amount = tilt * 0.65;
        for (let c = 0; c < channels.length; c++) {
          let low = tiltLowState[c] ?? 0;
          const buf = channels[c];
          for (let i = 0; i < frameCount; i++) {
            const x = buf[i];
            low += alpha * (x - low);
            const high = x - low;
            buf[i] = low * (1 - amount) + high * (1 + amount);
          }
          tiltLowState[c] = low;
        }
      }

      wrapper.process(channels, frameCount, mode, driveSm, wetGain, outputLinear, quality);
    },

    reset() {
      wrapper.reset();
      tiltLowState.fill(0);
      paramSmPrimed = false;
    },

    getLatencySamples() {
      // A disabled module passes audio straight through, so it must not
      // make the lane/host compensate for delay that is not there.
      if (store.get("enabled") < 0.5) return 0;
      return wrapper.getLatencySamples();
    },

    setParameter(id, value) {
      // A re-enable after a bypassed period must not resume from stale FIR
      // history: process() did not run while disabled, so the wrapper's
      // delay lines and dry ring still hold pre-bypass audio. Zero them on
      // the rising edge (waveshaper state and reported latency are kept —
      // the latency stays valid for the host's PDC across the toggle).
      if (id === "enabled" && store.get("enabled") < 0.5 && value >= 0.5) {
        wrapper.clearDelayHistory();
      }
      store.set(id, value);
    },
    getParameter(id) {
      return store.get(id);
    },
    getParameters() {
      return store.all();
    },
    loadParameters(p) {
      store.load(p);
      // Quality is a host-level setting, not a module preset parameter.
      const q = p["quality"];
      if (q === 0 || q === 1 || q === 2 || q === 3) {
        const qMap: Record<number, "eco" | "standard" | "high" | "render"> = {
          0: "eco",
          1: "standard",
          2: "high",
          3: "render",
        };
        qualityCached = qMap[q];
      }
    },
  };
}

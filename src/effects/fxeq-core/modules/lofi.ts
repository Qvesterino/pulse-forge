/* eslint-disable */
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
// FXEQ — Lo-Fi module
//
// 4 degradation modes, blended by `amount` (0 = clean, 100 = max grit):
//   0 — Bit Depth:    quantize sample magnitude (fewer bits = grittier)
//   1 — Sample Rate:  sample-and-hold decimation (classic downsampler)
//   2 — Wow/Flutter:  LFO-modulated short delay (tape pitch wobble)
//   3 — Vinyl/Noise:  filtered noise floor + bandlimiting + crackle
// ═══════════════════════════════════════════════════════════

import type { FxEqParamDef, ModuleProcessor } from "../dsp/types.js";
import { clamp, lerp } from "../dsp/mathUtils.js";
import { createLfo } from "../dsp/lfo.js";
import { assertAudioBlock } from "../dsp/audioBlockContract.js";
import { createParamStore } from "./moduleHelpers.js";

export const LOFI_TYPE_ID = "lofi";

const PARAM_DEFS: readonly FxEqParamDef[] = [
  { id: "enabled", name: "Enabled", defaultValue: 0, minValue: 0, maxValue: 1, automatable: false },
  { id: "mode", name: "Mode", defaultValue: 0, minValue: 0, maxValue: 3, automatable: false },
  {
    id: "amount",
    name: "Amount",
    defaultValue: 50,
    minValue: 0,
    maxValue: 100,
    unit: "%",
    automatable: true,
  },
  // 100 preserves the v1 sound when these v2 controls are absent from an
  // older preset; users can dial the new primary controls down from there.
  {
    id: "wear",
    name: "Wear",
    defaultValue: 100,
    minValue: 0,
    maxValue: 100,
    unit: "%",
    automatable: true,
  },
  {
    id: "wobble",
    name: "Wobble",
    defaultValue: 100,
    minValue: 0,
    maxValue: 100,
    unit: "%",
    automatable: true,
  },
  {
    id: "mix",
    name: "Mix",
    defaultValue: 100,
    minValue: 0,
    maxValue: 100,
    unit: "%",
    automatable: true,
  },
] as const;

// Preserve the original 512-sample delay at 44.1 kHz, but size the ring by
// time so wow/flutter has the same character at every sample rate.
const WOW_DELAY_MS = (512 / 44100) * 1000;

export function createLofiModule(params?: Record<string, number>): ModuleProcessor {
  const store = createParamStore(PARAM_DEFS, params);
  let prepared = false;
  let preparedMaxBlockSize = 1;
  let sampleRate = 44100;
  let wowDelaySamples = 512;

  // Sample-rate reduction state (per channel): held value + counter.
  const srrHeld: number[] = [];
  const srrCounter: number[] = [];

  // Wow/flutter delay line (per channel).
  const wowBuffers: Float32Array[] = [];
  const wowWriteIdx: number[] = [];
  const wowLfo = createLfo(44100, 0.7, "sine", 0, 1);
  const flutterLfo = createLfo(44100, 6, "sine", Math.PI / 3, 1);
  // Pre-computed LFO values per sample (one slot per channel, so the LFO
  // advances exactly once per sample instead of once per channel).
  let wowLfoBufL: Float32Array = new Float32Array(0);
  let wowLfoBufR: Float32Array = new Float32Array(0);

  // Vinyl noise filter state (one-pole HP to shape noise).
  const noisePrev: number[] = [];

  // Seeded PRNG (xorshift32) per channel for deterministic but decorrelated
  // noise/jitter between L and R (essential for golden snapshot tests).
  const PRNG_SEEDS = [0x12345678, 0x9abcdef0, 0xdeadbeef, 0xcafebabe];
  const prngStates: number[] = [PRNG_SEEDS[0], PRNG_SEEDS[1]];

  function seededRandom(ch: number): number {
    let s = prngStates[ch] ?? PRNG_SEEDS[0];
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    prngStates[ch] = s;
    return (s >>> 0) / 0x100000000;
  }

  function resetPrng(): void {
    for (let c = 0; c < prngStates.length; c++) {
      prngStates[c] = PRNG_SEEDS[c % PRNG_SEEDS.length];
    }
  }

  // Dry snapshot buffer (per channel) for wet/dry blend.
  const dryBuf: Float32Array[] = [];

  function allocChannels(channelCount: number, maxBlockSize?: number): void {
    wowDelaySamples = Math.max(8, Math.ceil((WOW_DELAY_MS / 1000) * sampleRate) + 4);
    srrHeld.length = 0;
    srrCounter.length = 0;
    wowBuffers.length = 0;
    wowWriteIdx.length = 0;
    noisePrev.length = 0;
    dryBuf.length = 0;
    const block = maxBlockSize ?? 8192;
    wowLfoBufL = new Float32Array(block);
    wowLfoBufR = new Float32Array(block);
    for (let c = 0; c < channelCount; c++) {
      srrHeld.push(0);
      srrCounter.push(0);
      wowBuffers.push(new Float32Array(wowDelaySamples));
      wowWriteIdx.push(0);
      noisePrev.push(0);
      dryBuf.push(new Float32Array(block));
    }
  }

  function processBitDepth(buf: Float32Array, frameCount: number, amount: number): void {
    // From 16 bits (clean) down to ~3 bits at full amount.
    const bits = lerp(16, 3, amount);
    const levels = Math.pow(2, bits);
    const dryGain = 1 - amount * 0.3; // keep some dry to avoid total destruction
    for (let i = 0; i < frameCount; i++) {
      const x = buf[i];
      buf[i] = (Math.round(x * levels) / levels) * dryGain + x * (1 - dryGain);
    }
  }

  function processSampleRate(
    buf: Float32Array,
    ch: number,
    frameCount: number,
    amount: number,
  ): void {
    // Decimation factor from 1 (clean) to ~24 at full amount.
    const factor = lerp(1, 24, amount);
    const intFactor = Math.max(1, Math.round(factor));
    const frac = factor - Math.floor(factor);
    for (let i = 0; i < frameCount; i++) {
      if (srrCounter[ch] <= 0) {
        srrHeld[ch] = buf[i];
        srrCounter[ch] = intFactor + (seededRandom(ch) < frac ? 1 : 0);
      }
      srrCounter[ch]--;
      buf[i] = srrHeld[ch];
    }
  }

  function processWowFlutter(
    buf: Float32Array,
    ch: number,
    frameCount: number,
    amount: number,
    wobble: number,
    lfoBuf: Float32Array,
  ): void {
    const delayBuf = wowBuffers[ch];
    let writeIdx = wowWriteIdx[ch];
    const maxDelay = wowDelaySamples - 4;
    for (let i = 0; i < frameCount; i++) {
      const lfoVal = lfoBuf[i];
      // Modulated read position (1..maxDelay samples behind write head).
      const modulationRange = maxDelay * (0.05 + wobble * 0.95);
      const readPos = writeIdx - (2 + (0.5 + 0.5 * lfoVal) * modulationRange);
      const rIdx = ((readPos % wowDelaySamples) + wowDelaySamples) % wowDelaySamples;
      const i0 = Math.floor(rIdx);
      const frac = rIdx - i0;
      const i1 = (i0 + 1) % wowDelaySamples;
      const delayed = delayBuf[i0] * (1 - frac) + delayBuf[i1] * frac;
      // Write current input.
      delayBuf[writeIdx] = buf[i];
      writeIdx = (writeIdx + 1) % wowDelaySamples;
      buf[i] = buf[i] * (1 - amount) + delayed * amount;
    }
    wowWriteIdx[ch] = writeIdx;
  }

  function processVinyl(buf: Float32Array, ch: number, frameCount: number, amount: number): void {
    const noiseGain = amount * 0.04;
    const hpAlpha = 0.95;
    for (let i = 0; i < frameCount; i++) {
      const white = seededRandom(ch) * 2 - 1;
      noisePrev[ch] = hpAlpha * noisePrev[ch] + (1 - hpAlpha) * white;
      const noise = noisePrev[ch] * noiseGain;
      const crackle =
        seededRandom(ch) < 0.0015 * amount ? (seededRandom(ch) * 2 - 1) * 0.3 * amount : 0;
      buf[i] = buf[i] + noise + crackle;
    }
  }

  return {
    get typeId() {
      return LOFI_TYPE_ID;
    },
    get parameterDefs() {
      return PARAM_DEFS;
    },

    prepare(sr, channelCount, maxBlockSize) {
      sampleRate = sr;
      preparedMaxBlockSize = Math.max(1, maxBlockSize);
      allocChannels(Math.max(1, channelCount), maxBlockSize);
      wowLfo.setSampleRate(sampleRate);
      flutterLfo.setSampleRate(sampleRate);
      wowLfo.setRate(0.7);
      wowLfo.reset();
      flutterLfo.setRate(6);
      flutterLfo.reset();
      resetPrng();
      prepared = true;
    },

    process(channels, frameCount) {
      if (!prepared) return;
      assertAudioBlock(channels, frameCount, preparedMaxBlockSize, "lo-fi", dryBuf.length);
      if (frameCount === 0) return;
      if (store.get("enabled") < 0.5) return;

      const amount = clamp(store.get("amount"), 0, 100) / 100;
      const wear = clamp(store.get("wear"), 0, 100) / 100;
      const wobble = clamp(store.get("wobble"), 0, 100) / 100;
      const mode = Math.round(store.get("mode"));
      const wetGain = clamp(store.get("mix"), 0, 100) / 100;
      // Amount controls the selected degradation type; Wear controls how
      // aggressively it is aged, so both controls remain musically useful.
      const degradation = clamp(amount * (0.35 + wear * 0.65), 0, 1);

      // Pre-compute wow/flutter LFO values once per sample (not per-channel)
      // so the LFO phase advances at exactly the requested rate. A previous
      // version read inside the per-channel loop, doubling the rate in stereo.
      if (mode === 2) {
        for (let i = 0; i < frameCount; i++) {
          const [wowL, wowR] = wowLfo.read();
          const [flL, flR] = flutterLfo.read();
          wowLfoBufL[i] = wowL + flL * 0.3;
          wowLfoBufR[i] = wowR + flR * 0.3;
        }
      }

      for (let c = 0; c < channels.length; c++) {
        const buf = channels[c];
        // Snapshot the dry signal for a true wet/dry blend (subarray is a view).
        dryBuf[c].set(buf.subarray(0, frameCount));
        switch (mode) {
          case 0:
            processBitDepth(buf, frameCount, degradation);
            break;
          case 1:
            processSampleRate(buf, c, frameCount, degradation);
            break;
          case 2:
            processWowFlutter(
              buf,
              c,
              frameCount,
              amount,
              wobble,
              c === 0 ? wowLfoBufL : wowLfoBufR,
            );
            break;
          case 3:
            processVinyl(buf, c, frameCount, degradation);
            break;
          default:
            processBitDepth(buf, frameCount, amount);
        }
        // Dry/wet blend against the pre-processed signal.
        if (wetGain < 1) {
          const dry = dryBuf[c];
          for (let i = 0; i < frameCount; i++) {
            buf[i] = dry[i] * (1 - wetGain) + buf[i] * wetGain;
          }
        }
      }
    },

    reset() {
      for (const b of wowBuffers) b.fill(0);
      for (let c = 0; c < srrHeld.length; c++) {
        srrHeld[c] = 0;
        srrCounter[c] = 0;
        noisePrev[c] = 0;
      }
      wowLfo.reset();
      flutterLfo.reset();
      resetPrng();
    },

    getLatencySamples() {
      return 0;
    },

    setParameter(id, value) {
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
    },
  };
}

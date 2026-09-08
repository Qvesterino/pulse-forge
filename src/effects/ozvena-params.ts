/**
 * UI/engine-facing numeric ranges for Ozvena's flattened state paths.
 *
 * The worklet owns the DSP state tree, but the host still needs one stable
 * range catalog for automation, macros, MIDI and persistence. Keep this file
 * dependency-free so both the effect registry and the project target catalog
 * can use it without introducing a registry ↔ target import cycle.
 */
export interface OzvenaParamRange {
  min: number;
  max: number;
}

const ENUM_RANGES: Record<string, OzvenaParamRange> = {
  "engines.e2.algo": { min: 0, max: 2 },
  "engines.e3.algo": { min: 0, max: 1 },
  "blendPad.engine2Algo": { min: 0, max: 2 },
  "mod.mode": { min: 0, max: 1 },
  "convolution.mode": { min: 0, max: 2 },
  "global.quality": { min: 0, max: 3 },
};

/** Resolve the legal numeric range for one flattened Ozvena path. */
export function ozvenaParamRange(id: string, value: number | boolean = 0): OzvenaParamRange {
  const enumRange = ENUM_RANGES[id];
  if (enumRange) return enumRange;

  const leaf = id.slice(id.lastIndexOf(".") + 1);
  if (typeof value === "boolean" || leaf === "enabled" || leaf === "syncEnabled") return { min: 0, max: 1 };

  switch (id) {
    case "global.inputGainDb":
    case "global.outputGainDb":
      return { min: -24, max: 24 };
    case "global.levelDb":
      return { min: -24, max: 6 };
    case "global.dryWet":
      return { min: 0, max: 100 };
    case "blendPad.x":
    case "blendPad.y":
    case "blendPad.injectER":
      return { min: 0, max: 1 };
    case "preDelay.ms":
      return { min: 0, max: 500 };
    case "smoother.amount":
    case "preEq.autoCut.amount":
    case "reverbEq.unmask.amount":
      return { min: 0, max: 100 };
    case "mod.depthX":
      return { min: 0, max: 1.25 };
    case "mod.rateY":
      return { min: 0, max: 1 };
    case "mod.maxDepthSamples":
      return { min: 0, max: 60 };
    case "duck.thresholdDb":
      return { min: -60, max: 0 };
    case "duck.sensitivity":
      return { min: 0, max: 1 };
    case "duck.attackMs":
      return { min: 1, max: 500 };
    case "duck.releaseMs":
      return { min: 10, max: 2000 };
    case "convolution.wet":
      return { min: 0, max: 100 };
  }

  if (id.startsWith("engines.e1.") && leaf === "time") return { min: 36.73, max: 250 };
  if (id.startsWith("engines.e2.") && leaf === "time") return { min: 1400, max: 14000 };
  if (id.startsWith("engines.e3.") && leaf === "time") return { min: 4170, max: 24000 };
  if (id.startsWith("engines.") && leaf === "time") return { min: 0, max: 24000 };
  if (id.startsWith("engines.") && leaf === "attack") return { min: 0, max: 250 };

  switch (leaf) {
    case "space":
    case "size":
    case "balance":
    case "width":
    case "stereoWidth":
    case "shimmer":
    case "drive":
      return { min: 0, max: 1 };
    case "diffusion":
    case "angle":
    case "mix":
      return { min: 0, max: 100 };
    case "crossoverHz":
      return { min: 20, max: 4000 };
    case "dampingAmount":
      return { min: 1, max: 11 };
    case "dampingFreqHz":
    case "lowpassHz":
      return { min: 30, max: 20000 };
    case "bassDecay":
    case "midDecay":
    case "modRateMult":
      return { min: 0.25, max: 4 };
    case "freqHz":
      return { min: 20, max: 20000 };
    case "gainDb":
      return { min: -24, max: 24 };
    case "q":
      return { min: 0.1, max: 24 };
    case "wet":
      return { min: 0, max: 100 };
    default:
      // Unknown numeric leaves are still bounded. This is only a defensive
      // fallback; every current numeric Ozvena path is covered above.
      return { min: value < 0 ? -1 : 0, max: Math.max(1, Math.abs(value) * 4) };
  }
}

export function clampOzvenaParam(id: string, value: number, fallback = 0): number {
  const safe = Number.isFinite(value) ? value : fallback;
  const range = ozvenaParamRange(id, safe);
  return Math.min(range.max, Math.max(range.min, safe));
}

/**
 * Upper bound on a user impulse response's length, in seconds. Factory IRs
 * top out at 5 s; real-world reverb IRs rarely exceed 8. Without a cap, a
 * mistaken long file (decodeAudioData happily decodes a whole song) drives
 * the partitioned convolver's spectrum allocation past hundreds of MB and
 * stalls the audio thread for the full FFT batch — an OOM/tab-crash path
 * reachable from the rack's IR file input.
 */
export const OZVENA_IR_MAX_SECONDS = 10;

/** Frames of a user IR actually loaded at `sampleRate` (time-based cap). */
export function capUserIrFrames(frames: number, sampleRate: number): number {
  if (!Number.isFinite(frames) || frames <= 0) return 0;
  const cap = Math.max(1, Math.floor(OZVENA_IR_MAX_SECONDS * sampleRate));
  return Math.min(Math.floor(frames), cap);
}

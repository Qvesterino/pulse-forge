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
// FXEQ — LFO (low-frequency oscillator)
//
// Phase-accumulator LFO with multiple waveforms and an optional stereo
// phase offset. Used by modulation (chorus/flanger/phaser), lo-fi
// wow/flutter, and tape-style delay wobble.
// ═══════════════════════════════════════════════════════════

export type LfoWaveform = "sine" | "triangle" | "saw" | "square" | "random";

/**
 * A stereo LFO. `read()` returns two samples in [-1, 1]: the first for the
 * left channel phase, the second offset by `stereoPhase` for the right.
 */
export interface Lfo {
  setSampleRate(sampleRate: number): void;
  setRate(hz: number): void;
  setWaveform(wave: LfoWaveform): void;
  setStereoPhase(radians: number): void;
  setDepth(depth: number): void;
  reset(): void;
  /** Advance and return [left, right] in [-depth, +depth]. */
  read(): [number, number];
  /**
   * Allocation-free variant of read() for the audio thread: writes the
   * advanced [left, right] pair into `out` and returns it. Callers must
   * consume the values before the next call (read() itself is unchanged
   * for hosts that keep the tuple).
   */
  readInto(out: [number, number]): [number, number];
}

// Deterministic S&H source for the "random" waveform. Hosts may provide a
// stable seed so independent plugin instances remain decorrelated while live
// and offline renders keep identical random holds. The default stays fixed for
// old callers and golden fixtures.
// xorshift32: allocation-free, zero-dependency, never reaches state 0 from
// a nonzero seed. State lives in the per-LFO closure so independent
// instances follow identical sequences regardless of read interleaving,
// and reset() re-seeds so a restarted render follows the same holds.
const RANDOM_SEED = 0x5eed1f0;

export function createLfo(
  sampleRate: number,
  rateHz = 1,
  wave: LfoWaveform = "sine",
  stereoPhaseRad = 0,
  depth = 1,
  seed = RANDOM_SEED,
): Lfo {
  let phase = 0;
  let currentSampleRate = sanitizeSampleRate(sampleRate);
  let currentRateHz = sanitizeRate(rateHz);
  let phaseInc = currentRateHz / currentSampleRate;
  let waveform = wave;
  let stereoPhase = stereoPhaseRad;
  let depthScale = depth;
  let randVal = 0;
  let prevPhase = 0;
  const initialSeed = sanitizeSeed(seed);
  let prngState = initialSeed;
  const nextRandom = (): number => {
    prngState ^= prngState << 13;
    prngState ^= prngState >>> 17;
    prngState ^= prngState << 5;
    return ((prngState >>> 0) / 0xffffffff) * 2 - 1;
  };

  function sampleAt(p: number): number {
    const ph = p - Math.floor(p); // wrap to [0, 1)
    switch (waveform) {
      case "sine":
        return Math.sin(2 * Math.PI * ph);
      case "triangle":
        return ph < 0.5 ? 4 * ph - 1 : 3 - 4 * ph;
      case "saw":
        return 2 * ph - 1;
      case "square":
        return ph < 0.5 ? 1 : -1;
      case "random": {
        // Sample & hold: hold value across first half, retake at mid-cross.
        return randVal;
      }
      default:
        return Math.sin(2 * Math.PI * ph);
      }
  }

  function advance(): void {
    prevPhase = phase;
    phase += phaseInc;
    if (phase >= 1) phase -= Math.floor(phase);
    // For random S&H, retake when crossing the 0.5 boundary.
    if (waveform === "random") {
      const wrappedPrev = prevPhase - Math.floor(prevPhase);
      const wrappedNow = phase;
      const crossed = wrappedPrev < 0.5 && wrappedNow >= 0.5;
      if (crossed || randVal === 0) {
        randVal = nextRandom();
      }
    }
  }

  return {
    setSampleRate(sampleRate: number) {
      currentSampleRate = sanitizeSampleRate(sampleRate);
      phaseInc = currentRateHz / currentSampleRate;
    },
    setRate(hz: number) {
      currentRateHz = sanitizeRate(hz);
      phaseInc = currentRateHz / currentSampleRate;
    },
    setWaveform(wave: LfoWaveform) {
      waveform = wave;
    },
    setStereoPhase(radians: number) {
      stereoPhase = radians;
    },
    setDepth(depth: number) {
      depthScale = depth;
    },
    reset() {
      phase = 0;
      prevPhase = 0;
      randVal = 0;
      prngState = initialSeed;
    },
    read() {
      const left = sampleAt(phase) * depthScale;
      const rightPhase = phase + stereoPhase / (2 * Math.PI);
      const right = sampleAt(rightPhase) * depthScale;
      advance();
      return [left, right];
    },
    readInto(out) {
      out[0] = sampleAt(phase) * depthScale;
      const rightPhase = phase + stereoPhase / (2 * Math.PI);
      out[1] = sampleAt(rightPhase) * depthScale;
      advance();
      return out;
    },
  };
}

function sanitizeSampleRate(sampleRate: number): number {
  return Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100;
}

function sanitizeRate(rateHz: number): number {
  return Number.isFinite(rateHz) ? Math.max(0, rateHz) : 0;
}

function sanitizeSeed(seed: number): number {
  const normalized = Number.isFinite(seed) ? seed >>> 0 : RANDOM_SEED;
  return normalized === 0 ? RANDOM_SEED : normalized;
}

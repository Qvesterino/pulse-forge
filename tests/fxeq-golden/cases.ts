// ═══════════════════════════════════════════════════════════
// FXEQ — Golden snapshot test definitions
//
// Each case is a deterministic signal + parameter set rendered through
// the processor. The resulting fingerprint is committed as JSON and
// compared on every CI run within a tolerance band.
//
// NOTE (2026-09-14): every case pins its historical crossover splits
// explicitly. The schema defaults were realigned (missing crossoverFreq6
// + a one-position default shift) so fresh instances no longer render a
// dead band — the fixtures keep the splits they were generated with.
// impulse-response and combined-chain were regenerated (UPDATE_GOLDEN=1):
// their 6-band default set contained a degenerate zero-width band that is
// intentionally unreachable after the monotonic-gap guard.
// ═══════════════════════════════════════════════════════════

import { impulseSignal, logSweepSignal, multiToneSignal, type GoldenCase } from "./helpers.js";

export const GOLDEN_CASES: readonly GoldenCase[] = [
  // ── Case 1: Transparent bypass ──
  // All modules disabled, crossover + limiter only. Tests that the
  // multiband split/reconstruction is transparent (output ≈ input).
  {
    name: "bypass-transparent",
    signal: () => logSweepSignal(16384, 20, 18000),
    params: {
      bandCount: 6,
      crossoverFreq2: 400,
      crossoverFreq3: 1200,
      crossoverFreq4: 4000,
      crossoverFreq5: 8000,
      crossoverFreq6: 8000,
      limiterEnabled: 0,
    },
    blockSize: 256,
  },

  // ── Case 2: Impulse response ──
  // Impulse through 6-band crossover with allpass equalization.
  // Verifies the phase response and reconstruction of the crossover.
  {
    name: "impulse-response",
    signal: () => impulseSignal(8192),
    params: {
      bandCount: 6,
      crossoverFreq2: 400,
      crossoverFreq3: 1200,
      crossoverFreq4: 4000,
      crossoverFreq5: 8000,
      crossoverFreq6: 8000,
      limiterEnabled: 0,
    },
    blockSize: 512,
  },

  // ── Case 3: Warmth saturation ──
  // Tube saturation on mid bands — tests the saturation module's
  // harmonic generation across the crossover.
  {
    name: "warmth-saturation",
    signal: () => multiToneSignal(16384, [80, 300, 1000, 3000, 8000]),
    params: {
      bandCount: 4,
      crossoverFreq2: 400,
      crossoverFreq3: 1200,
      crossoverFreq4: 4000,
      "band2.satEnabled": 1,
      "band2.satDriveDb": 6,
      "band2.satMode": 1,
      "band2.satMix": 60,
      "band3.satEnabled": 1,
      "band3.satDriveDb": 4,
      "band3.satMode": 1,
      "band3.satMix": 50,
      limiterEnabled: 1,
      limiterCeilDb: -0.5,
    },
    blockSize: 256,
  },

  // ── Case 4: Reverb tail ──
  // Plate reverb on high bands — tests the FDN reverb and band routing.
  {
    name: "reverb-plate",
    signal: () => logSweepSignal(16384, 100, 12000),
    params: {
      bandCount: 4,
      crossoverFreq2: 400,
      crossoverFreq3: 1200,
      crossoverFreq4: 4000,
      "band4.revEnabled": 1,
      "band4.revType": 0,
      "band4.revDecayMs": 2000,
      "band4.revMix": 40,
      limiterEnabled: 0,
    },
    blockSize: 512,
  },

  // ── Case 5: Lo-Fi degradation ──
  // Bit-depth + sample-rate reduction across low bands.
  {
    name: "lofi-degradation",
    signal: () => multiToneSignal(16384, [100, 500, 2000, 6000, 10000]),
    params: {
      bandCount: 4,
      crossoverFreq2: 400,
      crossoverFreq3: 1200,
      crossoverFreq4: 4000,
      "band1.lofiEnabled": 1,
      "band1.lofiMode": 0,
      "band1.lofiAmount": 60,
      "band1.lofiMix": 80,
      "band2.lofiEnabled": 1,
      "band2.lofiMode": 1,
      "band2.lofiAmount": 40,
      "band2.lofiMix": 60,
      limiterEnabled: 1,
      limiterCeilDb: -1,
    },
    blockSize: 256,
  },

  // ── Case 6: Delay feedback ──
  // Tape delay with feedback on mid bands — tests delay line + damping.
  {
    name: "delay-feedback",
    signal: () => impulseSignal(16384),
    params: {
      bandCount: 4,
      crossoverFreq2: 400,
      crossoverFreq3: 1200,
      crossoverFreq4: 4000,
      "band3.delayEnabled": 1,
      "band3.delayType": 1,
      "band3.delayTimeMs": 300,
      "band3.delayFeedback": 0.5,
      "band3.delayMix": 50,
      "band3.delayDampHz": 3000,
      limiterEnabled: 0,
    },
    blockSize: 512,
  },

  // ── Case 7: Modulation ──
  // Phaser on mid bands — tests the modulation module with feedback.
  {
    name: "phaser-modulation",
    signal: () => logSweepSignal(16384, 200, 8000),
    params: {
      bandCount: 4,
      crossoverFreq2: 400,
      crossoverFreq3: 1200,
      crossoverFreq4: 4000,
      "band2.modEnabled": 1,
      "band2.modType": 2,
      "band2.modRate": 0.5,
      "band2.modDepth": 70,
      "band2.modFeedback": 0.6,
      "band2.modMix": 55,
      limiterEnabled: 0,
    },
    blockSize: 256,
  },

  // ── Case 8: Combined chain ──
  // Saturation + reverb + delay — the full signal chain stress test.
  {
    name: "combined-chain",
    signal: () => multiToneSignal(16384, [60, 250, 1200, 4000, 9000, 14000]),
    params: {
      bandCount: 6,
      crossoverFreq2: 400,
      crossoverFreq3: 1200,
      crossoverFreq4: 4000,
      crossoverFreq5: 8000,
      crossoverFreq6: 8000,
      "band1.satEnabled": 1,
      "band1.satDriveDb": 8,
      "band1.satMode": 2,
      "band1.satMix": 45,
      "band3.satEnabled": 1,
      "band3.satDriveDb": 4,
      "band3.satMode": 1,
      "band3.satMix": 40,
      "band5.revEnabled": 1,
      "band5.revType": 1,
      "band5.revDecayMs": 3000,
      "band5.revMix": 35,
      "band4.delayEnabled": 1,
      "band4.delayType": 1,
      "band4.delayTimeMs": 250,
      "band4.delayFeedback": 0.35,
      "band4.delayMix": 25,
      limiterEnabled: 1,
      limiterCeilDb: -0.5,
    },
    blockSize: 256,
  },
];

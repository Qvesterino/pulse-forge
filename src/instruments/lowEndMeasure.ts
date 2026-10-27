/**
 * LOW-END STACK wave 3 — the render-based low-end measurement (E2 spirit:
 * measure the pump in the PCM, not in the model).
 *
 * The model-level `measureLowEndFit` (lowEndBass.ts) reads the arrangement;
 * this module listens to it. Three offline renders of the stems — the MIX
 * (kick+bass, real effects: KOREŇ and the sidechain RUN), the KICK solo and
 * the BASS solo — are combined through the superposition principle:
 *
 *     R(t) = mix(t) − kick(t) − bass(t)
 *
 * All three renders come from the same deterministic context and start at
 * tick 0, so they are sample-aligned. Without a sidechain the chain is
 * linear and time-invariant: R is identically zero. WITH a sidechain the
 * bass is multiplied by its duck gain, so R = bass·(duck(t) − 1) — the
 * pump signal ISOLATED, kick-free by construction. No band filter has to
 * separate two near-octave fundamentals (impossible at 12 dB/oct); the
 * kick bleed problem simply does not exist in the residual.
 *
 * The metric: where the unducked bass is audible, the per-sample duck gain
 * is g(t) = 1 − env_R(t)/env_bass(t); the hit-window median of g converts
 * straight into duck dB. A guard reads the residual OUTSIDE the hit
 * windows — track-FX nonlinearity or misalignment shows up there first,
 * and a failing guard demotes the verdict instead of hiding behind it.
 *
 * Pure DSP over Float32Array: deterministic, vitest-first, no Web Audio
 * needed until the render bridge hands over PCM.
 */

/** 2-pole Butterworth biquad coefficients (same math as the sidechain worklet). */
interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

function lpCoeffs(f: number, sr: number): BiquadCoeffs {
  const K = Math.tan((Math.PI * Math.min(f, sr * 0.45)) / sr);
  const K2 = K * K;
  const a0 = 1 + Math.SQRT2 * K + K2;
  return { b0: K2 / a0, b1: (2 * K2) / a0, b2: K2 / a0, a1: (2 * (K2 - 1)) / a0, a2: (1 - Math.SQRT2 * K + K2) / a0 };
}

function hpCoeffs(f: number, sr: number): BiquadCoeffs {
  const K = Math.tan((Math.PI * Math.min(f, sr * 0.45)) / sr);
  const K2 = K * K;
  const a0 = 1 + Math.SQRT2 * K + K2;
  return { b0: 1 / a0, b1: -2 / a0, b2: 1 / a0, a1: (2 * (K2 - 1)) / a0, a2: (1 - Math.SQRT2 * K + K2) / a0 };
}

function biquad(pcm: Float32Array, c: BiquadCoeffs): Float32Array {
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    const x = pcm[i]!;
    const y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    // FTZ: a silent tail must not simmer in denormals.
    out[i] = Math.abs(y) < 1e-20 ? 0 : y;
  }
  return out;
}

/**
 * Band-limited envelope: band-pass (HP then LP) around [low, high] Hz, then
 * a peak follower (fast attack, slow release — the pump lives in the
 * release). Full-rate, so windows can be slice-precise.
 */
export function bandEnvelope(pcm: Float32Array, sr: number, low: number, high: number): Float32Array {
  const hp = biquad(pcm, hpCoeffs(low, sr));
  const band = biquad(hp, lpCoeffs(high, sr));
  const env = new Float32Array(band.length);
  const attCoef = Math.exp(-1 / (sr * 0.001));
  const relCoef = Math.exp(-1 / (sr * 0.06));
  let level = 0;
  for (let i = 0; i < band.length; i++) {
    const peak = Math.abs(band[i]!);
    level = peak > level ? attCoef * level + (1 - attCoef) * peak : relCoef * level + (1 - relCoef) * peak;
    env[i] = Math.abs(level) < 1e-20 ? 0 : level;
  }
  return env;
}

const toDb = (v: number) => 20 * Math.log10(Math.max(v, 1e-6));
/** Band edges: ±1 st around a fundamental. */
const BAND_RATIO = Math.pow(2, 1 / 12);

export interface LowEndRenderInputs {
  /** The mixed stem render: kick + bass, real effects (sidechain active). */
  mix: Float32Array;
  /** The kick solo render. */
  kick: Float32Array;
  /** The bass solo render — its sidechain detector sees silence, so it is the unducked reference. */
  bass: Float32Array;
}

export interface LowEndBandMeasurement {
  /** Solo-render band peaks: who owns the low end, in dBFS. */
  kickBandPeakDb: number;
  bassBandPeakDb: number;
  /**
   * The measured duck depth under the hits, in dB (median over usable
   * windows). ≈0 = no pump; 8 = the bass is pinched 8 dB under every hit.
   */
  pumpDepthDb: number;
  /** Duck gain (0..1) at the hits — 1 would be a full mute. */
  pumpGain: number;
  /** Windows the duck statistic actually used. */
  pumpHits: number;
  /**
   * The residual OUTSIDE the hit windows, in dB relative to the bass band.
   * Superposition must hold there (R ≈ 0); a high floor means track-FX
   * nonlinearity or misalignment and demotes the verdict.
   */
  residualFloorDb: number;
  bandsTooClose: boolean;
  kickHz: number;
  bassHz: number;
  analyzedSeconds: number;
}

function windowPeakDb(env: Float32Array, from: number, to: number): number {
  let peak = 0;
  for (let j = Math.max(0, from); j < Math.min(to, env.length); j++) peak = Math.max(peak, env[j]!);
  return toDb(peak);
}

export function measureLowEndRender(
  inputs: LowEndRenderInputs,
  sr: number,
  timing: { onsetSeconds: number[]; analyzedSeconds: number },
  kickHz: number,
  bassHz: number,
): LowEndBandMeasurement {
  const n = Math.min(inputs.mix.length, inputs.kick.length, inputs.bass.length);
  // The superposition residual — the pump, isolated.
  const residual = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    residual[i] = (inputs.mix[i] ?? 0) - (inputs.kick[i] ?? 0) - (inputs.bass[i] ?? 0);
  }

  const separationSt = Math.abs(1200 * Math.log2(kickHz / bassHz)) / 100;
  const bandsTooClose = separationSt < 5;
  const kickBand: [number, number] = [kickHz / BAND_RATIO, kickHz * BAND_RATIO];
  const bassBand: [number, number] = [bassHz / BAND_RATIO, bassHz * BAND_RATIO];

  const kickPeak = bandsTooClose ? -120 : windowPeakDb(bandEnvelope(inputs.kick, sr, kickBand[0], kickBand[1]), 0, n);
  const bassPeak = bandsTooClose ? -120 : windowPeakDb(bandEnvelope(inputs.bass, sr, bassBand[0], bassBand[1]), 0, n);

  // The pump: residual and reference, band-limited to the BASS band.
  const envR = bandEnvelope(residual, sr, bassBand[0], bassBand[1]);
  const envU = bandEnvelope(inputs.bass, sr, bassBand[0], bassBand[1]);
  let uPeak = 0;
  for (let i = 0; i < n; i++) uPeak = Math.max(uPeak, envU[i]!);
  const uFloor = uPeak * 0.1; // where the reference is audible enough to divide by

  const onsets = timing.onsetSeconds.slice().sort((a, b) => a - b);
  const depthFactors: number[] = [];
  // A sample is "outside a hit" for the guard: ≥150 ms from every onset.
  const outside = (i: number) => {
    const t = i / sr;
    for (const t0 of onsets) if (t > t0 - 0.15 && t < t0 + 0.25) return false;
    return true;
  };
  let rEnergy = 0;
  let rCount = 0;
  for (let i = 0; i < onsets.length; i++) {
    const t0 = onsets[i]!;
    const next = onsets[i + 1] ?? timing.analyzedSeconds + 1;
    const attackFrom = Math.round(t0 * sr);
    const attackTo = Math.min(Math.round((t0 + 0.25) * sr), Math.round((next - 0.02) * sr));
    if (attackTo <= attackFrom || attackFrom >= n) continue;
    // The DEEPEST duck in the window: max of envR/envU where the reference
    // is audible. The recovery curve only relaxes the ratio after the hit,
    // so the max is the number "how far down was the bass under this hit".
    let maxRatio = 0;
    let audible = 0;
    for (let j = attackFrom; j < Math.min(attackTo, n); j++) {
      if (envU[j]! < uFloor) continue;
      audible++;
      maxRatio = Math.max(maxRatio, envR[j]! / envU[j]!);
    }
    // A window with an audible reference counts even when the ratio is 0 —
    // "no duck here" is a measurement, "no window" is not.
    if (audible > 0) depthFactors.push(Math.min(0.999, maxRatio));
  }
  depthFactors.sort((a, b) => a - b);
  // depthFactor = 1 − duck gain, so the duck in dB is −20·log₁₀(1 − factor).
  const medianFactor = depthFactors.length > 0 ? depthFactors[Math.floor(depthFactors.length / 2)]! : 0;
  const pumpGain = 1 - medianFactor;
  const pumpDepthDb = depthFactors.length > 0 ? -20 * Math.log10(Math.max(1e-3, pumpGain)) : 0;

  for (let i = 0; i < n; i++) {
    if (outside(i)) {
      rEnergy += residual[i]! * residual[i]!;
      rCount++;
    }
  }
  let uEnergy = 0;
  for (let i = 0; i < n; i++) uEnergy += (inputs.bass[i] ?? 0) * (inputs.bass[i] ?? 0);
  const residualFloorDb = rCount > 0 ? toDb(Math.sqrt(rEnergy / rCount)) - toDb(Math.sqrt(uEnergy / n)) : -120;

  return {
    kickBandPeakDb: kickPeak,
    bassBandPeakDb: bassPeak,
    pumpDepthDb,
    pumpGain,
    pumpHits: depthFactors.length,
    residualFloorDb,
    bandsTooClose,
    kickHz,
    bassHz,
    analyzedSeconds: timing.analyzedSeconds,
  };
}

/** The human line under the fit verdict — honest about guard and lower bounds. */
export function describeBandMeasurement(m: LowEndBandMeasurement): string {
  if (m.pumpHits === 0) {
    return "Rendered, but no clean hit window fit this pattern — lengthen the pattern or slow down.";
  }
  const db = (v: number) => `${v > -60 ? v.toFixed(1) : "−∞"} dB`;
  const guard =
    m.residualFloorDb > -25
      ? ` (residual floor ${m.residualFloorDb.toFixed(1)} dB — track FX add nonlinearity, take the number as indicative)`
      : "";
  let pump: string;
  if (m.pumpDepthDb < 1) pump = "no pump detected — the bass rides through the hits";
  else pump = `pump measured: the ducking pinches the bass ${m.pumpDepthDb.toFixed(1)} dB under each hit`;
  const peaks = m.bandsTooClose
    ? `bands ${m.kickHz.toFixed(0)}/${m.bassHz.toFixed(0)} Hz sit closer than 5 st — solo peaks withheld`
    : `kick band ${db(m.kickBandPeakDb)}, bass band ${db(m.bassBandPeakDb)}`;
  return `Rendered: ${peaks}, ${pump} (${m.pumpHits} hits)${guard}.`;
}

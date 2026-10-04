/**
 * TRANSIENT PROFILE — per-band leading-window energy (the sound-library
 * audit's attack term).
 *
 * WHY THIS EXISTS: a whole-file Welch band share is an average over a
 * loudness-normalized render. A sub-millisecond strike (a mallet contact, a
 * click transient) contributes a rounding error to that average, so the
 * 2026-09/10 strike fixes measured 0.0-0.1 dB broadband — the audit was
 * literally blind to them (the reason the campaign's own notes called the
 * strike path "inert"). This module measures the axis that work actually
 * changed: the mean power of the first `windowMs` ms after the first loud
 * sample, PER BAND, relative to the loud-span mean power of the same band.
 * A strike lives in one band; the max across the bands is the strike.
 *
 * Real pre/post evidence (2026-10 mallet wave, tmp-old-* pairs): broadband
 * moves 0.0-0.1 dB (invisible) while the per-band max moves 1.5-3.7 dB —
 * vibes 8.4→11.8 (himid), marimba 14.7→19.0 (himid), kalimba 8.2→10.1
 * (himid), celesta 7.5→9.9 (high), musicbox 7.3→8.4 (high).
 *
 * Pure + deterministic: float math only, no AudioContext, no clock. The
 * audit script (scripts/audit-samples.mts) consumes `ANALYSIS_BANDS` and
 * `analyzeTransientProfile` so the printed table, the redundancy feature
 * vector and this test can never drift apart.
 */

/** Band edges shared by the audit's whole-file shares and the transient
 *  profile — one source of truth for what "band" means. */
export const ANALYSIS_BANDS: ReadonlyArray<readonly [string, number, number]> = [
  ["sub", 20, 60],
  ["low", 60, 120],
  ["lowmid", 120, 350],
  ["mid", 350, 2000],
  ["himid", 2000, 6000],
  ["high", 6000, 12000],
  ["air", 12000, 22050],
];

export interface TransientProfile {
  /** Per-band head/loud ratio in dB, keyed by band name (all bands, raw). */
  bands: Record<string, number>;
  /** Strongest PARTICIPATING band's head/loud ratio (dB) — the strike's band. */
  maxDb: number;
  /** Name of the strongest participating band. */
  maxBand: string;
  /**
   * Bands that carried real body energy (within `participationFloorDb` of the
   * loudest band's loud-span power). A band whose loud-span content is orders
   * below the body's main energy has no "body" to be a transient relative to —
   * its ratio is filter/onset ringing divided by near-zero, and letting it win
   * the max would pin the metric to noise. Excluded bands stay in `bands` for
   * diagnostics but cannot be `maxBand`.
   */
  participating: string[];
  /**
   * Broadband ratio (dB), for comparison only. Kept because "which band
   * beats the broadband reading" is itself diagnostic: a real in-band
   * strike shows `maxDb` well above `broadbandDb`, while a uniformly loud
   * head shows them roughly equal.
   */
  broadbandDb: number;
  /** First loud sample index (1e-3 amplitude floor) the window was anchored to. */
  firstLoud: number;
  /** Last loud sample index of the loud span. */
  lastLoud: number;
}

export interface TransientProfileOptions {
  /** Leading window length in ms (default 10; 1-25 judges one-shots). */
  windowMs?: number;
  sampleRate?: number;
  /** Amplitude floor defining "loud" (default 1e-3, ≈ -60 dBFS). */
  loudFloor?: number;
  /**
   * How far below the loudest band's loud-span power a band may sit and still
   * count as "having body" (default 30 dB). Relative to the file's own loudest
   * band, so it is gain-invariant and content-relative — a dark kick's air band
   * and a bright hat's sub band are excluded the same way.
   */
  participationFloorDb?: number;
}

/** 2-pole RBJ biquad (Q 0.707) — enough separation for band energy without
 *  an FFT per window; matches the audit's band edges. */
function biquadCoeffs(
  kind: "lowpass" | "highpass",
  hz: number,
  sampleRate: number,
): [number, number, number, number, number] {
  const w0 = (2 * Math.PI * hz) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * 0.7071067811865476);
  const a0 = 1 + alpha;
  if (kind === "lowpass") {
    return [(1 - cos) / 2 / a0, (1 - cos) / a0, (1 - cos) / 2 / a0, (-2 * cos) / a0, (1 - alpha) / a0];
  }
  return [(1 + cos) / 2 / a0, -(1 + cos) / a0, (1 + cos) / 2 / a0, (-2 * cos) / a0, (1 - alpha) / a0];
}

function runBiquadForward(
  data: Float32Array,
  [b0, b1, b2, a1, a2]: [number, number, number, number, number],
): Float32Array {
  const out = new Float32Array(data.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < data.length; i++) {
    const x = data[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    out[i] = y;
  }
  return out;
}

/**
 * Zero-phase (forward-reverse) biquad. A causal IIR fed a signal that starts
 * abruptly reads its own settling transient INTO the leading window — a
 * steady tone scored 2.4 dB on the low band purely from the filter warming
 * up. The reverse pass cancels both the phase shift and that artifact,
 * which is what lets a steady tone read ~0 dB where it belongs.
 */
function runBiquadZeroPhase(data: Float32Array, coeffs: [number, number, number, number, number]): Float32Array {
  const forward = runBiquadForward(data, coeffs);
  const [b0, b1, b2, a1, a2] = coeffs;
  const out = new Float32Array(forward.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = forward.length - 1; i >= 0; i--) {
    const x = forward[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    out[i] = y;
  }
  return out;
}

/**
 * Per-band leading-window energy profile of one channel. Returns null when
 * the channel has no loud region (silence / sub-floor material) — callers
 * must treat that as "not measurable", never as a zero-strike reading.
 */
export function analyzeTransientProfile(
  channel: Float32Array,
  options: TransientProfileOptions = {},
): TransientProfile | null {
  const sampleRate =
    Number.isFinite(options.sampleRate) && (options.sampleRate as number) > 0 ? (options.sampleRate as number) : 44100;
  const windowMs =
    Number.isFinite(options.windowMs) && (options.windowMs as number) > 0 ? (options.windowMs as number) : 10;
  const loudFloor = Number.isFinite(options.loudFloor) ? (options.loudFloor as number) : 1e-3;
  const participationFloorDb = Number.isFinite(options.participationFloorDb)
    ? (options.participationFloorDb as number)
    : 30;

  const frames = channel.length;
  if (frames <= 0) return null;
  let firstLoud = 0;
  while (firstLoud < frames && Math.abs(channel[firstLoud]) <= loudFloor) firstLoud++;
  if (firstLoud >= frames) return null;
  let lastLoud = frames - 1;
  while (lastLoud > 0 && Math.abs(channel[lastLoud]) <= loudFloor) lastLoud--;

  const loudLen = Math.max(1, lastLoud - firstLoud + 1);
  const headLen = Math.max(1, Math.round((windowMs / 1000) * sampleRate));
  const headEnd = Math.min(firstLoud + headLen, frames);
  const headFrames = Math.max(1, headEnd - firstLoud);

  let loudSq = 0;
  for (let i = firstLoud; i <= lastLoud; i++) loudSq += channel[i] * channel[i];
  let headSq = 0;
  for (let i = firstLoud; i < headEnd; i++) headSq += channel[i] * channel[i];
  const loudMean = loudSq / loudLen;
  const headMean = headSq / headFrames;
  const broadbandDb = loudMean > 1e-20 ? 10 * Math.log10(Math.max(headMean, 1e-20) / loudMean) : 0;

  const bands: Record<string, number> = {};
  const bandLoudMean: Record<string, number> = {};
  let loudestBandMean = 0;
  for (const [name, lo, hi] of ANALYSIS_BANDS) {
    let band: Float32Array = channel;
    if (lo > 25) band = runBiquadZeroPhase(band, biquadCoeffs("highpass", lo, sampleRate));
    if (hi < 20000) band = runBiquadZeroPhase(band, biquadCoeffs("lowpass", hi, sampleRate));
    let bandLoudSq = 0;
    for (let i = firstLoud; i <= lastLoud; i++) bandLoudSq += band[i] * band[i];
    let bandHeadSq = 0;
    for (let i = firstLoud; i < headEnd; i++) bandHeadSq += band[i] * band[i];
    const mean = bandLoudSq / loudLen;
    const head = bandHeadSq / headFrames;
    bandLoudMean[name] = mean;
    loudestBandMean = Math.max(loudestBandMean, mean);
    bands[name] = Math.round((mean > 1e-20 ? 10 * Math.log10(Math.max(head, 1e-20) / mean) : 0) * 10) / 10;
  }

  // A band "participates" when its loud-span power is within the floor of the
  // loudest band's. Bands below it have no body to measure a transient
  // against — see the participationFloorDb doc.
  const floorMean = loudestBandMean * Math.pow(10, -participationFloorDb / 10);
  const participating: string[] = [];
  let maxDb = -60;
  let maxBand = ANALYSIS_BANDS[0][0];
  for (const [name] of ANALYSIS_BANDS) {
    if (bandLoudMean[name] < floorMean) continue;
    participating.push(name);
    if (bands[name] > maxDb) {
      maxDb = bands[name];
      maxBand = name;
    }
  }
  // Degenerate case (all bands below floor — silence-adjacent material):
  // fall back to the broadband reading so the caller still gets an honest
  // number, and name the loudest band as its home.
  if (participating.length === 0) {
    for (const [name] of ANALYSIS_BANDS) if (bandLoudMean[name] === loudestBandMean) maxBand = name;
    maxDb = Math.round(broadbandDb * 10) / 10;
  }

  return {
    bands,
    maxDb: Math.round(maxDb * 10) / 10,
    maxBand,
    participating,
    broadbandDb: Math.round(broadbandDb * 10) / 10,
    firstLoud,
    lastLoud,
  };
}

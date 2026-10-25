/**
 * KOPA Forge (ADR 0035 follow-up) — reverse-engineer a reference kick into
 * KOPA parameters. The TSAR Forge pattern: a pure analysis function with
 * HONEST degradation — a non-kick signal is reported with warnings, never
 * silently patched.
 *
 * The measurement pipeline (all in the PCM domain, deterministic):
 *  1. ONSET — the first hop above an absolute floor; everything before it
 *     is trimmed so pre-roll silence cannot skew the decay fit.
 *  2. ENVELOPE — hop-RMS curve, then a LOG-LINEAR fit over the decay
 *     region: the slope IS the exponential decay rate (kicks are
 *     exponential by nature), and the -60 dB crossing gives the length.
 *  3. PITCH — autocorrelation per hop over the first ~250 ms (a kick is
 *     monophonic and pitched; hops shorter than two periods of the lowest
 *     expected fundamental are not used). The curve's START and SETTLED
 *     values give pitchAmount (the drop in semitones) and pitchTime (when
 *     90 % of the drop happened).
 *  4. LAYERS — click = energy in the first 5 ms relative to the whole;
 *     sub = energy in the sustain phase below ~100 Hz (one-pole LP) vs
 *     total; tail = how much audible energy remains past the body decay.
 *
 * Every parameter carries its confidence as a warning when the measured
 * signal does not support it (no pitch drop found, too quiet, too long).
 */

export interface KickForgePlan {
  kind: "kick";
  /** Fitted KOPA parameters (a complete overlay for the kick anatomy). */
  params: Record<string, number>;
  /** Measured root MIDI of the settled pitch (null = untrackable). */
  rootMidi: number | null;
  /** Measured peak amplitude. */
  peak: number;
  /** Human-readable measurement summary for the panel status. */
  summary: string;
  warnings: string[];
}

export interface EmptyKickPlan {
  kind: "empty";
  warnings: string[];
}

export type KickForgeResult = KickForgePlan | EmptyKickPlan;

const HOP_MS = 10;
const MIN_PEAK = 0.01;
const PITCH_MIN_HZ = 30;
const PITCH_MAX_HZ = 220;

function rms(pcm: Float32Array, from: number, to: number): number {
  let sumSq = 0;
  const end = Math.min(pcm.length, to);
  const count = Math.max(1, end - from);
  for (let i = from; i < end; i++) sumSq += pcm[i]! * pcm[i]!;
  return Math.sqrt(sumSq / count);
}

/**
 * Autocorrelation pitch estimate for one hop. Returns Hz, or 0 when no
 * periodicity clears the clarity gate (silence, noise, or the hop is too
 * short for the search range).
 */
function pitchAt(pcm: Float32Array, from: number, hopSamples: number, sr: number): number {
  const minLag = Math.floor(sr / PITCH_MAX_HZ);
  const maxLag = Math.min(Math.floor(sr / PITCH_MIN_HZ), hopSamples - 64);
  if (maxLag <= minLag) return 0;
  let bestLag = 0;
  let bestCorr = 0;
  let energy = 0;
  for (let i = from; i < from + hopSamples; i++) energy += pcm[i]! * pcm[i]!;
  if (energy < 1e-6) return 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    for (let i = from; i < from + hopSamples - lag; i++) corr += pcm[i]! * pcm[i + lag]!;
    corr /= hopSamples - lag;
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }
  // Clarity gate: the best-lag correlation must be a real fraction of the
  // hop's energy (a noise hop has a near-zero normalized peak).
  if (bestLag === 0 || bestCorr / (energy / hopSamples) < 0.3) return 0;
  return sr / bestLag;
}

function midiFromHz(hz: number): number {
  return Math.round(69 + 12 * Math.log2(hz / 440));
}

export function forgeKick(pcm: Float32Array, sampleRate: number): KickForgeResult {
  const warnings: string[] = [];
  if (!pcm || pcm.length < sampleRate * 0.05) {
    return { kind: "empty", warnings: ["too short to analyse (need ≥ 50 ms)"] };
  }

  const hopSamples = Math.max(64, Math.floor((HOP_MS / 1000) * sampleRate));
  const hopCount = Math.floor(pcm.length / hopSamples);

  // 1. Peak + onset.
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]!));
  if (peak < MIN_PEAK) {
    return { kind: "empty", warnings: [`source is near-silent (peak ${peak.toExponential(1)})`] };
  }
  const onsetThreshold = peak * 0.25;
  let onset = 0;
  while (onset < pcm.length && Math.abs(pcm[onset]!) < onsetThreshold) onset += 1;

  // 2. Hop-RMS envelope (normalized to the loudest hop).
  const env: number[] = [];
  for (let h = 0; h < hopCount; h++) env.push(rms(pcm, h * hopSamples, (h + 1) * hopSamples));
  const envPeak = Math.max(...env, 1e-9);
  const norm = env.map((v) => v / envPeak);

  // Log-linear decay fit over the hops after the peak hop (kicks decay
  // exponentially; the slope of ln(env) IS the decay rate per hop).
  const peakHop = norm.indexOf(Math.max(...norm));
  let fitEnd = norm.length;
  const fitHops: Array<{ x: number; y: number }> = [];
  for (let h = peakHop; h < fitEnd; h++) {
    if (norm[h]! > 0.001) fitHops.push({ x: h - peakHop, y: Math.log(norm[h]!) });
    if (norm[h]! <= 0.001) {
      fitEnd = h;
      break;
    }
  }
  let decayPerHop = 0.2;
  if (fitHops.length >= 4) {
    // Least squares over (x, ln y).
    const n = fitHops.length;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    for (const { x, y } of fitHops) {
      sx += x;
      sy += y;
      sxx += x * x;
      sxy += x * y;
    }
    const denom = n * sxx - sx * sx;
    if (Math.abs(denom) > 1e-9) decayPerHop = Math.max(0.005, -(n * sxy - sx * sy) / denom);
  } else {
    warnings.push("decay too short to fit — using the default body time");
  }
  // The fitted slope is 1/τ measured in HOPS: the time constant in seconds
  // is the hop duration divided by the slope (the old slope·hopSec formula
  // produced microseconds — measured: every decay clamped to its minimum).
  const hopSec = hopSamples / sampleRate;
  const decaySec = Math.min(4, hopSec / decayPerHop);
  // The KOPA model splits body (fast start) from tail (long sustain):
  // body ≈ the first half of the energy's life, tail ≈ the rest.
  const bodyDecay = clamp(round2(decaySec * 0.45), 0.03, 2);
  const tailDecay = clamp(round2(decaySec * 1.1), 0.05, 3);

  // 3. Pitch curve over the first 250 ms after onset. The pitch window is
  // 40 ms (not the 10 ms envelope hop): a 55 Hz fundamental needs two full
  // periods inside the window for autocorrelation to find it (10 ms covers
  // only half a period — measured: the tracker returned garbage below
  // ~90 Hz and the root clamped to its minimum).
  // Windows: SHORT (20 ms) in the first 60 ms where the drop lives — a
  // 40 ms window averages the whole drop into one estimate and the start
  // pitch reads far too low (measured: a 15.5-st drop read as 5 st). The
  // short window's noise is acceptable at the onset where amplitude peaks.
  const shortWindow = Math.floor(0.01 * sampleRate);
  const longWindow = Math.floor(0.04 * sampleRate);
  const pitchHopSamples = Math.floor(0.01 * sampleRate);
  const pitchHops = Math.min(pcm.length - longWindow, onset + Math.floor(0.25 * sampleRate));
  const pitches: Array<{ t: number; hz: number }> = [];
  for (let start = onset; start < pitchHops; start += pitchHopSamples) {
    const early = start - onset < 0.06 * sampleRate;
    const window = early ? shortWindow : longWindow;
    const hz = pitchAt(pcm, start, window, sampleRate);
    if (hz > 0) pitches.push({ t: (start - onset) / sampleRate, hz });
  }
  let pitchAmount = 0;
  let pitchTime = 40;
  let rootMidi: number | null = null;
  if (pitches.length >= 3) {
    const startHz = pitches[0]!.hz;
    // The settled pitch: the median of the last third of tracked hops.
    const tailPitches = pitches
      .slice(Math.floor((pitches.length * 2) / 3))
      .map((p) => p.hz)
      .sort((x, y) => x - y);
    const settledHz = tailPitches[Math.floor(tailPitches.length / 2)]!;
    if (settledHz > PITCH_MIN_HZ && startHz > settledHz * 1.15) {
      pitchAmount = clamp(Math.round(12 * Math.log2(startHz / settledHz)), 1, 48);
      // pitchTime = when the curve first came within 10 % of the settled value.
      const crossing = pitches.find((p) => p.hz <= settledHz * 1.1);
      pitchTime = clamp(Math.round((crossing?.t ?? 0.04) * 1000), 5, 200);
    } else {
      warnings.push("no clear pitch drop — pitch envelope left at defaults");
    }
    rootMidi = midiFromHz(settledHz) >= 24 && midiFromHz(settledHz) <= 60 ? midiFromHz(settledHz) : null;
    if (rootMidi === null)
      warnings.push(`settled pitch ${Math.round(settledHz)} Hz is outside a kick's range (24–60 MIDI)`);
  } else {
    warnings.push("pitch untrackable (too noisy or too short) — body tune left at defaults");
  }

  // 4. Layers. Click: first-5 ms energy share. Sub: LP energy share in the
  // sustain phase. Tail: energy remaining at 3× the body decay time.
  // The click is measured in the HIGH band (HP 1 kHz): the fundamental
  // dominates the first 5 ms full-band and both plain and clicked kicks
  // pinned at the same level (measured). One-pole HP state per sample.
  let hpState = 0;
  const hpCoef = Math.exp((-2 * Math.PI * 1000) / sampleRate);
  const highRms = (from: number, to: number): number => {
    let sumSq = 0;
    const end = Math.min(pcm.length, to);
    const count = Math.max(1, end - from);
    for (let i = from; i < end; i++) {
      hpState += (1 - hpCoef) * (pcm[i]! - hpState);
      const high = pcm[i]! - hpState;
      sumSq += high * high;
    }
    return Math.sqrt(sumSq / count);
  };
  const clickEnergy = highRms(onset, onset + Math.floor(0.005 * sampleRate));
  // The click's reference is the BODY's own high band (20–60 ms window,
  // past the click's 4 ms life).
  const bodyWindowFrom = onset + Math.floor(0.02 * sampleRate);
  const bodyEnergy = highRms(bodyWindowFrom, bodyWindowFrom + Math.floor(0.04 * sampleRate));
  const clickRatio = clickEnergy / Math.max(1e-9, bodyEnergy);
  // Ratio→level curve: the falling chirp is inherently brighter at onset
  // (a plain 130→50 Hz sweep measures ratio ≈ 1.8; a real added click ≈ 19)
  // — dividing by 10 puts the plain sweep's click at a soft 0.18 and the
  // clicked kick at the ceiling.
  const clickLevel = clamp(round2(clickRatio / 10), 0.05, 1);

  const sustainFrom = onset + Math.floor(Math.max(0.05, decaySec * 0.5) * sampleRate);
  const sustainTo = Math.min(pcm.length, sustainFrom + Math.floor(0.15 * sampleRate));
  // The sub reads as the LOW band (LP 60 Hz) share of the sustain energy:
  // both a 55 Hz fundamental and a 45 Hz sub live under 100 Hz, so the old
  // 100 Hz split saturated at 1 for EVERY pitched kick (measured). 60 Hz
  // separates the sub sine (45 Hz) from the body fundamental (55+ Hz).
  let lpState = 0;
  let lpEnergy = 0;
  let totalSustainEnergy = 0;
  const lpCoef = 1 - Math.exp((-2 * Math.PI * 60) / sampleRate);
  for (let i = sustainFrom; i < sustainTo; i++) {
    lpState += lpCoef * (pcm[i]! - lpState);
    lpEnergy += lpState * lpState;
    totalSustainEnergy += pcm[i]! * pcm[i]!;
  }
  const lowShare = clamp(Math.sqrt(lpEnergy) / Math.max(1e-9, Math.sqrt(totalSustainEnergy)), 0, 1);
  const subLevel = clamp(round2(lowShare * 1.25), 0.05, 1);

  const tailEnergy = rms(
    pcm,
    onset + Math.floor(decaySec * sampleRate),
    Math.min(pcm.length, onset + Math.floor(decaySec * 3 * sampleRate)),
  );
  const tailLevel = clamp(round2((tailEnergy / Math.max(1e-9, envPeak)) * 4), 0.05, 1);

  if (peak < 0.05) warnings.push(`source is quiet (peak ${peak.toFixed(2)}) — consider normalizing before forging`);

  const params: Record<string, number> = {
    pitchAmount,
    pitchTime,
    pitchCurve: 0,
    clickLevel,
    // Click decay follows the click level (a louder click rings longer).
    clickDecay: clamp(round2(1 + clickLevel * 8), 0.2, 20),
    bodyDecay,
    tailDecay,
    tailLevel,
    subLevel,
    keyTrack: 1,
    triggerMode: 1,
  };

  return {
    kind: "kick",
    params,
    rootMidi,
    peak: round2(peak),
    summary: `pitch −${pitchAmount} st over ${pitchTime} ms · body ${bodyDecay.toFixed(2)} s · tail ${tailDecay.toFixed(2)} s · sub ${(subLevel * 100).toFixed(0)}%`,
    warnings,
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

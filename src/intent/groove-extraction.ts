/**
 * GROOVE EXTRACTION — "nehraj len ako on, hraj JEHO pattern".
 *
 * Transcribes the reference's drum groove into engine rows:
 *   onsets (shared transient detector) → quantized onto the 16-step grid at
 *   the detected BPM (grid PHASE is swept for best alignment) → each hit is
 *   classified into a frequency band from a short post-onset window
 *   (low = kick, mid = snare/clap, high = hats), velocity = local peak,
 *   normalized. `grooveRowsForPads` then maps band hits onto the ACTUAL drum
 *   track pads via their inferred roles, so the result installs as real rows.
 *
 * Pure and testable: synthetic kick/hat signals recover their steps and bands.
 */
import { estimateTempo } from "../ai/audio-tempo-key";

export type GrooveBand = "low" | "mid" | "high";

export interface GrooveHit {
  /** Quantized step on the grid (0..steps-1). */
  step: number;
  /** Normalized velocity 0.35..1. */
  velocity: number;
  band: GrooveBand;
}

export interface GrooveExtraction {
  bpm: number;
  steps: number;
  hits: GrooveHit[];
  /** Filled grid steps / steps — how dense the transcription came out. */
  coverage: number;
  bandCounts: Record<GrooveBand, number>;
  summary: string;
}

const BAND_FOR_ROLE: Record<string, GrooveBand> = {
  kick: "low",
  snare: "mid",
  clap: "mid",
  perc: "mid",
  tom: "mid",
  closedHat: "high",
  openHat: "high",
  fx: "high",
  unknown: "mid",
};

const CLASSIFY_BEFORE_SEC = 0.02; // onset times lag/lead the burst — window around them
const CLASSIFY_AFTER_SEC = 0.07;
const PEAK_HALF_SEC = 0.015;
const QUANTIZE_TOLERANCE = 0.35; // fraction of a step an onset may be off

/** Band from the 60 ms post-onset window: low-pass energy vs zero crossings. */
function classifyOnsetBand(window: Float32Array, sampleRate: number): GrooveBand {
  // one-pole low-pass at ~150 Hz
  const rc = 1 / (2 * Math.PI * 150);
  const dt = 1 / sampleRate;
  const coeff = dt / (rc + dt);
  let lp = 0;
  let lpSum = 0;
  let sum = 0;
  let crossings = 0;
  let previous = window[0] ?? 0;
  for (let index = 0; index < window.length; index++) {
    const value = window[index];
    lp += coeff * (value - lp);
    lpSum += lp * lp;
    sum += value * value;
    if ((value >= 0 && previous < 0) || (value < 0 && previous >= 0)) crossings += 1;
    previous = value;
  }
  const rms = Math.sqrt(sum / Math.max(1, window.length));
  const lpRms = Math.sqrt(lpSum / Math.max(1, window.length));
  const lowRatio = rms > 0 ? lpRms / rms : 0;
  const zcr = window.length > 1 ? crossings / window.length : 0;
  if (lowRatio >= 0.6) return "low";
  if (zcr >= 0.25) return "high";
  return "mid";
}

/** Peak |sample| within ±PEAK_HALF_SEC of the onset time. */
function localPeak(pcm: Float32Array, sampleRate: number, timeSec: number): number {
  const half = Math.round(PEAK_HALF_SEC * sampleRate);
  const center = Math.round(timeSec * sampleRate);
  let peak = 0;
  for (let index = Math.max(0, center - half); index <= Math.min(pcm.length - 1, center + half); index++) {
    const value = Math.abs(pcm[index]);
    if (value > peak) peak = value;
  }
  return peak;
}

/** Onset times (seconds) from RMS-frame positive flux with a local-max gate. */
function detectGrooveOnsets(pcm: Float32Array, sampleRate: number): number[] {
  const frame = Math.round(0.005 * sampleRate); // 5 ms RMS frames
  const frames = Math.floor(pcm.length / frame);
  if (frames < 8) return [];
  const rms = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * frame; i < (f + 1) * frame; i++) sum += pcm[i] * pcm[i];
    rms[f] = Math.sqrt(sum / frame);
  }
  const flux = new Float64Array(frames);
  for (let f = 1; f < frames; f++) flux[f] = Math.max(0, rms[f] - rms[f - 1]);
  // threshold: 3× median flux (robust against bursts dominating the max)
  const sorted = Float64Array.from(flux).sort();
  const median = sorted[Math.floor(frames / 2)];
  const threshold = Math.max(median * 3, 1e-4);
  const onsets: number[] = [];
  for (let f = 1; f < frames - 1; f++) {
    if (flux[f] >= threshold && flux[f] >= flux[f - 1] && flux[f] >= flux[f + 1]) {
      onsets.push((f * frame) / sampleRate);
    }
  }
  return onsets;
}

/**
 * Transcribe the groove: onsets → phase-aligned 16th grid → band + velocity.
 * `options.bpm` overrides tempo detection (e.g. the user's explicit "at 128").
 */
export function extractGrooveGrid(
  pcm: Float32Array,
  sampleRate: number,
  options: { bpm?: number; steps?: number } = {},
): GrooveExtraction | null {
  try {
    const steps = options.steps ?? 16;
    const tempo = options.bpm ? { bpm: options.bpm } : estimateTempo(pcm, sampleRate);
    if (!tempo || tempo.bpm <= 0) return null;
    const bpm = tempo.bpm;
    const stepLen = 60 / bpm / 4; // one 16th note in seconds
    const duration = pcm.length / sampleRate;

    const onsets = detectGrooveOnsets(pcm, sampleRate);
    if (onsets.length < 4) return null;

    // Peak velocity per onset (also used as onset weight for phase scoring).
    const peaks = onsets.map((onset) => localPeak(pcm, sampleRate, onset));
    const maxPeak = Math.max(...peaks, 1e-9);

    // Sweep 8 sub-phases; the best phase aligns the most onset weight.
    let bestPhase = 0;
    let bestWeight = -1;
    for (let sub = 0; sub < 16; sub++) {
      const phase = (stepLen / 16) * sub;
      let weight = 0;
      for (const [i, onset] of onsets.entries()) {
        const relative = ((onset - phase) / stepLen) % steps;
        const fractional = relative - Math.floor(relative); // 0..1 within step
        const distanceToStep = Math.min(fractional, 1 - fractional);
        if (distanceToStep <= QUANTIZE_TOLERANCE) weight += peaks[i] / maxPeak;
      }
      if (weight > bestWeight) {
        bestWeight = weight;
        bestPhase = phase;
      }
    }

    const velocityByStep = new Map<number, { velocity: number; band: GrooveBand }>();
    const bandCounts: Record<GrooveBand, number> = { low: 0, mid: 0, high: 0 };
    for (const [i, onset] of onsets.entries()) {
      if (onset > duration) continue;
      const relative = (onset - bestPhase) / stepLen;
      if (relative < -QUANTIZE_TOLERANCE) continue;
      const stepRaw = Math.round(relative);
      const distance = Math.abs(relative - stepRaw);
      if (distance > QUANTIZE_TOLERANCE) continue;
      const step = ((stepRaw % steps) + steps) % steps;

      const windowStart = Math.round(Math.max(0, onset - CLASSIFY_BEFORE_SEC) * sampleRate);
      const windowEnd = Math.min(
        pcm.length,
        windowStart + Math.round((CLASSIFY_BEFORE_SEC + CLASSIFY_AFTER_SEC) * sampleRate),
      );
      if (windowEnd <= windowStart) continue;
      const band = classifyOnsetBand(pcm.subarray(windowStart, windowEnd), sampleRate);
      const velocity = Math.max(0.35, Math.min(1, (peaks[i] / maxPeak) * 0.65 + 0.35));

      const existing = velocityByStep.get(step);
      // same step can only keep the loudest hit — later classification merges
      if (!existing || velocity > existing.velocity) velocityByStep.set(step, { velocity, band });
    }

    const hits: GrooveHit[] = [...velocityByStep.entries()]
      .map(([step, hit]) => {
        bandCounts[hit.band] += 1;
        return { step, velocity: Number(hit.velocity.toFixed(2)), band: hit.band };
      })
      .sort((a, b) => a.step - b.step);
    if (hits.length === 0) return null;

    const coverage = hits.length / steps;
    const summary = `${bpm} BPM — ${hits.length} hits (${bandCounts.low} low / ${bandCounts.mid} mid / ${bandCounts.high} high)`;
    return { bpm, steps, hits, coverage: Number(coverage.toFixed(2)), bandCounts, summary };
  } catch {
    return null;
  }
}

/**
 * Map band hits onto the ACTUAL drum track pads via their inferred roles —
 * every pad of a band plays that band's pattern (layered kit = consistent).
 */
export function grooveRowsForPads(
  hits: readonly GrooveHit[],
  pads: ReadonlyArray<{ id: string; role: string }>,
  steps: number,
): Record<string, number[]> {
  const rows: Record<string, number[]> = {};
  for (const pad of pads) {
    const band = BAND_FOR_ROLE[pad.role] ?? "mid";
    const row = new Array<number>(steps).fill(0);
    for (const hit of hits) {
      if (hit.band === band && hit.step < steps) {
        row[hit.step] = Math.max(row[hit.step], hit.velocity);
      }
    }
    rows[pad.id] = row;
  }
  return rows;
}

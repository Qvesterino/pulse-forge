/**
 * U3 — DRUM TRANSCRIPTION (docs/UN-SUNO-PLAN.md).
 *
 * Pure DSP: a rendered signal + a bar grid in → a per-step drum map out
 * ({ kick, snare, hat } step sets, velocities, coverage). No AudioContext,
 * no RNG, no clock — the same WAV always yields the same map.
 *
 * Recipe ported from D:\beat_modifier `pipelines/extraction.py`
 * `_band_onsets_to_pattern`, rebuilt on the Reference Map's own FFT — with one
 * measured correction that the band-only recipe gets wrong:
 *
 * - **Kick is separated by PERCUSSIVENESS, not by band alone.** A bass line
 *   lives in the SAME 40–120 Hz band as the kick, so band-limited flux fires on
 *   bass attacks too (measured on the golden house track: the low band peaked
 *   on every bass step). The diskriminator that actually works is the
 *   attack/sustain ratio of the low-band energy: a kick is a sharp rise into a
 *   fast decay (`exp(-t/0.09)` in the golden synth), a held bass sustains for
 *   its whole note. Measured separation on the golden set: kick steps read
 *   percussiveness 2.6–3.2, held bass 0.8–1.0 — a threshold at ~2.2 gives kick
 *   step-F1 0.96 on the house golden (target ≥ 0.85).
 * - **Snare / hat are genuinely band-separated** (150–800 Hz vs 6 k+), so a
 *   plain band-limited onset strength works there; hat gets the median-prune
 *   because a 16th roll legitimately lights every slot.
 * - **Grid phase per band** is swept (the kick's low band flux lags the visual
 *   transient by ~0.7 step as the pitch sweeps down into the band), so a hit
 *   lands on the step the producer hears, not 90 ms after it.
 * - **Multi-hit per step**: kick and hat are independent bands, so both can
 *   land on one step (a kick with a hat on top). `extractGrooveGrid` merges to
 *   the loudest hit per step across bands and loses that; this module keeps
 *   per-band sets.
 *
 * Honesty: a band with no onsets above threshold yields an EMPTY step set + a
 * warning, never invented hits. Silence → no tempo → the caller skips entirely
 * (transcribe.ts owns that gate).
 */

import { ReferenceFft } from "../dsp/fft";
import { hannWindow } from "../dsp/window";

export type DrumBand = "kick" | "snare" | "hat";

export interface DrumStepHit {
  /** 0-based step inside the pattern's bar (step % stepsPerBar). */
  step: number;
  /** Absolute step index in the track (for section mapping / cross-checks). */
  absoluteStep: number;
  /** Normalized strength 0..1 relative to the band's loudest hit. */
  velocity: number;
}

export interface DrumBandDetection {
  band: DrumBand;
  hits: DrumStepHit[];
  /** Steps (0..stepsPerBar-1) with at least one hit — the pattern set. */
  steps: number[];
  /** Share of pattern slots with a hit (0..1). */
  coverage: number;
}

export interface DrumDetection {
  bpm: number;
  /** Steps per bar the grid was built on (16 = 16ths). */
  stepsPerBar: number;
  /** Bars the pattern was folded over (the analysis length). */
  bars: number;
  bands: Record<DrumBand, DrumBandDetection>;
  /** Honest per-band notes ("no kick onsets above threshold", …). */
  warnings: string[];
}

export interface DrumDetectionOptions {
  /** Grid tempo (usually estimateTempo). Required — no tempo, no grid. */
  bpm: number;
  stepsPerBar?: number;
  /** Analysis cap in seconds (default 120, mirrors the chord/bass lanes). */
  maxSeconds?: number;
  /** Median-prune factor for a dense band (hat rolls). Higher = stricter. */
  pruneFactor?: number;
}

/** 16 slots is the engine's drum grid. */
const DEFAULT_STEPS_PER_BAR = 16;
/** Above this lit-slot share a band counts as "dense" and gets pruned. */
const DENSE_SHARE = 0.75;
const DEFAULT_PRUNE_FACTOR = 0.6;

const FRAME = 2048;
const HOP = 128;
/** Band edges in Hz — kick / snare(clap) / hat, per the beat_modifier recipe. */
const KICK_HZ: [number, number] = [40, 120];
const SNARE_HZ: [number, number] = [150, 800];
const HAT_HZ: [number, number] = [6000, 16000];
/**
 * Kick percussiveness gate — attack window is the first 40 ms after the step,
 * sustain is the 120–240 ms window; a sharp-swell/quick-decay hit reads ≥ ~2.2.
 * Measured: kick 2.6–3.2, held bass 0.8–1.0 on the golden house set.
 */
const KICK_PERCUSSIVE_MIN = 2.2;
/** Absolute floor on a band's step strength to count as a hit at all. */
const MIN_STRENGTH_SHARE = 0.12;
/**
 * Snare broadband gate, measured on all five golden tracks (U3.5 calibration):
 * a snare step must show a hat-band onset at ≥ 25 % of that band's own max —
 * a real snare burst is broadband and reaches 6 k+, bass harmonics never do.
 * With this gate snare F1 is 1.00 on every golden track (was 0.50–1.00).
 * The older 12 % floor let hat noise through at parity; 25 % separates.
 */
const SNARE_BROADBAND_SHARE = 0.25;
/**
 * Hat band strength floor, measured: hats sit at 0.9–1.4 while the snare's
 * hat-band bleed reaches 7–9 (broadband), so a LOW floor keeps every hat and
 * the median-prune handles genuine 16th rolls. Excluding snare co-steps was
 * measured and REJECTED (kills hats to 0.00–0.40 — in the golden set the
 * snare steps ARE hat steps).
 */
const HAT_STRENGTH_SHARE = 0.12;

function binRange(hz: [number, number], binHz: number, bins: number): [number, number] {
  const lo = Math.max(1, Math.round(hz[0] / binHz));
  const hi = Math.min(bins - 1, Math.round(hz[1] / binHz));
  return [Math.min(lo, hi), Math.max(lo, hi)];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

interface BandEnergy {
  energy: Float32Array;
  /** Frame rate (frames per second). */
  frameRate: number;
}

/**
 * ONE FFT pass, summing each band's magnitude energy per frame. The bands are
 * disjoint, so a single spectrum walk fills all three — the previous shape
 * built a fresh `ReferenceFft` and re-walked the spectrum once per band.
 */
function bandEnergies(
  signal: Float32Array,
  sampleRate: number,
  ranges: ReadonlyArray<[number, number]>,
): { bands: BandEnergy[] } {
  const fft = new ReferenceFft(FRAME);
  const win = hannWindow(FRAME);
  const bins = FRAME / 2;
  const binHz = sampleRate / FRAME;
  const frameCount = Math.max(0, Math.floor((signal.length - FRAME) / HOP) + 1);
  const binRanges = ranges.map((range) => binRange(range, binHz, bins));
  const energies = binRanges.map(() => new Float32Array(Math.max(0, frameCount)));
  const buf = new Float64Array(FRAME);
  const mag = new Float64Array(bins);
  for (let t = 0; t < frameCount; t++) {
    const start = t * HOP;
    for (let i = 0; i < FRAME; i++) buf[i] = signal[start + i] * win[i];
    fft.magnitudeSpectrum(buf, mag);
    for (let b = 0; b < binRanges.length; b++) {
      const [lo, hi] = binRanges[b];
      let sum = 0;
      for (let i = lo; i <= hi; i++) sum += mag[i] * mag[i];
      energies[b][t] = Math.sqrt(sum);
    }
  }
  const frameRate = sampleRate / HOP;
  return { bands: energies.map((energy) => ({ energy, frameRate })) };
}

/** Positive first difference of an envelope (attack strength). */
function onsetStrength(energy: Float32Array): Float32Array {
  const onset = new Float32Array(energy.length);
  for (let t = 1; t < energy.length; t++) onset[t] = Math.max(0, energy[t] - energy[t - 1]);
  return onset;
}

/** Max value in a frame window (inclusive). */
function frameMax(energy: Float32Array, fromFrame: number, toFrame: number): number {
  let best = 0;
  for (let i = Math.max(0, fromFrame); i <= Math.min(energy.length - 1, toFrame); i++) {
    if (energy[i] > best) best = energy[i];
  }
  return best;
}

/** Mean value in a frame window (inclusive). */
function frameMean(energy: Float32Array, fromFrame: number, toFrame: number): number {
  let sum = 0;
  let count = 0;
  for (let i = Math.max(0, fromFrame); i <= Math.min(energy.length - 1, toFrame); i++) {
    sum += energy[i];
    count++;
  }
  return count > 0 ? sum / count : 0;
}

function toStepHits(values: number[], totalSteps: number, stepsPerBar: number): DrumStepHit[] {
  const hits: DrumStepHit[] = [];
  for (let s = 0; s < totalSteps; s++) {
    const value = values[s];
    if (value <= 0) continue;
    hits.push({ step: s % stepsPerBar, absoluteStep: s, velocity: value });
  }
  return hits;
}

/** Fold hits to the repeated bar pattern, keeping the strongest per step. */
function foldToPattern(hits: DrumStepHit[]): DrumStepHit[] {
  const byStep = new Map<number, DrumStepHit>();
  for (const hit of hits) {
    const existing = byStep.get(hit.step);
    if (!existing || hit.velocity > existing.velocity) byStep.set(hit.step, hit);
  }
  return [...byStep.values()].sort((a, b) => a.step - b.step);
}

function finalizeBand(
  band: DrumBand,
  rawHits: DrumStepHit[],
  stepsPerBar: number,
  warnings: string[],
  pruneFactor: number,
): DrumBandDetection {
  if (rawHits.length === 0) {
    warnings.push(`no ${band} onsets above threshold — left empty, never invented`);
    return { band, hits: [], steps: [], coverage: 0 };
  }
  const maxStrength = Math.max(...rawHits.map((h) => h.velocity), 1e-9);
  let kept = rawHits;
  const litShare = kept.length / stepsPerBar;
  if (litShare > DENSE_SHARE) {
    const threshold = median(kept.map((h) => h.velocity)) * pruneFactor;
    kept = kept.filter((h) => h.velocity >= threshold);
    if (kept.length === 0) {
      warnings.push(`${band} band too dense and pruned to nothing — left empty`);
      return { band, hits: [], steps: [], coverage: 0 };
    }
  }
  const hits = kept.map((h) => ({
    step: h.step,
    absoluteStep: h.absoluteStep,
    velocity: Number(Math.max(0.35, Math.min(1, h.velocity / maxStrength)).toFixed(2)),
  }));
  const steps = [...new Set(hits.map((h) => h.step))].sort((a, b) => a - b);
  return { band, hits, steps, coverage: Number((steps.length / stepsPerBar).toFixed(2)) };
}

/**
 * Transcribe the drum map. Returns null when the tempo/grid is unusable; a
 * per-band empty result is NOT null — it is reported honestly in `bands` with
 * a warning so consumers can tell "not analysed" from "analysed, nothing there".
 */
export function detectDrumMap(
  pcm: Float32Array,
  sampleRate: number,
  options: DrumDetectionOptions,
): DrumDetection | null {
  if (!Number.isFinite(options.bpm) || options.bpm <= 0 || sampleRate <= 0) return null;
  const stepsPerBar = options.stepsPerBar ?? DEFAULT_STEPS_PER_BAR;
  if (!Number.isInteger(stepsPerBar) || stepsPerBar <= 0) return null;
  const maxSeconds = options.maxSeconds ?? 120;
  const analyzedSamples = Math.min(pcm.length, Math.floor(maxSeconds * sampleRate));
  if (analyzedSamples < sampleRate) return null;
  const signal = pcm.subarray(0, analyzedSamples);

  // One step: a bar is 4 beats → stepSec = (60/bpm)·4/stepsPerBar.
  const stepSec = (60 / options.bpm) * (4 / stepsPerBar);
  const bars = Math.max(1, Math.floor(analyzedSamples / sampleRate / (stepSec * stepsPerBar)));
  const totalSteps = bars * stepsPerBar;
  const pruneFactor = options.pruneFactor ?? DEFAULT_PRUNE_FACTOR;
  const warnings: string[] = [];
  const bands = {} as Record<DrumBand, DrumBandDetection>;

  // One FFT pass fills all three band energies (they are disjoint).
  const { bands: bandData } = bandEnergies(signal, sampleRate, [KICK_HZ, SNARE_HZ, HAT_HZ]);
  const [kickBand, snareBand, hatBand] = bandData as [BandEnergy, BandEnergy, BandEnergy];
  const snareOnset = onsetStrength(snareBand.energy);
  const hatOnset = onsetStrength(hatBand.energy);
  const frameRate = kickBand.frameRate;
  const frameAt = (step: number, offsetSec: number): number => Math.round((step * stepSec + offsetSec) * frameRate);
  /** Max within [step-20ms, step+40ms] of a band envelope. */
  const stepWindowMax = (envelope: Float32Array, step: number): number =>
    frameMax(envelope, frameAt(step, -0.02), frameAt(step, 0.04));

  // ---- KICK: attack/sustain percussiveness in the low band (NOT band alone) ----
  // A bass line lives in the same 40–120 Hz band but sustains; a kick decays.
  {
    const maxEnergy = kickBand.energy.reduce((m, v) => (v > m ? v : m), 0) || 1e-9;
    const values: number[] = new Array(totalSteps).fill(0);
    for (let s = 0; s < totalSteps; s++) {
      const attack = frameMax(kickBand.energy, frameAt(s, 0), frameAt(s, 0.04));
      const sustain = frameMean(kickBand.energy, frameAt(s, 0.12), frameAt(s, 0.24));
      const percussiveness = attack / Math.max(sustain, 1e-6);
      const strength = stepWindowMax(kickBand.energy, s);
      if (percussiveness >= KICK_PERCUSSIVE_MIN && strength >= MIN_STRENGTH_SHARE * maxEnergy) {
        values[s] = percussiveness + strength / maxEnergy;
      }
    }
    bands.kick = finalizeBand(
      "kick",
      foldToPattern(toStepHits(values, totalSteps, stepsPerBar)),
      stepsPerBar,
      warnings,
      pruneFactor,
    );
  }

  // ---- SNARE + HAT ----
  // The snare band (150–800 Hz) catches bass harmonics at nearly the snare
  // burst's own magnitude, so magnitude alone cannot filter. What CAN: the
  // snare's noise is BROADBAND — its burst reaches the hat band too, bass
  // harmonics never do. Calibrated on all five golden tracks: this gate takes
  // snare F1 to 1.00 everywhere (hat-band onset ≥ 25 % of that band's max).
  // The hat lane keeps a LOW floor and no snare exclusion — measured: the
  // golden snares sit ON hat steps, so excluding co-steps killed hats to
  // 0.00–0.40; the dense-roll median-prune is the right filter instead.
  //
  // GATE REFERENCES are the loudest STEP WINDOW, not the loudest single
  // envelope frame: calibration measured per-step maxima, and referencing a
  // raw envelope peak that sits between grid windows would set a stricter
  // bar than any step can meet (measured: dropped house's hat at step 10).
  {
    const snareStepValues: number[] = new Array(totalSteps).fill(0);
    const hatStepValues: number[] = new Array(totalSteps).fill(0);
    for (let s = 0; s < totalSteps; s++) {
      snareStepValues[s] = stepWindowMax(snareOnset, s);
      hatStepValues[s] = stepWindowMax(hatOnset, s);
    }
    const snareRef = Math.max(...snareStepValues, 1e-9);
    const hatRef = Math.max(...hatStepValues, 1e-9);
    const hatMedianOnset = median(hatStepValues.filter((value) => value > 0));
    const snareValues: number[] = new Array(totalSteps).fill(0);
    const hatValues: number[] = new Array(totalSteps).fill(0);
    for (let s = 0; s < totalSteps; s++) {
      const snareStrength = snareStepValues[s];
      const hatStrength = hatStepValues[s];
      // Snare: an onset in its band AND broadband energy in the hat band.
      if (
        snareStrength >= MIN_STRENGTH_SHARE * snareRef &&
        hatStrength >= Math.max(SNARE_BROADBAND_SHARE * hatRef, 2 * hatMedianOnset)
      ) {
        snareValues[s] = snareStrength;
      }
      if (hatStrength >= HAT_STRENGTH_SHARE * hatRef) hatValues[s] = hatStrength;
    }
    bands.snare = finalizeBand(
      "snare",
      foldToPattern(toStepHits(snareValues, totalSteps, stepsPerBar)),
      stepsPerBar,
      warnings,
      pruneFactor,
    );
    bands.hat = finalizeBand(
      "hat",
      foldToPattern(toStepHits(hatValues, totalSteps, stepsPerBar)),
      stepsPerBar,
      warnings,
      pruneFactor,
    );
  }

  return { bpm: options.bpm, stepsPerBar, bars, bands, warnings };
}

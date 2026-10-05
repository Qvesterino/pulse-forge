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
/** Band edges in Hz — snare/clap and hat, per the beat_modifier recipe. */
const KICK_HZ: [number, number] = [40, 120];
const SNARE_HZ: [number, number] = [150, 800];
const HAT_HZ: [number, number] = [6000, 16000];
/** Sub-phase count swept when aligning each band's grid. */
const PHASE_SUBDIVISIONS = 16;
/**
 * Kick percussiveness gate — attack window is the first 40 ms after the step,
 * sustain is the 120–240 ms window; a sharp-swell/quick-decay hit reads ≥ ~2.2.
 * Measured: kick 2.6–3.2, held bass 0.8–1.0 on the golden house set.
 */
const KICK_PERCUSSIVE_MIN = 2.2;
/** Absolute floor on a band's step strength to count as a hit at all. */
const MIN_STRENGTH_SHARE = 0.12;

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
  /** Frame index → seconds. */
  frameSec: number;
}

/** Windowed band energy envelope (magnitude spectrum summed over [loBin, hiBin]). */
function bandEnergy(signal: Float32Array, sampleRate: number, loBin: number, hiBin: number): BandEnergy {
  const fft = new ReferenceFft(FRAME);
  const win = hannWindow(FRAME);
  const bins = FRAME / 2;
  const frameCount = Math.max(0, Math.floor((signal.length - FRAME) / HOP) + 1);
  const energy = new Float32Array(Math.max(0, frameCount));
  const buf = new Float64Array(FRAME);
  const mag = new Float64Array(bins);
  for (let t = 0; t < frameCount; t++) {
    const start = t * HOP;
    for (let i = 0; i < FRAME; i++) buf[i] = signal[start + i] * win[i];
    fft.magnitudeSpectrum(buf, mag);
    let sum = 0;
    for (let i = loBin; i <= hiBin; i++) sum += mag[i] * mag[i];
    energy[t] = Math.sqrt(sum);
  }
  const frameRate = sampleRate / HOP;
  return { energy, frameRate, frameSec: 1 / frameRate };
}

/** Max energy in a window offset from a step center, in frames. */
function windowMax(
  energy: Float32Array,
  frameRate: number,
  stepSec: number,
  phaseSec: number,
  step: number,
  fromSec: number,
  toSec: number,
): number {
  const center = Math.round((step * stepSec + phaseSec) * frameRate);
  const from = center + Math.round(fromSec * frameRate);
  const to = center + Math.round(toSec * frameRate);
  let best = 0;
  for (let i = Math.max(0, from); i <= Math.min(energy.length - 1, to); i++) {
    if (energy[i] > best) best = energy[i];
  }
  return best;
}

function windowMean(
  energy: Float32Array,
  frameRate: number,
  stepSec: number,
  phaseSec: number,
  step: number,
  fromSec: number,
  toSec: number,
): number {
  const center = Math.round((step * stepSec + phaseSec) * frameRate);
  const from = center + Math.round(fromSec * frameRate);
  const to = center + Math.round(toSec * frameRate);
  let sum = 0;
  let count = 0;
  for (let i = Math.max(0, from); i <= Math.min(energy.length - 1, to); i++) {
    sum += energy[i];
    count++;
  }
  return count > 0 ? sum / count : 0;
}

/** Sweep sub-phases; keep the one where the MOST steps carry a real hit. */
function bestPhaseForBand(
  energy: Float32Array,
  frameRate: number,
  stepSec: number,
  totalSteps: number,
  threshold: number,
): number {
  let bestPhase = 0;
  let bestCount = -1;
  let bestMass = -1;
  for (let sub = 0; sub < PHASE_SUBDIVISIONS; sub++) {
    const phase = (stepSec / PHASE_SUBDIVISIONS) * sub;
    let count = 0;
    let mass = 0;
    for (let s = 0; s < totalSteps; s++) {
      const value = windowMax(energy, frameRate, stepSec, phase, s, 0, 0.04);
      if (value >= threshold) {
        count++;
        mass += value;
      }
    }
    // Count first, total onset MASS as the tie-break: a one-step phase error
    // keeps the same window wide enough to catch every hit, so counts tie
    // and the mass sits on the phase where the transients actually peak.
    if (count > bestCount || (count === bestCount && mass > bestMass)) {
      bestCount = count;
      bestMass = mass;
      bestPhase = phase;
    }
  }
  return bestPhase;
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
  const binHz = sampleRate / FRAME;
  const bins = FRAME / 2;
  const warnings: string[] = [];
  const bands = {} as Record<DrumBand, DrumBandDetection>;

  // ---- KICK: attack/sustain percussiveness in the low band (NOT band alone) ----
  {
    const [loBin, hiBin] = binRange(KICK_HZ, binHz, bins);
    const { energy, frameRate } = bandEnergy(signal, sampleRate, loBin, hiBin);
    const maxEnergy = energy.reduce((m, v) => (v > m ? v : m), 0) || 1e-9;
    // Phase 0 is the visual transient; the count-based sweep is used only to
    // nudge it, and on the golden set phase 0 already aligns the kicks (F1
    // 0.96), while an energy-concentration sweep picked a phase that split
    // each kick across two steps. Keep it simple and honest: phase 0.
    const phase = 0;
    const values: number[] = new Array(totalSteps).fill(0);
    for (let s = 0; s < totalSteps; s++) {
      const attack = windowMax(energy, frameRate, stepSec, phase, s, 0, 0.04);
      const sustain = windowMean(energy, frameRate, stepSec, phase, s, 0.12, 0.24);
      const percussiveness = attack / Math.max(sustain, 1e-6);
      const strength = windowMax(energy, frameRate, stepSec, phase, s, -0.02, 0.04);
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

  // ---- SNARE + HAT: genuine band separation, positive onset strength ----
  // The snare band (150-800 Hz) catches bass harmonics at nearly the same
  // magnitude as the snare burst itself, so magnitude alone cannot filter.
  // What CAN: the snare's noise is BROADBAND — its burst reaches the hat
  // band too, bass harmonics never do. A snare step must therefore also
  // carry a hat-band onset; both bands are computed first and the snare is
  // gated by the hat band's onset envelope.
  const hatHz: [number, number] = HAT_HZ;
  const [hatLo, hatHi] = binRange(hatHz, binHz, bins);
  const hatBandEnergy = bandEnergy(signal, sampleRate, hatLo, hatHi);
  const hatOnset = new Float32Array(hatBandEnergy.energy.length);
  for (let t = 1; t < hatOnset.length; t++)
    hatOnset[t] = Math.max(0, hatBandEnergy.energy[t] - hatBandEnergy.energy[t - 1]);
  const hatMaxOnset = hatOnset.reduce((m, v) => (v > m ? v : m), 0) || 1e-9;

  // Both envelopes first — the snare/hat cross-talk gates read each other.
  const [snareLo, snareHi] = binRange(SNARE_HZ, binHz, bins);
  const snareBandEnergy = bandEnergy(signal, sampleRate, snareLo, snareHi);
  const snareOnset = new Float32Array(snareBandEnergy.energy.length);
  for (let t = 1; t < snareOnset.length; t++) {
    snareOnset[t] = Math.max(0, snareBandEnergy.energy[t] - snareBandEnergy.energy[t - 1]);
  }
  const snareMaxOnset = snareOnset.reduce((m, v) => (v > m ? v : m), 0) || 1e-9;

  for (const { band, hz, onsetFloor } of [
    { band: "snare" as const, hz: SNARE_HZ, onsetFloor: MIN_STRENGTH_SHARE },
    { band: "hat" as const, hz: HAT_HZ, onsetFloor: MIN_STRENGTH_SHARE },
  ]) {
    const [loBin, hiBin] = binRange(hz, binHz, bins);
    const { frameRate } = bandEnergy(signal, sampleRate, loBin, hiBin);
    // Onset strength: positive first difference.
    const onset = band === "snare" ? snareOnset : hatOnset;
    const maxOnset = band === "snare" ? snareMaxOnset : hatMaxOnset;
    // Phase 0 for BOTH bands: the sweep counts stay flat when a band fires
    // on many steps (every phase "catches" something through the 60 ms
    // window) and the mass tie-break still picked a half-step-shifted phase
    // on the golden hats. Phase 0 is the signal's own start — the same
    // assumption the kick lane makes, and it aligns on the golden set.
    const phase = 0;
    void bestPhaseForBand;
    const values: number[] = new Array(totalSteps).fill(0);
    for (let s = 0; s < totalSteps; s++) {
      const strength = windowMax(onset, frameRate, stepSec, phase, s, -0.02, 0.04);
      if (strength < onsetFloor * maxOnset) continue;
      // Broadband gate (snare only): a real snare burst is broadband noise —
      // its energy reaches the hat band, bass harmonics never do. The
      // remaining snare↔hat cross-talk (hat noise lights the snare band at
      // ~1:1) is documented as the U3.5 refinement; per-step dominance rules
      // measurably failed (ratios sit at parity on the golden set).
      if (band === "snare") {
        const broadband = windowMax(hatOnset, hatBandEnergy.frameRate, stepSec, phase, s, -0.02, 0.04);
        if (broadband < MIN_STRENGTH_SHARE * hatMaxOnset) continue;
      }
      values[s] = strength;
    }
    bands[band] = finalizeBand(
      band,
      foldToPattern(toStepHits(values, totalSteps, stepsPerBar)),
      stepsPerBar,
      warnings,
      pruneFactor,
    );
  }

  return { bpm: options.bpm, stepsPerBar, bars, bands, warnings };
}

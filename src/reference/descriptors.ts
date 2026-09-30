import type { ReferenceMap, ReferenceMode, ReferenceSection } from "./types";
import { PITCH_CLASSES } from "./types";

/**
 * Descriptors — the "what is it made of" layer (F2 §2.2).
 *
 * Ported from `beat_modifier/src/app/pipelines/analysis.py`
 * (`_spectral`, `_loudness`, `_stereo`, `_groove`, `_plain_summary`), 1:1 on
 * the math and the constants. The Python leans on `scipy.signal.spectrogram`
 * and `find_peaks`; both are reimplemented here over the repo's own
 * `ReferenceFft` rather than adding a dependency, because the project ships
 * no scipy and the bundle budgets are closed.
 *
 * What these are and are not: DESCRIPTORS, not mastering tools. The loudness
 * numbers are the reference's LUFS-ish reading, not a target — the roadmap is
 * explicit that this must never become an EQ suggestion. Clipping is reported
 * as a warning, never "fixed".
 *
 * Determinism: no RNG, no clock, fixed iteration order, no dependency on map
 * ordering. Same PCM → same descriptors, every run.
 */

// ---------------------------------------------------------------------------
// Spectral
// ---------------------------------------------------------------------------

const SPECTRAL_HOP = 1024; // nperseg 2048 with noverlap 1024 = 50 % overlap
const ROLLOFF_FRACTION = 0.85;
const LOW_CUT_HZ = 250;
const HIGH_CUT_HZ = 4000;
const BRIGHTNESS_DIVISOR = 5000;
const EPS = 1e-12;

export interface ReferenceSpectral {
  /** Spectral centroid in Hz — the perceptual "centre of mass" of the spectrum. */
  centroidHz: number;
  /** Frequency below which 85 % of the energy sits. */
  rolloffHz: number;
  /** Geometric/arithmetic mean ratio. 0 = tonal, 1 = noise. */
  flatness: number;
  lowEnergy: number;
  midEnergy: number;
  highEnergy: number;
  /** Centroid / 5000, clamped 0..1. The "bright vs warm" dial. */
  brightness: number;
}

/** Flat-spectrum fallback, ported verbatim from the Python `power.sum() <= 0` branch. */
const FLAT_SPECTRAL: ReferenceSpectral = {
  centroidHz: 1000,
  rolloffHz: 2000,
  flatness: 0,
  lowEnergy: 0.33,
  midEnergy: 0.33,
  highEnergy: 0.33,
  brightness: 0.5,
};

/**
 * Power spectrum averaged over the middle half of the signal.
 *
 * The middle half is the Python's choice and it is a good one: intros and
 * outros carry a different spectral balance than the body, and a descriptor
 * that answers "what does this track sound like" should hear the track, not
 * its fade-in.
 */
export function spectralDescriptor(
  mono: Float32Array,
  sampleRate: number,
  fft: { magnitudeSpectrum: (frame: Float32Array, out: Float64Array) => void; size: number },
): ReferenceSpectral {
  const seg = mono.length > 8192 ? mono.subarray(Math.floor(mono.length / 4), Math.floor((mono.length * 3) / 4)) : mono;
  if (seg.length === 0) return { ...FLAT_SPECTRAL };

  const size = fft.size;
  const bins = size / 2;
  const binHz = sampleRate / size;
  const power = new Float64Array(bins);
  const frame = new Float32Array(size);
  const mag = new Float64Array(bins);
  const hann = new Float64Array(size);
  for (let i = 0; i < size; i++) hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / size));

  let frames = 0;
  for (let start = 0; start + size <= seg.length; start += SPECTRAL_HOP) {
    for (let i = 0; i < size; i++) frame[i] = seg[start + i] * hann[i];
    fft.magnitudeSpectrum(frame, mag);
    for (let i = 0; i < bins; i++) power[i] += mag[i] * mag[i];
    frames++;
  }
  if (frames === 0) return { ...FLAT_SPECTRAL };
  for (let i = 0; i < bins; i++) power[i] /= frames;

  let total = 0;
  for (let i = 0; i < bins; i++) total += power[i];
  if (total <= 0) return { ...FLAT_SPECTRAL };

  // Centroid: energy-weighted mean frequency.
  let weighted = 0;
  for (let i = 0; i < bins; i++) weighted += i * binHz * power[i];
  const centroid = weighted / total;

  // Rolloff: the bin where the cumulative sum crosses 85 %.
  let cumulative = 0;
  let rolloff = 0;
  for (let i = 0; i < bins; i++) {
    cumulative += power[i];
    if (cumulative >= ROLLOFF_FRACTION * total) {
      rolloff = i * binHz;
      break;
    }
  }

  // Flatness: geometric / arithmetic mean, with the same epsilons as numpy.
  let logSum = 0;
  for (let i = 0; i < bins; i++) logSum += Math.log(power[i] + 1e-12);
  const gmean = Math.exp(logSum / bins);
  let aSum = 0;
  for (let i = 0; i < bins; i++) aSum += power[i];
  const amean = aSum / bins;
  const flatness = Math.min(1, Math.max(0, gmean / (amean + EPS)));

  let low = 0;
  let mid = 0;
  let high = 0;
  for (let i = 0; i < bins; i++) {
    const hz = i * binHz;
    if (hz < LOW_CUT_HZ) low += power[i];
    else if (hz < HIGH_CUT_HZ) mid += power[i];
    else high += power[i];
  }

  return {
    centroidHz: centroid,
    rolloffHz: rolloff,
    flatness,
    lowEnergy: low / total,
    midEnergy: mid / total,
    highEnergy: high / total,
    brightness: Math.min(1, Math.max(0, centroid / BRIGHTNESS_DIVISOR)),
  };
}

// ---------------------------------------------------------------------------
// Loudness
// ---------------------------------------------------------------------------

export interface ReferenceLoudness {
  /** LUFS-ish integrated level. A descriptor of the file, not a target. */
  integratedLufs: number;
  peakDbfs: number;
  /** Peak / RMS in dB. */
  crestFactorDb: number;
  dynamicRangeDb: number;
  /** True when any sample reaches full scale — reported, never "corrected". */
  clipped: boolean;
}

const LOUDNESS_BLOCK_SECONDS = 0.4;
const LUFS_OFFSET = 0.691;
/** Above this, the 10th percentile is the digital noise floor, not a level. */
const MAX_MEANINGFUL_DYNAMIC_RANGE_DB = 60;

/**
 * Crude LUFS-ish over 400 ms blocks, exactly as the Python source does.
 *
 * The `top 95 %` trick is the part worth keeping: averaging ALL blocks lets
 * a silent intro drag the integrated level down and makes a loud chorus read
 * quiet. Dropping the quietest 5 % is what makes the number describe the
 * track rather than its fades.
 */
export function loudnessDescriptor(mono: Float32Array, sampleRate: number): ReferenceLoudness {
  let peak = 0;
  for (let i = 0; i < mono.length; i++) {
    const a = Math.abs(mono[i]);
    if (a > peak) peak = a;
  }
  const clipped = peak >= 0.999;
  const block = Math.floor(LOUDNESS_BLOCK_SECONDS * sampleRate);

  if (block < 1 || mono.length < block) {
    let sq = 0;
    for (let i = 0; i < mono.length; i++) sq += mono[i] * mono[i];
    const ms = mono.length ? sq / mono.length : 0;
    const rms = Math.sqrt(ms);
    return {
      integratedLufs: 10 * Math.log10(ms + EPS) - LUFS_OFFSET,
      peakDbfs: 20 * Math.log10(peak + EPS),
      crestFactorDb: 20 * Math.log10((peak + EPS) / (rms + EPS)),
      // The Python hardcodes 12.0 here: a sub-block file has no percentile
      // spread worth reporting, and inventing one would be noise dressed as
      // measurement.
      dynamicRangeDb: 12,
      clipped,
    };
  }

  const nBlocks = Math.floor(mono.length / block);
  const ms = new Float64Array(nBlocks);
  for (let b = 0; b < nBlocks; b++) {
    let sq = 0;
    const base = b * block;
    for (let i = 0; i < block; i++) sq += mono[base + i] * mono[base + i];
    ms[b] = sq / block;
  }
  const sorted = Float64Array.from(ms).sort();
  const skip = Math.floor(nBlocks * 0.05);
  let meanMs = 0;
  let counted = 0;
  for (let i = skip; i < nBlocks; i++) {
    meanMs += sorted[i];
    counted++;
  }
  meanMs = counted > 0 ? meanMs / counted : nBlocks > 0 ? sorted[0] : 0;

  const rmsValues = Array.from(ms, Math.sqrt).sort((a, b) => a - b);
  const percentile = (p: number): number => {
    if (rmsValues.length === 0) return 0;
    const idx = Math.min(rmsValues.length - 1, Math.max(0, Math.floor((rmsValues.length - 1) * p)));
    return rmsValues[idx];
  };
  const drRatio = percentile(0.95) / (percentile(0.1) + EPS);
  const drDb = 20 * Math.log10(drRatio + EPS);

  return {
    integratedLufs: 10 * Math.log10(meanMs + EPS) - LUFS_OFFSET,
    peakDbfs: 20 * Math.log10(peak + EPS),
    crestFactorDb: 20 * Math.log10((peak + EPS) / (Math.sqrt(meanMs) + EPS)),
    // Third departure from the Python source, and the only one that CHANGES a
    // value rather than adding a step. `dr = p95 / (p10 + 1e-12)` explodes on
    // sparse material: a click track with true digital silence between hits
    // measured 223 dB here, because the 10th percentile is the 1e-12 floor,
    // not a quiet musical level. No audio — not even a 32-bit float pipeline —
    // has 223 dB of range, so the number was an artefact wearing a unit.
    //
    // 60 dB is the ceiling where the p10 is still a level rather than the
    // noise floor. Above it the metric is measuring silence, so we stop
    // claiming a number. A steady tone still reports 0 dB, which is correct.
    dynamicRangeDb: Math.min(MAX_MEANINGFUL_DYNAMIC_RANGE_DB, Math.max(0, drDb)),
    clipped,
  };
}

// ---------------------------------------------------------------------------
// Stereo
// ---------------------------------------------------------------------------

export interface ReferenceStereo {
  /** 0 = mono, 1 = maximally wide. */
  width: number;
  /** Side energy relative to mid. The raw number behind `width`. */
  sideEnergyRatio: number;
}

const MONO_STEREO: ReferenceStereo = { width: 0, sideEnergyRatio: 0 };

/**
 * Mid/side width from the ORIGINAL channels.
 *
 * This is the one descriptor that cannot run on the mono downmix: mid/side is
 * definitionally the difference between left and right, so a mono signal has
 * no side component and would report a width of 0 no matter what. The caller
 * must pass the decoded channels, not `toMono(...)`.
 */
export function stereoDescriptor(channels: Float32Array[]): ReferenceStereo {
  if (channels.length < 2) return { ...MONO_STEREO };
  const [left, right] = channels;
  const n = Math.min(left.length, right.length);
  if (n === 0) return { ...MONO_STEREO };

  let midE = 0;
  let sideE = 0;
  for (let i = 0; i < n; i++) {
    const mid = (left[i] + right[i]) / 2;
    const side = (left[i] - right[i]) / 2;
    midE += mid * mid;
    sideE += side * side;
  }
  midE /= n;
  sideE /= n;
  const midEps = midE + 1e-12;
  return {
    width: Math.min(1, Math.max(0, Math.sqrt(sideE) / (Math.sqrt(midEps) + 1e-12))),
    sideEnergyRatio: Math.min(1, Math.max(0, sideE / midEps)),
  };
}

// ---------------------------------------------------------------------------
// Groove family
// ---------------------------------------------------------------------------

export type GrooveFamily = "four_on_the_floor" | "breakbeat" | "half_time" | "two_step";

export interface ReferenceGroove {
  family: GrooveFamily;
  /** Onsets per second mapped to 0..1, saturating around 8/s. */
  drumDensity: number;
  /** Coefficient of variation of inter-onset intervals. 0 = metronomic. */
  syncopation: number;
}

const PEAK_HEIGHT = 0.3;
const DENSE_ONSETS_PER_SEC = 8;

/**
 * Transient density + syncopation, ported from `_groove`.
 *
 * The onset detector here is a crude downsample-max with a fixed height
 * threshold rather than scipy's `find_peaks`. That is a deliberate downgrade:
 * scipy gets `distance` in samples, we approximate the same minimum spacing
 * on the downsampled envelope, and the fixed 0.3 height is a coarse gate. The
 * family classification only needs density to separate "4-to-the-floor" from
 * "breakbeat", and a bad density produces a wrong LABEL, never a wrong number
 * presented as precise.
 */
export function grooveDescriptor(mono: Float32Array, sampleRate: number, tempo: number | null): ReferenceGroove {
  const ds = 50;
  const usable = Math.floor(mono.length / ds) * ds;
  if (usable < ds) {
    return { family: "four_on_the_floor", drumDensity: 0, syncopation: 0.3 };
  }
  const n = usable / ds;
  const env = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let max = 0;
    const base = i * ds;
    for (let j = 0; j < ds; j++) {
      const v = Math.abs(mono[base + j]);
      if (v > max) max = v;
    }
    env[i] = max;
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    if (env[i] < lo) lo = env[i];
    if (env[i] > hi) hi = env[i];
  }
  const range = hi - lo + 1e-9;
  for (let i = 0; i < n; i++) env[i] = (env[i] - lo) / range;

  // Peak picking: above threshold, at least `minGap` bins since the last peak.
  const minGap = Math.max(1, Math.floor((sampleRate / ds) * 0.05));
  const peaks: number[] = [];
  let lastPeak = -Infinity;
  for (let i = 1; i < n - 1; i++) {
    if (env[i] < PEAK_HEIGHT) continue;
    if (env[i] < env[i - 1] || env[i] < env[i + 1]) continue;
    if (i - lastPeak < minGap) continue;
    peaks.push(i);
    lastPeak = i;
  }

  const duration = mono.length / sampleRate;
  const onsetsPerSecond = peaks.length / Math.max(duration, 1e-3);
  const density = Math.min(1, Math.max(0, onsetsPerSecond / DENSE_ONSETS_PER_SEC));

  let syncopation: number;
  if (peaks.length > 3) {
    let mean = 0;
    const iv: number[] = [];
    for (let i = 1; i < peaks.length; i++) {
      const d = peaks[i] - peaks[i - 1];
      iv.push(d);
      mean += d;
    }
    mean /= iv.length;
    let variance = 0;
    for (const d of iv) variance += (d - mean) ** 2;
    variance /= iv.length;
    syncopation = Math.min(1, Math.max(0, Math.sqrt(variance) / (mean + 1e-9)));
  } else {
    syncopation = 0.3;
  }

  // Family by tempo, then density. No tempo → the family that assumes least.
  let family: GrooveFamily;
  if (tempo === null) family = "four_on_the_floor";
  else if (tempo >= 160) family = "breakbeat";
  else if (tempo >= 110 && density > 0.55) family = "breakbeat";
  else if (tempo < 90) family = "half_time";
  else if (density > 0.6) family = "two_step";
  else family = "four_on_the_floor";

  return { family, drumDensity: density, syncopation };
}

// ---------------------------------------------------------------------------
// Plain summary
// ---------------------------------------------------------------------------

const FAMILY_LABELS: Record<GrooveFamily, string> = {
  four_on_the_floor: "four-on-the-floor",
  breakbeat: "breakbeat",
  half_time: "half-time",
  two_step: "two-step",
};

/**
 * One sentence in plain language — the F5 Inspiration builder's input.
 *
 * Written to be quotable to a human first and machine-readable second. Every
 * number in it is already on screen somewhere else, so this adds no new claim.
 */
export function plainSummary(input: {
  bpm: number | null;
  tonic: string | null;
  mode: ReferenceMode | null;
  confidence: number;
  averageEnergy: number;
  sections: ReferenceSection[];
  spectral: ReferenceSpectral;
  stereo: ReferenceStereo;
  groove: ReferenceGroove;
}): string {
  const parts: string[] = [];

  if (input.bpm !== null) {
    const keyName = input.tonic ? `${input.tonic} ${input.mode ?? ""}`.trim() : "unknown key";
    parts.push(
      `Estimated around ${input.bpm.toFixed(0)} BPM in ${keyName} (${Math.round(input.confidence * 100)}% confidence).`,
    );
  } else {
    parts.push("No reliable tempo detected.");
  }

  parts.push(`Energy averages ${input.averageEnergy.toFixed(2)}.`);

  const roles = input.sections
    .slice(0, 5)
    .map((s) => s.role)
    .join(", ");
  parts.push(`Structure: ${roles || "single-section"}.`);

  parts.push(
    `Groove reads as ${FAMILY_LABELS[input.groove.family]} (drum density ${input.groove.drumDensity.toFixed(
      2,
    )}, syncopation ${input.groove.syncopation.toFixed(2)}).`,
  );

  const bright = input.spectral.brightness > 0.5 ? "bright" : "warm/dark";
  parts.push(`Spectral character: ${bright} (centroid ${input.spectral.centroidHz.toFixed(0)} Hz).`);

  const width = input.stereo.width > 0.5 ? "wide" : input.stereo.width < 0.2 ? "narrow" : "moderate";
  parts.push(`Stereo field: ${width}.`);

  return parts.join(" ");
}

/** Human-readable key label, or null when nothing was detected. */
export function keyLabel(tonic: string | null, mode: ReferenceMode | null): string | null {
  if (!tonic) return null;
  if (!mode) return tonic;
  return `${tonic} ${mode}`;
}

export { PITCH_CLASSES };
export type { ReferenceMap };

/**
 * U1 — CHORD TRANSCRIPTION (docs/UN-SUNO-PLAN.md).
 *
 * Pure DSP: a rendered signal + a bar grid in → per-bar chord spans out.
 * Recipe ported from D:\beat_modifier `pipelines/extraction.py` (per-bar
 * chroma → template scoring → merge repeats), with two corrections earned on
 * the U0 golden set:
 *
 * 1. ROOT + TONALITY come from a Krumhansl-Kessler correlation against the
 *    SAME major/minor profiles the F1 key lane uses — not from a raw
 *    in-chord share. A pure share score cannot tell F major from D minor 7
 *    (they share three of four tones) and 4-tone templates always outscore
 *    triads by harvesting whatever neighboring tone the kick sweep left
 *    behind. Scale profiles judge the WHOLE distribution shape, which is why
 *    the key lane survives polyphonic mixes.
 *
 * 2. QUALITY is decided among triads first (maj vs min at the winning root),
 *    then upgraded to a seventh only when the seventh's tone carries real
 *    mass — relative to the weakest triad tone, so broadband drum noise can
 *    never buy a seventh.
 *
 * Honesty rules (the apply.ts contract): a bar whose chroma carries no
 * stable harmony contributes NOTHING (no invented chords); confidence is the
 * root-certainty margin, never a vibe; same signal → same spans (no RNG).
 *
 * The tempo/grid comes from the caller (estimateTempo) — this module never
 * guesses where bars are. Analyzing beyond MAX_ANALYSIS_SECONDS is a
 * truncation the result reports (`barsAnalyzed`).
 */
import { MAJOR_PROFILE, MINOR_PROFILE } from "../../ai/audio-tempo-key";

export type TranscribedChordQuality = "maj" | "min" | "dom7" | "min7" | "maj7" | "sus4";

const PITCH_CLASS_COUNT = 12;
/** Goertzel probes per pitch class — C2 (65.406 Hz) + four octaves, the F1 key probes. */
const OCTAVE_PROBES = 4;
const C2_HZ = 65.406;
/** A bar is harmonic only when its chroma correlates with a scale profile
 * this strongly. Measured on the U0 golden set: drums-only material peaks at
 * 0.487 while every true chord bar sits ≥ 0.70 — 0.55 splits them with room
 * on both sides. The ROOT MARGIN deliberately does NOT gate: fifth-related
 * roots share 6 of 7 scale tones, so correct bars legitimately score tiny
 * margins (0.002 measured) while drums-only scores large ones (0.44) — it
 * stays as the reported confidence, never a filter. */
const MIN_PROFILE_CORRELATION = 0.55;
/** A seventh exists only when its tone clears BOTH relative bars — a fraction
 * of the weakest triad tone AND of the root itself. The second bar kills
 * transient leakage (a snare tuned near the seventh's tone deposits a few
 * percent of the root's mass there; voiced sevenths land near triad parity). */
const SEVENTH_MASS_FRACTION = 0.6;
const SEVENTH_ROOT_FRACTION = 0.25;
/** Bar chroma mass below this (relative to the loudest bar) counts as silence. */
const SILENCE_RELATIVE_MASS = 0.05;

export interface ChordSpan {
  /** Bar index the span starts at (0 = first analyzed bar). */
  startBar: number;
  /** Length in whole bars (merged repeats of the same root+quality). */
  bars: number;
  rootPc: number;
  quality: TranscribedChordQuality;
  /** Root-certainty margin 0..1: KK margin of the winning root over every
   * other root. */
  confidence: number;
}

export interface ChordDetection {
  spans: ChordSpan[];
  /** Bars actually analyzed (after the analysis cap). */
  barsAnalyzed: number;
}

export interface ChordDetectionOptions {
  /** Bar grid source — normally the estimateTempo result. */
  bpm: number;
  /** Analysis cap in seconds (default 120 — a worker-stage concern later). */
  maxSeconds?: number;
}

function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const length = Math.min(a.length, b.length);
  let meanA = 0;
  let meanB = 0;
  for (let index = 0; index < length; index++) {
    meanA += a[index];
    meanB += b[index];
  }
  meanA /= length;
  meanB /= length;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let index = 0; index < length; index++) {
    const da = a[index] - meanA;
    const db = b[index] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const denominator = Math.sqrt(denA * denB);
  return denominator > 0 ? num / denominator : 0;
}

/**
 * Goertzel chroma with per-octave weights (12 pitch classes, C2 + four
 * octaves — the same probes estimateKey uses, so key and chords always read
 * the same surface). Returns TWO views of the same probes:
 *
 * - `root` — full weights: the bass fundamental (octave 0) is a legitimate
 *   root voter, and relative-minor confusions (Fm7 read as Ab) lose their
 *   tercious bias once the bass speaks.
 * - `quality` — octave 0 dropped: the kick's pitch sweep sweeps C2–B2 and
 *   fakes sevenths; chord voicings live in octave 1+, and so does every
 *   tone the quality decision needs.
 */
function goertzelChroma(
  segment: Float32Array,
  sampleRate: number,
): { root: Float64Array; quality: Float64Array; bass: Float64Array; mass: number } {
  const root = new Float64Array(PITCH_CLASS_COUNT);
  const quality = new Float64Array(PITCH_CLASS_COUNT);
  const bass = new Float64Array(PITCH_CLASS_COUNT);
  let mass = 0;
  for (let pitchClass = 0; pitchClass < PITCH_CLASS_COUNT; pitchClass++) {
    let weightedRoot = 0;
    let weightedQuality = 0;
    for (let octave = 0; octave < OCTAVE_PROBES; octave++) {
      const frequency = C2_HZ * Math.pow(2, octave + pitchClass / PITCH_CLASS_COUNT);
      const k = (2 * Math.PI * frequency) / sampleRate;
      const coeff = 2 * Math.cos(k);
      let s1 = 0;
      let s2 = 0;
      for (let i = 0; i < segment.length; i++) {
        const s0 = segment[i] + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      const magnitude = Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2);
      weightedRoot += magnitude;
      if (octave > 0) weightedQuality += magnitude;
      if (octave === 0) bass[pitchClass] = magnitude;
    }
    root[pitchClass] = weightedRoot;
    quality[pitchClass] = weightedQuality;
    mass += weightedRoot;
  }
  const norm = (view: Float64Array, total: number): void => {
    if (total > 0) for (let pc = 0; pc < PITCH_CLASS_COUNT; pc++) view[pc] /= total;
  };
  norm(root, mass);
  const qMass = quality.reduce((sum, value) => sum + value, 0);
  norm(quality, qMass);
  const bMass = bass.reduce((sum, value) => sum + value, 0);
  norm(bass, bMass);
  return { root, quality, bass, mass };
}

interface RootVerdict {
  rootPc: number;
  /** Best profile correlation at this root (max of major/minor). */
  correlation: number;
  /** Margin over the best OTHER root (relative, 0..1). */
  margin: number;
}

/**
 * The bass-root rule. Seventh chords are chromatically ambiguous — Bbmaj7
 * and Dm6 hold the IDENTICAL pitch-class set, so no chord-template scoring
 * can ever separate them; the scale profiles just pick a favourite. The one
 * honest discriminator is the bass: when ONE pitch class clearly owns the
 * low octave (>= 1/4 of its mass — a real bass note, not sweep residue), it
 * earns a flat correlation bonus as the root. Anything quieter keeps the
 * plain profile correlation.
 */
const BASS_ROOT_SHARE = 0.2;
const BASS_ROOT_BONUS = 0.12;

function scoreRoots(chroma: Float64Array, bass: Float64Array): RootVerdict[] {
  const perRoot: { rootPc: number; correlation: number; score: number }[] = [];
  for (let rootPc = 0; rootPc < PITCH_CLASS_COUNT; rootPc++) {
    // Rotate so the profile's tonic sits on this root: chroma[(i + root) % 12].
    const rotated = chroma.map((_, index) => chroma[(index + rootPc) % PITCH_CLASS_COUNT]);
    const correlation = Math.max(pearson(rotated, MAJOR_PROFILE), pearson(rotated, MINOR_PROFILE));
    const bonus = bass[rootPc] >= BASS_ROOT_SHARE ? BASS_ROOT_BONUS : 0;
    perRoot.push({ rootPc, correlation, score: correlation + bonus });
  }
  perRoot.sort((a, b) => b.score - a.score);
  return perRoot.map((entry) => {
    const rival = perRoot.find((other) => other.rootPc !== entry.rootPc);
    const margin = rival ? (entry.score - rival.score) / Math.max(entry.score, 1e-9) : 1;
    return { rootPc: entry.rootPc, correlation: entry.correlation, margin: Math.max(0, Math.min(1, margin)) };
  });
}

/** Tone shares at a bar for the quality decision. */
function toneShare(chroma: Float64Array, pitchClass: number): number {
  return chroma[pitchClass % PITCH_CLASS_COUNT];
}

/** Decide maj/min at the winning root from triad-tone shares, then upgrade
 * to a seventh only when the seventh tone earns its place relative to the
 * weakest triad tone. */
function decideQuality(chroma: Float64Array, rootPc: number): TranscribedChordQuality {
  const third = toneShare(chroma, rootPc + 4);
  const minorThird = toneShare(chroma, rootPc + 3);
  const isMinor = minorThird > third;
  const triadTones = [toneShare(chroma, rootPc), isMinor ? minorThird : third, toneShare(chroma, rootPc + 7)];
  const weakest = Math.min(...triadTones);
  const flatSeventh = toneShare(chroma, rootPc + 10);
  const majorSeventh = toneShare(chroma, rootPc + 11);
  const seventhThreshold = Math.max(weakest * SEVENTH_MASS_FRACTION, toneShare(chroma, rootPc) * SEVENTH_ROOT_FRACTION);
  if (flatSeventh >= seventhThreshold && flatSeventh >= majorSeventh) return isMinor ? "min7" : "dom7";
  if (majorSeventh >= seventhThreshold) return "maj7";
  return isMinor ? "min" : "maj";
}

export function detectChordSpans(
  pcm: Float32Array,
  sampleRate: number,
  options: ChordDetectionOptions,
): ChordDetection | null {
  if (!Number.isFinite(options.bpm) || options.bpm <= 0 || sampleRate <= 0) return null;
  const maxSeconds = options.maxSeconds ?? 120;
  const analyzedSamples = Math.min(pcm.length, Math.floor(maxSeconds * sampleRate));
  if (analyzedSamples < sampleRate) return null;

  const barSeconds = (60 / options.bpm) * 4;
  const barSamples = Math.round(barSeconds * sampleRate);
  if (barSamples < sampleRate / 4) return null; // grid too fast to be meaningful
  const barsAnalyzed = Math.floor(analyzedSamples / barSamples);
  if (barsAnalyzed < 1) return null;

  interface BarChord {
    rootPc: number;
    quality: TranscribedChordQuality;
    confidence: number;
  }
  const perBar: (BarChord | null)[] = [];
  const masses: number[] = [];
  const rootChromas: Float64Array[] = [];
  const qualityChromas: Float64Array[] = [];
  const bassChromas: Float64Array[] = [];
  let maxMass = 0;
  for (let bar = 0; bar < barsAnalyzed; bar++) {
    const views = goertzelChroma(pcm.subarray(bar * barSamples, (bar + 1) * barSamples), sampleRate);
    rootChromas.push(views.root);
    qualityChromas.push(views.quality);
    bassChromas.push(views.bass);
    masses.push(views.mass);
    if (views.mass > maxMass) maxMass = views.mass;
  }

  for (let bar = 0; bar < barsAnalyzed; bar++) {
    if (masses[bar] < maxMass * SILENCE_RELATIVE_MASS) {
      perBar.push(null); // silence — no opinion, never a chord
      continue;
    }
    const [best] = scoreRoots(rootChromas[bar], bassChromas[bar]);
    if (!best || best.correlation < MIN_PROFILE_CORRELATION) {
      perBar.push(null);
      continue;
    }
    perBar.push({
      rootPc: best.rootPc,
      quality: decideQuality(qualityChromas[bar], best.rootPc),
      confidence: best.margin,
    });
  }

  // Merge consecutive equal chords into spans.
  const spans: ChordSpan[] = [];
  for (let bar = 0; bar < barsAnalyzed; bar++) {
    const current = perBar[bar];
    if (!current) continue;
    const last = spans[spans.length - 1];
    if (
      last &&
      last.startBar + last.bars === bar &&
      last.rootPc === current.rootPc &&
      last.quality === current.quality
    ) {
      last.bars += 1;
      last.confidence = (last.confidence * (last.bars - 1) + current.confidence) / last.bars;
    } else {
      spans.push({
        startBar: bar,
        bars: 1,
        rootPc: current.rootPc,
        quality: current.quality,
        confidence: current.confidence,
      });
    }
  }
  return { spans, barsAnalyzed };
}

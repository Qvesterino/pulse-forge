/**
 * MATCH EQ — "znej ako ref": measure the mix, measure the reference, derive
 * a corrective tonal curve, apply it to the master.
 *
 * The flagship "AI zvukár" capability: a human matching a reference by ear
 * sweeps EQ bands for minutes; this measures both spectra with an averaged
 * periodogram and computes the correction in closed form.
 *
 * ARCHITECTURE (plugin-audit lessons applied — no new plugin surface):
 *   - Analysis lives here (pure math on PCM; unit-testable in node).
 *   - Application rides the EXISTING 6-band EQ runtime inserted into the
 *     master chain (the master already hosts effect runtimes — tape, glue,
 *     limiter), driven by `MasterConfig.matchEq`.
 *   - The curve matches tonal SHAPE, not loudness: both spectra are
 *     normalized to their own total energy before differencing, so a −12 dB
 *     reference produces the IDENTICAL curve (level is the loudness pass's
 *     job, not the EQ's).
 *
 * Mastering-grade safety rails:
 *   - corrections clamp to ±6 dB per band (broad-stroke tonal matching, not
 *     resonance copying);
 *   - sub-1 dB residuals floor to 0 (don't chase trivia);
 *   - the mean of the band differences is removed (DC-free curve — a match
 *     never becomes a hidden volume boost).
 */

import { fftInPlace } from "../audio-engine/spectralEdit";

/** Master chain band layout — mirrors the EQ's shelf/bell structure. */
export interface MatchEqBands {
  /** < 250 Hz — low shelf region. */
  low: number;
  /** 250–1000 Hz — low-mid bell region. */
  lowMid: number;
  /** 1000–4000 Hz — high-mid bell region. */
  highMid: number;
  /** > 4000 Hz — high shelf region. */
  high: number;
}

/**
 * Band edges in Hz. The TOP edge is 8000, not Nyquist: the reference is
 * retained at 16 kHz (Nyquist 8 kHz) while the mix measures at 44.1 kHz —
 * integrating the mix to 22 kHz against a reference that stops at 8 kHz
 * would read the mix as systematically darker (its >4 kHz band carries
 * 8–22 kHz energy the reference can never show) and bias every curve toward
 * darkening. Both analyses therefore integrate the SAME 0–8 kHz window.
 */
export const MATCH_EQ_BAND_EDGES = [0, 250, 1000, 4000, 8000] as const;
/** A band reading at/below this (dB of share) means "no energy anywhere". */
export const SILENT_BAND_DB = -100;
export const MATCH_EQ_MAX_GAIN_DB = 6;
export const MATCH_EQ_DEADZONE_DB = 1;

/** FFT frame for the periodogram. 4096 @ 44.1 kHz → ~10.8 Hz bins. */
const FFT_SIZE = 4096;
const HOP = FFT_SIZE / 2;

/**
 * Averaged power spectrum, integrated into the four master bands, returned
 * in dB relative to each band's share of TOTAL energy — i.e. the band
 * BALANCE (loudness-invariant by construction: scaling the input scales
 * every band equally and cancels in the dB-of-share domain).
 *
 * Share-of-total formulation: bandShare = bandPower / totalPower, and the
 * returned value is 10·log10(bandShare). A pure 440 Hz sine at ANY level
 * therefore reads ≈ 0 dB in lowMid (all energy) and very negative
 * elsewhere — exactly the invariant the match needs.
 */
export function spectrumBandBalance(pcm: Float32Array, sampleRate: number): MatchEqBands {
  const frames = Math.max(1, Math.floor((pcm.length - FFT_SIZE) / HOP) + 1);
  const bins = FFT_SIZE / 2;
  const acc = new Float64Array(bins);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);

  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    for (let i = 0; i < FFT_SIZE; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)); // Hann
      re[i] = (off + i < pcm.length ? pcm[off + i] : 0) * w;
      im[i] = 0;
    }
    fftInPlace(re, im);
    for (let k = 0; k < bins; k++) {
      acc[k] += re[k] * re[k] + im[k] * im[k];
    }
  }

  // Integrate bin energy into the four bands (bin frequency = k·sr/N).
  // Bins at/above the 8 kHz window edge are skipped ENTIRELY — including
  // them in `total` would deflate every band's share on the 44.1 kHz side
  // and reintroduce the bandwidth bias the fixed window exists to remove.
  const bandPower = [0, 0, 0, 0];
  let total = 0;
  for (let k = 1; k < bins; k++) {
    const hz = (k * sampleRate) / FFT_SIZE;
    if (hz >= MATCH_EQ_BAND_EDGES[4]) break;
    const p = acc[k];
    total += p;
    if (hz < MATCH_EQ_BAND_EDGES[1]) bandPower[0] += p;
    else if (hz < MATCH_EQ_BAND_EDGES[2]) bandPower[1] += p;
    else if (hz < MATCH_EQ_BAND_EDGES[3]) bandPower[2] += p;
    else bandPower[3] += p;
  }
  const dbOfShare = (p: number): number => (p > 0 && total > 0 ? 10 * Math.log10(p / total) : -120);
  return {
    low: dbOfShare(bandPower[0]),
    lowMid: dbOfShare(bandPower[1]),
    highMid: dbOfShare(bandPower[2]),
    high: dbOfShare(bandPower[3]),
  };
}

export interface MatchEqCurve {
  low: number;
  lowMid: number;
  highMid: number;
  high: number;
}

/**
 * The correction: reference balance minus mix balance, de-meanded (shape
 * only — a match must never be a volume move), dead-zoned (< 1 dB → 0) and
 * clamped to ±6 dB per band. All four values are EQ GAINS in dB.
 */
export function computeMatchEqCurve(mix: MatchEqBands, reference: MatchEqBands): MatchEqCurve {
  const keys = ["low", "lowMid", "highMid", "high"] as const;
  const diff = keys.map((k) => reference[k] - mix[k]);
  const mean = diff.reduce((a, b) => a + b, 0) / diff.length;
  const shape = (value: number): number => {
    const d = value - mean;
    if (Math.abs(d) < MATCH_EQ_DEADZONE_DB) return 0;
    return Math.max(-MATCH_EQ_MAX_GAIN_DB, Math.min(MATCH_EQ_MAX_GAIN_DB, d));
  };
  return {
    low: shape(diff[0]),
    lowMid: shape(diff[1]),
    highMid: shape(diff[2]),
    high: shape(diff[3]),
  };
}

/** A spectrum where every band sits at the floor = no usable energy. */
export function bandBalanceIsUsable(bands: MatchEqBands): boolean {
  return (
    Number.isFinite(bands.low) &&
    bands.low > SILENT_BAND_DB &&
    bands.lowMid > SILENT_BAND_DB &&
    bands.highMid > SILENT_BAND_DB &&
    bands.high > SILENT_BAND_DB
  );
}

/**
 * Convenience: PCM → curve in one call. Returns null when EITHER side is
 * unusable (silent / non-finite / no energy in the 0–8 kHz window): a
 * silent reference would otherwise anti-match (the curve becomes the
 * inversion of the mix's balance — wrong direction), and a silent mix has
 * nothing to correct. Declining is the only honest answer for both.
 */
export function matchEqCurveForPcm(
  mixPcm: Float32Array,
  mixSr: number,
  refPcm: Float32Array,
  refSr: number,
): MatchEqCurve | null {
  const mix = spectrumBandBalance(mixPcm, mixSr);
  const ref = spectrumBandBalance(refPcm, refSr);
  if (!bandBalanceIsUsable(mix) || !bandBalanceIsUsable(ref)) return null;
  return computeMatchEqCurve(mix, ref);
}

/* ---------------- reference retention + mix measurement ---------------- */

/**
 * The last 🎧 REF analysis PCM, retained for the match (16 kHz mono is all
 * the band analysis needs — the reference is tonal SHAPE, not fidelity).
 * Module state, same pattern as the semantic conditioning slot: cleared on
 * null, never serialized.
 */
let referencePcm: Float32Array | null = null;

export function setMatchEqReference(pcm: Float32Array | null): void {
  referencePcm = pcm;
}

export function hasMatchEqReference(): boolean {
  return referencePcm !== null && referencePcm.length > FFT_SIZE;
}

/**
 * Full match pipeline: render the CURRENT pattern (pre-master — the
 * correction must measure the mix, not the master's reaction to it), derive
 * the curve against the retained reference, and hand back the curve for
 * `applyMasterMatchEqCommand`. Returns null when no reference is loaded or
 * the render fails (never throws into the caller).
 */
export async function computeMasterMatchEq(doc: ProjectDocument, bank: SampleBank): Promise<MatchEqCurve | null> {
  try {
    if (!hasMatchEqReference()) return null;
    // A reference with no usable 0–8 kHz energy (silent WAV, NaN PCM) is
    // declined here as well — computeMasterMatchEq must never hand the
    // applier an anti-match curve.
    const { renderProject } = await import("../rendering/renderer");
    const buffer = await renderProject(doc, bank, {
      mode: "pattern",
      sampleRate: 44100,
      tailSeconds: 0.3,
      masterProcessing: false,
    });
    const channels = buffer.numberOfChannels;
    const mix = new Float32Array(buffer.length);
    for (let c = 0; c < channels; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < mix.length; i++) mix[i] += data[i] / channels;
    }
    return matchEqCurveForPcm(mix, 44100, referencePcm!, 16000);
  } catch {
    return null;
  }
}

import type { ProjectDocument } from "../project-model/types";
import type { SampleBank } from "../sample-library/factory";

/**
 * REFERENCE MATCH — "ako ďaleko som od referencie" (reference-matching wave).
 *
 * The measured half of "sound like the reference": the panel renders the
 * CURRENT project pre-master, this module measures BOTH sides with the same
 * analyzers the app already trusts (mix-doctor band shares + BS.1770
 * loudness + mid/side stereo width), and projects every difference onto
 * CONCRETE, undoable mix commands — a master match-EQ curve in the EQ's own
 * four-band vocabulary, plus a loudness trim in LU.
 *
 * What this module deliberately does NOT do:
 *   - It never presents the reference's own descriptors as targets. The
 *     *difference* between two measurements is a legitimate suggestion (that
 *     is the entire point of a match); the reference alone is not (the F2 §2.2
 *     rule — descriptors.ts: "descriptors, never an EQ suggestion").
 *   - It never auto-applies. The report carries suggestions; the panel renders
 *     them with an explicit APPLY button (the mix-diagnosis pattern —
 *     findings + user-invoked fix).
 *   - It never invents values: every number in every suggestion is a rounded
 *     measurement, clamped to the boundary the command layer already enforces
 *     (±6 dB per EQ band, ±6 dB loudness trim, 0.5× the measured gap so a
 *     match is a broad-stroke correction and not a resonance copy).
 *
 * Pure math only — no React, no engine, no clock, no module state. Same
 * inputs → byte-identical report (the F1 determinism rule), which is what
 * makes the panel's numbers comparable between sessions.
 */

import { analyzeLoudnessBuffer } from "../audio-engine/kweighting";
import { analyzeMixHealth, type MixHealthReport } from "../analysis/mixDoctor";
import type { MatchEqBands, MatchEqCurve } from "../intent/match-eq";
import { computeMatchEqCurve } from "../intent/match-eq";

/* ───────────────────────── measurement inputs ───────────────────────── */

/** The project's side: the pre-master render (the match measures the MIX). */
export interface MatchProjectInput {
  channels: Float32Array[];
  sampleRate: number;
}

/** The reference side: the dropped file, decoded channels at native rate. */
export interface MatchReferenceInput {
  channels: Float32Array[];
  sampleRate: number;
}

/* ────────────────────────── the comparison ────────────────────────── */

/** One mix-doctor band: both sides' share (dB-of-own-total) + the delta. */
export interface MatchBandRow {
  band: "sub" | "low" | "lowmid" | "mid" | "himid" | "high" | "air";
  label: string;
  hz: string;
  mixDb: number;
  refDb: number;
  /** ref − mix, dB of share. Positive = the mix is thinner here than the ref. */
  deltaDb: number;
}

export interface MatchLoudness {
  mixLufs: number | null;
  refLufs: number | null;
  /** ref − mix, LU. Null when either side is unmeasurable. */
  deltaLu: number | null;
}

export interface MatchStereo {
  /** mix-doctor stereo correlation for the mix (−1..1, null when mono source). */
  mixCorrelation: number | null;
  /** Reference mid/side side-energy ratio (0 = mono, higher = wider). */
  refSideRatio: number;
  verdict: "wider-reference" | "narrow-reference" | "similar" | "unknown";
}

export interface ReferenceMatchReport {
  /** All 7 mix-doctor bands, always in display order (deterministic). */
  bands: MatchBandRow[];
  loudness: MatchLoudness;
  stereo: MatchStereo;
  /** The master match-EQ curve the APPLY button would land (null = no tonal move worth making). */
  curve: MatchEqCurve | null;
  /** The loudness trim the APPLY button would land (null = no level move worth making). */
  loudnessTrimDb: number | null;
  /** Human headline — the panel renders this first. */
  summary: string;
}

/* ─────────────────────────── constants ─────────────────────────── */

/** Band display metadata — mix-doctor band order and edges. */
const BAND_DEFS: ReadonlyArray<{
  band: MatchBandRow["band"];
  label: string;
  hz: string;
}> = [
  { band: "sub", label: "Sub", hz: "20–60 Hz" },
  { band: "low", label: "Low", hz: "60–120 Hz" },
  { band: "lowmid", label: "Low-mid", hz: "120–350 Hz" },
  { band: "mid", label: "Mid", hz: "350 Hz–2 kHz" },
  { band: "himid", label: "High-mid", hz: "2–6 kHz" },
  { band: "high", label: "High", hz: "6–12 kHz" },
  { band: "air", label: "Air", hz: "12 kHz+" },
];

/** A |delta| below this is chasing trivia, not matching. */
export const MATCH_DEADZONE_DB = 1.5;
/** The loudness half only fires from a full LU of gap (LU are coarse). */
export const MATCH_LOUDNESS_MIN_LU = 1;
/** Both halves clamp to the same ±6 the master commands already enforce. */
export const MATCH_MAX_DB = 6;

const round1 = (value: number): number => Math.round(value * 10) / 10;

/** Linear share (0..1) → dB-of-share. A silent band reads the −120 floor. */
function dbOfShare(share: number): number {
  return share > 1e-12 ? 10 * Math.log10(share) : -120;
}

/* ─────────────────────────── the pipeline ─────────────────────────── */

/**
 * Full match: measure both sides with the SAME analyzers (analyzeMixHealth
 * for band shares + correlation, analyzeLoudnessBuffer for LUFS), compare in
 * the share domain (dB-of-own-total — a quiet reference compares honestly
 * against a loud mix), derive the master match-EQ curve and the loudness
 * trim. Pure and synchronous: same inputs → byte-identical report.
 */
export function buildReferenceMatch(
  project: MatchProjectInput,
  reference: MatchReferenceInput,
): ReferenceMatchReport {
  const mix = analyzeMixHealth(project.channels, project.sampleRate);
  const ref = analyzeMixHealth(reference.channels, reference.sampleRate);

  const bands: MatchBandRow[] = BAND_DEFS.map(({ band, label, hz }) => {
    // mix-doctor bandShares are LINEAR shares (0..1 of own total); the match
    // compares in dB-of-share (10·log10) so the table reads like every other
    // dB column and deltas are perceptually proportional.
    const mixDb = round1(dbOfShare(mix.bandShares[band]));
    const refDb = round1(dbOfShare(ref.bandShares[band]));
    return { band, label, hz, mixDb, refDb, deltaDb: round1(refDb - mixDb) };
  });

  const loudness: MatchLoudness = {
    mixLufs: mix.integratedLufs === null ? null : round1(mix.integratedLufs),
    refLufs: ref.integratedLufs === null ? null : round1(ref.integratedLufs),
    deltaLu:
      mix.integratedLufs !== null && ref.integratedLufs !== null
        ? round1(ref.integratedLufs - mix.integratedLufs)
        : null,
  };

  const stereo = buildStereo(reference.channels, mix.stereoCorrelation);

  // Tonal half: reuse the proven match-eq math on the 7-band measurements by
  // folding them into the master chain's 4-band vocabulary (sub+low → low,
  // lowmid → lowMid, mid+himid → highMid, high+air → high — energy-weighted
  // by the share domain's own exponentials, never a plain average of dB).
  const curve = matchCurveFromBands(mix.bandShares, ref.bandShares);

  // Level half: the reference's own LUFS, clamped to the streaming trim
  // window, only when the gap is a full LU or more.
  const loudnessTrimDb =
    loudness.deltaLu !== null && Math.abs(loudness.deltaLu) >= MATCH_LOUDNESS_MIN_LU
      ? round1(Math.max(-MATCH_MAX_DB, Math.min(MATCH_MAX_DB, loudness.deltaLu)))
      : null;

  return {
    bands,
    loudness,
    stereo,
    curve,
    loudnessTrimDb,
    summary: summarize(bands, loudness),
  };
}

/* ───────────────────────── stereo comparison ───────────────────────── */

function buildStereo(refChannels: Float32Array[], mixCorrelation: number | null): MatchStereo {
  const refSideRatio = round1(sideEnergyRatio(refChannels));
  const verdict: MatchStereo["verdict"] =
    mixCorrelation === null
      ? "unknown"
      : refSideRatio > 0.25
        ? mixCorrelation > 0.98
          ? "wider-reference"
          : "similar"
        : refSideRatio < 0.05 && mixCorrelation > 0.98
          ? "similar"
          : refSideRatio < 0.05
            ? "narrow-reference"
            : "similar";
  return { mixCorrelation: mixCorrelation === null ? null : round1(mixCorrelation * 100) / 100, refSideRatio, verdict };
}

/** Mid/side side-energy ratio — the descriptors.ts stereo math (epsilon + clamp 0..1), self-contained. */
function sideEnergyRatio(channels: Float32Array[]): number {
  if (channels.length < 2) return 0;
  const [l, r] = [channels[0]!, channels[1]!];
  const n = Math.min(l.length, r.length);
  let midE = 0;
  let sideE = 0;
  for (let i = 0; i < n; i++) {
    const mid = (l[i]! + r[i]!) / 2;
    const side = (l[i]! - r[i]!) / 2;
    midE += mid * mid;
    sideE += side * side;
  }
  // Epsilon + clamp — the descriptors.ts contract: a pure-antiphase signal
  // (mid ≈ 0) saturates at 1 instead of dividing by zero, and mono reads 0.
  return Math.min(1, Math.max(0, sideE / (midE + 1e-12)));
}

/* ───────────── 7 mix-doctor bands → 4 master-chain bands ───────────── */

/** Which mix-doctor bands fold into which master match-EQ band. */
const BAND_FOLD: Record<keyof MatchEqBands, ReadonlyArray<MatchBandRow["band"]>> = {
  low: ["sub", "low"],
  lowMid: ["lowmid"],
  highMid: ["mid", "himid"],
  high: ["high", "air"],
};

/**
 * Energy-weighted fold of the 7 measured shares into the 4-band master EQ
 * vocabulary, then the proven `computeMatchEqCurve` (de-mean, dead-zone,
 * clamp ±6). dB shares are ratios of TOTAL energy, so folding must
 * renormalize: the folded band is the dB of the SUM of its parts' linear
 * shares — a plain dB average would read a sub-heavy mix as louder in
 * "low" than it is.
 */
function matchCurveFromBands(
  mix: MixHealthReport["bandShares"],
  ref: MixHealthReport["bandShares"],
): MatchEqCurve | null {
  const fold = (shares: MixHealthReport["bandShares"]): MatchEqBands => {
    const out: Record<keyof MatchEqBands, number> = { low: 0, lowMid: 0, highMid: 0, high: 0 };
    for (const target of Object.keys(BAND_FOLD) as Array<keyof MatchEqBands>) {
      // Shares are LINEAR (0..1 of own total) — folding is a plain sum, and
      // the folded value converts to dB only at the end
      // (computeMatchEqCurve speaks dB-of-share).
      let sum = 0;
      for (const band of BAND_FOLD[target]) sum += shares[band];
      out[target] = dbOfShare(sum);
    }
    return { low: out.low, lowMid: out.lowMid, highMid: out.highMid, high: out.high };
  };
  const curve = computeMatchEqCurve(fold(mix), fold(ref));
  // All-zero curve = nothing worth moving; report null so the panel can say
  // "tonally matched" instead of rendering a zero row.
  if (curve.low === 0 && curve.lowMid === 0 && curve.highMid === 0 && curve.high === 0) return null;
  return curve;
}

/* ─────────────────────────── the summary ─────────────────────────── */

function summarize(bands: MatchBandRow[], loudness: MatchLoudness): string {
  const loud =
    loudness.deltaLu !== null ? ` · loudness ${loudness.deltaLu > 0 ? "+" : ""}${loudness.deltaLu} LU` : "";
  // Deadzone-aware: a match where NO band clears the deadzone and no trim
  // was derived is "tonally matched", not "biggest gap 0.0 dB" — reporting a
  // zero gap as a gap is noise, not information.
  const worst = [...bands].sort((a, b) => Math.abs(b.deltaDb) - Math.abs(a.deltaDb))[0] ?? null;
  if (worst === null || Math.abs(worst.deltaDb) < MATCH_DEADZONE_DB) {
    return `No measurable difference${loud}`;
  }
  return `Biggest gap: ${worst.label} ${worst.deltaDb > 0 ? "+" : ""}${worst.deltaDb} dB${loud}`;
}

/* ───────────────── re-exported measurement seam for the panel ───────── */

/**
 * The panel's project measurement: render pre-master once, measure with the
 * same analyzer the report uses. Exported so the panel never measures the
 * mix any other way (two analyzers = two truths).
 */
export function measureProjectMatch(channels: Float32Array[], sampleRate: number): MixHealthReport {
  return analyzeMixHealth(channels, sampleRate);
}

/** The reference's integrated loudness on its own — the panel shows it beside the mix's. */
export function referenceIntegratedLufs(channels: Float32Array[], sampleRate: number): number | null {
  return analyzeLoudnessBuffer(channels, sampleRate).integrated;
}
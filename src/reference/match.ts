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
import { analyzeMixHealth, type MixBandShares, type MixHealthReport } from "../analysis/mixDoctor";
import type { MatchEqBands, MatchEqCurve } from "../intent/match-eq";
import { computeMatchEqCurve } from "../intent/match-eq";
import { snapshot } from "../commands/core";
import { setTrackParams } from "../commands/project";
import { applyMasterMatchEqCommand } from "../commands/master";
import type { Command } from "../commands/types";
import type { ProjectDocument } from "../project-model/types";

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
  /**
   * Both sides sit below the participation floor — the band holds no energy on
   * either side, so its delta is filter leakage and must not be ranked as a
   * gap. The row still renders (it is a real measurement of "nothing here").
   */
  empty: boolean;
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
/**
 * A band sitting this far below ITS OWN SIDE's loudest band holds no
 * information — the "difference" there is filter leakage, not a mix decision.
 * The same participation floor the sound-library audit's attack term uses: a
 * band with no body to measure against must never win a comparison on ringing
 * divided by near-zero. Relative per side, so a dark mix and a bright mix are
 * each judged against their own dominant band.
 */
export const MATCH_PARTICIPATION_FLOOR_DB = 30;

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
export function buildReferenceMatch(project: MatchProjectInput, reference: MatchReferenceInput): ReferenceMatchReport {
  const mix = analyzeMixHealth(project.channels, project.sampleRate);
  const ref = analyzeMixHealth(reference.channels, reference.sampleRate);

  const rows: Array<Omit<MatchBandRow, "empty">> = BAND_DEFS.map(({ band, label, hz }) => {
    // mix-doctor bandShares are LINEAR shares (0..1 of own total); the match
    // compares in dB-of-share (10·log10) so the table reads like every other
    // dB column and deltas are perceptually proportional.
    const mixDb = round1(dbOfShare(mix.bandShares[band]));
    const refDb = round1(dbOfShare(ref.bandShares[band]));
    return { band, label, hz, mixDb, refDb, deltaDb: round1(refDb - mixDb) };
  });
  // Participation floor, per side: a band is EMPTY only when it is quiet on
  // BOTH sides — each judged against its own loudest band. A band loud on one
  // side and quiet on the other is the REAL gap a match exists to find (the
  // mix is missing the reference's sub, say), never "empty". The curve folds
  // only non-empty rows so leakage in a dead band cannot tilt the master EQ.
  const mixLoudest = Math.max(...rows.map((r) => r.mixDb));
  const refLoudest = Math.max(...rows.map((r) => r.refDb));
  const quietOn = (db: number, loudest: number): boolean => db < loudest - MATCH_PARTICIPATION_FLOOR_DB;
  const bands: MatchBandRow[] = rows.map((row) => ({
    ...row,
    empty: quietOn(row.mixDb, mixLoudest) && quietOn(row.refDb, refLoudest),
  }));
  const participating = bands.filter((row) => !row.empty);

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
  // Only PARTICIPATING bands are folded: an empty band's leakage would
  // otherwise tilt the curve toward moving air neither mix nor reference has.
  const curve = matchCurveFromBands(mix.bandShares, ref.bandShares, participating as MatchBandRow[]);

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
  participating: readonly MatchBandRow[],
): MatchEqCurve | null {
  const fold = (shares: MixHealthReport["bandShares"]): MatchEqBands => {
    const out: Record<keyof MatchEqBands, number> = { low: 0, lowMid: 0, highMid: 0, high: 0 };
    for (const target of Object.keys(BAND_FOLD) as Array<keyof MatchEqBands>) {
      // Shares are LINEAR (0..1 of own total) — folding is a plain sum, and
      // the folded value converts to dB only at the end
      // (computeMatchEqCurve speaks dB-of-share). A target band with no
      // participating source is EXCLUDED rather than folded as −120: the
      // curve must not try to correct a region neither side occupies.
      const sources = BAND_FOLD[target].filter((band) => participating.some((p) => p.band === band));
      if (sources.length === 0) {
        out[target] = dbOfShare(0);
        continue;
      }
      let sum = 0;
      for (const band of sources) sum += shares[band];
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
  const loud = loudness.deltaLu !== null ? ` · loudness ${loudness.deltaLu > 0 ? "+" : ""}${loudness.deltaLu} LU` : "";
  // Rank only bands that hold energy on BOTH sides: an empty band's delta is
  // filter leakage, and calling it the "biggest gap" would send the user after
  // a band neither mix nor reference occupies. Deadzone-aware on top of that:
  // a match where nothing clears 1.5 dB is "no measurable difference", not a
  // zero gap reported as a gap.
  const worst = [...bands].filter((b) => !b.empty).sort((a, b) => Math.abs(b.deltaDb) - Math.abs(a.deltaDb))[0] ?? null;
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

/* ─────────────────────── per-track attribution ─────────────────────── */

/**
 * One rendered strip (a single track's own pre-master stem). The panel renders
 * these; this module only consumes the measurement, so attribution is pure and
 * testable without an OfflineAudioContext.
 */
export interface MatchStrip {
  id: string;
  name: string;
  kind: "drum" | "instrument" | "audio" | "group";
  lufs: number | null;
  /** The strip's own 7-band shares (linear 0..1 of its own total). */
  bandShares: MixBandShares;
  /** True when the track owns playable content (notes / rows / clips). */
  hasContent: boolean;
  /** True when the track is muted at the track level (mute beats every fader move). */
  muted: boolean;
}

/**
 * Which strip owns a band, and how much of the mix's energy there is theirs.
 * `share` is energy-weighted (each strip's loudness as power × its own band
 * share) — the same math as the mix-diagnosis `rankBandOwnership`, so a quiet
 * track cannot "own" a band it barely contributes to.
 */
export interface BandOwner {
  band: MatchBandRow["band"];
  strip: MatchStrip;
  /** 0..1 of the mix's energy in this band contributed by this strip. */
  share: number;
}

/** Linear power proxy from LUFS (absolute log scale → energy ratio). */
function lufsToPower(lufs: number): number {
  return Math.pow(10, lufs / 10);
}

/**
 * Rank band ownership across strips for every band. Deterministic; strips
 * without a measurable LUFS are skipped honestly (unknown energy cannot be
 * ranked). Ties break by strip id so the order never depends on input order.
 */
export function rankMatchBandOwnership(strips: readonly MatchStrip[]): BandOwner[] {
  const measured = strips.filter((strip) => strip.lufs !== null && strip.hasContent);
  const owners: BandOwner[] = [];
  for (const band of ["sub", "low", "lowmid", "mid", "himid", "high", "air"] as const) {
    const contributions = measured.map((strip) => ({
      strip,
      weight: lufsToPower(strip.lufs ?? -99) * strip.bandShares[band],
    }));
    const total = contributions.reduce((acc, c) => acc + c.weight, 0);
    if (total <= 0) continue;
    const best = contributions
      .map((c) => ({ strip: c.strip, share: c.weight / total }))
      .sort((a, b) => b.share - a.share || a.strip.id.localeCompare(b.strip.id))[0]!;
    owners.push({ band, strip: best.strip, share: best.share });
  }
  return owners;
}

/** A band suggestion is only actionable when one strip clearly owns it. */
export const MATCH_OWNER_MIN_SHARE = 0.4;
/** The strip-gain move never exceeds this (the mix-diagnosis setGain ceiling). */
export const MATCH_STRIP_GAIN_LIMIT_DB = 3;

/**
 * Per-track suggestions for the bands with a real gap. Each names the OWNER of
 * the band and proposes a bounded fader move TOWARD closing the measured gap:
 *
 *   - a band the mix is THIN in (delta > 0, reference has more) → the owner is
 *     the wrong place to cut; raising it is the move (bounded, partial);
 *   - a band the mix is RICH in (delta < 0) → the owner is the suspect to pull
 *     down (bounded);
 *   - a muted owner is a mute problem, not a fader problem — say so, do not
 *     propose a gain the mute would swallow.
 *
 * The gain factor is 0.5× the measured gap (the ultina/match-eq broad-stroke
 * convention) so a "match" nudges, never over-corrects, and is clamped to the
 * command layer's own setGain ceiling. A band with no clear owner (share below
 * MATCH_OWNER_MIN_SHARE) yields NO strip action — an ownership guess would be
 * an invented target.
 */
export function attributeMatchToStrips(
  report: ReferenceMatchReport,
  strips: readonly MatchStrip[],
): Array<{ band: MatchBandRow; owner: BandOwner }> {
  const owners = rankMatchBandOwnership(strips);
  const out: Array<{ band: MatchBandRow; owner: BandOwner }> = [];
  for (const band of report.bands) {
    if (band.empty) continue;
    if (Math.abs(band.deltaDb) < MATCH_DEADZONE_DB) continue;
    const owner = owners.find((candidate) => candidate.band === band.band);
    if (!owner || owner.share < MATCH_OWNER_MIN_SHARE) continue;
    out.push({ band, owner });
  }
  return out;
}

/** One concrete per-track move the panel can render and APPLY. */
export interface MatchStripMove {
  band: MatchBandRow;
  owner: BandOwner;
  /** Signed fader move in dB, clamped to ±{@link MATCH_STRIP_GAIN_LIMIT_DB}. */
  gainDb: number;
  /** One-line evidence the panel renders ("Kick owns 58% of sub · mix is 3.1 dB thin"). */
  reason: string;
}

/**
 * Turn the band attributions into concrete strip moves. Each is a broad-stroke
 * partial correction: half the measured band gap, clamped ±3 dB, with the
 * sign telling the direction (mix thin in the band → raise its owner; mix rich
 * → pull it down). A muted owner is skipped with a reason instead of a gain —
 * mute beats every fader value, so proposing one would be a dead move.
 */
export function matchStripMoves(report: ReferenceMatchReport, strips: readonly MatchStrip[]): MatchStripMove[] {
  const moves: MatchStripMove[] = [];
  for (const { band, owner } of attributeMatchToStrips(report, strips)) {
    const raw = band.deltaDb * 0.5;
    const gainDb = round1(Math.max(-MATCH_STRIP_GAIN_LIMIT_DB, Math.min(MATCH_STRIP_GAIN_LIMIT_DB, raw)));
    const direction = band.deltaDb > 0 ? "thin" : "rich";
    moves.push({
      band,
      owner,
      gainDb: owner.strip.muted ? 0 : gainDb,
      reason: owner.strip.muted
        ? `${owner.strip.name} owns ${Math.round(owner.share * 100)}% of ${band.label} but is MUTED — unmute (a fader move would be swallowed)`
        : `${owner.strip.name} owns ${Math.round(owner.share * 100)}% of ${band.label} · the mix is ${Math.abs(band.deltaDb).toFixed(1)} dB ${direction} there → move ${gainDb > 0 ? "+" : ""}${gainDb} dB`,
    });
  }
  return moves;
}

/**
 * The panel's APPLY: ONE command carrying the master match-EQ curve, the
 * loudness trim, and every unmuted per-track fader move as a single undo step.
 * Returns null when there is nothing to apply. Each sub-move rides an existing
 * command (`applyMasterMatchEqCommand`, `setTrackParams`) — no new mutation
 * paths — and is folded through `snapshot` so Ctrl-Z reverts the whole match.
 */
export function applyMatchCommand(
  doc: ProjectDocument,
  report: ReferenceMatchReport,
  moves: readonly MatchStripMove[],
): Command | null {
  const before = doc;
  let after = doc;
  let changed = false;

  if (report.curve !== null || report.loudnessTrimDb !== null) {
    after = applyMasterMatchEqCommand(after, report.curve, report.loudnessTrimDb ?? undefined).execute(after);
    changed = true;
  }

  for (const move of moves) {
    if (move.owner.strip.muted || move.gainDb === 0) continue;
    const track = after.tracks.find((candidate) => candidate.id === move.owner.strip.id);
    if (!track) continue;
    // Linear gain from the current value; setTrackParams clamps [0,1.5].
    const nextGain = track.gain * Math.pow(10, move.gainDb / 20);
    after = setTrackParams(after, track.id, { gain: nextGain }).execute(after);
    changed = true;
  }

  if (!changed) return null;
  return snapshot("referenceMatch", "Apply reference match", before, after);
}

/**
 * MASTERING VERIFICATION — the measured half of a mastering move.
 *
 * Loudness alone is not mastering. A trim can hit −14 LUFS while the crest
 * collapses, the low end takes over or the stereo image narrows. This module
 * reads the SAME `analyzeMixHealthBuffer` report the Mix Doctor uses and
 * compares before/after, so a mastering report can state what changed beyond
 * the LUFS target.
 *
 * These are measurements, not a taste verdict. A human A/B is still the final
 * gate for "warm", "punchy" or "expensive".
 */
import { analyzeMixHealthBuffer, type MixHealthReport } from "../analysis/mixDoctor";

export interface MasteringSnapshot {
  /** BS.1770 gated integrated loudness; null when unmeasurable. */
  lufs: number | null;
  crestDb: number;
  /** sub + low share, in percent. */
  lowEndPct: number;
  /** −1..+1 mono-to-wide correlation; null when mono. */
  stereoCorrelation: number | null;
}

export interface MasteringComparison {
  before: MasteringSnapshot;
  after: MasteringSnapshot;
  deltaLufs: number | null;
  deltaCrestDb: number;
  deltaLowEndPct: number;
  deltaStereoCorrelation: number | null;
  /** Human-readable evidence line for the loudness/mastering report. */
  line: string;
}

export function snapshotMixHealth(report: MixHealthReport): MasteringSnapshot {
  return {
    lufs: report.integratedLufs,
    crestDb: report.crestDb,
    lowEndPct: report.lowEndShare * 100,
    stereoCorrelation: report.stereoCorrelation,
  };
}

export function snapshotBuffer(buffer: AudioBuffer): MasteringSnapshot {
  return snapshotMixHealth(analyzeMixHealthBuffer(buffer));
}

function signed(value: number, digits = 1): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function lufsText(value: number | null): string {
  return value == null ? "unmeasured" : `${value.toFixed(1)} LUFS`;
}

export function compareMasteringSnapshots(before: MasteringSnapshot, after: MasteringSnapshot): MasteringComparison {
  const deltaLufs = before.lufs != null && after.lufs != null ? after.lufs - before.lufs : null;
  const deltaCrestDb = after.crestDb - before.crestDb;
  const deltaLowEndPct = after.lowEndPct - before.lowEndPct;
  const deltaStereoCorrelation =
    before.stereoCorrelation != null && after.stereoCorrelation != null
      ? after.stereoCorrelation - before.stereoCorrelation
      : null;
  const parts = [
    `loudness ${lufsText(before.lufs)} → ${lufsText(after.lufs)}${deltaLufs != null ? ` (${signed(deltaLufs)} LU)` : ""}`,
    `crest ${before.crestDb.toFixed(1)} → ${after.crestDb.toFixed(1)} dB (${signed(deltaCrestDb)} dB)`,
    `low-end ${before.lowEndPct.toFixed(1)} → ${after.lowEndPct.toFixed(1)} % (${signed(deltaLowEndPct)} pts)`,
  ];
  if (deltaStereoCorrelation != null) {
    parts.push(
      `stereo corr ${before.stereoCorrelation!.toFixed(2)} → ${after.stereoCorrelation!.toFixed(2)} (${signed(deltaStereoCorrelation, 2)})`,
    );
  }
  return {
    before,
    after,
    deltaLufs,
    deltaCrestDb,
    deltaLowEndPct,
    deltaStereoCorrelation,
    line: parts.join(" · "),
  };
}

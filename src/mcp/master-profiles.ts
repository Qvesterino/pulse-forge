/**
 * MASTERING PLATFORM PROFILES (mastering wave, ADR 0020 lineage) — the
 * loudness/true-peak contract per delivery platform, plus the verdict math.
 * Pure data + pure rules: the same numbers the export verdict and the
 * assistant see, one source of truth.
 *
 * Targets follow the platforms' published normalization: Spotify/YouTube
 * normalize around −14 LUFS, Apple Music around −16; true-peak ceilings leave
 * headroom for lossy codec clipping (−1 dBTP is the usual safe floor, −0.3
 * only for loud/club deliveries where normalization is not expected). Vinyl
 * is a PRE-MASTER contract: cutting lathes want headroom (−2 dBTP hard) and
 * mono-compatible bass — the mono check itself is informational here.
 */

export interface MasterProfile {
  id: "streaming" | "apple" | "loud" | "vinyl";
  label: string;
  targetLufs: number;
  maxTruePeakDb: number;
  note: string;
}

export const MASTER_PROFILES: MasterProfile[] = [
  {
    id: "streaming",
    label: "Streaming — Spotify / YouTube / Tidal",
    targetLufs: -14,
    maxTruePeakDb: -1,
    note: "platforms normalize to ≈−14 LUFS; −1 dBTP leaves codec headroom",
  },
  {
    id: "apple",
    label: "Apple Music",
    targetLufs: -16,
    maxTruePeakDb: -1,
    note: "Apple normalizes around −16 LUFS (soundcheck)",
  },
  {
    id: "loud",
    label: "Club / Loud",
    targetLufs: -8,
    maxTruePeakDb: -0.3,
    note: "no normalization expected — loudness is the point, guard the PA",
  },
  {
    id: "vinyl",
    label: "Vinyl Pre-Master",
    targetLufs: -12,
    maxTruePeakDb: -2,
    note: "cutting lathe headroom — keep bass mono below ~150 Hz (ŠÍRKA lowWidth 0)",
  },
];

export function profileFor(id: string | undefined): MasterProfile | null {
  return MASTER_PROFILES.find((profile) => profile.id === id) ?? null;
}

export interface PlatformVerdict {
  status: "pass" | "warn" | "fail";
  line: string;
}

/** Verdict of one measurement against one platform profile. */
export function verdictAgainst(
  m: { lufs: number | null; truePeakDb: number },
  profile: MasterProfile,
): PlatformVerdict[] {
  const out: PlatformVerdict[] = [];
  if (m.lufs == null) {
    out.push({ status: "warn", line: `${profile.label}: LUFS not measurable — play a few seconds for integration to settle` });
  } else {
    const delta = m.lufs - profile.targetLufs;
    const adelta = Math.abs(delta);
    const status: PlatformVerdict["status"] = adelta <= 1 ? "pass" : adelta <= 2 ? "warn" : "fail";
    const where = delta > 0 ? `${delta.toFixed(1)} LU HOT` : `${(-delta).toFixed(1)} LU under`;
    out.push({
      status,
      line: `${profile.label}: ${m.lufs.toFixed(1)} LUFS vs target ${profile.targetLufs} — ${where}`,
    });
  }
  const tpOver = m.truePeakDb - profile.maxTruePeakDb;
  if (tpOver > 0.3) {
    out.push({ status: "fail", line: `true peak ${m.truePeakDb.toFixed(1)} dBTP exceeds the ${profile.maxTruePeakDb} dBTP ceiling by ${tpOver.toFixed(1)} dB` });
  } else if (tpOver > 0) {
    out.push({ status: "warn", line: `true peak ${m.truePeakDb.toFixed(1)} dBTP grazes the ${profile.maxTruePeakDb} dBTP ceiling` });
  } else {
    out.push({ status: "pass", line: `true peak ${m.truePeakDb.toFixed(1)} dBTP within the ${profile.maxTruePeakDb} dBTP ceiling` });
  }
  if (profile.id === "vinyl") {
    out.push({ status: "warn", line: `${profile.note} (run ŠÍRKA lowWidth 0 — the mono check is not automated yet)` });
  }
  return out;
}

/** Worst status across verdicts — the one-line summary status. */
export function worstStatus(verdicts: PlatformVerdict[]): PlatformVerdict["status"] {
  if (verdicts.some((v) => v.status === "fail")) return "fail";
  if (verdicts.some((v) => v.status === "warn")) return "warn";
  return "pass";
}

/**
 * ATTENTIVE MODE (F3 of docs/INTENT-REACTION-LISTENING-PLAN.md) — the engine
 * that notices. Opt-in (default OFF): when a song audition renders, the
 * section meters are compared against the song's own median and anything
 * that reads as a MEASURED complaint surfaces as a suggestion chip —
 * audition-first, never a silent bake, at most one finding per section.
 *
 * v1 finding vocabulary mirrors what the evidence actually supports (the
 * same QUIET_GAP_DB = 6 rule the complaints diagnosis uses):
 *   quiet section (≥ 6 dB under the song median) → "empty/thin" finding
 *     → chips: more energy / more density in the section (revise flow)
 *
 * Everything above that (muddy/harsh/noPunch) needs per-role spectral
 * evidence the section meters do not carry yet — deliberately NOT claimed
 * here. Silence is the default: no finding, no chip.
 */
import type { SongSectionMeter } from "./song-audio-review";
import { diagnoseComplaint } from "./complaints";

export const ATTENTIVE_MODE_KEY = "pf:attentive-mode";
/** A section this far under the song's own median RMS reads as empty. */
export const ATTENTIVE_QUIET_GAP_DB = 6;
/** At most this many chips surface per analysis — attention, not a wall. */
export const ATTENTIVE_MAX_FINDINGS = 3;

export function isAttentiveModeEnabled(): boolean {
  try {
    return localStorage.getItem(ATTENTIVE_MODE_KEY) === "on";
  } catch {
    return false;
  }
}

export function setAttentiveModeEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(ATTENTIVE_MODE_KEY, "on");
    else localStorage.removeItem(ATTENTIVE_MODE_KEY);
  } catch {
    /* storage unavailable — the mode simply stays off */
  }
}

export interface AttentiveFinding {
  role: string;
  kind: "empty" | "thin";
  rmsDbfs: number;
  gapToMedianDb: number;
  /** Executable instruction chips (revise-flow; nothing auto-applies). */
  chips: Array<{ label: string; instruction: string }>;
  evidence: string;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Pure: section meters → measured findings. A song whose sections sit within
 * 6 dB of their own median yields NOTHING (the honest default). NEVER throws.
 */
export function findingsFromSectionMeters(meters: readonly SongSectionMeter[]): AttentiveFinding[] {
  const usable = meters.filter((meter) => Number.isFinite(meter.rmsDbfs) && meter.rmsDbfs > -60);
  if (usable.length < 2) return []; // a median over one section proves nothing
  const medianRms = median(usable.map((meter) => meter.rmsDbfs));

  const findings: AttentiveFinding[] = [];
  for (const meter of usable) {
    const gap = Math.round((meter.rmsDbfs - medianRms) * 10) / 10;
    if (gap > -ATTENTIVE_QUIET_GAP_DB) continue;
    const kind: AttentiveFinding["kind"] = gap <= -2 * ATTENTIVE_QUIET_GAP_DB ? "empty" : "thin";
    const diagnosis = diagnoseComplaint({ kind, role: meter.role, family: null });
    const chips = (diagnosis?.proposals ?? []).map((proposal) => ({
      label: proposal.label,
      instruction: proposal.instruction,
    }));
    findings.push({
      role: meter.role,
      kind,
      rmsDbfs: meter.rmsDbfs,
      gapToMedianDb: gap,
      chips,
      evidence: `${meter.role} RMS ${meter.rmsDbfs.toFixed(1)} dBFS, ${Math.abs(gap).toFixed(1)} dB pod mediánom pesničky`,
    });
  }

  findings.sort((a, b) => a.gapToMedianDb - b.gapToMedianDb); // quietest first
  return findings.slice(0, ATTENTIVE_MAX_FINDINGS);
}

/** One SK status line summarizing the findings ("" when none). */
export function attentiveStatusLine(findings: readonly AttentiveFinding[]): string {
  if (findings.length === 0) return "";
  const parts = findings.map((finding) => `${finding.role} ${finding.evidence.split(",")[1]?.trim() ?? ""}`);
  return `🎧 pozorný režim: ${parts.join(" · ")}`;
}

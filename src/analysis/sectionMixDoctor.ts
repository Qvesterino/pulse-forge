/**
 * U5 — SECTION MIX DOCTOR (UN-SUNO): "mix-doctor sits beside you" findings
 * over the SOURCE track, shown right after a BUILD PROJECT reconstruction.
 *
 * Two measured, deliberately conservative heuristics:
 *
 * 1. SECTION BALANCE — a section whose broadband RMS sits ≥ QUIET_DELTA_DB
 *    under the median of all sections. This is the "chorus is 3 dB quieter
 *    than the verse" observation; the fix is musical (revive the section in
 *    the reconstructed project), so it is REPORT-ONLY by design.
 *
 * 2. LOW-END MASKING — a section where the 60–120 Hz band carries most of
 *    the energy (bass-dense) while the low band has almost no transient
 *    contrast (no visible kick punch above the sustain). That is the
 *    "the bass masks the kick around 60 Hz" situation. Also REPORT-ONLY:
 *    which of bass/kick should yield is a taste decision.
 *
 * The mechanically-safe master fixes (dark tilt, master input trim) stay in
 * mixDoctor.deriveMixAutoFix — the panel offers that separately as a chip.
 *
 * Etiquette (the W0.2 rule): findings exist only where something was
 * MEASURED; a clean section list produces an empty array, never advice.
 * Pure, deterministic, no RNG.
 */

export interface SectionMixFinding {
  kind: "section-quiet" | "low-masking";
  /** User-facing one-liner (Slovak, panel language). */
  message: string;
  /** The measured numbers behind the claim. */
  evidence: string;
  /** Section role this finding belongs to (absent for track-level notes). */
  section?: string;
}

export interface SectionMixInput {
  role: string;
  startSec: number;
  endSec: number;
}

/** A section at least this long carries a mix character worth measuring. */
const MIN_SECTION_SEC = 1;
/** Quiet-section threshold against the section median. */
const QUIET_DELTA_DB = 3;
/** A section whose low band (≤120 Hz) holds more than this share of its
 * total energy counts as bass-dense. */
const LOW_DENSE_SHARE = 0.55;
/** Below this peak-to-sustain contrast the low band has no visible kick
 * punch — the bass is the only story down there. */
const TRANSIENT_CONTRAST_MAX = 1.7;

/** One-pole low-pass RMS cascade: e60 ⊂ e120 hierarchically, so the 60–120
 * band energy is estimated as sqrt(max(e120² − e60², 0)). Cheap O(n) pass.
 * Input must already be DC-free (see dcFreeSlice). */
function lowBandRms(data: Float32Array, sampleRate: number, from: number, to: number): { e120: number } {
  const coeff60 = Math.exp((-2 * Math.PI * 60) / sampleRate);
  const coeff120 = Math.exp((-2 * Math.PI * 120) / sampleRate);
  let lp60 = 0;
  let lp120 = 0;
  let s60 = 0;
  let s120 = 0;
  const lo = Math.max(0, from);
  const hi = Math.min(data.length, to);
  for (let i = lo; i < hi; i++) {
    const x = data[i];
    lp60 = x + coeff60 * (lp60 - x);
    lp120 = x + coeff120 * (lp120 - x);
    s60 += lp60 * lp60;
    s120 += lp120 * lp120;
  }
  const count = Math.max(1, hi - lo);
  void s60;
  return { e120: Math.sqrt(s120 / count) };
}

function toDb(value: number): number {
  return 20 * Math.log10(Math.max(value, 1e-6));
}

export function analyzeSectionMix(
  channels: readonly Float32Array[],
  sampleRate: number,
  sections: readonly SectionMixInput[],
): SectionMixFinding[] {
  if (channels.length === 0 || sampleRate <= 0 || sections.length < 2) return [];
  const mono = new Float32Array(channels[0].length);
  for (let i = 0; i < mono.length; i++) {
    let sum = 0;
    for (const channel of channels) sum += channel[i] ?? 0;
    mono[i] = sum / channels.length;
  }

  const usable = sections.filter((section) => section.endSec - section.startSec >= MIN_SECTION_SEC);
  if (usable.length < 2) return [];

  // DC-free measurement: a one-pole low-pass at 120 Hz passes DC COMPLETELY,
  // so an un-removed offset reads as "100 % of the energy is low-band with
  // no transient contrast" — a fabricated bass-masking finding on a silent
  // render with an offset (probe-verified 2026-10-06). Subtract the section
  // mean before every measurement; zero-mean material is unchanged.
  const dcFreeSlice = (from: number, to: number): Float32Array => {
    const lo = Math.max(0, from);
    const hi = Math.min(mono.length, to);
    const slice = mono.slice(lo, hi);
    let mean = 0;
    for (let i = 0; i < slice.length; i++) mean += slice[i]!;
    mean /= Math.max(1, slice.length);
    for (let i = 0; i < slice.length; i++) slice[i] = slice[i]! - mean;
    return slice;
  };
  const rmsOf = (data: Float32Array): number => {
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    return Math.sqrt(sum / Math.max(1, data.length));
  };

  const levels = usable.map((section) => {
    const slice = dcFreeSlice(Math.round(section.startSec * sampleRate), Math.round(section.endSec * sampleRate));
    return toDb(rmsOf(slice));
  });
  const medianLevel = [...levels].sort((a, b) => a - b)[Math.floor(levels.length / 2)];

  const findings: SectionMixFinding[] = [];
  usable.forEach((section, index) => {
    const delta = medianLevel - levels[index];
    if (delta >= QUIET_DELTA_DB) {
      findings.push({
        kind: "section-quiet",
        section: section.role,
        message: `„${section.role}" je o ${delta.toFixed(1)} dB tichšia než medián sekcií`,
        evidence: `${levels[index].toFixed(1)} dBFS vs medián ${medianLevel.toFixed(1)} dBFS`,
      });
    }

    const slice = dcFreeSlice(Math.round(section.startSec * sampleRate), Math.round(section.endSec * sampleRate));
    const full = rmsOf(slice);
    const { e120 } = lowBandRms(slice, sampleRate, 0, slice.length);
    const lowShare = full > 0 ? e120 / full : 0;
    // Transient contrast: loudest 20 ms low-band window vs the section's
    // typical 200 ms window. A kick under the bass shows as a clear peak.
    let peak20 = 0;
    const window = Math.max(1, Math.round(0.02 * sampleRate));
    const step = Math.max(1, Math.round(0.01 * sampleRate));
    for (let i = 0; i + window < slice.length; i += step) {
      const value = rmsOf(slice.subarray(i, i + window));
      if (value > peak20) peak20 = value;
    }
    const contrast = e120 > 0 ? peak20 / e120 : 0;
    if (lowShare > LOW_DENSE_SHARE && contrast < TRANSIENT_CONTRAST_MAX) {
      findings.push({
        kind: "low-masking",
        section: section.role,
        message: `„${section.role}": basa môže maskovať kick okolo 60–120 Hz (hustý bas, bez viditeľného kick translientu)`,
        evidence: `low share ${(lowShare * 100).toFixed(0)} %, transient contrast ${contrast.toFixed(2)}`,
      });
    }
  });
  return findings;
}

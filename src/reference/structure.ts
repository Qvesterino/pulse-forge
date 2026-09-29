import type { Marker } from "../project-model/types";
import type { ReferenceSection, ReferenceStructure } from "./types";

/**
 * Structure — "where is what": energy curve + section map.
 *
 * Ported from `beat_modifier/src/app/pipelines/analysis.py` (`_rms_envelope`,
 * `_energy_curve`, `_structure_from_energy`, `_section_role`), 1:1 on the
 * math: Hann 2048 / hop 512, chunk-mean / max, and the same
 * `0.4 * median` / `0.7` threshold pair.
 *
 * Two deliberate departures from the Python source, both documented in
 * docs/REFERENCE-MAP-ROADMAP.md §2.1:
 *
 * 1. **Sections snap to the beat grid.** The source works in normalized
 *    position only, so a section edge lands wherever the energy bucket
 *    happened to fall — musically meaningless, and useless as a marker. We
 *    keep the raw position AND add beat-anchored seconds, so "import as
 *    markers" puts cues on downbeats instead of between kicks.
 * 2. **Long flat runs merge.** A 16-point energy curve over a quiet intro can
 *    oscillate across the threshold and produce a dozen "breakdown" sections
 *    in eight seconds. `_minSectionSeconds` collapses those, which the source
 *    does not do and needed to.
 *
 * Determinism is the F1 contract, so: no RNG, no clock, fixed iteration order.
 */

const FRAME = 2048;
const HOP = 512;

/** Minimum energy-point count. Longer tracks get more points. */
const MIN_ENERGY_POINTS = 16;
const MAX_ENERGY_POINTS = 64;
const MIN_SECTION_SECONDS = 1.5;

/** Energy label thresholds, ported from the Python source. */
const LOW_FACTOR = 0.4;
const HIGH_FACTOR = 0.7;
const MEDIAN_FLOOR = 0.1;

/** Hann-windowed RMS envelope. Returns [] only for an empty signal. */
function rmsEnvelope(signal: Float32Array): Float32Array {
  if (signal.length < FRAME) {
    // Shorter than one frame: the whole buffer is the measurement, not zeros.
    let sq = 0;
    for (let i = 0; i < signal.length; i++) sq += signal[i] * signal[i];
    return new Float32Array([signal.length ? Math.sqrt(sq / signal.length) : 0]);
  }
  const nFrames = 1 + Math.floor((signal.length - FRAME) / HOP);
  const out = new Float32Array(nFrames);
  // Precomputed Hann window — recomputing 2048 cosines per frame would cost
  // more than the FFT that follows it in the caller.
  const win = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i++) win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / FRAME));

  for (let f = 0; f < nFrames; f++) {
    const start = f * HOP;
    let sq = 0;
    for (let i = 0; i < FRAME; i++) {
      const v = signal[start + i] * win[i];
      sq += v * v;
    }
    out[f] = Math.sqrt(sq / FRAME);
  }
  return out;
}

/**
 * Energy curve as `nPoints` samples of {position 0..1, energy 0..1}.
 * Point count scales with duration but stays within [16, 64] as the roadmap
 * specifies, so a 10-minute track does not produce 500 sections.
 */
export function energyCurve(signal: Float32Array, durationSeconds: number): ReferenceStructure["energyCurve"] {
  const rms = rmsEnvelope(signal);
  if (rms.length === 0) {
    return [
      { position: 0, energy: 0 },
      { position: 1, energy: 0 },
    ];
  }
  const nPoints = Math.min(MAX_ENERGY_POINTS, Math.max(MIN_ENERGY_POINTS, Math.round(durationSeconds / 4) + 1));
  const max = rms.reduce((m, v) => (v > m ? v : m), 0) + 1e-9;
  const points: ReferenceStructure["energyCurve"] = [];
  // np.array_split semantics: the first chunks absorb the remainder, so the
  // curve always spans exactly 0..1 with no short tail.
  const base = Math.floor(rms.length / nPoints);
  const extra = rms.length % nPoints;
  let cursor = 0;
  for (let i = 0; i < nPoints; i++) {
    const size = base + (i < extra ? 1 : 0);
    let sum = 0;
    for (let j = 0; j < size; j++) sum += rms[cursor + j];
    cursor += size;
    const mean = size > 0 ? sum / size : 0;
    points.push({
      position: (i + 0.5) / nPoints,
      energy: Math.min(1, Math.max(0, mean / max)),
    });
  }
  return points;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Port of `_section_role`, with one correction.
 *
 * The source decides from the section's START position (`pos > 0.9 → outro`).
 * That works only when the outro is very short. A track whose last 20% is a
 * tail-off produces a final section starting at ~0.84, which falls through to
 * the label check and gets labelled "breakdown" — so an outro imports as a
 * neutral cue instead of an `impact`, and the timeline loses the one marker
 * that says "this is where it ends".
 *
 * The correction: a section that RUNS TO THE END is the outro, whatever its
 * start. That is the definition, not a heuristic.
 */
function sectionRole(position: number, label: "low" | "mid" | "high", isLast: boolean): ReferenceSection["role"] {
  if (position < 0.15) return "intro";
  if (position > 0.9 || isLast) return "outro";
  if (label === "high") return "drop";
  if (label === "low") return "breakdown";
  return "development";
}

/**
 * Marker type for a role. This is the bridge that makes section import free:
 * a "drop" section becomes a `drop` marker, which the arrangement view and
 * `markerAssetFor()` already know how to colour and sound.
 */
export function markerTypeForRole(role: ReferenceSection["role"]): Marker["type"] {
  switch (role) {
    case "drop":
      return "drop";
    case "intro":
      return "buildup";
    case "breakdown":
      return "cue";
    case "outro":
      return "impact";
    default:
      return "custom";
  }
}

export interface StructureOptions {
  /** Duration of the analysed signal in seconds. */
  durationSeconds: number;
  /** F1 beat times, used to snap section edges onto the grid. */
  beatTimes: number[];
  /** Tempo used to convert beat index → seconds. */
  bpm: number | null;
}

/**
 * Section map from the energy curve, with beat-anchored boundaries.
 *
 * Returns [] only when there is nothing to say (an all-silent curve), in
 * which case the caller reports the honest null rather than inventing a
 * one-section "full" placeholder.
 */
export function sectionsFromEnergy(
  curve: ReferenceStructure["energyCurve"],
  options: StructureOptions,
): ReferenceStructure["sections"] {
  if (curve.length === 0) return [];
  const energies = curve.map((p) => p.energy);

  // A curve with no dynamic range has no structure to claim. Without this,
  // a flat curve labels the whole track one long "intro" and the marker
  // import writes a cue at bar 1 for a file that has no shape at all — the
  // F1 contract is an honest null, not a fabricated section. (In practice
  // analyzeReference short-circuits silence before reaching here; this guard
  // covers the flat-but-not-silent case, e.g. a held drone.)
  const peak = energies.reduce((m, v) => (v > m ? v : m), 0);
  const floor = energies.reduce((m, v) => (v < m ? v : m), peak);
  if (peak - floor < 0.05) return [];

  const mid = median(energies);
  const lowCut = LOW_FACTOR * Math.max(mid, MEDIAN_FLOOR);

  const labels: ("low" | "mid" | "high")[] = curve.map((p) =>
    p.energy < lowCut ? "low" : p.energy > HIGH_FACTOR ? "high" : "mid",
  );

  // Raw sections from consecutive equal labels.
  const raw: Array<{ role: ReferenceSection["role"]; start: number; end: number; energy: number }> = [];
  let start = 0;
  for (let i = 1; i <= labels.length; i++) {
    if (i !== labels.length && labels[i] === labels[start]) continue;
    const endPos = i < labels.length ? curve[i].position : 1;
    const segEnergy = energies.slice(start, Math.max(i, start + 1)).reduce((a, b) => a + b, 0) / Math.max(1, i - start);
    raw.push({
      role: sectionRole(curve[start].position, labels[start], endPos >= 1),
      start: Math.min(curve[start].position, endPos),
      end: Math.min(endPos, 1),
      energy: segEnergy,
    });
    start = i;
  }

  // Merge runs shorter than MIN_SECTION_SECONDS into the previous section.
  // Without this, a quiet intro oscillating around the threshold yields a
  // dozen sections in eight seconds and the marker import is unusable.
  const merged: typeof raw = [];
  for (const section of raw) {
    const previous = merged[merged.length - 1];
    const tooShort = (section.end - section.start) * options.durationSeconds < MIN_SECTION_SECONDS;
    if (previous && tooShort && previous.role === section.role) {
      previous.end = section.end;
      continue;
    }
    if (previous && tooShort && previous.role !== section.role && merged.length === 1) {
      // Keep the first section's role (it carries the intro/outro position
      // meaning) and absorb the runt.
      previous.end = section.end;
      continue;
    }
    merged.push({ ...section });
  }

  const beatTimes = options.beatTimes;
  const secondsPerBeat = options.bpm && options.bpm > 0 ? 60 / options.bpm : null;
  return merged.map((section) => {
    const startSec = section.start * options.durationSeconds;
    const endSec = section.end * options.durationSeconds;
    const snapped = snapToBeat(startSec, endSec, beatTimes, secondsPerBeat);
    return {
      role: section.role,
      startSec: snapped.startSec,
      endSec: snapped.endSec,
      startBeat: snapped.startBeat,
      endBeat: snapped.endBeat,
      energy: Number(section.energy.toFixed(4)),
      markerType: markerTypeForRole(section.role),
    };
  });
}

/**
 * Snap a time range to the nearest detected beat, preserving order and a
 * minimum length of one beat. Snapping is what separates "a marker between
 * two kicks" from "a marker on the downbeat".
 */
function snapToBeat(
  startSec: number,
  endSec: number,
  beatTimes: number[],
  secondsPerBeat: number | null,
): { startSec: number; endSec: number; startBeat: number | null; endBeat: number | null } {
  if (secondsPerBeat === null || beatTimes.length === 0) {
    return { startSec, endSec, startBeat: null, endBeat: null };
  }
  const nearestBeat = (t: number): { time: number; index: number } | null => {
    if (beatTimes.length === 0) return null;
    let best = 0;
    let bestDist = Math.abs(beatTimes[0] - t);
    for (let i = 1; i < beatTimes.length; i++) {
      const dist = Math.abs(beatTimes[i] - t);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    return { time: beatTimes[best], index: best };
  };

  const start = nearestBeat(startSec);
  const end = nearestBeat(endSec);
  const snappedStart = start ? start.time : startSec;
  let snappedEnd = end ? end.time : endSec;
  // A section that snapped onto or before its own start would render as a
  // zero-width band; give it exactly one beat so it stays visible.
  if (snappedEnd <= snappedStart) snappedEnd = snappedStart + secondsPerBeat;
  return {
    startSec: snappedStart,
    endSec: snappedEnd,
    startBeat: start ? start.index : null,
    endBeat: end ? end.index : null,
  };
}

/**
 * Sections ready for marker import: one marker per section start, in seconds
 * and in the tempo the caller will apply. Kept here so the panel does not
 * re-derive the mapping.
 */
export function sectionsToMarkerSeconds(
  sections: ReferenceStructure["sections"],
  _bpm: number | null,
): Array<{ sec: number; role: ReferenceSection["role"]; markerType: Marker["type"] }> {
  return sections.map((s) => ({ sec: s.startSec, role: s.role, markerType: s.markerType }));
}

/** Convenience for tests and for the panel's headline. */
export function dominantRole(sections: ReferenceStructure["sections"]): ReferenceSection["role"] | null {
  if (sections.length === 0) return null;
  const first = sections[0];
  return first.role;
}

/** Mean energy across the curve — the "how loud overall" headline number. */
export function averageEnergy(curve: ReferenceStructure["energyCurve"]): number {
  if (curve.length === 0) return 0;
  return Number((curve.reduce((a, p) => a + p.energy, 0) / curve.length).toFixed(4));
}

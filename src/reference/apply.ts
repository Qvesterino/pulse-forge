/**
 * Reference Map → project commands (F4-full).
 *
 * This is the seam that makes the analysis *act*. Everything here is a pure
 * function of `(ProjectDocument, ReferenceMap) → Command`, so the mapping is
 * testable without React and the panel only ever describes intent — the same
 * split the rest of the app obeys (UI describes, commands mutate).
 *
 * Three honesty rules shape this module, and they are why some things are
 * missing on purpose:
 *
 * 1. **No value is invented.** F1 measures tempo and key; it does not measure
 *    sections or swing. So there is no `applyReferenceSections` — sections are
 *    an energy question (F2) and a swing number derived from a uniform beat
 *    grid would be fiction. {@link applyReferenceGroove} therefore takes swing
 *    as an explicit *user* value, never as a detected one.
 *
 * 2. **Detected and confirmed stay separate.** Commands always act on the
 *    value the producer is looking at on screen, which may be a correction.
 *
 * 3. **Every action is one undo step.** Marker import adds N markers but is a
 *    single `snapshot()` command, so one Ctrl-Z removes the whole import
 *    rather than peeling markers off one at a time.
 */

import { BAR_TICKS, PPQ, type ProjectDocument } from "../project-model/types";
import type { MusicalKey } from "../project-model/types";
import { addMarker, setBpm, setGroove, setProjectKey, snapshot } from "../commands/commands";
import type { Command } from "../commands/types";
import type { GrooveSettings } from "../project-model/types";
import { PITCH_CLASSES, type PitchClass, type ReferenceMap, type ReferenceMode } from "./types";

/** How the producer reads the detected tempo. */
export type TempoReading = "as-detected" | "half" | "double";

/**
 * KYX names its scales ("Natural Minor"), the analyzer names its modes
 * ("minor"). The mapping is total: F1 only ever emits major or minor, and
 * `MusicalKey` contains every root against both of those scale labels, so
 * this cannot produce an out-of-union string. `tests/reference/apply.test.ts`
 * asserts that totality rather than trusting the cast.
 */
const SCALE_FOR_MODE: Record<ReferenceMode, MusicalKey extends string ? string : never> = {
  major: "Major",
  minor: "Natural Minor",
};

/** MusicalKey for a detected (or user-chosen) tonic + mode, or null if out of range. */
export function musicalKeyFor(tonic: PitchClass | string, mode: ReferenceMode | string): MusicalKey | null {
  if (!(PITCH_CLASSES as readonly string[]).includes(tonic)) return null;
  const scale = mode === "major" ? SCALE_FOR_MODE.major : mode === "minor" ? SCALE_FOR_MODE.minor : null;
  if (!scale) return null;
  return `${tonic} ${scale}` as MusicalKey;
}

/**
 * The tempo the user is actually looking at: a typed correction wins, then the
 * half/double reading, then the raw detection. Null when nothing was detected
 * — the caller must not substitute a guess.
 */
export function effectiveBpm(map: ReferenceMap, reading: TempoReading, confirmed?: number | null): number | null {
  if (confirmed !== null && confirmed !== undefined && Number.isFinite(confirmed)) return confirmed;
  const detected = map.rhythm.bpm;
  if (detected === null) return null;
  if (reading === "half") return detected / 2;
  if (reading === "double") return detected * 2;
  return detected;
}

/** Project tempo is clamped to MIN/MAX_BPM inside `setBpm`; report what landed. */
export function bpmCommand(doc: ProjectDocument, bpm: number): Command {
  return setBpm(doc, bpm);
}

/**
 * Set the project's key/scale hint. `MusicalKey` is a *hint* the project
 * already carries for quantize and the intent pipeline — this routes the
 * detected key into that existing source of truth instead of inventing a new
 * one (the F4 rule: "nevymýšľať nový source-of-truth").
 */
export function keyCommand(doc: ProjectDocument, tonic: string | null, mode: ReferenceMode | string | null): Command | null {
  if (!tonic || !mode) return null;
  const key = musicalKeyFor(tonic, mode);
  if (!key) return null;
  return setProjectKey(doc, key);
}

export interface PhraseMarkerOptions {
  /** Beats per phrase — 4 = one bar, 8 = two, 16 = four. */
  beatsPerPhrase: number;
  /** Tempo used to convert the reference's seconds into project ticks. */
  bpm: number;
  /** Prefix for the marker names, e.g. "Ref track.wav". */
  label?: string;
}

/**
 * Seconds → project ticks at `bpm` (PPQ 480). Tick length is tempo-dependent
 * by definition, so a reference analysed at 128 places differently in a 120
 * project. The panel passes the tempo the project *will* have after applying
 * the reference, and warns when the two differ.
 */
export function secondsToTicks(seconds: number, bpm: number): number {
  if (!Number.isFinite(seconds) || !Number.isFinite(bpm) || bpm <= 0) return 0;
  return Math.round((seconds * bpm * PPQ) / 60);
}

/**
 * Drop a marker on every phrase boundary of the detected beat grid.
 *
 * This is a *phrase* grid, not F2's section detection: it says "a bar line
 * falls here", which is a fact the beat grid carries. It cannot say "the drop
 * is here" — that needs an energy curve.
 *
 * Markers land on bar boundaries so they stay musically meaningful when the
 * project tempo differs slightly from the reference; a marker stranded
 * between bars is worse than one nudged to the nearest line.
 */
export function markerCommand(doc: ProjectDocument, map: ReferenceMap, options: PhraseMarkerOptions): Command | null {
  const { beatsPerPhrase, bpm, label } = options;
  const { beatTimes } = map.rhythm;
  if (beatTimes.length < beatsPerPhrase || beatsPerPhrase < 1) return null;

  const boundaryTicks: number[] = [];
  for (let beat = 0; beat < beatTimes.length; beat += beatsPerPhrase) {
    const raw = secondsToTicks(beatTimes[beat], bpm);
    // Snap to the nearest bar so a small tempo disagreement does not leave
    // the marker visibly off the grid.
    const snapped = Math.round(raw / BAR_TICKS) * BAR_TICKS;
    if (snapped > 0) boundaryTicks.push(snapped);
  }
  // Two boundaries can collapse onto the same bar after snapping; duplicates
  // would stack markers on one line and make the timeline unreadable.
  const unique = [...new Set(boundaryTicks)].sort((a, b) => a - b);
  if (unique.length === 0) return null;

  const prefix = label ? `${label} ` : "";
  const before = doc;
  const after = unique.reduce(
    (d, tick) => addMarker(d, { tick, type: "cue", name: `${prefix}Phrase ${tick / BAR_TICKS + 1}` }).execute(d),
    doc,
  );
  if (after.markers.length === before.markers.length) return null;
  return snapshot("importReferenceMarkers", `Import ${unique.length} phrase markers from reference`, before, after);
}

/**
 * Write groove feel. `swing` is a *user* value in F4 — the analyzer does not
 * measure it (F3 owns that), and this function never fabricates one.
 *
 * Clamped to the ranges the playback runtime already assumes: swing is a
 * 0..1 fraction of a 16th note, humanize values are 0..1 amounts.
 */
export function grooveCommand(
  doc: ProjectDocument,
  settings: Partial<Pick<GrooveSettings, "swing" | "humanizeTiming" | "humanizeVelocity">>,
): Command | null {
  const cleaned: Partial<GrooveSettings> = {};
  for (const key of ["swing", "humanizeTiming", "humanizeVelocity"] as const) {
    const value = settings[key];
    if (value === undefined || !Number.isFinite(value)) continue;
    cleaned[key] = Math.min(1, Math.max(0, value));
  }
  if (Object.keys(cleaned).length === 0) return null;
  return setGroove(doc, cleaned);
}

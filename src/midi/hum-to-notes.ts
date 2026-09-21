import type { NoteEvent, MusicalKey, Pattern, ProjectDocument } from "../project-model/types";
import { PPQ, STEP_TICKS } from "../project-model/types";
import { snapToScale } from "../project-model/scales";
import { uid } from "../shared/ids";
import { snapshot } from "../commands/commands";
import type { PitchFrame } from "../audio-workers/pitch-tracker";

/**
 * HUM-TO-MELODY (sound-quality wave: the signature beginner feature).
 *
 * Hummed/sung audio → pitch frames (pitch-tracker worker) → NOTE EVENTS in
 * the current pattern, snapped to the project key and the 16th-note grid.
 * Pure and deterministic: the same recording + settings produce the same
 * notes, so the flow is unit-testable end to end without a microphone.
 *
 * Segmentation is tuned for HUMMING specifically: one voice, slow glides,
 * shallow vibrato. Pitch changes only split notes when the new pitch is
 * stable for several frames (a glide toward the next note must not shatter
 * into chromatic fragments), and short dropouts (breath) bridge instead of
 * cutting.
 */

/** Frames below this clarity are treated as unvoiced even if the tracker guessed. */
const CLARITY_GATE = 0.55;
/** Absolute silence floor (≈ −48 dBFS) — room tone must not become notes. */
const RMS_FLOOR = 0.004;
/** A pitch change splits a note only after it is stable this many frames (~40 ms). */
const SPLIT_STABLE_FRAMES = 4;
/** Pitch distance (semitones) that counts as "moved to a new note". */
const SPLIT_SEMITONES = 0.7;
/** Dropouts up to this length bridge instead of cutting a hummed note. */
const BRIDGE_SEC = 0.08;
/** Minimum voiced run to become a note. */
const MIN_NOTE_SEC = 0.1;
/** Upper bound — a stuck detector must not flood the pattern. */
const MAX_NOTES = 64;

export interface HumNoteOptions {
  bpm: number;
  /** Snap pitches to the project scale (default: yes). */
  key?: MusicalKey | null;
  /** Snap starts/durations to the 16th grid (default: yes). */
  quantize?: boolean;
  /** Pattern length in ticks — notes beyond it are clamped into the last step. */
  patternLengthTicks: number;
  /**
   * Transport tick at the moment the TAKE started (beat-synced hum). When
   * present, frame times map from THIS position and wrap modulo the pattern
   * length — humming "bar 5" of a looping 4-bar pattern lands on bar 1,
   * exactly like MIDI pattern-record. Absent = free-time take (legacy:
   * tick 0 = take start).
   */
  transportStartTick?: number;
  /**
   * Transient times (seconds) from the onset detector over the RAW take —
   * onset-assisted segmentation: re-attacks inside a pitch run split it, so
   * two same-pitch notes ("da-da") stay two notes instead of merging.
   * Absent = pitch-change splitting only (deterministic tests, worker-free).
   */
  onsets?: readonly number[];
}

export interface HumToNotesTarget {
  trackId: string;
  patternId: string;
  mode: "replace" | "merge";
}

/**
 * Pitch frames → note drafts (ticks, snapped). Deterministic.
 */
export function framesToNotes(frames: readonly PitchFrame[], options: HumNoteOptions): NoteEvent[] {
  const bpm = Number.isFinite(options.bpm) && options.bpm > 0 ? options.bpm : 120;
  const voiced = frames.filter((f) => f.clarity >= CLARITY_GATE && f.rms >= RMS_FLOOR && f.midi > 0);
  if (voiced.length === 0) return [];

  // Median-of-5 on the voiced pitch curve — kills single-frame octave flips
  // and takes the edge off vibrato before run splitting.
  const midi = voiced.map((f) => f.midi);
  const smoothed = midi.map((_value, i) => {
    const window = midi.slice(Math.max(0, i - 2), i + 3).sort((a, b) => a - b);
    return window[Math.floor(window.length / 2)];
  });

  // Split the voiced timeline into runs at sustained pitch changes.
  interface Run {
    startIdx: number;
    endIdx: number; // inclusive
    pitchSum: number;
    count: number;
    rmsMax: number;
    /** Sub-run created by an onset cut — bridging must not re-merge it. */
    onsetCut?: boolean;
  }
  const runs: Run[] = [];
  let current: Run | null = null;
  let pendingSplit = 0;
  let splitRef = 0;
  for (let i = 0; i < voiced.length; i++) {
    const pitch = smoothed[i];
    if (current && Math.abs(pitch - splitRef) >= SPLIT_SEMITONES) {
      pendingSplit += 1;
      if (pendingSplit >= SPLIT_STABLE_FRAMES) {
        // Close the previous run BEFORE the stable change began.
        current.endIdx = i - pendingSplit;
        current = null;
      }
    } else {
      pendingSplit = 0;
    }
    if (!current) {
      current = { startIdx: i, endIdx: i, pitchSum: 0, count: 0, rmsMax: 0 };
      runs.push(current);
      splitRef = pitch;
      pendingSplit = 0;
    }
    current.endIdx = i;
    current.pitchSum += pitch;
    current.count += 1;
    current.rmsMax = Math.max(current.rmsMax, voiced[i].rms);
    splitRef = splitRef * 0.8 + pitch * 0.2; // slow reference follows glides
  }

  // Onset-assisted segmentation: pitch runs split on sustained pitch CHANGES
  // only, so two same-pitch notes ("da-da") merge into one long note. With
  // transient times from the onset detector, a re-attack strictly INSIDE a
  // run becomes a boundary. Margins keep ≥80 ms of note on both sides of the
  // cut (the take's initial attack and hairline fragments stay out); the
  // sub-run keeps its own pitch mean/rms so velocity follows the re-attack.
  const cutMarginSec = MIN_NOTE_SEC * 0.8;
  const onsetMatchSec = 0.02; // onset ↔ voiced-frame matching (2× hop)
  const sortedOnsets = [...(options.onsets ?? [])].filter(Number.isFinite).sort((a, b) => a - b);
  const segmented: Run[] = [];
  for (const run of runs) {
    const cuts: number[] = [];
    for (const onset of sortedOnsets) {
      if (onset <= voiced[run.startIdx].timeSec) continue;
      if (onset >= voiced[run.endIdx].timeSec) break;
      let idx = -1;
      for (let i = run.startIdx + 1; i <= run.endIdx; i++) {
        if (voiced[i].timeSec >= onset - onsetMatchSec) {
          idx = i;
          break;
        }
      }
      if (idx < 0) continue;
      const headSec = voiced[idx].timeSec - voiced[run.startIdx].timeSec;
      const tailSec = voiced[run.endIdx].timeSec + 0.01 - voiced[idx].timeSec;
      if (headSec < cutMarginSec || tailSec < cutMarginSec) continue;
      if (cuts.length === 0 || idx > cuts[cuts.length - 1]) cuts.push(idx);
    }
    if (cuts.length === 0) {
      segmented.push(run);
      continue;
    }
    let start = run.startIdx;
    for (const cut of [...cuts, run.endIdx + 1]) {
      const end = cut - 1;
      let pitchSum = 0;
      let rmsMax = 0;
      for (let i = start; i <= end; i++) {
        pitchSum += smoothed[i];
        rmsMax = Math.max(rmsMax, voiced[i].rms);
      }
      segmented.push({
        startIdx: start,
        endIdx: end,
        pitchSum,
        count: end - start + 1,
        rmsMax,
        onsetCut: start !== run.startIdx,
      });
      start = cut;
    }
  }

  // Runs → tick-space drafts (time from the FIRST voiced frame index).
  // Beat-synced takes anchor at the transport tick where recording began;
  // drafts stay in UNWRAPPED (absolute) tick space so bridging and duration
  // math stay correct across loop boundaries — wrapping happens per-note at
  // the end (the transport loops the pattern, so a hum "one loop later"
  // lands on the same grid slots).
  const maxRms = segmented.reduce((max, r) => Math.max(max, r.rmsMax), 1e-9);
  const secPerTick = 60 / (bpm * PPQ);
  const beatSynced =
    options.transportStartTick !== undefined && Number.isFinite(options.transportStartTick);
  const anchor = beatSynced ? Math.max(0, options.transportStartTick!) : 0;
  const patternLen = options.patternLengthTicks;
  const wrapTick = (tick: number): number => ((tick % patternLen) + patternLen) % patternLen;

  const raw: Array<{ pitch: number; startTick: number; endTick: number; velocity: number; onsetCut: boolean }> = [];
  for (const run of segmented) {
    const t0 = voiced[run.startIdx].timeSec;
    const t1 = voiced[run.endIdx].timeSec + 0.01; // hop width tail
    if (t1 - t0 < MIN_NOTE_SEC) continue;
    const pitch = Math.round(run.pitchSum / Math.max(1, run.count));
    if (pitch < 12 || pitch > 120) continue;
    raw.push({
      pitch,
      startTick: anchor + Math.round(t0 / secPerTick),
      endTick: anchor + Math.round(t1 / secPerTick),
      velocity: 0.45 + 0.45 * Math.min(1, run.rmsMax / maxRms),
      onsetCut: !!run.onsetCut,
    });
  }
  if (raw.length === 0) return [];

  // Bridge tiny gaps between adjacent runs (breath) BEFORE quantizing.
  const bridged: typeof raw = [];
  for (const note of raw) {
    const prev = bridged[bridged.length - 1];
    if (
      prev &&
      note.pitch === prev.pitch &&
      !note.onsetCut &&
      (note.startTick - prev.endTick) * secPerTick < BRIDGE_SEC
    ) {
      prev.endTick = note.endTick;
      prev.velocity = Math.max(prev.velocity, note.velocity);
      continue;
    }
    bridged.push({ ...note });
  }

  const quantize = options.quantize !== false;
  const notes: NoteEvent[] = [];
  for (const draft of bridged) {
    const durationTicks = Math.max(1, draft.endTick - draft.startTick);
    let startTick = beatSynced ? wrapTick(draft.startTick) : draft.startTick;
    let duration = durationTicks;
    if (quantize) {
      startTick = Math.round(startTick / STEP_TICKS) * STEP_TICKS;
      duration = Math.round(duration / STEP_TICKS) * STEP_TICKS;
      if (duration < STEP_TICKS) duration = STEP_TICKS;
    }
    let pitch = draft.pitch;
    if (options.key) pitch = snapToScale(pitch, options.key);
    // Clamp into the pattern. Free-time keeps the legacy semantics (drop
    // past-the-end notes); beat-synced wraps, so rounding that reaches the
    // end boundary lands at the pattern start instead.
    if (beatSynced) {
      if (startTick >= patternLen) startTick = 0;
    } else if (startTick >= patternLen) {
      continue;
    }
    let endTick = startTick + duration;
    if (endTick > patternLen) endTick = patternLen;
    if (endTick - startTick < (quantize ? STEP_TICKS : 1)) continue;

    if (beatSynced) {
      // Humming across loops can land the same pitch on the same grid slot
      // twice — the second pass REINFORCES the first (keep the longer note).
      const dup = notes.find((n) => n.pitch === pitch && n.start === startTick);
      if (dup) {
        dup.duration = Math.max(dup.duration, endTick - startTick);
        continue;
      }
    } else {
      const last = notes[notes.length - 1];
      if (last && last.pitch === pitch && startTick < last.start + last.duration) {
        // Overlap after quantize/key-snap — trim the earlier note, keep both.
        last.duration = Math.max(STEP_TICKS, startTick - last.start);
        if (last.duration <= 0) notes.pop();
      }
    }
    notes.push({
      id: uid("note"),
      pitch,
      start: startTick,
      duration: endTick - startTick,
      velocity: Math.round(draft.velocity * 100) / 100,
    });
    if (notes.length >= MAX_NOTES) break;
  }
  return notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}

/**
 * Install hummed notes as ONE undoable command (snapshot delta — concurrent
 * edits between record and apply survive undo). Replace swaps the track's
 * note list; merge appends (identical pitch+start deduped).
 */
export function humToNotesCommand(
  doc: ProjectDocument,
  notes: readonly NoteEvent[],
  target: HumToNotesTarget,
): ReturnType<typeof snapshot> {
  const pattern = doc.patterns.find((p) => p.id === target.patternId);
  if (!pattern) throw new Error("The target pattern no longer exists");
  if (!doc.tracks.some((t) => t.id === target.trackId)) throw new Error("The target track no longer exists");
  if (notes.length === 0) throw new Error("No hummed notes to apply");

  const existing = pattern.notes[target.trackId] ?? [];
  const nextNotes =
    target.mode === "merge"
      ? [
          ...existing,
          ...notes.filter(
            (note) => !existing.some((e) => e.pitch === note.pitch && e.start === note.start),
          ),
        ]
      : [...notes];
  const sorted = [...nextNotes].sort((a, b) => a.start - b.start || a.pitch - b.pitch);

  const next: ProjectDocument = {
    ...doc,
    patterns: doc.patterns.map((p) =>
      p.id === target.patternId ? { ...p, notes: { ...p.notes, [target.trackId]: sorted } } : p,
    ),
  };
  return snapshot(
    "humToNotes",
    `Hum → notes: ${notes.length} note${notes.length === 1 ? "" : "s"} (${target.mode})`,
    doc,
    next,
  );
}

/** Pattern length in ticks (shared with the piano roll's grid math). */
export function patternLengthTicks(pattern: Pattern): number {
  return pattern.stepCount * STEP_TICKS;
}

/**
 * Shift the hummed draft by whole octaves (±1 keeps scale membership — the
 * pitch class never moves). Pitches pushed out of the MIDI range 12..120 are
 * dropped; if everything would drop, the ORIGINAL drafts come back (a
 * preview must never become empty by accident).
 */
export function shiftNotesOctave(notes: readonly NoteEvent[], octaves: number): NoteEvent[] {
  const delta = Math.round(octaves) * 12;
  if (delta === 0) return [...notes];
  const shifted = notes
    .map((note) => ({ ...note, pitch: note.pitch + delta }))
    .filter((note) => note.pitch >= 12 && note.pitch <= 120);
  return shifted.length > 0 ? shifted : [...notes];
}

export interface AuditionTiming {
  /** Milliseconds from audition start until this note fires. */
  delayMs: number;
  pitch: number;
  velocity: number;
  /** Sounding length in seconds (>= 50 ms). */
  durationSec: number;
}

/**
 * Pure timing plan for the pre-apply AUDITION: one entry per note, delays
 * anchored to a single t0 (no accumulated drift). The panel fires each note
 * through engine.noteOn at its delay — nothing is scheduled ahead inside the
 * engine, so STOP is instant silence with no dangling notes.
 */
export function auditionTimings(
  notes: readonly NoteEvent[],
  bpm: number,
  leadInSec = 0.12,
): AuditionTiming[] {
  const effectiveBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
  const secPerTick = 60 / (effectiveBpm * PPQ);
  return notes.map((note) => ({
    delayMs: Math.max(0, (leadInSec + note.start * secPerTick) * 1000),
    pitch: note.pitch,
    velocity: note.velocity,
    durationSec: Math.max(0.05, note.duration * secPerTick),
  }));
}

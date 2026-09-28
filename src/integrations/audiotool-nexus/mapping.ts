import type { InstrumentTrack, NoteEvent, Pattern, TimeSignature, Track } from "../../project-model/types";
import { PPQ } from "../../project-model/types";
import { patternLengthTicks } from "../../midi/hum-to-notes";

/** Audiotool's document timeline uses 3,840 ticks per quarter note (KYX uses 480). */
export const AUDIOTOOL_TICKS_PER_QUARTER = 3840;
export const KYX_TO_AUDIOTOOL_TICK_SCALE = AUDIOTOOL_TICKS_PER_QUARTER / PPQ;
export const MAX_AUDIOTOOL_PARTS = 24;
export const MAX_AUDIOTOOL_NOTES = 4096;
export const MAX_AUDIOTOOL_BARS = 256;

export interface AudiotoolMidiNote {
  pitch: number;
  positionTicks: number;
  durationTicks: number;
  velocity: number;
  doesSlide: boolean;
}

export interface AudiotoolMidiPart {
  name: string;
  notes: AudiotoolMidiNote[];
}

export interface AudiotoolWritePlan {
  projectId: string;
  sourceBpm: number;
  timeSignature: TimeSignature;
  durationTicks: number;
  bars: number;
  parts: AudiotoolMidiPart[];
  noteCount: number;
  unsupportedDrumHits: number;
  unsupportedNoteCount: number;
  fingerprint: string;
}

export type AudiotoolPlanResult = { ok: true; plan: AudiotoolWritePlan } | { ok: false; error: string };

/** Accept only the official Audiotool Studio project URL; never pass arbitrary URLs to the SDK. */
export function audiotoolProjectIdFromUrl(raw: string): string | null {
  if (raw.length > 2048) return null;
  try {
    const url = new URL(raw.trim());
    if (
      url.protocol !== "https:" ||
      url.hostname !== "beta.audiotool.com" ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/studio" ||
      url.hash !== ""
    ) {
      return null;
    }
    const values = url.searchParams.getAll("project");
    if (
      values.length !== 1 ||
      [...url.searchParams.keys()].some((key) => key !== "project") ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(values[0] ?? "")
    ) {
      return null;
    }
    return values[0] ?? null;
  } catch {
    return null;
  }
}

export function audiotoolProjectUrl(projectId: string): string {
  return `https://beta.audiotool.com/studio?project=${encodeURIComponent(projectId)}`;
}

/**
 * Pure, bounded conversion of KYX's selected pattern into Audiotool MIDI.
 * Drum rows and unrecognized note lanes are reported rather than silently
 * represented as supported content.
 */
export function buildAudiotoolWritePlan(args: {
  pattern: Pattern;
  tracks: readonly Track[];
  timeSignature: TimeSignature;
  sourceBpm: number;
  projectId: string;
}): AudiotoolPlanResult {
  const { pattern, tracks, timeSignature, sourceBpm, projectId } = args;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(projectId)) return { ok: false, error: "Audiotool project URL is invalid." };
  if (!Number.isFinite(sourceBpm) || sourceBpm < 20 || sourceBpm > 400) {
    return { ok: false, error: "The KYX tempo is outside the supported range." };
  }
  if (
    !Number.isInteger(timeSignature.numerator) ||
    timeSignature.numerator < 1 ||
    timeSignature.numerator > 32 ||
    ![1, 2, 4, 8, 16].includes(timeSignature.denominator)
  ) {
    return { ok: false, error: "The KYX time signature is not supported." };
  }

  const barTicks = (AUDIOTOOL_TICKS_PER_QUARTER * 4 * timeSignature.numerator) / timeSignature.denominator;
  if (!Number.isInteger(barTicks) || barTicks <= 0) return { ok: false, error: "The KYX bar length is invalid." };

  const instruments = new Map<string, InstrumentTrack>();
  for (const track of tracks) if (track.kind === "instrument") instruments.set(track.id, track);

  const parts: AudiotoolMidiPart[] = [];
  let noteCount = 0;
  let unsupportedNoteCount = 0;
  let lastNoteEnd = 0;

  for (const [trackId, sourceNotes] of Object.entries(pattern.notes)) {
    if (!Array.isArray(sourceNotes) || sourceNotes.length === 0) continue;
    const instrument = instruments.get(trackId);
    if (!instrument) {
      unsupportedNoteCount += sourceNotes.length;
      continue;
    }
    if (parts.length >= MAX_AUDIOTOOL_PARTS) {
      return { ok: false, error: `This idea has more than ${MAX_AUDIOTOOL_PARTS} pitched parts.` };
    }

    const notes: AudiotoolMidiNote[] = [];
    for (const note of sourceNotes) {
      if (!isValidNote(note)) return { ok: false, error: `A note on “${instrument.name}” has invalid MIDI data.` };
      noteCount += 1;
      if (noteCount > MAX_AUDIOTOOL_NOTES) {
        return { ok: false, error: `This idea exceeds the ${MAX_AUDIOTOOL_NOTES}-note safety limit.` };
      }
      const positionTicks = note.start * KYX_TO_AUDIOTOOL_TICK_SCALE;
      const durationTicks = note.duration * KYX_TO_AUDIOTOOL_TICK_SCALE;
      if (!Number.isSafeInteger(positionTicks) || !Number.isSafeInteger(durationTicks)) {
        return { ok: false, error: `A note on “${instrument.name}” is outside Audiotool's supported timeline.` };
      }
      lastNoteEnd = Math.max(lastNoteEnd, positionTicks + durationTicks);
      notes.push({
        pitch: note.pitch,
        positionTicks,
        durationTicks,
        velocity: note.velocity,
        doesSlide: note.slide === true,
      });
    }
    notes.sort(compareNotes);
    parts.push({ name: safePartName(instrument.name, parts.length + 1), notes });
  }

  if (parts.length === 0 || noteCount === 0) {
    return {
      ok: false,
      error: "This idea has no pitched MIDI notes to send. Drum-only patterns are not supported yet.",
    };
  }

  const patternTicks = patternLengthTicks(pattern) * KYX_TO_AUDIOTOOL_TICK_SCALE;
  const unquantizedLength = Math.max(patternTicks, lastNoteEnd);
  if (!Number.isSafeInteger(unquantizedLength)) {
    return { ok: false, error: "This idea is outside Audiotool's supported timeline." };
  }
  const durationTicks = Math.ceil(unquantizedLength / barTicks) * barTicks;
  const bars = durationTicks / barTicks;
  if (!Number.isFinite(durationTicks) || durationTicks <= 0 || bars > MAX_AUDIOTOOL_BARS) {
    return { ok: false, error: `This idea exceeds the ${MAX_AUDIOTOOL_BARS}-bar safety limit.` };
  }

  const fingerprintInput = JSON.stringify({
    projectId,
    sourceBpm,
    timeSignature,
    durationTicks,
    parts: parts.map((part) => ({ name: part.name, notes: part.notes })),
  });
  const plan: AudiotoolWritePlan = {
    projectId,
    sourceBpm,
    timeSignature: { ...timeSignature },
    durationTicks,
    bars,
    parts,
    noteCount,
    unsupportedDrumHits: countDrumHits(pattern),
    unsupportedNoteCount,
    // This is an idempotency marker, not a cryptographic integrity check.
    fingerprint: stableFingerprint(fingerprintInput),
  };
  return { ok: true, plan };
}

function isValidNote(note: NoteEvent): boolean {
  return (
    Number.isInteger(note.pitch) &&
    note.pitch >= 0 &&
    note.pitch <= 127 &&
    Number.isSafeInteger(note.start) &&
    note.start >= 0 &&
    note.start <= Number.MAX_SAFE_INTEGER / KYX_TO_AUDIOTOOL_TICK_SCALE &&
    Number.isSafeInteger(note.duration) &&
    note.duration > 0 &&
    note.duration <= Number.MAX_SAFE_INTEGER / KYX_TO_AUDIOTOOL_TICK_SCALE &&
    Number.isFinite(note.velocity) &&
    note.velocity >= 0 &&
    note.velocity <= 1
  );
}

function compareNotes(a: AudiotoolMidiNote, b: AudiotoolMidiNote): number {
  return (
    a.positionTicks - b.positionTicks ||
    a.pitch - b.pitch ||
    a.durationTicks - b.durationTicks ||
    a.velocity - b.velocity ||
    Number(a.doesSlide) - Number(b.doesSlide)
  );
}

function safePartName(name: string, index: number): string {
  const cleaned = name
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 48);
  return cleaned || `KYX Part ${index}`;
}

function countDrumHits(pattern: Pattern): number {
  return Object.values(pattern.rows).reduce(
    (total, row) => total + row.reduce((hits, value) => hits + (Number.isFinite(value) && value > 0 ? 1 : 0), 0),
    0,
  );
}

function stableFingerprint(value: string): string {
  const seeds = [0x811c9dc5, 0x9747b28c, 0x85ebca6b, 0xc2b2ae35];
  return seeds
    .map((seed) => {
      let hash = seed >>> 0;
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
        hash ^= hash >>> 13;
      }
      return (hash >>> 0).toString(16).padStart(8, "0");
    })
    .join("");
}

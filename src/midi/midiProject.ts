/**
 * Bridge between Standard MIDI Files and the project model.
 *
 * IMPORT: a .mid becomes a new pattern (plus the tracks it needs). Notes on
 * the GM drum channel (10 / 0-based 9) land on the imported drum track's
 * pads via a General-MIDI→pad-name map; everything else becomes an
 * instrument track's piano-roll notes. MIDI ticks scale into project ticks
 * (both are per-quarter, so it is a straight multiply when divisions differ).
 *
 * EXPORT: the active pattern becomes a format-1 .mid — drums on channel 10,
 * each instrument track on its own channel, project tempo in the conductor.
 */
import type { Command } from "../commands/types";
import { snapshot } from "../commands/commands";
import {
  createDrumTrackModel,
  createInstrumentTrackModel,
  createPatternForDoc,
  normalizeProject,
  MAX_ARRANGEMENT_CLIP_TICKS,
} from "../project-model/schema";
import {
  BAR_TICKS,
  PPQ,
  STEP_TICKS,
  type DrumTrack,
  type InstrumentTrack,
  type ProjectDocument,
} from "../project-model/types";
import { downloadBlob } from "../export/download";
import { drumHitsInWindow } from "../project-model/groove";
import { midiClipEventsInWindow, noteEventsInWindow, patternBaseTickForClip } from "../project-model/events";
import { parseMidiFile, writeMidiFile, type MidiExportTrack, type MidiTrackData } from "./midiFile";

const GM_DRUM_CHANNEL = 9; // 0-based (MIDI channel 10)
const MAX_PATTERN_STEPS = 512; // 32 bars of 16ths — sane import ceiling
const MAX_SONG_MIDI_NOTES = 200_000;

/** GM percussion note → default-kit pad index (see makeKit in schema.ts). */
const GM_TO_PAD: Record<number, number> = {
  35: 0,
  36: 0, // Kick
  37: 3, // Side stick / rim
  38: 4,
  40: 4, // Snare
  39: 6, // Clap
  42: 8,
  44: 8, // Closed hat
  46: 10, // Open hat
  51: 11,
  53: 11, // Ride
  41: 12,
  43: 12, // Low tom
  45: 13,
  47: 13,
  48: 13,
  50: 13, // High/mid toms
  54: 14,
  56: 14,
  75: 14, // Shaker/tambourine-ish → Tick
};

function padIndexForGmNote(pitch: number): number {
  return GM_TO_PAD[pitch] ?? 15; // misc percussion → Blip
}

/** Instrument kind for an imported melodic channel — bass for bassy material. */
function kindForNotes(notes: { pitch: number }[]): "analog" | "bass" {
  if (notes.length === 0) return "analog";
  const avg = notes.reduce((sum, n) => sum + n.pitch, 0) / notes.length;
  return avg < 48 ? "bass" : "analog";
}

function scaleTicks(tick: number, division: number): number {
  return Math.round((tick * PPQ) / division);
}

export interface MidiImportSummary {
  patternName: string;
  stepCount: number;
  trackNames: string[];
  drumHits: number;
  notes: number;
  droppedNotes: number;
  bpm: number | null;
}

/**
 * Build the import command: new tracks (if needed) + one pattern holding the
 * whole file, activated. Reuses existing tracks when names/kinds line up —
 * actually NO: deterministic freshness wins for imports, every import adds
 * its own tracks so repeated drops never merge two files into one track.
 */
export function importMidiCommand(doc: ProjectDocument, midi: Uint8Array, fileLabel: string): Command {
  const parsed = parseMidiFile(midi);
  const melodic = parsed.tracks.filter((t) => t.channel !== GM_DRUM_CHANNEL).slice(0, 8);
  const drums = parsed.tracks.filter((t) => t.channel === GM_DRUM_CHANNEL);
  const drumNotes = drums.flatMap((t) => t.notes);

  // Pattern length: longest note end, rounded up to whole bars (16 steps).
  let maxTick = 0;
  for (const track of parsed.tracks) {
    for (const note of track.notes) maxTick = Math.max(maxTick, scaleTicks(note.endTick, parsed.division));
  }
  const neededSteps = Math.ceil(maxTick / STEP_TICKS);
  const stepCount = Math.max(16, Math.min(MAX_PATTERN_STEPS, Math.ceil(neededSteps / 16) * 16));
  const raw: ProjectDocument = { ...doc, tracks: [...doc.tracks] };
  const trackNames: string[] = [];

  // Drum track first (pads must exist before rows can be written).
  let drumTrackId: string | null = null;
  const drumTrackName = drums[0]?.name || `${fileLabel} Drums`;
  if (drumNotes.length > 0) {
    const drumTrack = createDrumTrackModel(drumTrackName);
    drumTrackId = drumTrack.id;
    raw.tracks = [...raw.tracks, drumTrack];
    trackNames.push(drumTrack.name);
  }

  const patternName = fileLabel.replace(/\.(midi?|MIDI?)$/, "").slice(0, 48) || "MIDI Import";
  const instrumentPlans: { trackId: string; trackName: string; notes: MidiTrackData["notes"] }[] = [];
  for (const [index, source] of melodic.entries()) {
    const kind = kindForNotes(source.notes);
    const track = createInstrumentTrackModel(kind, index + 1);
    track.name = (source.name || track.name).slice(0, 32);
    raw.tracks = [...raw.tracks, track];
    instrumentPlans.push({ trackId: track.id, trackName: track.name, notes: source.notes });
    trackNames.push(track.name);
  }

  const pattern = createPatternForDoc(raw, patternName, stepCount);
  const next: ProjectDocument = normalizeProject({
    ...raw,
    patterns: [...raw.patterns, pattern],
    activePatternId: pattern.id,
    ...(parsed.bpm && parsed.bpm >= 20 && parsed.bpm <= 300 ? { bpm: parsed.bpm } : {}),
  });

  // normalizeProject may rebuild track/pattern objects — resolve the FRESH
  // references by id before writing content, or the hits land on orphaned
  // clones and the pattern stays empty.
  const freshPattern = next.patterns.find((p) => p.id === pattern.id) ?? pattern;
  const freshDrum = drumTrackId ? (next.tracks.find((t) => t.id === drumTrackId) as DrumTrack | undefined) : undefined;

  // Drum hits → rows (velocity grid).
  let drumHits = 0;
  if (freshDrum) {
    for (const note of drumNotes) {
      const start = scaleTicks(note.startTick, parsed.division);
      const step = Math.floor(start / STEP_TICKS);
      if (step < 0 || step >= stepCount) continue;
      const padIndex = padIndexForGmNote(note.pitch);
      const pad = freshDrum.pads[padIndex];
      if (!pad) continue;
      freshPattern.rows[pad.id][step] = Math.max(freshPattern.rows[pad.id][step], note.velocity);
      drumHits++;
    }
  }

  // Melodic notes stay sparse and can extend past the bounded step grid.
  let noteCount = 0;
  let dropped = 0;
  for (const plan of instrumentPlans) {
    const freshTrack = next.tracks.find((t) => t.id === plan.trackId) as InstrumentTrack | undefined;
    if (!freshTrack) continue;
    const list: (typeof freshPattern.notes)[string] = [];
    for (const note of plan.notes) {
      const start = scaleTicks(note.startTick, parsed.division);
      const end = scaleTicks(note.endTick, parsed.division);
      if (start < 0 || start >= MAX_ARRANGEMENT_CLIP_TICKS) {
        dropped++;
        continue;
      }
      list.push({
        id: `midi-${plan.trackId}-${noteCount}`,
        pitch: Math.max(0, Math.min(127, note.pitch)),
        start,
        duration: Math.max(1, Math.min(end, MAX_ARRANGEMENT_CLIP_TICKS) - start),
        velocity: note.velocity,
      });
      noteCount++;
    }
    list.sort((a, b) => a.start - b.start);
    freshPattern.notes[freshTrack.id] = list;
  }

  const summary: MidiImportSummary = {
    patternName,
    stepCount,
    trackNames,
    drumHits,
    notes: noteCount,
    droppedNotes: dropped,
    bpm: parsed.bpm,
  };

  return {
    ...snapshot("importMidi", `Import MIDI ${patternName} (${noteCount} notes, ${drumHits} drum hits)`, doc, next),
    summary,
  } as Command & { summary: MidiImportSummary };
}

// ── export ──────────────────────────────────────────────────────────────────

/** Inverse of GM_TO_PAD: default-kit pad name → GM note for export. */
function gmNoteForPad(pad: { name: string; index?: number }): number {
  const name = pad.name.toLowerCase();
  if (name.includes("kick")) return 36;
  if (name.includes("rim")) return 37;
  if (name.includes("snare")) return 38;
  if (name.includes("clap")) return 39;
  if (name.includes("hat open")) return 46;
  if (name.includes("hat")) return 42;
  if (name.includes("ride")) return 51;
  if (name.includes("tom low")) return 41;
  if (name.includes("tom")) return 45;
  if (name.includes("shaker")) return 70;
  return 56; // misc percussion
}

/**
 * Export one pattern: drums (row grid) → channel 10, each instrument track →
 * its own channel (skipping 9), 1/16 drum gate, project tempo.
 */
export function patternToMidi(doc: ProjectDocument, patternId: string): Uint8Array {
  const pattern = doc.patterns.find((p) => p.id === patternId) ?? doc.patterns[0];
  if (!pattern) throw new Error("no pattern to export");

  const tracks: {
    name: string;
    channel: number;
    notes: { pitch: number; startTick: number; endTick: number; velocity: number }[];
  }[] = [];
  let nextChannel = 0;

  for (const track of doc.tracks) {
    if (track.kind === "drum") {
      const notes: (typeof tracks)[number]["notes"] = [];
      for (const pad of (track as DrumTrack).pads) {
        const row = pattern.rows[pad.id] ?? [];
        const pitch = gmNoteForPad(pad);
        for (let step = 0; step < pattern.stepCount; step++) {
          const velocity = row[step] ?? 0;
          if (velocity > 0) {
            notes.push({
              pitch,
              startTick: step * STEP_TICKS,
              endTick: step * STEP_TICKS + STEP_TICKS,
              velocity: Math.max(0.05, Math.min(1, velocity)),
            });
          }
        }
      }
      if (notes.length > 0) tracks.push({ name: track.name, channel: GM_DRUM_CHANNEL, notes });
    } else if (track.kind === "instrument") {
      const notes = (pattern.notes?.[track.id] ?? []).map((note) => ({
        pitch: note.pitch,
        startTick: note.start,
        endTick: note.start + note.duration,
        velocity: note.velocity,
      }));
      if (notes.length === 0) continue;
      if (nextChannel === GM_DRUM_CHANNEL) nextChannel++;
      tracks.push({ name: track.name, channel: nextChannel % 16, notes });
      nextChannel++;
    }
  }

  return writeMidiFile({
    division: PPQ,
    bpm: doc.bpm,
    timeSignature: { num: 4, den: 4 },
    tracks,
  });
}

/** Export the whole Song arrangement as a format-1 MIDI file. */
export function arrangementToMidi(doc: ProjectDocument): Uint8Array {
  const notesByTrack = new Map<string, MidiExportTrack["notes"]>();
  const channelsByTrack = new Map<string, number>();
  let totalNotes = 0;
  let nextChannel = 0;
  for (const track of doc.tracks) {
    if (track.kind === "drum") {
      channelsByTrack.set(track.id, GM_DRUM_CHANNEL);
      notesByTrack.set(track.id, []);
    } else if (track.kind === "instrument") {
      if (nextChannel === GM_DRUM_CHANNEL) nextChannel++;
      channelsByTrack.set(track.id, nextChannel++ % 16);
      notesByTrack.set(track.id, []);
    }
  }
  const appendNote = (trackId: string, pitch: number, startTick: number, endTick: number, velocity: number) => {
    const notes = notesByTrack.get(trackId);
    if (!notes || !Number.isFinite(startTick) || !Number.isFinite(endTick) || endTick <= startTick) return;
    if (totalNotes >= MAX_SONG_MIDI_NOTES) {
      throw new Error(`Song MIDI export exceeds ${MAX_SONG_MIDI_NOTES.toLocaleString()} notes`);
    }
    notes.push({ pitch, startTick, endTick, velocity });
    totalNotes++;
  };

  const tempoEvents: Array<{ tick: number; bpm: number; priority: number }> = [{ tick: 0, bpm: doc.bpm, priority: 0 }];
  for (const clip of [...doc.arrangement.clips].sort((a, b) => a.startBar - b.startBar)) {
    const scene = doc.scenes.find((candidate) => candidate.id === clip.sceneId);
    const pattern = scene ? doc.patterns.find((candidate) => candidate.id === scene.patternId) : undefined;
    if (!scene || !pattern) continue;
    const from = clip.startBar * BAR_TICKS;
    const to = from + clip.lengthBars * BAR_TICKS;
    const base = patternBaseTickForClip(clip);
    for (let cursor = from; cursor < to; cursor += BAR_TICKS) {
      const windowEnd = Math.min(to, cursor + BAR_TICKS);
      for (const hit of drumHitsInWindow(doc, pattern, base, cursor, windowEnd)) {
        appendNote(hit.trackId, gmNoteForPad(hit.pad), hit.tick, Math.min(to, hit.tick + STEP_TICKS), hit.velocity);
      }
      for (const event of noteEventsInWindow(pattern, base, cursor, windowEnd)) {
        appendNote(
          event.trackId,
          event.note.pitch,
          event.tick,
          Math.min(to, event.tick + event.note.duration),
          event.note.velocity,
        );
      }
    }
    tempoEvents.push({ tick: from, bpm: scene.bpm ?? doc.bpm, priority: 1 });
    tempoEvents.push({ tick: to, bpm: doc.bpm, priority: 0 });
  }
  for (const clip of doc.arrangement.midiClips ?? []) {
    const clipEnd = clip.startTick + clip.lengthTicks;
    for (let cursor = clip.startTick; cursor < clipEnd; cursor += BAR_TICKS) {
      for (const event of midiClipEventsInWindow(doc, clip, cursor, Math.min(clipEnd, cursor + BAR_TICKS))) {
        appendNote(event.trackId, event.note.pitch, event.tick, event.tick + event.note.duration, event.note.velocity);
      }
    }
  }

  const tracks: MidiTrackData[] = doc.tracks.flatMap((track) => {
    const channel = channelsByTrack.get(track.id);
    const notes = notesByTrack.get(track.id) ?? [];
    return channel === undefined || notes.length === 0 ? [] : [{ name: track.name, channel, notes }];
  });
  const sortedTempoEvents = tempoEvents
    .filter(({ tick, bpm }) => Number.isFinite(tick) && tick >= 0 && Number.isFinite(bpm) && bpm > 0)
    .sort((a, b) => a.tick - b.tick || a.priority - b.priority);
  const tempoChanges: Array<{ tick: number; bpm: number }> = [];
  for (const event of sortedTempoEvents) {
    const previous = tempoChanges[tempoChanges.length - 1];
    if (previous?.tick === event.tick) previous.bpm = event.bpm;
    else tempoChanges.push({ tick: event.tick, bpm: event.bpm });
  }
  return writeMidiFile({
    division: PPQ,
    bpm: doc.bpm,
    tempoChanges,
    timeSignature: { num: doc.timeSignature.numerator, den: doc.timeSignature.denominator },
    tracks: tracks.map((track) => ({ name: track.name, channel: track.channel, notes: track.notes })),
  });
}

/** Browser download helper (Export panel / PatternBar share it). */
export function downloadMidi(bytes: Uint8Array, filename: string): void {
  downloadBlob(
    new Blob([bytes as unknown as BlobPart], { type: "audio/midi" }),
    filename.endsWith(".mid") ? filename : `${filename}.mid`,
  );
}

/** Convenience for UI code: parse + build the command in one call. */
export function midiImportFromBytes(doc: ProjectDocument, bytes: Uint8Array, fileLabel: string) {
  return importMidiCommand(doc, bytes, fileLabel);
}

export { parseMidiFile };

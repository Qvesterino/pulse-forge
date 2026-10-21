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
import { addAutomationClip } from "../commands/automationClips";
import {
  createDrumTrackModel,
  createInstrumentTrackModel,
  createPatternForDoc,
  normalizeProject,
  MAX_ARRANGEMENT_CLIP_TICKS,
  ticksPerBar,
} from "../project-model/schema";
import {
  PPQ,
  STEP_TICKS,
  type AutomationTarget,
  type DrumTrack,
  type InstrumentTrack,
  type ProjectDocument,
} from "../project-model/types";
import { downloadBlob } from "../export/download";
import { drumHitsInWindow } from "../project-model/groove";
import { stepsForWholeBars } from "../project-model/grid";
import {
  arrangementAutomationSegmentsInWindow,
  automationClipEventsInWindow,
  midiClipEventsInWindow,
  noteEventsInWindow,
  patternBaseTickForClip,
} from "../project-model/events";
import { automationTargetKey } from "../project-model/targets";
import {
  parseMidiFile,
  writeMidiFile,
  type MidiControllerEvent,
  type MidiExportTrack,
  type MidiTrackData,
} from "./midiFile";

const GM_DRUM_CHANNEL = 9; // 0-based (MIDI channel 10)
const MAX_PATTERN_STEPS = 512; // 32 bars of 16ths — sane import ceiling
const MAX_SONG_MIDI_NOTES = 200_000;

function midiControllerForTarget(target: AutomationTarget): 7 | 10 | null {
  if (target.kind === "trackGain") return 7;
  if (target.kind === "trackPan") return 10;
  return null;
}

function automationValueToMidiController(target: AutomationTarget, value: number): number {
  // CC7 has no representation above unity; cap KYX's wider 0..2 gain range.
  if (target.kind === "trackGain") return Math.round(Math.max(0, Math.min(1, value)) * 127);
  // Match the inverse of MIDI import's asymmetric 64/63 pan mapping so hard
  // left, center and hard right return to 0, 64 and 127 exactly.
  const pan = Math.max(-1, Math.min(1, value));
  return Math.round(pan <= 0 ? (pan + 1) * 64 : 64 + pan * 63);
}

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

/** Map MIDI ticks through their source tempo map into the target project's constant tempo. */
export function createMidiToProjectTickMapper(
  parsed: ReturnType<typeof parseMidiFile>,
  targetBpm: number | undefined,
): (tick: number) => number {
  if (targetBpm === undefined || !Number.isFinite(targetBpm) || targetBpm <= 0)
    return (tick) => scaleTicks(tick, parsed.division);
  const projectBpm = targetBpm;

  const segments: Array<{ tick: number; seconds: number; bpm: number }> = [{ tick: 0, seconds: 0, bpm: 120 }];
  let cursorTick = 0;
  let cursorSeconds = 0;
  let sourceBpm = 120;
  for (const event of parsed.tempoEvents) {
    const eventTick = Math.max(cursorTick, event.tick);
    cursorSeconds += ((eventTick - cursorTick) / parsed.division) * (60 / sourceBpm);
    cursorTick = eventTick;
    sourceBpm = event.bpm;
    segments.push({ tick: eventTick, seconds: cursorSeconds, bpm: sourceBpm });
  }

  return (tick) => {
    const sourceTick = Math.max(0, tick);
    let low = 0;
    let high = segments.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((segments[middle]?.tick ?? Infinity) <= sourceTick) low = middle + 1;
      else high = middle;
    }
    const segment = segments[Math.max(0, low - 1)]!;
    const elapsedSeconds = segment.seconds + ((sourceTick - segment.tick) / parsed.division) * (60 / segment.bpm);
    return Math.round((elapsedSeconds * projectBpm * PPQ) / 60);
  };
}

export interface MidiImportSummary {
  patternName: string;
  stepCount: number;
  trackNames: string[];
  drumHits: number;
  droppedDrumHits: number;
  notes: number;
  droppedNotes: number;
  truncatedNotes: number;
  droppedControllerEvents: number;
  bpm: number | null;
}

function importControllerAutomation(
  doc: ProjectDocument,
  trackId: string,
  controllers: MidiControllerEvent[],
  noteEndTick: number,
  toProjectTick: (tick: number) => number,
): { doc: ProjectDocument; droppedEvents: number } {
  const mapped: Array<{ tick: number; controller: 7 | 10 | 11; value: number; order: number }> = [];
  let droppedEvents = 0;
  for (const [order, event] of controllers.entries()) {
    const tick = toProjectTick(event.tick);
    if (!Number.isFinite(tick) || tick < 0 || tick > MAX_ARRANGEMENT_CLIP_TICKS) {
      droppedEvents++;
      continue;
    }
    mapped.push({ ...event, tick, order });
  }
  if (mapped.length === 0) return { doc, droppedEvents };
  mapped.sort((a, b) => a.tick - b.tick || a.order - b.order);

  let endTick = Math.max(1, Math.min(MAX_ARRANGEMENT_CLIP_TICKS, noteEndTick));
  for (const event of mapped) endTick = Math.max(endTick, Math.min(MAX_ARRANGEMENT_CLIP_TICKS, event.tick + 1));

  const volumePoints = new Map<number, number>([[0, 1]]);
  const panPoints = new Map<number, number>([[0, 0]]);
  let volume = 127;
  let expression = 127;
  for (let index = 0; index < mapped.length;) {
    const tick = mapped[index]!.tick;
    let next = index;
    let sawVolume = false;
    let lastPan: number | undefined;
    while (next < mapped.length && mapped[next]!.tick === tick) {
      const event = mapped[next]!;
      if (event.controller === 7) {
        volume = event.value;
        sawVolume = true;
      } else if (event.controller === 11) {
        expression = event.value;
        sawVolume = true;
      } else {
        lastPan = event.value;
      }
      next++;
    }
    if (sawVolume) volumePoints.set(tick, (volume / 127) * (expression / 127));
    if (lastPan !== undefined) {
      panPoints.set(tick, lastPan <= 64 ? (lastPan - 64) / 64 : (lastPan - 64) / 63);
    }
    index = next;
  }

  let nextDoc = doc;
  if (mapped.some((event) => event.controller === 7 || event.controller === 11)) {
    const target: AutomationTarget = { kind: "trackGain", trackId };
    nextDoc = addAutomationClip(
      nextDoc,
      target,
      0,
      endTick,
      [...volumePoints].map(([tick, value]) => ({ tick, value })),
    ).execute(nextDoc);
  }
  if (mapped.some((event) => event.controller === 10)) {
    const target: AutomationTarget = { kind: "trackPan", trackId };
    nextDoc = addAutomationClip(
      nextDoc,
      target,
      0,
      endTick,
      [...panPoints].map(([tick, value]) => ({ tick, value })),
    ).execute(nextDoc);
  }
  return { doc: nextDoc, droppedEvents };
}

/**
 * Build the import command: new tracks (if needed) + one pattern holding the
 * whole file, activated. Reuses existing tracks when names/kinds line up —
 * actually NO: deterministic freshness wins for imports, every import adds
 * its own tracks so repeated drops never merge two files into one track.
 */
export function importMidiCommand(
  doc: ProjectDocument,
  midi: Uint8Array,
  fileLabel: string,
  options: { targetBpm?: number } = {},
): Command {
  const parsed = parseMidiFile(midi);
  const toProjectTick = createMidiToProjectTickMapper(parsed, options.targetBpm);
  const melodic = parsed.tracks.filter((t) => t.channel !== GM_DRUM_CHANNEL).slice(0, 8);
  const drums = parsed.tracks.filter((t) => t.channel === GM_DRUM_CHANNEL);
  const drumNotes = drums.flatMap((t) => t.notes);

  // Pattern length: the longest note end, rounded UP to a whole number of the
  // DOCUMENT's bars (ADR 0057). In 4/4 this is exactly the old behaviour — a
  // multiple of sixteen steps — so every 4/4 project stays byte-identical. In
  // 6/8 a bar is twelve steps, so an imported groove lands ON the downbeat
  // instead of 1.33 bars into the bar. Rounding UP is what keeps the user's
  // material: the result is never shorter than the longest note, so nothing is
  // ever cut to fit a bar.
  let maxTick = 0;
  for (const track of parsed.tracks) {
    for (const note of track.notes) maxTick = Math.max(maxTick, toProjectTick(note.endTick));
    for (const controller of track.controllers) maxTick = Math.max(maxTick, toProjectTick(controller.tick));
  }
  const neededSteps = Math.ceil(maxTick / STEP_TICKS);
  const stepCount = Math.min(MAX_PATTERN_STEPS, stepsForWholeBars(doc, neededSteps));
  const raw: ProjectDocument = { ...doc, tracks: [...doc.tracks] };
  const trackNames: string[] = [];

  // Drum track first (pads must exist before rows can be written).
  let drumTrackId: string | null = null;
  const drumTrackName = drums[0]?.name || `${fileLabel} Drums`;
  if (drumNotes.length > 0 || drums.some((track) => track.controllers.length > 0)) {
    const drumTrack = createDrumTrackModel(drumTrackName);
    drumTrackId = drumTrack.id;
    raw.tracks = [...raw.tracks, drumTrack];
    trackNames.push(drumTrack.name);
  }

  const patternName = fileLabel.replace(/\.(midi?|MIDI?)$/, "").slice(0, 48) || "MIDI Import";
  const instrumentPlans: {
    trackId: string;
    trackName: string;
    notes: MidiTrackData["notes"];
    controllers: MidiTrackData["controllers"];
  }[] = [];
  for (const [index, source] of melodic.entries()) {
    const kind = kindForNotes(source.notes);
    const track = createInstrumentTrackModel(kind, index + 1);
    track.name = (source.name || track.name).slice(0, 32);
    raw.tracks = [...raw.tracks, track];
    instrumentPlans.push({
      trackId: track.id,
      trackName: track.name,
      notes: source.notes,
      controllers: source.controllers,
    });
    trackNames.push(track.name);
  }

  const pattern = createPatternForDoc(raw, patternName, stepCount);
  let next: ProjectDocument = normalizeProject({
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
  let droppedDrumHits = 0;
  if (freshDrum) {
    for (const note of drumNotes) {
      const start = toProjectTick(note.startTick);
      const step = Math.floor(start / STEP_TICKS);
      if (step < 0 || step >= stepCount) {
        droppedDrumHits++;
        continue;
      }
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
  let truncated = 0;
  let droppedControllerEvents = 0;
  const controllerAutomationPlans: Array<{
    trackId: string;
    controllers: MidiTrackData["controllers"];
    noteEndTick: number;
  }> = [];
  for (const plan of instrumentPlans) {
    const freshTrack = next.tracks.find((t) => t.id === plan.trackId) as InstrumentTrack | undefined;
    if (!freshTrack) continue;
    const list: (typeof freshPattern.notes)[string] = [];
    for (const note of plan.notes) {
      const start = toProjectTick(note.startTick);
      const end = toProjectTick(note.endTick);
      if (start < 0 || start >= MAX_ARRANGEMENT_CLIP_TICKS) {
        dropped++;
        continue;
      }
      if (end > MAX_ARRANGEMENT_CLIP_TICKS) truncated++;
      list.push({
        id: `midi-${plan.trackId}-${noteCount}`,
        pitch: Math.max(0, Math.min(127, note.pitch)),
        start,
        duration: Math.max(1, Math.min(end, MAX_ARRANGEMENT_CLIP_TICKS) - start),
        velocity: note.velocity,
        ...(note.releaseVelocity === undefined ? {} : { expression: { releaseVelocity: note.releaseVelocity } }),
      });
      noteCount++;
    }
    list.sort((a, b) => a.start - b.start);
    freshPattern.notes[freshTrack.id] = list;
    const noteEndTick = plan.notes.reduce((latest, note) => Math.max(latest, toProjectTick(note.endTick)), 0);
    controllerAutomationPlans.push({ trackId: freshTrack.id, controllers: plan.controllers, noteEndTick });
  }

  // Controller automation commands deep-freeze their previous document in
  // development. Apply them only after every note list has been written, or a
  // later MIDI lane would attempt to mutate the frozen shared pattern.
  for (const plan of controllerAutomationPlans) {
    const automation = importControllerAutomation(
      next,
      plan.trackId,
      plan.controllers,
      plan.noteEndTick,
      toProjectTick,
    );
    next = automation.doc;
    droppedControllerEvents += automation.droppedEvents;
  }

  if (freshDrum && drums.some((track) => track.controllers.length > 0)) {
    const noteEndTick = drumNotes.reduce((latest, note) => Math.max(latest, toProjectTick(note.endTick)), 0);
    const automation = importControllerAutomation(
      next,
      freshDrum.id,
      drums.flatMap((track) => track.controllers),
      noteEndTick,
      toProjectTick,
    );
    next = automation.doc;
    droppedControllerEvents += automation.droppedEvents;
  }

  const summary: MidiImportSummary = {
    patternName,
    stepCount,
    trackNames,
    drumHits,
    droppedDrumHits,
    notes: noteCount,
    droppedNotes: dropped,
    truncatedNotes: truncated,
    droppedControllerEvents,
    bpm: parsed.bpm,
  };
  const finalDoc = normalizeProject(next);

  return {
    ...snapshot("importMidi", `Import MIDI ${patternName} (${noteCount} notes, ${drumHits} drum hits)`, doc, finalDoc),
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
    notes: { pitch: number; startTick: number; endTick: number; velocity: number; releaseVelocity?: number }[];
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
        ...(note.expression?.releaseVelocity === undefined ? {} : { releaseVelocity: note.expression.releaseVelocity }),
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
  const controllersByTrack = new Map<string, MidiControllerEvent[]>();
  const channelsByTrack = new Map<string, number>();
  // The document's bar length in ticks (ADR 0056) — the MIDI export walks the
  // arrangement in musical bars, and the pattern base is anchored to them.
  const barUnit = ticksPerBar(doc);
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
  const appendNote = (
    trackId: string,
    pitch: number,
    startTick: number,
    endTick: number,
    velocity: number,
    releaseVelocity?: number,
  ) => {
    const notes = notesByTrack.get(trackId);
    if (!notes || !Number.isFinite(startTick) || !Number.isFinite(endTick) || endTick <= startTick) return;
    if (totalNotes >= MAX_SONG_MIDI_NOTES) {
      throw new Error(`Song MIDI export exceeds ${MAX_SONG_MIDI_NOTES.toLocaleString()} notes`);
    }
    notes.push({ pitch, startTick, endTick, velocity, ...(releaseVelocity === undefined ? {} : { releaseVelocity }) });
    totalNotes++;
  };

  const tempoEvents: Array<{ tick: number; bpm: number; priority: number }> = [{ tick: 0, bpm: doc.bpm, priority: 0 }];
  for (const clip of [...doc.arrangement.clips].sort((a, b) => a.startBar - b.startBar)) {
    const scene = doc.scenes.find((candidate) => candidate.id === clip.sceneId);
    const pattern = scene ? doc.patterns.find((candidate) => candidate.id === scene.patternId) : undefined;
    if (!scene || !pattern) continue;
    const from = clip.startBar * barUnit;
    const to = from + clip.lengthBars * barUnit;
    const base = patternBaseTickForClip(clip, barUnit);
    for (let cursor = from; cursor < to; cursor += barUnit) {
      const windowEnd = Math.min(to, cursor + barUnit);
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
          event.note.expression?.releaseVelocity,
        );
      }
    }
    tempoEvents.push({ tick: from, bpm: scene.bpm ?? doc.bpm, priority: 1 });
    tempoEvents.push({ tick: to, bpm: doc.bpm, priority: 0 });
  }
  for (const clip of doc.arrangement.midiClips ?? []) {
    const clipEnd = clip.startTick + clip.lengthTicks;
    for (let cursor = clip.startTick; cursor < clipEnd; cursor += barUnit) {
      for (const event of midiClipEventsInWindow(doc, clip, cursor, Math.min(clipEnd, cursor + barUnit))) {
        appendNote(
          event.trackId,
          event.note.pitch,
          event.tick,
          event.tick + event.note.duration,
          event.note.velocity,
          event.note.expression?.releaseVelocity,
        );
      }
    }
  }

  // BRING A SONG maps supported source CCs onto track-gain/pan automation.
  // Put those curves back into the Standard MIDI track for that instrument so
  // a KYX transfer can continue in another DAW. CC7 represents the combined
  // gain curve (source CC7 and CC11 cannot be separated after import).
  const automationClips = doc.arrangement.automationClips ?? [];
  const automationEnd = automationClips.reduce((latest, clip) => {
    const end = clip.startTick + clip.lengthTicks;
    return Number.isFinite(end) ? Math.max(latest, end) : latest;
  }, 0);
  if (automationEnd > 0) {
    const byTrackAndEvent = new Map<string, Map<string, MidiControllerEvent>>();
    for (const segment of arrangementAutomationSegmentsInWindow(automationClips, 0, automationEnd)) {
      const { clip, target } = segment;
      if (automationTargetKey(target) !== automationTargetKey(clip.target)) continue;
      const controller = midiControllerForTarget(target);
      if (controller === null || !channelsByTrack.has(target.trackId)) continue;
      const fallback = target.kind === "trackGain" ? 1 : 0;
      const events = automationClipEventsInWindow(clip, segment.fromTick, segment.toTick, fallback);
      let lane = byTrackAndEvent.get(target.trackId);
      if (!lane) byTrackAndEvent.set(target.trackId, (lane = new Map()));
      for (const event of events) {
        const tick = Math.max(0, Math.round(event.tick));
        const key = `${controller}:${tick}`;
        // Adjacent/overlapping automation segments may both expose their
        // shared boundary. The later segment is the active value there.
        lane.set(key, {
          tick,
          controller,
          value: automationValueToMidiController(target, event.value),
        });
      }
    }
    for (const [trackId, events] of byTrackAndEvent) {
      controllersByTrack.set(
        trackId,
        [...events.values()].sort((a, b) => a.tick - b.tick || a.controller - b.controller),
      );
    }
  }

  const tracks: MidiTrackData[] = doc.tracks.flatMap((track) => {
    const channel = channelsByTrack.get(track.id);
    const notes = notesByTrack.get(track.id) ?? [];
    const controllers = controllersByTrack.get(track.id) ?? [];
    return channel === undefined || (notes.length === 0 && controllers.length === 0)
      ? []
      : [{ name: track.name, channel, notes, controllers }];
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
    tracks: tracks.map((track) => ({
      name: track.name,
      channel: track.channel,
      notes: track.notes,
      controllers: track.controllers,
    })),
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

import { addAudioClip } from "../commands/audioClips";
import { addArrangementClip } from "../commands/arrangement";
import { addMidiClip } from "../commands/midiClips";
import { createScene } from "../commands/scenes";
import { assertAudioImportSize, isAudioImportFile, MAX_AUDIO_IMPORT_BYTES } from "../audio-import-capabilities";
import {
  MAX_ARRANGEMENT_CLIP_BARS,
  MAX_ARRANGEMENT_CLIP_TICKS,
  createGroupTrackModel,
  createInstrumentTrackModel,
  normalizeProject,
  ticksPerBarFor,
} from "../project-model/schema";
import {
  PATTERN_TICKS,
  STEP_TICKS,
  type InstrumentTrack,
  type Pattern,
  type ProjectDocument,
  type ProjectTransferSourceDaw,
  type TimeSignature,
} from "../project-model/types";
import { createProjectFromTemplate } from "../project-model/templates";
import { uid } from "../shared/ids";
import { importMidiCommand } from "../midi/midiProject";
import { parseMidiFile, type ParsedMidi } from "../midi/midiFile";

export type TransferSourceDaw = ProjectTransferSourceDaw;

export interface TransferInspection {
  audioFiles: File[];
  totalAudioBytes: number;
  midiFile: File | null;
  parsedMidi: ParsedMidi | null;
  errors: string[];
  warnings: string[];
}

export interface TransferAudioAsset {
  fileName: string;
  assetId: string;
  durationSec: number;
  trackName?: string;
  referenceMix?: boolean;
}

export interface BuildTransferProjectOptions {
  projectName: string;
  sourceDaw: TransferSourceDaw;
  bpm: number;
  timeSignature: TimeSignature;
  audioAssets: TransferAudioAsset[];
  midiFileName?: string;
  midiBytes?: Uint8Array;
  parsedMidi?: ParsedMidi | null;
}

export interface TransferProjectResult {
  doc: ProjectDocument;
  audioTrackNames: string[];
  midiTrackNames: string[];
  warnings: string[];
}

const MAX_TRANSFER_AUDIO_TRACKS = 32;
const TRANSFER_AUDIO_MEMORY_WARNING_BYTES = MAX_AUDIO_IMPORT_BYTES * 4;
const MAX_TRANSFER_MIDI_BYTES = 10 * 1024 * 1024;
const MAX_TRANSFER_MIDI_INSTRUMENT_TRACKS = 8;
const MAX_IMPORTED_DRUM_STEPS = 512;
const MAX_MIDI_TICK = MAX_ARRANGEMENT_CLIP_TICKS;

function extension(name: string): string {
  return name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
}

function fileBaseName(name: string): string {
  const base = name
    .replace(/\.[^.]+$/, "")
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
    .trim();
  return (base || "Imported Track").slice(0, 48);
}

/** Sensible default for the editable output-lane name in the transfer preflight. */
export function defaultTransferTrackName(fileName: string): string {
  return fileBaseName(fileName);
}

function uniqueName(name: string, used: Set<string>): string {
  const base = name.slice(0, 48);
  let result = base;
  let suffix = 2;
  while (used.has(result.toLowerCase())) {
    const marker = ` (${suffix++})`;
    result = `${base.slice(0, Math.max(1, 48 - marker.length))}${marker}`;
  }
  used.add(result.toLowerCase());
  return result;
}

function distinctTimelineEvents(events: Array<{ tick: number }>): number {
  return events.length;
}

function midiEventLossWarning(parsed: ParsedMidi): string | null {
  const lostEventTypes: Array<[number, string, string]> = [
    [parsed.unsupportedEvents.controlChanges, "unsupported CC message", "unsupported CC messages"],
    [parsed.unsupportedEvents.pitchBends, "pitch bend", "pitch bends"],
    [parsed.unsupportedEvents.programChanges, "program change", "program changes"],
    [parsed.unsupportedEvents.aftertouch, "aftertouch event", "aftertouch events"],
    [parsed.unsupportedEvents.systemExclusive, "SysEx message", "SysEx messages"],
  ];
  const lostEvents = lostEventTypes.filter(([count]) => count > 0);
  if (lostEvents.length === 0) return null;
  const details = lostEvents.map(([count, singular, plural]) => `${count} ${count === 1 ? singular : plural}`);
  return `MIDI data that will not transfer: ${details.join(", ")}. KYX imports notes, GM drum hits, CC7/10/11 track automation, and bakes CC64 sustain into note lengths.`;
}

function midiControllerConversionWarning(parsed: ParsedMidi): string | null {
  const controllers = parsed.tracks.flatMap((track) => track.controllers);
  const hasVolume = controllers.some((event) => event.controller === 7);
  const hasPan = controllers.some((event) => event.controller === 10);
  const hasExpression = controllers.some((event) => event.controller === 11);
  const messages: string[] = [];
  if (hasVolume && hasExpression) {
    messages.push("CC7 volume and CC11 expression become combined track-volume automation");
  } else if (hasVolume) {
    messages.push("CC7 volume becomes track-volume automation");
  } else if (hasExpression) {
    messages.push("CC11 expression becomes track-volume automation");
  }
  if (hasPan) messages.push("CC10 becomes track-pan automation");
  if (parsed.sustainPedalEvents > 0)
    messages.push("CC64 sustain extends note lengths and is not retained as an editable pedal lane");
  return messages.length > 0 ? `MIDI controller conversion: ${messages.join("; ")}.` : null;
}

/** Classify a multi-file handoff without decoding audio or writing to storage. */
export async function inspectTransferFiles(files: readonly File[]): Promise<TransferInspection> {
  const audioFiles: File[] = [];
  const midiFiles: File[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const file of files) {
    const ext = extension(file.name);
    if (ext === "mid" || ext === "midi") {
      if (file.size > MAX_TRANSFER_MIDI_BYTES) {
        errors.push(
          `${file.name} is larger than the ${Math.floor(MAX_TRANSFER_MIDI_BYTES / 1024 / 1024)} MB MIDI import limit.`,
        );
      } else if (file.size === 0) {
        errors.push(`${file.name} is empty.`);
      } else {
        midiFiles.push(file);
      }
    } else if (isAudioImportFile(file)) {
      try {
        assertAudioImportSize(file.size);
        audioFiles.push(file);
      } catch (error) {
        errors.push(`${file.name}: ${error instanceof Error ? error.message : "audio file is too large"}`);
      }
    } else {
      errors.push(`${file.name} is not a supported audio or Standard MIDI file.`);
    }
  }

  if (audioFiles.length === 0 && midiFiles.length === 0)
    errors.push("Choose at least one audio file or one MIDI file.");
  if (audioFiles.length > MAX_TRANSFER_AUDIO_TRACKS) {
    errors.push(`A transfer can contain up to ${MAX_TRANSFER_AUDIO_TRACKS} audio tracks at a time.`);
  }
  if (midiFiles.length > 1)
    errors.push("Choose one combined MIDI file. It can contain multiple named instrument tracks.");

  const totalAudioBytes = audioFiles.reduce((total, file) => total + file.size, 0);
  if (totalAudioBytes > TRANSFER_AUDIO_MEMORY_WARNING_BYTES) {
    warnings.push(
      "This batch contains more than 100 MB of audio files. Decoded PCM can use considerably more memory; remove unused tracks or the reference mix if KYX is running on a low-memory device.",
    );
  }

  let parsedMidi: ParsedMidi | null = null;
  const midiFile = midiFiles[0] ?? null;
  if (midiFile && errors.length === 0) {
    try {
      parsedMidi = parseMidiFile(new Uint8Array(await midiFile.arrayBuffer()));
      if (parsedMidi.tracks.length === 0) errors.push(`${midiFile.name} contains no note events KYX can import.`);

      const melodicTracks = parsedMidi.tracks.filter((track) => track.channel !== 9);
      if (melodicTracks.length > MAX_TRANSFER_MIDI_INSTRUMENT_TRACKS) {
        errors.push(
          `This transfer path supports up to ${MAX_TRANSFER_MIDI_INSTRUMENT_TRACKS} melodic MIDI tracks per file.`,
        );
      }

      const drumTracks = parsedMidi.tracks.filter((track) => track.channel === 9);
      const latestDrumTick = drumTracks.reduce(
        (latest, track) => track.notes.reduce((trackLatest, note) => Math.max(trackLatest, note.startTick), latest),
        0,
      );
      if (Math.round((latestDrumTick * 480) / parsedMidi.division) >= MAX_IMPORTED_DRUM_STEPS * STEP_TICKS) {
        errors.push(
          "This MIDI file has drum hits beyond KYX's 32-bar drum-pattern import limit. Export those drums as aligned audio for this transfer.",
        );
      }

      const latestNoteTick = parsedMidi.tracks.reduce(
        (latest, track) => track.notes.reduce((trackLatest, note) => Math.max(trackLatest, note.endTick), latest),
        0,
      );
      if (Math.round((latestNoteTick * 480) / parsedMidi.division) > MAX_MIDI_TICK) {
        errors.push("This MIDI file extends beyond KYX's current song-length limit.");
      }

      if (parsedMidi.tempoEvents.length > 1) {
        warnings.push(
          "MIDI tempo changes will be flattened into the chosen project tempo while preserving performance timing; the tempo map will not remain separately editable.",
        );
      }
      if (parsedMidi.timeSignatureEvents.length > 1) {
        warnings.push(
          "MIDI time-signature changes will be flattened to the chosen project meter; meter changes will not remain separately editable.",
        );
      }
      if (parsedMidi.bpm !== null && (parsedMidi.bpm < 20 || parsedMidi.bpm > 300)) {
        warnings.push(
          `MIDI's starting tempo (${parsedMidi.bpm} BPM) is outside KYX's 20–300 BPM range; choose a supported tempo.`,
        );
      }
      const firstMeter = parsedMidi.timeSignature;
      if (
        firstMeter &&
        (!Number.isInteger(firstMeter.num) ||
          firstMeter.num < 1 ||
          firstMeter.num > 32 ||
          ![1, 2, 4, 8, 16, 32].includes(firstMeter.den))
      ) {
        warnings.push("MIDI's starting time signature is outside KYX's supported range; choose a supported meter.");
      }
      const eventLossWarning = midiEventLossWarning(parsedMidi);
      if (eventLossWarning) warnings.push(eventLossWarning);
      const controllerWarning = midiControllerConversionWarning(parsedMidi);
      if (controllerWarning) warnings.push(controllerWarning);
      if (drumTracks.length > 0) {
        warnings.push("GM drum notes are mapped to KYX kit pads on a 16th-note grid.");
      }
    } catch (error) {
      errors.push(`${midiFile.name}: ${error instanceof Error ? error.message : "could not parse MIDI"}`);
      parsedMidi = null;
    }
  }

  if (audioFiles.length > 0) {
    warnings.push(
      "Audio files are placed at bar 1 with their original timing. Export every track from the same song start and range.",
    );
    warnings.push(
      "MIDI instrument patches, plug-in state, mixer routing and audio automation are not transferred; KYX creates editable tracks and audio clips.",
    );
  }

  return { audioFiles, totalAudioBytes, midiFile, parsedMidi, errors, warnings };
}

function emptyTransferDocument(
  name: string,
  bpm: number,
  timeSignature: TimeSignature,
  tracks: ProjectDocument["tracks"],
): ProjectDocument {
  const base = createProjectFromTemplate("empty");
  const nameTrimmed = name.trim().slice(0, 64) || "Transferred Song";
  return normalizeProject({
    ...base,
    id: uid("project"),
    name: nameTrimmed,
    bpm,
    timeSignature,
    tracks,
    patterns: [],
    activePatternId: "",
    scenes: [],
    arrangement: {
      ...base.arrangement,
      clips: [],
      audioClips: [],
      midiClips: [],
      automationClips: [],
      transitions: [],
      clipGroups: [],
      takeGroups: [],
    },
    markers: [],
    sceneAutomation: [],
    automation: [],
    lfos: [],
    macros: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

function drumOnlyPattern(pattern: Pattern, name: string): Pattern {
  return {
    ...pattern,
    id: uid("pattern"),
    name: `${name.slice(0, 40)} Drums`,
    rows: Object.fromEntries(Object.entries(pattern.rows).map(([padId, values]) => [padId, [...values]])),
    notes: {},
    ...(pattern.stepMeta
      ? {
          stepMeta: Object.fromEntries(Object.entries(pattern.stepMeta).map(([padId, steps]) => [padId, { ...steps }])),
        }
      : {}),
  };
}

/** Assemble a new editable KYX project from the already inspected and persisted transfer assets. */
export function buildTransferProject(options: BuildTransferProjectOptions): TransferProjectResult {
  if (!Number.isFinite(options.bpm) || options.bpm < 20 || options.bpm > 300)
    throw new Error("Project tempo must be 20–300 BPM.");
  if (
    !Number.isInteger(options.timeSignature.numerator) ||
    options.timeSignature.numerator < 1 ||
    options.timeSignature.numerator > 32 ||
    ![1, 2, 4, 8, 16, 32].includes(options.timeSignature.denominator)
  ) {
    throw new Error("Choose a valid time signature (1–32 beats, denominator 1/2/4/8/16/32).");
  }
  if (options.audioAssets.length > MAX_TRANSFER_AUDIO_TRACKS)
    throw new Error("Too many audio tracks in this transfer.");
  if (options.midiBytes && !options.parsedMidi)
    throw new Error("Inspect the MIDI file before building the transfer project.");

  const audioNames = new Set<string>();
  const group = options.audioAssets.length > 0 ? createGroupTrackModel("AUDIO TRACKOUTS") : null;
  const audioTracks = options.audioAssets.map((asset, index) => {
    if (!asset.assetId) throw new Error(`Audio track "${asset.fileName}" has no stored sample asset.`);
    if (!Number.isFinite(asset.durationSec) || asset.durationSec <= 0)
      throw new Error(`Audio track "${asset.fileName}" has an invalid duration.`);
    const track = createInstrumentTrackModel("sampler", index + 1);
    track.name = uniqueName(fileBaseName(asset.trackName?.trim() || asset.fileName), audioNames);
    track.groupId = group?.id;
    if (asset.referenceMix) track.mute = true;
    return track;
  });
  const initialTracks: ProjectDocument["tracks"] = [...(group ? [group] : []), ...audioTracks];
  let doc = emptyTransferDocument(options.projectName, options.bpm, options.timeSignature, initialTracks);
  const audioTrackNames: string[] = [];
  const secondsPerBar = (60 / doc.bpm) * doc.timeSignature.numerator * (4 / doc.timeSignature.denominator);

  for (const [index, asset] of options.audioAssets.entries()) {
    const track = audioTracks[index];
    if (!track) continue;
    const lengthBars = Math.max(0.25, Math.ceil(asset.durationSec / secondsPerBar));
    if (lengthBars > MAX_ARRANGEMENT_CLIP_BARS)
      throw new Error(`Audio track "${asset.fileName}" is longer than KYX's arrangement limit.`);
    doc = addAudioClip(doc, track.id, asset.assetId, 0, lengthBars).execute(doc);
    audioTrackNames.push(track.name);
  }

  const midiTrackNames: string[] = [];
  const warnings: string[] = [];
  if (options.midiBytes && options.parsedMidi) {
    const priorTrackIds = new Set(doc.tracks.map((track) => track.id));
    const midiCommand = importMidiCommand(doc, options.midiBytes, fileBaseName(options.midiFileName ?? "MIDI Import"), {
      targetBpm: options.bpm,
    });
    const importSummary = (
      midiCommand as typeof midiCommand & {
        summary?: {
          droppedNotes?: number;
          droppedDrumHits?: number;
          truncatedNotes?: number;
          droppedControllerEvents?: number;
          drumHits?: number;
        };
      }
    ).summary;
    const omitted: string[] = [];
    if (importSummary?.droppedNotes) omitted.push(`${importSummary.droppedNotes} melodic note(s)`);
    if (importSummary?.droppedDrumHits) omitted.push(`${importSummary.droppedDrumHits} GM drum hit(s)`);
    if (importSummary?.truncatedNotes) omitted.push(`${importSummary.truncatedNotes} MIDI note tail(s)`);
    if (importSummary?.droppedControllerEvents)
      omitted.push(`${importSummary.droppedControllerEvents} MIDI controller event(s)`);
    if (omitted.length > 0) {
      throw new Error(
        `This tempo would omit ${omitted.join(" and ")} from the MIDI transfer. Choose a lower project tempo or export the affected parts as aligned audio.`,
      );
    }
    const imported = midiCommand.execute(doc);
    const importedTracks = imported.tracks.filter(
      (track): track is InstrumentTrack => !priorTrackIds.has(track.id) && track.kind === "instrument",
    );
    const importedDrums = imported.tracks.filter((track) => !priorTrackIds.has(track.id) && track.kind === "drum");
    const sourcePattern = imported.patterns.find((pattern) => pattern.id === imported.activePatternId);
    if (!sourcePattern) throw new Error("The MIDI importer did not create an editable pattern.");

    // Re-apply explicit import settings after the legacy MIDI-to-pattern command,
    // which otherwise takes its tempo from the file without exposing the UI choice.
    doc = normalizeProject({
      ...imported,
      bpm: options.bpm,
      timeSignature: options.timeSignature,
      scenes: [],
      arrangement: { ...imported.arrangement, clips: [] },
    });
    const currentSourcePattern = doc.patterns.find((pattern) => pattern.id === sourcePattern.id) ?? sourcePattern;
    const melodicSources = options.parsedMidi.tracks.filter((track) => track.channel !== 9).slice(0, 8);
    for (const [index, track] of importedTracks.entries()) {
      const notes = currentSourcePattern.notes[track.id] ?? [];
      const maxEnd = notes.reduce((latest, note) => Math.max(latest, note.start + note.duration), 0);
      if (maxEnd > 0) {
        doc = addMidiClip(doc, track.id, currentSourcePattern.id, 0, Math.min(MAX_MIDI_TICK, maxEnd)).execute(doc);
      }
      if (maxEnd > 0 || (melodicSources[index]?.controllers.length ?? 0) > 0) midiTrackNames.push(track.name);
    }

    if (importedDrums.length > 0 && (importSummary?.drumHits ?? 0) > 0) {
      const percussionPattern = drumOnlyPattern(currentSourcePattern, fileBaseName(options.midiFileName ?? "MIDI"));
      doc = normalizeProject({
        ...doc,
        patterns: [...doc.patterns, percussionPattern],
        activePatternId: percussionPattern.id,
      });
      doc = createScene(doc, `${importedDrums[0]?.name ?? "Imported Drums"}`).execute(doc);
      const scene = doc.scenes[doc.scenes.length - 1];
      if (!scene) throw new Error("Could not create the imported drum scene.");
      const drumBars = Math.min(MAX_ARRANGEMENT_CLIP_BARS, Math.max(1, Math.ceil(percussionPattern.stepCount / 16)));
      doc = addArrangementClip(doc, scene.id, 0, drumBars).execute(doc);
    }
    if (importedDrums.length > 0) midiTrackNames.push(...importedDrums.map((track) => track.name));

    const parsed = options.parsedMidi;
    if (parsed.tempoEvents.length > 1) {
      warnings.push(
        `The MIDI tempo map was flattened into ${options.bpm} BPM while preserving performance timing; tempo changes are not separately editable.`,
      );
    }
    if (parsed.timeSignatureEvents.length > 1)
      warnings.push(
        `The MIDI time-signature map was flattened to ${options.timeSignature.numerator}/${options.timeSignature.denominator}; meter changes are not separately editable.`,
      );
    const eventLossWarning = midiEventLossWarning(parsed);
    if (eventLossWarning) warnings.push(eventLossWarning);
    const controllerWarning = midiControllerConversionWarning(parsed);
    if (controllerWarning) warnings.push(controllerWarning);
  }

  doc = normalizeProject({
    ...doc,
    transferOrigin: { version: 1, kind: "aligned-audio-midi", sourceDaw: options.sourceDaw },
  });

  return {
    doc,
    audioTrackNames,
    midiTrackNames,
    warnings,
  };
}

export function midiImportWarnings(parsed: ParsedMidi | null): string[] {
  if (!parsed) return [];
  const warnings: string[] = [];
  if (distinctTimelineEvents(parsed.tempoEvents) > 1) {
    warnings.push(
      "MIDI tempo changes will be flattened into the chosen project tempo while preserving performance timing; the tempo map will not remain separately editable.",
    );
  }
  if (distinctTimelineEvents(parsed.timeSignatureEvents) > 1) {
    warnings.push(
      "MIDI time-signature changes will be flattened to the chosen project meter; meter changes will not remain separately editable.",
    );
  }
  const eventLossWarning = midiEventLossWarning(parsed);
  if (eventLossWarning) warnings.push(eventLossWarning);
  const controllerWarning = midiControllerConversionWarning(parsed);
  if (controllerWarning) warnings.push(controllerWarning);
  if (parsed.tracks.some((track) => track.channel === 9))
    warnings.push("GM drum notes are mapped to KYX kit pads on a 16th-note grid.");
  return warnings;
}

/**
 * The ARRANGEMENT follows the document's meter (ADR 0056 Stage 2): the ruler,
 * clip placement, loop regions, the metronome and the bar readouts all measure
 * the metrical bar. The PATTERN grid follows it too now (ADR 0057): one bar is
 * `ticksPerBar(doc) / STEP_TICKS` sixteenth steps, and the grid draws that bar
 * line.
 *
 * What still needs disclosing is the IMPORTED PATTERN'S OWN LENGTH. A pattern
 * is a musical duration in sixteenth notes, and the imported one carries the
 * source project's length — a 4/4 bar of 16 sixteenth notes (1920 ticks), which
 * is 1.33 bars of 6/8. A pattern that is not a whole number of bars drifts
 * against the ruler: its downbeat reaches the bar line only every fourth bar.
 * That is measured, not assumed (see `tests/adr0056-pattern-grid.test.ts`), and
 * the dialog discloses it BEFORE the song is imported rather than shipping a
 * project whose grooves quietly drift against its own ruler.
 *
 * `null` when a 16-step pattern is exactly a whole number of bars of the
 * chosen meter (4/4, 2/2, 8/8, 2/4).
 */
export function patternGridWarning(sig: TimeSignature): string | null {
  const barTicks = ticksPerBarFor(sig);
  const patternTicks = PATTERN_TICKS;
  const stepsPerBar = Math.max(1, Math.round(barTicks / STEP_TICKS));
  // A 16-step pattern is a whole number of bars only when the metrical bar
  // divides it. In 6/8 the bar is 12 steps and 16 is not a multiple of 12.
  if ((PATTERN_TICKS / STEP_TICKS) % stepsPerBar === 0) return null;
  // How many bars one 4/4 bar of pattern spans (fractional in 3/4 and 6/8).
  const barsPerPattern = patternTicks / barTicks;
  // How many bars pass between two pattern downbeats that land on a bar line.
  const downbeatEveryBars = patternTicks / greatestCommonDivisor(patternTicks, barTicks);
  return (
    `KYX's arrangement follows your ${sig.numerator}/${sig.denominator} meter — every ruler bar, ` +
    `clip placement and loop region is ${barTicks} ticks, and the step grid follows the meter as well. ` +
    `But the imported pattern keeps its own length: 16 sixteenth notes (${patternTicks} ticks = four ` +
    `quarter notes) is ${barsPerPattern.toFixed(2)} bars of ${sig.numerator}/${sig.denominator}, so a ` +
    `pattern that is not a whole number of bars drifts against the ruler — its downbeat reaches the bar ` +
    `line only every ${downbeatEveryBars} ${downbeatEveryBars === 1 ? "bar" : "bars"}. The grid draws ` +
    `that bar line now, and the pattern length control offers whole bars (${stepsPerBar} steps) if you ` +
    `want the groove to land on the downbeat.`
  );
}

function greatestCommonDivisor(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x || 1;
}

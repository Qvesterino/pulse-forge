import { addAudioClip } from "../commands/audioClips";
import { addArrangementClip } from "../commands/arrangement";
import { addMidiClip } from "../commands/midiClips";
import { createScene } from "../commands/scenes";
import { assertAudioImportSize, isAudioImportFile } from "../audio-import-capabilities";
import {
  MAX_ARRANGEMENT_CLIP_BARS,
  MAX_ARRANGEMENT_CLIP_TICKS,
  createGroupTrackModel,
  createInstrumentTrackModel,
  normalizeProject,
} from "../project-model/schema";
import {
  STEP_TICKS,
  type InstrumentTrack,
  type Pattern,
  type ProjectDocument,
  type TimeSignature,
} from "../project-model/types";
import { createProjectFromTemplate } from "../project-model/templates";
import { uid } from "../shared/ids";
import { importMidiCommand } from "../midi/midiProject";
import { parseMidiFile, type ParsedMidi } from "../midi/midiFile";

export type TransferSourceDaw = "fl-studio" | "cubase" | "pro-tools" | "other";

export interface TransferInspection {
  audioFiles: File[];
  midiFile: File | null;
  parsedMidi: ParsedMidi | null;
  errors: string[];
  warnings: string[];
}

export interface TransferAudioAsset {
  fileName: string;
  assetId: string;
  durationSec: number;
  referenceMix?: boolean;
}

export interface BuildTransferProjectOptions {
  projectName: string;
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
          "MIDI tempo changes are not represented by this transfer yet. KYX will use the first tempo; later MIDI may drift against the audio tracks.",
        );
      }
      if (parsedMidi.timeSignatureEvents.length > 1) {
        warnings.push(
          "MIDI time-signature changes are not represented by this transfer yet. KYX will use the first meter.",
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
      const unsupportedCount = Object.values(parsedMidi.unsupportedEvents).reduce((sum, count) => sum + count, 0);
      if (unsupportedCount > 0) {
        warnings.push(
          `MIDI contains ${unsupportedCount} controller, pitch-bend, program, aftertouch or SysEx event(s); KYX imports notes and GM drum hits only.`,
        );
      }
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

  return { audioFiles, midiFile, parsedMidi, errors, warnings };
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
    track.name = uniqueName(fileBaseName(asset.fileName), audioNames);
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
    const midiCommand = importMidiCommand(doc, options.midiBytes, fileBaseName(options.midiFileName ?? "MIDI Import"));
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
    for (const track of importedTracks) {
      const notes = currentSourcePattern.notes[track.id] ?? [];
      const maxEnd = notes.reduce((latest, note) => Math.max(latest, note.start + note.duration), 0);
      if (maxEnd > 0) {
        doc = addMidiClip(doc, track.id, currentSourcePattern.id, 0, Math.min(MAX_MIDI_TICK, maxEnd)).execute(doc);
        midiTrackNames.push(track.name);
      }
    }

    if (importedDrums.length > 0) {
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
      midiTrackNames.push(...importedDrums.map((track) => track.name));
    }

    const parsed = options.parsedMidi;
    if (parsed.tempoEvents.length > 1 || parsed.timeSignatureEvents.length > 1) {
      warnings.push(
        "This MIDI file contains timeline changes that KYX v1 does not model on a global song map; the first tempo and meter were applied.",
      );
    }
    const unsupportedCount = Object.values(parsed.unsupportedEvents).reduce((sum, count) => sum + count, 0);
    if (unsupportedCount > 0)
      warnings.push(
        `${unsupportedCount} MIDI controller/program/pitch-bend/aftertouch/SysEx event(s) were not imported.`,
      );
    const importSummary = (midiCommand as typeof midiCommand & { summary?: { droppedNotes?: number } }).summary;
    if (importSummary?.droppedNotes)
      warnings.push(`${importSummary.droppedNotes} MIDI note(s) exceeded KYX's arrangement range and were omitted.`);
  }

  return {
    doc: normalizeProject(doc),
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
      "MIDI tempo changes are not represented by this transfer yet. KYX will use the first tempo; later MIDI may drift against the audio tracks.",
    );
  }
  if (distinctTimelineEvents(parsed.timeSignatureEvents) > 1) {
    warnings.push(
      "MIDI time-signature changes are not represented by this transfer yet. KYX will use the first meter.",
    );
  }
  const unsupportedCount = Object.values(parsed.unsupportedEvents).reduce((sum, count) => sum + count, 0);
  if (unsupportedCount > 0) {
    warnings.push(
      `MIDI contains ${unsupportedCount} controller, pitch-bend, program, aftertouch or SysEx event(s); KYX imports notes and GM drum hits only.`,
    );
  }
  if (parsed.tracks.some((track) => track.channel === 9))
    warnings.push("GM drum notes are mapped to KYX kit pads on a 16th-note grid.");
  return warnings;
}

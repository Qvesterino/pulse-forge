import type {
  DrumPad,
  DrumSynthType,
  InstrumentTrack,
  NoteEvent,
  Pattern,
  TimeSignature,
  Track,
} from "../../project-model/types";
import { PPQ } from "../../project-model/types";
import { patternLengthTicks } from "../../midi/hum-to-notes";

/** Audiotool's document timeline uses 3,840 ticks per quarter note (KYX uses 480). */
export const AUDIOTOOL_TICKS_PER_QUARTER = 3840;
export const KYX_TO_AUDIOTOOL_TICK_SCALE = AUDIOTOOL_TICKS_PER_QUARTER / PPQ;
export const MAX_AUDIOTOOL_PARTS = 24;
export const MAX_AUDIOTOOL_NOTES = 4096;
export const MAX_AUDIOTOOL_BARS = 256;
export const AUDIOTOOL_BEATBOX_STEP_TICKS = AUDIOTOOL_TICKS_PER_QUARTER / 4;
export const MAX_AUDIOTOOL_BEATBOX_STEPS = 64;

export type AudiotoolBeatboxRole =
  | "bassdrumIsActive"
  | "snaredrumIsActive"
  | "tomCongaLowIsActive"
  | "tomCongaMidIsActive"
  | "tomCongaHighIsActive"
  | "rimClavesIsActive"
  | "clapMaracasIsActive"
  | "cowbellIsActive"
  | "cymbalIsActive"
  | "openHihatIsActive"
  | "closedHihatIsActive";

export interface AudiotoolBeatboxStep {
  bassdrumIsActive: boolean;
  snaredrumIsActive: boolean;
  tomCongaLowIsActive: boolean;
  tomCongaMidIsActive: boolean;
  tomCongaHighIsActive: boolean;
  rimClavesIsActive: boolean;
  clapMaracasIsActive: boolean;
  cowbellIsActive: boolean;
  cymbalIsActive: boolean;
  openHihatIsActive: boolean;
  closedHihatIsActive: boolean;
  isAccented: boolean;
}

export type AudiotoolBeatboxSteps = AudiotoolBeatboxStep[] & { length: 64 };

export interface AudiotoolBeatboxPattern {
  /** Number of active steps in the exported 16th-note pattern. */
  length: number;
  /** Original KYX step count, retained to report/cap patterns longer than Beatbox8. */
  sourceStepCount: number;
  /** Beatbox8 requires exactly 64 step objects even when `length` is shorter. */
  steps: AudiotoolBeatboxSteps;
  /** Number of distinct Beatbox8 role/step activations after collision merging. */
  hitCount: number;
}

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
  drumPattern?: AudiotoolBeatboxPattern;
  noteCount: number;
  unsupportedDrumHits: number;
  collapsedDrumHits: number;
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
 * Pure, bounded conversion of KYX's selected pattern into Audiotool MIDI and
 * the explicitly supported Beatbox8 drum roles. Unknown content is reported.
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
  const maxSourceSteps = Math.max(1, Math.floor((MAX_AUDIOTOOL_BARS * barTicks) / AUDIOTOOL_BEATBOX_STEP_TICKS));
  if (!Number.isSafeInteger(pattern.stepCount) || pattern.stepCount < 1 || pattern.stepCount > maxSourceSteps) {
    return {
      ok: false,
      error: `This idea has an invalid or unsupported pattern length (maximum ${MAX_AUDIOTOOL_BARS} bars).`,
    };
  }

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

  const drumResult = mapDrumPattern(pattern, tracks, maxSourceSteps);
  if (!drumResult.ok) return drumResult;
  const drumPattern = drumResult.pattern;

  if ((parts.length === 0 || noteCount === 0) && !drumPattern) {
    return {
      ok: false,
      error: "This idea has no supported pitched MIDI notes or Beatbox8-compatible drum hits to send.",
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

  const fingerprintPayload: {
    projectId: string;
    sourceBpm: number;
    timeSignature: TimeSignature;
    durationTicks: number;
    parts: AudiotoolMidiPart[];
    drumPattern?: Pick<AudiotoolBeatboxPattern, "length" | "steps">;
  } = {
    projectId,
    sourceBpm,
    timeSignature,
    durationTicks,
    parts: parts.map((part) => ({ name: part.name, notes: part.notes })),
  };
  if (drumPattern) fingerprintPayload.drumPattern = { length: drumPattern.length, steps: drumPattern.steps };
  const fingerprintInput = JSON.stringify(fingerprintPayload);
  const plan: AudiotoolWritePlan = {
    projectId,
    sourceBpm,
    timeSignature: { ...timeSignature },
    durationTicks,
    bars,
    parts,
    ...(drumPattern ? { drumPattern } : {}),
    noteCount,
    unsupportedDrumHits: drumResult.unsupportedHits,
    collapsedDrumHits: drumResult.collapsedHits,
    unsupportedNoteCount,
    // This is an idempotency marker, not a cryptographic integrity check.
    fingerprint: stableFingerprint(fingerprintInput),
  };
  return { ok: true, plan };
}

type DrumMappingResult =
  | { ok: true; pattern?: AudiotoolBeatboxPattern; unsupportedHits: number; collapsedHits: number }
  | { ok: false; error: string };

const FACTORY_DRUM_ROLES: ReadonlyArray<readonly [string, AudiotoolBeatboxRole]> = [
  ["factory.kick.", "bassdrumIsActive"],
  ["factory.snare.", "snaredrumIsActive"],
  ["factory.clap.", "clapMaracasIsActive"],
  ["factory.hat.open", "openHihatIsActive"],
  ["factory.hat.closed", "closedHihatIsActive"],
  ["factory.hat.pedal", "closedHihatIsActive"],
  ["factory.hat.", "closedHihatIsActive"],
  ["factory.tom.low", "tomCongaLowIsActive"],
  ["factory.tom.floor", "tomCongaLowIsActive"],
  ["factory.tom.mid", "tomCongaMidIsActive"],
  ["factory.tom.high", "tomCongaHighIsActive"],
  ["factory.rim.", "rimClavesIsActive"],
  ["factory.cowbell.", "cowbellIsActive"],
  ["factory.cymbal.", "cymbalIsActive"],
  ["factory.crash.", "cymbalIsActive"],
  ["factory.ride.", "cymbalIsActive"],
];

const SYNTH_DRUM_ROLES: Record<DrumSynthType, AudiotoolBeatboxRole | null> = {
  kick: "bassdrumIsActive",
  snare: "snaredrumIsActive",
  hatClosed: "closedHihatIsActive",
  hatOpen: "openHihatIsActive",
  clap: "clapMaracasIsActive",
  cowbell: "cowbellIsActive",
  perc: null,
};

function mapDrumPattern(pattern: Pattern, tracks: readonly Track[], maxSourceSteps: number): DrumMappingResult {
  const padRoles = new Map<string, AudiotoolBeatboxRole | null>();
  for (const track of tracks) {
    if (track.kind !== "drum") continue;
    for (const pad of track.pads) {
      if (padRoles.has(pad.id)) {
        padRoles.set(pad.id, null);
      } else {
        padRoles.set(pad.id, beatboxRoleForPad(pad));
      }
    }
  }

  const steps = Array.from({ length: MAX_AUDIOTOOL_BEATBOX_STEPS }, createEmptyBeatboxStep) as AudiotoolBeatboxSteps;
  let hitCount = 0;
  let unsupportedHits = 0;
  let collapsedHits = 0;

  for (const [padId, row] of Object.entries(pattern.rows)) {
    if (!Array.isArray(row)) return { ok: false, error: "This idea contains an invalid drum row." };
    if (row.length > maxSourceSteps) {
      return { ok: false, error: "This idea contains a drum row beyond the supported timeline." };
    }
    const role = padRoles.get(padId) ?? null;
    for (let stepIndex = 0; stepIndex < row.length; stepIndex += 1) {
      const velocity = row[stepIndex];
      if (typeof velocity !== "number" || !Number.isFinite(velocity) || velocity < 0 || velocity > 1) {
        return { ok: false, error: "This idea contains an invalid drum velocity." };
      }
      if (velocity === 0) continue;
      if (stepIndex >= pattern.stepCount || stepIndex >= MAX_AUDIOTOOL_BEATBOX_STEPS || !role) {
        unsupportedHits += 1;
        continue;
      }
      const step = steps[stepIndex];
      if (!step) return { ok: false, error: "This idea contains a drum step outside the supported timeline." };
      if (step[role]) {
        collapsedHits += 1;
      } else {
        step[role] = true;
        hitCount += 1;
      }
      if (velocity >= 0.75) step.isAccented = true;
    }
  }

  if (hitCount === 0) return { ok: true, unsupportedHits, collapsedHits };
  return {
    ok: true,
    pattern: {
      length: Math.min(pattern.stepCount, MAX_AUDIOTOOL_BEATBOX_STEPS),
      sourceStepCount: pattern.stepCount,
      steps,
      hitCount,
    },
    unsupportedHits,
    collapsedHits,
  };
}

function createEmptyBeatboxStep(): AudiotoolBeatboxStep {
  return {
    bassdrumIsActive: false,
    snaredrumIsActive: false,
    tomCongaLowIsActive: false,
    tomCongaMidIsActive: false,
    tomCongaHighIsActive: false,
    rimClavesIsActive: false,
    clapMaracasIsActive: false,
    cowbellIsActive: false,
    cymbalIsActive: false,
    openHihatIsActive: false,
    closedHihatIsActive: false,
    isAccented: false,
  };
}

function beatboxRoleForPad(pad: DrumPad): AudiotoolBeatboxRole | null {
  if (pad.layers?.length) {
    const layerRoles = pad.layers.map((layer) => factoryAssetBeatboxRole(layer.sampleId));
    const first = layerRoles[0];
    return first && layerRoles.every((role) => role === first) ? first : null;
  }
  if (pad.assetId) return factoryAssetBeatboxRole(pad.assetId);
  return pad.synth ? (SYNTH_DRUM_ROLES[pad.synth.type] ?? null) : null;
}

function factoryAssetBeatboxRole(assetId: string | null): AudiotoolBeatboxRole | null {
  if (!assetId) return null;
  for (const [prefix, role] of FACTORY_DRUM_ROLES) {
    if (assetId === prefix.slice(0, -1) || assetId.startsWith(prefix)) return role;
  }
  return null;
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

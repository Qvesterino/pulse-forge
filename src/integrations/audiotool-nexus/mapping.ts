import type {
  DrumPad,
  DrumTrack,
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
export const AUDIOTOOL_BEATBOX_STEP_TICKS = AUDIOTOOL_TICKS_PER_QUARTER / 4;
export const KYX_TO_AUDIOTOOL_TICK_SCALE = AUDIOTOOL_TICKS_PER_QUARTER / PPQ;
export const MAX_AUDIOTOOL_PARTS = 24;
export const MAX_AUDIOTOOL_NOTES = 4096;
export const MAX_AUDIOTOOL_BARS = 256;
export const MAX_AUDIOTOOL_BEATBOX_STEPS = 64;
const MAX_AUDIOTOOL_PATTERN_STEPS = MAX_AUDIOTOOL_BARS * MAX_AUDIOTOOL_BEATBOX_STEPS;

export type AudiotoolDrumRole =
  | "bassdrum"
  | "snaredrum"
  | "tomCongaLow"
  | "tomCongaMid"
  | "tomCongaHigh"
  | "rimClaves"
  | "clapMaracas"
  | "cowbell"
  | "cymbal"
  | "openHihat"
  | "closedHihat";

export type AudiotoolBeatboxStep = Record<`${AudiotoolDrumRole}IsActive`, boolean> & {
  isAccented: boolean;
};

export interface AudiotoolBeatboxPattern {
  /** Number of steps before the Audiotool pattern repeats (1–64). */
  length: number;
  /** Original KYX loop length; a larger value cannot fit into one Beatbox8 pattern. */
  sourceStepCount: number;
  /** Beatbox8 uses a fixed 64-step array even when its loop is shorter. */
  steps: AudiotoolBeatboxStep[] & { length: 64 };
  /** Number of distinct role/step triggers that survive the conversion. */
  hits: number;
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
  noteCount: number;
  drumPattern: AudiotoolBeatboxPattern | null;
  drumHitCount: number;
  collapsedDrumHits: number;
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
 * Pure, bounded conversion of a selected KYX pattern into Audiotool MIDI and
 * the subset of drum roles represented by Beatbox8. Samples and detailed
 * velocity/per-step performance metadata are intentionally not embedded.
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
    !Number.isSafeInteger(pattern.stepCount) ||
    pattern.stepCount < 1 ||
    pattern.stepCount > MAX_AUDIOTOOL_PATTERN_STEPS
  ) {
    return { ok: false, error: "The KYX pattern length is outside the supported range." };
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
  const drums = mapDrumPattern(pattern, tracks);
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

  if ((parts.length === 0 || noteCount === 0) && !drums.pattern) {
    return {
      ok: false,
      error: "This idea has no supported MIDI notes or Beatbox8 drum hits to send.",
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
    drumPattern: drums.pattern,
    drumHitCount: drums.hitCount,
    collapsedDrumHits: drums.collapsedHits,
    unsupportedDrumHits: drums.unsupportedHits,
  });
  const plan: AudiotoolWritePlan = {
    projectId,
    sourceBpm,
    timeSignature: { ...timeSignature },
    durationTicks,
    bars,
    parts,
    noteCount,
    drumPattern: drums.pattern,
    drumHitCount: drums.hitCount,
    collapsedDrumHits: drums.collapsedHits,
    unsupportedDrumHits: drums.unsupportedHits,
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

function mapDrumPattern(
  pattern: Pattern,
  tracks: readonly Track[],
): {
  pattern: AudiotoolBeatboxPattern | null;
  hitCount: number;
  collapsedHits: number;
  unsupportedHits: number;
} {
  const steps = Array.from({ length: MAX_AUDIOTOOL_BEATBOX_STEPS }, emptyBeatboxStep) as AudiotoolBeatboxStep[] & {
    length: 64;
  };
  const stepMaxVelocity = new Array<number>(MAX_AUDIOTOOL_BEATBOX_STEPS).fill(0);
  const drumPads = new Map<string, { track: DrumTrack; pad: DrumPad }[]>();
  for (const track of tracks) {
    if (track.kind !== "drum") continue;
    for (const pad of track.pads) {
      const matches = drumPads.get(pad.id) ?? [];
      matches.push({ track, pad });
      drumPads.set(pad.id, matches);
    }
  }

  let hitCount = 0;
  let collapsedHits = 0;
  let unsupportedHits = 0;
  const rawHitCount = (row: number[]) =>
    row.reduce((count, value) => count + (typeof value === "number" && Number.isFinite(value) && value > 0 ? 1 : 0), 0);

  for (const [padId, row] of Object.entries(pattern.rows)) {
    if (!Array.isArray(row)) continue;
    const matches = drumPads.get(padId);
    if (!matches || matches.length !== 1) {
      unsupportedHits += rawHitCount(row);
      continue;
    }
    const match = matches[0];
    if (!match || match.track.mute || match.pad.mute) continue;
    const role = audiotoolRoleForPad(match.pad);
    if (!role) {
      unsupportedHits += rawHitCount(row);
      continue;
    }
    const roleField = `${role}IsActive` as `${AudiotoolDrumRole}IsActive`;
    for (let stepIndex = 0; stepIndex < row.length; stepIndex += 1) {
      const velocity = row[stepIndex];
      if (typeof velocity !== "number" || !Number.isFinite(velocity) || velocity <= 0) continue;
      if (stepIndex >= pattern.stepCount || stepIndex >= MAX_AUDIOTOOL_BEATBOX_STEPS) {
        unsupportedHits += 1;
        continue;
      }
      const step = steps[stepIndex];
      if (!step) {
        unsupportedHits += 1;
        continue;
      }
      if (step[roleField]) collapsedHits += 1;
      else hitCount += 1;
      step[roleField] = true;
      stepMaxVelocity[stepIndex] = Math.max(stepMaxVelocity[stepIndex] ?? 0, Math.min(1, velocity));
    }
  }

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (step) step.isAccented = (stepMaxVelocity[index] ?? 0) >= 0.75;
  }

  if (hitCount === 0) {
    return { pattern: null, hitCount, collapsedHits, unsupportedHits };
  }
  return {
    pattern: {
      length: Math.max(1, Math.min(MAX_AUDIOTOOL_BEATBOX_STEPS, Math.trunc(pattern.stepCount))),
      sourceStepCount: pattern.stepCount,
      steps,
      hits: hitCount,
    },
    hitCount,
    collapsedHits,
    unsupportedHits,
  };
}

function emptyBeatboxStep(): AudiotoolBeatboxStep {
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

function audiotoolRoleForPad(pad: DrumPad): AudiotoolDrumRole | null {
  if (!pad.assetId && pad.synth) {
    switch (pad.synth.type) {
      case "kick":
        return "bassdrum";
      case "snare":
        return "snaredrum";
      case "hatClosed":
        return "closedHihat";
      case "hatOpen":
        return "openHihat";
      case "clap":
        return "clapMaracas";
      case "cowbell":
        return "cowbell";
      case "perc":
        return null;
    }
  }

  const assetId = pad.assetId ?? "";
  if (assetId.startsWith("factory.kick.")) return "bassdrum";
  if (assetId.startsWith("factory.snare.")) return "snaredrum";
  if (assetId.startsWith("factory.clap.") || assetId.startsWith("factory.shaker.")) return "clapMaracas";
  if (assetId.startsWith("factory.hat.open.")) return "openHihat";
  if (assetId.startsWith("factory.hat.")) return "closedHihat";
  if (assetId.startsWith("factory.tom.low") || assetId.startsWith("factory.tom.floor")) return "tomCongaLow";
  if (assetId.startsWith("factory.tom.mid")) return "tomCongaMid";
  if (assetId.startsWith("factory.tom.high")) return "tomCongaHigh";
  if (assetId.startsWith("factory.rim.")) return "rimClaves";
  if (assetId.startsWith("factory.perc.cowbell")) return "cowbell";
  if (
    assetId.startsWith("factory.ride.") ||
    assetId.startsWith("factory.crash.") ||
    assetId.startsWith("factory.cymbal.")
  ) {
    return "cymbal";
  }
  return null;
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

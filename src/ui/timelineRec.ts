/**
 * Timeline recording helpers — the placement math for mic takes recorded
 * straight onto an armed arrangement track. Pure, so the tests cover the
 * math without a microphone.
 */
import { BAR_TICKS } from "../project-model/types";
import type { AudioClip, ProjectDocument } from "../project-model/types";
import type { RecordingChannelDestination, RecordingSession } from "../persistence/RecordingRecoveryRepository";
import { addAudioClip, addAudioTakeClip, setActiveAudioTake, snapshot } from "../commands/commands";
import type { Command } from "../commands/types";

/** One bar in seconds at the given tempo (4/4). */
export function secondsPerBar(bpm: number): number {
  const safeBpm = Number.isFinite(bpm) && bpm >= 20 ? bpm : 120;
  return 240 / safeBpm;
}

/**
 * Clip length in bars for a recorded take — rounded to 2 decimals (the
 * command's own granularity) with a 0.25-bar floor so whisper-short takes
 * still make a visible, selectable clip.
 */
export function clipLengthBars(durationSec: number, bpm: number): number {
  const bars = durationSec / secondsPerBar(bpm);
  return Math.max(0.25, Math.round(bars * 100) / 100);
}

export interface RecordedPunchWindow {
  /** Non-destructive source offset at the AudioWorklet's exact punch-in frame. */
  offsetSec: number;
  /** Exact locator span for a completed punch, or captured duration for a manual partial stop. */
  lengthBars: number;
}

/** Resolve a durable punch recording to the exact input-frame window for placement/recovery. */
export function recordedPunchWindow(session: RecordingSession): RecordedPunchWindow | null {
  const punch = session.punchCapture;
  if (
    !punch ||
    !Number.isSafeInteger(session.totalFrames) ||
    session.totalFrames <= 0 ||
    !Number.isInteger(session.sampleRate) ||
    session.sampleRate <= 0 ||
    !Number.isSafeInteger(punch.startTick) ||
    !Number.isSafeInteger(punch.endTick) ||
    punch.endTick <= punch.startTick
  ) {
    return null;
  }
  const startFrame = (session.takeBoundaries ?? []).find(
    (frame) => Number.isSafeInteger(frame) && frame >= 0 && frame < session.totalFrames,
  );
  if (startFrame === undefined || startFrame >= session.totalFrames) return null;
  const capturedFrames = session.totalFrames - startFrame;
  const lengthBars = session.punchOutReached
    ? (punch.endTick - punch.startTick) / BAR_TICKS
    : clipLengthBars(capturedFrames / session.sampleRate, session.bpm);
  if (!Number.isFinite(lengthBars) || lengthBars <= 0) return null;
  return { offsetSec: startFrame / session.sampleRate, lengthBars };
}

/** Exact musical position where REC starts, expressed in bars. */
export function recordingStartBar(positionTicks: number): number {
  return Number.isFinite(positionTicks) ? Math.max(0, positionTicks / BAR_TICKS) : 0;
}

/** Apply a measured manual mic-input correction; positive values move takes earlier. */
export function compensateRecordingStartBar(startBar: number, inputOffsetMs: number, bpm: number): number {
  const safeStartBar = Number.isFinite(startBar) ? Math.max(0, startBar) : 0;
  const safeOffsetMs = Number.isFinite(inputOffsetMs) ? inputOffsetMs : 0;
  return Math.max(0, safeStartBar - safeOffsetMs / (secondsPerBar(bpm) * 1000));
}

/** A recovered recording may already have a timeline clip after a failed library commit. */
export function recordedTakeAlreadyPlaced(doc: ProjectDocument, bufferId: string): boolean {
  return (doc.arrangement.audioClips ?? []).some((clip) => clip.bufferId === bufferId);
}

/**
 * Mic takes need sample-accurate timeline placement. The general-purpose
 * addAudioClip command keeps its centibar behavior for editing; this lazy
 * recording-only wrapper preserves the REC anchor at transport-tick resolution.
 */
export function addRecordedAudioClip(
  doc: ProjectDocument,
  trackId: string,
  bufferId: string,
  startBar: number,
  lengthBars: number,
  patch: Partial<Omit<AudioClip, "id" | "trackId" | "bufferId" | "startBar" | "lengthBars">> = {},
): Command {
  const exactStartBar = Number.isFinite(startBar) ? Math.max(0, Math.round(startBar * BAR_TICKS) / BAR_TICKS) : 0;
  const addCommand = addAudioClip(doc, trackId, bufferId, exactStartBar, lengthBars, patch);
  return {
    ...addCommand,
    execute(currentDoc) {
      const added = addCommand.execute(currentDoc);
      const existingIds = new Set((currentDoc.arrangement.audioClips ?? []).map((clip) => clip.id));
      const addedClipId = (added.arrangement.audioClips ?? []).find((clip) => !existingIds.has(clip.id))?.id;
      if (!addedClipId) throw new Error("The recorded audio clip could not be created");

      return {
        ...added,
        arrangement: {
          ...added.arrangement,
          audioClips: (added.arrangement.audioClips ?? [])
            .map((clip) => (clip.id === addedClipId ? { ...clip, startBar: exactStartBar } : clip))
            .sort((a, b) => a.startBar - b.startBar),
        },
      };
    },
  };
}

export interface RecordedAudioDestination {
  trackId: string;
  /** When set, route one captured source channel to this mono timeline clip. */
  sourceChannel?: number;
}

export interface ResolvedRecordedAudioDestinations {
  destinations: RecordedAudioDestination[];
  unavailableChannels: number[];
  missingTracks: string[];
  usedFallback: boolean;
}

/** Validate durable channel-routing metadata against the restored take and current project. */
export function resolveRecordedAudioDestinations(
  doc: ProjectDocument,
  fallbackTrackId: string,
  channelDestinations: RecordingChannelDestination[] | undefined,
  capturedChannels: number,
): ResolvedRecordedAudioDestinations {
  const trackIds = new Set(doc.tracks.map((track) => track.id));
  const fallback = (): ResolvedRecordedAudioDestinations => ({
    destinations: trackIds.has(fallbackTrackId) ? [{ trackId: fallbackTrackId }] : [],
    unavailableChannels: [],
    missingTracks: trackIds.has(fallbackTrackId) ? [] : [fallbackTrackId],
    usedFallback: true,
  });
  if (!Array.isArray(channelDestinations) || channelDestinations.length === 0) return fallback();

  const destinations: RecordedAudioDestination[] = [];
  const unavailableChannels: number[] = [];
  const missingTracks: string[] = [];
  const seenChannels = new Set<number>();
  for (const entry of channelDestinations) {
    if (!entry || !Number.isSafeInteger(entry.channelIndex) || entry.channelIndex < 0 || entry.channelIndex >= 32) {
      continue;
    }
    if (seenChannels.has(entry.channelIndex)) continue;
    seenChannels.add(entry.channelIndex);
    if (entry.channelIndex >= capturedChannels) {
      unavailableChannels.push(entry.channelIndex);
      continue;
    }
    if (typeof entry.trackId !== "string" || !trackIds.has(entry.trackId)) {
      missingTracks.push(typeof entry.trackName === "string" && entry.trackName ? entry.trackName : entry.trackId);
      continue;
    }
    destinations.push({ trackId: entry.trackId, sourceChannel: entry.channelIndex });
  }
  if (destinations.length > 0) {
    return { destinations, unavailableChannels, missingTracks, usedFallback: false };
  }
  const restored = fallback();
  return { ...restored, unavailableChannels, missingTracks, usedFallback: true };
}

/**
 * Place channel-split takes as one undoable edit. All clips refer to the same
 * saved buffer; selecting a channel never duplicates the captured PCM asset.
 */
export function addRecordedAudioClips(
  doc: ProjectDocument,
  destinations: RecordedAudioDestination[],
  bufferId: string,
  startBar: number,
  lengthBars: number,
  patch: Partial<Omit<AudioClip, "id" | "trackId" | "bufferId" | "startBar" | "lengthBars" | "sourceChannel">> = {},
): Command {
  if (destinations.length === 0) throw new Error("No available track destination for the recorded audio");
  const exactStartBar = Number.isFinite(startBar) ? Math.max(0, Math.round(startBar * BAR_TICKS) / BAR_TICKS) : 0;
  let next = doc;
  for (const destination of destinations) {
    const channelPatch =
      destination.sourceChannel === undefined ? patch : { ...patch, sourceChannel: destination.sourceChannel };
    next = addRecordedAudioClip(next, destination.trackId, bufferId, exactStartBar, lengthBars, channelPatch).execute(
      next,
    );
  }
  return snapshot(
    "addRecordedAudioClips",
    destinations.length > 1 ? `Place ${destinations.length} captured channels` : "Place recorded audio",
    doc,
    next,
  );
}

/** Place and select one captured alternate pass at exact transport-tick resolution. */
export function addRecordedAudioTakeClip(
  doc: ProjectDocument,
  groupId: string,
  takeId: string,
  trackId: string,
  bufferId: string,
  startBar: number,
  lengthBars: number,
  patch: Partial<Omit<AudioClip, "id" | "trackId" | "bufferId" | "startBar" | "lengthBars">> = {},
): Command {
  const exactStartBar = Number.isFinite(startBar) ? Math.max(0, Math.round(startBar * BAR_TICKS) / BAR_TICKS) : 0;
  const added = addAudioTakeClip(doc, groupId, takeId, trackId, bufferId, exactStartBar, lengthBars, patch).execute(
    doc,
  );
  const existingIds = new Set((doc.arrangement.audioClips ?? []).map((clip) => clip.id));
  const addedClip = (added.arrangement.audioClips ?? []).find((clip) => !existingIds.has(clip.id));
  if (!addedClip) throw new Error("The recorded audio take could not be created");

  const selected = setActiveAudioTake(added, groupId, takeId).execute(added);
  const exactSelected = {
    ...selected,
    arrangement: {
      ...selected.arrangement,
      audioClips: (selected.arrangement.audioClips ?? []).map((clip) =>
        clip.id === addedClip.id ? { ...clip, startBar: exactStartBar } : clip,
      ),
    },
  };
  return snapshot("addRecordedAudioTakeClip", "Add and select recorded take", doc, exactSelected);
}

export interface RecordedLoopPass {
  takeId: string;
  startFrame: number;
  endFrame: number;
  lengthBars: number;
}

/** Recover validated, non-empty pass windows from durable capture-frame markers. */
export function recordedLoopPasses(
  totalFrames: number,
  sampleRate: number,
  boundaries: readonly number[] | undefined,
  bpm: number,
  sessionId: string,
): RecordedLoopPass[] {
  if (!Number.isSafeInteger(totalFrames) || totalFrames <= 0 || !Number.isInteger(sampleRate) || sampleRate <= 0)
    return [];
  const validBoundaries = (boundaries ?? []).filter(
    (frame) => Number.isSafeInteger(frame) && frame > 0 && frame <= totalFrames,
  );
  const points = [0, ...validBoundaries.filter((frame) => frame < totalFrames), totalFrames].sort((a, b) => a - b);
  const uniquePoints = points.filter((frame, index) => index === 0 || frame !== points[index - 1]);
  const minimumFrames = Math.ceil(secondsPerBar(bpm) * 0.25 * sampleRate);
  const passes: RecordedLoopPass[] = [];
  for (let index = 0; index + 1 < uniquePoints.length; index++) {
    const startFrame = uniquePoints[index]!;
    const endFrame = uniquePoints[index + 1]!;
    const durationSec = (endFrame - startFrame) / sampleRate;
    const lengthBars = durationSec / secondsPerBar(bpm);
    if (endFrame - startFrame < minimumFrames || !Number.isFinite(lengthBars) || lengthBars < 0.25) continue;
    passes.push({ takeId: `${sessionId}-pass-${passes.length + 1}`, startFrame, endFrame, lengthBars });
  }
  return passes;
}

/** Place every captured loop pass as a selectable, non-destructive alternate in one undo step. */
export function addRecordedLoopTakeClips(
  doc: ProjectDocument,
  groupId: string,
  trackId: string,
  bufferId: string,
  startBar: number,
  sampleRate: number,
  totalFrames: number,
  passes: readonly RecordedLoopPass[],
  patch: Partial<Omit<AudioClip, "id" | "trackId" | "bufferId" | "startBar" | "lengthBars">> = {},
): Command {
  if (passes.length === 0) throw new Error("No complete loop passes were captured");
  if (!Number.isInteger(sampleRate) || sampleRate <= 0 || !Number.isSafeInteger(totalFrames) || totalFrames <= 0) {
    throw new Error("Invalid loop recording format");
  }
  const exactStartBar = Number.isFinite(startBar) ? Math.max(0, startBar) : 0;
  let next = doc;
  let activeTakeId = "";
  for (const pass of passes) {
    if (
      !Number.isSafeInteger(pass.startFrame) ||
      !Number.isSafeInteger(pass.endFrame) ||
      pass.startFrame < 0 ||
      pass.endFrame <= pass.startFrame ||
      pass.endFrame > totalFrames ||
      !pass.takeId
    ) {
      throw new Error("Invalid captured loop pass");
    }
    const lengthBars = pass.lengthBars;
    if (lengthBars < 0.25) continue;
    const previousIds = new Set((next.arrangement.audioClips ?? []).map((clip) => clip.id));
    next = addAudioTakeClip(next, groupId, pass.takeId, trackId, bufferId, exactStartBar, lengthBars, {
      ...patch,
      offsetSec: pass.startFrame / sampleRate,
      trimEnd: (totalFrames - pass.endFrame) / sampleRate,
    }).execute(next);
    const addedClip = (next.arrangement.audioClips ?? []).find((clip) => !previousIds.has(clip.id));
    if (!addedClip) throw new Error("A recorded loop pass could not be placed on the timeline");
    next = {
      ...next,
      arrangement: {
        ...next.arrangement,
        audioClips: next.arrangement.audioClips?.map((clip) =>
          clip.id === addedClip.id ? { ...clip, startBar: exactStartBar, lengthBars } : clip,
        ),
      },
    };
    activeTakeId = pass.takeId;
  }
  if (!activeTakeId) throw new Error("No complete loop passes were captured");
  const selected = setActiveAudioTake(next, groupId, activeTakeId).execute(next);
  return snapshot("addRecordedLoopTakeClips", `Add ${passes.length} recorded loop passes`, doc, selected);
}

/** Rebuild a recovered loop session as one undoable group-placement command. */
export function addRecordedLoopSession(
  doc: ProjectDocument,
  session: RecordingSession,
  bufferId: string,
  patch: Partial<Omit<AudioClip, "id" | "trackId" | "bufferId" | "startBar" | "lengthBars">> = {},
): Command {
  if (!session.loopCapture || !session.takeGroupId) throw new Error("Loop recording metadata is incomplete");
  const passes = recordedLoopPasses(
    session.totalFrames,
    session.sampleRate,
    session.takeBoundaries,
    session.bpm,
    session.id,
  );
  return addRecordedLoopTakeClips(
    doc,
    session.takeGroupId,
    session.trackId,
    bufferId,
    compensateRecordingStartBar(session.startBar, session.recordingInputOffsetMs ?? 0, session.bpm),
    session.sampleRate,
    session.totalFrames,
    passes,
    patch,
  );
}

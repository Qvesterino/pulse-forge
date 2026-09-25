/**
 * Timeline recording helpers — the placement math for mic takes recorded
 * straight onto an armed arrangement track. Pure, so the tests cover the
 * math without a microphone.
 */
import { BAR_TICKS } from "../project-model/types";
import type { AudioClip, ProjectDocument } from "../project-model/types";
import type { RecordingChannelDestination } from "../persistence/RecordingRecoveryRepository";
import { addAudioClip, snapshot } from "../commands/commands";
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

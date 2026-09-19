/**
 * Timeline recording helpers — the placement math for mic takes recorded
 * straight onto an armed arrangement track. Pure, so the tests cover the
 * math without a microphone.
 */
import { BAR_TICKS } from "../project-model/types";
import type { AudioClip, ProjectDocument } from "../project-model/types";
import { addAudioClip } from "../commands/commands";
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

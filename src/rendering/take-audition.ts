import type { ProjectDocument } from "../project-model/types";
import { BAR_TICKS } from "../project-model/types";
import { buildTempoMap, type ClipWindow } from "./renderer";

/**
 * Build an ephemeral, non-persistent project for auditioning one take lane.
 * It keeps the selected audio pass and its track/group signal path, mutes all
 * unrelated tracks, clears note content and markers, and leaves the source
 * document untouched. Relevant scene clips remain as a tempo map. The normal
 * offline renderer then supplies track FX and sends for the audition buffer.
 */
export function createAudioTakeAuditionDoc(doc: ProjectDocument, groupId: string, takeId: string): ProjectDocument {
  const group = doc.arrangement.takeGroups?.find((candidate) => candidate.id === groupId);
  if (!group) throw new Error(`Audio take group ${groupId} not found`);
  const clips = (doc.arrangement.audioClips ?? []).filter(
    (clip) => clip.takeGroupId === groupId && clip.takeId === takeId && clip.trackId === group.trackId,
  );
  if (clips.length === 0) throw new Error(`Audio take ${takeId} has no clips in group ${groupId}`);
  const endBar = Math.max(...clips.map((clip) => clip.startBar + clip.lengthBars));
  const tempoClips = doc.arrangement.clips
    .filter((clip) => clip.startBar < endBar)
    .map((clip) => {
      const lengthBars = Math.min(clip.startBar + clip.lengthBars, endBar) - clip.startBar;
      return lengthBars === clip.lengthBars ? clip : { ...clip, lengthBars };
    });

  const tracksById = new Map(doc.tracks.map((track) => [track.id, track]));
  const audibleTrackIds = new Set<string>();
  let current = tracksById.get(group.trackId);
  while (current && !audibleTrackIds.has(current.id)) {
    audibleTrackIds.add(current.id);
    const parentGroupId = current.kind === "group" ? undefined : current.groupId;
    current = parentGroupId ? tracksById.get(parentGroupId) : undefined;
  }
  if (!tracksById.has(group.trackId)) throw new Error(`Audio take group ${groupId} has no track`);

  return {
    ...doc,
    patterns: doc.patterns.map((pattern) => ({ ...pattern, rows: {}, notes: {} })),
    tracks: doc.tracks.map((track) => ({
      ...track,
      mute: !audibleTrackIds.has(track.id),
      solo: false,
    })),
    markers: [],
    arrangement: {
      ...doc.arrangement,
      clips: tempoClips,
      audioClips: clips,
      takeGroups: [{ ...group, activeTakeId: takeId }],
      transitions: [],
    },
  };
}

/** Build a runtime-only take audition anchored at the live song playhead. */
export function createLiveAudioTakeAuditionProject(
  doc: ProjectDocument,
  groupId: string,
  takeId: string,
  playheadTick: number,
): { project: ProjectDocument; resumedAudioClipOffsets: ReadonlyMap<string, number> } {
  if (!Number.isFinite(playheadTick)) throw new Error("Take audition playhead must be finite");
  const playhead = Math.max(0, playheadTick);
  const project = createAudioTakeAuditionDoc(doc, groupId, takeId);
  const tempoMap = buildTempoMap(doc, takeTempoWindows(doc));
  const resumedAudioClipOffsets = new Map<string, number>();
  const liveClips = (project.arrangement.audioClips ?? []).flatMap((clip) => {
    const clipStartTick = clip.startBar * BAR_TICKS;
    const clipEndTick = clipStartTick + clip.lengthBars * BAR_TICKS;
    if (clipEndTick <= playhead + 1e-6) return [];
    if (clipStartTick >= playhead - 1e-6) return [clip];

    const stretchRate = clip.stretchRate ?? 1;
    if (
      clip.reverse ||
      clip.loop ||
      (clip.stretchMode === "stretch" && Math.abs(stretchRate - 1) >= 0.01) ||
      (clip.warpMarkers?.length ?? 0) > 0
    ) {
      throw new Error(
        "Stop transport to audition a take that is already playing in reverse, loop, stretch, or warp mode",
      );
    }

    const elapsedSec = Math.max(0, tempoMap.timeAt(playhead) - tempoMap.timeAt(clipStartTick));
    resumedAudioClipOffsets.set(clip.id, elapsedSec);
    return [
      {
        ...clip,
        startBar: playhead / BAR_TICKS,
        lengthBars: (clipEndTick - playhead) / BAR_TICKS,
        offsetSec: Math.max(0, (clip.offsetSec ?? 0) + elapsedSec * stretchRate),
      },
    ];
  });

  if (liveClips.length === 0) throw new Error("The selected take has no audio at or after the current playhead");
  return {
    project: {
      ...project,
      arrangement: {
        ...project.arrangement,
        // Keep the entire song timeline and scene-tempo map for live playback;
        // offline audition can safely trim this list to the lane's end.
        clips: doc.arrangement.clips,
        audioClips: liveClips,
      },
    },
    resumedAudioClipOffsets,
  };
}

function takeTempoWindows(doc: ProjectDocument): ClipWindow[] {
  return doc.arrangement.clips.flatMap((clip) => {
    const scene = doc.scenes.find((candidate) => candidate.id === clip.sceneId);
    const pattern = scene ? doc.patterns.find((candidate) => candidate.id === scene.patternId) : undefined;
    if (!scene || !pattern) return [];
    const from = clip.startBar * BAR_TICKS;
    return [
      {
        pattern,
        base: from,
        from,
        to: (clip.startBar + clip.lengthBars) * BAR_TICKS,
        bpm: scene.bpm ?? doc.bpm,
        sceneId: scene.id,
      },
    ];
  });
}

/** Wall-clock start of a take lane using the project's piecewise scene tempo. */
export function audioTakeAuditionStartOffsetSec(doc: ProjectDocument, groupId: string, takeId: string): number {
  const group = doc.arrangement.takeGroups?.find((candidate) => candidate.id === groupId);
  if (!group) throw new Error(`Audio take group ${groupId} not found`);
  const clips = (doc.arrangement.audioClips ?? []).filter(
    (clip) => clip.takeGroupId === groupId && clip.takeId === takeId && clip.trackId === group.trackId,
  );
  if (clips.length === 0) throw new Error(`Audio take ${takeId} has no clips in group ${groupId}`);
  const startTick = Math.min(...clips.map((clip) => clip.startBar * BAR_TICKS));
  return buildTempoMap(doc, takeTempoWindows(doc)).timeAt(startTick);
}

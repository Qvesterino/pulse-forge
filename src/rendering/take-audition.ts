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

/** Wall-clock start of a take lane using the project's piecewise scene tempo. */
export function audioTakeAuditionStartOffsetSec(doc: ProjectDocument, groupId: string, takeId: string): number {
  const group = doc.arrangement.takeGroups?.find((candidate) => candidate.id === groupId);
  if (!group) throw new Error(`Audio take group ${groupId} not found`);
  const clips = (doc.arrangement.audioClips ?? []).filter(
    (clip) => clip.takeGroupId === groupId && clip.takeId === takeId && clip.trackId === group.trackId,
  );
  if (clips.length === 0) throw new Error(`Audio take ${takeId} has no clips in group ${groupId}`);
  const startTick = Math.min(...clips.map((clip) => clip.startBar * BAR_TICKS));
  const windows: ClipWindow[] = doc.arrangement.clips.flatMap((clip) => {
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
  return buildTempoMap(doc, windows).timeAt(startTick);
}

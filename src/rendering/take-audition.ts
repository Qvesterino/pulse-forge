import type { ProjectDocument } from "../project-model/types";

/**
 * Build an ephemeral, non-persistent project for auditioning one take lane.
 * It keeps the selected audio pass and its track/group signal path, mutes all
 * unrelated tracks, removes song material and markers, and leaves the source
 * document untouched. The normal offline renderer then supplies track FX,
 * sends and master processing for the audition buffer.
 */
export function createAudioTakeAuditionDoc(doc: ProjectDocument, groupId: string, takeId: string): ProjectDocument {
  const group = doc.arrangement.takeGroups?.find((candidate) => candidate.id === groupId);
  if (!group) throw new Error(`Audio take group ${groupId} not found`);
  const clips = (doc.arrangement.audioClips ?? []).filter(
    (clip) => clip.takeGroupId === groupId && clip.takeId === takeId && clip.trackId === group.trackId,
  );
  if (clips.length === 0) throw new Error(`Audio take ${takeId} has no clips in group ${groupId}`);

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
      clips: [],
      audioClips: clips,
      takeGroups: [{ ...group, activeTakeId: takeId }],
      transitions: [],
    },
    sceneAutomation: [],
  };
}

import type { Arrangement, AudioClip } from "./types";

/**
 * Return only the selected whole-take pass for groups. Ungrouped clips and
 * clips whose group metadata is stale stay audible so damaged optional take
 * metadata can never silently erase ordinary timeline audio.
 */
export function audioClipsForPlayback(arrangement: Pick<Arrangement, "audioClips" | "takeGroups">): AudioClip[] {
  const groups = new Map((arrangement.takeGroups ?? []).map((group) => [group.id, group]));
  return (arrangement.audioClips ?? []).filter((clip) => {
    // Clip-level mute (B3): filtered HERE so the scheduler, the offline
    // render and the live-editing resume all agree through one choke point —
    // muting cannot diverge between live and exported audio.
    if (clip.muted) return false;
    if (!clip.takeGroupId || !clip.takeId) return true;
    const group = groups.get(clip.takeGroupId);
    if (!group || group.trackId !== clip.trackId) return true;
    return clip.takeId === group.activeTakeId;
  });
}

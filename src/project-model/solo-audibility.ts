import type { ProjectDocument } from "./types";
import { getDocIndex } from "./doc-index";

/**
 * THE audibility rule — one owner, three consumers.
 *
 * Solo-bus semantics for a project. Any solo anywhere mutes unsoloed
 * material; a group is audible when it — or any of its members — is soloed;
 * a member is audible when it — or the group it feeds — is soloed. (Before
 * this rule, soloing a child inside a group muted the group itself, so the
 * soloed child was inaudible too.)
 *
 * WHY THIS LIVES IN THE MODEL LAYER: the rule is a fact about the DOCUMENT
 * (which tracks are audible), not about the audio graph. Three subsystems need
 * it and they must agree:
 *
 *   - the mixer (src/audio-engine/AudioEngine.ts) — zeroes the gain of an
 *     inaudible track,
 *   - the drum scheduler (src/project-model/groove.ts) — decides whether a
 *     drum track's hits are scheduled at all,
 *   - and the group commands (src/commands/tracks.ts) — which must NOT
 *     rewrite member state to express a group solo.
 *
 * It used to live in the engine only, so groove.ts carried its own, group-
 * UNaware copy ("any solo and this track is not soloed → drop its hits"). The
 * two copies disagreed for group members, and the gap was bridged by
 * addToGroup writing `solo: true` onto every member of a soloed group — a
 * state write that was never released, so un-soloing the group left the
 * member soloed and silenced the whole project.
 */
export interface SoloAudibility {
  anySolo: boolean;
  audible(trackId: string): boolean;
}

export function soloAudibility(doc: ProjectDocument): SoloAudibility {
  const tracks = doc.tracks;
  // The track lookup is a MAP, not a scan. This rule is consulted once per
  // track on every document change (the mixer, the drum scheduler and the
  // group commands all read it), so a `tracks.find` per consultation made
  // one edit cost O(T²) — the measured quadratic of the performance-cliff
  // audit. The index keeps the ANSWER identical: `indexById` keeps the first
  // match, which is exactly what `tracks.find` returned.
  const tracksById = getDocIndex(doc).tracksById;
  const anySolo = tracks.some((t) => t.solo);
  const soloedGroups = new Set(tracks.filter((t) => t.kind === "group" && t.solo).map((t) => t.id));
  const groupsWithSoloedChild = new Set<string>();
  for (const t of tracks) {
    if (t.kind !== "group" && t.solo && t.groupId) groupsWithSoloedChild.add(t.groupId);
  }
  return {
    anySolo,
    audible(trackId: string): boolean {
      const t = tracksById.get(trackId);
      if (!t) return false;
      // Group mute silences its members — 1 gesture mutes 8 tracks
      if (t.kind !== "group" && t.groupId) {
        const g = tracksById.get(t.groupId);
        if (g && g.mute) return false;
      }
      if (t.kind === "group") {
        return !t.mute && (!anySolo || t.solo || groupsWithSoloedChild.has(t.id));
      }
      return !t.mute && (!anySolo || t.solo || (t.groupId != null && soloedGroups.has(t.groupId)));
    },
  };
}

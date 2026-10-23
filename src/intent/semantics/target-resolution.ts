/**
 * TARGET RESOLUTION — families + explicit tracks + an ordinal, in one place.
 *
 * `MixTarget` intents historically addressed only families. Ordinal targeting
 * ("track two") is an explicit track id, so every consumer (apply, read-back,
 * plan) must resolve the same union in the same order. This helper is that
 * one place.
 */
import type { ProjectDocument } from "../../project-model/types";
import { trackIdsForTarget } from "../conversation";
import type { FamilyTargetId } from "./target-registry";

export function targetTrackIds(
  doc: ProjectDocument,
  targets: readonly FamilyTargetId[],
  trackIds?: readonly string[],
  trackOrdinal?: number,
): string[] {
  const ids = new Set<string>();
  for (const target of targets) {
    for (const trackId of trackIdsForTarget(doc, target)) ids.add(trackId);
  }
  for (const trackId of trackIds ?? []) {
    if (doc.tracks.some((track) => track.id === trackId)) ids.add(trackId);
  }
  if (trackOrdinal != null) {
    const track = doc.tracks.filter((candidate) => candidate.kind !== "group")[trackOrdinal];
    if (track) ids.add(track.id);
  }
  return [...ids];
}

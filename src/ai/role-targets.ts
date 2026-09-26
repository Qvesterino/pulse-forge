import type { InstrumentTrack, ProjectDocument, Track } from "../project-model/types";

/** Melodic generator lanes and their stable fallback order. */
export type MelodicRole = "bass" | "chord" | "lead";

const MELODIC_ROLE_INDEX: Readonly<Record<MelodicRole, number>> = { bass: 0, chord: 1, lead: 2 };

/** Resolve the instrument tracks visible to the generator. */
export function instrumentTargets(doc: ProjectDocument, targetTrackIds?: readonly string[]): InstrumentTrack[] {
  const instrumentTracks = doc.tracks.filter((track): track is InstrumentTrack => track.kind === "instrument");
  return targetTrackIds && targetTrackIds.length > 0
    ? instrumentTracks.filter((track) => targetTrackIds.includes(track.id))
    : instrumentTracks;
}

/**
 * Resolve one melodic lane to the same track for generation, preserve and UI
 * explanation. Explicit name matches win; old projects retain the generator's
 * deterministic positional fallback.
 */
export function instrumentTrackForRole(
  doc: ProjectDocument,
  role: MelodicRole,
  targetTrackIds?: readonly string[],
): InstrumentTrack | null {
  const tracks = instrumentTargets(doc, targetTrackIds);
  if (tracks.length === 0) return null;
  const named = tracks.find((track) => track.name.toLowerCase().includes(role));
  return named ?? tracks[MELODIC_ROLE_INDEX[role] % tracks.length] ?? null;
}

/** Drum generation and drum preservation must resolve one identical target. */
export function drumTrackForTarget(
  doc: ProjectDocument,
  targetTrackId?: string,
): Extract<Track, { kind: "drum" }> | null {
  const drumTracks = doc.tracks.filter((track): track is Extract<Track, { kind: "drum" }> => track.kind === "drum");
  if (targetTrackId) return drumTracks.find((track) => track.id === targetTrackId) ?? drumTracks[0] ?? null;
  return drumTracks[0] ?? null;
}

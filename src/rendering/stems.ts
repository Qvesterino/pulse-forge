import type { ProjectDocument, Track } from "../project-model/types";

export interface StemGroup {
  id: string;
  label: string;
  filter: (track: Track) => boolean;
}

export const STEM_GROUPS: StemGroup[] = [
  { id: "drums", label: "Drums", filter: (t) => t.kind === "drum" },
  {
    id: "bass",
    label: "Bass",
    filter: (t) => t.kind === "instrument" && (t.instrument === "bass" || t.instrument === "808"),
  },
  {
    id: "music",
    label: "Music",
    filter: (t) => t.kind === "instrument" && (t.instrument === "analog" || t.instrument === "sampler"),
  },
];

export function buildStemProject(doc: ProjectDocument, filter: (track: Track) => boolean): ProjectDocument {
  // Collect tracks matching the filter PLUS any parent GroupTrack they feed —
  // otherwise stems bypass group gain/pan/FX and don't sum to the mix.
  // The offline renderer needs the group in the doc for routing, just like
  // track-renderer.ts does for frozen-track renders.
  const matched = doc.tracks.filter(filter);
  const groupIds = new Set(
    matched
      .map((t) => (t as { groupId?: string }).groupId)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
  const parents = doc.tracks.filter((t) => t.kind === "group" && groupIds.has(t.id));
  const kept = new Map<string, Track>();
  for (const t of [...matched, ...parents]) {
    // Audit 11 D2: stems are deliverables for re-balancing in another DAW —
    // live-session MUTE (like solo) must not bake a silent, "successful"
    // stem. The engine silences muted tracks/groups, so preserving mute
    // zeroed whole stems while the export still reported success.
    if (!kept.has(t.id)) kept.set(t.id, { ...t, solo: false, mute: false } as Track);
  }
  // Deterministic order — same as the original doc.
  const ordered = doc.tracks.filter((t) => kept.has(t.id)).map((t) => kept.get(t.id)!);
  return { ...doc, tracks: ordered };
}

export function nonEmptyStemGroups(doc: ProjectDocument): StemGroup[] {
  return STEM_GROUPS.filter((group) => doc.tracks.some(group.filter));
}

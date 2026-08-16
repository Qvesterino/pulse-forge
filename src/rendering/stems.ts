import type { ProjectDocument, Track } from "../project-model/types";

export interface StemGroup {
  id: string;
  label: string;
  filter: (track: Track) => boolean;
}

export const STEM_GROUPS: StemGroup[] = [
  { id: "drums", label: "Drums", filter: (t) => t.kind === "drum" },
  { id: "bass", label: "Bass", filter: (t) => t.kind === "instrument" && (t.instrument === "bass" || t.instrument === "808") },
  { id: "music", label: "Music", filter: (t) => t.kind === "instrument" && (t.instrument === "analog" || t.instrument === "sampler") },
];

export function buildStemProject(doc: ProjectDocument, filter: (track: Track) => boolean): ProjectDocument {
  return {
    ...doc,
    tracks: doc.tracks.filter(filter).map((track) => ({ ...track, solo: false })),
  };
}

export function nonEmptyStemGroups(doc: ProjectDocument): StemGroup[] {
  return STEM_GROUPS.filter((group) => doc.tracks.some(group.filter));
}

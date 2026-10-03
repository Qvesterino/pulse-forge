import type { EffectInstance, ProjectDocument } from "../project-model/types";

/**
 * Document-shape helpers shared by more than one command domain.
 *
 * This module is deliberately NOT re-exported wholesale from the commands barrel: everything
 * here is plumbing that happens to be pure, not part of the command surface. `trackEffectsOf` is
 * the one exception and the barrel re-exports it by name, so the public surface stays identical.
 *
 * The reason this file exists: the engine is split by domain behind src/commands/commands.ts, and
 * these two helpers are the access path into a track's effect chain from four different domains
 * (effects, the per-plugin panels, and pattern assist). Without a shared home each of those
 * modules would have to import from the barrel, and the barrel imports them - a cycle.
 */

/** Apply `fn` to one track's effect chain, leaving every other track untouched. */
export function withTrackEffects(
  doc: ProjectDocument,
  trackId: string,
  fn: (effects: EffectInstance[]) => EffectInstance[],
): ProjectDocument {
  return {
    ...doc,
    tracks: doc.tracks.map((t) => (t.id === trackId && "effects" in t ? { ...t, effects: fn(t.effects) } : t)),
  };
}

/** A track's effect chain, or an empty list for tracks that carry none. */
export function trackEffectsOf(doc: ProjectDocument, trackId: string): EffectInstance[] {
  const track = doc.tracks.find((t) => t.id === trackId);
  return track && "effects" in track ? track.effects : [];
}

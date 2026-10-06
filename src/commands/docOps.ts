import {
  MASTER_EFFECT_OWNER_ID,
  type EffectInstance,
  type Marker,
  type Pattern,
  type ProjectDocument,
} from "../project-model/types";
import { BAR_TICKS, STEP_TICKS } from "../project-model/types";

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
  if (trackId === MASTER_EFFECT_OWNER_ID) {
    return { ...doc, master: { ...doc.master, effects: fn(doc.master.effects ?? []) } };
  }
  return {
    ...doc,
    tracks: doc.tracks.map((t) => (t.id === trackId && "effects" in t ? { ...t, effects: fn(t.effects) } : t)),
  };
}

/** A track's effect chain, or an empty list for tracks that carry none. */
export function trackEffectsOf(doc: ProjectDocument, trackId: string): EffectInstance[] {
  if (trackId === MASTER_EFFECT_OWNER_ID) return doc.master.effects ?? [];
  const track = doc.tracks.find((t) => t.id === trackId);
  return track && "effects" in track ? track.effects : [];
}

/**
 * Deep-copy a pattern's per-step metadata.
 *
 * A StepMeta entry is a two-level record (pad -> step -> meta), so a shallow
 * `{ ...meta }` would leave lanes sharing nested lock objects with the pattern
 * they were cloned from. Shared locks would then be mutated by two commands at
 * once and undo would only half-restore.
 */
export function cloneStepMeta(meta: Pattern["stepMeta"]): Pattern["stepMeta"] {
  if (!meta) return undefined;
  return Object.fromEntries(
    Object.entries(meta).map(([padId, steps]) => [
      padId,
      Object.fromEntries(
        Object.entries(steps).map(([step, m]) => [step, { ...m, ...(m.locks ? { locks: { ...m.locks } } : {}) }]),
      ),
    ]),
  );
}

/**
 * Clear `linkedClipId` on markers whose linked clip is going away.
 *
 * The link promises "tied to this clip" (Marker.linkedClipId doc): after a
 * delete the stale id survived every save (schema keeps any string) and the
 * scheduler silently fell back to the global preview bus. Unlink INSIDE the
 * delete command — same contract as stripDanglingEffectReferences (Audit 05
 * D1) — so undo restores the link together with the clip. Returns undefined
 * when nothing changed, so callers avoid needless clones.
 */
export function unlinkMarkersOfClips(markers: Marker[], removedClipIds: Set<string>): Marker[] | undefined {
  if (markers.length === 0 || removedClipIds.size === 0) return undefined;
  let changed = false;
  const next = markers.map((m) => {
    if (!m.linkedClipId || !removedClipIds.has(m.linkedClipId)) return m;
    changed = true;
    return { ...m, linkedClipId: undefined };
  });
  return changed ? next : undefined;
}

/**
 * Audit 08 D3: mirror normalize's marker clamp so an arrangement shrink
 * records marker moves INSIDE the command delta - otherwise undo of the
 * shrink restored the clips but the markers stayed clamped to the shrunken
 * end. Returns a `{ markers }` patch only when something actually moved.
 */
export function markerClampPatch(
  markers: Marker[],
  scenes: ProjectDocument["scenes"],
  patterns: ProjectDocument["patterns"],
  arrangement: ProjectDocument["arrangement"],
): Partial<ProjectDocument> {
  if (markers.length === 0) return {};
  const totalProjectTicks = Math.max(
    0,
    ...scenes.map((sc) => (patterns.find((p) => p.id === sc.patternId)?.stepCount ?? 0) * STEP_TICKS),
    ...(arrangement.clips?.map((c) => (c.startBar + c.lengthBars) * BAR_TICKS) ?? []),
  );
  let changed = false;
  const clamped = markers.map((m) => {
    if (m.tick <= totalProjectTicks) return m;
    changed = true;
    return { ...m, tick: totalProjectTicks };
  });
  return changed ? { markers: clamped } : {};
}

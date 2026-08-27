/**
 * Y.Doc command utilities — helper functions for applying command mutations
 * directly to a Y.Doc. Used by commands that implement applyToYDoc/undoYDoc.
 */
import * as Y from "yjs";

// ─── Pattern Operations ─────────────────────────────────────────────────────

/** Toggle a step in a pattern's drum row. */
export function yToggleStep(
  yMap: Y.Map<unknown>,
  patternId: string,
  padId: string,
  stepIndex: number,
): void {
  const patterns = yMap.get("patterns") as Y.Array<unknown>;
  const pattern = findPattern(patterns, patternId);
  if (!pattern) return;
  const rows = pattern.get("rows") as Y.Map<unknown>;
  let row = rows.get(padId) as Y.Array<number> | undefined;
  if (!row) {
    if (stepIndex !== 0) return; // a fresh row can only hold index 0
    row = new Y.Array<number>();
    rows.set(padId, row);
  }
  // A peer may have shrunk the pattern while this gesture was in flight —
  // yjs transactions have no rollback, so an out-of-range write would throw
  // straight through store.execute. Clamp to a no-op instead.
  if (stepIndex >= row.length || stepIndex < 0) return;
  const current = row.get(stepIndex) ?? 0;
  row.delete(stepIndex, 1);
  row.insert(stepIndex, [current > 0 ? 0 : 0.8]);
}

/** Set velocity for a specific step. */
export function ySetStepVelocity(
  yMap: Y.Map<unknown>,
  patternId: string,
  padId: string,
  stepIndex: number,
  velocity: number,
): void {
  const patterns = yMap.get("patterns") as Y.Array<unknown>;
  const pattern = findPattern(patterns, patternId);
  if (!pattern) return;
  const rows = pattern.get("rows") as Y.Map<unknown>;
  let row = rows.get(padId) as Y.Array<number> | undefined;
  if (!row) {
    row = new Y.Array<number>();
    rows.set(padId, row);
  }
  if (stepIndex < row.length) {
    row.delete(stepIndex, 1);
    row.insert(stepIndex, [velocity]);
  }
}

/** Set a scalar field on a pattern. */
export function ySetPatternField(
  yMap: Y.Map<unknown>,
  patternId: string,
  field: string,
  value: unknown,
): void {
  const patterns = yMap.get("patterns") as Y.Array<unknown>;
  const pattern = findPattern(patterns, patternId);
  if (pattern) pattern.set(field, value);
}

// ─── Track Operations ───────────────────────────────────────────────────────

/** Set a scalar field on a track. */
export function ySetTrackField(
  yMap: Y.Map<unknown>,
  trackId: string,
  field: string,
  value: unknown,
): void {
  const tracks = yMap.get("tracks") as Y.Array<unknown>;
  const track = findTrack(tracks, trackId);
  if (track) track.set(field, value);
}

// ─── Scalar Operations ──────────────────────────────────────────────────────

/** Set a top-level scalar field on the project. */
export function ySetProjectField(
  yMap: Y.Map<unknown>,
  field: string,
  value: unknown,
): void {
  yMap.set(field, value);
}

// ─── Finders ────────────────────────────────────────────────────────────────

function findPattern(patterns: Y.Array<unknown>, patternId: string): Y.Map<unknown> | undefined {
  for (let i = 0; i < patterns.length; i++) {
    const p = patterns.get(i) as Y.Map<unknown>;
    if (p.get("id") === patternId) return p;
  }
  return undefined;
}

function findTrack(tracks: Y.Array<unknown>, trackId: string): Y.Map<unknown> | undefined {
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks.get(i) as Y.Map<unknown>;
    if (t.get("id") === trackId) return t;
  }
  return undefined;
}

import { uid } from "../shared/ids";
import type { NoteEvent, Pattern } from "../project-model/types";

/**
 * Ghost morph — crossfade between two takes of a pattern (the "time machine"
 * slider: A ⟷ B).
 *
 * - Drum `rows` (continuous 0..1 step values) interpolate exactly — ghost
 *   notes fade in smoothly, so the slider feels like a crossfader.
 * - Melodic `notes` match by `pitch:start`: matched notes lerp velocity +
 *   duration; unmatched notes switch at the midpoint (documented, no fake
 *   glissandi). Morphed notes get fresh ids (collision-safe when the result
 *   coexists with its parents in the version stack).
 * - Discrete state (`stepMeta`, `phrasePlan`, provenance) follows the nearer
 *   side — a morph is a blend, not a new generation.
 *
 * Pure, total for equal-length patterns; returns `null` when the step counts
 * differ (morphing across lengths is a re-arrange, not a crossfade) and never
 * aliases its inputs.
 */

const MIDPOINT = 0.5;

function clampT(t: number): number {
  if (typeof t !== "number" || Number.isNaN(t)) return 0;
  return Math.max(0, Math.min(1, t));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function noteKey(note: Pick<NoteEvent, "pitch" | "start">): string {
  return `${note.pitch}:${note.start}`;
}

function cloneNote(note: NoteEvent): NoteEvent {
  return {
    ...note,
    id: uid("note"),
    locks: note.locks ? { ...note.locks } : undefined,
  };
}

/**
 * Blend two patterns at position `t` (0 = A, 1 = B). Returns a fresh pattern
 * (inputs untouched) or `null` for mismatched step counts.
 */
export function morphPatterns(a: Pattern, b: Pattern, t: number): Pattern | null {
  const k = clampT(t);
  if (a.stepCount !== b.stepCount) return null;
  const stepCount = a.stepCount;

  // ── rows: exact per-step lerp over the pad union ──
  const pads = new Set([...Object.keys(a.rows), ...Object.keys(b.rows)]);
  const rows: Pattern["rows"] = {};
  for (const pad of pads) {
    const rowA = a.rows[pad] ?? [];
    const rowB = b.rows[pad] ?? [];
    const out: number[] = new Array<number>(stepCount);
    for (let i = 0; i < stepCount; i++) {
      const va = rowA[i] ?? 0;
      const vb = rowB[i] ?? 0;
      out[i] = va === 0 && vb === 0 ? 0 : round3(va * (1 - k) + vb * k);
    }
    rows[pad] = out;
  }

  // ── notes: matched lerp, unmatched midpoint switch ──
  const notesA = Object.values(a.notes).flat();
  const notesB = Object.values(b.notes).flat();
  const byKeyB = new Map(notesB.map((n) => [noteKey(n), n]));
  const consumedB = new Set<string>();
  const morphed: NoteEvent[] = [];
  for (const na of notesA) {
    const key = noteKey(na);
    const nb = byKeyB.get(key);
    if (nb && !consumedB.has(key)) {
      // First pairing wins on duplicate keys; extras fall to midpoint rule.
      consumedB.add(key);
      morphed.push({
        ...cloneNote(k < MIDPOINT ? na : nb),
        pitch: na.pitch,
        start: na.start,
        duration: Math.max(1, Math.round(na.duration * (1 - k) + nb.duration * k)),
        velocity: round3(na.velocity * (1 - k) + nb.velocity * k),
        slide: k < MIDPOINT ? na.slide : nb.slide,
      });
    } else if (k < MIDPOINT) {
      morphed.push(cloneNote(na));
    }
  }
  for (const nb of notesB) {
    if (consumedB.has(noteKey(nb))) continue;
    if (k >= MIDPOINT) morphed.push(cloneNote(nb));
  }
  const notes: Pattern["notes"] = {};
  for (const n of morphed) {
    notes[n.id] = [n];
  }

  const nearer = k < MIDPOINT ? a : b;
  return {
    ...nearer,
    id: uid("pattern"),
    rows,
    notes,
    stepMeta: nearer.stepMeta ? structuredClone(nearer.stepMeta) : nearer.stepMeta,
    phrasePlan: nearer.phrasePlan ? structuredClone(nearer.phrasePlan) : nearer.phrasePlan,
    name: `${a.name} ⟷ ${b.name} ${Math.round(k * 100)}%`,
  };
}

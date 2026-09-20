/**
 * Gallery intent carry (viral growth plan B1) — "Regenerate with intent".
 *
 * Intent-generated patterns keep their normalized IntentSpec snapshot in
 * `pattern.intent` (provenance, survives publish/share-code round-trips).
 * A gallery beat that carries one can be regenerated in the studio: same
 * character, FRESH seed — the intent engine's answer to "make me another
 * one like this".
 *
 * Pure document math: no store, no UI. The flow is a plain studio link with
 * `?import=<code>&regen=1` — Boot stashes the flag, IntentPanel pulls the
 * snapshot out of the IMPORTED document itself, so nothing rides the URL
 * beyond one marker param.
 */

import { decodeShareCode } from "../export/shareCode";
import type { ProjectDocument } from "../project-model/types";

/** The provenance snapshot a generated pattern carries. */
export type IntentSnapshot = Record<string, unknown>;

/**
 * Pick the most representative intent snapshot from a document: the DROP
 * scene's pattern first (it defines the beat's character), then any pattern
 * carrying provenance. Returns null for beats without engine lineage
 * (hand-programmed or pre-intent projects) — those are not regenerable.
 */
export function intentSnapshotOfDoc(doc: ProjectDocument): IntentSnapshot | null {
  if (!doc || !Array.isArray(doc.patterns)) return null;
  const byId = new Map(doc.patterns.map((p) => [p.id, p] as const));
  const dropScene = doc.scenes?.find((s) => s.role === "drop");
  const ordered: Array<ProjectDocument["patterns"][number] | undefined> = [];
  if (dropScene?.patternId) ordered.push(byId.get(dropScene.patternId));
  ordered.push(...doc.patterns);
  for (const pattern of ordered) {
    const intent = (pattern as { intent?: unknown })?.intent;
    if (intent && typeof intent === "object" && !Array.isArray(intent)) {
      return intent as IntentSnapshot;
    }
  }
  return null;
}

/** Decode a gallery/share code and pull its intent snapshot (client-side). */
export function intentSnapshotOfCode(code: string): IntentSnapshot | null {
  const doc = decodeShareCode(code);
  return doc ? intentSnapshotOfDoc(doc) : null;
}

/** Human-readable one-liner for the IntentPanel field: "trap 140 · energetic". */
export function promptFromIntent(snapshot: IntentSnapshot): string {
  const parts: string[] = [];
  const genre = typeof snapshot.genre === "string" ? snapshot.genre : "";
  if (genre) parts.push(genre);
  if (Array.isArray(snapshot.bpmRange) && snapshot.bpmRange.length === 2) {
    const bpm = Math.round(Number(snapshot.bpmRange[1]));
    if (Number.isFinite(bpm) && bpm > 0) parts.push(String(bpm));
  }
  const energy = typeof snapshot.energy === "number" ? snapshot.energy : null;
  if (energy !== null) {
    if (energy >= 0.75) parts.push("high energy");
    else if (energy <= 0.35) parts.push("chill");
  }
  const mood = typeof snapshot.mood === "string" && snapshot.mood ? snapshot.mood : "";
  if (mood) parts.push(mood);
  return parts.join(" ");
}

/** Fresh seed for a regenerate pass — same character by intent, new take. */
export function freshRegenSeed(): string {
  return `regen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

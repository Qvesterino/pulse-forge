import { assistVary } from "../commands/commands";
import { sanitizeLineage } from "../project-model/schema";
import type { ProjectDocument, ProjectLineage } from "../project-model/types";
import { uid } from "../shared/ids";

/**
 * Remix-DNA family engine — "rodokmeň beatov".
 *
 * Every beat carries its family link in `doc.lineage` (schema v3), so DNA
 * travels inside share codes, not just the gallery sidecar: a child knows
 * its parent doc id, the tree root and its depth. Pure document math —
 * no store, no UI, no server.
 *
 * Two paths create children:
 * - `mutateBeat` (this file): one-click "Mutate 10 %" sibling — same seed
 *   namespace, small deterministic variation, fresh doc id + lineage stamp.
 * - gallery `REMIX` (`remix.ts`): heavier auto-arrange + drop re-roll with
 *   gallery `parentId`. The gallery tree joins both via doc lineage.
 */

/** Default mutate strength (0..1) — a sibling, not a stranger. */
export const MUTATE_AMOUNT = 0.1;
const CHILD_NAME_MAX = 64;

export interface MutateOptions {
  /** Variation strength 0..1 (default 0.1). Clamped. */
  amount?: number;
  /**
   * Sibling index within the family (0 = first child). Callers that know
   * the current child count (gallery `remixCount`) pass it so every child
   * is a distinct deterministic take; same parent + same options = same
   * child content (idempotent mutate).
   */
  sibling?: number;
  /** Display-prompt override for the child's lineage. */
  prompt?: string | null;
}

export interface MutateResult {
  doc: ProjectDocument;
  /** Patterns the variation pass actually rewrote. */
  variedPatterns: number;
  lineage: ProjectLineage;
}

/** Strict lineage read — invalid shapes behave as "no lineage" (pre-v3 beat). */
export function readLineage(doc: ProjectDocument): ProjectLineage | null {
  return sanitizeLineage(doc.lineage) ?? null;
}

/** Display provenance for a family: first pattern carrying intent wins. */
export function familyProvenance(doc: ProjectDocument): { prompt: string | null; seed: string | null } {
  for (const pattern of doc.patterns) {
    const intent = pattern.generation?.intent;
    if (!intent || typeof intent !== "object") continue;
    const record = intent as Record<string, unknown>;
    const prompt = typeof record.text === "string" && record.text.trim() !== "" ? record.text.slice(0, 160) : null;
    const seed = typeof record.seed === "string" && record.seed !== "" ? record.seed.slice(0, 128) : null;
    return { prompt, seed };
  }
  return { prompt: null, seed: null };
}

/** Stamp a root lineage onto a beat that has none (founder of a tree). */
export function ensureRootLineage(doc: ProjectDocument, prompt?: string | null, seed?: string | null): ProjectDocument {
  if (readLineage(doc)) return doc;
  const provenance = familyProvenance(doc);
  const lineage: ProjectLineage = {
    parentId: null,
    rootId: doc.id,
    depth: 0,
    prompt: prompt ?? provenance.prompt,
    seed: seed ?? provenance.seed,
  };
  return { ...doc, lineage };
}

function childNameOf(baseName: string): string {
  const stripped = baseName.replace(/(\s*🧬)+$/u, "").trim() || "Beat";
  const named = `${stripped} 🧬`;
  return named.length > CHILD_NAME_MAX ? `${named.slice(0, CHILD_NAME_MAX - 1)}…` : named;
}

/**
 * Forge one deterministic child from any beat: same seed namespace with a
 * small `assistVary` variation on every pattern, fresh doc id, lineage
 * pointing at the parent. Never throws for content reasons — patterns that
 * cannot vary are skipped and reported via `variedPatterns`.
 */
export function mutateBeat(doc: ProjectDocument, options: MutateOptions = {}): MutateResult {
  const amount = Math.max(0, Math.min(1, typeof options.amount === "number" ? options.amount : MUTATE_AMOUNT));
  const sibling = Math.max(0, Math.floor(typeof options.sibling === "number" ? options.sibling : 0));
  const base = ensureRootLineage(doc);
  const baseLineage = readLineage(base) ?? { parentId: null, rootId: base.id, depth: 0, prompt: null, seed: null };
  const provenance = familyProvenance(base);
  const familySeed = baseLineage.seed ?? provenance.seed ?? base.id;
  const varySeed = `${familySeed}|mutate:${sibling}:${amount}`;

  let varied: ProjectDocument = base;
  let variedPatterns = 0;
  for (const pattern of base.patterns) {
    try {
      varied = assistVary(varied, pattern.id, `${varySeed}:${pattern.id}`, amount).execute(varied);
      variedPatterns += 1;
    } catch {
      /* a pattern that cannot vary stays parental */
    }
  }

  const now = new Date().toISOString();
  const lineage: ProjectLineage = {
    parentId: base.id,
    rootId: baseLineage.rootId,
    depth: baseLineage.depth + 1,
    prompt: options.prompt ?? baseLineage.prompt ?? provenance.prompt,
    seed: familySeed,
  };
  const child: ProjectDocument = {
    ...varied,
    id: uid("project"),
    name: childNameOf(base.name),
    createdAt: now,
    updatedAt: now,
    lineage,
  };
  return { doc: child, variedPatterns, lineage };
}

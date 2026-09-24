import { uid } from "../shared/ids";
import type { Pattern } from "../project-model/types";

/**
 * Ghost versions — the "time machine" stack.
 *
 * Every pattern USE pushes its applied content here (session-scoped,
 * in-memory: ghosts are cheap working takes, the project + undo remain the
 * durable truth). The panel lets producers A/B audition takes and morph
 * between two ghosts with the crossfader (`morph.ts`).
 *
 * Pure push/list/get/remove/clear over a module-level stack capped at
 * GHOST_CAP (oldest evicted); consecutive identical content is deduped so
 * double-USE doesn't ghost twice.
 */

/** Max ghosts kept — newest survive; a full song's takes stay small. */
export const GHOST_CAP = 12;

export interface GhostVersion {
  id: string;
  label: string;
  pattern: Pattern;
  prompt: string | null;
  createdAt: number;
}

let stack: GhostVersion[] = [];

/** Content key for dedupe — ids excluded (fresh ids ≠ new music). */
function contentKey(pattern: Pattern): string {
  const notes = Object.values(pattern.notes)
    .flat()
    .map((n) => `${n.pitch}:${n.start}:${n.duration}:${n.velocity}`)
    .sort()
    .join(",");
  return `${pattern.stepCount}|${JSON.stringify(pattern.rows)}|${notes}`;
}

export function pushGhost(pattern: Pattern, label: string, prompt: string | null): GhostVersion {
  const key = contentKey(pattern);
  const last = stack[stack.length - 1];
  if (last && contentKey(last.pattern) === key) return last;
  const ghost: GhostVersion = { id: uid("ghost"), label, pattern, prompt, createdAt: Date.now() };
  stack = [...stack, ghost].slice(-GHOST_CAP);
  return ghost;
}

export function listGhosts(): readonly GhostVersion[] {
  return [...stack];
}

export function getGhost(id: string): GhostVersion | null {
  return stack.find((g) => g.id === id) ?? null;
}

export function removeGhost(id: string): void {
  stack = stack.filter((g) => g.id !== id);
}

export function clearGhosts(): void {
  stack = [];
}

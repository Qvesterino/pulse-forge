import type { Command } from "./types";
import type { ProjectDocument } from "../project-model/types";
import { applyDocDelta, computeDocDelta, deepEqualRef, deepFreeze } from "./docDelta";

/**
 * The command engine's foundation — `snapshot()` plus the dev-only
 * immutability guard every other command module builds on.
 *
 * Everything in `src/commands/` sits above this file. It has no dependency on
 * any domain module, so the dependency graph starts here and never loops back.
 */

// Immutability enforcement for the delta undo engine. In DEV/test, snapshot()
// deep-freezes `prev`: any command factory (or later code holding the
// reference) that mutates the previous document in place throws a loud
// TypeError immediately, instead of silently corrupting the undo stack.
// In production builds the check is dead-code-eliminated (NODE_ENV=production).
// Implemented as a function (not a module-scope constant) so test environments
// using `vi.stubEnv("NODE_ENV", "production")` can flip it without a re-import.
function isDev(): boolean {
  return process.env.NODE_ENV !== "production";
}

let snapshotVerificationFallbacks = 0;
/** TEST-ONLY: how many snapshot() calls failed delta self-verification and fell back to the legacy whole-document command. */
export function __snapshotVerificationFallbacks(): number {
  return snapshotVerificationFallbacks;
}
/** TEST-ONLY: reset the fallback counter (call at the start of a battery). */
export function __resetSnapshotVerificationFallbacks(): void {
  snapshotVerificationFallbacks = 0;
}

export function snapshot(type: string, label: string, prev: ProjectDocument, next: ProjectDocument): Command {
  // Inverse-patch command: capture the CHANGE (id-anchored operations), not
  // the documents. Functional execute/undo apply the delta to whatever
  // document is current - an async dispatch (seconds-long freeze render,
  // collab merge) can no longer silently revert concurrent edits, and the
  // undo stack no longer pins whole document chains.
  const dev = isDev();
  if (dev) deepFreeze(prev);
  const forward = computeDocDelta(prev, next);
  const backward = computeDocDelta(next, prev);
  // Defect C.5 (performance / memory recon): the legacy verification path
  // runs `applyDocDelta` twice + `deepEqualRef` twice per snapshot() call -
  // four O(changes) traversals per command dispatch, including the hot
  // velocity-layer / step / pattern / track factories that fire many
  // times per second. CI runs with `NODE_ENV !== "production"` so any bug
  // in `computeDocDelta` is caught by the dev-only verifier below; the
  // fallback safety net (legacy whole-document command) is also dev-only.
  // Production builds trust the well-tested delta path and skip both
  // `applyDocDelta` self-checks, cutting the per-snapshot cost by ~50%.
  if (dev) {
    const verified =
      deepEqualRef(applyDocDelta(prev, forward.ops), next) && deepEqualRef(applyDocDelta(next, backward.ops), prev);
    if (!verified) {
      snapshotVerificationFallbacks++;
      return { type, label, execute: () => next, undo: () => prev };
    }
  }
  return {
    type,
    label,
    execute: (d) => applyDocDelta(d, forward.ops),
    undo: (d) => applyDocDelta(d, backward.ops),
  };
}

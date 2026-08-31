/* eslint-disable */
/**
 * VENDORED from VocalForge_DAW/plugins/fxeq. Do not edit by hand — this is a
 * byte-faithful copy of the upstream DSP oracle so Pulse Forge and VocalForge
 * validate against the SAME golden fixtures (tests/fxeq-golden/). Fix DSP
 * issues upstream, then re-vendor via scripts/vendor-fxeq.mjs.
 *
 * Applied transforms (mechanical, semantics-preserving):
 *  - type-only specifiers marked with "type" for verbatimModuleSyntax
 *    (Pulse Forge tsconfig is stricter than upstream).
 */
// ═══════════════════════════════════════════════════════════
// FXEQ — Command history (undo/redo)
//
// Simple undo/redo stack for parameter changes. Each entry records
// the parameter ID and its previous value. Undo restores the old
// value; redo re-applies it.
//
// Usage:
//   history.push("band1.gainDb", oldValue)
//   history.undo() → returns { id, value } or null
//   history.redo() → returns { id, value } or null
// ═══════════════════════════════════════════════════════════

export interface CommandEntry {
  id: string;
  value: number;
}

const MAX_HISTORY = 200;
/**
 * Audit M9: every setParameter used to push an undo entry, so one knob
 * drag (or a host automation curve) flooded the stack with hundreds of
 * entries and user undo became meaningless. Consecutive pushes for the
 * SAME parameter within this window coalesce into the existing entry —
 * the entry keeps the value from BEFORE the interaction, so undo after a
 * drag returns to the pre-drag state in one step.
 */
const COALESCE_MS = 500;

export interface CommandHistory {
  /** Record a parameter change (before applying it). */
  push(id: string, value: number): void;
  /** Undo the last change. Returns the entry to apply, or null. */
  undo(): CommandEntry | null;
  /** Redo the last undone change. Returns the entry to apply, or null. */
  redo(): CommandEntry | null;
  /** Clear all history (e.g., on preset load). */
  clear(): void;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

export function createCommandHistory(): CommandHistory {
  const undoStack: CommandEntry[] = [];
  const redoStack: CommandEntry[] = [];
  /** Last-push time per entry, for the coalescing window. */
  const lastPushAt = new WeakMap<CommandEntry, number>();

  return {
    get canUndo() {
      return undoStack.length > 0;
    },
    get canRedo() {
      return redoStack.length > 0;
    },

    push(id, value) {
      const now = nowMs();
      const top = undoStack[undoStack.length - 1];
      if (top && top.id === id && now - (lastPushAt.get(top) ?? -Infinity) < COALESCE_MS) {
        // Keep the original pre-interaction value; just extend the window.
        lastPushAt.set(top, now);
        redoStack.length = 0;
        return;
      }
      const entry: CommandEntry = { id, value };
      undoStack.push(entry);
      lastPushAt.set(entry, now);
      if (undoStack.length > MAX_HISTORY) {
        const dropped = undoStack.shift();
        if (dropped) lastPushAt.delete(dropped);
      }
      // New action clears the redo stack.
      redoStack.length = 0;
    },

    undo() {
      const entry = undoStack.pop();
      if (!entry) return null;
      redoStack.push(entry);
      return entry;
    },

    redo() {
      const entry = redoStack.pop();
      if (!entry) return null;
      undoStack.push(entry);
      return entry;
    },

    clear() {
      undoStack.length = 0;
      redoStack.length = 0;
    },
  };
}
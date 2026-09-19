/* eslint-disable */
// @ts-nocheck
/**
 * VENDORED from VocalForge_DAW/plugins/ultina. Do not edit by hand — this is
 * a byte-faithful copy of the upstream DSP oracle so Pulse Forge and
 * VocalForge validate against the SAME golden vectors
 * (tests/ultina-vectors.test.ts). Fix DSP issues upstream, then re-vendor
 * via scripts/vendor-ultina.mjs.
 *
 * Applied transforms (mechanical, semantics-preserving):
 *  - type-only specifiers marked with "type" for verbatimModuleSyntax
 *    (Pulse Forge tsconfig is stricter than upstream).
 */
// ═══════════════════════════════════════════════════════════
// Ultina — Module Graph Contract
//
// Defines the reorderable module graph structure. The graph
// is a list of module entries, each with a type, enabled
// state, and its own parameter subset. Users can reorder,
// add, remove, enable, and disable modules via the editor.
//
// The graph is rebuilt on the control thread. The audio thread
// receives a new immutable snapshot via atomic pointer swap.
// ═══════════════════════════════════════════════════════════

import { MODULE_TYPES, type ModuleType, isModuleType } from "./moduleTypes.js";
import { DEFAULT_MODULE_ORDER } from "./state.js";

// ── Module graph entry ─────────────────────────────────────

/**
 * One entry in the module graph. Only one instance of each
 * module type can exist (like Neutron 5).
 */
export interface ModuleGraphEntry {
  /** Module type identifier (eq, comp, gate, etc.). */
  type: ModuleType;
  /** Whether this module is active in the signal chain. */
  enabled: boolean;
}

/**
 * Immutable snapshot of the module graph. This is what the
 * audio thread receives. Once created, it is never mutated.
 */
export interface ModuleGraphSnapshot {
  /** Ordered list of entries. Order = signal flow. */
  entries: readonly ModuleGraphEntry[];
  /** Schema version. */
  version: number;
}

// ── Graph builder ──────────────────────────────────────────

/**
 * Build the default module graph (all modules present, all
 * disabled — user enables what they need).
 */
export function createDefaultModuleGraph(): ModuleGraphEntry[] {
  return DEFAULT_MODULE_ORDER.map((type) => ({
    type: type as ModuleType,
    enabled: false,
  }));
}

/**
 * Create an immutable snapshot from entries.
 * The entries array and each entry object are deep-frozen.
 */
export function createSnapshot(entries: readonly ModuleGraphEntry[], version: number = 1): ModuleGraphSnapshot {
  const frozenEntries = Object.freeze(entries.map((e) => Object.freeze({ ...e })));
  return {
    entries: frozenEntries,
    version,
  };
}

// ── Graph manipulation ─────────────────────────────────────

/**
 * Reorder modules by moving a module from one position to
 * another. Returns a new array (does not mutate input).
 */
export function moveModule(
  entries: readonly ModuleGraphEntry[],
  fromIndex: number,
  toIndex: number,
): ModuleGraphEntry[] {
  if (fromIndex < 0 || fromIndex >= entries.length) return [...entries];
  if (toIndex < 0) return [...entries];

  // Dropping at the end of the rack (toIndex === entries.length) means
  // "insert at the end" — clamp any value above the length.
  const cap = Math.min(toIndex, entries.length);

  const result = entries.map((e) => ({ ...e }));
  const [moved] = result.splice(fromIndex, 1);

  // "Lands at toIndex" semantics — the moved module ends up at the
  // requested index (this is what the drag-drop UI, the tests, and the
  // C++ runtime all expect). Clamp into the post-removal array so
  // dropping at the end of the rack (toIndex === entries.length)
  // inserts at the end.
  const target = Math.max(0, Math.min(cap, result.length));
  result.splice(target, 0, moved);
  return result;
}

/**
 * Toggle a module's enabled state. Returns a new array.
 */
export function toggleModule(entries: readonly ModuleGraphEntry[], moduleType: ModuleType): ModuleGraphEntry[] {
  return entries.map((e) => (e.type === moduleType ? { ...e, enabled: !e.enabled } : e));
}

/**
 * Set a module's enabled state. Returns a new array.
 */
export function setModuleEnabled(
  entries: readonly ModuleGraphEntry[],
  moduleType: ModuleType,
  enabled: boolean,
): ModuleGraphEntry[] {
  return entries.map((e) => (e.type === moduleType ? { ...e, enabled } : e));
}

/**
 * Get the enabled modules in order (the active signal chain).
 */
export function getActiveModules(entries: readonly ModuleGraphEntry[]): ModuleGraphEntry[] {
  return entries.filter((e) => e.enabled);
}

/**
 * Validate a graph. Returns a sanitized version.
 */
export function validateGraph(entries: unknown): ModuleGraphEntry[] {
  if (!Array.isArray(entries)) return createDefaultModuleGraph();

  const result: ModuleGraphEntry[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const type = (entry as { type?: string }).type;
    if (typeof type !== "string" || !isModuleType(type)) continue;
    if (seen.has(type)) continue; // Duplicate — skip
    seen.add(type);
    result.push({
      type,
      enabled: Boolean((entry as { enabled?: boolean }).enabled),
    });
  }

  // Ensure all module types are present
  for (const t of MODULE_TYPES) {
    if (!seen.has(t)) {
      result.push({ type: t, enabled: false });
    }
  }

  return result;
}

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
// Ultina — Module Graph Runtime
//
// Runtime management of the reorderable module graph.
//
// The control thread (editor / host API) mutates the graph via
// methods on ModuleGraphRuntime. Each mutation builds a new
// immutable ModuleGraphSnapshot and publishes it atomically.
//
// The audio thread (process callback) calls getActiveSnapshot()
// to read the current immutable graph without any locks.
//
// In JavaScript, "atomic swap" is a simple reference assignment
// (single-threaded event loop). In the C++ port, this becomes
// a std::atomic<ModuleGraphSnapshot*> or equivalent.
// ═══════════════════════════════════════════════════════════

import {
  type ModuleGraphEntry,
  type ModuleGraphSnapshot,
  createDefaultModuleGraph,
  createSnapshot,
  moveModule as moveModulePure,
  toggleModule as toggleModulePure,
  setModuleEnabled as setModuleEnabledPure,
  getActiveModules as getActiveModulesPure,
  validateGraph,
} from "../contracts/moduleGraph.js";
import { MODULE_TYPES, type ModuleType } from "../contracts/moduleTypes.js";

// ── Active chain snapshot ──────────────────────────────────
//
// A flattened representation of the active signal chain.
// This is what the audio thread actually iterates over.

export interface ActiveChainSnapshot {
  /** Active modules in signal-flow order. */
  readonly modules: readonly ModuleType[];
  /** Snapshot version (incremented on every graph change). */
  readonly version: number;
  /** Total number of active modules. */
  readonly count: number;
}

// ── Module graph runtime ───────────────────────────────────

export class ModuleGraphRuntime {
  /** Mutable graph entries (control-thread only). */
  private entries: ModuleGraphEntry[];

  /** Current immutable snapshot (published for audio thread). */
  private snapshot: ModuleGraphSnapshot;

  /** Current active chain snapshot (derived from snapshot). */
  private activeChain: ActiveChainSnapshot;

  /** Monotonic version counter. */
  private versionCounter: number = 0;

  constructor(entries?: ModuleGraphEntry[]) {
    this.entries = entries
      ? validateGraph(entries)
      : createDefaultModuleGraph();
    this.snapshot = this.buildSnapshot();
    this.activeChain = this.buildActiveChain();
  }

  // ── Audio-thread-safe reads ──────────────────────────────

  /**
   * Get the current immutable graph snapshot.
   * Safe to call from the audio thread — no locks, no allocation.
   */
  getActiveSnapshot(): ModuleGraphSnapshot {
    return this.snapshot;
  }

  /**
   * Get the current active chain (enabled modules only).
   * Safe to call from the audio thread.
   */
  getActiveChain(): ActiveChainSnapshot {
    return this.activeChain;
  }

  /**
   * Get a read-only copy of the full graph entries (including disabled modules).
   * Allocates — use only on the control thread.
   */
  getEntries(): ModuleGraphEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  /**
   * Get the active module types in order.
   */
  getActiveModules(): ModuleType[] {
    return [...this.activeChain.modules];
  }

  // ── Control-thread mutations ─────────────────────────────

  /**
   * Move a module from one position to another.
   * Returns true if the graph changed.
   */
  moveModule(fromIndex: number, toIndex: number): boolean {
    const newEntries = moveModulePure(this.entries, fromIndex, toIndex);
    if (newEntries.length !== this.entries.length) return false;
    const changed = !entriesEqual(newEntries, this.entries);
    if (changed) {
      this.entries = newEntries;
      this.publish();
    }
    return changed;
  }

  /**
   * Move a module by type to a target index.
   */
  moveModuleByType(moduleType: ModuleType, toIndex: number): boolean {
    const fromIndex = this.entries.findIndex((e) => e.type === moduleType);
    if (fromIndex === -1) return false;
    return this.moveModule(fromIndex, toIndex);
  }

  /**
   * Toggle a module's enabled state.
   */
  toggleModule(moduleType: ModuleType): boolean {
    const newEntries = toggleModulePure(this.entries, moduleType);
    const changed = !entriesEqual(newEntries, this.entries);
    if (changed) {
      this.entries = newEntries;
      this.publish();
    }
    return changed;
  }

  /**
   * Set a module's enabled state explicitly.
   */
  setModuleEnabled(moduleType: ModuleType, enabled: boolean): boolean {
    const newEntries = setModuleEnabledPure(this.entries, moduleType, enabled);
    const changed = !entriesEqual(newEntries, this.entries);
    if (changed) {
      this.entries = newEntries;
      this.publish();
    }
    return changed;
  }

  /**
   * Enable a module.
   */
  enableModule(moduleType: ModuleType): boolean {
    return this.setModuleEnabled(moduleType, true);
  }

  /**
   * Disable a module.
   */
  disableModule(moduleType: ModuleType): boolean {
    return this.setModuleEnabled(moduleType, false);
  }

  /**
   * Enable only the specified modules (disable all others).
   */
  setActiveModules(moduleTypes: readonly ModuleType[]): boolean {
    const typeSet = new Set(moduleTypes);
    const newEntries = this.entries.map((e) => ({
      ...e,
      enabled: typeSet.has(e.type),
    }));
    const changed = !entriesEqual(newEntries, this.entries);
    if (changed) {
      this.entries = newEntries;
      this.publish();
    }
    return changed;
  }

  /**
   * Disable all modules (bypass the entire chain).
   */
  disableAll(): boolean {
    const newEntries = this.entries.map((e) => ({ ...e, enabled: false }));
    const changed = !entriesEqual(newEntries, this.entries);
    if (changed) {
      this.entries = newEntries;
      this.publish();
    }
    return changed;
  }

  /**
   * Reset the graph to default order, all disabled.
   */
  reset(): void {
    this.entries = createDefaultModuleGraph();
    this.publish();
  }

  /**
   * Load graph entries from external data (validated).
   */
  loadEntries(raw: unknown): boolean {
    const validated = validateGraph(raw);
    const changed = !entriesEqual(validated, this.entries);
    this.entries = validated;
    if (changed) {
      this.publish();
    }
    return changed;
  }

  /**
   * Get the index of a module type in the graph.
   */
  indexOf(moduleType: ModuleType): number {
    return this.entries.findIndex((e) => e.type === moduleType);
  }

  /**
   * Check if a module is enabled.
   */
  isModuleEnabled(moduleType: ModuleType): boolean {
    const entry = this.entries.find((e) => e.type === moduleType);
    return entry?.enabled ?? false;
  }

  /**
   * Check if a module type exists in the graph.
   */
  hasModule(moduleType: ModuleType): boolean {
    return this.entries.some((e) => e.type === moduleType);
  }

  /**
   * Get the current version number.
   */
  getVersion(): number {
    return this.versionCounter;
  }

  // ── Internal ─────────────────────────────────────────────

  /**
   * Build a new immutable snapshot and publish it atomically.
   */
  private publish(): void {
    this.snapshot = this.buildSnapshot();
    this.activeChain = this.buildActiveChain();
  }

  private buildSnapshot(): ModuleGraphSnapshot {
    this.versionCounter++;
    return createSnapshot(this.entries, this.versionCounter);
  }

  private buildActiveChain(): ActiveChainSnapshot {
    const active = getActiveModulesPure(this.entries).map((e) => e.type);
    return {
      modules: Object.freeze([...active]) as readonly ModuleType[],
      version: this.versionCounter,
      count: active.length,
    };
  }
}

// ── Utility functions ──────────────────────────────────────

/**
 * Shallow equality check for graph entries arrays.
 */
function entriesEqual(
  a: readonly ModuleGraphEntry[],
  b: readonly ModuleGraphEntry[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].type !== b[i].type || a[i].enabled !== b[i].enabled) {
      return false;
    }
  }
  return true;
}

/**
 * Create a default ModuleGraphRuntime instance.
 */
export function createModuleGraphRuntime(): ModuleGraphRuntime {
  return new ModuleGraphRuntime();
}

/**
 * Validate that all 10 module types are represented in a snapshot.
 */
export function isCompleteGraph(
  snapshot: ModuleGraphSnapshot,
): boolean {
  const types = new Set(snapshot.entries.map((e) => e.type));
  return MODULE_TYPES.every((t) => types.has(t));
}

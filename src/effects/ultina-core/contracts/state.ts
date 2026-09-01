/* eslint-disable */
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
// Ultina — Versioned State Container
//
// State format rules:
//   - Unknown future fields are ignored safely.
//   - Missing parameters receive documented defaults.
//   - Invalid values are clamped during load, never during
//     serialization alone.
//   - State restore happens outside the audio callback and
//     reaches the processor via a prepared command/state exchange.
//   - Corrupt state falls back safely and reports a diagnostic.
//   - Closing or reopening the editor does not alter state.
// ═══════════════════════════════════════════════════════════

import { buildDefaultParams } from "./parameterSchema.js";

// ── State version ──────────────────────────────────────────

/** Current state schema version. Increment on breaking changes. */
export const STATE_SCHEMA_VERSION = 1;

/** Magic/product identifier for state serialization. */
export const STATE_MAGIC = "ULTI" as const;

/** Product version embedded in state. */
export const STATE_PRODUCT_VERSION = { major: 0, minor: 1, patch: 0 } as const;

// ── A/B snapshots ───────────────────────────────────────────

export interface ABSnapshot {
  label: "A" | "B";
  name: string;
  params: Record<string, number>;
  moduleOrder: string[];
  moduleEnabled: Record<string, boolean>;
  timestamp: number;
  /** LUFS-S measured at capture time (for A/B delta metering). */
  capturedLufs?: number;
}

// ── Quality mode ────────────────────────────────────────────

export type QualityMode = "tracking" | "mix" | "hq";

// ── Module graph state ──────────────────────────────────────

export interface ModuleGraphState {
  /** Ordered list of module type IDs defining the signal chain. */
  order: string[];
  /** Per-module enabled state. */
  enabled: Record<string, boolean>;
}

// ── Full state container ────────────────────────────────────

export interface UltinaState {
  magic: typeof STATE_MAGIC;
  schemaVersion: number;
  productVersion: { major: number; minor: number; patch: number };
  params: Record<string, number>;
  moduleGraph: ModuleGraphState;
  qualityMode: QualityMode;
  abSnapshots: {
    a: ABSnapshot | null;
    b: ABSnapshot | null;
    active: "A" | "B";
  };
}

// ── Default state ───────────────────────────────────────────

export const DEFAULT_MODULE_ORDER = [
  "gate",
  "eq",
  "comp",
  "exciter",
  "transient",
  "density",
  "sculptor",
  "clipper",
  "phase",
  "unmask",
] as const;

export const DEFAULT_MODULE_ENABLED: Record<string, boolean> = Object.fromEntries(
  DEFAULT_MODULE_ORDER.map((m) => [m, false]),
) as Record<string, boolean>;

/** All modules disabled by default — user enables what they need. */
export function createDefaultState(): UltinaState {
  return {
    magic: STATE_MAGIC,
    schemaVersion: STATE_SCHEMA_VERSION,
    productVersion: { ...STATE_PRODUCT_VERSION },
    params: buildDefaultParams(),
    moduleGraph: {
      order: [...DEFAULT_MODULE_ORDER],
      enabled: { ...DEFAULT_MODULE_ENABLED },
    },
    qualityMode: "mix",
    abSnapshots: {
      a: null,
      b: null,
      active: "A",
    },
  };
}

// ── State validation ────────────────────────────────────────

export function validateState(raw: unknown): UltinaState {
  const fallback = createDefaultState();

  if (typeof raw !== "object" || raw === null) return fallback;

  const obj = raw as Partial<UltinaState>;

  if (obj.magic !== STATE_MAGIC) {
    // Unknown magic — treat as corrupt, fall back
    return fallback;
  }

  // Merge params with defaults
  const params = { ...buildDefaultParams() };
  if (obj.params && typeof obj.params === "object") {
    for (const [k, v] of Object.entries(obj.params)) {
      if (typeof v === "number" && Number.isFinite(v)) {
        params[k] = v;
      }
    }
  }

  // Merge module graph
  const graph: ModuleGraphState = {
    order: [...DEFAULT_MODULE_ORDER],
    enabled: { ...DEFAULT_MODULE_ENABLED },
  };
  if (obj.moduleGraph) {
    if (Array.isArray(obj.moduleGraph.order)) {
      graph.order = obj.moduleGraph.order.filter((m) => typeof m === "string");
    }
    if (obj.moduleGraph.enabled && typeof obj.moduleGraph.enabled === "object") {
      for (const [k, v] of Object.entries(obj.moduleGraph.enabled)) {
        graph.enabled[k] = Boolean(v);
      }
    }
  }

  return {
    magic: STATE_MAGIC,
    schemaVersion: STATE_SCHEMA_VERSION,
    productVersion: { ...STATE_PRODUCT_VERSION },
    params,
    moduleGraph: graph,
    qualityMode:
      obj.qualityMode === "tracking" || obj.qualityMode === "hq"
        ? obj.qualityMode
        : "mix",
    abSnapshots: obj.abSnapshots ?? fallback.abSnapshots,
  };
}

// ── A/B snapshot helpers ────────────────────────────────────

export function snapshotFromState(
  state: UltinaState,
  label: "A" | "B",
  name: string,
): ABSnapshot {
  return {
    label,
    name,
    params: { ...state.params },
    moduleOrder: [...state.moduleGraph.order],
    moduleEnabled: { ...state.moduleGraph.enabled },
    timestamp: Date.now(),
  };
}

export function applySnapshot(
  state: UltinaState,
  snap: ABSnapshot,
): UltinaState {
  return {
    ...state,
    params: { ...snap.params },
    moduleGraph: {
      order: [...snap.moduleOrder],
      enabled: { ...snap.moduleEnabled },
    },
  };
}

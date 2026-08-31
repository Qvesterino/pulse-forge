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
// FXEQ — Module parameter helper
//
// Reduces boilerplate across modules: stores clamped values keyed by
// parameter def, and wires up the ModuleProcessor parameter surface.
// ═══════════════════════════════════════════════════════════

import type { FxEqParamDef } from "../dsp/types.js";
import { clamp } from "../dsp/mathUtils.js";

export interface ParamStore {
  get(id: string): number;
  set(id: string, value: number): void;
  all(): Record<string, number>;
  load(params: Record<string, number>): void;
}

/** Create a clamped parameter store from parameter definitions + initial values. */
export function createParamStore(
  defs: readonly FxEqParamDef[],
  initial?: Record<string, number>,
): ParamStore {
  const values: Record<string, number> = {};
  for (const d of defs) values[d.id] = d.defaultValue;
  if (initial) {
    for (const d of defs) {
      if (initial[d.id] !== undefined) {
        values[d.id] = clamp(initial[d.id], d.minValue, d.maxValue);
      }
    }
  }
  return {
    get(id) {
      return values[id] ?? 0;
    },
    set(id, value) {
      const d = defs.find((x) => x.id === id);
      if (d) values[id] = clamp(value, d.minValue, d.maxValue);
    },
    all() {
      return { ...values };
    },
    load(params) {
      for (const d of defs) {
        if (params[d.id] !== undefined) {
          values[d.id] = clamp(params[d.id], d.minValue, d.maxValue);
        }
      }
    },
  };
}

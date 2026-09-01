/* eslint-disable */
// @ts-nocheck
/**
 * VENDORED from VocalForge_DAW/plugins/ozvena. Do not edit by hand — this is
 * a byte-faithful copy of the upstream DSP oracle so Pulse Forge and
 * VocalForge validate against the SAME golden fixtures
 * (tests/ozvena-golden.test.ts). Fix DSP issues upstream, then re-vendor
 * via scripts/vendor-ozvena.mjs.
 *
 * Applied transforms (mechanical, semantics-preserving):
 *  - type-only specifiers marked with "type" for verbatimModuleSyntax
 *    (Pulse Forge tsconfig is stricter than upstream).
 */
// ═══════════════════════════════════════════════════════════
// Ozvena — Blend Pad core
//
// Bridges the v2/ BlendPadState (string ID `blend.x`, `blend.y`,
// `blend.engine2Algo`) to the runtime barycentric weights used by the
// top-level processor. Pure functions, no state.
// ═══════════════════════════════════════════════════════════

import { blendPadToEngineWeights, type EngineWeights } from "../v2/types.js";
import type { BlendPadState } from "../v2/types.js";

export interface BlendPadMix {
  weights: EngineWeights;
  /** Convenience: total gain to apply to the wet bus. */
  wetGain: number;
}

/**
 * Apply a Blend Pad state + per-engine enabled flags to compute the
 * actual wet-side mix coefficients for the three engines.
 *
 * Disabled engines drop out cleanly (weight = 0) so the disabled engine
 * contributes silence. The remaining engines are renormalised to sum 1.
 */
export function computeBlendPadMix(
  blend: BlendPadState,
  enginesEnabled: { e1: boolean; e2: boolean; e3: boolean },
): BlendPadMix {
  const raw = blendPadToEngineWeights(blend.x, blend.y);
  let e1 = enginesEnabled.e1 ? raw.e1 : 0;
  let e2 = enginesEnabled.e2 ? raw.e2 : 0;
  let e3 = enginesEnabled.e3 ? raw.e3 : 0;
  const sum = e1 + e2 + e3;
  if (sum > 1e-6) {
    e1 /= sum;
    e2 /= sum;
    e3 /= sum;
  }
  return { weights: { e1, e2, e3 }, wetGain: 1 };
}

/**
 * Convenience helper: distribute one input stereo signal across the
 * three engines according to the blend weights. Returns three stereo
 * outputs (one per engine). Each engine module then processes its own
 * copy and the host sums the three results weighted again by the blend.
 */
export function distributeToEngines(
  channels: Float32Array[],
  weights: EngineWeights,
  frameCount: number,
): { e1: Float32Array[]; e2: Float32Array[]; e3: Float32Array[] } {
  const e1: Float32Array[] = channels.map((c) => {
    const out = new Float32Array(frameCount);
    for (let i = 0; i < frameCount; i++) out[i] = c[i] * weights.e1;
    return out;
  });
  const e2: Float32Array[] = channels.map((c) => {
    const out = new Float32Array(frameCount);
    for (let i = 0; i < frameCount; i++) out[i] = c[i] * weights.e2;
    return out;
  });
  const e3: Float32Array[] = channels.map((c) => {
    const out = new Float32Array(frameCount);
    for (let i = 0; i < frameCount; i++) out[i] = c[i] * weights.e3;
    return out;
  });
  return { e1, e2, e3 };
}

/**
 * Realtime-safe variant of `distributeToEngines`: fills caller-owned,
 * pre-allocated scratch instead of allocating six new Float32Arrays per
 * audio block. Every buffer in `out` is fully written for `frameCount`
 * samples — channels beyond `channels.length` are zero-filled so the
 * engines never observe stale scratch from a previous block.
 */
export function distributeToEnginesInto(
  out: { e1: Float32Array[]; e2: Float32Array[]; e3: Float32Array[] },
  channels: Float32Array[],
  weights: EngineWeights,
  frameCount: number,
): void {
  const cc = Math.min(channels.length, out.e1.length, out.e2.length, out.e3.length);
  for (let c = 0; c < cc; c++) {
    const src = channels[c];
    const o1 = out.e1[c];
    const o2 = out.e2[c];
    const o3 = out.e3[c];
    const w1 = weights.e1;
    const w2 = weights.e2;
    const w3 = weights.e3;
    for (let i = 0; i < frameCount; i++) {
      const s = src[i];
      o1[i] = s * w1;
      o2[i] = s * w2;
      o3[i] = s * w3;
    }
  }
  // Zero-fill scratch channels the host did not supply this block.
  const total = Math.min(out.e1.length, out.e2.length, out.e3.length);
  for (let c = cc; c < total; c++) {
    out.e1[c].fill(0, 0, frameCount);
    out.e2[c].fill(0, 0, frameCount);
    out.e3[c].fill(0, 0, frameCount);
  }
}

/**
 * Sum the three engine outputs back into a single stereo bus.
 * Used after each engine has processed its own distributed slice.
 */
export function sumEngines(
  out: Float32Array[],
  e1: Float32Array[],
  e2: Float32Array[],
  e3: Float32Array[],
  frameCount: number,
): void {
  const cc = out.length;
  for (let c = 0; c < cc; c++) {
    const a = e1[c] || null;
    const b = e2[c] || null;
    const d = e3[c] || null;
    if (!a && !b && !d) continue;
    for (let i = 0; i < frameCount; i++) {
      let s = 0;
      if (a) s += a[i];
      if (b) s += b[i];
      if (d) s += d[i];
      out[c][i] = s;
    }
  }
}

/**
 * Scale-bridge registry — ONE named adapter per document↔DSP scale crossing.
 *
 * Contract (Phase 5 of docs/PLUGIN-AUDIT-FOLLOWUP-ROADMAP.md): every
 * `ParamDef` declares the DOCUMENT scale. Where a worklet parameter carries
 * the same physical quantity in a different DOMAIN or SCALE, the crossing
 * must be registered here so the dual-domain pairs are enumerable and every
 * one is test-verified (`tests/param-range-coherence.test.ts` fails on an
 * unregistered def↔descriptor mismatch).
 *
 * The audit (docs/PLUGIN-AUDIT-2026-09-27.md) found two real bugs of this
 * class: ultina `global.mix` clamped on the wrong scale in automation lanes
 * (0..100 percent vs the 0..1 document convention) and the historical
 * multi-tap bar/beat confusion. Registering bridges makes the remaining ones
 * impossible to add by accident.
 *
 * Registry entries:
 *   domain  — "identity" when the descriptor carries the same unit as the
 *             def; named conversions for the known dual-domain pairs.
 *
 * Currently registered bridges:
 *   compressor.makeup  — def dB, descriptor linear gain (×10^(dB/20))
 *   ultina.global.mix  — doc 0..1, vendored DSP percent 0..100 (×100)
 *   fxeq.globalMix     — doc 0..1, vendored DSP percent 0..100 (×100)
 *   ozvena.global.dryWet — doc 0..1, vendored percent 0..100 (×100)
 *   morphdynamics.global.mix — doc 0..1, DSP percent 0..100 (×100)
 *   bitcrusher.downsample — musical powers of two (1..64), descriptor count
 *   fxeq.crossoverOrder — structural snap {2,4,8}
 */

/** dB (document) → linear gain (worklet AudioParam). */
export const dbToLinearGain = (db: number): number => Math.pow(10, db / 20);

/** Document 0..1 mix → vendored DSP percent 0..100. */
export const mix01ToPercent100 = (v: number): number => v * 100;

/** Document powers-of-two selector → descriptor count (identity, snapped). */
export const powerOfTwoCount = (v: number): number => Math.pow(2, Math.round(Math.log2(Math.max(1, v))));

/** Structural snap onto the legal crossover slopes {2, 4, 8}. */
export const snapCrossoverSlope = (v: number): number => {
  const options = [2, 4, 8];
  return options.reduce((best, o) => (Math.abs(o - v) < Math.abs(best - v) ? o : best), 2);
};

export interface ScaleBridge {
  /** Descriptor/AudioParam scale. "document" = identity crossing (no entry needed). */
  domain: "document" | "linear-gain" | "percent-100" | "power-of-two-count" | "structural-snap";
  /** Document value → descriptor value (identity bridges omit this). */
  toDescriptor?: (v: number) => number;
  /** Note explaining the crossing; asserted in the coherence test. */
  note: string;
}

/**
 * effectType.paramId → bridge. THE single list of every registered
 * document↔descriptor domain crossing.
 */
export const SCALE_BRIDGES: Record<string, ScaleBridge> = {
  "compressor.makeup": {
    domain: "linear-gain",
    toDescriptor: dbToLinearGain,
    note: "def is dB (0..24); the AudioParam is linear gain (0..16 ≈ +24 dB)",
  },
  "ultina.global.mix": {
    domain: "percent-100",
    toDescriptor: mix01ToPercent100,
    note: "doc/rack 0..1; vendored schema stores percent 0..100 (ultinaNode rescales ×100)",
  },
  "fxeq.mix": {
    domain: "percent-100",
    toDescriptor: mix01ToPercent100,
    note: "rack MIX 0..1; the vendored globalMix is percent 0..100 (fxeqNode bridges)",
  },
  "ozvena.global.dryWet": {
    domain: "percent-100",
    toDescriptor: mix01ToPercent100,
    note: "doc 0..1; the vendored dryWet is percent 0..100",
  },
  "morphdynamics.global.mix": {
    domain: "percent-100",
    toDescriptor: mix01ToPercent100,
    note: "doc 0..1; vendored mix is percent 0..100",
  },
  "bitcrusher.downsample": {
    domain: "power-of-two-count",
    toDescriptor: powerOfTwoCount,
    note: "musical powers of two (1..64) — descriptor is the raw decimation count",
  },
  "fxeq.crossoverOrder": {
    domain: "structural-snap",
    toDescriptor: snapCrossoverSlope,
    note: "legal slopes {2,4,8}; descriptor is the raw slope order",
  },
};

/** Look up a bridge for an effect param; undefined = identity (no crossing). */
export const scaleBridgeFor = (effectType: string, paramId: string): ScaleBridge | undefined =>
  SCALE_BRIDGES[`${effectType}.${paramId}`];

/** Test-side helper: def value → the descriptor-domain value to compare. */
export const toDescriptorValue = (effectType: string, paramId: string, defValue: number): number => {
  const bridge = scaleBridgeFor(effectType, paramId);
  return bridge?.toDescriptor ? bridge.toDescriptor(defValue) : defValue;
};

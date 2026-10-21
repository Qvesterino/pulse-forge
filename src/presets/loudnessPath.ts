/**
 * WHICH SYNTHESIS the loudness map describes — and which the drift gate has
 * to measure.
 *
 * The map (scripts/measure-preset-loudness.mjs) and the drift gate
 * (src/browser-checks.ts → auditFactoryPresetAudio) measure the same
 * quantity: "how loud is this preset". Two numbers are only comparable when
 * they come from the SAME synthesis, and for a worklet-path instrument that
 * means the production worklet — not the native fallback that stands in for
 * it when the module is missing.
 *
 * MEASURED 2026-10-21 on all 16 KOPA presets: the map matches the worklet to
 * 0.04 LU, while the native fallback reads **6.2-12.5 LU LOUDER**. The gate
 * measured the fallback, compared it with the map, and called the map stale —
 * and its advice ("run npm run presets:loudness") would have baked the
 * fallback's level into the map, describing a sound the product never
 * exports. The map was never stale; the gate was measuring a different kick.
 *
 * ONE OWNER, TWO CONSUMERS. The list lives here, and the map generator and
 * the drift gate both read it — a list written twice is a list nobody checks.
 * The instrument name is also its worklet type, so the list doubles as the
 * module to load.
 */

/** The instruments whose loudness is measured through their production worklet. */
export const WORKLET_PATH_INSTRUMENTS = ["kopa"] as const;

/** Does this instrument measure through its production worklet? */
export function isWorkletPathInstrument(instrument: string): boolean {
  return (WORKLET_PATH_INSTRUMENTS as readonly string[]).includes(instrument);
}

/**
 * Light seam over the curated sample layer (F2 eager diet).
 *
 * `./curated` carries the full CURATED_SAMPLES data table (~324 KB built).
 * The only boot-path consumers — services wiring and the offline renderer —
 * need the two async functions, not the data, so they import THIS module and
 * the data module loads on the first `ensureCuratedLayer` call instead of at
 * boot. Dev tooling (browser-checks) keeps its static import: it is not in
 * the studio boot graph and wants the data directly.
 *
 * The dedup lives in the heavy module's `layerByBank` map — re-calling these
 * wrappers never re-loads or re-applies the layer for an already-ensured bank.
 */
import type { SampleBank } from "./factory";

type CuratedOptions = {
  fetchImpl?: typeof fetch;
  decode?: (data: ArrayBuffer) => Promise<AudioBuffer>;
  signal?: AbortSignal;
};

export function ensureCuratedLayer(bank: SampleBank, options: CuratedOptions = {}): Promise<void> {
  return import("./curated").then((m) => m.ensureCuratedLayer(bank, options));
}

export async function curatedReadyWithin(bank: SampleBank, timeoutMs: number): Promise<void> {
  const m = await import("./curated");
  return m.curatedReadyWithin(bank, timeoutMs);
}

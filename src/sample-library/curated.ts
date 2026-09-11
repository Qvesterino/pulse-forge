import type { SampleBank } from "./factory";

/**
 * Curated factory sound layer (VISION §5 "factory content is part of the
 * product"): a small set of excellent WAVs that OVERRIDE key factory slots.
 *
 * Same-id override contract: files register under the EXISTING `factory.*`
 * ids, so the synthesized kit (built eagerly at boot, ~62 ms) is the
 * guaranteed fallback BY CONSTRUCTION — a missing, failing or slow curated
 * file simply leaves the synth sound in place. No kit/preset/template/schema
 * changes; pads keep referencing the ids they always did.
 *
 * Files live in `public/samples/` (see that folder's README for the curation
 * contract) and are fetched lazily — they are NOT part of any JS budget.
 */

export interface CuratedSample {
  /** Existing factory asset id this file overrides (see sample-library/manifest.ts). */
  id: string;
  /** File name inside public/samples/. */
  file: string;
  /** Optional trim applied on load (linear, default 1) — curation tool. */
  gain?: number;
}

export const CURATED_SAMPLES: CuratedSample[] = [
  { id: "factory.kick.deep", file: "factory.kick.deep.wav" },
  { id: "factory.kick.punch", file: "factory.kick.punch.wav" },
  { id: "factory.snare.punch", file: "factory.snare.punch.wav" },
  { id: "factory.hat.closed", file: "factory.hat.closed.wav" },
  { id: "factory.clap.main", file: "factory.clap.main.wav" },
  { id: "factory.tonal.keys", file: "factory.tonal.keys.wav" },
];

/** Concurrency cap for parallel fetch+decode. */
const MAX_PARALLEL = 4;
/** Whole-layer byte ceiling — a hostile/oversized set must not balloon memory. */
const MAX_TOTAL_BYTES = 30 * 1024 * 1024;

export interface CuratedLoadResult {
  loaded: number;
  failed: string[];
  skipped: string[];
}

function defaultDecode(data: ArrayBuffer): Promise<AudioBuffer> {
  if (typeof OfflineAudioContext === "undefined") {
    return Promise.reject(new Error("OfflineAudioContext unavailable"));
  }
  // Same pattern as user-sample restore: decode needs the context machinery
  // only — a minimal OfflineAudioContext stays independent of the live
  // engine and of autoplay-gesture state.
  const ctx = new OfflineAudioContext(1, 1, 44100);
  return ctx.decodeAudioData(data);
}

function applyGain(buffer: AudioBuffer, gain: number): AudioBuffer {
  if (gain === 1) return buffer;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) data[i] *= gain;
  }
  return buffer;
}

/**
 * Load every curated sample into the bank (same-id override). Per-file error
 * isolation: a missing/corrupt file skips that slot and the synthesized
 * fallback stays — the layer never throws.
 */
export async function loadCuratedLayer(
  bank: SampleBank,
  options: {
    fetchImpl?: typeof fetch;
    decode?: (data: ArrayBuffer) => Promise<AudioBuffer>;
    signal?: AbortSignal;
  } = {},
): Promise<CuratedLoadResult> {
  const doFetch =
    options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const decode = options.decode ?? defaultDecode;
  const result: CuratedLoadResult = { loaded: 0, failed: [], skipped: [] };
  if (CURATED_SAMPLES.length === 0) return result;

  let totalBytes = 0;
  const queue = [...CURATED_SAMPLES];
  const worker = async () => {
    while (queue.length > 0) {
      if (options.signal?.aborted) return;
      const sample = queue.shift()!;
      try {
        const response = await doFetch(`/samples/${sample.file}`, { signal: options.signal });
        if (!response.ok) {
          // Missing file = the slot simply stays synthesized (offline-first
          // installs, seed-less checkouts). Not an error worth reporting.
          result.skipped.push(sample.id);
          continue;
        }
        const data = await response.arrayBuffer();
        totalBytes += data.byteLength;
        if (totalBytes > MAX_TOTAL_BYTES) {
          result.skipped.push(sample.id);
          continue;
        }
        const buffer = await decode(data);
        bank.add(sample.id, applyGain(buffer, sample.gain ?? 1));
        result.loaded += 1;
      } catch (err) {
        if (options.signal?.aborted) return;
        console.warn(`[curated] failed to load ${sample.file}:`, err);
        result.failed.push(sample.id);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, CURATED_SAMPLES.length) }, worker));
  return result;
}

/** Per-bank memo: embed/export paths build their OWN banks — each gets the layer exactly once. */
const layerByBank = new WeakMap<object, Promise<void>>();

/**
 * Ensure the curated layer has landed in THIS bank (memoized per bank — the
 * services boot fires it off fire-and-forget; offline renders await the same
 * promise so exports use the curated sound when it made it in time). Never
 * rejects: a failed file leaves the synthesized fallback in place.
 */
export function ensureCuratedLayer(
  bank: SampleBank,
  options: Parameters<typeof loadCuratedLayer>[1] = {},
): Promise<void> {
  let existing = layerByBank.get(bank as unknown as object);
  if (!existing) {
    existing = loadCuratedLayer(bank, options).then(
      () => undefined,
      () => undefined,
    );
    layerByBank.set(bank as unknown as object, existing);
  }
  return existing;
}

/** Await the curated layer for at most `timeoutMs` — then render synth-fallback. */
export async function curatedReadyWithin(bank: SampleBank, timeoutMs: number): Promise<void> {
  await Promise.race([ensureCuratedLayer(bank), new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
}

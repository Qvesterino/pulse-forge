import { decodeAudioData } from "../services/audio-decode";
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

/**
 * Full-kit curation (factory-content pass 2026-09): every factory asset id
 * gets a curated file, so the whole kit carries the mastering glue and the
 * per-category loudness balance (see scripts/render-curated-seeds.mjs for
 * the targets). The same-id override contract is unchanged.
 */
export const CURATED_SAMPLES: CuratedSample[] = [
  { id: "factory.kick.deep", file: "factory.kick.deep.wav" },
  { id: "factory.kick.punch", file: "factory.kick.punch.wav" },
  { id: "factory.kick.techno", file: "factory.kick.techno.wav" },
  { id: "factory.kick.sub808", file: "factory.kick.sub808.wav" },
  { id: "factory.kick.trap", file: "factory.kick.trap.wav" },
  { id: "factory.kick.soft", file: "factory.kick.soft.wav" },
  { id: "factory.snare.main", file: "factory.snare.main.wav" },
  { id: "factory.snare.tight", file: "factory.snare.tight.wav" },
  { id: "factory.snare.punch", file: "factory.snare.punch.wav" },
  { id: "factory.snare.trap", file: "factory.snare.trap.wav" },
  { id: "factory.clap.main", file: "factory.clap.main.wav" },
  { id: "factory.clap.soft", file: "factory.clap.soft.wav" },
  { id: "factory.hat.closed", file: "factory.hat.closed.wav" },
  { id: "factory.hat.closed.soft", file: "factory.hat.closed.soft.wav" },
  { id: "factory.hat.open", file: "factory.hat.open.wav" },
  { id: "factory.hat.open.short", file: "factory.hat.open.short.wav" },
  { id: "factory.hat.pedal", file: "factory.hat.pedal.wav" },
  { id: "factory.ride.ping", file: "factory.ride.ping.wav" },
  { id: "factory.ride.bell", file: "factory.ride.bell.wav" },
  { id: "factory.crash.main", file: "factory.crash.main.wav" },
  { id: "factory.crash.dark", file: "factory.crash.dark.wav" },
  { id: "factory.tom.low", file: "factory.tom.low.wav" },
  { id: "factory.tom.mid", file: "factory.tom.mid.wav" },
  { id: "factory.tom.high", file: "factory.tom.high.wav" },
  { id: "factory.rim.chip", file: "factory.rim.chip.wav" },
  { id: "factory.shaker.soft", file: "factory.shaker.soft.wav" },
  { id: "factory.perc.tick", file: "factory.perc.tick.wav" },
  { id: "factory.perc.blip", file: "factory.perc.blip.wav" },
  { id: "factory.perc.cowbell", file: "factory.perc.cowbell.wav" },
  { id: "factory.perc.conga", file: "factory.perc.conga.wav" },
  { id: "factory.perc.tambourine", file: "factory.perc.tambourine.wav" },
  { id: "factory.fx.riser", file: "factory.fx.riser.wav" },
  { id: "factory.fx.downlifter", file: "factory.fx.downlifter.wav" },
  { id: "factory.fx.impact", file: "factory.fx.impact.wav" },
  { id: "factory.fx.sweep", file: "factory.fx.sweep.wav" },
  { id: "factory.fx.reverse", file: "factory.fx.reverse.wav" },
  { id: "factory.fx.noise", file: "factory.fx.noise.wav" },
  { id: "factory.tonal.pluck", file: "factory.tonal.pluck.wav" },
  { id: "factory.tonal.stab", file: "factory.tonal.stab.wav" },
  { id: "factory.tonal.keys", file: "factory.tonal.keys.wav" },
  { id: "factory.tonal.bell", file: "factory.tonal.bell.wav" },
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
  // Audio-decode platform contract (GOAL 03) — same default, injectable.
  return decodeAudioData(data);
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

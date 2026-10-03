import { decodeAudioData } from "../services/audio-decode";
import { assetUrl } from "../shared/assetUrls";
import { applyRoundRobinVariants, type SampleBank } from "./factory";

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
 * Full-kit curation (factory-content pass 2026-09): every factory asset gets
 * a curated file — the three mallet slots joined when the sound-library gate
 * closed the last loudness inconsistency (they measured ~10 dB above the
 * mastered kit as synthesis-only). The curated layer carries the mastering
 * glue and the per-category loudness balance (see
 * scripts/render-curated-seeds.mjs), locked by tests/sound-library-gate.
 */

export const CURATED_SAMPLES: CuratedSample[] = [
  { id: "factory.kick.deep", file: "factory.kick.deep.wav" },
  { id: "factory.kick.punch", file: "factory.kick.punch.wav" },
  { id: "factory.kick.techno", file: "factory.kick.techno.wav" },
  { id: "factory.kick.sub808", file: "factory.kick.sub808.wav" },
  { id: "factory.kick.trap", file: "factory.kick.trap.wav" },
  { id: "factory.kick.soft", file: "factory.kick.soft.wav" },
  { id: "factory.kick.808drive", file: "factory.kick.808drive.wav" },
  { id: "factory.kick.808pure", file: "factory.kick.808pure.wav" },
  { id: "factory.kick.drill", file: "factory.kick.drill.wav" },
  { id: "factory.kick.phonk", file: "factory.kick.phonk.wav" },
  { id: "factory.kick.jersey", file: "factory.kick.jersey.wav" },
  { id: "factory.kick.dnb", file: "factory.kick.dnb.wav" },
  { id: "factory.kick.lofi", file: "factory.kick.lofi.wav" },
  { id: "factory.kick.knock", file: "factory.kick.knock.wav" },
  { id: "factory.kick.909", file: "factory.kick.909.wav" },
  { id: "factory.snare.main", file: "factory.snare.main.wav" },
  { id: "factory.snare.tight", file: "factory.snare.tight.wav" },
  { id: "factory.snare.punch", file: "factory.snare.punch.wav" },
  { id: "factory.snare.trap", file: "factory.snare.trap.wav" },
  { id: "factory.snare.drill", file: "factory.snare.drill.wav" },
  { id: "factory.snare.phonk", file: "factory.snare.phonk.wav" },
  { id: "factory.snare.jersey", file: "factory.snare.jersey.wav" },
  { id: "factory.snare.dnb", file: "factory.snare.dnb.wav" },
  { id: "factory.snare.lofi", file: "factory.snare.lofi.wav" },
  { id: "factory.snare.room", file: "factory.snare.room.wav" },
  { id: "factory.clap.main", file: "factory.clap.main.wav" },
  { id: "factory.clap.soft", file: "factory.clap.soft.wav" },
  { id: "factory.hat.closed", file: "factory.hat.closed.wav" },
  { id: "factory.hat.closed.soft", file: "factory.hat.closed.soft.wav" },
  { id: "factory.hat.open", file: "factory.hat.open.wav" },
  { id: "factory.hat.open.short", file: "factory.hat.open.short.wav" },
  { id: "factory.hat.pedal", file: "factory.hat.pedal.wav" },
  { id: "factory.hat.drill", file: "factory.hat.drill.wav" },
  { id: "factory.hat.phonk", file: "factory.hat.phonk.wav" },
  { id: "factory.hat.jersey", file: "factory.hat.jersey.wav" },
  { id: "factory.hat.dnb", file: "factory.hat.dnb.wav" },
  { id: "factory.hat.open.cup", file: "factory.hat.open.cup.wav" },
  { id: "factory.hat.wash", file: "factory.hat.wash.wav" },
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
  { id: "factory.perc.cowbell.dark", file: "factory.perc.cowbell.dark.wav" },
  { id: "factory.perc.cowbell.scream", file: "factory.perc.cowbell.scream.wav" },
  { id: "factory.perc.cowbell.drill", file: "factory.perc.cowbell.drill.wav" },
  { id: "factory.perc.cowbell.bright", file: "factory.perc.cowbell.bright.wav" },
  { id: "factory.perc.conga", file: "factory.perc.conga.wav" },
  { id: "factory.perc.tambourine", file: "factory.perc.tambourine.wav" },
  { id: "factory.fx.riser", file: "factory.fx.riser.wav" },
  { id: "factory.fx.downlifter", file: "factory.fx.downlifter.wav" },
  { id: "factory.fx.impact", file: "factory.fx.impact.wav" },
  { id: "factory.fx.sweep", file: "factory.fx.sweep.wav" },
  { id: "factory.fx.reverse", file: "factory.fx.reverse.wav" },
  { id: "factory.fx.noise", file: "factory.fx.noise.wav" },
  { id: "factory.fx.subdrop", file: "factory.fx.subdrop.wav" },
  { id: "factory.fx.vinyl", file: "factory.fx.vinyl.wav" },
  { id: "factory.fx.impact2", file: "factory.fx.impact2.wav" },
  { id: "factory.fx.riser-short", file: "factory.fx.riser-short.wav" },
  { id: "factory.fx.noise-down", file: "factory.fx.noise-down.wav" },
  { id: "factory.tonal.pluck", file: "factory.tonal.pluck.wav" },
  { id: "factory.tonal.stab", file: "factory.tonal.stab.wav" },
  { id: "factory.tonal.keys", file: "factory.tonal.keys.wav" },
  { id: "factory.tonal.bell", file: "factory.tonal.bell.wav" },
  { id: "factory.tonal.memphisguitar", file: "factory.tonal.memphisguitar.wav" },
  { id: "factory.tonal.darkstrings", file: "factory.tonal.darkstrings.wav" },
  { id: "factory.tonal.rhodes", file: "factory.tonal.rhodes.wav" },
  { id: "factory.tonal.trumpet", file: "factory.tonal.trumpet.wav" },
  { id: "factory.tonal.animepluck", file: "factory.tonal.animepluck.wav" },
  { id: "factory.tonal.sadpiano", file: "factory.tonal.sadpiano.wav" },
  { id: "factory.tonal.padwarm", file: "factory.tonal.padwarm.wav" },
  { id: "factory.tonal.harp", file: "factory.tonal.harp.wav" },
  { id: "factory.tonal.wurli", file: "factory.tonal.wurli.wav" },
  { id: "factory.tonal.organ", file: "factory.tonal.organ.wav" },
  { id: "factory.tonal.acousticguitar", file: "factory.tonal.acousticguitar.wav" },
  { id: "factory.tonal.choirpad", file: "factory.tonal.choirpad.wav" },
  { id: "factory.tonal.sitar", file: "factory.tonal.sitar.wav" },
  { id: "factory.tonal.erhu", file: "factory.tonal.erhu.wav" },
  // Orphan backfill (full-kit contract): tonal carriers that shipped without
  // curated overrides — seeds rendered by `npm run curated:seeds` like the rest.
  { id: "factory.tonal.cello", file: "factory.tonal.cello.wav" },
  { id: "factory.tonal.nylonguitar", file: "factory.tonal.nylonguitar.wav" },
  { id: "factory.tonal.orchestrahit", file: "factory.tonal.orchestrahit.wav" },
  { id: "factory.tonal.pizzicato", file: "factory.tonal.pizzicato.wav" },
  { id: "factory.tonal.violin", file: "factory.tonal.violin.wav" },
  // Pop wave (WAVs rendered by `npm run curated:seeds` from the builders).
  { id: "factory.kick.pop", file: "factory.kick.pop.wav" },
  { id: "factory.clap.pop", file: "factory.clap.pop.wav" },
  { id: "factory.crash.pop", file: "factory.crash.pop.wav" },
  { id: "factory.tom.floor", file: "factory.tom.floor.wav" },
  { id: "factory.rim.pop", file: "factory.rim.pop.wav" },
  { id: "factory.perc.shaker.pop", file: "factory.perc.shaker.pop.wav" },
  { id: "factory.mallet.kalimba", file: "factory.mallet.kalimba.wav" },
  { id: "factory.mallet.musicbox", file: "factory.mallet.musicbox.wav" },
  // Mallet trio mastered (library-gate wave): the last synthesis-only slots
  // — as curated WAVs they land on the Tonal loudness target like the kit.
  { id: "factory.mallet.vibes", file: "factory.mallet.vibes.wav" },
  { id: "factory.mallet.marimba", file: "factory.mallet.marimba.wav" },
  { id: "factory.mallet.celesta", file: "factory.mallet.celesta.wav" },
  // Bass pack (library-completion wave 2026-10-04) — the empty category.
  { id: "factory.bass.clean", file: "factory.bass.clean.wav" },
  { id: "factory.bass.reese", file: "factory.bass.reese.wav" },
  { id: "factory.bass.fm", file: "factory.bass.fm.wav" },
  { id: "factory.bass.pluck", file: "factory.bass.pluck.wav" },
  { id: "factory.bass.wobble", file: "factory.bass.wobble.wav" },
  { id: "factory.bass.dist", file: "factory.bass.dist.wav" },
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
        const response = await doFetch(assetUrl(`/samples/${sample.file}`), { signal: options.signal });
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
        // A curated override changes the base a round-robin set derives from.
        // Re-derive its variants from the sound the user actually hears —
        // otherwise base and variants are two different drums alternating.
        // Best-effort by contract: this is an enhancement on top of a load
        // that has already succeeded, so a derivation failure (e.g. a host
        // without the AudioBuffer constructor) must never turn a good sample
        // into a reported failure.
        try {
          applyRoundRobinVariants(bank, sample.id);
        } catch (error) {
          console.warn(`[curated] RR re-derivation skipped for ${sample.id}:`, error);
        }
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

/**
 * S3 — MODEL STEM CLIENT: gate → ORT session → chunked overlap-add.
 *
 * The never-throw contract: every failure (flag off, no manifest, no
 * gatePassed, no model file, ORT failure) resolves to null and the caller
 * falls back to Tier-1 HPSS — never an exception into the UI.
 *
 * The ORT session is lazily created ONCE and cached; the actual tensor
 * plumbing (pre/post-processing per chunk — resample to manifest
 * sampleRate, channel layout, overlap-add trimming) lives behind
 * `separateChunkFn`, which S4 fills with the real implementation once a
 * real checkpoint exists to validate against. The chunking runner here is
 * production code exercised with a fake separator by tests.
 */
import { assetUrl } from "../../shared/assetUrls";
import { runChunkedSeparation, type ChunkedSeparationOptions, type StemChunkResult } from "./chunking";
import { manifestGatePassed, probeStemModelManifest, stemModelFlagOn, type StemModelManifest } from "./gate";

export interface ModelStems {
  stems: Float32Array[];
  stemNames: StemModelManifest["stems"];
  analyzedSec: number;
  modelVersion: string;
}

export interface ModelSeparationOptions extends ChunkedSeparationOptions {
  onProgress?: (chunkDone: number, chunksTotal: number) => void;
  signal?: AbortSignal;
}

export interface StemModelSession {
  manifest: StemModelManifest;
  /** ORT InferenceSession (typed loosely — onnxruntime-web import is lazy). */
  session: unknown;
}

let cachedSession: StemModelSession | null = null;

/** Test seam — inject a scripted session so tests never touch ORT. */
let sessionFactoryOverride: ((manifest: StemModelManifest) => Promise<StemModelSession | null>) | null = null;

export function setStemModelSessionFactoryForTests(
  factory: ((manifest: StemModelManifest) => Promise<StemModelSession | null>) | null,
): void {
  sessionFactoryOverride = factory;
  cachedSession = null;
}

export function resetStemModelSession(): void {
  cachedSession = null;
}

/** Create the ORT session for the manifest's model file. Never throws. */
async function createSession(manifest: StemModelManifest): Promise<StemModelSession | null> {
  if (sessionFactoryOverride) return sessionFactoryOverride(manifest);
  try {
    const ort = await import("onnxruntime-web");
    const session = await ort.InferenceSession.create(assetUrlFor(manifest.modelFile), {
      executionProviders: ["wasm"],
    });
    return { manifest, session };
  } catch {
    return null;
  }
}

function assetUrlFor(modelFile: string): string {
  // manifest.modelFile is relative to the manifest location — the same
  // origin-relative asset resolution every model download here uses.
  return assetUrl("/models/stem/" + modelFile.replace(/^\//, ""));
}

export interface ModelSeparationResult extends ModelStems, StemChunkResult {}

/**
 * Separate the track with the gated neural model. Resolves null whenever
 * the model is not available (flag/manifest/gate/session) — the caller
 * falls back to Tier-1 HPSS. Deterministic per input: fixed chunk grid,
 * cached session, no RNG.
 */
export async function separateTrackModel(
  pcm: Float32Array,
  sampleRate: number,
  options: ModelSeparationOptions = {},
): Promise<ModelSeparationResult | null> {
  try {
    if (!stemModelFlagOn()) return null;
    const manifest = await probeStemModelManifest();
    if (!manifest || !manifestGatePassed(manifest)) return null;
    if (!cachedSession) cachedSession = await createSession(manifest);
    if (!cachedSession) return null;

    const session = cachedSession;
    const result = runChunkedSeparation(
      pcm,
      sampleRate,
      (chunk, index, total) => {
        if (options.signal?.aborted) return null;
        const chunks = separateChunkWithSession(session, chunk, sampleRate);
        options.onProgress?.(index + 1, total);
        return chunks;
      },
      options,
    );
    if (!result || result.aborted) return null;
    return { ...result, analyzedSec: result.stems[0].length / sampleRate, modelVersion: manifest.stemModelVersion };
  } catch {
    return null;
  }
}

/**
 * S4 fills this with the real tensor plumbing (resample → ort session.run →
 * de-layout → resample back). Until a real checkpoint exists to validate
 * against, the honest answer is null → caller falls back to HPSS.
 */
function separateChunkWithSession(
  session: StemModelSession,
  chunk: Float32Array,
  sampleRate: number,
): Float32Array[] | null {
  void session;
  void chunk;
  void sampleRate;
  return null;
}

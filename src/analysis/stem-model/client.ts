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
import type { ChunkedSeparationOptions, StemChunkResult } from "./chunking";
import { fitLength, monoToStereoPlanar, planarToMonoStems, resampleLinear } from "./tensor";
import { manifestGatePassed, probeStemModelManifest, stemModelFlagOn, type StemModelManifest } from "./gate";

export interface ModelStems {
  stems: Float32Array[];
  stemNames: StemModelManifest["stems"];
  analyzedSec: number;
  modelVersion: string;
  /** Execution provider the session ran on (S5). */
  ep: StemEp;
}

export interface ModelSeparationOptions extends ChunkedSeparationOptions {
  onProgress?: (chunkDone: number, chunksTotal: number) => void;
  signal?: AbortSignal;
}

export interface StemModelSession {
  manifest: StemModelManifest;
  /** ORT InferenceSession (typed loosely — onnxruntime-web import is lazy). */
  session: unknown;
  /** Execution provider actually used (S5) — "wasm" unless WebGPU probed. */
  ep: StemEp;
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

/** S5 — execution-provider probe: WebGPU when the browser exposes
 * navigator.gpu, WASM SIMD otherwise. The choice is remembered per
 * session; a WebGPU session that fails to CREATE falls back to WASM
 * here (not silently mid-run — ORT does not hot-swap EPs). */
export type StemEp = "webgpu" | "wasm";

let cachedEp: StemEp | null = null;

export function resetStemEpCache(): void {
  cachedEp = null;
}

async function pickExecutionProvider(): Promise<StemEp> {
  if (cachedEp) return cachedEp;
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
    cachedEp = gpu ? ((await gpu.requestAdapter()) ? "webgpu" : "wasm") : "wasm";
  } catch {
    cachedEp = "wasm";
  }
  return cachedEp;
}

/** Create the ORT session for the manifest's model file. Never throws;
 * WebGPU first (when probed available) with a WASM fallback on creation
 * failure. Reports the EP actually used on the session. */
async function createSession(manifest: StemModelManifest): Promise<StemModelSession | null> {
  if (sessionFactoryOverride) return sessionFactoryOverride(manifest);
  try {
    const ort = await import("onnxruntime-web");
    const preferred = await pickExecutionProvider();
    const providers = preferred === "webgpu" ? ["webgpu", "wasm"] : ["wasm"];
    try {
      const session = await ort.InferenceSession.create(assetUrlFor(manifest.modelFile), {
        executionProviders: providers,
      });
      return { manifest, session, ep: preferred };
    } catch {
      if (preferred === "webgpu") {
        const session = await ort.InferenceSession.create(assetUrlFor(manifest.modelFile), {
          executionProviders: ["wasm"],
        });
        cachedEp = "wasm";
        return { manifest, session, ep: "wasm" };
      }
      return null;
    }
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
    // The model separator is ASYNC (ORT run is a promise), so the chunked
    // grid runs inline with the SAME rules as runChunkedSeparation (fixed
    // grid, complementary crossfades, abort between chunks). The pure sync
    // runner stays for tests and future sync separators.
    const chunkSec = options.chunkSec ?? manifest.chunkSec ?? 8;
    const overlapSec = Math.min(options.overlapSec ?? 1, chunkSec / 4);
    const maxSeconds = options.maxSeconds ?? 240;
    const total = Math.min(pcm.length, Math.floor(maxSeconds * sampleRate));
    if (total < sampleRate) return null;
    const chunkSamples = Math.floor(chunkSec * sampleRate);
    const overlapSamples = Math.floor(overlapSec * sampleRate);
    if (chunkSamples <= overlapSamples) return null;
    const starts: number[] = [];
    for (let start = 0; start < total; start += chunkSamples - overlapSamples) {
      starts.push(start);
      if (start + chunkSamples >= total) break;
    }
    const last = starts.length - 1;
    const fadeIn = new Float64Array(overlapSamples);
    const fadeOut = new Float64Array(overlapSamples);
    for (let j = 0; j < overlapSamples; j++) {
      const phase = (j + 0.5) / overlapSamples;
      fadeIn[j] = 0.5 - 0.5 * Math.cos(Math.PI * phase);
      fadeOut[j] = 1 - fadeIn[j];
    }
    const stems: Float32Array[] = [0, 1, 2, 3].map(() => new Float32Array(total));
    let processed = 0;
    for (let index = 0; index < starts.length; index++) {
      if (options.signal?.aborted) return null;
      const start = starts[index];
      const end = Math.min(total, start + chunkSamples);
      const length = end - start;
      const tailStart = length - overlapSamples;
      const separated = await separateChunkWithSession(session, pcm.subarray(start, end), sampleRate);
      if (!separated || separated.length !== 4) continue;
      for (let stem = 0; stem < 4; stem++) {
        const target = stems[stem];
        const source = separated[stem];
        for (let i = 0; i < length; i++) {
          let weight = 1;
          const inHead = index > 0 && i < overlapSamples;
          const inTail = index < last && i >= tailStart;
          if (inHead) weight = fadeIn[i];
          else if (inTail) weight = fadeOut[i - tailStart];
          target[start + i] += source[i] * weight;
        }
      }
      processed += 1;
      // Yield between chunks so the main thread breathes during inference.
      await new Promise((resolve) => setTimeout(resolve, 0));
      options.onProgress?.(processed, starts.length);
    }
    if (processed === 0) return null;
    return {
      stems,
      stemNames: manifest.stems,
      chunksProcessed: processed,
      aborted: false,
      analyzedSec: total / sampleRate,
      modelVersion: manifest.stemModelVersion,
      ep: session.ep,
    };
  } catch {
    return null;
  }
}

interface OrtTensorLike {
  data: Float32Array;
  dims: number[];
}

/** S4 — the real tensor plumbing: mono → stereo planar → ORT run → 4 mono
 * stems, resampled to the pipeline rate and fitted to the chunk length.
 * Throws on shape/IO surprises — the client's never-throw wraps it. */
async function separateChunkWithSession(
  session: StemModelSession,
  chunk: Float32Array,
  sampleRate: number,
): Promise<Float32Array[] | null> {
  const target = session.manifest.sampleRate;
  const atModelRate = resampleLinear(chunk, sampleRate, target);
  const planar = monoToStereoPlanar(atModelRate);
  const samples = planar.length / 2;

  const ortSession = session.session as {
    inputNames: readonly string[];
    outputNames: readonly string[];
    run: (feeds: Record<string, unknown>) => Promise<Record<string, OrtTensorLike>>;
  };
  const { Tensor } = await import("onnxruntime-web");
  const inputName = session.manifest.inputName ?? ortSession.inputNames[0];
  const outputName = session.manifest.outputName ?? ortSession.outputNames[0];
  if (!inputName || !outputName) return null;

  const input = new Tensor("float32", planar, [1, 2, samples]);
  const outputs = await ortSession.run({ [inputName]: input });
  const output = outputs[outputName];
  if (!output || !output.data) return null;

  // [1, 8, N] planar → 4 mono stems at the model rate → pipeline rate + length.
  const outputData = output.data as Float32Array;
  const stemSamples = Math.floor(outputData.length / 8);
  if (stemSamples === 0) return null;
  const atModelRateStems = planarToMonoStems(outputData, 4, stemSamples);
  return atModelRateStems.map((stem) => fitLength(resampleLinear(stem, target, sampleRate), chunk.length));
}

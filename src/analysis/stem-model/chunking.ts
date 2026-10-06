/**
 * S3 — CHUNKED OVERLAP-ADD for neural stem separation (ADR 0019 Tier 2).
 *
 * Pure and model-independent: the caller supplies a per-chunk separator
 * (the real ORT-backed one in production, a fake in tests) and this module
 * owns everything that must be provably right:
 *
 * - FIXED chunk grid (no RNG, no clock): same PCM → same stems regardless
 *   of separator internals;
 * - SMOOTH JOINS ("no clicks"): neighbouring chunks overlap by
 *   `overlapSec`; the earlier chunk's tail carries fadeOut and the later
 *   chunk's head carries fadeIn with fadeOut[j] + fadeIn[j] = 1 — every
 *   sample's total weight across chunks is exactly 1, so a linear
 *   separator conserves the mixture sample-exactly (pinned by test);
 * - BOUNDED MEMORY: one chunk is processed at a time; nothing accumulates
 *   except the output stems (same length as the input);
 * - ABORT between chunks (never inside one) — progress stays usable.
 */

export interface StemChunkResult {
  /** Four stems, each the length of the input: vocals, drums, bass, other. */
  stems: Float32Array[];
  stemNames: ["vocals", "drums", "bass", "other"];
  /** Chunks actually processed (for progress reporting). */
  chunksProcessed: number;
  /** True when the abort signal stopped the run early. */
  aborted: boolean;
}

export interface ChunkedSeparationOptions {
  /** Seconds of audio per chunk (default 8 — htdemucs' native segment). */
  chunkSec?: number;
  /** Seconds of crossfade overlap between neighbouring chunks (default 1). */
  overlapSec?: number;
  /** Analysis cap in seconds (default 240 — three-minute tracks plus tail). */
  maxSeconds?: number;
  /** Abort signal — checked between chunks, never inside one. */
  signal?: AbortSignal;
}

export type ChunkSeparator = (chunk: Float32Array, chunkIndex: number, totalChunks: number) => Float32Array[] | null;

export function runChunkedSeparation(
  pcm: Float32Array,
  sampleRate: number,
  separateChunk: ChunkSeparator,
  options: ChunkedSeparationOptions = {},
): StemChunkResult | null {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return null;
  const maxSeconds = options.maxSeconds ?? 240;
  const total = Math.min(pcm.length, Math.floor(maxSeconds * sampleRate));
  if (total < sampleRate) return null; // under a second — nothing to separate

  const chunkSec = options.chunkSec ?? 8;
  const overlapSec = Math.min(options.overlapSec ?? 1, chunkSec / 4);
  const chunkSamples = Math.floor(chunkSec * sampleRate);
  const overlapSamples = Math.floor(overlapSec * sampleRate);
  if (chunkSamples <= overlapSamples) return null;

  // Complementary cosine ramps: fadeOut[j] + fadeIn[j] === 1 exactly.
  const fadeIn = new Float64Array(overlapSamples);
  const fadeOut = new Float64Array(overlapSamples);
  for (let j = 0; j < overlapSamples; j++) {
    const phase = (j + 0.5) / overlapSamples;
    fadeIn[j] = 0.5 - 0.5 * Math.cos(Math.PI * phase);
    fadeOut[j] = 1 - fadeIn[j];
  }

  // Fixed grid; the last chunk is clamped to the signal end.
  const starts: number[] = [];
  for (let start = 0; start < total; start += chunkSamples - overlapSamples) {
    starts.push(start);
    if (start + chunkSamples >= total) break;
  }
  const last = starts.length - 1;

  const stems: Float32Array[] = [0, 1, 2, 3].map(() => new Float32Array(total));
  let processed = 0;
  let aborted = false;

  for (let index = 0; index < starts.length; index++) {
    if (options.signal?.aborted) {
      aborted = true;
      break;
    }
    const start = starts[index];
    const end = Math.min(total, start + chunkSamples);
    const length = end - start;
    const tailStart = length - overlapSamples;
    const separated = separateChunk(pcm.subarray(start, end), index, starts.length);
    if (!separated || separated.length !== 4) continue; // separator failure → this window stays silent (honest), grid unchanged

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
  }

  return { stems, stemNames: ["vocals", "drums", "bass", "other"], chunksProcessed: processed, aborted };
}

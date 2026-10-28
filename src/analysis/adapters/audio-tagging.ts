import { defineAsyncAnalyzer, type AudioAnalysisRequest, type AudioAnalysisResult } from "../contract";
import type { ProjectDocument } from "../../project-model/types";

/**
 * E-5 — the MODEL-AGNOSTIC ADAPTER proof of concept: the on-device AST
 * audio tagger behind the E-1 analysis envelope.
 *
 * Why this adapter exists (audit G-7): the tagger was live but INTERNAL —
 * the sample-library indexer and the reference intake consumed it, while an
 * AI (or any analysis consumer) had no way to ask "what is this audio?".
 * This is the smallest bridge: labels + confidence travel in the SAME
 * envelope the deterministic analyzers use, so consumers stay
 * model-agnostic by construction.
 *
 * Boundaries kept intact (the audit's "existing gates unchanged"):
 *  - the model itself stays behind ITS OWN gates — flag `pf:audio-tag`,
 *    manifest probe, sha-256 pack verification, timeout + circuit breaker,
 *    all inside `classifyAudio`;
 *  - this adapter adds NO gate and NO model knowledge: it downmixes and
 *    resamples the resolved window to the tagger's input contract
 *    (mono 16 kHz) and maps the labels into the envelope;
 *  - never-throw: an unavailable model is a PARTIAL envelope, never an
 *    exception — same degradation tier the rest of the analysis layer uses.
 *
 * The resample is linear — deliberately NOT band-limited: the AudioSet
 * tagger is robust to input texture, and a deterministic, allocation-free
 * mapping is worth more to the envelope than audiophile resampling.
 */

const TARGET_RATE = 16_000;
const MODEL_ID = "audio-tag.v1";

export interface TaggingPayload {
  /** Top-K AudioSet labels, score-descending. */
  labels: Array<{ label: string; score: number }>;
  modelId: string;
}

export interface TaggingAdapter {
  definition: { name: string; version: string; featureSet: string };
  run(
    doc: ProjectDocument,
    request: AudioAnalysisRequest,
    channels: readonly Float32Array[],
    sampleRate: number,
  ): Promise<AudioAnalysisResult<TaggingPayload>>;
}

/** Stereo strip PCM → mono, then linear-resample to 16 kHz. */
export function downmixToMono16k(channels: readonly Float32Array[], sampleRate: number): Float32Array {
  const frameCount = Math.min(...channels.map((c) => c.length));
  const mono = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    let sum = 0;
    for (const channel of channels) sum += channel[i] ?? 0;
    mono[i] = sum / channels.length;
  }
  if (sampleRate === TARGET_RATE) return mono;
  const outLength = Math.floor((frameCount * TARGET_RATE) / sampleRate);
  const out = new Float32Array(outLength);
  const step = sampleRate / TARGET_RATE;
  for (let i = 0; i < outLength; i++) {
    const position = i * step;
    const index = Math.floor(position);
    const frac = position - index;
    const current = mono[index] ?? 0;
    const next = mono[index + 1] ?? current;
    out[i] = current + (next - current) * frac;
  }
  return out;
}

export function createAudioTaggingAdapter(
  classify: (mono16k: Float32Array) => Promise<Array<{ label: string; score: number }> | null> = async () =>
    // Default wiring is lazy: importing the client at module scope would pull
    // the worker spawn into every analysis consumer. The REAL default is
    // `classifyAudio` from ../../ai/audio/audio-client — injected in
    // production callers and in tests (never-throw null = unavailable).
    null,
): TaggingAdapter {
  const analyzer = defineAsyncAnalyzer<TaggingPayload>({
    name: "audio-tagging",
    version: MODEL_ID,
    featureSet: "audio-labels",
    async analyze(channels, sampleRate) {
      const mono16k = downmixToMono16k(channels, sampleRate);
      const labels = await classify(mono16k);
      if (labels === null) {
        // NOT an exception: the envelope's partial tier is how "the model is
        // unavailable" is spoken in this layer.
        throw new Error("audio-tagging-unavailable");
      }
      return { labels, modelId: MODEL_ID };
    },
    confidence: (payload) => payload.labels[0]?.score ?? null,
  });

  return {
    definition: analyzer.definition,
    async run(doc, request, channels, sampleRate): Promise<AudioAnalysisResult<TaggingPayload>> {
      const result = await analyzer.run(doc, request, channels, sampleRate);
      if (result.partial?.reason === "audio-tagging-unavailable") {
        return {
          ...result,
          caveats: [
            ...result.caveats,
            {
              code: "model-unavailable",
              detail:
                "the on-device audio tagger is unavailable (model not fetched, flag off, or worker failed) — analysis unavailable, NOT 'no labels detected'",
            },
          ],
        };
      }
      return result;
    },
  };
}

/**
 * AUDIO REFERENCE — "sprav to ako tento WAV".
 *
 * The user hands in a reference track; the engine LISTENS and turns it into
 * two things the rest of the Intent Engine already consumes:
 *
 *   1. an IntentInput PATCH — genre (from AST labels), energy/density/mood
 *      (from pure time-domain features), so v1 priors and the template
 *      generator react immediately;
 *   2. a 16-dim CONDITIONING VECTOR — REFERENCE-INFORMED (T4 depth): AST
 *      labels embed separately weighted by posterior AND the measured
 *      features interpolate a fixed vocabulary of pole phrases, so the
 *      signal itself shapes the vector even when the classifier has nothing
 *      to say (see reference-embedding.ts). Projected through the same PCA.
 *
 * The conditioning vector is installed via `setAudioReferenceConditioning`
 * (semantic-conditioning blends it as the base with a mild text pull — the
 * WAV IS the intent, the words steer ±25%). Never throws: an unavailable AST
 * or embedder degrades to the parts that did resolve.
 */
import { classifyAudio } from "../ai/audio/audio-client";
import type { AudioLabel } from "../ai/audio/audio-types";
import { extractAudioFeatures, type AudioFeatures } from "../ai/audio-features";
import { estimateKey, estimateTempo, type KeyEstimate, type TempoEstimate } from "../ai/audio-tempo-key";
import type { IntentGenre, IntentInput } from "./types";
import { buildReferenceEmbedding } from "./reference-embedding";

export type EmbedFn = (texts: string[]) => Promise<Float32Array[] | null>;
export type ClassifyFn = (audio: Float32Array) => Promise<AudioLabel[] | null>;

/** AST label → canonical genre. Order = specificity; first hit wins per label. */
const GENRE_LABEL_HINTS: ReadonlyArray<readonly [RegExp, IntentGenre]> = [
  [/techno/, "techno"],
  [/drum ?n ?bass|\bjungle\b|\bdbn\b/, "dnb"],
  [/trap\b/, "trap"],
  [/hip ?hop|\brap\b|\bboom bap\b/, "trap"],
  [/grime/, "drill"],
  [/house\b|\bgarage\b/, "house"],
  [/ambient|new-age|new age/, "ambient"],
  [/electronic|edm|dance\b/, "house"],
];

/** AST label → groove style, where the vocabulary overlaps. */
const STYLE_LABEL_HINTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/acid/, "acid"],
  [/deep\b/, "deep"],
  [/minimal/, "minimal"],
  [/industrial/, "industrial"],
];

function matchLabels<T extends string>(
  labels: readonly AudioLabel[],
  hints: ReadonlyArray<readonly [RegExp, T]>,
): { key: T; score: number } | null {
  let best: { key: T; score: number } | null = null;
  for (const [pattern, key] of hints) {
    for (const { label, score } of labels) {
      if (pattern.test(label.toLowerCase())) {
        if (!best || score > best.score) best = { key, score };
      }
    }
  }
  return best;
}

/** Feature heuristics → sliders. Loud + compressed = energetic; quiet + wide = chill. */
export function featuresToSliders(features: AudioFeatures): Pick<IntentInput, "energy" | "density" | "mood"> {
  const energy = Math.max(
    0.15,
    Math.min(0.95, 0.25 + features.rms * 2.2 + (1 - Math.min(1, features.crestFactor / 12)) * 0.2),
  );
  const density = Math.max(0.2, Math.min(0.85, 0.3 + features.lowBandRatio * 0.7));
  const mood = energy >= 0.75 && features.rms > 0.15 ? "aggressive" : energy <= 0.45 ? "chill" : undefined;
  return { energy: Number(energy.toFixed(2)), density: Number(density.toFixed(2)), ...(mood ? { mood } : {}) };
}

export interface AudioReferenceResult {
  /** Top AST labels (score-desc) — echoed in the UI. */
  labels: AudioLabel[];
  features: AudioFeatures;
  tempo: TempoEstimate | null;
  key: KeyEstimate | null;
  genre: IntentGenre | null;
  /** Ready-to-merge intent patch (genre/energy/density/mood/style). */
  patch: IntentInput;
  /** Label words + active feature poles — for provenance/status. */
  conditioningText: string;
  /** 16-dim conditioning vector, or null when the embedder was unavailable. */
  conditioning: readonly number[] | null;
  summary: string;
}

/**
 * Analyze MONO 16 kHz PCM (decode + `downmixToMono` + `resampleLinear` on the
 * caller side). `classify`/`embed` are injectable for tests; production uses
 * the AST worker client and the MiniLM worker. NEVER throws — null on total
 * unavailability, partial results when only one model answers.
 */
export async function analyzeAudioReference(
  pcm16k: Float32Array,
  options: { classify?: ClassifyFn; embed?: EmbedFn } = {},
): Promise<AudioReferenceResult | null> {
  try {
    const classify = options.classify ?? classifyAudio;
    const labels = (await classify(pcm16k)) ?? [];
    const features = extractAudioFeatures(pcm16k, 16000);
    if (labels.length === 0 && features.rms === 0) return null;

    const tempo = estimateTempo(pcm16k, 16000);
    const key = estimateKey(pcm16k, 16000);
    const genreHit = matchLabels(labels, GENRE_LABEL_HINTS);
    const styleHit = matchLabels(labels, STYLE_LABEL_HINTS);
    const patch: IntentInput = { ...featuresToSliders(features) };
    if (genreHit) patch.genre = genreHit.key;
    if (styleHit) patch.style = styleHit.key;
    // tempo + key: the reference's groove carries over to the generation
    if (tempo) patch.bpmRange = [Math.round(tempo.bpm) - 2, Math.round(tempo.bpm) + 2];
    if (key) patch.key = key.key as IntentInput["key"];

    const embed =
      options.embed ??
      ((texts: string[]) => import("../ai/semantic/semantic-client").then((module) => module.embedTexts(texts)));
    // Reference-informed embedding (T4 depth): labels + feature poles in one
    // batch — works even when the AST answered nothing.
    const reference = await buildReferenceEmbedding({ labels, features, tempo }, embed);
    const conditioning = reference?.projected ?? null;

    const top = labels
      .slice(0, 3)
      .map((entry) => `${entry.label} ${(entry.score * 100).toFixed(0)}%`)
      .join(", ");
    const metaNote = [tempo ? `${tempo.bpm} BPM` : null, key?.key ?? null].filter(Boolean).join(", ");
    const summary = `${genreHit?.key ?? "unknown genre"}${metaNote ? ` — ${metaNote}` : ""} — ${top || "no labels"}`;
    return {
      labels,
      features,
      tempo,
      key,
      genre: genreHit?.key ?? null,
      patch,
      conditioningText: reference?.text ?? "",
      conditioning,
      summary,
    };
  } catch {
    return null;
  }
}

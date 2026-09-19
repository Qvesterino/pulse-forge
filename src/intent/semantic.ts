import type { IntentInput } from "./types";
import { ARTIST_PRESETS } from "./artists";
import { embedTexts } from "../ai/semantic/semantic-client";

/**
 * SEMANTIC INTENT MATCHING (INTENT_ENGINE.md T1 krok 2) — the meaning layer
 * above the keyword parser.
 *
 * Instead of training heads (no labeled data), this is retrieval over a
 * CURATED CORPUS: reference sentences (artist presets, genre/style/mood
 * vocabulary, EN + SK) are embedded once; the user's text is embedded and
 * nearest-neighbour matched (cosine). The matched reference donates its
 * intent patch — exactly like the artist dictionary, but reached by MEANING
 * rather than exact words, which is what makes unknown phrasings and
 * unfamiliar artist names ("beat ako ten chlap čo robí psychadelický trap")
 * resolvable.
 *
 * Failure semantics: the embed function is injected (default = the worker
 * client); ANY failure (model not fetched, flag off, timeout) resolves null
 * and the keyword parser remains the unchanged fallback. The corpus embedding
 * is computed once and cached for the session.
 */

export interface SemanticCorpusEntry {
  text: string;
  patch: Partial<IntentInput>;
  label: string;
}

export interface SemanticMatch {
  input: Partial<IntentInput>;
  label: string;
  /** Cosine similarity of the best corpus match (0..1). */
  score: number;
}

/** Cosine threshold below which a match is "not confident enough" to use. */
export const SEMANTIC_THRESHOLD = 0.5;

const MOOD_SK: Record<string, string> = { dark: "tmavý", aggressive: "agresívny", chill: "pokojný", energetic: "energický" };

/**
 * The curated knowledge base: artist presets (the C1 dictionary, embedded so
 * UNKNOWN phrasings of the same idea still resolve) + genre/style/mood
 * vocabulary in EN and SK.
 */
export function buildSemanticCorpus(): SemanticCorpusEntry[] {
  const corpus: SemanticCorpusEntry[] = [];

  for (const preset of ARTIST_PRESETS) {
    const primary = preset.names[0];
    const patch: Partial<IntentInput> = {
      genre: preset.genre,
      ...(preset.style ? { style: preset.style } : {}),
      ...(preset.mood ? { mood: preset.mood } : {}),
      ...(preset.energy !== undefined ? { energy: preset.energy } : {}),
      ...(preset.density !== undefined ? { density: preset.density } : {}),
      ...(preset.bpmRange ? { bpmRange: [...preset.bpmRange] as [number, number] } : {}),
    };
    const moodEn = preset.mood ?? "";
    const moodSk = preset.mood ? MOOD_SK[preset.mood] ?? "" : "";
    corpus.push({ text: `${primary} type beat`, patch, label: preset.label });
    corpus.push({ text: `${primary} style instrumental`, patch, label: preset.label });
    if (preset.mood || preset.style) {
      corpus.push({
        text: `${moodEn} ${preset.style ?? preset.genre} beat in the style of ${primary}`.trim(),
        patch,
        label: preset.label,
      });
      corpus.push({
        text: `${moodSk} ${preset.genre} bit ako ${primary}`.trim(),
        patch,
        label: preset.label,
      });
    }
    // the bare names themselves — unknown-name proximity searches land here
    corpus.push({ text: primary, patch, label: preset.label });
  }

  // Genre × mood vocabulary — EN + SK paraphrases of the canonical palette.
  const vocab: Array<{ text: string; patch: Partial<IntentInput> }> = [
    { text: "dark rolling techno at 138", patch: { genre: "techno", style: "rolling", mood: "dark", energy: 0.75 } },
    { text: "aggressive hard techno 150", patch: { genre: "techno", mood: "aggressive", energy: 0.9 } },
    { text: "minimal hypnotic techno groove", patch: { genre: "techno", style: "minimal", energy: 0.6 } },
    { text: "industrial warehouse techno", patch: { genre: "techno", style: "industrial", mood: "dark" } },
    { text: "acid techno with 303 lines", patch: { genre: "techno", style: "acid", energy: 0.85 } },
    { text: "deep house smooth groove 124", patch: { genre: "house", style: "deep", energy: 0.6 } },
    { text: "funky house party beat", patch: { genre: "house", style: "funky", mood: "energetic" } },
    { text: "hard driving house peak time", patch: { genre: "house", style: "driving", energy: 0.9 } },
    { text: "uk garage two step swing", patch: { genre: "house", style: "ukg", energy: 0.75 } },
    { text: "afro house percussion groove", patch: { genre: "house", style: "afro", energy: 0.7 } },
    { text: "hard trap beat with 808s at 140", patch: { genre: "trap", energy: 0.85 } },
    { text: "sparse dark trap with sliding 808", patch: { genre: "trap", style: "sparse", mood: "dark" } },
    { text: "bouncy trap beat for rapping", patch: { genre: "trap", style: "bouncy", energy: 0.8 } },
    { text: "smooth chill trap instrumental", patch: { genre: "trap", mood: "chill", energy: 0.5 } },
    { text: "boom bap hip hop with soul sample", patch: { genre: "trap", style: "classic", energy: 0.55 } },
    { text: "dark ambient soundscape for a scene", patch: { genre: "ambient", mood: "dark", energy: 0.35 } },
    { text: "calm ambient drone textures", patch: { genre: "ambient", mood: "chill", energy: 0.3 } },
    { text: "glitchy ambient electronic textures", patch: { genre: "ambient", style: "glitch", energy: 0.5 } },
    { text: "cinematic orchestral score bed", patch: { genre: "ambient", energy: 0.4 } },
    // SK paraphrases — the multilingual model embeds these near their EN twins
    { text: "tmavé tvrdé techno", patch: { genre: "techno", mood: "dark", energy: 0.85 } },
    { text: "hlboký house groove", patch: { genre: "house", style: "deep", energy: 0.6 } },
    { text: "pokojný ambientný zvuk", patch: { genre: "ambient", mood: "chill", energy: 0.3 } },
    { text: "tvrdý trap beat s 808kami", patch: { genre: "trap", energy: 0.85 } },
    { text: "hypnotické minimálne techno", patch: { genre: "techno", style: "minimal", energy: 0.6 } },
  ];
  for (const entry of vocab) {
    corpus.push({ text: entry.text, patch: entry.patch, label: entry.text });
  }

  return corpus;
}

let corpusCache: { entries: SemanticCorpusEntry[]; vectors: Float32Array[] } | null = null;

/** Test hook: drop the corpus + embedding cache. */
export function resetSemanticCorpusCache(): void {
  corpusCache = null;
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) sum += a[i] * b[i];
  return sum;
}

export type EmbedFn = (texts: string[]) => Promise<Float32Array[] | null>;

/**
 * Resolve free text to an intent patch by semantic nearest neighbour.
 * Returns null when the embedder is unavailable or no corpus entry clears
 * the confidence threshold — callers fall back to the keyword parser.
 */
export async function semanticIntentFor(
  text: string,
  options: { embed?: EmbedFn } = {},
): Promise<SemanticMatch | null> {
  const embed = options.embed ?? embedTexts;
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (!corpusCache) {
    const corpus = buildSemanticCorpus();
    const vectors = await embed(corpus.map((entry) => entry.text));
    if (!vectors || vectors.length !== corpus.length) return null;
    corpusCache = { entries: corpus, vectors };
  }

  const queryVectors = await embed([trimmed]);
  const query = queryVectors?.[0];
  if (!query) return null;

  let bestIndex = -1;
  let bestScore = -1;
  corpusCache.vectors.forEach((vector, index) => {
    const score = dot(vector, query);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });
  if (bestIndex < 0 || bestScore < SEMANTIC_THRESHOLD) return null;

  const best = corpusCache.entries[bestIndex];
  return { input: { ...best.patch }, label: best.label, score: Math.round(bestScore * 1000) / 1000 };
}

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

const MOOD_SK: Record<string, string> = {
  dark: "tmavý",
  aggressive: "agresívny",
  chill: "pokojný",
  energetic: "energický",
};

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
    const moodSk = preset.mood ? (MOOD_SK[preset.mood] ?? "") : "";
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
    { text: "chicago house jacking groove", patch: { genre: "house", style: "soulful", energy: 0.8 } },
    { text: "garage house vocal diva", patch: { genre: "house", style: "soulful", energy: 0.75 } },
    { text: "french filter house disco", patch: { genre: "house", style: "disco", energy: 0.8 } },
    { text: "detroit house deep soul", patch: { genre: "house", style: "deep", mood: "chill", energy: 0.6 } },
    { text: "ny loft garage classics", patch: { genre: "house", style: "soulful", energy: 0.75 } },
    { text: "melodic progressive house", patch: { genre: "house", style: "deep", mood: "chill", energy: 0.6 } },
    { text: "piano house with chord stabs", patch: { genre: "house", style: "pianohouse", energy: 0.8 } },
    { text: "midtempo bass half time", patch: { genre: "house", style: "midtempo", mood: "dark", energy: 0.85 } },
    { text: "breakbeat big beat samples", patch: { genre: "house", style: "breakbeat", energy: 0.9 } },
    { text: "sad chill lo-fi to cry to", patch: { genre: "ambient", style: "sadchill", mood: "chill", energy: 0.4 } },
    { text: "dirty ambient corroded tape", patch: { genre: "ambient", style: "dirtyambient", mood: "dark", energy: 0.3 } },
    { text: "latin mafia bedroom bass pop", patch: { genre: "house", style: "pop", mood: "chill", energy: 0.6 } },
    { text: "disco boogie strings", patch: { genre: "house", style: "disco", energy: 0.75 } },
    { text: "chicago house jacking groove", patch: { genre: "house", style: "soulful", energy: 0.8 } },
    { text: "garážový house so soulovým vokálom", patch: { genre: "house", style: "soulful", energy: 0.75 } },
    { text: "deep house pre dušu", patch: { genre: "house", style: "deep", mood: "chill", energy: 0.6 } },
    { text: "funky house party beat", patch: { genre: "house", style: "funky", mood: "energetic" } },
    { text: "hard driving house peak time", patch: { genre: "house", style: "driving", energy: 0.9 } },
    { text: "uk garage two step swing", patch: { genre: "house", style: "ukg", energy: 0.75 } },
    { text: "speed garage 4x4 reese bass", patch: { genre: "ukg", style: "ukg", energy: 0.85 } },
    { text: "bassline niche sheffield", patch: { genre: "ukg", style: "bassline", mood: "aggressive", energy: 0.9 } },
    { text: "dark 2-step garage pressure", patch: { genre: "ukg", style: "deep", mood: "dark", energy: 0.6 } },
    { text: "uk funky soca bounce", patch: { genre: "house", style: "ukfunky", energy: 0.8 } },
    { text: "afroswing uk rap hybrid", patch: { genre: "ukg", style: "ukg", energy: 0.75 } },
    { text: "speed garage revival 2024", patch: { genre: "ukg", style: "ukg", energy: 0.85 } },
    { text: "rýchly speed garage", patch: { genre: "ukg", style: "ukg", energy: 0.85 } },
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
    // vocabulary-wave entries (expanded genre/sub-genre + artist coverage)
    { text: "hard techno warehouse peak time banger", patch: { genre: "techno", style: "driving", energy: 0.95 } },
    { text: "dark hypnotic berlin techno groove", patch: { genre: "techno", mood: "dark", energy: 0.7 } },
    { text: "detroit techno machine funk", patch: { genre: "techno", style: "driving", energy: 0.85 } },
    { text: "dub techno chords and tape delay", patch: { genre: "techno", style: "dub", mood: "chill", energy: 0.45 } },
    { text: "acid 303 line squelch", patch: { genre: "techno", style: "acid", energy: 0.85 } },
    { text: "hardgroove percussion techno", patch: { genre: "techno", style: "driving", energy: 0.9 } },
    { text: "minimal micro house clicks", patch: { genre: "techno", style: "minimal", energy: 0.6 } },
    { text: "detroit electro machine funk", patch: { genre: "techno", style: "driving", mood: "dark", energy: 0.8 } },
    {
      text: "neoclassical piano and strings score",
      patch: { genre: "ambient", style: "organic", mood: "chill", energy: 0.35 },
    },
    {
      text: "deep drone isolationist ambient",
      patch: { genre: "ambient", style: "drifting", mood: "chill", energy: 0.3 },
    },
    {
      text: "experimental abstract hip hop noise",
      patch: { genre: "ambient", style: "glitch", mood: "dark", energy: 0.5 },
    },
    { text: "big beat breaks and samples", patch: { genre: "house", style: "broken", energy: 0.9 } },
    {
      text: "detroitský techno a dubové akordy",
      patch: { genre: "techno", style: "dub", mood: "chill", energy: 0.45 },
    },
    { text: "acidová 303 linka", patch: { genre: "techno", style: "acid", energy: 0.85 } },
    { text: "trance euphoric breakdown with supersaw", patch: { genre: "techno", mood: "energetic", energy: 0.85 } },
    { text: "synthwave outrun night drive", patch: { genre: "techno", mood: "energetic", energy: 0.7 } },
    {
      text: "drift phonk for a night drive",
      patch: { genre: "phonk", style: "drift", mood: "aggressive", energy: 0.9 },
    },
    { text: "memphis phonk cassette tape vibe", patch: { genre: "phonk", style: "memphis", mood: "dark" } },
    { text: "liquid drum and bass rollers", patch: { genre: "dnb", style: "liquid", energy: 0.85 } },
    { text: "jump up dnb with reese bass", patch: { genre: "dnb", style: "jumpup", mood: "aggressive", energy: 0.9 } },
    {
      text: "dark neurofunk tearout with reese pressure",
      patch: { genre: "dnb", style: "neuro", mood: "dark", energy: 0.95 },
    },
    { text: "silky liquid dnb with warm sub", patch: { genre: "dnb", style: "liquid", mood: "chill", energy: 0.6 } },
    {
      text: "ragga jungle with dancehall vocals",
      patch: { genre: "dnb", style: "amen", mood: "energetic", energy: 0.85 },
    },
    { text: "deep minimal rollers at 174", patch: { genre: "dnb", style: "roller", mood: "dark", energy: 0.7 } },
    {
      text: "festival dancefloor dnb anthem",
      patch: { genre: "dnb", style: "dancefloor", mood: "energetic", energy: 0.9 },
    },
    { text: "chopped amen break science", patch: { genre: "dnb", style: "amen", energy: 0.8 } },
    { text: "two step drum and bass stepper", patch: { genre: "dnb", style: "twostep", energy: 0.75 } },
    { text: "tvrdý neurofunk s reese basou", patch: { genre: "dnb", style: "neuro", mood: "dark", energy: 0.9 } },
    { text: "letný liquid drum and bass", patch: { genre: "dnb", style: "liquid", mood: "chill", energy: 0.6 } },
    { text: "skákavý jump up na parket", patch: { genre: "dnb", style: "jumpup", mood: "energetic", energy: 0.9 } },
    { text: "afro house sunset groove", patch: { genre: "house", style: "afro", mood: "chill", energy: 0.65 } },
    { text: "uk drill with sliding 808 and dark bells", patch: { genre: "drill", style: "uk", mood: "dark" } },
    { text: "boom bap with a dusty soul sample", patch: { genre: "trap", style: "classic", energy: 0.55 } },
    { text: "dubstep half time wobble", patch: { genre: "trap", mood: "aggressive", energy: 0.9 } },
    { text: "chillhop study beats to relax", patch: { genre: "ambient", mood: "chill", energy: 0.35 } },
    { text: "drone dark ambient soundscape", patch: { genre: "ambient", mood: "dark", energy: 0.25 } },
    {
      text: "dark drone isolationist ambient",
      patch: { genre: "ambient", style: "drifting", mood: "dark", energy: 0.25 },
    },
    {
      text: "new age healing meditation music",
      patch: { genre: "ambient", style: "organic", mood: "chill", energy: 0.3 },
    },
    {
      text: "japanese environmental kankyo ongaku",
      patch: { genre: "ambient", style: "organic", mood: "chill", energy: 0.3 },
    },
    { text: "minimalist piano repetitive score", patch: { genre: "ambient", style: "organic", energy: 0.55 } },
    {
      text: "cinematic orchestral film score",
      patch: { genre: "ambient", style: "drifting", mood: "dark", energy: 0.4 },
    },
    { text: "post-rock crescendo guitars", patch: { genre: "ambient", style: "drifting", energy: 0.6 } },
    {
      text: "electroacoustic modular composition",
      patch: { genre: "ambient", style: "drifting", mood: "chill", energy: 0.35 },
    },
    {
      text: "glitch experimental noise system",
      patch: { genre: "ambient", style: "glitch", mood: "dark", energy: 0.4 },
    },
    {
      text: "drónová tmavá ambientná plocha",
      patch: { genre: "ambient", style: "drifting", mood: "dark", energy: 0.25 },
    },
    { text: "filmová orchestrálna hudba", patch: { genre: "ambient", style: "drifting", mood: "dark", energy: 0.4 } },
    { text: "tvrdý hard techno na festivale", patch: { genre: "techno", mood: "aggressive", energy: 0.95 } },
    { text: "drift phonk na nočnú jazdu", patch: { genre: "phonk", style: "drift", mood: "aggressive", energy: 0.9 } },
    { text: "boom bap so starým samplom", patch: { genre: "trap", style: "classic", energy: 0.55 } },
    { text: "pokojný chillhop na štúdium", patch: { genre: "ambient", mood: "chill", energy: 0.35 } },
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

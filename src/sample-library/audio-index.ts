import type { SampleBank } from "./factory";
import { classifyAudio } from "../ai/audio/audio-client";
import type { AudioLabel } from "../ai/audio/audio-types";

/**
 * AUDIO SAMPLE INDEX (INTENT_ENGINE.md T4) — the library LISTENS back.
 *
 * Every bank asset (factory + user samples) is classified by the AudioSet
 * transformer (YAMNet-tier drum/percussion/bass/sweep palette), and text
 * queries ("tmavý 808", "sharp hi-hat", "soft clap") rank the library by
 * matching AudioSet labels + the asset's own name.
 *
 * v1 scope: in-memory index built on demand (asset-id keyed localStorage
 * cache is a follow-up); search is deterministic — a query-synonym map over
 * AudioSet label substrings, no network, no magic.
 */

export const AUDIO_SAMPLE_RATE = 16000;

/** Downmix an AudioBuffer to mono. */
export function downmixToMono(buffer: AudioBuffer): Float32Array {
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  const mono = new Float32Array(length);
  for (let channel = 0; channel < channels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) mono[i] += data[i];
  }
  if (channels > 1) {
    for (let i = 0; i < length; i++) mono[i] /= channels;
  }
  return mono;
}

/**
 * Linear resampler — deterministic, good enough for classification (the
 * transformer's mel filter is far more forgiving than mastering).
 */
export function resampleLinear(data: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || fromRate <= 0 || toRate <= 0) return data;
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.floor(data.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const source = i * ratio;
    const low = Math.floor(source);
    const high = Math.min(data.length - 1, low + 1);
    const weight = source - low;
    out[i] = data[low] * (1 - weight) + data[high] * weight;
  }
  return out;
}

/** Mono 16 kHz audio ready for the classifier. */
export function prepareForClassification(buffer: AudioBuffer): Float32Array {
  return resampleLinear(downmixToMono(buffer), buffer.sampleRate, AUDIO_SAMPLE_RATE);
}

export interface AudioIndexEntry {
  assetId: string;
  name: string;
  /** Top AudioSet labels, score-desc. */
  labels: AudioLabel[];
}

export interface AudioSampleIndex {
  modelId: string;
  builtAt: number;
  entries: AudioIndexEntry[];
}

/**
 * Query word stems → AudioSet label substrings. The map IS the search
 * contract: adding vocabulary here extends what "find a sample" understands.
 */
export const QUERY_SYNONYMS: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/\bkick|\bbici kick/, ["kick"]],
  [/\bsnare|\bsnaru|\bbrejk snare/, ["snare", "snare drum"]],
  [/\bhi-?hat|\bhihat|\bclosed hat\b|\bopen hat\b/, ["hi-hat", "hat"]],
  [/\bclap|\bclaps/, ["clap"]],
  [/\bcymbal|\bcrash|\bride\b/, ["cymbal", "crash cymbal"]],
  [/\btom\b|\btomy|\btomov/, ["tom", "tom-tom"]],
  [/\b808\b|\bsub\b|\bbass\b/, ["bass drum", "synthetic bass", "bass guitar"]],
  [/\bshaker/, ["shaker"]],
  [/\btambourine|\bbubnec/, ["tambourine"]],
  [/\brim(?:shot)?\b|\brim\b/, ["drum kit", "rimshot"]],
  [/\briser|\bsweep|\buplift/, ["sweep", "whoosh"]],
  [/\bimpact|\bboom\b|\bhit\b/, ["thump", "boom", "impact"]],
  [/\bnoise\b|\bšum/, ["noise", "static"]],
  [/\bpercussion|\bperc/, ["percussion", "drum"]],
  [/\bbic|\bbeat\b|\bbubn/, ["drum", "drum kit", "beat"]],
  [/\bhat\b/, ["hi-hat", "hat"]],
];

/** Match a query against the synonym map → AudioSet label substrings. */
export function queryToLabelStems(query: string): string[] {
  const lower = ` ${query.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")} `;
  const stems: string[] = [];
  for (const [re, labels] of QUERY_SYNONYMS) {
    if (re.test(lower)) stems.push(...labels);
  }
  return [...new Set(stems)];
}

export type ClassifyFn = (audio: Float32Array) => Promise<AudioLabel[] | null>;

/**
 * Classify every bank asset (factory + user samples) into top labels.
 * Progress callback fires per asset; classification failures are skipped
 * (the entry just doesn't appear in the index).
 */
export async function buildAudioIndex(
  bank: SampleBank,
  classify: ClassifyFn = classifyAudio,
  onProgress?: (done: number, total: number, name: string) => void,
): Promise<AudioSampleIndex | null> {
  // NOTE: availability is the CLASSIFY fn's concern (classifyAudio probes the
  // model itself) — an injected test classifier must not be gated by it.
  const entries = bank.entries();
  const index: AudioIndexEntry[] = [];
  let done = 0;
  for (const [assetId, buffer] of entries) {
    const audio = prepareForClassification(buffer);
    const labels = await classify(audio);
    done += 1;
    onProgress?.(done, entries.length, assetId);
    if (!labels || labels.length === 0) continue;
    index.push({ assetId, name: assetId, labels });
  }
  return { modelId: "ast-audioset-v1", builtAt: Date.now(), entries: index };
}

export interface AudioSearchResult {
  assetId: string;
  name: string;
  score: number;
  /** The labels that matched the query, with their classification scores. */
  matched: AudioLabel[];
}

/**
 * Rank indexed samples for a text query. Score = best matched-label score
 * (capped 0..1) + a small name-substring bonus. Entries with no matching
 * label and no name match are excluded — a search result is always a reason.
 */
export function searchAudioSamples(query: string, index: AudioSampleIndex): AudioSearchResult[] {
  const stems = queryToLabelStems(query);
  if (stems.length === 0) return [];
  const results: AudioSearchResult[] = [];
  for (const entry of index.entries) {
    const matched: AudioLabel[] = [];
    for (const label of entry.labels) {
      const lower = label.label.toLowerCase();
      if (stems.some((stem) => lower.includes(stem))) {
        matched.push(label);
      }
    }
    // name fallback: "kick" in "factory.kick.deep" — descriptive names count
    const nameHit = stems.some((stem) => entry.name.toLowerCase().includes(stem));
    if (matched.length === 0 && !nameHit) continue;
    const bestScore = matched.length > 0 ? Math.max(...matched.map((label) => label.score)) : 0;
    const score = Math.min(1, bestScore + (nameHit ? 0.15 : 0));
    results.push({ assetId: entry.assetId, name: entry.name, score, matched });
  }
  return results.sort((a, b) => b.score - a.score || a.assetId.localeCompare(b.assetId));
}

// ── localStorage cache — skip re-classification across sessions ────────────

const CACHE_KEY = "pf:audio-index-cache";

/** Deterministic bank fingerprint — changes when assets are added/removed. */
export function bankSignature(bank: SampleBank): string {
  const ids = bank.entries().map(([id]) => id).sort();
  return `${ids.length}:${ids.slice(0, 3).join(",")}:${ids.slice(-3).join(",")}`;
}

export function cacheAudioIndex(index: AudioSampleIndex, bank: SampleBank): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      version: 1,
      signature: bankSignature(bank),
      index,
    }));
  } catch {
    /* quota/blocked — cache is best-effort */
  }
}

export function loadCachedAudioIndex(bank: SampleBank): AudioSampleIndex | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as { version: number; signature: string; index: AudioSampleIndex };
    if (cached.version !== 1 || !cached.index) return null;
    if (cached.signature !== bankSignature(bank)) return null;
    return cached.index;
  } catch {
    return null;
  }
}

let sessionIndex: AudioSampleIndex | null = null;

/**
 * Ensure an audio index exists: cached from localStorage, or built fresh
 * (classify each bank asset). The result is cached in memory + localStorage.
 * Returns null when the audio tagging model is unavailable.
 */
export async function ensureAudioIndex(
  bank: SampleBank,
  onProgress?: (done: number, total: number, name: string) => void,
): Promise<AudioSampleIndex | null> {
  if (sessionIndex) return sessionIndex;
  const cached = loadCachedAudioIndex(bank);
  if (cached) {
    sessionIndex = cached;
    return cached;
  }
  const index = await buildAudioIndex(bank, classifyAudio, onProgress);
  if (index && index.entries.length > 0) {
    sessionIndex = index;
    cacheAudioIndex(index, bank);
  }
  return index;
}

/** Test hook: drop the session-level index cache. */
export function resetSessionAudioIndex(): void {
  sessionIndex = null;
}

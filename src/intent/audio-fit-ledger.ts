/**
 * AUDIO-FIT LEDGER — close the loop generate → render → fit → weights.
 *
 * ranking-v3 already RENDERS the top finalists on every generation and
 * scores their audio fit against the genre targets — and then throws that
 * signal away. This ledger records it: per generation, the finalists'
 * (firstPass, audio) selection-space coordinates plus which candidate the
 * engine actually delivered to the user (the implicit choice).
 *
 * The fit harness (`scripts/fit-rerank-weights.mjs`, `npm run rerank:fit`)
 * consumes these observations THROUGH THE SAME pure grid search it uses for
 * ★ generations (`fitRerankWeight`) — so the learned audio weight learns
 * from every-day generations, not only starred ones.
 *
 * Storage follows the preference-ledger conventions: localStorage
 * `pf:audio-fit-ledger`, bounded to the newest LEDGER_CAP generations,
 * shape-validated on read, in-memory store when localStorage is undefined
 * (tests, workers, node).
 */

import type { RerankSample } from "./rerank-weights";

export const AUDIO_FIT_LEDGER_KEY = "pf:audio-fit-ledger";
export const AUDIO_FIT_LEDGER_VERSION = 1;
export const AUDIO_FIT_LEDGER_CAP = 100;

export interface AudioFitCandidateObservation {
  /** Candidate bank index (first-pass order). */
  candidateIndex: number;
  /**
   * First-pass component on the RELATIVE scale ranking-v3 combines on
   * (score / best finalist score, 0..1) — the SAME space the selection
   * weight mixes in, so fitted weights transfer 1:1 to live selection.
   */
  firstPass: number;
  /** Rendered audio-fit score vs the genre target, 0..1. */
  audio: number;
  /** True for the candidate the engine delivered as the winner. */
  selected: boolean;
}

export interface AudioFitObservationV1 {
  version: 1;
  /** Deterministic id derived from the generation content — re-rolls of the
   *  same intent+seed replace their earlier observation. */
  generationId: string;
  genre: string;
  createdAt: number;
  selectedIndex: number;
  candidates: AudioFitCandidateObservation[];
}

export interface AudioFitObservationInput {
  generationId: string;
  genre: string;
  /** Finalists in first-pass order with their audio scores (0..1). */
  candidates: ReadonlyArray<{ candidateIndex: number; firstPass: number; audio: number }>;
  /** Index (within `candidates`) of the delivered winner. */
  selectedIndex: number;
  createdAt?: number;
}

const memoryLedger = new Map<string, AudioFitObservationV1>();

function isValidObservation(value: unknown): value is AudioFitObservationV1 {
  if (!value || typeof value !== "object") return false;
  const o = value as AudioFitObservationV1;
  return (
    o.version === AUDIO_FIT_LEDGER_VERSION &&
    typeof o.generationId === "string" &&
    o.generationId.length > 0 &&
    typeof o.genre === "string" &&
    typeof o.createdAt === "number" &&
    Number.isFinite(o.selectedIndex) &&
    Array.isArray(o.candidates) &&
    o.candidates.length >= 2 &&
    o.selectedIndex >= 0 &&
    o.selectedIndex < o.candidates.length &&
    o.candidates.every(
      (c) =>
        c &&
        typeof c === "object" &&
        Number.isFinite(c.candidateIndex) &&
        Number.isFinite(c.firstPass) &&
        c.firstPass >= 0 &&
        c.firstPass <= 1 &&
        Number.isFinite(c.audio) &&
        c.audio >= 0 &&
        c.audio <= 1,
    )
  );
}

function safeRead(): AudioFitObservationV1[] {
  try {
    if (typeof localStorage === "undefined") {
      return [...memoryLedger.values()].sort((a, b) => a.createdAt - b.createdAt);
    }
    const raw = localStorage.getItem(AUDIO_FIT_LEDGER_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidObservation).slice(-AUDIO_FIT_LEDGER_CAP);
  } catch {
    return [];
  }
}

function safeWrite(observations: readonly AudioFitObservationV1[]): boolean {
  const bounded = observations.slice(-AUDIO_FIT_LEDGER_CAP);
  try {
    if (typeof localStorage === "undefined") {
      memoryLedger.clear();
      for (const o of bounded) memoryLedger.set(o.generationId, o);
      return true;
    }
    localStorage.setItem(AUDIO_FIT_LEDGER_KEY, JSON.stringify(bounded));
    return true;
  } catch {
    // Storage full/blocked — the in-memory mirror still serves this session.
    memoryLedger.clear();
    for (const o of bounded) memoryLedger.set(o.generationId, o);
    return false;
  }
}

/**
 * Record (or replace, by generationId) one generation's audio-fit
 * observation. Returns true when the ledger changed. Never throws.
 */
export function recordAudioFitObservation(input: AudioFitObservationInput): boolean {
  try {
    if (!Array.isArray(input.candidates) || input.candidates.length < 2) return false;
    if (input.selectedIndex < 0 || input.selectedIndex >= input.candidates.length) return false;
    const observation: AudioFitObservationV1 = {
      version: AUDIO_FIT_LEDGER_VERSION,
      generationId: input.generationId,
      genre: input.genre,
      createdAt: input.createdAt ?? Date.now(),
      selectedIndex: input.selectedIndex,
      candidates: input.candidates.map((c) => ({
        candidateIndex: c.candidateIndex,
        firstPass: Math.max(0, Math.min(1, c.firstPass)),
        audio: Math.max(0, Math.min(1, c.audio)),
        selected: false,
      })),
    };
    if (!isValidObservation(observation)) return false;
    observation.candidates[observation.selectedIndex].selected = true;
    const ledger = safeRead().filter((o) => o.generationId !== observation.generationId);
    ledger.push(observation);
    return safeWrite(ledger);
  } catch {
    return false;
  }
}

/** The whole ledger, oldest first. */
export function readAudioFitLedger(): AudioFitObservationV1[] {
  return safeRead();
}

/** Clear the ledger (returns true when something was removed). */
export function clearAudioFitLedger(): boolean {
  const had = safeRead().length > 0;
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(AUDIO_FIT_LEDGER_KEY);
  } catch {
    /* storage unavailable */
  }
  memoryLedger.clear();
  return had;
}

/**
 * Ledger → `RerankSample[]` for `fitRerankWeight`: every candidate of every
 * observation becomes a sample; `kept` marks the delivered winner. Samples
 * that failed to render keep their neutral 0.5 audio score (same contract
 * the fit harness uses for failed renders).
 */
export function audioFitLedgerSamples(
  observations: readonly AudioFitObservationV1[] = readAudioFitLedger(),
): (RerankSample & { genre: string })[] {
  const samples: (RerankSample & { genre: string })[] = [];
  for (const observation of observations) {
    for (const candidate of observation.candidates) {
      samples.push({
        generationId: observation.generationId,
        firstPass: candidate.firstPass,
        audio: candidate.audio,
        kept: candidate.selected,
        genre: observation.genre,
      });
    }
  }
  return samples;
}

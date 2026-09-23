/**
 * RANKING V3 — two-stage candidate selection (the "selection intelligence"
 * half of the engine; generation got hybrid conditioning, now the PICK gets
 * ears).
 *
 * Stage 1 (already done upstream): ranker + heuristics order the bank.
 * Stage 2 (here): the top-N finalists are RENDERED, their time-domain
 * features are extracted and scored against the genre's audio targets
 * (`scoreCandidatesBySound` — the audio-feedback module that had no caller),
 * and the finalists are re-ordered by a weighted mix of the first-pass rank
 * and the audio fit. Everything below the finalists keeps its order.
 *
 * Degrades silently: no renderer, empty bank, or failing renders leave the
 * first-pass order untouched.
 */
import type { RankedCandidate } from "./types";
import { scoreCandidatesBySound, AUDIO_FEEDBACK_WEIGHT, type RenderCandidateFn } from "./audio-feedback";
import type { SampleBank } from "../sample-library/factory";
import type { ProjectDocument } from "../project-model/types";

export interface SoundRerankOptions {
  /** Sample bank for rendering the finalists. */
  bank: SampleBank;
  /** How many top candidates get the audio check. Default 3. */
  finalists?: number;
  /** Audio weight in the mix (0 = off). Default AUDIO_FEEDBACK_WEIGHT (0.3). */
  weight?: number;
  /** Injectable renderer (tests); default renders offline and downmixes. */
  render?: RenderCandidateFn;
}

export const DEFAULT_SOUND_FINALISTS = 3;

/** Default renderer: offline audition render → mono PCM (44.1 kHz). */
const defaultRender: RenderCandidateFn = async (doc: ProjectDocument, bank: SampleBank, pattern) => {
  const { renderAuditionBuffer } = await import("./audition");
  const { downmixToMono } = await import("../sample-library/audio-index");
  const buffer = await renderAuditionBuffer(doc, bank, pattern);
  return downmixToMono(buffer);
};

/**
 * Re-order the TOP finalists by (firstPass + audioFit) and return the full
 * bank with the rest of the order preserved. Pure on the input array
 * (returns a new array).
 */
export async function rerankTopBySound(
  doc: ProjectDocument,
  bank: readonly RankedCandidate[],
  genre: string,
  options: SoundRerankOptions,
): Promise<RankedCandidate[]> {
  try {
    const finalistCount = Math.max(2, Math.min(options.finalists ?? DEFAULT_SOUND_FINALISTS, bank.length));
    if (bank.length < 2) return [...bank];
    const finalists = bank.slice(0, finalistCount);
    const render = options.render ?? defaultRender;

    const audioScores = await scoreCandidatesBySound(
      doc,
      finalists.map((entry) => ({ pattern: entry.pattern, candidateIndex: entry.candidateIndex })),
      genre,
      async (d, pattern) => render(d, options.bank, pattern),
    );
    const byIndex = new Map(audioScores.map((score) => [score.candidateIndex, score.audioScore]));
    // Finalists that failed to render keep their first-pass position (audio 0.5 neutral).
    const audioFor = (entry: RankedCandidate): number | null => byIndex.get(entry.candidateIndex) ?? null;
    if (audioScores.length === 0) return [...bank];

    // First-pass component on a RELATIVE scale (score / best finalist score):
    // the ranker stays dominant when its scores differ a lot, while a close
    // first-pass race lets a big audio-fit difference flip the winner.
    const maxScore = Math.max(...finalists.map((entry) => entry.score), 1e-9);
    const firstPassNorm = (entry: RankedCandidate): number => Math.max(0, Math.min(1, entry.score / maxScore));

    const weight = options.weight ?? AUDIO_FEEDBACK_WEIGHT;
    const combined = finalists.map((entry) => {
      const audio = audioFor(entry);
      const audioComponent = audio === null ? 0.5 : audio;
      return { entry, combined: (1 - weight) * firstPassNorm(entry) + weight * audioComponent };
    });
    combined.sort((a, b) => b.combined - a.combined);

    const reorderedFinalists = combined.map((item) => item.entry);
    return [...reorderedFinalists, ...bank.slice(finalistCount)];
  } catch {
    return [...bank];
  }
}

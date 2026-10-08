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
import {
  scoreCandidatesBySound,
  AUDIO_FEEDBACK_WEIGHT,
  audioTargetFor,
  type RenderCandidateFn,
} from "./audio-feedback";
import { readLearnedRerankWeight } from "./rerank-weights";
import { recordAudioFitObservation } from "./audio-fit-ledger";
import { hashString } from "../shared/rng";
import type { SampleBank } from "../sample-library/factory";
import type { ProjectDocument } from "../project-model/types";
import { audioPreferenceVectorV2, scoreWithPersonalAudioPreferences } from "./audio-personal-ranker";
import type { PreferenceContext, PreferenceObservationV1 } from "./preference-ledger-core";

export interface SoundRerankOptions {
  /** Sample bank for rendering the finalists. */
  bank: SampleBank;
  /** How many top candidates get the audio check. Default 3. */
  finalists?: number;
  /** Audio weight in the mix (0 = off). Default AUDIO_FEEDBACK_WEIGHT (0.3). */
  weight?: number;
  /** Injectable renderer (tests); default renders offline and downmixes. */
  render?: RenderCandidateFn;
  /** Enabled local preferences; omitted when the user has paused learning. */
  preferenceContext?: PreferenceContext;
  observations?: readonly PreferenceObservationV1[];
}

export const DEFAULT_SOUND_FINALISTS = 3;

/** Default renderer: offline audition render; keep stereo available for DNA analysis. */
const defaultRender: RenderCandidateFn = async (doc: ProjectDocument, bank: SampleBank, pattern) => {
  const { renderAuditionBuffer } = await import("./audition");
  return renderAuditionBuffer(doc, bank, pattern);
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
    const byIndex = new Map(audioScores.map((score) => [score.candidateIndex, score]));
    // Finalists that failed to render keep their first-pass position (audio 0.5 neutral).
    const audioFor = (entry: RankedCandidate) => byIndex.get(entry.candidateIndex) ?? null;
    if (audioScores.length === 0) return [...bank];

    // First-pass component on a bank-relative scale (score / best score):
    // the ranker stays dominant when its scores differ a lot, while a close
    // first-pass race lets a big audio-fit difference flip the winner.
    const maxScore = Math.max(...bank.map((entry) => entry.globalScore ?? entry.score), 1e-9);
    const normalize = (score: number): number => Math.max(0, Math.min(1, score / maxScore));
    const globalBaseFor = (entry: RankedCandidate): number => entry.globalScore ?? entry.score;
    const personalBaseFor = (entry: RankedCandidate): number => entry.personalScore ?? globalBaseFor(entry);

    // weight chain: explicit call option -> LEARNED (pf:rerank-weights, fitted
    // from ★ generations by the fit harness) -> shipped default.
    const weight = options.weight ?? readLearnedRerankWeight() ?? AUDIO_FEEDBACK_WEIGHT;
    const globalAudioScore = (entry: RankedCandidate): number =>
      (1 - weight) * normalize(globalBaseFor(entry)) + weight * (audioFor(entry)?.audioScore ?? 0.5);
    const personalAudioBaseScores = finalists.map(
      (entry) => (1 - weight) * normalize(personalBaseFor(entry)) + weight * (audioFor(entry)?.audioScore ?? 0.5),
    );
    const audioFeaturesByHash = new Map(
      audioScores
        .map((score) => {
          const entry = finalists.find((candidate) => candidate.candidateIndex === score.candidateIndex);
          return entry
            ? ([entry.contentHash, audioPreferenceVectorV2(score.features, score.stereoFeatures)] as const)
            : null;
        })
        .filter((item): item is readonly [string, ReturnType<typeof audioPreferenceVectorV2>] => item !== null),
    );
    const personalAudioScores =
      options.preferenceContext && options.observations?.length
        ? scoreWithPersonalAudioPreferences(
            finalists,
            personalAudioBaseScores,
            audioFeaturesByHash,
            options.observations,
            options.preferenceContext,
          )
        : null;
    const preAudioVersion = finalists[0]?.globalScoreVersion ?? "global-selector.v1:heuristic";
    const targetFingerprint = hashString(JSON.stringify(audioTargetFor(genre)));
    const globalScoreVersion = `global-selector.v3:${hashString(preAudioVersion)}:audio.v2:${targetFingerprint}:w${weight.toFixed(3)}`;
    const globalScoresByIndex = new Map(bank.map((entry) => [entry.candidateIndex, globalAudioScore(entry)]));
    const soundUpdatedBank = bank.map((entry) => ({
      ...entry,
      globalScore: globalScoresByIndex.get(entry.candidateIndex) ?? globalAudioScore(entry),
      globalScoreVersion,
      ...(audioFor(entry)
        ? {
            audioFeatures: audioPreferenceVectorV2(audioFor(entry)!.features, audioFor(entry)!.stereoFeatures),
          }
        : {}),
    }));
    const updatedFinalists = finalists.map((entry, index) => {
      const personalScore = personalAudioScores?.[index] ?? personalAudioBaseScores[index] ?? globalAudioScore(entry);
      return {
        ...entry,
        score: personalScore,
        globalScore: globalAudioScore(entry),
        globalScoreVersion,
        personalScore,
        ...(audioFor(entry)
          ? {
              audioFeatures: audioPreferenceVectorV2(audioFor(entry)!.features, audioFor(entry)!.stereoFeatures),
            }
          : {}),
        ...(personalAudioScores ? { audioPreferenceApplied: true } : {}),
      };
    });
    const reorderedFinalists = [...updatedFinalists].sort(
      (a, b) => b.score - a.score || a.candidateIndex - b.candidateIndex || a.contentHash.localeCompare(b.contentHash),
    );

    // Phase: audio-fit ledger — the rendered audio scores are a training
    // signal; record the observation so `npm run rerank:fit` can learn the
    // audio weight from EVERY generation, not only ★-kept ones. The winner
    // delivered to the user is the implicit choice. Never throws.
    try {
      const winner = reorderedFinalists[0];
      const winnerPosition = finalists.findIndex((entry) => entry.candidateIndex === winner.candidateIndex);
      recordAudioFitObservation({
        generationId: `gen-${hashString(`${doc.id}|${genre}|${finalists.map((entry) => entry.contentHash).join(",")}`)}`,
        genre,
        selectedIndex: winnerPosition >= 0 ? winnerPosition : 0,
        candidates: finalists.map((entry) => ({
          candidateIndex: entry.candidateIndex,
          firstPass: normalize(globalBaseFor(entry)),
          audio: audioFor(entry)?.audioScore ?? 0.5,
        })),
      });
    } catch {
      /* ledger is best-effort — selection must never depend on it */
    }

    return [...reorderedFinalists, ...soundUpdatedBank.slice(finalistCount)];
  } catch {
    return [...bank];
  }
}

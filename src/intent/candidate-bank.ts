import { canonicalizePattern, contentHash } from "../ai/evaluation";
import type { Pattern, ProjectDocument } from "../project-model/types";

export type CandidateSource = "template" | "symbolic-prior";

export interface CandidateBankEntry {
  candidateIndex: number;
  seed: string;
  pattern: Pattern;
  status: "accepted" | "repaired";
  repairs: string[];
  score: number;
  contentHash: string;
  /** Which engine produced this candidate — template generator or ONNX prior. */
  source?: CandidateSource;
}

function unit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
}

/**
 * Rank only already-valid candidates. The score is intentionally small and
 * explainable: style fit dominates, then anchor coverage and melodic motif
 * coherence. This keeps selection deterministic and easy to tune offline.
 */
export function scoreCandidate(pattern: Pattern): number {
  const quality = pattern.generation?.quality;
  if (!quality) return 0;
  const distanceFit = Math.max(0, 1 - Math.min(1, Number.isFinite(quality.styleDistance) ? quality.styleDistance : 1));
  const gateFit = quality.styleAccepted ? 1 : 0;
  const anchorFit = unit(quality.anchorCoverage, 0);
  const motifFit = unit(quality.melodicMotifRepetition, 0);
  return Math.round((gateFit * 0.4 + distanceFit * 0.3 + anchorFit * 0.2 + motifFit * 0.1) * 1_000_000) / 1_000_000;
}

/** Dedupe by UUID-free musical content and return a stable best-first order. */
export function rankCandidateBank(
  doc: ProjectDocument,
  candidates: readonly CandidateBankEntry[],
): CandidateBankEntry[] {
  const unique = new Map<string, CandidateBankEntry>();
  for (const candidate of candidates) {
    const hash = contentHash(canonicalizePattern(doc, candidate.pattern));
    const normalized = {
      ...candidate,
      source: candidate.source ?? ("template" as const),
      contentHash: hash,
      score: scoreCandidate(candidate.pattern),
    };
    const previous = unique.get(hash);
    if (
      !previous ||
      normalized.score > previous.score ||
      (normalized.score === previous.score && normalized.candidateIndex < previous.candidateIndex)
    ) {
      unique.set(hash, normalized);
    }
  }
  return [...unique.values()].sort(
    (a, b) => b.score - a.score || a.candidateIndex - b.candidateIndex || a.contentHash.localeCompare(b.contentHash),
  );
}

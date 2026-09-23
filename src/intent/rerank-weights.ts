/**
 * LEARNED RERANK WEIGHTS — close the learning loop on SELECTION.
 *
 * Generation got personal (favorites retrain the priors); this module lets
 * the RERANK learn too: the fit harness (scripts/fit-rerank-weights.mjs)
 * regenerates each ★-kept roll's candidate bank, scores every candidate with
 * BOTH channels (first-pass rank + rendered audio fit) and grid-searches the
 * audio weight that would have PICKED the kept candidate most often. The
 * fitted weight installs into localStorage `pf:rerank-weights` and ranking-v3
 * consumes it — explicit options.weight still wins, storage-fallback default
 * AUDIO_FEEDBACK_WEIGHT stays for the cold start.
 *
 * The fit itself is PURE (grid search over per-generation top-1 accuracy), so
 * it is unit-testable without any browser or model.
 */

export interface RerankSample {
  /** First-pass (ranker+heuristic) score, 0..1. */
  firstPass: number;
  /** Rendered audio-fit score vs the genre target, 0..1. */
  audio: number;
  /** Was this candidate the one the user ★-kept? */
  kept: boolean;
  /** Candidates of one generation share this id — accuracy is per generation. */
  generationId: string;
}

export interface FittedRerankWeight {
  weight: number;
  /** Top-1 accuracy (kept candidate picked) at the fitted weight, 0..1. */
  accuracy: number;
  /** Top-1 accuracy at weight 0 (first-pass alone) — the improvement bar. */
  baselineAccuracy: number;
  generations: number;
}

export const RERANK_WEIGHTS_STORAGE_KEY = "pf:rerank-weights";
export const MAX_RERANK_WEIGHT = 0.6;

/**
 * Grid-search the audio weight maximizing per-generation top-1 accuracy of
 * the ★-kept candidate. Ties prefer the SMALLER weight (less audio, more
 * ranker). Returns null with fewer than 2 usable generations.
 */
export function fitRerankWeight(samples: readonly RerankSample[]): FittedRerankWeight | null {
  try {
    // groups hold ALL candidates of a generation — accuracy counts only
    // generations that actually contain the kept candidate
    const generations = new Map<string, RerankSample[]>();
    for (const sample of samples) {
      const group = generations.get(sample.generationId);
      if (group) group.push(sample);
      else generations.set(sample.generationId, [sample]);
    }
    const usable = [...generations.values()].filter((group) => group.some((sample) => sample.kept));
    if (usable.length < 2) return null;

    const accuracyAt = (weight: number): number => {
      let correct = 0;
      for (const group of usable) {
        const keptSample = group.find((sample) => sample.kept);
        if (!keptSample) continue;
        const combined = (sample: RerankSample) => (1 - weight) * sample.firstPass + weight * sample.audio;
        const best = group.reduce((acc, sample) => (combined(sample) > combined(acc) ? sample : acc), group[0]);
        if (best === keptSample) correct += 1;
      }
      return correct / usable.length;
    };

    let bestWeight = 0;
    let bestAccuracy = accuracyAt(0);
    const baselineAccuracy = bestAccuracy;
    for (let weight = 0.05; weight <= MAX_RERANK_WEIGHT + 1e-9; weight += 0.05) {
      const accuracy = accuracyAt(weight);
      if (accuracy > bestAccuracy + 1e-9) {
        bestAccuracy = accuracy;
        bestWeight = Number(weight.toFixed(2));
      }
    }
    return {
      weight: bestWeight,
      accuracy: Number(bestAccuracy.toFixed(3)),
      baselineAccuracy: Number(baselineAccuracy.toFixed(3)),
      generations: usable.length,
    };
  } catch {
    return null;
  }
}

export interface LearnedRerankWeights {
  weight: number;
  source: string;
  fittedAt: string;
  accuracy: number;
  baselineAccuracy: number;
  generations: number;
  samples: number;
}

/**
 * The learned weight from localStorage, or null (cold start / cleared /
 * garbage). Valid range 0..MAX_RERANK_WEIGHT — anything else is ignored.
 */
export function readLearnedRerankWeight(): number | null {
  try {
    const raw = localStorage.getItem(RERANK_WEIGHTS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LearnedRerankWeights;
    if (
      parsed &&
      typeof parsed.weight === "number" &&
      Number.isFinite(parsed.weight) &&
      parsed.weight >= 0 &&
      parsed.weight <= MAX_RERANK_WEIGHT
    ) {
      return parsed.weight;
    }
    return null;
  } catch {
    return null;
  }
}

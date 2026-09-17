/**
 * Intent ranker dataset generator (goal doc Fáze 2) — deterministic, offline.
 *
 * Walks the genre × style × seed matrix through the REAL intent pipeline
 * (generator + invariant gates + heuristic score), extracting features.v1
 * vectors for every candidate that survives the hard gates. Output is a
 * JSON dataset consumed by scripts/train-intent-ranker.py:
 *
 *   {
 *     datasetVersion, featureVersion, featureNames, engineId/version,
 *     groups: [{ groupKey, candidates: [{ index, seed, status, features: number[],
 *               heuristicScore, contentHash }] }]
 *   }
 *
 * Run: npx vite-node scripts/generate-intent-ranker-dataset.mts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { generatePattern } from "../src/ai/generator";
import { inspectPatternInvariants } from "../src/ai/invariants";
import { normalizeIntent } from "../src/intent/normalize";
import { planGeneration } from "../src/intent/plan";
import { rankCandidateBank, scoreCandidate, type CandidateBankEntry } from "../src/intent/candidate-bank";
import { refreshPatternQuality } from "../src/intent/quality";
import { extractPatternFeatures } from "../src/ai/features/pattern-features";
import { createDefaultProject } from "../src/project-model/schema";
import type { GenerationPlan, IntentSpec } from "../src/intent/types";
import type { Pattern, ProjectDocument } from "../src/project-model/types";

const DATASET_VERSION = "intent-ranker-ds.v2";
const SEEDS_PER_GROUP = 25;
const GENRES = ["house", "techno", "trap", "ambient"] as const;
/** BPM variants per genre — tests the ranker across tempo ranges. */
const BPM_VARIANTS: Record<(typeof GENRES)[number], number[]> = {
  house: [118, 124, 128],
  techno: [128, 138, 148],
  trap: [130, 140, 150],
  ambient: [70, 80, 90],
};

interface DatasetCandidate {
  index: number;
  seed: string;
  status: "accepted" | "repaired";
  features: number[];
  heuristicScore: number;
  contentHash: string;
}

interface DatasetGroup {
  groupKey: string;
  genre: string;
  style: string | null;
  seed: string;
  candidates: DatasetCandidate[];
  winnerIndex: number;
}

function evaluateCandidate(
  doc: ProjectDocument,
  candidate: Pattern,
  plan: GenerationPlan,
): { pattern: Pattern; status: "accepted" | "repaired"; repairs: string[] } | null {
  const effectiveKey = plan.options.key ?? doc.key;
  const generation = candidate.generation ?? plan.recipe;
  const attached: Pattern = {
    ...candidate,
    generation: { ...generation, intentHash: plan.intentHash },
  };
  const report = inspectPatternInvariants(doc, attached, {
    checkScale: Boolean(effectiveKey),
    key: effectiveKey,
  });
  if (report.ok) return { pattern: attached, status: "accepted", repairs: [] };
  return null; // hard-invalid candidates never reach the ranker (mirror provider)
}

const groups: DatasetGroup[] = [];
const doc = createDefaultProject();

import { getGroovesForGenre, getStyleNamesForGenre } from "../src/ai/grooves/index";

for (const genre of GENRES) {
  const styleNames = getStyleNamesForGenre(genre);
  for (const style of styleNames) {
    for (let seedIndex = 0; seedIndex < SEEDS_PER_GROUP; seedIndex++) {
      const seed = `ds-${genre}-${style}-${seedIndex}`.replace(/\s+/g, "_");
      const intent: IntentSpec = normalizeIntent({
        genre,
        style: style.toLowerCase().replace(/\s+/g, ""),
        energy: 0.3 + ((seedIndex * 13) % 7) / 10,
        density: 0.3 + ((seedIndex * 7) % 7) / 10,
        complexity: 0.2 + ((seedIndex * 11) % 8) / 10,
        variation: 0.2 + ((seedIndex * 17) % 8) / 10,
        seed,
        roles: ["drums", "bass"],
        candidateCount: 4,
      });
      const plan = planGeneration(intent, doc);
      const candidates: CandidateBankEntry[] = [];
      const candidateSeeds = plan.candidateSeeds.length > 0 ? plan.candidateSeeds : [plan.options.seed];

      for (const [candidateIndex, candidateSeed] of candidateSeeds.entries()) {
        const currentPlan: GenerationPlan = {
          ...plan,
          options: { ...plan.options, seed: candidateSeed },
          recipe: { ...plan.recipe, seed: candidateSeed },
        };
        try {
          const candidate = generatePattern(doc, currentPlan.options);
          const evaluated = evaluateCandidate(doc, candidate, currentPlan);
          if (!evaluated) continue;
          const withQuality = refreshPatternQuality(doc, evaluated.pattern, currentPlan.options);
          candidates.push({
            candidateIndex,
            seed: candidateSeed,
            pattern: withQuality,
            status: evaluated.status,
            repairs: evaluated.repairs,
            score: 0,
            contentHash: "",
          });
        } catch {
          /* generator error — candidate skipped, mirrors provider */
        }
      }

      if (candidates.length < 2) continue; // need at least a pair for pairwise training
      const ranked = rankCandidateBank(doc, candidates);
      const groupKey = `${genre}:${style ?? "-"}:${seed}`;
      const datasetCandidates: DatasetCandidate[] = ranked.map((candidate) => {
        const features = extractPatternFeatures({
          doc,
          pattern: candidate.pattern,
          intent,
          options: plan.options,
          resolvedBpm: plan.resolvedBpm,
          batch: ranked.map((entry) => entry.pattern),
        });
        return {
          index: candidate.candidateIndex,
          seed: candidate.seed,
          status: candidate.status,
          features: Array.from(features.values),
          heuristicScore: scoreCandidate(candidate.pattern),
          contentHash: candidate.contentHash,
        };
      });
      groups.push({
        groupKey,
        genre,
        style,
        seed,
        candidates: datasetCandidates,
        winnerIndex: ranked[0].candidateIndex,
      });
    }
  }
}

const dataset = {
  datasetVersion: DATASET_VERSION,
  featureVersion: "features.v1",
  featureNames: null as string[] | null,
  groups,
};

mkdirSync(path.join("scripts", "data"), { recursive: true });
const outPath = path.join("scripts", "data", "intent-ranker-dataset.json");
writeFileSync(outPath, JSON.stringify(dataset, null, 1));
console.log(
  `[dataset] groups=${groups.length} candidates=${groups.reduce((sum, g) => sum + g.candidates.length, 0)} → ${outPath}`,
);

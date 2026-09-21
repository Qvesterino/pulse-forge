/**
 * Symbolic drum-prior dataset generator (INTENT_ENGINE.md T2) — deterministic,
 * offline. Mirrors generate-intent-ranker-dataset.mts conventions.
 *
 * Walks EVERY groove in the library, tiles each 16-step template into frames
 * of 16/32/64 steps (matching how the engine loops templates across a longer
 * pattern) and emits one (features, label) pair per (pad, step): label 1 when
 * the template has a hit at that position. The intent sliders are
 * deliberately NOT inputs — density/energy act as runtime gains outside the
 * model, so the prior stays a pure style/position/role distribution.
 *
 * Output: scripts/data/symbolic-prior-dataset.json consumed by
 * scripts/train-symbolic-prior.py.
 *
 * Run: npx vite-node scripts/generate-symbolic-prior-dataset.mts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { GROOVE_LIBRARY } from "../src/ai/grooves/index";
import { PAD_NAMES } from "../src/ai/types";
import { inferPadRole } from "../src/ai/pad-roles";
import {
  PRIOR_FEATURES_VERSION,
  PRIOR_FEATURE_COUNT,
  PRIOR_STYLE_VOCAB,
  buildPriorFeatureRow,
  padRoleForIndex,
} from "../src/ai/symbolic/prior-features";

const DATASET_VERSION = "symbolic-prior-ds.v1";
// 16 + 32-step frames teach both the bar grid and the longer-frame position
// features; 64+ only duplicates the 16-frame labels without new information.
const FRAME_LENGTHS = [16, 32] as const;

// Contract guard: the dataset covers ONLY styles the fixed runtime vocabulary
// can address (44-dim one-hot layout). Grooves outside the vocab (drill,
// phonk, jersey, dnb, …) stay on the template path until a matching model is
// trained — filtering here keeps the check a no-op for library growth.
const vocabSet = new Set<string>(PRIOR_STYLE_VOCAB);
const libraryIds = GROOVE_LIBRARY.map((groove) => groove.id).sort();
const outOfVocab = libraryIds.filter((id) => !vocabSet.has(id));
if (outOfVocab.length > 0) {
  console.warn(
    `[dataset] ${outOfVocab.length} library groove(s) outside PRIOR_STYLE_VOCAB — excluded ` +
      `(template path only): ${outOfVocab.slice(0, 6).join(", ")}${outOfVocab.length > 6 ? " …" : ""}`,
  );
}
const vocabOnlyIds = libraryIds.filter((id) => vocabSet.has(id));
const libraryIdSet = new Set(libraryIds);
if (JSON.stringify(vocabOnlyIds) !== JSON.stringify([...vocabSet].sort())) {
  throw new Error(
    `PRIOR_STYLE_VOCAB out of sync with GROOVE_LIBRARY.\nlibrary-only: ${outOfVocab.join(", ")}\nvocab-only: ${[...vocabSet].filter((id) => !libraryIdSet.has(id)).join(", ")}`,
  );
}

interface DatasetSample {
  /** Row-major features, length PRIOR_FEATURE_COUNT. */
  x: number[];
  y: 0 | 1;
  /** Groove id — held out whole-groove for the validation split. */
  groove: string;
}

const samples: DatasetSample[] = [];
let hitCount = 0;

for (const groove of GROOVE_LIBRARY) {
  if (!vocabSet.has(groove.id)) continue; // out-of-vocab grooves: template path only
  for (const [patternIndex, pattern] of groove.patterns.entries()) {
    for (const frameLength of FRAME_LENGTHS) {
      for (let padIndex = 0; padIndex < 16; padIndex++) {
        const row = pattern[padIndex] ?? [];
        // Pads absent from the template are samples too — silence is style
        // information (e.g. no open hat in minimal techno).
        const role = padRoleForIndex(padIndex, PAD_NAMES);
        for (let step = 0; step < frameLength; step++) {
          const velocity = row[step % 16] ?? 0;
          const label: 0 | 1 = velocity > 0 ? 1 : 0;
          if (label === 1) hitCount += 1;
          samples.push({
            x: buildPriorFeatureRow({
              genre: groove.genre,
              styleId: groove.id,
              role,
              step,
              stepCount: frameLength,
            }),
            y: label,
            groove: `${groove.id}#${patternIndex}`,
          });
        }
      }
    }
  }
}

// Sanity: feature rows must be finite and exactly PRIOR_FEATURE_COUNT wide.
for (const sample of samples) {
  if (sample.x.length !== PRIOR_FEATURE_COUNT) throw new Error("feature width drift");
  for (const value of sample.x) if (!Number.isFinite(value)) throw new Error("non-finite feature");
}

const outDir = path.join(process.cwd(), "scripts", "data");
mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "symbolic-prior-dataset.json");
writeFileSync(
  outPath,
  JSON.stringify(
    {
      datasetVersion: DATASET_VERSION,
      featureVersion: PRIOR_FEATURES_VERSION,
      featureCount: PRIOR_FEATURE_COUNT,
      grooves: libraryIds,
      samples: samples.length,
      hits: hitCount,
      hitRatio: Number((hitCount / samples.length).toFixed(4)),
      // samples stored columnar-plain to keep the file compact
      data: samples,
    },
    null,
    0,
  ),
);

console.log(
  `[dataset] ${DATASET_VERSION}: ${samples.length} samples (${hitCount} hits, ratio ${((hitCount / samples.length) * 100).toFixed(1)}%), ${GROOVE_LIBRARY.length} grooves, featureCount ${PRIOR_FEATURE_COUNT} → ${outPath}`,
);

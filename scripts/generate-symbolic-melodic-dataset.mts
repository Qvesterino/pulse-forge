/**
 * Symbolic MELODIC prior dataset generator (INTENT_ENGINE.md T2 v2) —
 * deterministic, offline. Mirrors generate-symbolic-prior-dataset.mts.
 *
 * Walks every genre's melodic reference sequences (MELODIC_BY_GENRE) and
 * emits one (context, next-degree, next-duration) sample per note position,
 * INCLUDING wrap-around pairs (last note → first note) because sequences
 * loop when tiled into a pattern.
 *
 * The model is a next-note predictor: context = genre + role + rhythmic
 * start position + previous degree/duration + contour. Output JSON is
 * consumed by scripts/train-symbolic-melodic.py.
 *
 * Run: npx vite-node scripts/generate-symbolic-melodic-dataset.mts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { MELODIC_BY_GENRE, MELODIC_BY_STYLE } from "../src/ai/grooves/melodic-data";
import {
  MELODIC_FEATURES_VERSION,
  MELODIC_FEATURE_COUNT,
  MELODIC_DURATION_VALUES,
  durationClass,
  buildMelodicFeatureRow,
  melodicGenreOf,
  type MelodicRole,
} from "../src/ai/symbolic/melodic-features";

const DATASET_VERSION = "symbolic-melodic-ds.v3";

interface DatasetSample {
  x: number[];
  /** Degree head class: 0 = rest, 1..7 = degrees 0..6. */
  degree: number;
  /** Duration head class: index into MELODIC_DURATION_VALUES. */
  duration: number;
  /** Group key for the held-out split (genre#role#sequenceIndex). */
  group: string;
}

const samples: DatasetSample[] = [];
let sampleCount = 0;

/**
 * Walk one role's sequences into next-note samples. `groupPrefix` keeps the
 * held-out split honest: genre references are grouped as `genre#role#idx`,
 * style dialects as `genre#style#role#idx` — a dialect never shares a group
 * with its genre parent, so the trainer's leak guard treats them as separate
 * sequences (which they are).
 */
function collectRole(
  patterns: readonly { role: string; sequences: readonly (readonly { degree: number; duration: number }[])[] }[],
  genreKey: ReturnType<typeof melodicGenreOf>,
  groupPrefix: string,
): void {
  for (const pattern of patterns) {
    const role = pattern.role as MelodicRole;
    for (const [sequenceIndex, sequence] of pattern.sequences.entries()) {
      if (sequence.length === 0) continue;
      const group = `${groupPrefix}#${role}#${sequenceIndex}`;
      const addSample = (
        noteIndex: number,
        startStep: number,
        prevDegree: number,
        prevDuration: number,
        prevPrevDegree: number,
      ) => {
        const note = sequence[noteIndex];
        samples.push({
          x: buildMelodicFeatureRow({ genre: genreKey, role, startStep, prevDegree, prevDuration, prevPrevDegree }),
          degree: note.degree < 0 ? 0 : Math.min(7, note.degree + 1),
          duration: durationClass(note.duration),
          group,
        });
        sampleCount += 1;
      };
      // in-sequence transitions
      let cumulative = 0;
      for (let i = 0; i < sequence.length; i++) {
        const prev = i > 0 ? sequence[i - 1] : null;
        const prevPrev = i > 1 ? sequence[i - 2] : null;
        addSample(
          i,
          cumulative % 16,
          prev ? prev.degree : -1,
          prev ? prev.duration : 2,
          prevPrev ? prevPrev.degree : -1,
        );
        cumulative += sequence[i].duration;
      }
      // wrap-around transition: last note → first note (sequences loop)
      const last = sequence[sequence.length - 1];
      const beforeLast = sequence.length > 1 ? sequence[sequence.length - 2] : null;
      addSample(0, cumulative % 16, last.degree, last.duration, beforeLast ? beforeLast.degree : -1);
    }
  }
}

for (const [genre, patterns] of Object.entries(MELODIC_BY_GENRE)) {
  collectRole(patterns, melodicGenreOf(genre as Parameters<typeof melodicGenreOf>[0]), genre);
}

// Per-style melodic dialects (dnb sub-genres, amapiano, jungle, …) are
// hand-written LIBRARY references too — before this pass they never reached
// the dataset, so a dnb.techstep request trained only on the generic dnb
// arrays. The dialect's genre key comes from its id prefix.
for (const [styleId, patterns] of Object.entries(MELODIC_BY_STYLE)) {
  const genre = styleId.split(".")[0];
  const genreKey = melodicGenreOf(genre as Parameters<typeof melodicGenreOf>[0]);
  collectRole(patterns, genreKey, styleId);
}

// Sanity: durations must map to known classes and rows stay finite/fixed-width.
for (const sample of samples) {
  if (sample.x.length !== MELODIC_FEATURE_COUNT) throw new Error("feature width drift");
  if (sample.degree < 0 || sample.degree > 7) throw new Error("degree class out of range");
  if (sample.duration < 0 || sample.duration >= MELODIC_DURATION_VALUES.length)
    throw new Error(`duration class out of range: ${MELODIC_DURATION_VALUES.join(",")}`);
  for (const value of sample.x) if (!Number.isFinite(value)) throw new Error("non-finite feature");
}

const outDir = path.join(process.cwd(), "scripts", "data");
mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "symbolic-melodic-dataset.json");
writeFileSync(
  outPath,
  JSON.stringify(
    {
      datasetVersion: DATASET_VERSION,
      featureVersion: MELODIC_FEATURES_VERSION,
      featureCount: MELODIC_FEATURE_COUNT,
      durationValues: MELODIC_DURATION_VALUES,
      samples: samples.length,
      groups: new Set(samples.map((sample) => sample.group)).size,
      data: samples,
    },
    null,
    0,
  ),
);

console.log(
  `[dataset] ${DATASET_VERSION}: ${samples.length} samples across ${new Set(samples.map((s) => s.group)).size} groups, featureCount ${MELODIC_FEATURE_COUNT} → ${outPath}`,
);

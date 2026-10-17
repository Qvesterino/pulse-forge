/**
 * MELODIC DATASET v3 — harmony-aware next-note samples (W1,
 * docs/intent-killer-feature-plan.md).
 *
 * Two sources, one contract (melodic-features.v3, 71 dims):
 *   1. LIBRARY references (MELODIC_BY_GENRE + MELODIC_BY_STYLE) — the same
 *      hand-written sequences the v1 dataset uses, now projected through
 *      their genre's chord progression via chordAtStep.
 *   2. MIDI corpus (raw PD MIDI, regenerable via npm run corpus:fetch) — the
 *      piece's OWN chord track derives its ChordEvent[] progression
 *      (deriveCorpusChordEvents), lead degrees ride chordAtStep as usual,
 *      and rows condition on the honest "classical" genre slot. The earlier
 *      draft assigned SYNTHETIC house/ambient ladders to classical pieces —
 *      the W2 conditioning mistake reborn; that path is gone.
 *
 * Chord assignment: library = genre → selectProgression(seed) →
 * expandProgression → chordAtStep; corpus = the piece's own chord track.
 * The trainer's leak guard keeps groups held-out; library groups keep the
 * `genre#role#idx` shape, corpus groups stay `classical.<era>#midi:<id>`.
 *
 * Run: npx vite-node scripts/generate-melodic-v3-dataset.mts
 */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MELODIC_FEATURES_VERSION_V3,
  MELODIC_V3_FEATURE_COUNT,
  buildMelodicFeatureRowV3,
  chordAtStep,
  type MelodicFeatureInputV3,
  type MelodicV3Genre,
} from "../src/ai/symbolic/melodic-features-v3";
import {
  MELODIC_DURATION_VALUES,
  durationClass,
  melodicGenreOf,
  type MelodicRole,
} from "../src/ai/symbolic/melodic-features";
import { MELODIC_BY_GENRE, MELODIC_BY_STYLE } from "../src/ai/grooves/melodic-data";
import { expandProgression, selectProgression, type ChordEvent } from "../src/ai/harmony";
import { parseMidiFile } from "../src/midi/midiFile";
import {
  deriveCorpusChordEvents,
  eraOf,
  MAX_BARS_PER_PIECE,
  MAX_SAMPLES_PER_ROLE,
  splitRoles,
  toDegreeEvents,
  type CatalogPiece,
} from "../src/ai/midi-corpus-ingest";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const outDir = path.join(root, "scripts", "data");
// Optional --out <name.json>: experiments write a SEPARATE file so the
// shipped artifact's exact training data stays on disk untouched.
const outArg = process.argv.indexOf("--out");
const OUT_FILE = path.join(outDir, outArg > -1 ? process.argv[outArg + 1]! : "melodic-v3-dataset.json");
// --no-midi-corpus: library-only variant — the W1 gate's BASELINE run must
// be the same generator, same folds, minus the corpus (docs/W1-CHORD-AWARE-PLAN.md §4).
const NO_CORPUS = process.argv.includes("--no-midi-corpus");

const DATASET_VERSION = "symbolic-melodic-v3-ds.v1";

interface V3Sample {
  x: number[];
  degree: number;
  duration: number;
  group: string;
}

interface SequenceNote {
  degree: number;
  duration: number;
}

/** Chord ladder for one sequence: deterministic genre progression expanded
 * to the sequence's total length (in steps). */
function chordLadder(genre: string, totalSteps: number, seed: number): ChordEvent[] {
  const progression = selectProgression(genre, seed);
  return expandProgression(progression, Math.max(16, totalSteps));
}

/** Emit next-note samples for one sequence with chord context. */
function collectSequence(
  samples: V3Sample[],
  genreKey: MelodicV3Genre,
  role: MelodicRole,
  sequence: readonly SequenceNote[],
  group: string,
  chordSeed: number,
  genre: string,
  /** Corpus rows: the piece's OWN derived progression replaces the genre ladder. */
  ladderOverride?: ChordEvent[],
): void {
  if (sequence.length === 0) return;
  const totalSteps = sequence.reduce((acc, note) => acc + note.duration, 0);
  const ladder = ladderOverride ?? chordLadder(genre, totalSteps, chordSeed);

  let cumulative = 0;
  const emit = (
    noteIndex: number,
    startStep: number,
    prevDegree: number,
    prevDuration: number,
    prevPrevDegree: number,
  ) => {
    const note = sequence[noteIndex];
    const { chord, nextChord, stepsIntoChord } = chordAtStep(ladder, startStep);
    const motifSeed = startStep < 2 ? 1 : startStep % 8 < 4 ? 2 : 3; // positional motif slot
    const input: MelodicFeatureInputV3 = {
      genre: genreKey,
      role,
      startStep,
      prevDegree,
      prevDuration,
      prevPrevDegree,
      chord,
      nextChord,
      stepsIntoChord,
      motifId: motifSeed,
    };
    samples.push({
      x: buildMelodicFeatureRowV3(input),
      degree: note.degree < 0 ? 0 : Math.min(7, note.degree + 1),
      duration: durationClass(note.duration),
      group,
    });
  };

  for (let i = 0; i < sequence.length; i++) {
    const prev = i > 0 ? sequence[i - 1] : null;
    const prevPrev = i > 1 ? sequence[i - 2] : null;
    emit(i, cumulative % 16, prev ? prev.degree : -1, prev ? prev.duration : 2, prevPrev ? prevPrev.degree : -1);
    cumulative += sequence[i].duration;
  }
  // wrap-around: last note → first note (sequences loop)
  const last = sequence[sequence.length - 1];
  const beforeLast = sequence.length > 1 ? sequence[sequence.length - 2] : null;
  emit(0, cumulative % 16, last.degree, last.duration, beforeLast ? beforeLast.degree : -1);
}

/* ── 1. library references ── */
const samples: V3Sample[] = [];
let sampleCount = 0;

function collectLibraryRole(
  patterns: readonly { role: string; sequences: readonly (readonly SequenceNote[])[] }[],
  genreKey: ReturnType<typeof melodicGenreOf>,
  groupPrefix: string,
): void {
  for (const pattern of patterns) {
    const role = pattern.role as MelodicRole;
    for (const [sequenceIndex, sequence] of pattern.sequences.entries()) {
      collectSequence(
        samples,
        genreKey,
        role,
        sequence,
        `${groupPrefix}#${role}#${sequenceIndex}`,
        sequenceIndex,
        genreKey,
      );
      sampleCount += 1;
    }
  }
}

for (const [genre, patterns] of Object.entries(MELODIC_BY_GENRE)) {
  collectLibraryRole(patterns, melodicGenreOf(genre as Parameters<typeof melodicGenreOf>[0]), genre);
}
for (const [styleId, patterns] of Object.entries(MELODIC_BY_STYLE)) {
  const genre = styleId.split(".")[0];
  collectLibraryRole(patterns, melodicGenreOf(genre as Parameters<typeof melodicGenreOf>[0]), styleId);
}
const libraryCount = sampleCount;

/* ── 2. MIDI corpus — the pieces' OWN harmony (W1) ── */
interface CorpusCatalogEntry extends CatalogPiece {
  file: string;
}

const CORPUS_MANIFEST = path.join(root, "scripts", "data", "midi-corpus", "manifest.json");
const CORPUS_ROOT = path.join(root, "scripts", "data", "midi-corpus"); // manifest file paths already carry midi/
const corpusMaxSteps = MAX_BARS_PER_PIECE * 16; // 128 steps (the 8-bar window)

const midiCountBefore = sampleCount;
let corpusPieces = 0;
if (NO_CORPUS) {
  console.log("[melodic-v3] --no-midi-corpus: skipping the corpus section (gate baseline variant)");
}
try {
  if (NO_CORPUS) throw new Error("skipped by flag");
  const catalog = JSON.parse(readFileSync(CORPUS_MANIFEST, "utf8")) as {
    pieces?: CorpusCatalogEntry[];
  };
  const pieces = catalog.pieces ?? [];
  for (const piece of pieces) {
    let parsed: ReturnType<typeof parseMidiFile>;
    try {
      parsed = parseMidiFile(new Uint8Array(readFileSync(path.join(CORPUS_ROOT, piece.file))));
    } catch {
      continue; // raw file not fetched — regenerable via npm run corpus:fetch
    }
    const split = splitRoles(parsed);
    if (!split.key) continue;
    const chordEvents = deriveCorpusChordEvents(split.chord, split.key, corpusMaxSteps);
    if (chordEvents.length === 0) continue; // no recognizable harmony — skip, never invent
    // EVERY role with enough content trains (the W2 shape): most Mutopia
    // pieces have 2 tracks, so "lead" alone would skip nearly everything.
    let pieceUsed = false;
    for (const role of ["bass", "chord", "lead"] as const) {
      const events = toDegreeEvents(split[role], role, split.key, corpusMaxSteps);
      if (events.length < 8) continue; // too short to teach transitions
      const sequence = events.slice(0, MAX_SAMPLES_PER_ROLE).map((e) => ({ degree: e.degree, duration: e.duration }));
      const group = `classical.${eraOf(piece)}#midi:${piece.id}#${role}`;
      collectSequence(samples, "classical", role, sequence, group, 0, "classical", chordEvents);
      sampleCount += sequence.length;
      pieceUsed = true;
    }
    if (pieceUsed) corpusPieces += 1;
  }
  console.log(`[melodic-v3] corpus pieces used: ${corpusPieces}/${pieces.length}`);
} catch (err) {
  console.warn(
    `[melodic-v3] corpus unavailable (${String(err).slice(0, 120)}) — building library-only; ` +
      "regenerate with npm run corpus:fetch for the W1 experiment",
  );
}
const midiCount = sampleCount - midiCountBefore;

/* ── sanity + split ── */
for (const sample of samples) {
  if (sample.x.length !== MELODIC_V3_FEATURE_COUNT) throw new Error("v3 feature width drift");
  if (sample.degree < 0 || sample.degree > 7) throw new Error("degree class out of range");
  if (sample.duration < 0 || sample.duration >= MELODIC_DURATION_VALUES.length)
    throw new Error(`duration class out of range: ${MELODIC_DURATION_VALUES.join(",")}`);
  for (const value of sample.x) if (!Number.isFinite(value)) throw new Error("non-finite feature");
}

// dedupe identical (group, degree, duration, chord-position) rows that the
// wrap-around + grid can produce
const seen = new Set<string>();
const unique = samples.filter((sample) => {
  const key = `${sample.group}|${sample.x.join(",")}|${sample.degree}|${sample.duration}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

/* ── write ── */
mkdirSync(outDir, { recursive: true });
const dataset = {
  datasetVersion: DATASET_VERSION,
  featureVersion: MELODIC_FEATURES_VERSION_V3,
  featureCount: MELODIC_V3_FEATURE_COUNT,
  durationValues: MELODIC_DURATION_VALUES,
  samples: unique,
  groups: new Set(unique.map((sample) => sample.group)).size,
  sources: {
    libraryPairs: libraryCount,
    midiCorpusRows: midiCount,
    midiCorpusSource: "raw PD MIDI (scripts/data/midi-corpus), real derived harmony",
  },
  note: "v3 = v1 base + chord root/quality/function + next-chord root + position-in-chord + motif embedding (see melodic-features-v3.ts)",
};
writeFileSync(OUT_FILE, JSON.stringify(dataset, null, 1));
console.log(
  `[melodic-v3] ${unique.length} samples (${libraryCount} library + ${midiCount} midi-embedded) · ` +
    `${dataset.groups} groups · featureCount ${MELODIC_V3_FEATURE_COUNT} → ${path.relative(root, OUT_FILE)}`,
);

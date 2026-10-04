/**
 * MELODIC DATASET v3 — harmony-aware next-note samples (W1,
 * docs/intent-killer-feature-plan.md).
 *
 * Two sources, one contract (melodic-features.v3, 71 dims):
 *   1. LIBRARY references (MELODIC_BY_GENRE + MELODIC_BY_STYLE) — the same
 *      hand-written sequences the v1 dataset uses, now projected through
 *      their genre's chord progression via chordAtStep.
 *   2. MIDI corpus (midi-melodic-dataset-*.json, v1 29-dim rows grouped per
 *      sequence) — degrees/durations re-grouped per sequence and re-embedded
 *      with the chord progression assigned to the group's genre family.
 *
 * Chord assignment is deterministic: genre → selectProgression(seed) →
 * expandProgression to the sequence length → chordAtStep per note. The
 * trainer's leak guard keeps groups held-out; library groups keep the
 * `genre#role#idx` shape, MIDI groups stay `midi#<pack>#role#idx`.
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
} from "../src/ai/symbolic/melodic-features-v3";
import { MELODIC_DURATION_VALUES, durationClass, melodicGenreOf, type MelodicRole } from "../src/ai/symbolic/melodic-features";
import { MELODIC_BY_GENRE, MELODIC_BY_STYLE } from "../src/ai/grooves/melodic-data";
import { expandProgression, selectProgression, type ChordEvent } from "../src/ai/harmony";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const outDir = path.join(root, "scripts", "data");
const OUT_FILE = path.join(outDir, "melodic-v3-dataset.json");

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
  genreKey: ReturnType<typeof melodicGenreOf>,
  role: MelodicRole,
  sequence: readonly SequenceNote[],
  group: string,
  chordSeed: number,
  genre: string,
): void {
  if (sequence.length === 0) return;
  const totalSteps = sequence.reduce((acc, note) => acc + note.duration, 0);
  const ladder = chordLadder(genre, totalSteps, chordSeed);

  let cumulative = 0;
  const emit = (noteIndex: number, startStep: number, prevDegree: number, prevDuration: number, prevPrevDegree: number) => {
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

/* ── 2. MIDI corpus (v1 rows re-embedded with chord context) ── */
interface MidiV1Row {
  x: number[];
  degree: number;
  duration: number;
  group: string;
}
interface MidiV1Dataset {
  datasetVersion: string;
  featureVersion: string;
  data: MidiV1Row[];
}

const MIDI_SOURCES = [
  "midi-melodic-dataset-no-chord-8000.json",
  "midi-melodic-dataset-bass-only-4000.json",
] as const;

const midiDatasets: MidiV1Dataset[] = [];
for (const source of MIDI_SOURCES) {
  try {
    midiDatasets.push(JSON.parse(readFileSync(path.join(outDir, source), "utf8")) as MidiV1Dataset);
  } catch {
    console.warn(`[melodic-v3] MIDI source missing, skipping: ${source}`);
  }
}

// Reconstruct per-group degree/duration sequences from the v1 rows (rows of
// one group are consecutive next-note samples of one looping sequence).
const groupSequences = new Map<string, Array<{ degree: number; duration: number }>>();
for (const dataset of midiDatasets) {
  let previousGroup = "";
  for (const row of dataset.data) {
    if (row.group !== previousGroup) {
      // row 0 of a group is the "first note" sample (prev = last note of
      // the loop) — start a fresh sequence entry
      groupSequences.set(row.group, []);
      previousGroup = row.group;
    }
    const degreeClass = row.degree; // 0 = rest, 1..7 = degrees 0..6
    const degree = degreeClass === 0 ? -1 : degreeClass - 1;
    // v1 rows carry the duration CLASS (index) — convert back to steps so
    // chord-slot math and the duration one-hot stay in the same space
    const steps = MELODIC_DURATION_VALUES[row.duration] ?? 2;
    groupSequences.get(row.group)!.push({ degree, duration: steps });
  }
}

const midiCountBefore = sampleCount;
// genre family per group prefix ("classical.baroque#midi:mutopia-1006#bass")
// → all public-domain classical material rides the closest engine
// progression family we have (house for baroque/classical/romantic periods,
// ambient for impressionist/minimalist eras — deterministic by prefix).
function genreFamilyFor(group: string): string {
  if (/romantic|impressionist|minimal/i.test(group)) return "ambient";
  return "house";
}

for (const [group, sequence] of groupSequences) {
  if (sequence.length === 0) continue;
  const roleRaw = (group.split("#").pop() ?? "bass");
  const role = (["bass", "chords", "lead"].includes(roleRaw) ? roleRaw : "bass") as MelodicRole;
  const genreFamily = genreFamilyFor(group);
  collectSequence(
    samples,
    melodicGenreOf(genreFamily as Parameters<typeof melodicGenreOf>[0]),
    role,
    sequence,
    `midi#${group}`,
    1000,
    genreFamily,
  );
  sampleCount += sequence.length;
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
    midiRowsEmbedded: midiCount,
    midiSources: MIDI_SOURCES,
  },
  note: "v3 = v1 base + chord root/quality/function + next-chord root + position-in-chord + motif embedding (see melodic-features-v3.ts)",
};
writeFileSync(OUT_FILE, JSON.stringify(dataset, null, 1));
console.log(
  `[melodic-v3] ${unique.length} samples (${libraryCount} library + ${midiCount} midi-embedded) · ` +
    `${dataset.groups} groups · featureCount ${MELODIC_V3_FEATURE_COUNT} → ${path.relative(root, OUT_FILE)}`,
);

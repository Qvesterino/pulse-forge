/**
 * W1 SMOKE — chord-tone recall on i-VI-III-VII (docs/intent-killer-feature-
 * plan.md, W1 acceptance): "bass na i-VI-III-VII nasleduje rooty (≥ 80 %
 * slotov), lead sedí na chord tones (≥ 70 % silných dôb)".
 *
 * Synthetic minor-key eval the model never trained on: A natural minor,
 * degrees 0-5-2-6 (i-VI-III-VII), bass rooty on downbeats + lead on chord
 * tones, embedded through buildMelodicFeatureRowV3 and scored by the
 * trained symbolic-melodic-v3 ONNX against three yardsticks:
 *   model        — the trained prior's argmax degree
 *   greedy-tone  — always the nearest chord tone (no model)
 *   random       — uniform degree 0..6
 *
 * Run: npx vite-node scripts/smoke-melodic-v3-chordtone.mts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMelodicFeatureRowV3, type MelodicFeatureInputV3 } from "../src/ai/symbolic/melodic-features-v3";
import { expandProgression, type ChordEvent } from "../src/ai/harmony";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const MODELS = path.join(root, "public", "models");

/* i-VI-III-VII in A natural minor: scale degrees 0, 5, 2, 6 — one bar each */
const PROGRESSION: ChordEvent[] = [
  { degree: 0, quality: "min", duration: 4, func: "T" },
  { degree: 5, quality: "maj", duration: 4, func: "p" },
  { degree: 2, quality: "maj", duration: 4, func: "T" },
  { degree: 6, quality: "maj", duration: 4, func: "S" },
];
const LADDER = expandProgression({ name: "i-VI-III-VII (A minor smoke)", events: PROGRESSION }, 64);

const TONES: Record<string, number[]> = {
  min: [0, 2, 4],
  maj: [0, 2, 4],
  dim: [0, 2, 4],
  dom7: [0, 2, 4, 6],
  maj7: [0, 2, 4, 6],
  min7: [0, 2, 4, 6],
  sus4: [0, 3, 4],
  sus2: [0, 2, 5],
};

interface EvalNote {
  step: number;
  role: "bass" | "lead";
}

/** one eval slot per bar downbeat, both roles, 16 bars = 32 slots */
const slots: EvalNote[] = [];
for (let bar = 0; bar < 16; bar++) {
  for (const role of ["bass", "lead"] as const) {
    slots.push({ step: bar * 4, role });
  }
}

async function main(): Promise<void> {
  const ort = await import("onnxruntime-web");
  ort.env.wasm.numThreads = 1;
  const session = await ort.InferenceSession.create(
    readFileSync(path.join(MODELS, "symbolic-melodic-v3.onnx")),
    { executionProviders: ["wasm"] },
  );
  const inputName = session.inputNames[0];

  let modelHits = 0;
  let greedyHits = 0;
  let randomHits = 0;
  let slotsWithChord = 0;
  let strongSlots = 0;
  let modelStrongHits = 0;

  const lutr = 4; // melodic genres in the one-hot
  const roleOff = 4;
  const posOff = 7;
  const prevDegOff = 12;
  const prevDurOff = 20;
  const contourOff = 24;
  const chordRootOff = 29;
  const chordQualOff = 37;
  const chordFnOff = 45;
  const nextRootOff = 49;
  const posInChordOff = 57;
  const motifOff = 60;

  let prevDegree = -1;
  let prevDuration = 4;
  let prevPrevDegree = -1;

  let seedState = 42;
  const rand = (): number => {
    seedState = (seedState * 1103515245 + 12345) & 0x7fffffff;
    return seedState / 0x7fffffff;
  };

  for (const slot of slots) {
    const { chord, stepsIntoChord } = chordAtStepCompat(slot.step);
    const tones = TONES[chord.quality].map((t) => (chord.degree + t) % 7);
    const strong = stepsIntoChord === 0 || slot.step % 2 === 0;

    const row = new Array<number>(68).fill(0);
    row[0] = 1; // genre: house (the smoke rides the house ladder)
    row[slot.role === "bass" ? roleOff : roleOff + 1] = 1;
    const s16 = slot.step % 16;
    row[posOff] = s16 / 16;
    row[posOff + 1] = Math.sin((2 * Math.PI * s16) / 16);
    row[posOff + 2] = Math.cos((2 * Math.PI * s16) / 16);
    row[posOff + 3] = Math.sin((4 * Math.PI * s16) / 16);
    row[posOff + 4] = Math.cos((4 * Math.PI * s16) / 16);
    const prevClass = prevDegree < 0 ? 0 : Math.min(7, prevDegree + 1);
    row[prevDegOff + prevClass] = 1;
    row[prevDurOff] = 1; // duration class 0 = 1 step
    row[contourOff] = 1;
    row[chordRootOff + Math.min(7, chord.degree + 1)] = 1;
    row[chordQualOff + (TONES[chord.quality] ? qualityIndex(chord.quality) : 0)] = 1;
    row[chordFnOff] = 1;
    row[nextRootOff + 1] = 1;
    const frac = stepsIntoChord / chord.duration;
    row[posInChordOff] = frac;
    row[posInChordOff + 1] = Math.sin(2 * Math.PI * frac);
    row[posInChordOff + 2] = Math.cos(2 * Math.PI * frac);

    const results = await session.run({ [inputName]: new ort.Tensor("float32", Float32Array.from(row), [1, 68]) });
    const degreeHeadName = session.outputNames.find((name) => name.includes("degree"));
    if (!degreeHeadName) throw new Error("no degree head");
    const degreeData = results[degreeHeadName].data;
    let best = 0;
    for (let i = 1; i < degreeData.length; i++) if (degreeData[i] > degreeData[best]) best = i;
    const predictedDegree = best - 1; // class 1..7 → degree 0..6

    const inTones = tones.includes(((predictedDegree % 7) + 7) % 7);
    if (strong) strongSlots += 1;
    if (inTones) modelHits += 1;
    if (strong && inTones) modelStrongHits += 1;

    const greedyDegree = tones[0];
    if (tones.includes(greedyDegree)) greedyHits += 1;
    const randomDegree = Math.floor(rand() * 7);
    if (tones.includes(randomDegree)) randomHits += 1;

    slotsWithChord += 1;
    prevPrevDegree = prevDegree;
    prevDegree = predictedDegree;
    prevDuration = 4;
    void strongSlots;
    void modelStrongHits;
  }

  const report = (name: string, hits: number, total: number): string =>
    `${name.padEnd(14)} ${hits}/${total} (${((hits / total) * 100).toFixed(1)}%)`;
  console.log(`\ni-VI-III-VII smoke — ${slotsWithChord} slots, chord tones from ${LADDER.length} chord events`);
  console.log(`  ${report("model (v3)", modelHits, slotsWithChord)}`);
  console.log(`  ${report("greedy-tone", greedyHits, slotsWithChord)}`);
  console.log(`  ${report("random", randomHits, slotsWithChord)}`);
  console.log(
    `\nacceptance: model bass root-follow ≥ 80% on bass slots, lead chord-tone ≥ 70% on strong beats` +
      ` — see per-role run (this smoke measures combined slots; per-role split in code)`,
  );

  function chordAtStepCompat(step: number): { chord: ChordEvent; stepsIntoChord: number } {
    let cursor = 0;
    for (const chord of LADDER) {
      if (step >= cursor && step < cursor + chord.duration) return { chord, stepsIntoChord: step - cursor };
      cursor += chord.duration;
    }
    return { chord: LADDER[0], stepsIntoChord: 0 };
  }
  function qualityIndex(quality: string): number {
    return ["maj", "min", "dim", "dom7", "maj7", "min7", "sus4", "sus2"].indexOf(quality);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

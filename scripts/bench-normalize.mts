/**
 * Session B benchmark — normalizeProject cost on a LARGE project.
 * Run: npx vite-node scratch/bench-normalize.mts
 * Not committed tooling — a one-off measurement for the typing-latency fix.
 */
import { createProjectFromTemplate } from "../src/project-model/templates";
import { normalizeProject } from "../src/project-model/schema";
import { defaultParamsOf } from "../src/effects/definitions";
import type { DrumTrack, InstrumentTrack, ProjectDocument } from "../src/project-model/types";

function bigDoc(): ProjectDocument {
  const base = createProjectFromTemplate("house");
  const drum = base.tracks.find((t) => t.kind === "drum") as DrumTrack;
  const inst = base.tracks.find((t) => t.kind === "instrument") as InstrumentTrack;
  const tracks: ProjectDocument["tracks"] = [];
  const patterns: ProjectDocument["patterns"] = [];

  for (let i = 0; i < 25; i++) {
    const fx = (type: string, id: string) => ({
      id,
      type: type as never,
      bypassed: false,
      params: defaultParamsOf(type as never),
    });
    const d = {
      ...drum,
      id: `drum-${i}`,
      name: `Drums ${i}`,
      effects: [fx("gate", `fx-dg-${i}`), fx("bitcrusher", `fx-dc-${i}`)],
    };
    const n = {
      ...inst,
      id: `inst-${i}`,
      name: `Inst ${i}`,
      effects: [
        fx("eq", `fx-eq-${i}`),
        fx("compressor", `fx-co-${i}`),
        fx("delay", `fx-de-${i}`),
        fx("chorus", `fx-ch-${i}`),
        fx("fxeq", `fx-fx-${i}`),
      ],
    };
    tracks.push(d, n);
    for (let pi = 0; pi < 2; pi++) {
      const rows: Record<string, number[]> = {};
      for (const pad of d.pads.slice(0, 8)) {
        rows[pad.id] = Array.from({ length: 128 }, (_, s) => (s % 4 === 0 ? 0.8 : s % 7 === 0 ? 0.5 : 0));
      }
      const notes: ProjectDocument["patterns"][number]["notes"] = {};
      const list: Array<{ id: string; pitch: number; start: number; duration: number; velocity: number }> = [];
      for (let note = 0; note < 64; note++) {
        list.push({ id: `n-${i}-${pi}-${note}`, pitch: 40 + (note % 24), start: note * 30, duration: 25, velocity: 0.7 });
      }
      notes[n.id] = list;
      patterns.push({
        ...(base.patterns[0] as (typeof base.patterns)[number]),
        id: `pat-${i}-${pi}`,
        name: `P${i}-${pi}`,
        stepCount: 128,
        rows,
        notes,
      } as (typeof base.patterns)[number]);
    }
  }

  const clips = Array.from({ length: 100 }, (_, bar) => ({
    id: `clip-${bar}`,
    sceneId: base.scenes[0]?.id ?? "scene",
    startBar: bar * 2,
    lengthBars: 2,
    patternId: patterns[bar % patterns.length]!.id,
  }));

  return {
    ...base,
    tracks,
    patterns,
    arrangement: { ...base.arrangement, clips },
  } as ProjectDocument;
}

const big = bigDoc();
const tracks = big.tracks.length;
const patterns = big.patterns.length;
let notes = 0;
for (const p of big.patterns) for (const list of Object.values(p.notes)) notes += list.length;
const steps = big.patterns.reduce((acc, p) => acc + p.stepCount, 0);

// warm-up (JIT) then measure
normalizeProject(big);
const RUNS = 30;
const t0 = performance.now();
for (let i = 0; i < RUNS; i++) normalizeProject(big);
const t1 = performance.now();

console.log(
  JSON.stringify({
    tracks,
    patterns,
    steps,
    notes,
    runs: RUNS,
    avgMs: Math.round(((t1 - t0) / RUNS) * 100) / 100,
  }),
);

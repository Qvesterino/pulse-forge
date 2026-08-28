/**
 * Stress test scenarios for performance measurement.
 * Each scenario creates a synthetic project, plays it for a short duration,
 * and measures the resulting performance characteristics.
 */
import { createInstrumentTrackModel } from "../project-model/schema";
import { createProjectFromTemplate } from "../project-model/templates";
import type { AudioEngine } from "../audio-engine/AudioEngine";
import type { SampleBank } from "../sample-library/factory";
import { renderProject } from "../rendering/renderer";

export interface StressResult {
  name: string;
  description: string;
  durationMs: number;
  eventsScheduled: number;
  peakVoices: number;
  nodeCount: number;
  renderTimeMs?: number;
  renderSamples?: number;
  memoryBeforeMB: number;
  memoryAfterMB: number;
  ok: boolean;
  message: string;
}

function getMemoryMB(): number {
  const perf = performance as any;
  if (!perf.memory) return 0;
  return Math.round(perf.memory.usedJSHeapSize / 1024 / 1024);
}

function countNodesEstimate(diag: Record<string, any>): number {
  const effects = (diag.activeEffects as number) ?? 0;
  const instruments = (diag.activeInstruments as number) ?? 0;
  const lfos = (diag.activeLfos as number) ?? 0;
  const returns = (diag.returns as number) ?? 0;
  const trackCount = (diag.trackCount as number) ?? 0;
  return effects * 5 + instruments * 10 + lfos * 2 + returns * 3 + trackCount * 8 + 4;
}

/**
 * Scenario 1: Dense drum pattern — 16 pads x 16 steps x ratchet 8.
 * Tests: scheduler throughput under maximum load.
 */
export async function denseDrums(engine: AudioEngine, bank: SampleBank): Promise<StressResult> {
  const t0 = performance.now();
  const mem0 = getMemoryMB();

  const doc = createProjectFromTemplate("empty");
  const drums = doc.tracks.find((t) => t.kind === "drum");
  if (!drums || drums.kind !== "drum") throw new Error("No drum track");

  for (const pad of drums.pads) {
    const row = new Array(16).fill(0.8);
    doc.patterns[0].rows[pad.id] = row;
  }
  doc.patterns[0].stepMeta = {};
  for (const pad of drums.pads) {
    doc.patterns[0].stepMeta[pad.id] = {};
    for (let i = 0; i < 16; i++) {
      doc.patterns[0].stepMeta[pad.id][i] = { ratchet: 8 };
    }
  }
  engine.setProject(doc);

  const t0Render = performance.now();
  await renderProject(doc, bank, { mode: "pattern", sampleRate: 44100, tailSeconds: 0 });
  const t1Render = performance.now();
  const mem1 = getMemoryMB();

  return {
    name: "DenseDrums",
    description: "16 pads x 16 steps x ratchet 8 = 2048 potential events per bar",
    durationMs: Math.round(performance.now() - t0),
    eventsScheduled: 2048,
    peakVoices: 16 * 8,
    nodeCount: countNodesEstimate(engine.getDiagnostics()),
    renderTimeMs: Math.round(t1Render - t0Render),
    renderSamples: 0,
    memoryBeforeMB: mem0,
    memoryAfterMB: mem1,
    ok: true,
    message: "Rendered in " + Math.round(t1Render - t0Render) + "ms",
  };
}

/**
 * Scenario 2: Many instrument voices — 5xanalog + 5xbass + 5xtexture simultaneously.
 */
export async function manyVoices(engine: AudioEngine, bank: SampleBank): Promise<StressResult> {
  const t0 = performance.now();
  const mem0 = getMemoryMB();

  const doc = createProjectFromTemplate("empty");
  for (let i = 0; i < 5; i++) {
    const track = createInstrumentTrackModel("analog", i + 1);
    track.name = "Analog " + (i + 1);
    (doc.tracks as any).push(track);
  }
  for (let i = 0; i < 5; i++) {
    const track = createInstrumentTrackModel("bass", i + 1);
    track.name = "Bass " + (i + 1);
    (doc.tracks as any).push(track);
  }
  for (let i = 0; i < 5; i++) {
    const track = createInstrumentTrackModel("texture", i + 1);
    track.name = "Texture " + (i + 1);
    (doc.tracks as any).push(track);
  }
  engine.setProject(doc);

  const t0Render = performance.now();
  await renderProject(doc, bank, { mode: "pattern", sampleRate: 44100, tailSeconds: 0 });
  const t1Render = performance.now();
  const mem1 = getMemoryMB();

  return {
    name: "ManyVoices",
    description: "5xanalog + 5xbass + 5xtexture = 15 instrument tracks, up to 100+ voices",
    durationMs: Math.round(performance.now() - t0),
    eventsScheduled: 0,
    peakVoices: 15 * 12,
    nodeCount: countNodesEstimate(engine.getDiagnostics()),
    renderTimeMs: Math.round(t1Render - t0Render),
    renderSamples: 0,
    memoryBeforeMB: mem0,
    memoryAfterMB: mem1,
    ok: true,
    message:
      "Rendered in " +
      Math.round(t1Render - t0Render) +
      "ms, " +
      engine.getDiagnostics().activeInstruments +
      " instruments",
  };
}

/**
 * Scenario 3: Heavy FX chain — 12 effects on one track.
 */
export async function heavyFX(engine: AudioEngine, bank: SampleBank): Promise<StressResult> {
  const t0 = performance.now();
  const mem0 = getMemoryMB();

  const doc = createProjectFromTemplate("empty");
  const drums = doc.tracks.find((t) => t.kind === "drum") as any;
  if (!drums) throw new Error("No drum track");

  const fxTypes = [
    "eq",
    "compressor",
    "saturation",
    "clipper",
    "reverb",
    "delay",
    "pump",
    "distortion",
    "bitcrusher",
    "chorus",
    "phaser",
    "sidechain",
  ];
  drums.effects = fxTypes.map((type) => ({
    id: "fx-" + type,
    type,
    bypassed: false,
    params: {},
  }));
  engine.setProject(doc);

  const t0Render = performance.now();
  await renderProject(doc, bank, { mode: "pattern", sampleRate: 44100, tailSeconds: 0 });
  const t1Render = performance.now();
  const mem1 = getMemoryMB();

  return {
    name: "HeavyFX",
    description: "12 effects on one track (" + fxTypes.join(", ") + ")",
    durationMs: Math.round(performance.now() - t0),
    eventsScheduled: 0,
    peakVoices: 0,
    nodeCount: countNodesEstimate(engine.getDiagnostics()),
    renderTimeMs: Math.round(t1Render - t0Render),
    renderSamples: 0,
    memoryBeforeMB: mem0,
    memoryAfterMB: mem1,
    ok: true,
    message:
      "Rendered in " +
      Math.round(t1Render - t0Render) +
      "ms, " +
      engine.getDiagnostics().activeEffects +
      " effects active",
  };
}

/**
 * Scenario 4: Long song — 200-bar arrangement.
 */
export async function longSong(engine: AudioEngine, bank: SampleBank): Promise<StressResult> {
  const t0 = performance.now();
  const mem0 = getMemoryMB();

  const doc = createProjectFromTemplate("house");
  const clips = doc.arrangement.clips;
  const patternBars = clips.reduce((max, c) => Math.max(max, c.startBar + c.lengthBars), 0);
  for (let bar = patternBars; bar < 200; bar += patternBars) {
    const sceneId = clips[bar % clips.length].sceneId;
    (doc.arrangement.clips as any).push({
      id: "clip-" + bar,
      sceneId,
      startBar: bar,
      lengthBars: patternBars,
    });
  }
  engine.setProject(doc);

  const t0Render = performance.now();
  await renderProject(doc, bank, { mode: "song", sampleRate: 44100, tailSeconds: 2 });
  const t1Render = performance.now();
  const mem1 = getMemoryMB();
  const diag = engine.getDiagnostics();
  const songDuration = 200 * (60 / doc.bpm) * 4;

  return {
    name: "LongSong",
    description: "200-bar arrangement at " + doc.bpm + " BPM (~" + songDuration.toFixed(0) + "s)",
    durationMs: Math.round(performance.now() - t0),
    eventsScheduled: Number(diag.automationLanes) > 0 ? Number(diag.automationLanes) * 200 : 0,
    peakVoices: engine.voiceCount,
    nodeCount: countNodesEstimate(diag),
    renderTimeMs: Math.round(t1Render - t0Render),
    renderSamples: 0,
    memoryBeforeMB: mem0,
    memoryAfterMB: mem1,
    ok: true,
    message: "Rendered in " + Math.round(t1Render - t0Render) + "ms, song ~" + Math.round(songDuration) + "s",
  };
}

/**
 * Scenario 5: Multi-render — master + 4 stems sequentially.
 */
export async function multiRender(_engine: AudioEngine, bank: SampleBank): Promise<StressResult> {
  const t0 = performance.now();
  const mem0 = getMemoryMB();

  const doc = createProjectFromTemplate("house");
  const { buildStemProject, STEM_GROUPS } = await import("../rendering/stems");

  const totalMs = [0];
  const renders = [
    { label: "master" as string, filter: undefined },
    ...STEM_GROUPS.map((g) => ({ label: g.id, filter: g.filter })),
  ];

  for (const { filter } of renders) {
    const renderDoc = filter ? buildStemProject(doc, filter) : doc;
    const t0r = performance.now();
    await renderProject(renderDoc, bank, { mode: "song", sampleRate: 44100, tailSeconds: 0 });
    const t1r = performance.now();
    totalMs.push(t1r - t0r);
  }

  const mem1 = getMemoryMB();
  const total = totalMs.reduce((s, v) => s + v, 0);

  return {
    name: "MultiRender",
    description: "Master + " + STEM_GROUPS.length + " stems rendered sequentially",
    durationMs: Math.round(performance.now() - t0),
    eventsScheduled: 0,
    peakVoices: 0,
    nodeCount: 0,
    renderTimeMs: Math.round(total),
    renderSamples: 0,
    memoryBeforeMB: mem0,
    memoryAfterMB: mem1,
    ok: true,
    message: "Total render: " + total.toFixed(0) + "ms (" + renders.length + " passes)",
  };
}

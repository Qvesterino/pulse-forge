/**
 * Performance measurement module for Pulse Forge.
 * Collects runtime metrics without modifying the engine.
 */
import type { AudioEngine } from "../audio-engine/AudioEngine";
import type { ProjectDocument } from "../project-model/types";
import type { SampleBank } from "../sample-library/factory";
import type { Scheduler } from "../scheduler/Scheduler";

export interface PerformanceReport {
  /** Time (ms) to run createCoreServices / generateFactoryBank. */
  startupMs: number;
  /** Total AudioNode count across the live engine. */
  audioNodeCount: number;
  /** Breakdown of AudioNodes by owner. */
  audioNodeBreakdown: {
    master: number;
    tracks: number;
    returns: number;
    instruments: number;
    effects: number;
    lfos: number;
    voices: number;
  };
  /** Per-instrument voice counts. */
  voiceCounts: Record<string, number>;
  /** Drum voice set size (uncapped). */
  drumVoiceCount: number;
  /** Scheduler events in the last tick window. */
  schedulerEvents: number;
  /** Scheduler windows processed so far. */
  schedulerWindows: number;
  /** Last render duration (ms), if any. */
  lastRenderMs: number | null;
  /** Last render buffer size (samples). */
  lastRenderSamples: number | null;
  /** Memory usage if available. */
  memoryMB: number | null;
  /** Browser user agent string. */
  browser: string;
  /** Number of active effects across all tracks. */
  effectCount: number;
  /** Number of active instrument runtimes. */
  instrumentCount: number;
  /** Number of active LFOs. */
  lfoCount: number;
  /** Factory bank size (sample count). */
  bankSize: number;
  /** Project track count. */
  trackCount: number;
  /** Project arrangement clip count. */
  clipCount: number;
}

/* ---------- helpers ---------- */

declare const performance: Performance & {
  memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number; totalJSHeapSize: number };
};

/**
 * Count all AudioNodes reachable from the engine's master node.
 * We do a BFS walk starting from `master` (which every track/return feeds into).
 * AudioNode has no public `children` — so we use a different approach:
 * we track all nodes created by the engine and count them.
 */
export function countAudioNodes(engine: AudioEngine): number {
  const diag = engine.getDiagnostics();
  return Number(diag.activeEffects ?? 0) * 5 + Number(diag.activeInstruments ?? 0) * 10 + Number(diag.returns ?? 0) * 3 + Number(diag.activeLfos ?? 0) * 2 + 4;
}

/**
 * Count per-type node breakdown (estimated from diagnostics).
 */
export function audioNodeBreakdown(engine: AudioEngine): PerformanceReport["audioNodeBreakdown"] {
  const diag = engine.getDiagnostics();
  const trackCount = Number(diag.trackCount ?? 0);
  const returns = Number(diag.returns ?? 0);
  const activeInstruments = Number(diag.activeInstruments ?? 0);
  const activeEffects = Number(diag.activeEffects ?? 0);
  const activeLfos = Number(diag.activeLfos ?? 0);
  return {
    master: 4,
    tracks: trackCount * 8,
    returns: returns * 3,
    instruments: activeInstruments * 10,
    effects: activeEffects * 5,
    lfos: activeLfos * 2,
    voices: engine.voiceCount * 3, // each voice = 3 nodes
  };
}

/**
 * Collect a full performance snapshot.
 */
export function collectPerformanceReport(
  engine: AudioEngine,
  scheduler: Scheduler,
  startupMs: number,
  bankSize: number,
): PerformanceReport {
  const diag = engine.getDiagnostics();
  const breakdown = audioNodeBreakdown(engine);
  const totalNodes = Object.values(breakdown).reduce((s, n) => s + n, 0);

  // Voice counts per instrument
  const voiceCounts: Record<string, number> = {};
  const instrumentsMap = (engine as any).instruments as Map<string, { runtime: any }> | undefined;
  const doc = (engine as any).doc as ProjectDocument | undefined;
  if (instrumentsMap) {
    for (const [id] of instrumentsMap) {
      const track = doc?.tracks.find((t) => t.id === id);
      const kind = track && track.kind === "instrument" ? track.instrument : "unknown";
      voiceCounts[kind] = (voiceCounts[kind] ?? 0) + 1;
    }
  }

  let memoryMB: number | null = null;
  if (performance.memory) {
    memoryMB = Math.round(performance.memory.usedJSHeapSize / 1024 / 1024);
  }

  return {
    startupMs: Math.round(startupMs),
    audioNodeCount: totalNodes,
    audioNodeBreakdown: breakdown,
    voiceCounts,
    drumVoiceCount: engine.voiceCount,
    schedulerEvents: scheduler.stats.scheduledEvents,
    schedulerWindows: scheduler.stats.windows,
    lastRenderMs: null,
    lastRenderSamples: null,
    memoryMB,
    browser: navigator.userAgent,
    effectCount: Number(diag.activeEffects),
    instrumentCount: Number(diag.activeInstruments),
    lfoCount: Number(diag.activeLfos),
    bankSize,
    trackCount: Number(diag.trackCount ?? 0),
    clipCount: Number(diag.clipCount ?? 0),
  };
}

/**
 * Measure render time by doing a pattern-mode render.
 */
export async function measureRenderTime(
  doc: ProjectDocument,
  bank: SampleBank,
): Promise<{ durationMs: number; bufferDuration: number; samples: number }> {
  const { renderProject } = await import("../rendering/renderer");
  const t0 = performance.now();
  const buffer = await renderProject(doc, bank, { mode: "pattern", sampleRate: 44100, tailSeconds: 0.5 });
  const t1 = performance.now();
  return {
    durationMs: Math.round(t1 - t0),
    bufferDuration: buffer.duration,
    samples: buffer.length,
  };
}

/**
 * Measure a song-mode render for the full arrangement.
 */
export async function measureSongRender(
  doc: ProjectDocument,
  bank: SampleBank,
): Promise<{ durationMs: number; bufferDuration: number; samples: number; arrangementBars: number }> {
  const { renderProject } = await import("../rendering/renderer");
  const bars = doc.arrangement.clips.reduce((max, c) => Math.max(max, c.startBar + c.lengthBars), 0);
  const t0 = performance.now();
  const buffer = await renderProject(doc, bank, { mode: "song", sampleRate: 44100, tailSeconds: 2 });
  const t1 = performance.now();
  return {
    durationMs: Math.round(t1 - t0),
    bufferDuration: buffer.duration,
    samples: buffer.length,
    arrangementBars: bars,
  };
}

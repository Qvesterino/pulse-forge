/**
 * Benchmark runner — executes all stress tests and produces a PerformanceReport.
 */
import type { AudioEngine } from "../audio-engine/AudioEngine";
import type { SampleBank } from "../sample-library/factory";
import type { Scheduler } from "../scheduler/Scheduler";
import { collectPerformanceReport, measureRenderTime, type PerformanceReport } from "./performance";
import { denseDrums, heavyFX, longSong, manyVoices, multiRender, type StressResult } from "./stress";

export interface BenchmarkReport {
  performance: PerformanceReport;
  stressResults: StressResult[];
  timestamp: string;
  passed: number;
  failed: number;
}

const MEMORY_THRESHOLD_MB = 500;
const NODE_THRESHOLD = 1000;
const RENDER_RATIO_THRESHOLD = 3;

export async function runBenchmark(
  engine: AudioEngine,
  scheduler: Scheduler,
  bank: SampleBank,
  startupMs: number,
  doc: any,
): Promise<BenchmarkReport> {
  const stressResults: StressResult[] = [];

  const scenarios = [
    () => denseDrums(engine, bank),
    () => manyVoices(engine, bank),
    () => heavyFX(engine, bank),
    () => longSong(engine, bank),
    () => multiRender(engine, bank),
  ];

  for (const scenario of scenarios) {
    try {
      const result = await scenario();
      stressResults.push(result);
    } catch (error) {
      stressResults.push({
        name: "unknown",
        description: "Scenario failed",
        durationMs: 0,
        eventsScheduled: 0,
        peakVoices: 0,
        nodeCount: 0,
        memoryBeforeMB: 0,
        memoryAfterMB: 0,
        ok: false,
        message: String(error),
      });
    }
  }

  // Collect base performance report
  const performance = collectPerformanceReport(engine, scheduler, startupMs, bank.size);

  // Measure renders
  try {
    const patternRender = await measureRenderTime(doc, bank);
    performance.lastRenderMs = patternRender.durationMs;
    performance.lastRenderSamples = patternRender.samples;
  } catch {
    // non-critical
  }

  // Count stress test failures
  const failed = stressResults.filter((r) => !r.ok).length;
  const passed = stressResults.length - failed;

  return {
    performance,
    stressResults,
    timestamp: new Date().toISOString(),
    passed,
    failed,
  };
}

/**
 * Evaluate a report against thresholds and return a human-readable summary.
 */
export function evaluateReport(report: BenchmarkReport): string[] {
  const issues: string[] = [];
  const p = report.performance;

  if (p.startupMs > 5000) {
    issues.push(`Startup slow: ${p.startupMs}ms (threshold: 5000ms)`);
  }
  if (p.audioNodeCount > NODE_THRESHOLD) {
    issues.push(`Too many AudioNodes: ${p.audioNodeCount} (threshold: ${NODE_THRESHOLD})`);
  }
  if (p.memoryMB !== null && p.memoryMB > MEMORY_THRESHOLD_MB) {
    issues.push(`Memory high: ${p.memoryMB}MB (threshold: ${MEMORY_THRESHOLD_MB}MB)`);
  }
  if (p.lastRenderMs !== null && p.lastRenderSamples !== null) {
    const songDurationMs = 4 * (60 / 124) * 1000; // assume 4 bars
    const ratio = p.lastRenderMs / songDurationMs;
    if (ratio > RENDER_RATIO_THRESHOLD) {
      issues.push(`Render ratio too high: ${ratio.toFixed(1)}× (threshold: ${RENDER_RATIO_THRESHOLD}×)`);
    }
  }
  if (p.drumVoiceCount > 100) {
    issues.push(`Uncapped drum voices: ${p.drumVoiceCount} (consider Worklet limiting)`);
  }

  for (const stress of report.stressResults) {
    if (!stress.ok) {
      issues.push(`Stress "${stress.name}" failed: ${stress.message}`);
    }
    if (stress.renderTimeMs && stress.renderTimeMs > 5000) {
      issues.push(`Stress "${stress.name}" render slow: ${stress.renderTimeMs}ms`);
    }
  }

  return issues;
}

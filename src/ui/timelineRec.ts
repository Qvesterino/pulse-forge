/**
 * Timeline recording helpers — the placement math for mic takes recorded
 * straight onto an armed arrangement track. Pure, so the tests cover the
 * math without a microphone.
 */
import { BAR_TICKS } from "../project-model/types";

/** One bar in seconds at the given tempo (4/4). */
export function secondsPerBar(bpm: number): number {
  const safeBpm = Number.isFinite(bpm) && bpm >= 20 ? bpm : 120;
  return 240 / safeBpm;
}

/**
 * Clip length in bars for a recorded take — rounded to 2 decimals (the
 * command's own granularity) with a 0.25-bar floor so whisper-short takes
 * still make a visible, selectable clip.
 */
export function clipLengthBars(durationSec: number, bpm: number): number {
  const bars = durationSec / secondsPerBar(bpm);
  return Math.max(0.25, Math.round(bars * 100) / 100);
}

/** The bar the transport sits in when REC starts — clips anchor there. */
export function recordingStartBar(positionTicks: number): number {
  return Math.max(0, Math.floor(positionTicks / BAR_TICKS));
}

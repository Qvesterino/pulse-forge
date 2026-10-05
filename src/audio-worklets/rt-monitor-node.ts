import { attachProcessorErrorGuard } from "./processor-errors";

/**
 * RT Monitor handle — audio-thread health probe (release-gate hardening).
 *
 * Sink node fed from the post-limiter master bus (same observer pattern as
 * the K-weighted meter): it shapes no audio, it only reports the AUDIO CLOCK
 * and a heartbeat, and this wrapper turns them into the host-visible health
 * numbers.
 *
 * Two numbers, both honest (see the processor for why an in-worklet wall
 * clock is not portable):
 *   - `xruns`: quanta the audio device actually dropped (the audio clock
 *     advanced by more than one render quantum between callbacks). This is
 *     the platform's xrun signal.
 *   - `maxGapMs` / `avgGapMs`: main-thread delivery jitter of the worklet's
 *     heartbeat. A graph that overruns its deadline makes the heartbeat
 *     arrive late or in bursts, which is what a listener actually hears as a
 *     glitch.
 *
 * `loadPercent` is NOT reported: without a wall clock in the worklet there is
 * no honest CPU-load number, and inventing one would be a lie in a
 * diagnostics panel.
 */
export interface RtMonitorSnapshot {
  /** Render quanta the audio thread has processed since the last reset. */
  blocks: number;
  /** Quanta the audio device dropped (audio clock skipped). */
  xruns: number;
  /** Context sample rate the monitor is running at. */
  sampleRate: number;
  /** Nominal quantum duration, ms (128 / sampleRate). */
  quantumMs: number;
  /** Worst main-thread delivery jitter of the worklet heartbeat, ms. */
  maxGapMs: number;
  /** Mean main-thread delivery jitter, ms. */
  avgGapMs: number;
  /** Heartbeats received since the last reset (delivery health). */
  heartbeats: number;
}

export interface RtMonitorHandle {
  input: AudioNode;
  getSnapshot(): RtMonitorSnapshot;
  reset(): void;
  dispose(): void;
}

const EMPTY: RtMonitorSnapshot = {
  blocks: 0,
  xruns: 0,
  sampleRate: 0,
  quantumMs: 0,
  maxGapMs: 0,
  avgGapMs: 0,
  heartbeats: 0,
};

export function createRtMonitorNode(
  ctx: BaseAudioContext,
  now: () => number = () => performance.now(),
): RtMonitorHandle {
  const node = new AudioWorkletNode(ctx, "rt-monitor-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 2,
    channelInterpretation: "speakers",
    processorOptions: { reportEveryBlocks: 64 },
  });
  // Runtime processor-error containment (GOAL 07/LONGEVITY §3): the browser
  // silently kills a throwing processor — surface + count it.
  attachProcessorErrorGuard(node, "rt-monitor-processor");

  let last: RtMonitorSnapshot = { ...EMPTY, sampleRate: ctx.sampleRate, quantumMs: (128 / ctx.sampleRate) * 1000 };
  let lastAt = 0;
  let gapSum = 0;

  node.port.onmessage = (event: MessageEvent) => {
    const data = event.data as {
      type?: string;
      blocks?: number;
      droppedQuanta?: number;
      sampleRate?: number;
      quantumMs?: number;
    } | null;
    if (data?.type !== "rt") return;
    // Validate the untrusted port shape before adopting it.
    if (typeof data.blocks !== "number" || typeof data.droppedQuanta !== "number") return;
    const at = now();
    const gap = lastAt > 0 ? at - lastAt : 0;
    lastAt = at;
    if (gap > 0) {
      gapSum += gap;
      if (gap > last.maxGapMs) last.maxGapMs = gap;
    }
    const heartbeats = last.heartbeats + 1;
    last = {
      blocks: data.blocks,
      xruns: data.droppedQuanta,
      sampleRate: typeof data.sampleRate === "number" ? data.sampleRate : last.sampleRate,
      quantumMs: typeof data.quantumMs === "number" ? data.quantumMs : last.quantumMs,
      maxGapMs: last.maxGapMs,
      avgGapMs: heartbeats > 1 ? gapSum / (heartbeats - 1) : 0,
      heartbeats,
    };
  };

  return {
    input: node,
    getSnapshot: () => ({ ...last }),
    reset() {
      last = {
        blocks: 0,
        xruns: 0,
        sampleRate: last.sampleRate,
        quantumMs: last.quantumMs,
        maxGapMs: 0,
        avgGapMs: 0,
        heartbeats: 0,
      };
      gapSum = 0;
      lastAt = 0;
    },
    dispose() {
      node.port.onmessage = null;
      // Keep the port open (fxeqNode/ozvena convention): the GC closes it.
      node.disconnect();
    },
  };
}

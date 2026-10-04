import { attachProcessorErrorGuard } from "./processor-errors";

/**
 * RT Monitor handle — audio-thread load probe (release-gate hardening).
 *
 * Sink node fed from the post-limiter master bus (same observer pattern as
 * the K-weighted meter): it shapes no audio, it only measures how long the
 * audio thread spends per render quantum and whether quanta are being
 * dropped. The engine registers it with MeteringRig for lifetime reads and
 * teardown; the wrapper owns the port protocol.
 *
 * Honest limits: `performance.now()` lives on the main-thread global; the
 * AudioWorklet scope exposes it in Chrome/Firefox but the processor guards
 * for its absence. A context with no RT Monitor (worklet module unavailable)
 * simply reports `xrun` fields as unavailable.
 */
export interface RtMonitorSnapshot {
  /** Whether the audio thread could measure time at all. */
  available: boolean;
  /** Render quanta processed since the last report/reset. */
  blocks: number;
  /** Callbacks whose inter-call gap exceeded 2× the quantum (xrun proxy). */
  xruns: number;
  /** Worst wall time inside one process() callback, ms. */
  maxBlockMs: number;
  /** Mean wall time inside one process() callback, ms. */
  avgBlockMs: number;
  /** Worst wall gap between consecutive callbacks, ms. */
  maxGapMs: number;
  /** Nominal quantum duration, ms (128 / sampleRate). */
  quantumMs: number;
}

export interface RtMonitorHandle {
  input: AudioNode;
  getSnapshot(): RtMonitorSnapshot;
  reset(): void;
  dispose(): void;
}

const EMPTY: RtMonitorSnapshot = {
  available: false,
  blocks: 0,
  xruns: 0,
  maxBlockMs: 0,
  avgBlockMs: 0,
  maxGapMs: 0,
  quantumMs: 0,
};

export function createRtMonitorNode(ctx: BaseAudioContext): RtMonitorHandle {
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

  let last: RtMonitorSnapshot = { ...EMPTY, quantumMs: (128 / ctx.sampleRate) * 1000 };
  node.port.onmessage = (event: MessageEvent) => {
    const data = event.data as Partial<RtMonitorSnapshot> & { type?: string } | null;
    if (data?.type !== "rt") return;
    // Validate the untrusted port shape before adopting it.
    if (
      typeof data.available === "boolean" &&
      typeof data.blocks === "number" &&
      typeof data.xruns === "number" &&
      typeof data.maxBlockMs === "number" &&
      typeof data.avgBlockMs === "number" &&
      typeof data.maxGapMs === "number"
    ) {
      last = {
        available: data.available,
        blocks: data.blocks,
        xruns: data.xruns,
        maxBlockMs: data.maxBlockMs,
        avgBlockMs: data.avgBlockMs,
        maxGapMs: data.maxGapMs,
        quantumMs: typeof data.quantumMs === "number" ? data.quantumMs : last.quantumMs,
      };
    }
  };

  return {
    input: node,
    getSnapshot: () => ({ ...last }),
    reset() {
      node.port.postMessage({ type: "reset" });
      last = { ...EMPTY, quantumMs: last.quantumMs };
    },
    dispose() {
      node.port.onmessage = null;
      // Keep the port open (fxeqNode/ozvena convention): the GC closes it.
      node.disconnect();
    },
  };
}

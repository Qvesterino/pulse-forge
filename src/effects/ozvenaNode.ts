import type { EffectRuntime } from "../effects/types";
import type { EffectInstance } from "../project-model/types";

/**
 * Main-thread Ozvena node: an AudioWorkletNode wrapping the vendored
 * three-engine reverb DSP (E1 Reflections, E2 Plate/Chamber, E3 Hall +
 * pre-delay/EQ/mod/duck/limiter). All audio runs on the worklet; parameters
 * travel over the message port as dotted state paths ("blendPad.x").
 */
export function createOzvenaNode(
  ctx: BaseAudioContext,
  instance: EffectInstance,
  defaults: Record<string, number>,
  initialBpm = 120,
): EffectRuntime {
  const initial: Record<string, number> = { ...defaults, ...instance.params };

  const node = new AudioWorkletNode(ctx, "ozvena-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: "explicit",
    channelInterpretation: "speakers",
    processorOptions: { params: initial, bpm: initialBpm },
  });

  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(node);
  node.connect(output);

  // DSP latency arrives asynchronously over the port — the engine subscribes
  // via onLatencyChange to re-sync PDC the moment it lands instead of
  // waiting for the next document sync.
  let latencySamples = 0;
  const latencyListeners = new Set<() => void>();
  let disposed = false;
  node.port.onmessage = (event) => {
    const msg = event.data as { type?: string; samples?: number } | null;
    if (msg?.type === "latency" && typeof msg.samples === "number") {
      latencySamples = msg.samples;
      if (!disposed) for (const listener of latencyListeners) listener();
    }
  };

  return {
    input,
    output,
    getLatencySec: () => latencySamples / ctx.sampleRate,
    onLatencyChange(listener: () => void) {
      latencyListeners.add(listener);
      return () => {
        latencyListeners.delete(listener);
      };
    },
    setParameter(id: string, value: number) {
      if (disposed) return;
      node.port.postMessage({ type: "param", id, value });
    },
    /**
     * Time-stamped parameter set (automation lanes, offline render). The
     * worklet queues the event and applies it when the render clock reaches
     * `when` — otherwise every point would land at the moment it was
     * posted and exports would lose automation timing entirely.
     */
    setParameterAt(id: string, value: number, when: number) {
      if (disposed) return;
      node.port.postMessage({ type: "paramAt", id, value, when });
    },
    /**
     * Live tempo changes: the tempo-synced pre-delay must follow the
     * project BPM (the core clamps 20..300 and re-computes the delay).
     */
    syncBpm(bpm: number) {
      if (disposed || !Number.isFinite(bpm)) return;
      node.port.postMessage({ type: "bpm", bpm });
    },
    dispose() {
      disposed = true;
      latencyListeners.clear();
      node.port.onmessage = null;
      try {
        // Must land BEFORE close(): the processor's core keeps a
        // module-global IPC peer entry (duck controller) that pins the
        // whole DSP graph unless explicitly released — after close() no
        // further messages are delivered and the processor would leak.
        node.port.postMessage({ type: "dispose" });
      } catch {
        // port already closed
      }
      try {
        node.port.close();
      } catch {
        // already closed
      }
      node.disconnect();
      input.disconnect();
      output.disconnect();
    },
  };
}

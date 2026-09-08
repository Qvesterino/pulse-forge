import type { EffectRuntime } from "../effects/types";
import type { EffectInstance } from "../project-model/types";

/**
 * Main-thread Ultina node: an AudioWorkletNode wrapping the vendored Ultina
 * mixing DSP (module graph: EQ, Comp, Gate, Exciter, Transient, Clipper,
 * Density, Sculptor, Phase, Unmask + LUFS/autogain). All audio runs on the
 * worklet; parameters travel over the message port.
 *
 * The rack exposes the global gain/mix surface plus quick module toggles;
 * per-module editing lands with the Ultina panel.
 */
export function createUltinaNode(
  ctx: BaseAudioContext,
  instance: EffectInstance,
  defaults: Record<string, number>,
): EffectRuntime {
  // Full param merge (defaults + every instance param — the Ultina
  // parameter space is namespaced: "global.inputGainDb", "comp.ratio"…).
  const initial: Record<string, number> = { ...defaults, ...instance.params };

  const node = new AudioWorkletNode(ctx, "ultina-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: "explicit",
    channelInterpretation: "speakers",
    processorOptions: { params: initial },
  });

  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(node);
  node.connect(output);

  // DSP latency arrives asynchronously over the port — the engine subscribes
  // via onLatencyChange to re-sync PDC the moment it lands instead of
  // waiting for the next document sync.
  let latencySamples = 0;
  let meters: unknown = null;
  const latencyListeners = new Set<() => void>();
  let disposed = false;

  // Metering runs ONLY while a consumer (UltinaPanel) is attached: the
  // analysis path costs real audio-thread CPU per instance (spectrum FFT,
  // 32-band analyzer, waveform), so the node defaults to off and the engine
  // flips it on behalf of the panel. The worklet defaults to on for any
  // direct consumer that never negotiates — this initial message sets the
  // app-side default. The node also ENFORCES the gate: worklet messages can
  // straggle past the toggle (offline renders deliver port messages slightly
  // late), and a gated instance must surface no meters at all.
  let metersWanted = false;
  node.port.postMessage({ type: "setMeters", enabled: false });

  node.port.onmessage = (event) => {
    const msg = event.data as { type?: string; samples?: number; meters?: unknown } | null;
    if (msg?.type === "latency" && typeof msg.samples === "number") {
      latencySamples = msg.samples;
      if (!disposed) for (const listener of latencyListeners) listener();
    } else if (msg?.type === "meters") {
      if (metersWanted) meters = msg.meters;
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
    getMeters: () => meters,
    setParameter(id: string, value: number) {
      if (disposed) return;
      node.port.postMessage({ type: "param", id, value });
    },
    /**
     * Time-stamped parameter set (automation lanes, offline render). The
     * worklet queues the event and applies it when the render clock reaches
     * `when` — port messages have no timing of their own, so without this
     * an offline export collapses an entire automation lane to the final
     * point's value (every point overwrites the previous one pre-render).
     */
    setParameterAt(id: string, value: number, when: number) {
      if (disposed) return;
      node.port.postMessage({ type: "paramAt", id, value, when });
    },
    setMetersEnabled(enabled: boolean) {
      if (disposed) return;
      metersWanted = enabled;
      if (!enabled) meters = null; // no stale reads behind a closed panel
      node.port.postMessage({ type: "setMeters", enabled });
    },
    dispose() {
      if (disposed) return; // idempotent — engine rebuild paths may re-dispose
      disposed = true;
      latencyListeners.clear();
      metersWanted = false;
      meters = null; // no stale reads from a disposed runtime
      // Best-effort spectral-registry cleanup. The port must NOT be closed
      // here: closing a MessagePort can drop already-queued messages
      // (engine-dependent), which would silently discard this terminal
      // teardown and leak one spectral-registry entry per disposed instance
      // for the page's lifetime. Dropping the last JS reference to the node
      // lets the implementation close the port after the message has been
      // delivered.
      try {
        node.port.postMessage({ type: "dispose" });
      } catch {
        // port already dead
      }
      node.port.onmessage = null;
      node.disconnect();
      input.disconnect();
      output.disconnect();
    },
  };
}

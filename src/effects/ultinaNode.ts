import { mix01ToPercent100 } from "./scale-bridges";
import type { EffectRuntime } from "../effects/types";
import type { EffectInstance } from "../project-model/types";
import { createLatencyReportReadiness } from "./latencyReadiness";

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
  // Quality backlog A6: doc mix params are 0..1; the deep DSP expects
  // 0..100 — the node bridges at the doc→worklet boundary. The defaults
  // fallback arrives deep-scale and is not bridged.
  // Document 0..1 mix → vendored percent 0..100. The crossing is registered
  // in src/effects/scale-bridges.ts (ultina.global.mix) — keep them in sync.
  const toDeepScale = (id: string, v: number): number => (id === "global.mix" ? mix01ToPercent100(v) : v);
  const initial: Record<string, number> = { ...defaults, ...instance.params };
  for (const [id, v] of Object.entries(instance.params)) initial[id] = toDeepScale(id, v);

  // TWO inputs: [0] = the mix to process, [1] = the sidechain feed (key /
  // buss track picked as EffectInstance.sidechainTrackId). The vendored
  // processor already accepts a sidechain buffer pair (process(channels,
  // frameCount, sidechain)) and gates its comp/gate/EQ/unmask detectors on
  // it — the host simply never delivered one, so every sidechain switch in
  // the DSP was unreachable. Feeding it as a real second input keeps the
  // detector sample-aligned with the block instead of polling an Analyser
  // from the main thread (that route cannot see inside the render quantum).
  const node = new AudioWorkletNode(ctx, "ultina-processor", {
    numberOfInputs: 2,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: "explicit",
    channelInterpretation: "speakers",
    processorOptions: { params: initial },
  });

  const input = ctx.createGain();
  const output = ctx.createGain();
  // Sidechain feed node — stays connected to the worklet's second input; the
  // engine swaps what lands on it (or disconnects for the internal signal).
  const sidechainFeed = ctx.createGain();
  // Unconnected inputs are silent, which is exactly the "no sidechain"
  // default: modules fall back to their own audio.
  input.connect(node);
  sidechainFeed.connect(node, 0, 1);
  node.connect(output);

  // DSP latency arrives asynchronously over the port — the engine subscribes
  // via onLatencyChange to re-sync PDC the moment it lands instead of
  // waiting for the next document sync.
  let latencySamples = 0;
  const latencyReadiness = createLatencyReportReadiness();
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
  /** Currently connected sidechain source (null = none). */
  let sidechainSource: AudioNode | null = null;

  node.port.onmessage = (event) => {
    const msg = event.data as { type?: string; samples?: number; meters?: unknown } | null;
    if (
      msg?.type === "latency" &&
      typeof msg.samples === "number" &&
      Number.isSafeInteger(msg.samples) &&
      msg.samples >= 0
    ) {
      latencySamples = msg.samples;
      latencyReadiness.markReported();
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
    waitForLatencyReport: (timeoutMs: number) => latencyReadiness.wait(timeoutMs),
    getMeters: () => meters,
    setParameter(id: string, value: number) {
      if (disposed) return;
      node.port.postMessage({ type: "param", id, value: toDeepScale(id, value) });
    },
    /**
     * Sidechain feed (2026-10-04 audit). The engine calls this once after
     * construction when `EffectInstance.sidechainTrackId` resolves to a live
     * track, and again with `null` to clear it. `sidechainFeed` is already
     * wired to the worklet's second input for the whole lifetime, so the
     * whole job is (dis)connecting the source node to it — the DSP falls back
     * to its own audio when the feed is silent, so a cleared sidechain needs
     * no extra parameter write.
     */
    setSidechainInput(source: AudioNode | null) {
      if (disposed) return;
      if (sidechainSource === source) return;
      if (sidechainSource) {
        try {
          sidechainSource.disconnect(sidechainFeed);
        } catch {
          /* already disconnected */
        }
      }
      sidechainSource = source;
      if (source) {
        try {
          source.connect(sidechainFeed);
        } catch {
          // A source that refuses the connection (already torn down with
          // its track) leaves the feed silent — modules fall back to their
          // own signal rather than going silent.
          sidechainSource = null;
        }
      }
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
      node.port.postMessage({ type: "paramAt", id, value: toDeepScale(id, value), when });
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
      latencyReadiness.dispose();
      latencyListeners.clear();
      metersWanted = false;
      meters = null; // no stale reads from a disposed runtime
      if (sidechainSource) {
        try {
          sidechainSource.disconnect(sidechainFeed);
        } catch {
          /* already gone */
        }
        sidechainSource = null;
      }
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
      sidechainFeed.disconnect();
    },
  };
}

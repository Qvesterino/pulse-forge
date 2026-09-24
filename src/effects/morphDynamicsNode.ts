import type { EffectRuntime } from "../effects/types";
import type { EffectInstance } from "../project-model/types";

/**
 * Main-thread MORPH DYNAMICS node: an AudioWorkletNode wrapping the
 * reactive dynamics-morph DSP (dynamics → character → motion → space,
 * driven by transient/body/texture analysis through the modulation
 * matrix). All audio runs on the worklet; parameters travel over the
 * message port. Protocol mirrors ultinaNode.
 */
export function createMorphDynamicsNode(
  ctx: BaseAudioContext,
  instance: EffectInstance,
  defaults: Record<string, number>,
): EffectRuntime {
  // Full param merge (defaults + every instance param — the MORPH
  // parameter space is namespaced: "macro.pressure", "dyn.ratio",
  // "routes.0.amount", …).
  // Quality backlog A6: doc mix params are 0..1; the deep DSP expects
  // 0..100 — the node bridges at the doc→worklet boundary. The defaults
  // fallback arrives deep-scale and is not bridged.
  const toDeepScale = (id: string, v: number): number => (id === "global.mix" ? v * 100 : v);
  const initial: Record<string, number> = { ...defaults, ...instance.params };
  for (const [id, v] of Object.entries(instance.params)) initial[id] = toDeepScale(id, v);

  // Input 2 carries the external sidechain feed (dyn.sidechainExt): the
  // engine wires a source track's post-fader node here via setSidechainInput.
  const node = new AudioWorkletNode(ctx, "morphdynamics-processor", {
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
  input.connect(node);
  node.connect(output);
  let scFeed: AudioNode | null = null;

  // DSP latency arrives asynchronously over the port — the engine
  // subscribes via onLatencyChange to re-sync PDC the moment it lands.
  let latencySamples = 0;
  let meters: unknown = null;
  const latencyListeners = new Set<() => void>();
  let disposed = false;

  // Metering runs ONLY while a consumer (MorphDynamicsPanel) is attached:
  // the node defaults to off and the engine flips it on the panel's behalf.
  // The node ENFORCES the gate — worklet messages can straggle past the
  // toggle (offline renders deliver port messages slightly late).
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
      node.port.postMessage({ type: "param", id, value: toDeepScale(id, value) });
    },
    /**
     * Time-stamped parameter set (automation lanes, offline render). The
     * worklet queues the event and applies it when the render clock reaches
     * `when` — without this, an offline export collapses an automation lane
     * to its final point's value.
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
    /**
     * External sidechain feed (input 2 of the worklet). The engine wires the
     * source track's node when EffectInstance.sidechainTrackId resolves and
     * clears it with null. Safe to call repeatedly with the same node.
     */
    setSidechainInput(feed: AudioNode | null) {
      if (disposed) return;
      if (scFeed === feed) return; // engine re-syncs may re-assert — cheap no-op
      try {
        scFeed?.disconnect(node);
      } catch {
        // feed already gone (its own teardown ran first)
      }
      scFeed = feed;
      if (feed) feed.connect(node, 0, 1); // → node input 2 (index 1)
    },
    /** Morph-scene glide (see EffectRuntime.morphToParams). */
    morphToParams(params: Record<string, number>, durationSec: number) {
      if (disposed) return;
      node.port.postMessage({ type: "morphTo", params, durationMs: Math.round(durationSec * 1000) });
    },
    dispose() {
      if (disposed) return; // idempotent — engine rebuild paths may re-dispose
      disposed = true;
      latencyListeners.clear();
      metersWanted = false;
      meters = null;
      try {
        scFeed?.disconnect(node);
      } catch {
        // feed already gone
      }
      scFeed = null;
      // The port must NOT be closed here: closing a MessagePort can drop
      // already-queued messages, discarding the terminal teardown. Drop the
      // last JS reference to the node instead and let the implementation
      // close the port after delivery.
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

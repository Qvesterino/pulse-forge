import type { EffectRuntime } from "../effects/types";
import type { HarmonyContextInit } from "../effects/types";
import type { EffectInstance } from "../project-model/types";
import { REZONANS_PARAMS, buildDefaultParams } from "./rezonans-core/contracts/parameters";
import { createLatencyReportReadiness } from "./latencyReadiness";

/**
 * Main-thread REZONANS node: an AudioWorkletNode wrapping the spectral
 * formant + key-aware harmony DSP.
 *
 * Protocol mirrors morphDynamicsNode: parameters travel over the message port
 * because REZONANS is a flagship suite whose parameter surface is namespaced
 * and deep (`harmony.*`, `voice{n}.*`), not a flat AudioParam set.
 *
 * The time-stamped path matters more here than in most plugins: REZONANS owns
 * its own musical clock, so `syncBpm` and `transport` carry absolute context
 * times and the worklet applies them when the render clock reaches them. An
 * un-timed write would collapse an offline render to its last value.
 *
 * Latency is real (~21 ms at balanced quality) and arrives asynchronously over
 * the port; the engine subscribes via `onLatencyChange` to re-sync PDC the
 * moment it lands, which is what keeps a 55-effect project phase-aligned.
 */
export function createRezonansNode(
  ctx: BaseAudioContext,
  instance: EffectInstance,
  env: { bpm?: number; harmonyContext?: HarmonyContextInit },
): EffectRuntime {
  // Full param merge (defaults + every instance param).
  const initial: Record<string, number> = { ...buildDefaultParams(), ...instance.params };

  const node = new AudioWorkletNode(ctx, "rezonans-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: "explicit",
    channelInterpretation: "speakers",
    processorOptions: {
      params: initial,
      bpm: env.bpm ?? 120,
      harmonyContext: env.harmonyContext,
    },
  });

  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(node);
  node.connect(output);

  let latencySamples = 0;
  const latencyReadiness = createLatencyReportReadiness();
  let meters: unknown = null;
  const latencyListeners = new Set<() => void>();
  let disposed = false;

  // Metering runs ONLY while a consumer (RezonansPanel) is attached: the node
  // defaults to off and the engine flips it on the panel's behalf. The node
  // ENFORCES the gate — worklet messages can straggle past the toggle.
  let metersWanted = false;
  node.port.postMessage({ type: "setMeters", enabled: false });

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
    hasLatencyReport: () => latencyReadiness.isReported(),
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
      node.port.postMessage({ type: "param", id, value });
    },
    /**
     * Time-stamped parameter set (automation lanes, offline render). The
     * worklet queues the event and applies it when the render clock reaches
     * `when` — without this, an offline export collapses an automation lane
     * to its final point's value.
     */
    setParameterAt(id: string, value: number, when: number) {
      if (disposed) return;
      node.port.postMessage({ type: "paramAt", id, value, when });
    },
    /** Tempo change for the worklet's musical clock (ADR 0040 §4.3b). */
    syncBpm(bpm: number, when?: number) {
      if (disposed) return;
      node.port.postMessage({ type: "syncBpm", bpm, when: when ?? 0 });
    },
    /**
     * Transport seed. REZONANS needs absolute musical position because its
     * chord lane is indexed by ABSOLUTE bar — that is what makes a seek or a
     * loop re-resolve instead of drifting.
     */
    onTransportStarted(_time: number, beatPhase: number, positionBeats?: number) {
      if (disposed) return;
      node.port.postMessage({
        type: "transport",
        positionBeats: positionBeats ?? beatPhase,
        time: ctx.currentTime,
      });
    },
    /** Offline renders start at position 0 and replay tempo per window. */
    prepareOfflineRender() {
      if (disposed) return;
      node.port.postMessage({ type: "transport", positionBeats: 0, time: 0 });
    },
    /** Key/chord bridge push (ADR 0040 §4.3a). */
    setHarmonyContext(context: HarmonyContextInit) {
      if (disposed) return;
      node.port.postMessage({ type: "harmonyContext", harmonyContext: context });
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
      meters = null;
      // The port must NOT be closed here: closing a MessagePort can drop
      // already-queued messages, discarding the terminal teardown.
      try {
        node.port.postMessage({ type: "dispose" });
      } catch {
        /* port already dead */
      }
      node.port.onmessage = null;
      node.disconnect();
      input.disconnect();
      output.disconnect();
    },
  };
}

/** Declared parameter count — surfaced in the registration tests. */
export const REZONANS_DECLARED_PARAM_COUNT = REZONANS_PARAMS.length;

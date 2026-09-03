import type { EffectRuntime } from "../effects/types";
import type { EffectInstance } from "../project-model/types";

/**
 * Rack ↔ core parameter-id translation. The rack surface (registry params,
 * stored in documents as instance.params) uses `mix`; the vendored core
 * schema names the same control `globalMix`. Without this map the rack's
 * MIX knob is silently dead — the core drops unknown ids (setParameter
 * routes through schema.routes.get). Add an entry here whenever a rack id
 * diverges from its core id; tests/fxeq-rack-contract.test.ts enforces that
 * every registry param resolves through this map or the schema directly.
 */
const RACK_TO_CORE: Record<string, string> = {
  mix: "globalMix",
};

function toCoreId(id: string): string {
  return RACK_TO_CORE[id] ?? id;
}

/**
 * Main-thread FXEQ node: an AudioWorkletNode wrapping the vendored fxeq DSP
 * (multiband crossover + per-band Sat/LoFi/Mod/Delay/Rev + limiter). All
 * audio runs on the worklet; parameters travel over the message port.
 *
 * The registry exposes a small top-level param surface (input/output gain,
 * band count, global mix, limiter) — the full per-band palette arrives with
 * the EQ-paint editor panel.
 */
export function createFxEqNode(
  ctx: BaseAudioContext,
  instance: EffectInstance,
  defaults: Record<string, number>,
): EffectRuntime {
  // Initial params ride processorOptions so the very first block is already
  // in the right state; later changes go over the port. Defaults first, then
  // EVERY instance param — the fxeq parameter space includes dotted
  // per-band ids ("band2.satDriveDb"…) beyond the rack's top-level surface.
  const initial: Record<string, number> = {};
  for (const [id, value] of Object.entries({ ...defaults, ...instance.params })) {
    initial[toCoreId(id)] = id === "bandCount" ? Math.round(value) : value;
  }

  const node = new AudioWorkletNode(ctx, "fxeq-processor", {
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

  // The worklet reports DSP latency (oversampled bands) after prepare and
  // whenever params change it — consumed by the engine's PDC via
  // getLatencySec() so fxeq tracks stay in phase with the rest of the mix.
  // The report arrives ASYNCHRONOUSLY over the port, so the engine also
  // subscribes via onLatencyChange to re-sync PDC the moment it lands
  // (syncPdc would otherwise compensate 0 until the next document sync).
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
      // The worklet's setParameter validates ids — forward everything,
      // including dotted per-band ids outside the rack surface. Rack ids
      // that diverge from core ids are translated (see RACK_TO_CORE).
      node.port.postMessage({
        type: "param",
        id: toCoreId(id),
        value: id === "bandCount" ? Math.round(value) : value,
      });
    },
    dispose() {
      disposed = true;
      latencyListeners.clear();
      node.port.onmessage = null;
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

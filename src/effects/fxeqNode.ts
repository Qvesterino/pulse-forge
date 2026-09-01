import type { EffectRuntime } from "../effects/types";
import type { EffectInstance } from "../project-model/types";

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
  const initial: Record<string, number> = { ...defaults, ...instance.params };
  if (instance.params.bandCount !== undefined) {
    initial.bandCount = Math.round(instance.params.bandCount);
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
  let latencySamples = 0;
  node.port.onmessage = (event) => {
    const msg = event.data as { type?: string; samples?: number } | null;
    if (msg?.type === "latency" && typeof msg.samples === "number") {
      latencySamples = msg.samples;
    }
  };

  return {
    input,
    output,
    getLatencySec: () => latencySamples / ctx.sampleRate,
    setParameter(id: string, value: number) {
      // The worklet's setParameter validates ids — forward everything,
      // including dotted per-band ids outside the rack surface.
      node.port.postMessage({ type: "param", id, value: id === "bandCount" ? Math.round(value) : value });
    },
    dispose() {
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

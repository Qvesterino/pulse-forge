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
      node.port.postMessage({ type: "param", id, value });
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

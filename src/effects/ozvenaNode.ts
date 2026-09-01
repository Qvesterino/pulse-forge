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
): EffectRuntime {
  const initial: Record<string, number> = { ...defaults, ...instance.params };

  const node = new AudioWorkletNode(ctx, "ozvena-processor", {
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

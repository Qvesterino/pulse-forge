import type { EffectRuntime } from "../effects/types";
import { safeApplyAudioParam } from "./safeAudioParam";

/**
 * Create a Bitcrusher AudioWorkletNode synchronously.
 * The processor module MUST be pre-loaded via `loadWorkletModules()` first.
 */
export function createBitcrusherNode(
  ctx: BaseAudioContext,
  instance: { params: Record<string, number> },
): EffectRuntime {
  const node = new AudioWorkletNode(ctx, "bitcrusher-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelInterpretation: "speakers",
  });

  // Wet/dry mix bus
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const out = ctx.createGain();
  input.connect(dry).connect(output);
  input.connect(wet).connect(node).connect(out).connect(output);

  // Set initial parameter values (safeApplyAudioParam guards non-finite)
  safeApplyAudioParam(node, "bits", instance.params.bits ?? 8);
  safeApplyAudioParam(node, "downsample", instance.params.downsample ?? 1);
  const bitsParam = node.parameters.get("bits");
  const dsParam = node.parameters.get("downsample");

  // Set initial mix
  const mixVal = instance.params.mix ?? 1;
  wet.gain.value = mixVal;
  dry.gain.value = 1 - mixVal;

  // Set initial output gain
  const outputDb = instance.params.output ?? 0;
  out.gain.value = Math.pow(10, outputDb / 20);

  return {
    input,
    output,
    setParameter(id: string, v: number) {
      const now = ctx.currentTime;
      switch (id) {
        case "bits":
          safeApplyAudioParam(node, "bits", v, now);
          break;
        case "downsample":
          safeApplyAudioParam(node, "downsample", v, now);
          break;
        case "mix":
          wet.gain.setTargetAtTime(v, now, 0.02);
          dry.gain.setTargetAtTime(1 - v, now, 0.02);
          break;
        case "output":
          out.gain.setTargetAtTime(Math.pow(10, v / 20), now, 0.02);
          break;
      }
    },
    setParameterAt(id: string, v: number, when: number) {
      switch (id) {
        case "bits":
          safeApplyAudioParam(node, "bits", v, when);
          break;
        case "downsample":
          safeApplyAudioParam(node, "downsample", v, when);
          break;
        case "mix":
          wet.gain.setTargetAtTime(v, when, 0.02);
          dry.gain.setTargetAtTime(1 - v, when, 0.02);
          break;
        case "output":
          out.gain.setTargetAtTime(Math.pow(10, v / 20), when, 0.02);
          break;
      }
    },
    getAudioParam: (paramId: string) => {
      if (paramId === "bits") return bitsParam ?? null;
      if (paramId === "downsample") return dsParam ?? null;
      return null;
    },
    dispose() {
      node.disconnect();
      input.disconnect();
      output.disconnect();
      dry.disconnect();
      wet.disconnect();
      out.disconnect();
    },
  };
}

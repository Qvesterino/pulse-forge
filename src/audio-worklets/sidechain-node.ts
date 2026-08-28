import type { EffectRuntime } from "../effects/types";

/**
 * Create a Sidechain Compressor AudioWorkletNode synchronously.
 * The processor module MUST be pre-loaded via `loadWorkletModules()` first.
 *
 * Uses a 2-input AudioWorkletNode:
 *   Input 0 — main audio (ducked signal)
 *   Input 1 — sidechain audio (detector signal)
 *
 * The processor runs the envelope follower at audio rate, fixing:
 * 1. Offline rendering (setInterval doesn't fire during OfflineAudioContext)
 * 2. Envelope precision (per-sample vs 100 Hz timer)
 */
export function createSidechainNode(
  ctx: BaseAudioContext,
  instance: { params: Record<string, number> },
): EffectRuntime {
  const workletNode = new AudioWorkletNode(ctx, "sidechain-processor", {
    numberOfInputs: 2,   // [0]=main, [1]=sidechain
    numberOfOutputs: 1,
    channelCount: 2,
    channelInterpretation: "speakers",
  });

  const input = ctx.createGain();
  const output = ctx.createGain();

  // Connect: input -> worklet -> output
  input.connect(workletNode);
  workletNode.connect(output);

  // Set initial parameter values
  const params = instance.params;
  const setParam = (id: string, value: number) => {
    const p = workletNode.parameters.get(id);
    if (p) p.value = value;
  };
  setParam("threshold", params.threshold ?? -18);
  setParam("ratio", params.ratio ?? 4);
  setParam("attack", params.attack ?? 0.005);
  setParam("release", params.release ?? 0.2);
  setParam("amount", params.amount ?? 1);
  setParam("splitFreq", params.splitFreq ?? 0);

  return {
    input,
    output,
    setParameter(id: string, v: number) {
      const p = workletNode.parameters.get(id);
      if (p) p.setValueAtTime(v, ctx.currentTime);
    },
    setParameterAt(id: string, v: number, when: number) {
      const p = workletNode.parameters.get(id);
      if (p) p.setValueAtTime(v, when);
    },
    /**
     * Connect a sidechain source to the worklet's second input.
     * This replaces the old AnalyserNode + setInterval approach.
     */
    setSidechainInput(node: AudioNode | null) {
      // Disconnect any existing sidechain source from input 1
      try { input.disconnect(workletNode, 0, 1); } catch { /* not connected */ }
      if (node) {
        // Connect source output 0 -> worklet input 1
        node.connect(workletNode, 0, 1);
      }
    },
    dispose() {
      workletNode.disconnect();
      input.disconnect();
      output.disconnect();
    },
  };
}

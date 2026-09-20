import type { EffectRuntime } from "../effects/types";
import { safeApplyAudioParam } from "./safeAudioParam";

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
    numberOfInputs: 2, // [0]=main, [1]=sidechain
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelInterpretation: "speakers",
  });

  const input = ctx.createGain();
  const output = ctx.createGain();
  // The current sidechain feed on worklet input 1. Tracked so a repoint (or
  // dispose) can detach the PREVIOUS source — without this, the old source
  // subgraph stayed connected into the detector forever and the detector
  // summed old + new feeds (see compressor-node's lastSidechainSource).
  let sidechainSource: AudioNode | null = null;

  // Connect: input -> worklet -> output
  input.connect(workletNode);
  workletNode.connect(output);

  // Set initial parameter values (safeApplyAudioParam guards non-finite writes)
  const params = instance.params;
  safeApplyAudioParam(workletNode, "threshold", params.threshold ?? -18);
  safeApplyAudioParam(workletNode, "ratio", params.ratio ?? 4);
  safeApplyAudioParam(workletNode, "attack", params.attack ?? 0.005);
  safeApplyAudioParam(workletNode, "release", params.release ?? 0.2);
  safeApplyAudioParam(workletNode, "amount", params.amount ?? 1);
  safeApplyAudioParam(workletNode, "splitFreq", params.splitFreq ?? 0);

  return {
    input,
    output,
    setParameter(id: string, v: number) {
      safeApplyAudioParam(workletNode, id, v, ctx.currentTime);
    },
    setParameterAt(id: string, v: number, when: number) {
      safeApplyAudioParam(workletNode, id, v, when);
    },
    getAudioParam: (paramId: string) => workletNode.parameters.get(paramId) ?? null,
    /**
     * Connect a sidechain source to the worklet's second input.
     * This replaces the old AnalyserNode + setInterval approach.
     */
    setSidechainInput(node: AudioNode | null) {
      // Disconnect the PREVIOUS sidechain source from input 1. The old code
      // called input.disconnect(workletNode, 0, 1) — an edge that never
      // exists (input feeds input 0 only), so it detached nothing.
      if (sidechainSource) {
        try {
          sidechainSource.disconnect(workletNode, 0, 1);
        } catch {
          /* not connected */
        }
        sidechainSource = null;
      }
      if (node) {
        // Connect source output 0 -> worklet input 1
        node.connect(workletNode, 0, 1);
        sidechainSource = node;
      }
    },
    dispose() {
      if (sidechainSource) {
        try {
          sidechainSource.disconnect(workletNode, 0, 1);
        } catch {
          /* not connected */
        }
        sidechainSource = null;
      }
      workletNode.disconnect();
      input.disconnect();
      output.disconnect();
    },
  };
}

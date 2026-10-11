import type { EffectRuntime } from "../effects/types";
import { attachProcessorErrorGuard } from "./processor-errors";
import { safeApplyAudioParam } from "./safeAudioParam";

/**
 * SKRUTKA (skrutka) node wrapper — plain AudioParam surface, same contract as
 * the M2 mastering nodes (zenit-m2-nodes.ts) and KOREŇ: every parameter is an
 * AudioParam on the processor, so live writes and offline automation
 * (`setParameterAt` → setValueAtTime) both work without port messages.
 *
 * One input, stereo output. No sidechain, no telemetry: the panel's group
 * delay curve is computed from the params alone (src/effects/skrutka-curve),
 * so the sample path never posts a message.
 *
 * The processor module is a LAZY worklet (public/skrutka-worklet.js): the
 * registry factory only calls this when `isWorkletReady("skrutka")` is true;
 * unloaded contexts get the honest 1:1 bypass from the factory.
 */
const SKRUTKA_PARAMS = ["dispersion", "punch", "focusHz", "spread", "mix", "output"] as const;

export function createSkrutkaNode(ctx: BaseAudioContext, instance: { params: Record<string, number> }): EffectRuntime {
  const node = new AudioWorkletNode(ctx, "skrutka-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelInterpretation: "speakers",
  });
  attachProcessorErrorGuard(node, "skrutka-processor");

  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(node);
  node.connect(output);

  for (const id of SKRUTKA_PARAMS) {
    safeApplyAudioParam(node, id, instance.params[id] ?? 0);
  }

  let disposed = false;

  return {
    input,
    output,
    setParameter(id, value) {
      safeApplyAudioParam(node, id, value, ctx.currentTime);
    },
    setParameterAt(id, value, when) {
      safeApplyAudioParam(node, id, value, when);
    },
    dispose() {
      if (disposed) return; // idempotent — engine rebuild paths may re-dispose
      disposed = true;
      node.disconnect();
      input.disconnect();
      output.disconnect();
    },
  };
}

import type { EffectRuntime } from "../effects/types";
import { attachProcessorErrorGuard } from "./processor-errors";
import { safeApplyAudioParam } from "./safeAudioParam";

/**
 * KOREŇ (bassHarmonic) node wrapper — plain AudioParam surface, same
 * contract as the M2 mastering nodes (zenit-m2-nodes.ts): every parameter
 * is an AudioParam on the processor, so live writes and offline automation
 * (`setParameterAt` → setValueAtTime) both work without port messages.
 *
 * The processor module is a LAZY worklet (public/bass-harmonic-worklet.js):
 * the registry factory only calls this when `isWorkletReady("bassHarmonic")`
 * is true; unloaded contexts get the honest 1:1 bypass from the factory.
 */
const BASS_HARMONIC_PARAMS = [
  "drive",
  "focusHz",
  "harmonics",
  "subAnchor",
  "lowCut",
  "range",
  "attack",
  "release",
  "sustain",
  "retrig",
  "character",
  "width",
  "mix",
  "output",
] as const;

export function createBassHarmonicNode(
  ctx: BaseAudioContext,
  instance: { params: Record<string, number> },
): EffectRuntime {
  const node = new AudioWorkletNode(ctx, "bass-harmonic-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelInterpretation: "speakers",
  });
  attachProcessorErrorGuard(node, "bass-harmonic-processor");

  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(node);
  node.connect(output);

  for (const id of BASS_HARMONIC_PARAMS) {
    safeApplyAudioParam(node, id, instance.params[id] ?? 0);
  }

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
      node.port.onmessage = null;
      node.port.close();
      node.disconnect();
      input.disconnect();
      output.disconnect();
    },
  };
}

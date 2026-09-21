import type { EffectRuntime } from "../effects/types";
import { safeApplyAudioParam } from "./safeAudioParam";
import { createLfoSyncController } from "../effects/tempo-sync";

/**
 * Create a Frequency Shifter AudioWorkletNode synchronously.
 * The processor module MUST be pre-loaded via `loadCoreWorklets()` first —
 * callers gate construction behind `isWorkletReady("freqShifter", ctx)`.
 *
 * Single-sideband Hilbert shifter (Bode-style): shift + fine detune the
 * spectrum without preserving harmonic ratios, with a pro sideband select,
 * sweep LFO, feedback delay loop, drive, wet tone trim and stereo spread.
 */
export function createFreqShiftNode(
  ctx: BaseAudioContext,
  instance: { params: Record<string, number> },
  bpm?: number,
): EffectRuntime {
  const node = new AudioWorkletNode(ctx, "freqshift-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelInterpretation: "speakers",
  });

  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(node).connect(output);

  // Replay every descriptor parameter present in the instance so partial
  // documents (older schemas, presets) keep their defaults from the worklet.
  for (const param of [
    "shift",
    "fine",
    "side",
    "lfoRate",
    "lfoDepth",
    "feedback",
    "delayTime",
    "drive",
    "tone",
    "spread",
    "mix",
  ] as const) {
    const v = instance.params[param];
    if (Number.isFinite(v)) safeApplyAudioParam(node, param, v);
  }

  // C2 tempo-sync: lfoRate stays Hz; a musical `sync` locks the sweep LFO
  // to the transport and follows bpm pushes via the engine hook.
  const lfoSync = createLfoSyncController({
    rateParamId: "lfoRate",
    defaultRate: 0.1,
    initialRate: instance.params.lfoRate,
    initialSync: instance.params.sync,
    initialBpm: bpm,
    write: (paramId, value, when) =>
      when == null ? safeApplyAudioParam(node, paramId, value) : safeApplyAudioParam(node, paramId, value, when),
  });
  lfoSync.parameter("lfoRate", instance.params.lfoRate ?? 0.1, null);

  return {
    input,
    output,
    setParameter: (id, v) => {
      if (lfoSync.parameter(id, v, ctx.currentTime)) return;
      safeApplyAudioParam(node, id, v, ctx.currentTime);
    },
    setParameterAt: (id, v, when) => {
      if (lfoSync.parameter(id, v, when)) return;
      safeApplyAudioParam(node, id, v, when);
    },
    syncBpm(next, when) {
      lfoSync.syncBpm(next, when ?? ctx.currentTime);
    },
    getAudioParam: (paramId: string) => node.parameters.get(paramId) ?? null,
    dispose() {
      node.disconnect();
      input.disconnect();
      output.disconnect();
    },
  };
}

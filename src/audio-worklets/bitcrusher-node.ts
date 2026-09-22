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
  // DRIVE pushes more level into the quantizer (deeper crush character);
  // TONE lowpasses the crushed signal (tames the aliasing harshness).
  const drive = ctx.createGain();
  const tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  tone.Q.value = 0.7;
  input.connect(dry).connect(output);
  input.connect(wet).connect(drive).connect(node).connect(tone).connect(out).connect(output);

  // Set initial parameter values (safeApplyAudioParam guards non-finite)
  safeApplyAudioParam(node, "bits", instance.params.bits ?? 8);
  safeApplyAudioParam(node, "downsample", instance.params.downsample ?? 1);
  const bitsParam = node.parameters.get("bits");
  const dsParam = node.parameters.get("downsample");
  // drive/tone/mix/output live on NATIVE nodes (Gain/Biquad), not on the
  // worklet — safeApplyAudioParam can't cover them. Apply the same contract
  // by hand: a corrupt (non-finite) stored value is dropped, never thrown,
  // or it would abort the engine's whole-track bulk param sync.
  const driveVal = instance.params.drive ?? 0;
  if (Number.isFinite(driveVal)) drive.gain.value = 1 + driveVal * 7;
  const toneVal = instance.params.tone ?? 18000;
  if (Number.isFinite(toneVal)) tone.frequency.value = toneVal;

  // Set initial mix
  const mixVal = instance.params.mix ?? 1;
  if (Number.isFinite(mixVal)) {
    wet.gain.value = mixVal;
    dry.gain.value = 1 - mixVal;
  }

  // Set initial output gain
  const outputDb = instance.params.output ?? 0;
  if (Number.isFinite(outputDb)) out.gain.value = Math.pow(10, outputDb / 20);

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
        case "drive":
          if (Number.isFinite(v)) drive.gain.setTargetAtTime(1 + v * 7, now, 0.02);
          break;
        case "tone":
          if (Number.isFinite(v)) tone.frequency.setTargetAtTime(v, now, 0.02);
          break;
        case "mix":
          if (Number.isFinite(v)) {
            wet.gain.setTargetAtTime(v, now, 0.02);
            dry.gain.setTargetAtTime(1 - v, now, 0.02);
          }
          break;
        case "output":
          if (Number.isFinite(v)) out.gain.setTargetAtTime(Math.pow(10, v / 20), now, 0.02);
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
        case "drive":
          if (Number.isFinite(v)) drive.gain.setTargetAtTime(1 + v * 7, when, 0.02);
          break;
        case "tone":
          if (Number.isFinite(v)) tone.frequency.setTargetAtTime(v, when, 0.02);
          break;
        case "mix":
          if (Number.isFinite(v)) {
            wet.gain.setTargetAtTime(v, when, 0.02);
            dry.gain.setTargetAtTime(1 - v, when, 0.02);
          }
          break;
        case "output":
          if (Number.isFinite(v)) out.gain.setTargetAtTime(Math.pow(10, v / 20), when, 0.02);
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
      drive.disconnect();
      tone.disconnect();
      out.disconnect();
    },
  };
}

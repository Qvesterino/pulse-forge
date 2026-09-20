import type { EffectRuntime } from "../effects/types";
import { safeApplyAudioParam } from "./safeAudioParam";

/**
 * Create a Vocoder AudioWorkletNode synchronously.
 * The processor module MUST be pre-loaded via `loadCoreWorklets()` first —
 * callers gate construction behind `isWorkletReady("vocoder", ctx)`.
 *
 * Uses a 2-input AudioWorkletNode (the sidechain precedent):
 *   Input 0 — CARRIER (sculpted signal, this track)
 *   Input 1 — MODULATOR (sculpting signal, `sidechainTrackId` track)
 *
 * Without a modulator connection the processor passes the carrier through
 * 1:1; the runtime reports `degraded` so the UI can say why.
 */
export function createVocoderNode(ctx: BaseAudioContext, instance: { params: Record<string, number> }): EffectRuntime {
  const node = new AudioWorkletNode(ctx, "vocoder-processor", {
    numberOfInputs: 2, // [0]=carrier, [1]=modulator
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelInterpretation: "speakers",
  });

  const input = ctx.createGain();
  const output = ctx.createGain();
  // Tracked so a repoint (or dispose) detaches the PREVIOUS modulator —
  // without this the old source stayed connected into input 1 forever.
  let modulatorSource: AudioNode | null = null;

  input.connect(node, 0, 0);
  node.connect(output);

  for (const param of [
    "bands",
    "loFreq",
    "hiFreq",
    "q",
    "attack",
    "release",
    "shift",
    "sibilance",
    "stereo",
    "level",
    "mix",
  ] as const) {
    const v = instance.params[param];
    if (Number.isFinite(v)) safeApplyAudioParam(node, param, v);
  }

  return {
    input,
    output,
    degraded: true,
    degradedReason: modulatorSource
      ? undefined
      : "No modulator track routed — Vocoder passes the carrier through (set a SIDE CHAIN source)",
    setParameter(id, v) {
      safeApplyAudioParam(node, id, v, ctx.currentTime);
      if (id === "bands" || id === "shift" || id === "q") {
        // The processor rebuilds its filterbank on the next block; the
        // degraded flag stays as-is (it only reflects the modulator wiring).
      }
    },
    setParameterAt(id, v, when) {
      safeApplyAudioParam(node, id, v, when);
    },
    getAudioParam: (paramId: string) => node.parameters.get(paramId) ?? null,
    setSidechainInput(source: AudioNode | null) {
      if (modulatorSource) {
        try {
          modulatorSource.disconnect(node, 0, 1);
        } catch {
          /* not connected */
        }
        modulatorSource = null;
      }
      if (source) {
        source.connect(node, 0, 1);
        modulatorSource = source;
        // A live modulator clears the degraded state (the reason is a
        // snapshot by design — the UI re-reads it from getDegradedFx).
        this.degraded = false;
        this.degradedReason = undefined;
      } else {
        this.degraded = true;
        this.degradedReason =
          "No modulator track routed — Vocoder passes the carrier through (set a SIDE CHAIN source)";
      }
    },
    dispose() {
      if (modulatorSource) {
        try {
          modulatorSource.disconnect(node, 0, 1);
        } catch {
          /* not connected */
        }
        modulatorSource = null;
      }
      node.disconnect();
      input.disconnect();
      output.disconnect();
    },
  };
}

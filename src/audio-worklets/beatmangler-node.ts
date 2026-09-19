import type { EffectRuntime } from "../effects/types";

/**
 * Create a Beat Mangler AudioWorkletNode synchronously.
 * The processor module MUST be pre-loaded via `loadCoreWorklets()` first —
 * callers gate construction behind `isWorkletReady("beatMangler", ctx)`.
 *
 * Envelope arrays + BPM + mode flow over the message port (`setSteps`,
 * `setBpm`, `setMode`); the port callbacks live in the processor. The runtime
 * caches the last steps REFERENCE — the engine's sync loop calls `setSteps`
 * on every project sync, and identical references are ignored (cheap).
 */
export function createBeatManglerNode(
  ctx: BaseAudioContext,
  instance: { params: Record<string, number>; id?: string; volumeSteps?: number[]; pitchSteps?: number[] },
  bpm: number,
): EffectRuntime {
  const node = new AudioWorkletNode(ctx, "beatmangler-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 2,
    channelInterpretation: "speakers",
  });

  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(node).connect(output);

  const setParam = (id: string, v: number, when?: number) => {
    const p = node.parameters.get(id);
    if (!p) return;
    if (when === undefined) p.value = v;
    else p.setValueAtTime(v, when);
  };
  setParam("mix", instance.params.mix ?? 1);

  let lastVolume: readonly number[] | undefined;
  let lastPitch: readonly number[] | undefined;
  const pushSteps = (volume?: number[], pitch?: number[]) => {
    if (volume === lastVolume && pitch === lastPitch) return;
    lastVolume = volume;
    lastPitch = pitch;
    node.port.postMessage({
      type: "steps",
      volume: volume && volume.length > 0 ? volume : null,
      pitch: pitch && pitch.length > 0 ? pitch : null,
    });
  };
  pushSteps(instance.volumeSteps, instance.pitchSteps);
  node.port.postMessage({ type: "bpm", bpm });

  let lastMode = instance.params.playMode ?? 0;
  let lastFill = instance.params.repeatFill ?? 0;
  const pushMode = () => node.port.postMessage({ type: "mode", playMode: lastMode, repeatFill: lastFill });
  pushMode();

  return {
    input,
    output,
    setParameter: (id, v) => {
      if (id === "playMode") {
        lastMode = v;
        pushMode();
      } else if (id === "repeatFill") {
        lastFill = v;
        pushMode();
      } else if (id === "mix") {
        setParam("mix", v, ctx.currentTime);
      }
    },
    setParameterAt: (id, v, when) => setParam(id, v, when),
    /** Engine sync path: doc `volumeSteps`/`pitchSteps` reference changed. */
    setSteps: (volume: readonly number[] | undefined, pitch: readonly number[] | undefined) =>
      pushSteps(volume as number[] | undefined, pitch as number[] | undefined),
    syncBpm: (next) => node.port.postMessage({ type: "bpm", bpm: next }),
    getAudioParam: (paramId: string) => node.parameters.get(paramId) ?? null,
    dispose() {
      node.disconnect();
      input.disconnect();
      output.disconnect();
    },
  };
}

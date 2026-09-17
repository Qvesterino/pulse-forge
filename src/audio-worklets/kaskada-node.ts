import type { EffectRuntime } from "../effects/types";

/**
 * Main-thread wrapper for the KYX Kaskáda AudioWorklet delay processor.
 *
 * All parameters are k-rate — set via node.parameters.get(id).setValueAtTime().
 * `bpm` is a hidden parameter used to resolve tempo-synced delay times.
 * `syncBpm` on the runtime pushes the effective (scene) tempo from Wave 1.
 *
 * Dual-spectrum meters flow over the port (same contract as Ultina): the
 * worklet analyses only while a consumer (KaskadaPanel) is attached, the
 * node caches the latest frame for getMeters() and enforces the gate so a
 * straggler message after disable can never surface stale data.
 */
export function createKaskadaNode(ctx: BaseAudioContext, instance: { params: Record<string, number> }): EffectRuntime {
  const node = new AudioWorkletNode(ctx, "kaskada", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelInterpretation: "speakers",
  });

  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(node);
  node.connect(output);

  const setParam = (id: string, v: number, when?: number) => {
    const param = node.parameters.get(id);
    if (!param) return;
    if (when === undefined) param.value = v;
    else param.setValueAtTime(v, when);
  };

  // Apply initial params
  for (const [id, v] of Object.entries(instance.params)) setParam(id, v);

  let meters: unknown = null;
  let metersWanted = false;
  let disposed = false;

  // App-side default: panels opt IN — a Kaskáda with no panel open never
  // runs the FFT. The node also ENFORCES the gate: offline renders deliver
  // port messages slightly late, and a gated instance must surface no
  // meters at all.
  node.port.postMessage({ type: "setMeters", enabled: false });
  node.port.onmessage = (event) => {
    const msg = event.data as { type?: string; bands?: unknown } | null;
    if (msg?.type === "meters" && metersWanted) meters = msg.bands;
  };

  return {
    input,
    output,
    setParameter: (id, value) => setParam(id, value),
    setParameterAt: (id, value, when) => setParam(id, value, when),
    syncBpm: (bpm) => setParam("bpm", bpm),
    getMeters: () => meters,
    setMetersEnabled(enabled: boolean) {
      if (disposed) return;
      metersWanted = enabled;
      if (!enabled) meters = null; // no stale reads behind a closed panel
      node.port.postMessage({ type: "setMeters", enabled });
    },
    dispose: () => {
      if (disposed) return; // idempotent — engine rebuild paths may re-dispose
      disposed = true;
      metersWanted = false;
      meters = null;
      // No port.close(): a dropped MessagePort can discard already-queued
      // messages; dropping the last JS reference lets the implementation
      // close it after delivery (see ultinaNode.ts).
      node.port.onmessage = null;
      node.disconnect();
      input.disconnect();
      output.disconnect();
    },
  };
}

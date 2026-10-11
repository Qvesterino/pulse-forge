import type { EffectRuntime } from "../effects/types";
import { attachProcessorErrorGuard } from "./processor-errors";
import { safeApplyAudioParam } from "./safeAudioParam";

/**
 * KOREŇ (bassHarmonic) node wrapper — plain AudioParam surface, same
 * contract as the M2 mastering nodes (zenit-m2-nodes.ts): every parameter
 * is an AudioParam on the processor, so live writes and offline automation
 * (`setParameterAt` → setValueAtTime) both work without port messages.
 *
 * Two inputs: [0] main audio, [1] sidechain KEY (PUMP/DUCK). `setSidechainInput`
 * follows the duck-typed engine contract (AudioEngine.syncFxSidechains) used
 * by sidechain-node/compressor-node: identical repoints early-return because
 * the engine re-asserts wiring on every project sync.
 *
 * The processor posts a small throttled telemetry frame (`type:"koren"`) for
 * the KOREŇ panel visualizer and the rack mini meter. The node caches the
 * last validated frame; `getMeters()` is the only consumer surface. Telemetry
 * needs no enable gate — it is a few scalars at ~20 Hz, same discipline as
 * the compressor's gain-reduction frames.
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
  "keyMode",
  "mix",
  "output",
] as const;

/** Validated live telemetry frame for panels/meters. */
export interface KorenMeterFrame {
  f0: number;
  clarity: number;
  harm: number;
  key: number;
  partials: Float32Array | null;
}

export function createBassHarmonicNode(
  ctx: BaseAudioContext,
  instance: { params: Record<string, number> },
): EffectRuntime {
  const node = new AudioWorkletNode(ctx, "bass-harmonic-processor", {
    numberOfInputs: 2,
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

  // Current key feed on worklet input 1 — tracked so a repoint (or dispose)
  // detaches the PREVIOUS source; otherwise the old subgraph stays connected
  // into the key envelope forever and both feeds sum.
  let sidechainSource: AudioNode | null = null;
  let meters: KorenMeterFrame | null = null;
  let disposed = false;

  node.port.onmessage = (event) => {
    const msg = event.data as {
      type?: unknown;
      f0?: unknown;
      clarity?: unknown;
      harm?: unknown;
      key?: unknown;
      partials?: unknown;
    } | null;
    if (msg?.type !== "koren") return;
    const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
    if (!finite(msg.f0) || !finite(msg.clarity) || !finite(msg.harm) || !finite(msg.key)) return;
    meters = {
      f0: msg.f0,
      clarity: msg.clarity,
      harm: msg.harm,
      key: msg.key,
      partials: msg.partials instanceof Float32Array ? msg.partials : null,
    };
  };

  return {
    input,
    output,
    setParameter(id, value) {
      safeApplyAudioParam(node, id, value, ctx.currentTime);
    },
    setParameterAt(id, value, when) {
      safeApplyAudioParam(node, id, value, when);
    },
    setSidechainInput(source: AudioNode | null) {
      const next = source ?? null;
      // The engine re-runs sidechain wiring on EVERY project sync — tearing
      // the live edge down on each committed fader move would re-attack the
      // key envelope. Identical repoints must be a no-op.
      if (next === sidechainSource) return;
      if (sidechainSource) {
        try {
          sidechainSource.disconnect(node, 0, 1);
        } catch {
          /* not connected */
        }
        sidechainSource = null;
      }
      if (next) {
        next.connect(node, 0, 1);
        sidechainSource = next;
      }
    },
    getMeters: () => meters,
    dispose() {
      if (disposed) return; // idempotent — engine rebuild paths may re-dispose
      disposed = true;
      meters = null;
      if (sidechainSource) {
        try {
          sidechainSource.disconnect(node, 0, 1);
        } catch {
          /* not connected */
        }
        sidechainSource = null;
      }
      // No port.close(): a dropped MessagePort can discard already-queued
      // messages; dropping the last JS reference closes it after delivery
      // (same note as kaskada-node/ultinaNode).
      node.port.onmessage = null;
      node.disconnect();
      input.disconnect();
      output.disconnect();
    },
  };
}

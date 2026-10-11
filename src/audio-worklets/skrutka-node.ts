import type { EffectRuntime } from "../effects/types";
import { LFO_SYNC_DIVISIONS, createLfoSyncController, lfoSyncIndex } from "../effects/tempo-sync";
import { attachProcessorErrorGuard } from "./processor-errors";
import { safeApplyAudioParam } from "./safeAudioParam";

/**
 * TWIST (skrutka) node wrapper — v2.
 *
 * Plain AudioParam surface (M2 pattern): every rack parameter is an
 * AudioParam on the processor, so live writes and offline automation both
 * work without port messages. Two extra host-side contracts:
 *
 *  - LFO tempo sync (the flanger/tremolo contract): `lfoRate` stays Hz on
 *    the document; `lfoSync` picks a musical division and
 *    `createLfoSyncController` writes the effective Hz into the worklet's
 *    `lfoHz` param, following BPM pushes via `syncBpm`.
 *  - LFO phase anchor: `onTransportStarted` writes `lfoPhase` (0..1) at the
 *    transport start time so the sweep is phase-locked to the grid; the
 *    processor free-runs from 0 when no anchor lands (deterministic).
 *
 * Two inputs: [0] main audio, [1] sidechain KEY (PUMP/DUCK) — the same
 * duck-typed `setSidechainInput` contract as GROW; identical repoints
 * early-return because the engine re-asserts wiring on every project sync.
 *
 * The processor posts a small throttled telemetry frame (`type:"skrutka"`)
 * for the panel's state chips / moving dot. Observer-only; `getMeters()` is
 * the only consumer surface. The random-step LFO seed rides in
 * `processorOptions` from the factory env (persisted seed contract).
 *
 * The processor module is a LAZY worklet (public/skrutka-worklet.js): the
 * registry factory only calls this when `isWorkletReady("skrutka")` is true;
 * unloaded contexts get the honest 1:1 bypass from the factory.
 */
const SKRUTKA_PARAMS = [
  "dispersion",
  "punch",
  "punchHz",
  "punchMix",
  "focusHz",
  "shape",
  "spread",
  "field",
  "dyn",
  "dynPunch",
  "keyMode",
  "lfoShape",
  "lfoDepth",
  "mix",
  "output",
] as const;

/** Validated live telemetry frame for the panel. */
export interface SkrutkaMeterFrame {
  lfo: number;
  env: number;
  key: number;
  radius: number;
  /** Current dynamic PUNCH radius (0 = stage off). */
  punch: number;
}

export function createSkrutkaNode(
  ctx: BaseAudioContext,
  instance: { params: Record<string, number> },
  env?: { bpm?: number; seed?: number },
): EffectRuntime {
  const node = new AudioWorkletNode(ctx, "skrutka-processor", {
    numberOfInputs: 2,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelInterpretation: "speakers",
    processorOptions: { seed: env?.seed ?? 0 },
  });
  attachProcessorErrorGuard(node, "skrutka-processor");

  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(node);
  node.connect(output);

  // C2 tempo-sync: the document carries `lfoRate` (Hz) + `lfoSync`
  // (division); the worklet only ever sees the effective `lfoHz`.
  const lfo = createLfoSyncController({
    rateParamId: "lfoHz",
    defaultRate: 0.5,
    initialRate: instance.params.lfoRate,
    initialSync: instance.params.lfoSync,
    initialBpm: env?.bpm,
    write: (paramId, value, when) =>
      when == null ? safeApplyAudioParam(node, paramId, value) : safeApplyAudioParam(node, paramId, value, when),
  });
  lfo.parameter("lfoHz", instance.params.lfoRate ?? 0.5, null);
  let syncIndex = lfoSyncIndex(instance.params.lfoSync);

  for (const id of SKRUTKA_PARAMS) {
    safeApplyAudioParam(node, id, instance.params[id] ?? 0);
  }

  // Current key feed on worklet input 1 — tracked so a repoint (or dispose)
  // detaches the PREVIOUS source; otherwise the old subgraph stays connected
  // into the key envelope forever and both feeds sum.
  let sidechainSource: AudioNode | null = null;
  let meters: SkrutkaMeterFrame | null = null;
  let disposed = false;

  node.port.onmessage = (event) => {
    const msg = event.data as {
      type?: unknown;
      lfo?: unknown;
      env?: unknown;
      key?: unknown;
      radius?: unknown;
      punch?: unknown;
    } | null;
    if (msg?.type !== "skrutka") return;
    const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
    if (!finite(msg.lfo) || !finite(msg.env) || !finite(msg.key) || !finite(msg.radius)) return;
    meters = {
      lfo: msg.lfo,
      env: msg.env,
      key: msg.key,
      radius: msg.radius,
      punch: finite(msg.punch) ? msg.punch : 0,
    };
  };

  return {
    input,
    output,
    setParameter(id, value) {
      if (id === "lfoRate") {
        lfo.parameter("lfoHz", value, null);
        return;
      }
      if (id === "lfoSync") {
        syncIndex = lfoSyncIndex(value);
        lfo.parameter("sync", value, null);
        return;
      }
      safeApplyAudioParam(node, id, value, ctx.currentTime);
    },
    setParameterAt(id, value, when) {
      if (id === "lfoRate") {
        lfo.parameter("lfoHz", value, when);
        return;
      }
      if (id === "lfoSync") {
        syncIndex = lfoSyncIndex(value);
        lfo.parameter("sync", value, when);
        return;
      }
      safeApplyAudioParam(node, id, value, when);
    },
    syncBpm(bpm, when) {
      lfo.syncBpm(bpm, when ?? ctx.currentTime);
    },
    onTransportStarted(time, beatPhase, positionBeats) {
      const mult = LFO_SYNC_DIVISIONS[syncIndex]?.mult ?? 0;
      const beats = typeof positionBeats === "number" && Number.isFinite(positionBeats) ? positionBeats : beatPhase;
      const phase = mult > 0 ? (((beats * mult) % 1) + 1) % 1 : 0;
      safeApplyAudioParam(node, "lfoPhase", phase, time);
    },
    setSidechainInput(source: AudioNode | null) {
      const next = source ?? null;
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
      // messages; dropping the last JS reference closes it after delivery.
      node.port.onmessage = null;
      node.disconnect();
      input.disconnect();
      output.disconnect();
    },
  };
}

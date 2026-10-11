import type { EffectRuntime } from "../effects/types";
import {
  TWIST_CURVE_PARAM_IDS,
  morphTwistParams,
  readTwistCurvesState,
  type TwistCurvesState,
} from "../effects/skrutka-curves";
import { LFO_SYNC_DIVISIONS, createLfoSyncController, lfoSyncIndex } from "../effects/tempo-sync";
import { attachProcessorErrorGuard } from "./processor-errors";
import { safeApplyAudioParam } from "./safeAudioParam";

/**
 * TWIST (skrutka) node wrapper — v2 + CURVE SNAPSHOTS (v2.3).
 *
 * Plain AudioParam surface (M2 pattern): every DSP parameter is an AudioParam
 * on the processor, so live writes and offline automation both work without
 * port messages. Host-side contracts on top:
 *
 *  - LFO tempo sync (the flanger/tremolo contract): `lfoRate` stays Hz on the
 *    document; `lfoSync` picks a musical division and `createLfoSyncController`
 *    writes the effective Hz into the worklet's `lfoHz` param, following BPM
 *    pushes via `syncBpm`.
 *  - LFO phase anchor: `onTransportStarted` writes `lfoPhase` (0..1) at the
 *    transport start time so the sweep is phase-locked to the grid; the
 *    processor free-runs from 0 when no anchor lands (deterministic).
 *  - CURVE SNAPSHOTS: the A/B snapshots ride `instance.deviceState`
 *    (kind "twist-curves-v1") and the `morph` rack param blends between them.
 *    The interpolation is HOST-side (`morphTwistParams`): `morph` is a real
 *    param, so an automation lane or an intensity-sourced macro drives it;
 *    `setCurves` re-seeds the snapshots live after a STORE/CLEAR (a later
 *    chain rebuild re-reads `deviceState` and lands on the same sound).
 *    With no snapshots stored `morph` is a no-op and the render is untouched.
 *
 * Two inputs: [0] main audio, [1] sidechain KEY (PUMP/DUCK) — the same
 * duck-typed `setSidechainInput` contract as KOREŇ; identical repoints
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

/** Extra runtime surface used by the panel (not part of EffectRuntime). */
export interface SkrutkaCurveRuntime {
  setCurves(a: Record<string, number> | null, b: Record<string, number> | null): void;
}

export function createSkrutkaNode(
  ctx: BaseAudioContext,
  instance: {
    params: Record<string, number>;
    deviceState?: { kind: string; data: Record<string, unknown> } | null;
  },
  env?: { bpm?: number; seed?: number },
): EffectRuntime & SkrutkaCurveRuntime {
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

  // --- CURVE SNAPSHOTS (v2.3) --------------------------------------------
  const base: Record<string, number> = { ...instance.params };
  let curves: TwistCurvesState | null = readTwistCurvesState(instance.deviceState) ?? null;
  let morphValue = Math.min(1, Math.max(0, instance.params.morph ?? 0));
  const hasCurves = (): boolean => !!(curves?.slots.A || curves?.slots.B);

  /** Write a full parameter map through the right routing (LFO ids included). */
  const writeMap = (map: Record<string, number>, when?: number): void => {
    for (const id of TWIST_CURVE_PARAM_IDS) {
      const value = map[id];
      if (value === undefined) continue;
      if (id === "lfoRate") {
        lfo.parameter("lfoHz", value, when ?? null);
        continue;
      }
      if (id === "lfoSync") {
        syncIndex = lfoSyncIndex(value);
        lfo.parameter("sync", value, when ?? null);
        continue;
      }
      safeApplyAudioParam(node, id, value, when);
    }
  };

  /** Write the effective (morphed) parameter map; a no-op without snapshots. */
  const applyEffective = (when?: number): void => {
    if (!hasCurves()) return;
    writeMap(morphTwistParams(base, curves, morphValue), when);
  };
  applyEffective(ctx.currentTime);

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
      if (id === "morph") {
        if (typeof value === "number" && Number.isFinite(value)) {
          morphValue = Math.min(1, Math.max(0, value));
          applyEffective(ctx.currentTime);
        }
        return;
      }
      if (id === "lfoRate") {
        base.lfoRate = value;
        lfo.parameter("lfoHz", value, null);
        applyEffective(ctx.currentTime);
        return;
      }
      if (id === "lfoSync") {
        base.lfoSync = value;
        syncIndex = lfoSyncIndex(value);
        lfo.parameter("sync", value, null);
        applyEffective(ctx.currentTime);
        return;
      }
      base[id] = value;
      if (hasCurves()) applyEffective(ctx.currentTime);
      else safeApplyAudioParam(node, id, value, ctx.currentTime);
    },
    setParameterAt(id, value, when) {
      if (id === "morph") {
        if (typeof value === "number" && Number.isFinite(value)) {
          morphValue = Math.min(1, Math.max(0, value));
          applyEffective(when);
        }
        return;
      }
      if (id === "lfoRate") {
        base.lfoRate = value;
        lfo.parameter("lfoHz", value, when);
        applyEffective(when);
        return;
      }
      if (id === "lfoSync") {
        base.lfoSync = value;
        syncIndex = lfoSyncIndex(value);
        lfo.parameter("sync", value, when);
        applyEffective(when);
        return;
      }
      base[id] = value;
      if (hasCurves()) applyEffective(when);
      else safeApplyAudioParam(node, id, value, when);
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
    setCurves(a, b) {
      const hadCurves = hasCurves();
      curves = a || b ? { slots: { ...(a ? { A: { ...a } } : {}), ...(b ? { B: { ...b } } : {}) } } : null;
      // Clearing restores the live knob values; storing re-seeds the morph.
      if (curves) applyEffective(ctx.currentTime);
      else if (hadCurves) writeMap(base, ctx.currentTime);
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

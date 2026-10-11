import type { EffectRuntime } from "../effects/types";

import { attachProcessorErrorGuard } from "./processor-errors";
import { safeApplyAudioParam } from "./safeAudioParam";

/**
 * PORTAL (portal) node wrapper.
 *
 * Plain AudioParam surface (the M2 pattern, same contract as SKRUTKA and
 * KOREŃ): every rack parameter is an AudioParam on the processor, so live writes
 * and offline automation both work without port messages. That matters twice
 * over here — Chromium does not pump processor message queues mid-render
 * (NEW-EFFECT-CHECKLIST §5), and the DSP reads its controls once per block
 * (k-rate), so an AudioParam surface cannot introduce either failure.
 *
 * Meters are opt-IN: the processor only analyses while a consumer is attached,
 * the node caches the latest frame, and it enforces the gate itself so a
 * straggler message arriving after `disable` can never surface stale data.
 *
 * PORTAL is a LAZY worklet (public/spectral-worklet.js). The registry factory
 * only calls this when `isWorkletReady("portal", ctx)` is true; a context without
 * the module gets the honest 1:1 bypass from `bypassRuntime`.
 */
const PORTAL_PARAMS = [
  "mode",
  "time",
  "sync",
  "feedback",
  "decay",
  "resonance",
  "focus",
  "focusWidth",
  "shift",
  "diffuse",
  "freeze",
  "drive",
  "tone",
  "mix",
] as const;

/** Validated live telemetry frame for the panel. */
export interface PortalMeterFrame {
  peak: number;
  activity: number;
  delaySec: number;
  frames: number;
}

/** Algorithm latency in samples, as reported by the processor on construction. */
let reportedLatency = 0;

export function createPortalNode(ctx: BaseAudioContext, instance: { params: Record<string, number> }): EffectRuntime {
  const node = new AudioWorkletNode(ctx, "portal", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelInterpretation: "speakers",
    processorOptions: { params: instance.params },
  });
  attachProcessorErrorGuard(node, "portal");

  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(node);
  node.connect(output);

  for (const id of PORTAL_PARAMS) {
    const v = instance.params[id];
    if (typeof v === "number" && Number.isFinite(v)) safeApplyAudioParam(node, id, v);
  }

  let meters: PortalMeterFrame | null = null;
  let metersWanted = false;
  let disposed = false;

  // App-side default: panels opt IN. A PORTAL with no panel open must not post
  // a telemetry frame per hop.
  node.port.postMessage({ type: "setMeters", enabled: false });
  node.port.onmessage = (event) => {
    const msg = event.data as Partial<Record<"type" | "peak" | "activity" | "delaySec" | "frames", unknown>> | null;
    if (!msg || typeof msg !== "object") return;
    const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
    if (msg.type === "latency") {
      if (finite(msg.frames)) reportedLatency = msg.frames;
      return;
    }
    if (msg.type !== "meters" || !metersWanted) return;
    if (!finite(msg.peak) || !finite(msg.activity) || !finite(msg.delaySec) || !finite(msg.frames)) return;
    meters = { peak: msg.peak, activity: msg.activity, delaySec: msg.delaySec, frames: msg.frames };
  };

  return {
    input,
    output,
    setParameter: (id, value) => safeApplyAudioParam(node, id, value),
    setParameterAt: (id, value, when) => safeApplyAudioParam(node, id, value, when),
    syncBpm(bpm, when) {
      if (Number.isFinite(bpm)) safeApplyAudioParam(node, "bpm", bpm, when);
    },
    getMeters: () => meters,
    setMetersEnabled(enabled: boolean) {
      if (disposed) return;
      metersWanted = enabled;
      if (!enabled) meters = null;
      node.port.postMessage({ type: "setMeters", enabled });
    },
    /** Algorithm latency in samples, 0 until the processor reports it. */
    getLatencyFrames(): number {
      return reportedLatency;
    },
    dispose() {
      if (disposed) return; // idempotent — engine rebuild paths may re-dispose
      disposed = true;
      meters = null;
      // No port.close(): a dropped MessagePort can discard already-queued
      // messages; dropping the last JS reference closes it after delivery.
      node.port.onmessage = null;
      node.disconnect();
      input.disconnect();
      output.disconnect();
    },
  };
}

/** Latency last reported by any PORTAL processor in this context. */
export function portalLatencyFrames(): number {
  return reportedLatency;
}

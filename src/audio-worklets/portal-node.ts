import type { EffectRuntime } from "../effects/types";

import { attachProcessorErrorGuard } from "./processor-errors";
import { safeApplyAudioParam } from "./safeAudioParam";
import { createLatencyReportReadiness } from "../effects/latencyReadiness";

/**
 * PORTAL (portal) node wrapper.
 *
 * Plain AudioParam surface (the M2 pattern, same contract as TWIST and
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
  "motionRate",
  "motionDepth",
] as const;

/** Validated live telemetry frame for the panel. */
export interface PortalMeterFrame {
  /** Sample rate defines the Nyquist endpoint of the processor's band map. */
  sampleRate: number;
  peak: number;
  activity: number;
  delaySec: number;
  frames: number;
  shiftSemitones: number;
  /** Log-spaced 0..255 magnitudes as analysed — the panel's reference trace. */
  bandsIn: Uint8Array;
  /** Log-spaced 0..255 magnitudes after the mode ran — the effect itself. */
  bandsOut: Uint8Array;
}

/** Bands per trace. Must match SPECTRAL_BANDS in spectral-core. */
export const PORTAL_BANDS = 64;

/**
 * Copy a band trace off the message.
 *
 * The worklet owns the array it posts, and a structured clone is the only thing
 * standing between the audio thread's buffer and a panel that might keep the
 * reference. The frame is validated by LENGTH and by every value being an
 * integer in 0..255 — a wrong-length array would make the canvas read past the
 * end, and a non-integer means the contract moved without us noticing.
 *
 * Returns null rather than a half-trusted array: the panel's documented answer
 * to a bad frame is "waiting", not a plausible-looking trace.
 */
function readBands(value: unknown): Uint8Array | null {
  if (!ArrayBuffer.isView(value)) return null;
  const src = value as Uint8Array;
  if (src.length !== PORTAL_BANDS) return null;
  const out = new Uint8Array(PORTAL_BANDS);
  for (let i = 0; i < PORTAL_BANDS; i++) {
    const v = src[i]!;
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    out[i] = v;
  }
  return out;
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
  let latencySamples = 0;
  const latencyReadiness = createLatencyReportReadiness();
  const latencyListeners = new Set<() => void>();

  // App-side default: panels opt IN. A PORTAL with no panel open must not post
  // a telemetry frame per hop.
  node.port.postMessage({ type: "setMeters", enabled: false });
  node.port.onmessage = (event) => {
    const msg = event.data as Record<string, unknown> | null;
    if (!msg || typeof msg !== "object") return;
    const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
    if (msg.type === "latency") {
      if (!finite(msg.frames) || !Number.isSafeInteger(msg.frames) || msg.frames < 0) return;
      const changed = latencySamples !== msg.frames;
      latencySamples = msg.frames;
      reportedLatency = msg.frames;
      latencyReadiness.markReported();
      if (changed && !disposed) for (const listener of latencyListeners) listener();
      return;
    }
    if (msg.type !== "meters" || !metersWanted) return;
    if (!finite(msg.sampleRate) || msg.sampleRate <= 40) return;
    if (!finite(msg.peak) || !finite(msg.activity) || !finite(msg.delaySec) || !finite(msg.frames)) return;
    if (!finite(msg.shiftSemitones)) return;
    const bandsIn = readBands(msg.bandsIn);
    const bandsOut = readBands(msg.bandsOut);
    // A frame with unusable traces is dropped whole. Accepting the scalars and
    // blanking the spectrum would leave the panel drawing a silent device that
    // is in fact making sound — the worst possible half-truth.
    if (!bandsIn || !bandsOut) return;
    meters = {
      sampleRate: msg.sampleRate,
      peak: msg.peak,
      activity: msg.activity,
      delaySec: msg.delaySec,
      frames: msg.frames,
      shiftSemitones: msg.shiftSemitones,
      bandsIn,
      bandsOut,
    };
  };

  return {
    input,
    output,
    getLatencySec: () => latencySamples / ctx.sampleRate,
    hasLatencyReport: () => latencyReadiness.isReported(),
    onLatencyChange(listener) {
      latencyListeners.add(listener);
      return () => {
        latencyListeners.delete(listener);
      };
    },
    waitForLatencyReport: (timeoutMs) => latencyReadiness.wait(timeoutMs),
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
    dispose() {
      if (disposed) return; // idempotent — engine rebuild paths may re-dispose
      disposed = true;
      latencyReadiness.dispose();
      latencyListeners.clear();
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

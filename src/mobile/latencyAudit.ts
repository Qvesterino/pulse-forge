/**
 * Mobile latency evidence (ADR 0053).
 *
 * Phase 3 (Oboe/AAudio + C++ DSP) is CONDITIONAL on measurements. This module
 * turns the existing acoustic loopback measurement (latencyProbe.ts) plus the
 * context's reported latency into a stable JSON report with explicit verdicts:
 *
 *   - live monitoring (the tracking gate): acoustic round trip,
 *   - MIDI → sound: reported output latency (optimistic, labelled),
 *   - sequencing: reported base latency.
 *
 * The report never claims an acoustic measurement when the user did not run
 * the loopback; in that case `nativeHostForTracking` is `"unmeasured"`.
 */
import type { AudioLatencyMeasurement } from "../audio-engine/latencyCalibration";
import { downloadBlob } from "../export/download";

export const MOBILE_LATENCY_REPORT_SCHEMA = "kyx.mobile.latency.v1";

export const MOBILE_LATENCY_THRESHOLDS = {
  /** Acoustic loopback: at or below this is usable for live monitoring. */
  trackingPassMs: 15,
  /** Above pass but at or below this is marginal; above means the native host is justified. */
  trackingMarginalMs: 25,
  /** Reported output path for MIDI → sound. Not an acoustic measurement. */
  midiPassMs: 15,
  midiMarginalMs: 30,
  /** Sequencing is far more forgiving than monitoring. */
  sequencingPassMs: 50,
  sequencingMarginalMs: 100,
} as const;

export type LatencyVerdict = "pass" | "marginal" | "fail" | "unmeasured";
export type NativeHostVerdict = "no" | "marginal" | "yes" | "unmeasured";

export interface MobileLatencyEnvironment {
  userAgent: string;
  platform: string | null;
  model: string | null;
  platformVersion: string | null;
  sampleRate: number;
  baseLatencyMs: number | null;
  outputLatencyMs: number | null;
  audioWorklet: boolean;
  hardwareConcurrency: number | null;
  deviceMemoryGb: number | null;
  mobileProfile: boolean;
}

export interface MobileLatencyReport {
  schema: typeof MOBILE_LATENCY_REPORT_SCHEMA;
  generatedAt: string;
  environment: MobileLatencyEnvironment;
  measurement: {
    source: "acoustic-loopback";
    roundTripMs: number;
    jitterMs: number;
    sampleCount: number;
    stable: boolean;
    sampleRate: number;
    measuredAt: string;
  } | null;
  verdicts: {
    liveMonitoring: LatencyVerdict;
    midiToSound: LatencyVerdict;
    sequencing: LatencyVerdict;
    nativeHostForTracking: NativeHostVerdict;
  };
  thresholds: typeof MOBILE_LATENCY_THRESHOLDS;
  reasons: string[];
}

type NavigatorWithHints = Navigator & {
  deviceMemory?: number;
  userAgentData?: {
    getHighEntropyValues?: (hints: string[]) => Promise<Record<string, unknown>>;
  };
};

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function verdict(value: number | null, pass: number, marginal: number): LatencyVerdict {
  if (value === null || !Number.isFinite(value)) return "unmeasured";
  if (value <= pass) return "pass";
  if (value <= marginal) return "marginal";
  return "fail";
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

export async function collectLatencyEnvironment(
  ctx: AudioContext,
  nav: NavigatorWithHints = navigator,
  doc: Document = document,
): Promise<MobileLatencyEnvironment> {
  const hints = nav.userAgentData?.getHighEntropyValues
    ? await withTimeout(nav.userAgentData.getHighEntropyValues(["platform", "platformVersion", "model"]), 500)
    : null;
  const base = finiteOrNull(ctx.baseLatency);
  const output = finiteOrNull(ctx.outputLatency);
  return {
    userAgent: typeof nav.userAgent === "string" ? nav.userAgent : "",
    platform: typeof hints?.platform === "string" ? hints.platform : null,
    model: typeof hints?.model === "string" ? hints.model : null,
    platformVersion: typeof hints?.platformVersion === "string" ? hints.platformVersion : null,
    sampleRate: Number.isFinite(ctx.sampleRate) && ctx.sampleRate > 0 ? Math.round(ctx.sampleRate) : 0,
    baseLatencyMs: base === null ? null : round(base * 1000),
    outputLatencyMs: output === null ? null : round(output * 1000),
    audioWorklet: typeof (ctx as BaseAudioContext).audioWorklet !== "undefined",
    hardwareConcurrency:
      typeof nav.hardwareConcurrency === "number" && Number.isFinite(nav.hardwareConcurrency)
        ? nav.hardwareConcurrency
        : null,
    deviceMemoryGb: finiteOrNull(nav.deviceMemory),
    mobileProfile: doc.documentElement?.getAttribute("data-mobile-profile") === "mobile",
  };
}

/** Pure report builder — the decision is reproducible from the JSON alone. */
export function buildMobileLatencyReport({
  environment,
  measurement,
  generatedAt = new Date().toISOString(),
}: {
  environment: MobileLatencyEnvironment;
  measurement: AudioLatencyMeasurement | null;
  generatedAt?: string;
}): MobileLatencyReport {
  const reasons: string[] = [];
  const validMeasurement =
    measurement &&
    Number.isFinite(measurement.roundTripMs) &&
    Number.isFinite(measurement.jitterMs) &&
    measurement.roundTripMs >= 0 &&
    measurement.roundTripMs <= 1000 &&
    measurement.sampleCount > 0
      ? measurement
      : null;

  if (!validMeasurement) {
    reasons.push("No acoustic loopback measurement. Run the latency calibration with a wired/acoustic return.");
  } else {
    reasons.push(
      `Acoustic loopback: ${validMeasurement.roundTripMs.toFixed(1)} ms round trip, ` +
        `${validMeasurement.jitterMs.toFixed(1)} ms median jitter, ${validMeasurement.sampleCount} pulses, ` +
        `${validMeasurement.stable ? "stable" : "unstable"}.`,
    );
    if (validMeasurement.sampleCount < 5)
      reasons.push("Fewer than five pulses matched; treat the result as weak evidence.");
  }

  const reportedForMidi = environment.outputLatencyMs ?? environment.baseLatencyMs ?? null;
  if (environment.baseLatencyMs !== null || environment.outputLatencyMs !== null) {
    reasons.push(
      `Reported device latency: base ${environment.baseLatencyMs ?? "—"} ms, output ` +
        `${environment.outputLatencyMs ?? "—"} ms (browser-reported, not acoustic).`,
    );
  } else {
    reasons.push("The browser reports neither baseLatency nor outputLatency.");
  }

  const liveMonitoring = validMeasurement
    ? verdict(
        validMeasurement.roundTripMs,
        MOBILE_LATENCY_THRESHOLDS.trackingPassMs,
        MOBILE_LATENCY_THRESHOLDS.trackingMarginalMs,
      )
    : "unmeasured";
  const midiToSound = verdict(
    reportedForMidi,
    MOBILE_LATENCY_THRESHOLDS.midiPassMs,
    MOBILE_LATENCY_THRESHOLDS.midiMarginalMs,
  );
  const sequencing = verdict(
    environment.baseLatencyMs,
    MOBILE_LATENCY_THRESHOLDS.sequencingPassMs,
    MOBILE_LATENCY_THRESHOLDS.sequencingMarginalMs,
  );

  let nativeHostForTracking: NativeHostVerdict = "unmeasured";
  if (validMeasurement) {
    if (liveMonitoring === "pass" && validMeasurement.stable) nativeHostForTracking = "no";
    else if (liveMonitoring === "pass" || liveMonitoring === "marginal") nativeHostForTracking = "marginal";
    else nativeHostForTracking = "yes";
  }

  if (liveMonitoring === "pass") {
    reasons.push(
      validMeasurement!.stable
        ? `Live monitoring round trip ${validMeasurement!.roundTripMs.toFixed(1)} ms ≤ ` +
            `${MOBILE_LATENCY_THRESHOLDS.trackingPassMs} ms; Web Audio meets the gate.`
        : `Live monitoring round trip ${validMeasurement!.roundTripMs.toFixed(1)} ms is within the pass band, ` +
            `but the run was unstable; repeat before deciding.`,
    );
  } else if (liveMonitoring === "marginal") {
    reasons.push(
      `Live monitoring is marginal (${validMeasurement!.roundTripMs.toFixed(1)} ms); ` +
        `a native host is justified only if professional monitoring is required.`,
    );
  } else if (liveMonitoring === "fail") {
    reasons.push(
      `Live monitoring fails the gate (${validMeasurement!.roundTripMs.toFixed(1)} ms > ` +
        `${MOBILE_LATENCY_THRESHOLDS.trackingMarginalMs} ms); a native host is justified for tracking.`,
    );
  }

  return {
    schema: MOBILE_LATENCY_REPORT_SCHEMA,
    generatedAt,
    environment,
    measurement: validMeasurement
      ? {
          source: "acoustic-loopback",
          roundTripMs: round(validMeasurement.roundTripMs),
          jitterMs: round(validMeasurement.jitterMs),
          sampleCount: Math.max(0, Math.floor(validMeasurement.sampleCount)),
          stable: validMeasurement.stable,
          sampleRate: Math.max(0, Math.round(validMeasurement.sampleRate)),
          measuredAt: validMeasurement.measuredAt,
        }
      : null,
    verdicts: { liveMonitoring, midiToSound, sequencing, nativeHostForTracking },
    thresholds: MOBILE_LATENCY_THRESHOLDS,
    reasons,
  };
}

export function mobileLatencyReportFilename(now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `kyx-latency-${stamp}.json`;
}

/** Build and download the evidence the ADR 0053 decision consumes. */
export async function downloadMobileLatencyReport(
  ctx: AudioContext,
  measurement: AudioLatencyMeasurement | null,
): Promise<MobileLatencyReport> {
  const environment = await collectLatencyEnvironment(ctx);
  const report = buildMobileLatencyReport({ environment, measurement });
  downloadBlob(
    new Blob([`${JSON.stringify(report, null, 2)}\n`], { type: "application/json" }),
    mobileLatencyReportFilename(),
  );
  return report;
}

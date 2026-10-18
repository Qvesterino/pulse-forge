import { describe, expect, it } from "vitest";
import type { AudioLatencyMeasurement } from "../src/audio-engine/latencyCalibration";
import {
  MOBILE_LATENCY_REPORT_SCHEMA,
  MOBILE_LATENCY_THRESHOLDS,
  buildMobileLatencyReport,
  collectLatencyEnvironment,
  mobileLatencyReportFilename,
  type MobileLatencyEnvironment,
} from "../src/mobile/latencyAudit";

const env: MobileLatencyEnvironment = {
  userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8)",
  platform: "Android",
  model: "Pixel 8",
  platformVersion: "14",
  sampleRate: 48000,
  baseLatencyMs: 10,
  outputLatencyMs: 20,
  audioWorklet: true,
  hardwareConcurrency: 8,
  deviceMemoryGb: 6,
  mobileProfile: true,
};

function measurement(roundTripMs: number, overrides: Partial<AudioLatencyMeasurement> = {}): AudioLatencyMeasurement {
  return {
    roundTripMs,
    jitterMs: 2,
    sampleCount: 8,
    stable: true,
    sampleRate: 48000,
    measuredAt: "2026-10-18T10:00:00.000Z",
    ...overrides,
  };
}

describe("native-host decision gate (ADR 0053)", () => {
  it("passes Web Audio at or below 15 ms and says no native host", () => {
    const report = buildMobileLatencyReport({ environment: env, measurement: measurement(12) });
    expect(report.verdicts).toEqual({
      liveMonitoring: "pass",
      midiToSound: "marginal",
      sequencing: "pass",
      nativeHostForTracking: "no",
    });
    expect(report.reasons.join(" ")).toMatch(/meets the gate/);
  });

  it("treats 15–25 ms as marginal, not an automatic native mandate", () => {
    const report = buildMobileLatencyReport({ environment: env, measurement: measurement(20) });
    expect(report.verdicts.liveMonitoring).toBe("marginal");
    expect(report.verdicts.nativeHostForTracking).toBe("marginal");
    expect(report.reasons.join(" ")).toMatch(/justified only if professional monitoring/);
  });

  it("justifies a native host above 25 ms", () => {
    const report = buildMobileLatencyReport({ environment: env, measurement: measurement(30) });
    expect(report.verdicts.liveMonitoring).toBe("fail");
    expect(report.verdicts.nativeHostForTracking).toBe("yes");
    expect(report.reasons.join(" ")).toMatch(/native host is justified/);
  });

  it("treats an unstable low-latency result as marginal evidence", () => {
    const report = buildMobileLatencyReport({
      environment: env,
      measurement: measurement(10, { stable: false, jitterMs: 9 }),
    });
    expect(report.verdicts.liveMonitoring).toBe("pass");
    expect(report.verdicts.nativeHostForTracking).toBe("marginal");
  });

  it("never invents a measurement; reported latency is labelled separately", () => {
    const report = buildMobileLatencyReport({ environment: env, measurement: null });
    expect(report.measurement).toBeNull();
    expect(report.verdicts.liveMonitoring).toBe("unmeasured");
    expect(report.verdicts.nativeHostForTracking).toBe("unmeasured");
    expect(report.verdicts.midiToSound).toBe("marginal"); // outputLatency 20, reported only
    expect(report.verdicts.sequencing).toBe("pass");
    expect(report.reasons.join(" ")).toMatch(/No acoustic loopback measurement/);
    expect(report.reasons.join(" ")).toMatch(/not acoustic/);
  });

  it("rejects a non-finite or empty measurement", () => {
    expect(
      buildMobileLatencyReport({
        environment: env,
        measurement: measurement(Number.NaN),
      }).measurement,
    ).toBeNull();
    expect(
      buildMobileLatencyReport({
        environment: env,
        measurement: measurement(10, { sampleCount: 0 }),
      }).measurement,
    ).toBeNull();
  });

  it("flags a weak pulse count without changing the arithmetic", () => {
    const report = buildMobileLatencyReport({
      environment: env,
      measurement: measurement(10, { sampleCount: 2, stable: false }),
    });
    expect(report.measurement?.roundTripMs).toBe(10);
    expect(report.reasons.join(" ")).toMatch(/Fewer than five pulses/);
  });

  it("uses exactly the documented threshold boundaries", () => {
    expect(MOBILE_LATENCY_THRESHOLDS.trackingPassMs).toBe(15);
    expect(MOBILE_LATENCY_THRESHOLDS.trackingMarginalMs).toBe(25);
    expect(
      buildMobileLatencyReport({ environment: env, measurement: measurement(15) }).verdicts.nativeHostForTracking,
    ).toBe("no");
    expect(
      buildMobileLatencyReport({ environment: env, measurement: measurement(25) }).verdicts.nativeHostForTracking,
    ).toBe("marginal");
    expect(
      buildMobileLatencyReport({ environment: env, measurement: measurement(25.01) }).verdicts.nativeHostForTracking,
    ).toBe("yes");
  });

  it("is JSON-safe and round-trips with the schema/thresholds intact", () => {
    const report = buildMobileLatencyReport({
      environment: env,
      measurement: measurement(12.3456, { jitterMs: 1.2345 }),
      generatedAt: "2026-10-18T12:00:00.000Z",
    });
    const json = JSON.stringify(report);
    expect(json).not.toMatch(/NaN|Infinity/);
    const parsed = JSON.parse(json) as typeof report;
    expect(parsed.schema).toBe(MOBILE_LATENCY_REPORT_SCHEMA);
    expect(parsed.thresholds).toEqual(MOBILE_LATENCY_THRESHOLDS);
    expect(parsed.measurement?.roundTripMs).toBe(12.35);
    expect(parsed.measurement?.jitterMs).toBe(1.23);
  });

  it("names the report deterministically from the timestamp", () => {
    expect(mobileLatencyReportFilename(new Date("2026-10-18T12:34:56.789Z"))).toBe(
      "kyx-latency-2026-10-18T12-34-56-789Z.json",
    );
  });
});

describe("latency environment collection", () => {
  it("reads context latency, capability fields and Android high-entropy hints", async () => {
    const ctx = {
      sampleRate: 48000,
      baseLatency: 0.01,
      outputLatency: 0.025,
      audioWorklet: {},
    } as unknown as AudioContext;
    const nav = {
      userAgent: "UA",
      hardwareConcurrency: 8,
      deviceMemory: 6,
      userAgentData: {
        getHighEntropyValues: async () => ({ platform: "Android", platformVersion: "14", model: "Pixel 8" }),
      },
    } as unknown as Navigator;
    const doc = {
      documentElement: { getAttribute: (name: string) => (name === "data-mobile-profile" ? "mobile" : null) },
    } as unknown as Document;

    const environment = await collectLatencyEnvironment(ctx, nav, doc);
    expect(environment).toMatchObject({
      sampleRate: 48000,
      baseLatencyMs: 10,
      outputLatencyMs: 25,
      audioWorklet: true,
      hardwareConcurrency: 8,
      deviceMemoryGb: 6,
      mobileProfile: true,
      platform: "Android",
      platformVersion: "14",
      model: "Pixel 8",
    });
  });

  it("does not throw when high-entropy hints are unavailable", async () => {
    const ctx = { sampleRate: 44100, audioWorklet: {} } as unknown as AudioContext;
    const nav = { userAgent: "UA", hardwareConcurrency: 4 } as unknown as Navigator;
    const doc = { documentElement: { getAttribute: () => null } } as unknown as Document;
    const environment = await collectLatencyEnvironment(ctx, nav, doc);
    expect(environment).toMatchObject({
      sampleRate: 44100,
      baseLatencyMs: null,
      outputLatencyMs: null,
      platform: null,
      model: null,
      mobileProfile: false,
    });
  });
});

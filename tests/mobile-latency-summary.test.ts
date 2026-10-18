import { describe, expect, it } from "vitest";
import { summarizeLatencyReports } from "../scripts/mobile/summarize-latency.mjs";

function report(
  model: string,
  roundTripMs: number,
  stable = true,
  overrides: { userAgent?: string; sampleCount?: number } = {},
) {
  return {
    schema: "kyx.mobile.latency.v1",
    environment: {
      model,
      platformVersion: "14",
      userAgent: overrides.userAgent ?? `ua-${model}`,
    },
    measurement: {
      source: "acoustic-loopback",
      roundTripMs,
      jitterMs: stable ? 2 : 9,
      sampleCount: overrides.sampleCount ?? 8,
      stable,
      sampleRate: 48000,
      measuredAt: "2026-10-18T00:00:00.000Z",
    },
  };
}

function deviceRuns(model: string, roundTripMs: number, stable = true) {
  return [0, 1, 2].map(() => report(model, roundTripMs, stable));
}

describe("latency report summary (ADR 0053)", () => {
  it("requires five devices with three valid runs each", () => {
    const reports = [
      ...deviceRuns("Pixel 8", 10),
      ...deviceRuns("Pixel 6a", 11),
      ...deviceRuns("Galaxy A54", 12),
      ...deviceRuns("Moto G", 13),
      ...deviceRuns("Tab S9", 14),
    ];
    const summary = summarizeLatencyReports(reports);
    expect(summary.sufficient).toBe(true);
    expect(summary.deviceCount).toBe(5);
    expect(summary.nativeHostForTracking).toBe("no");
  });

  it("marks the gate marginal when a device sits in the 15–25 ms band", () => {
    const summary = summarizeLatencyReports([
      ...deviceRuns("Pixel 8", 8),
      ...deviceRuns("Pixel 6a", 8),
      ...deviceRuns("Galaxy A54", 8),
      ...deviceRuns("Moto G", 8),
      ...deviceRuns("Tab S9", 20),
    ]);
    expect(summary.devices.find((d) => d.device.startsWith("Tab S9"))?.verdict).toBe("marginal");
    expect(summary.nativeHostForTracking).toBe("marginal");
  });

  it("justifies the native host when any supported device exceeds 25 ms", () => {
    const summary = summarizeLatencyReports([
      ...deviceRuns("Pixel 8", 8),
      ...deviceRuns("Pixel 6a", 8),
      ...deviceRuns("Galaxy A54", 8),
      ...deviceRuns("Moto G", 8),
      ...deviceRuns("Budget", 31),
    ]);
    expect(summary.devices.find((d) => d.device.startsWith("Budget"))?.verdict).toBe("yes");
    expect(summary.nativeHostForTracking).toBe("yes");
  });

  it("does not decide on fewer than five devices or fewer than three valid runs", () => {
    const four = summarizeLatencyReports([
      ...deviceRuns("Pixel 8", 8),
      ...deviceRuns("Pixel 6a", 8),
      ...deviceRuns("Galaxy A54", 8),
      ...deviceRuns("Moto G", 8),
    ]);
    expect(four.sufficient).toBe(false);
    expect(four.nativeHostForTracking).toBe("unmeasured");

    const short = summarizeLatencyReports([
      ...deviceRuns("Pixel 8", 8),
      ...deviceRuns("Pixel 6a", 8),
      ...deviceRuns("Galaxy A54", 8),
      ...deviceRuns("Moto G", 8),
      report("Tab S9", 8),
    ]);
    expect(short.sufficient).toBe(false);
    expect(short.nativeHostForTracking).toBe("unmeasured");
  });

  it("treats an unstable run as marginal even when the median is low", () => {
    const summary = summarizeLatencyReports([
      ...deviceRuns("Pixel 8", 8),
      ...deviceRuns("Pixel 6a", 8),
      ...deviceRuns("Galaxy A54", 8),
      ...deviceRuns("Moto G", 8),
      ...deviceRuns("Tab S9", 8, false),
    ]);
    expect(summary.devices.find((d) => d.device.startsWith("Tab S9"))?.stable).toBe(false);
    expect(summary.nativeHostForTracking).toBe("marginal");
  });

  it("ignores malformed reports instead of fabricating evidence", () => {
    const summary = summarizeLatencyReports([
      ...deviceRuns("Pixel 8", 8),
      ...deviceRuns("Pixel 6a", 8),
      ...deviceRuns("Galaxy A54", 8),
      ...deviceRuns("Moto G", 8),
      { schema: "wrong", environment: { model: "Fake" }, measurement: null },
    ]);
    expect(summary.deviceCount).toBe(4);
    expect(summary.sufficient).toBe(false);
  });
});

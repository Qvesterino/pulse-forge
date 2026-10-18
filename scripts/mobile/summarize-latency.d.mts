export interface LatencySummaryDevice {
  device: string;
  runs: number;
  validRuns: number;
  medianRoundTripMs: number | null;
  worstRoundTripMs: number | null;
  stable: boolean;
  verdict: "no" | "marginal" | "yes" | "insufficient";
}

export interface LatencySummary {
  schema: "kyx.mobile.latency.summary.v1";
  sufficient: boolean;
  deviceCount: number;
  devices: LatencySummaryDevice[];
  nativeHostForTracking: "no" | "marginal" | "yes" | "unmeasured";
}

export function summarizeLatencyReports(reports: unknown[]): LatencySummary;

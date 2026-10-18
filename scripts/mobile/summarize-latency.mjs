#!/usr/bin/env node
/**
 * Aggregate exported kyx.mobile.latency.v1 reports into the ADR 0053 gate.
 *
 * Usage:
 *   npm run mobile:latency-summary -- <dir>
 *   (default dir: release-evidence/mobile-latency)
 *
 * Exit 0 when the evidence is sufficient (>=5 devices, >=3 valid runs each);
 * exit 1 when more device runs are required. The printed table is the same
 * decision matrix the ADR documents.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PASS_MS = 15;
const MARGINAL_MS = 25;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function validReport(raw) {
  if (!raw || typeof raw !== "object" || raw.schema !== "kyx.mobile.latency.v1") return false;
  if (!raw.environment || typeof raw.environment !== "object") return false;
  if (raw.measurement !== null && (!raw.measurement || typeof raw.measurement !== "object")) return false;
  return true;
}

function deviceKey(report) {
  const env = report.environment ?? {};
  const model = typeof env.model === "string" && env.model ? env.model : null;
  if (model) return `${model} / Android ${env.platformVersion ?? "?"}`;
  return String(env.userAgent ?? "unknown device").slice(0, 90);
}

export function summarizeLatencyReports(reports) {
  const groups = new Map();
  for (const report of reports) {
    if (!validReport(report)) continue;
    const key = deviceKey(report);
    const list = groups.get(key) ?? [];
    list.push(report);
    groups.set(key, list);
  }

  const devices = [];
  for (const [device, runs] of groups) {
    const valid = runs.filter(
      (run) =>
        run.measurement &&
        Number.isFinite(run.measurement.roundTripMs) &&
        run.measurement.roundTripMs >= 0 &&
        Number.isFinite(run.measurement.jitterMs),
    );
    const roundTrips = valid.map((run) => run.measurement.roundTripMs);
    const med = median(roundTrips);
    const worst = roundTrips.length ? Math.max(...roundTrips) : null;
    const stable = valid.length > 0 && valid.every((run) => run.measurement.stable === true);
    let verdict = "insufficient";
    if (valid.length >= 3) {
      if (med <= PASS_MS && stable) verdict = "no";
      else if (med <= MARGINAL_MS || !stable) verdict = "marginal";
      else verdict = "yes";
    }
    devices.push({
      device,
      runs: runs.length,
      validRuns: valid.length,
      medianRoundTripMs: roundTrips.length ? Math.round(med * 100) / 100 : null,
      worstRoundTripMs: worst === null ? null : Math.round(worst * 100) / 100,
      stable,
      verdict,
    });
  }

  const sufficient = devices.length >= 5 && devices.every((device) => device.validRuns >= 3);
  let nativeHostForTracking = "unmeasured";
  if (sufficient) {
    const verdicts = devices.map((device) => device.verdict);
    nativeHostForTracking = verdicts.includes("yes") ? "yes" : verdicts.includes("marginal") ? "marginal" : "no";
  }
  return {
    schema: "kyx.mobile.latency.summary.v1",
    sufficient,
    deviceCount: devices.length,
    devices,
    nativeHostForTracking,
  };
}

function printSummary(summary) {
  console.log("KYX mobile latency gate (ADR 0053)");
  console.log(`devices: ${summary.deviceCount} (need >= 5 with >= 3 valid runs each)`);
  console.log("");
  console.log("Device                                         Runs  Median   Worst   Stable  Verdict");
  for (const device of summary.devices) {
    console.log(
      [
        device.device.slice(0, 45).padEnd(45),
        String(`${device.validRuns}/${device.runs}`).padStart(4),
        `${device.medianRoundTripMs ?? "—"}`.padStart(8),
        `${device.worstRoundTripMs ?? "—"}`.padStart(7),
        String(device.stable).padStart(6),
        device.verdict.padStart(10),
      ].join(" "),
    );
  }
  console.log("");
  console.log(`evidence sufficient: ${summary.sufficient}`);
  console.log(`nativeHostForTracking: ${summary.nativeHostForTracking}`);
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const dir = resolve(process.argv[2] ?? "release-evidence/mobile-latency");
  if (!existsSync(dir)) {
    console.error(`[latency-summary] directory not found: ${dir}`);
    process.exit(1);
  }
  const reports = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      reports.push(JSON.parse(readFileSync(join(dir, name), "utf8")));
    } catch {
      console.warn(`[latency-summary] skipped unreadable ${name}`);
    }
  }
  const summary = summarizeLatencyReports(reports);
  printSummary(summary);
  process.exit(summary.sufficient ? 0 : 1);
}

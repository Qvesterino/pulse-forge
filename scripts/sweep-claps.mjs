#!/usr/bin/env node
/**
 * CLAP library sweep (ADR 0016 — real-plugin acceptance wave).
 *
 *   npm run sweep:claps [--dir "C:/extra/clap/dir"] [--seconds 1]
 *
 * For every .clap found in the standard directories (plus any --dir extras):
 *   1. probe metadata through the crash-isolated scanner
 *   2. process-run through clap-player (bounded seconds, PcmPipeSource),
 *      classifying the run: ok-audio / silent / refused / unstable / timeout
 *
 * Verdict semantics (honest by design):
 *   ok-audio   frames streamed, all samples finite and bounded
 *   silent     ran clean but produced digital silence — NORMAL for
 *              instruments without note input; not a failure
 *   refused    plugin refused init/activate (reported, not a crash)
 *   unstable   crashed or hung mid-run
 * With zero plugins installed the sweep says exactly that and how to fix it
 * (Surge XT / Vital / u-he all ship CLAP builds) — it never pretends.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  defaultProbePath,
  ClapProbeManager,
  listInstalledClapFiles,
  defaultScanDirectories,
} from "../desktop/clap-host-manager.cjs";
import { PcmPipeSource } from "../desktop/pcm-pipe.cjs";

const PLAYER_DEFAULT = join(process.cwd(), "native", "clap-host", "build", "Release", "clap-player.exe");

/** Classify one process run from the collected stats. */
export function classifyProcessRun({ framesReceived, nonFinite, outOfRange, error, timedOut }) {
  if (timedOut) return "timeout";
  if (error) return "unstable";
  if (framesReceived > 0 && nonFinite > 0) return "unstable";
  if (framesReceived > 0) {
    if (outOfRange > 0) return "unstable";
    return "ok-audio";
  }
  return "silent";
}

/**
 * Sweep the library. Returns the full report — never throws for plugin
 * problems (crashes are data, not errors). Infrastructure failures throw.
 */
export async function sweepClaps({
  directories,
  extraDirectories = [],
  playerPath = PLAYER_DEFAULT,
  probeTimeoutMs = 8000,
  secondsPerPlugin = 1,
  onProgress = () => {},
} = {}) {
  if (!existsSync(playerPath)) {
    throw new Error(`clap-player missing (${playerPath}) — run npm run build:clap-probe first`);
  }
  const directories_ = directories ?? [...defaultScanDirectories(), ...extraDirectories];
  const files = listInstalledClapFiles(directories_);
  onProgress({ phase: "scanned", files: files.length, directories: directories_ });
  if (files.length === 0) {
    return { status: "empty", files: [], plugins: [], directories: directories_ };
  }

  const manager = new ClapProbeManager({ timeoutMs: probeTimeoutMs });
  const scan = await manager.scanPaths(files);
  const plugins = [];
  for (const entry of scan.plugins) {
    onProgress({ phase: "process", file: entry.file, name: entry.name });
    const run = await processRun(playerPath, entry.file, secondsPerPlugin);
    plugins.push({
      file: entry.file,
      name: entry.name,
      vendor: entry.vendor,
      id: entry.id,
      processVerdict: classifyProcessRun(run),
      framesReceived: run.framesReceived,
      wallMs: run.wallMs,
      ...(run.detail ? { detail: run.detail } : {}),
    });
  }
  return {
    status: "ok",
    files,
    plugins,
    metadataFailures: scan.failures ?? [],
    notClap: scan.counts?.notClap ?? 0,
    directories: directories_,
  };
}

/** Run one plugin through clap-player and collect sanity stats. */
function processRun(playerPath, dllPath, seconds) {
  return new Promise((resolve) => {
    const source = new PcmPipeSource({
      hostPath: playerPath,
      args: ["--dll", dllPath, "--rate", "48000", "--seconds", String(seconds)],
    });
    let framesReceived = 0;
    let nonFinite = 0;
    let outOfRange = 0;
    let timedOut = false;
    let error = null;
    const startedAt = Date.now();
    const timer = setTimeout(
      () => {
        timedOut = true;
        source.stop();
      },
      seconds * 1000 + 8000,
    );
    source.on("pcm", (raw) => {
      const block = raw;
      for (let i = 0; i < block.samples.length; i++) {
        const s = block.samples[i];
        if (!Number.isFinite(s)) nonFinite++;
        else if (s < -4 || s > 4) outOfRange++;
      }
      framesReceived += block.samples.length / 2;
    });
    source.on("protocol-error", (message) => {
      error = String(message);
      source.stop();
    });
    source.on("close", () => {
      clearTimeout(timer);
      resolve({ framesReceived, nonFinite, outOfRange, error, timedOut, wallMs: Date.now() - startedAt });
    });
    source.start();
  });
}

async function main() {
  const dirIndex = process.argv.indexOf("--dir");
  const extra = dirIndex >= 0 ? [process.argv[dirIndex + 1]] : [];
  const secondsIndex = process.argv.indexOf("--seconds");
  const seconds = secondsIndex >= 0 ? Number(process.argv[secondsIndex + 1]) : 1;
  try {
    const report = await sweepClaps({ extraDirectories: extra, secondsPerPlugin: seconds });
    if (report.status === "empty") {
      console.log("[sweep] no .clap files found in:");
      for (const dir of report.directories) console.log("  -", dir);
      console.log("[sweep] install real CLAPs to sweep them — free options with official CLAP builds:");
      console.log("         Surge XT (surge-synthesizer.github.io), Vital (vital.audio),");
      console.log("         u-he Triple Cheese, ChowDSP plugins. Then re-run npm run sweep:claps");
      process.exit(0);
    }
    console.log(`[sweep] ${report.plugins.length} plugin(s), ${report.notClap} not-a-clap files skipped:`);
    for (const plugin of report.plugins) {
      console.log(
        `  ${plugin.processVerdict.padEnd(9)} ${plugin.name} [${plugin.id}] — ${plugin.framesReceived} frames`,
      );
    }
    for (const failure of report.metadataFailures) {
      console.log(`  ${failure.status.padEnd(9)} ${failure.file}`);
    }
    const unstable = report.plugins.filter((p) => p.processVerdict === "unstable" || p.processVerdict === "timeout");
    process.exitCode = unstable.length > 0 ? 1 : 0;
  } catch (err) {
    console.error("[sweep] infrastructure failure:", err?.message ?? err);
    process.exitCode = 1;
  }
}

/* No top-level await: vitest requires this module for the sweep pins. */
const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop());
if (isDirectRun) void main();

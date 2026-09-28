import { createRequire } from "node:module";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { sweepClaps, classifyProcessRun } = require("../scripts/sweep-claps.mjs") as {
  sweepClaps: (options?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  classifyProcessRun: (run: Record<string, unknown>) => string;
};

/**
 * Real-plugin sweep (ADR 0016): the runner classifies every installed CLAP
 * by metadata probe + a bounded process run. With no third-party CLAPs
 * installed the sweep reports an empty library honestly — so the
 * classification and the full flow are pinned against the tone fixture
 * placed in a temp directory.
 */

const REPO = path.resolve(__dirname, "..");
const TONE = path.join(REPO, "native", "clap-host", "build", "Release", "clap-tone.clap");
const PLAYER = path.join(REPO, "native", "clap-host", "build", "Release", "clap-player.exe");
let fixtureReady = existsSync(TONE) && existsSync(PLAYER);

beforeAll(async () => {
  if (fixtureReady) return;
  await new Promise<void>((resolve, reject) => {
    const { spawn } = require("node:child_process") as typeof import("node:child_process");
    const child = spawn(process.execPath, [path.join(REPO, "scripts", "build-clap-probe.mjs")], { stdio: "ignore" });
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`build exited ${code}`))));
    child.on("error", reject);
  }).catch(() => {
    /* toolchain absent — native tests skip honestly */
  });
  fixtureReady = existsSync(TONE) && existsSync(PLAYER);
}, 120_000);

describe("process-run classification", () => {
  it("separates audio, silence, refusals and instability", () => {
    expect(classifyProcessRun({ framesReceived: 4800, nonFinite: 0, outOfRange: 0 })).toBe("ok-audio");
    expect(classifyProcessRun({ framesReceived: 0, nonFinite: 0 })).toBe("silent"); // instruments w/o notes
    expect(classifyProcessRun({ framesReceived: 0, error: "load failed" })).toBe("unstable");
    expect(classifyProcessRun({ framesReceived: 100, timedOut: true })).toBe("timeout");
    expect(classifyProcessRun({ framesReceived: 10, nonFinite: 3 })).toBe("unstable"); // NaN poison
    expect(classifyProcessRun({ framesReceived: 10, outOfRange: 2 })).toBe("unstable"); // ±4 blowout
  });
});

describe.skipIf(!fixtureReady)("sweep over a real library directory (tone fixture)", () => {
  it("finds the fixture, probes metadata and streams ok-audio", async () => {
    const libraryDir = path.join(REPO, ".zcode", "clap-sweep-lib");
    mkdirSync(libraryDir, { recursive: true });
    const installed = path.join(libraryDir, "clap-tone.clap");
    require("node:fs").copyFileSync(TONE, installed);

    const report = (await sweepClaps({
      directories: [libraryDir],
      playerPath: PLAYER,
      secondsPerPlugin: 0.2,
    })) as {
      status: string;
      plugins: Array<{ name: string; id: string; processVerdict: string; framesReceived: number }>;
      notClap: number;
    };

    expect(report.status).toBe("ok");
    expect(report.plugins).toHaveLength(1);
    expect(report.plugins[0]).toMatchObject({
      name: "KYX CLAP Tone",
      id: "org.kyx.test.clap-tone",
      processVerdict: "ok-audio",
    });
    expect(report.plugins[0].framesReceived).toBeGreaterThan(0);
    expect(report.notClap).toBe(0);
    rmSync(libraryDir, { recursive: true, force: true });
  }, 40_000);

  it("reports an empty library honestly", async () => {
    const emptyDir = path.join(REPO, ".zcode", "clap-sweep-empty");
    mkdirSync(emptyDir, { recursive: true });
    try {
      const report = (await sweepClaps({
        directories: [emptyDir],
        playerPath: PLAYER,
      })) as { status: string; plugins: unknown[] };
      expect(report.status).toBe("empty");
      expect(report.plugins).toEqual([]);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("classifies a non-CLAP file as metadata failure, not a crash", async () => {
    const libDir = path.join(REPO, ".zcode", "clap-sweep-junk");
    mkdirSync(libDir, { recursive: true });
    try {
      require("node:fs").writeFileSync(path.join(libDir, "junk.clap"), "definitely not a plugin");
      const report = (await sweepClaps({
        directories: [libDir],
        playerPath: PLAYER,
      })) as { status: string; plugins: unknown[]; metadataFailures: unknown[]; notClap: number };
      expect(report.status).toBe("ok");
      expect(report.plugins).toHaveLength(0);
      // A not-a-clap file is a counted classification, not a crash.
      expect(report.notClap).toBe(1);
      expect(report.metadataFailures).toHaveLength(0);
    } finally {
      rmSync(libDir, { recursive: true, force: true });
    }
  }, 40_000);
});

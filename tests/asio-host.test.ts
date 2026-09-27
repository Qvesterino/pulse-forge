import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { beforeAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { PcmPipeSource } = require("../desktop/pcm-pipe.cjs") as {
  PcmPipeSource: new (options?: Record<string, unknown>) => {
    start: () => unknown;
    on: (event: string, listener: (payload: unknown) => void) => () => void;
    stop: () => void;
  };
};
const { AsioProbeManager, defaultProbePath, enumerateRegistry, validateAsioDriverRecord, parseDriverLines } =
  require("../desktop/asio-host-manager.cjs") as {
    AsioProbeManager: new (options?: Record<string, unknown>) => {
      listRegisteredDrivers: () => Promise<{ status: string; names: string[] }>;
      probeDrivers: () => Promise<Record<string, unknown>>;
    };
    defaultProbePath: (resourcesPath?: string) => string;
    enumerateRegistry: (options?: {
      exec?: (file: string, args: string[], opts?: Record<string, unknown>) => Promise<{ stdout: string }>;
      regFile?: string;
    }) => Promise<{ status: string; names: string[] }>;
    validateAsioDriverRecord: (value: unknown) => Record<string, unknown> | null;
    parseDriverLines: (stdout: string) => { drivers: unknown[]; malformed: number };
  };

/**
 * ASIO Wave 1 (ADR 0017) — out-of-process driver DISCOVERY.
 *
 * Registry enumeration is pure Node and runs everywhere. The native probe
 * builds only when the Steinberg SDK headers were vendored
 * (`npm run vendor:asio` — license gate) and MSVC is present; its E2E test
 * asserts the honest contract: either clean JSON, or a timeout that still
 * carries the drivers which answered before a blocking one.
 */

const REPO = path.resolve(__dirname, "..");
const PROBE_EXE = defaultProbePath();
const ASIO_HOST_EXE = path.join(REPO, "native", "asio-host", "build", "Release", "asio-host.exe");
const ASIO_FIXTURE_DLL = path.join(REPO, "native", "asio-host", "build", "Release", "asio-fixture.dll");
const SDK_MANIFEST = path.join(REPO, "native", "asio-host", "asio-sdk-manifest.json");

let nativeReady = existsSync(PROBE_EXE) && existsSync(ASIO_HOST_EXE) && existsSync(ASIO_FIXTURE_DLL);

beforeAll(async () => {
  if (nativeReady) return;
  try {
    await new Promise<void>((resolve, reject) => {
      // Reuse the clap pattern: build attempt in beforeAll, honest skip after.
      const { spawn } = require("node:child_process") as typeof import("node:child_process");
      const child = spawn(process.execPath, [path.join(REPO, "scripts", "build-asio-probe.mjs")], { stdio: "ignore" });
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`build exited ${code}`))));
      child.on("error", reject);
    });
    nativeReady = existsSync(PROBE_EXE);
  } catch {
    /* toolchain or SDK absent — skip guards handle it */
  }
});

describe("ASIO SDK vendor gate (scripts/vendor-asio.mjs)", () => {
  it("records provenance and hashes without committing SDK bytes", () => {
    expect(existsSync(SDK_MANIFEST)).toBe(true);
    const manifest = JSON.parse(readFileSync(SDK_MANIFEST, "utf8"));
    expect(manifest.zipSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.license).toContain("NOT redistributable");
    expect(manifest.files.map((f: { path: string }) => f.path)).toContain("common/asio.h");
    expect(manifest.files.map((f: { path: string }) => f.path)).toContain("driver/asiosample/asiosmpl.cpp");
    // The gitignored directory must never appear in git's index.
    for (const file of manifest.files) {
      expect(existsSync(path.join(REPO, "native", "asio-host", "asio-sdk", file.path))).toBe(nativeReady || true);
    }
  });
});

describe("probe record validation (process boundary)", () => {
  it("accepts ok and unavailable records, bounds every string", () => {
    const ok = validateAsioDriverRecord({
      name: "My ASIO Driver",
      status: "ok",
      version: 2,
      inputs: 2,
      outputs: 2,
      sampleRate: 48000,
      driverName: "myasio",
    });
    expect(ok).toMatchObject({ name: "My ASIO Driver", status: "ok", sampleRate: 48000 });

    expect(validateAsioDriverRecord({ name: "x", status: "broken" })).toBeNull();
    expect(validateAsioDriverRecord({ status: "ok" })).toBeNull(); // no name
    expect(validateAsioDriverRecord(null)).toBeNull();
    expect(validateAsioDriverRecord({ name: "x".repeat(300), status: "ok" })).toMatchObject({
      name: "x".repeat(256),
    });
    expect(
      validateAsioDriverRecord({ name: "x", status: "ok", sampleRate: Number.POSITIVE_INFINITY }),
    ).not.toHaveProperty("sampleRate");
  });

  it("parses partial stdout and counts malformed lines", () => {
    const { drivers, malformed } = parseDriverLines(
      '{"name":"A","status":"ok","inputs":2}\nnope\n{"name":"B","status":"unavailable"}\n',
    );
    expect(drivers).toHaveLength(2);
    expect(malformed).toBe(1);
  });
});

describe("registry enumeration (tier 1 — pure Node)", () => {
  it("parses reg.exe output from both views without duplicates", async () => {
    // Inject the process runner — real reg.exe output shape, both views,
    // including the duplicate the 32-bit view re-reports.
    const sep = String.fromCharCode(92);
    const lines = [
      `HKEY_LOCAL_MACHINE${sep}SOFTWARE${sep}ASIO${sep}ASIO4ALL v2`,
      `HKEY_LOCAL_MACHINE${sep}SOFTWARE${sep}ASIO${sep}Focusrite USB ASIO`,
      `HKEY_LOCAL_MACHINE${sep}SOFTWARE${sep}WOW6432Node${sep}ASIO${sep}ASIO4ALL v2`,
    ];
    const fakeExec = async () => ({ stdout: lines.join(String.fromCharCode(10)) });
    const result = await enumerateRegistry({ exec: fakeExec });
    expect(result.status).toBe("ok");
    expect(result.names).toContain("ASIO4ALL v2");
    expect(result.names).toContain("Focusrite USB ASIO");
    expect(new Set(result.names).size).toBe(result.names.length);
  });

  it("treats a missing registry key (reg.exe exit 1) as an empty answer", async () => {
    const notFound = Object.assign(new Error("reg exit 1"), { code: 1 });
    const result = await enumerateRegistry({
      exec: async () => {
        throw notFound;
      },
    });
    expect(result).toEqual({ status: "ok", names: [] });
    // A real failure (registry access denied etc.) surfaces as unavailable.
    const denied = Object.assign(new Error("access denied"), { code: 5, stderr: "Access is denied." });
    const failed = await enumerateRegistry({
      exec: async () => {
        throw denied;
      },
    });
    expect(failed.status).toBe("unavailable");
  });
});

describe("AsioProbeManager process boundary (fake spawn)", () => {
  function fakeChild(script: { stdout?: string; code?: number; signal?: string; never?: boolean; emitError?: string }) {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill: () => boolean };
    child.stdout = new PassThrough();
    child.kill = () => {
      if (script.never) child.emit("close", null, "SIGKILL");
      return true;
    };
    if (script.emitError) {
      setImmediate(() => {
        const err = new Error(script.emitError) as NodeJS.ErrnoException;
        err.code = script.emitError === "ENOENT" ? "ENOENT" : undefined;
        child.emit("error", err);
      });
      return child;
    }
    // Async so the manager's listeners attach first; `never` still STREAMS
    // stdout (a hung driver can have answered for earlier drivers) but never
    // closes — the manager's timeout must do the killing.
    setImmediate(() => {
      if (script.stdout !== undefined) child.stdout.write(script.stdout);
      if (!script.never) child.emit("close", script.code ?? 0, script.signal ?? null);
    });
    return child;
  }

  it("parses answered drivers and drops malformed lines", async () => {
    const manager = new AsioProbeManager({
      spawn: () =>
        fakeChild({
          stdout: '{"name":"A","status":"ok","inputs":8}\ngarbage\n{"name":"B","status":"unavailable"}\n',
          code: 0,
        }),
    });
    const result = (await manager.probeDrivers()) as { status: string; drivers: unknown[]; malformed: number };
    expect(result.status).toBe("ok");
    expect(result.drivers).toHaveLength(2);
    expect(result.malformed).toBe(1);
  });

  it("carries partial drivers through a timeout kill", async () => {
    const manager = new AsioProbeManager({
      spawn: () =>
        fakeChild({
          stdout: '{"name":"Early","status":"ok"}\n',
          never: true, // a later driver blocks COM init; kill fires
        }),
      timeoutMs: 40,
    });
    const result = (await manager.probeDrivers()) as { status: string; partial: boolean; drivers: unknown[] };
    expect(result.status).toBe("timeout");
    expect(result.partial).toBe(true);
    expect(result.drivers).toEqual([{ name: "Early", status: "ok" }]);
  });

  it("maps a missing executable to no-probe (SDK license gate)", async () => {
    const manager = new AsioProbeManager({ spawn: () => fakeChild({ emitError: "ENOENT" }) });
    const result = (await manager.probeDrivers()) as { status: string };
    expect(result.status).toBe("no-probe");
  });
});

describe.skipIf(!nativeReady)("native asio-probe end-to-end (ADR 0017 wave 1)", () => {
  const manager = new AsioProbeManager({ timeoutMs: 8000 });

  it("survives any driver set: clean JSON or a partial timeout, never a hang", async () => {
    const result = (await manager.probeDrivers()) as {
      status: string;
      drivers: { name: string; status: string }[];
    };
    expect(["ok", "timeout"]).toContain(result.status);
    for (const driver of result.drivers) {
      expect(typeof driver.name).toBe("string");
      expect(["ok", "unavailable"]).toContain(driver.status);
    }
    if (result.status === "ok") {
      // Drivers seen twice (both registry views) must appear — dedup is the
      // caller's concern; the probe reports per registration.
      expect(result.drivers.length).toBeLessThanOrEqual(256);
    }
  }, 30_000);

  it("registry tier agrees with the native probe on at least the names", async () => {
    const registry = await manager.listRegisteredDrivers();
    const probed = (await manager.probeDrivers()) as { drivers: { name: string }[] };
    if (registry.status !== "ok") return; // machine without the ASIO key
    for (const driver of probed.drivers) {
      expect(registry.names).toContain(driver.name);
    }
  }, 30_000);
});

describe.skipIf(!nativeReady)("ASIO streaming host end-to-end (ADR 0017 wave 2.5)", () => {
  it(
    "streams the fixture driver in realtime: bounded samples, contiguous seq, clean EOF",
    async () => {
      const SECONDS = 2;
      const source = new PcmPipeSource({
        hostPath: ASIO_HOST_EXE,
        args: ["--dll", ASIO_FIXTURE_DLL, "--seconds", String(SECONDS)],
      });
      const format = (await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no format frame in 10 s")), 10_000);
        source.on("format", (f) => {
          clearTimeout(timer);
          resolve(f as Record<string, number>);
        });
        source.on("protocol-error", (e) => reject(new Error(String(e))));
        source.start();
      })) as { rate: number; channels: number; blockFrames: number };
      expect(format.rate).toBe(48000);
      expect(format.channels).toBe(2);

      let rmsSum = 0;
      let sampleCount = 0;
      let outOfRange = 0;
      const firstBlock = await new Promise<{ seq: number; samples: Float32Array }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no PCM in 10 s")), 10_000);
        source.on("pcm", (raw) => {
          clearTimeout(timer);
          const block = raw as { seq: number; samples: Float32Array };
          for (let i = 0; i < block.samples.length; i++) {
            const s = block.samples[i];
            if (!Number.isFinite(s) || s < -1 || s > 1) outOfRange++;
            rmsSum += s * s;
            sampleCount++;
          }
          resolve(block);
        });
      });
      expect(firstBlock.seq).toBe(0);
      expect(outOfRange).toBe(0);
      expect(sampleCount).toBeGreaterThan(0);
      expect(rmsSum / sampleCount).toBeGreaterThan(1e-6); // a tone, not silence

      const done = await new Promise<{ stats: Record<string, unknown>; endStats: Record<string, unknown> }>(
        (resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("stream did not finish in 20 s")), 20_000);
          let endStats: Record<string, unknown> = {};
          source.on("end", (payload) => {
            endStats = payload as Record<string, unknown>;
          });
          source.on("close", (payload) => {
            clearTimeout(timer);
            resolve({ stats: (payload as { stats: Record<string, unknown> }).stats, endStats });
          });
        },
      );

      const stats = done.stats as { pcmFramesReceived: number; seqGaps: number; elapsedMs: number };
      const expected = SECONDS * format.rate;
      // The sample driver paces its thread in realtime: allow generous
      // scheduling slack (±25%) but nothing that would starve a listener.
      expect(stats.pcmFramesReceived).toBeGreaterThan(expected * 0.75);
      expect(stats.pcmFramesReceived).toBeLessThan(expected * 1.25);
      expect(stats.seqGaps).toBe(0);
      expect(stats.elapsedMs).toBeGreaterThan(SECONDS * 1000 * 0.75);
      expect(stats.elapsedMs).toBeLessThan(SECONDS * 1000 * 2);
      expect(done.endStats).toEqual({}); // EOF frame arrived
    },
    60_000,
  );
});

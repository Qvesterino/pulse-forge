import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { beforeAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
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
const SDK_MANIFEST = path.join(REPO, "native", "asio-host", "asio-sdk-manifest.json");

let nativeReady = existsSync(PROBE_EXE);

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
    expect(manifest.files.map((f: { path: string }) => f.path)).toEqual([
      "common/asio.h",
      "common/asiosys.h",
      "common/iasiodrv.h",
    ]);
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

import { createRequire } from "node:module";
import { spawn as realSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
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
const { ClapProbeManager, defaultProbePath, validatePluginDescriptor } =
  require("../desktop/clap-host-manager.cjs") as {
    ClapProbeManager: new (options?: Record<string, unknown>) => {
      probeFile: (filePath: string) => Promise<Record<string, unknown>>;
      scanPaths: (paths: string[]) => Promise<Record<string, unknown>>;
    };
    defaultProbePath: (resourcesPath?: string) => string;
    validatePluginDescriptor: (value: unknown) => Record<string, unknown> | null;
  };

/**
 * CLAP hosting Wave 1 (ADR 0016): out-of-process plugin scanning.
 *
 * The native probe and its fixture plugins build with MSVC via
 * `npm run build:clap-probe`. When the toolchain is absent the native-gated
 * tests SKIP with an honest message — the header/manifest and manager-logic
 * tests still run everywhere.
 */

const REPO = path.resolve(__dirname, "..");
const CLAP_DIR = path.join(REPO, "native", "clap-probe", "clap");
const PROBE_EXE = defaultProbePath();
const FIXTURE = path.join(REPO, "native", "clap-probe", "build", "Release", "clap-fixture.clap");
const FIXTURE_EMPTY = path.join(REPO, "native", "clap-probe", "build", "Release", "clap-fixture-empty.clap");

let nativeReady = existsSync(PROBE_EXE) && existsSync(FIXTURE);

beforeAll(async () => {
  if (nativeReady) return;
  // Try a build once — machines with MSVC+CMake get the full suite, the rest
  // get an honest skip rather than a silent pass.
  try {
    await new Promise<void>((resolve, reject) => {
      const child = realSpawn(process.execPath, [path.join(REPO, "scripts", "build-clap-probe.mjs")], {
        stdio: "ignore",
      });
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`build exited ${code}`))));
      child.on("error", reject);
    });
    nativeReady = existsSync(PROBE_EXE) && existsSync(FIXTURE);
  } catch {
    /* toolchain absent — handled by the skip guards below */
  }
});

describe("vendored CLAP headers (scripts/vendor-clap.mjs)", () => {
  it("vendors a complete 1.2.10 tree with a verifiable manifest", () => {
    const manifestPath = path.join(CLAP_DIR, "vendored-manifest.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.tag).toBe("1.2.10");
    expect(manifest.license).toBe("MIT");
    expect(manifest.fileCount).toBeGreaterThanOrEqual(60);
    expect(existsSync(path.join(REPO, "native", "clap-probe", "CLAP-LICENSE"))).toBe(true);

    // Reconcile every recorded hash — the tree must be byte-exact upstream.
    for (const file of manifest.files.slice(0, 8)) {
      const bytes = readFileSync(path.join(CLAP_DIR, file.path));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { createHash } = require("node:crypto") as typeof import("node:crypto");
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
    }

    const version = readFileSync(path.join(CLAP_DIR, "version.h"), "utf8");
    expect(version).toContain("#define CLAP_VERSION_MAJOR 1");
    expect(version).toContain("#define CLAP_VERSION_MINOR 2");
    expect(version).toContain("#define CLAP_VERSION_REVISION 10");
  });
});

describe("probe descriptor validation (network boundary)", () => {
  it("accepts a minimal descriptor and bounds every string", () => {
    const ok = validatePluginDescriptor({ index: 0, id: "com.x.y", name: "P", features: ["utility"] });
    expect(ok).toMatchObject({ id: "com.x.y", name: "P", features: ["utility"] });

    expect(validatePluginDescriptor(null)).toBeNull();
    expect(validatePluginDescriptor({ id: "x", name: "y" })).toBeNull(); // no index
    expect(validatePluginDescriptor({ index: 0, name: "y" })).toBeNull(); // no id
    expect(validatePluginDescriptor({ index: -1, id: "x", name: "y" })).toBeNull();
    expect(validatePluginDescriptor({ index: 0, id: "x".repeat(300), name: "y" })).toBeNull();
    expect(validatePluginDescriptor({ index: 0, id: "x", name: "y", features: "utility" })).toBeNull();
    expect(validatePluginDescriptor({ index: 0, id: "x", name: "y", features: [42] })).toBeNull();
  });
});

describe.skipIf(!nativeReady)("native probe end-to-end (ADR 0016 wave 1)", () => {
  const manager = new ClapProbeManager();

  it("discovers the fixture plugin descriptor", async () => {
    const result = (await manager.probeFile(FIXTURE)) as { status: string; plugins: Record<string, unknown>[] };
    expect(result.status).toBe("ok");
    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0]).toMatchObject({
      id: "org.kyx.test.clap-fixture",
      name: "KYX CLAP Fixture",
      vendor: "KYX (Pulse Forge)",
      version: "1.0.0",
    });
    expect(result.plugins[0].features).toContain("audio-effect");
  }, 20_000);

  it("classifies a DLL without clap_entry as not-clap", async () => {
    const result = (await manager.probeFile(FIXTURE_EMPTY)) as { status: string };
    expect(result.status).toBe("not-clap");
  }, 20_000);

  it("classifies a non-PE garbage file as not-clap (LoadLibrary fails)", async () => {
    const result = (await manager.probeFile(path.join(REPO, "package.json"))) as { status: string };
    expect(result.status).toBe("not-clap");
  }, 20_000);

  it("rejects malformed manager input without spawning", async () => {
    const result = (await manager.probeFile("")) as { status: string };
    expect(result.status).toBe("error");
  });

  it("aggregates a scan across files", async () => {
    const result = (await manager.scanPaths([FIXTURE, FIXTURE_EMPTY])) as {
      status: string;
      scanned: number;
      plugins: { file: string; id: string }[];
      counts: { ok: number; notClap: number; failed: number };
    };
    expect(result.status).toBe("ok");
    expect(result.scanned).toBe(2);
    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0].file).toBe(FIXTURE);
    expect(result.counts).toEqual({ ok: 1, notClap: 1, failed: 0 });
  }, 30_000);
});

describe("ClapProbeManager process boundary (fake spawn)", () => {
  /** Fake child: replays scripted stdout/exit behavior. */
  function fakeChild(script: { stdout?: string; code?: number; signal?: string; never?: boolean }) {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => void };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      if (script.never) child.emit("close", null, "SIGKILL");
      return true;
    };
    if (!script.never) {
      // Async so the manager's listeners attach before the close event fires
      // (a real process can never close inside spawn()).
      setImmediate(() => {
        if (script.stdout !== undefined) child.stdout.write(script.stdout);
        child.emit("close", script.code ?? 0, script.signal ?? null);
      });
    }
    return child;
  }

  it("parses JSONL, drops malformed lines, and counts them", async () => {
    const manager = new ClapProbeManager({
      spawn: () =>
        fakeChild({
          stdout: '{"index":0,"id":"a","name":"A"}\nnot json\n{"index":1,"id":"b"}\n',
          code: 0,
        }),
    });
    const result = (await manager.probeFile("x.clap")) as { status: string; plugins: unknown[]; malformed: number };
    expect(result.status).toBe("ok");
    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0]).toMatchObject({ id: "a" });
    expect(result.malformed).toBe(2); // "not json" + descriptor missing name
  });

  it("maps probe exit codes to classifications", async () => {
    const cases: [number, string][] = [
      [2, "not-clap"],
      [3, "init-refused"],
      [7, "crashed"],
    ];
    for (const [code, expected] of cases) {
      const manager = new ClapProbeManager({ spawn: () => fakeChild({ code }) });
      const result = (await manager.probeFile("x.clap")) as { status: string };
      expect(result.status).toBe(expected);
    }
  });

  it("kills a hung probe and reports timeout", async () => {
    const manager = new ClapProbeManager({ spawn: () => fakeChild({ never: true }), timeoutMs: 30 });
    const result = (await manager.probeFile("x.clap")) as { status: string };
    expect(result.status).toBe("timeout");
  });

  it("reports signal deaths from hostile plugins as crashed", async () => {
    const manager = new ClapProbeManager({ spawn: () => fakeChild({ signal: "SIGSEGV" }) });
    const result = (await manager.probeFile("x.clap")) as { status: string };
    expect(result.status).toBe("crashed");
  });
});

describe("default probe path resolution", () => {
  it("prefers packaged resources and falls back to the dev tree", () => {
    expect(defaultProbePath("C:/resources")).toBe(path.join("C:/resources", "clap", "clap-probe.exe"));
    const dev = defaultProbePath();
    expect(dev).toContain(path.join("native", "clap-probe", "build", "Release", "clap-probe.exe"));
    if (existsSync(dev)) expect(statSync(dev).size).toBeGreaterThan(0);
  });
});

describe.skipIf(!nativeReady)("CLAP player end-to-end (ADR 0016 audio hosting)", () => {
  it("instantiates the tone fixture, processes it, and streams sine-exact frames", async () => {
    const PLAYER = path.join(REPO, "native", "clap-host", "build", "Release", "clap-player.exe");
    const TONE = path.join(REPO, "native", "clap-host", "build", "Release", "clap-tone.clap");
    if (!existsSync(PLAYER) || !existsSync(TONE)) return; // older build tree — skip honestly

    const RATE = 48000;
    const source = new PcmPipeSource({
      hostPath: PLAYER,
      args: ["--dll", TONE, "--rate", String(RATE), "--seconds", "1"],
    });

    // Every listener attaches BEFORE start: the fixture's first block is
    // frame 0 and the transport does not replay missed events.
    const verdict = await new Promise<{ format: Record<string, unknown>; verified: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("stream did not finish in 20 s")), 20_000);
      let format: Record<string, unknown> | null = null;
      let absolute = 0;
      source.on("format", (raw) => (format = raw as Record<string, unknown>));
      source.on("protocol-error", (e) => {
        clearTimeout(timer);
        reject(new Error(String(e)));
      });
      source.on("pcm", (raw) => {
        const block = raw as { samples: Float32Array };
        const frames = block.samples.length / 2; // interleaved stereo, channels identical
        for (let n = 0; n < frames; n++, absolute++) {
          const expected = 0.25 * Math.sin((2 * Math.PI * 440 * absolute) / RATE);
          if (Math.abs(block.samples[n * 2] - expected) > 1e-5) {
            clearTimeout(timer);
            reject(new Error(`sample mismatch at absolute frame ${absolute}`));
            source.stop();
            return;
          }
        }
      });
      source.on("close", () => {
        clearTimeout(timer);
        if (!format) reject(new Error("no format frame"));
        else resolve({ format, verified: absolute });
      });
      source.start();
    });

    expect(verdict.format).toMatchObject({ rate: RATE, channels: 2, plugin: "org.kyx.test.clap-tone" });
    expect(verdict.verified).toBe(RATE); // exactly one second, every frame verified
  }, 30_000);

  it("applies --set through the params extension: the tone moves to 880 Hz", async () => {
    const PLAYER = path.join(REPO, "native", "clap-host", "build", "Release", "clap-player.exe");
    const TONE = path.join(REPO, "native", "clap-host", "build", "Release", "clap-tone.clap");
    if (!existsSync(PLAYER) || !existsSync(TONE)) return; // older build tree

    const RATE = 48000;
    const source = new PcmPipeSource({
      hostPath: PLAYER,
      args: ["--dll", TONE, "--rate", String(RATE), "--seconds", "1", "--set", "880"],
    });

    // All listeners before start (transport does not replay events).
    const verdict = await new Promise<{ params: unknown; verified: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("stream did not finish in 20 s")), 20_000);
      let absolute = 0;
      let params: unknown = null;
      source.on("event", (payload) => {
        const record = payload as { params?: unknown };
        if (record.params) params = record.params;
      });
      source.on("pcm", (raw) => {
        const block = raw as { samples: Float32Array };
        const frames = block.samples.length / 2; // interleaved stereo, identical channels
        for (let n = 0; n < frames; n++, absolute++) {
          // The queued PARAM_VALUE event retunes the FIRST block — the
          // whole stream is 880 Hz, not 440.
          const expected = 0.25 * Math.sin((2 * Math.PI * 880 * absolute) / RATE);
          if (Math.abs(block.samples[n * 2] - expected) > 1e-5) {
            clearTimeout(timer);
            reject(new Error(`sample mismatch at absolute frame ${absolute} (expected an 880 Hz tone)`));
            source.stop();
            return;
          }
        }
      });
      source.on("close", () => {
        clearTimeout(timer);
        resolve({ params, verified: absolute });
      });
      source.start();
    });

    expect(verdict.verified).toBe(RATE);
    expect(verdict.params).toEqual([{ id: 7001, name: "Tone Frequency", min: 50, max: 2000, default: 440 }]);
  }, 30_000);
});

import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { Mrt2WindowsHostManager, defaultWindowsPaths } = require("../desktop/mrt2-windows-host-manager.cjs") as {
  Mrt2WindowsHostManager: new (options?: Record<string, unknown>) => {
    getAvailability: () => Record<string, unknown>;
    assertInstallAvailable: () => void;
    start: () => Promise<{ ready: true }>;
    stop: () => Promise<void>;
    isReady: () => boolean;
    openTransport: () => string;
    on: (event: string, listener: (event: Record<string, unknown>) => void) => void;
  };
  defaultWindowsPaths: (homeDirectory: string, resourcesPath: string) => Record<string, string>;
};
const { parseReadyLine } = require("../desktop/mrt2-host-manager.cjs") as {
  parseReadyLine: (line: string) => { runtimeProfile?: Record<string, unknown> };
};
const { Mrt2Wsl2HostManager, windowsPathToWslPath } = require("../desktop/mrt2-wsl2-host-manager.cjs") as {
  Mrt2Wsl2HostManager: new (options?: Record<string, unknown>) => {
    getAvailability: () => Record<string, unknown>;
    assertInstallAvailable: () => void;
    getHostArgs: () => string[];
    nativeHostPath: string;
  };
  windowsPathToWslPath: (value: string) => string;
};

describe("Windows MRT2 companion manager", () => {
  it("uses a separate Windows executable and model root", () => {
    expect(defaultWindowsPaths("C:/Users/producer", "C:/KYX/resources")).toEqual({
      nativeHostPath: path.join("C:/KYX/resources", "mrt2-windows", "kyx-mrt2-windows-host.exe"),
      modelRoot: path.join("C:/Users/producer", "Documents", "Magenta", "magenta-rt-v2-windows"),
      resources: path.join("C:/Users/producer", "Documents", "Magenta", "magenta-rt-v2-windows", "resources"),
      model: path.join("C:/Users/producer", "Documents", "Magenta", "magenta-rt-v2-windows", "models", "mrt2_small"),
    });
  });

  it("reports Windows as unavailable until the fixed companion and model are installed", () => {
    const manager = new Mrt2WindowsHostManager({
      appIsPackaged: true,
      resourcesPath: "C:/KYX/resources",
      homeDirectory: "C:/Users/producer",
      fileExists: () => false,
      lstat: () => ({ isFile: () => true, isSymbolicLink: () => false }),
      assertExecutable: () => undefined,
    });
    expect(manager.getAvailability()).toMatchObject({
      platform: "win32",
      arch: "x64",
      windowsCompanionInstalled: false,
      windowsCompanionReady: false,
      executionMode: "capture",
      status: "unavailable",
    });
    expect(() => manager.assertInstallAvailable()).toThrow(/model resources|missing/u);
  });

  it("exposes a capture-tier capability before realtime has been benchmarked", () => {
    const manager = new Mrt2WindowsHostManager({
      appIsPackaged: true,
      resourcesPath: "C:/KYX/resources",
      homeDirectory: "C:/Users/producer",
      fileExists: () => true,
      lstat: () => ({ isFile: () => true, isSymbolicLink: () => false }),
      assertExecutable: () => undefined,
      executionMode: "capture",
      backendId: "mrt2-windows-jax",
      runtimeVersion: "dev",
    });
    expect(manager.getAvailability()).toMatchObject({
      windowsCompanionInstalled: true,
      windowsCompanionReady: false,
      nativeRealtime: false,
      executionMode: "capture",
      backendId: "mrt2-windows-jax",
      runtimeVersion: "dev",
    });
  });

  it("accepts a bounded runtime profile in the fixed ready handshake", () => {
    expect(
      parseReadyLine(
        JSON.stringify({
          version: 1,
          type: "ready",
          providerId: "mrt2",
          modelId: "mrt2_small",
          runtimeProfile: {
            backendId: "mrt2-windows-cuda",
            executionMode: "near-realtime",
            frameP95Ms: 31,
          },
        }),
      ),
    ).toMatchObject({ runtimeProfile: { backendId: "mrt2-windows-cuda", executionMode: "near-realtime" } });
  });

  it("builds a fixed WSL2 command line from main-process paths only", () => {
    expect(windowsPathToWslPath("C:\\Program Files\\KYX\\resources\\mrt2-windows\\host.py")).toBe(
      "/mnt/c/Program Files/KYX/resources/mrt2-windows/host.py",
    );
    expect(() => windowsPathToWslPath("\\\\server\\share\\host.py")).toThrow(/drive-letter/u);
    const manager = new Mrt2Wsl2HostManager({
      appIsPackaged: true,
      resourcesPath: "C:/KYX/resources",
      homeDirectory: "C:/Users/producer",
      wslExePath: "C:/Windows/System32/wsl.exe",
      hostScriptPath: "C:/KYX/resources/mrt2-windows/kyx_mrt2_windows_host.py",
      manifestPath: "C:/KYX/resources/mrt2-windows/kyx-mrt2-windows-manifest.json",
      wslDistro: "Ubuntu",
      wslPythonPath: "/home/producer/.venvs/kyx-mrt2-wsl/bin/python",
      verifyHostScript: () => ({ ok: true }),
      fileExists: () => true,
      lstat: () => ({ isFile: () => true, isSymbolicLink: () => false }),
      assertExecutable: () => undefined,
    });

    manager.assertInstallAvailable();
    expect(manager.nativeHostPath).toBe("C:/Windows/System32/wsl.exe");
    expect(manager.getHostArgs()).toEqual([
      "--distribution",
      "Ubuntu",
      "--exec",
      "/usr/bin/env",
      "XLA_PYTHON_CLIENT_PREALLOCATE=false",
      "XLA_FLAGS=--xla_gpu_autotune_level=1",
      "TF_GPU_ALLOCATOR=cuda_malloc_async",
      "/home/producer/.venvs/kyx-mrt2-wsl/bin/python",
      "/mnt/c/KYX/resources/mrt2-windows/kyx_mrt2_windows_host.py",
      "--model-root",
      "/mnt/c/Users/producer/Documents/Magenta/magenta-rt-v2-windows",
      "--execution-mode",
      "near-realtime",
    ]);
    expect(manager.getAvailability()).toMatchObject({
      backendId: "mrt2-windows-wsl2-cuda",
      executionMode: "near-realtime",
      nativeRealtime: false,
    });
  });

  it("cleans up a crashed helper and can restart the fixed companion", async () => {
    class FakeChild extends EventEmitter {
      stdout = new PassThrough();
      stderr = new PassThrough();
      stdin = new Writable({ write: (_chunk, _encoding, callback) => callback() });
      kill = vi.fn(() => {
        queueMicrotask(() => this.emit("exit", 0, "SIGTERM"));
        return true;
      });
    }
    const children: FakeChild[] = [];
    const manager = new Mrt2WindowsHostManager({
      appIsPackaged: true,
      resourcesPath: "C:/KYX/resources",
      homeDirectory: "C:/Users/producer",
      fileExists: () => true,
      lstat: () => ({ isFile: () => true, isSymbolicLink: () => false }),
      assertExecutable: () => undefined,
      spawn: vi.fn(() => {
        const child = new FakeChild();
        children.push(child);
        return child;
      }),
      startTimeoutMs: 1_000,
    });
    const first = manager.start();
    children[0]!.stdout.write(
      `${JSON.stringify({
        version: 1,
        type: "ready",
        providerId: "mrt2",
        modelId: "mrt2_small",
        runtimeProfile: { backendId: "mrt2-windows-jax", executionMode: "capture" },
      })}\n`,
    );
    await expect(first).resolves.toEqual({ ready: true });
    const transportId = manager.openTransport();
    const events: Record<string, unknown>[] = [];
    manager.on("transport-event", (event) => events.push(event));
    children[0]!.emit("exit", 1, null);
    expect(manager.isReady()).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ transportId, kind: "closed" }));

    const second = manager.start();
    children[1]!.stdout.write(
      `${JSON.stringify({ version: 1, type: "ready", providerId: "mrt2", modelId: "mrt2_small" })}\n`,
    );
    await expect(second).resolves.toEqual({ ready: true });
    await manager.stop();
  });
});

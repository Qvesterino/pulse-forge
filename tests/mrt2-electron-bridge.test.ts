import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const bridge = require("../desktop/mrt2-bridge.cjs") as {
  getMrt2Availability: (options?: Record<string, unknown>) => Record<string, unknown>;
  getMrt2WindowsAvailability: (options?: Record<string, unknown>) => Record<string, unknown>;
  validateMrt2Endpoint: (value: string) => { url: string; host: string; port: number };
  registerMrt2IpcHandlers: (
    ipcMain: {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) => void;
    },
    options?: Record<string, unknown>,
  ) => void;
};

describe("Electron MRT2 boundary", () => {
  it("reports Windows as explicit unavailable while retaining a local companion option", () => {
    expect(bridge.getMrt2Availability({ platform: "win32", arch: "x64" })).toMatchObject({
      nativeRealtime: false,
      localCompanion: true,
      status: "unavailable",
      message: "MRT2 realtime requires an Apple Silicon Mac",
    });
  });

  it("reports the optional Windows companion separately from the macOS native helper", () => {
    const resourcesPath = "C:/KYX/resources";
    const modelRoot = "C:/Users/producer/Documents/Magenta/magenta-rt-v2-windows";
    const existing = new Set([
      path.join(resourcesPath, "mrt2-windows", "kyx-mrt2-windows-host.exe"),
      path.join(modelRoot, "resources"),
      path.join(modelRoot, "models", "mrt2_small"),
    ]);
    expect(
      bridge.getMrt2WindowsAvailability({
        platform: "win32",
        arch: "x64",
        appIsPackaged: true,
        resourcesPath,
        homeDirectory: "C:/Users/producer",
        fileExists: (filePath: string) => existing.has(filePath),
        lstat: () => ({ isFile: () => true, isSymbolicLink: () => false }),
        assertExecutable: () => undefined,
      }),
    ).toMatchObject({
      windowsCompanionInstalled: true,
      windowsCompanionReady: false,
      nativeRealtime: false,
      executionMode: "capture",
      status: "unavailable",
    });
  });

  it("only reports native realtime when the packaged host and standard model assets exist", () => {
    const resourcesPath = "C:/KYX/resources";
    const homeDirectory = "C:/Users/producer";
    const hostPath = path.join(resourcesPath, "mrt2-host", "kyx-mrt2-host");
    const modelRoot = "C:/Users/producer/Documents/Magenta/magenta-rt-v2";
    const existing = new Set([
      hostPath,
      path.join(modelRoot, "resources", "musiccoca"),
      path.join(modelRoot, "models", "mrt2_small", "mrt2_small.mlxfn"),
    ]);
    const availability = bridge.getMrt2Availability({
      platform: "darwin",
      arch: "arm64",
      appIsPackaged: true,
      resourcesPath,
      homeDirectory,
      fileExists: (path: string) => existing.has(path),
      isRegularFile: () => true,
      assertExecutable: () => undefined,
    });
    expect(availability).toMatchObject({ nativeInstalled: true, nativeRealtime: false, status: "unavailable" });

    expect(
      bridge.getMrt2Availability({
        platform: "darwin",
        arch: "arm64",
        appIsPackaged: true,
        resourcesPath,
        homeDirectory,
        fileExists: (path: string) => existing.has(path),
        isRegularFile: () => true,
        assertExecutable: () => undefined,
        nativeReady: true,
      }),
    ).toMatchObject({ nativeInstalled: true, nativeRealtime: true, status: "available" });

    existing.delete(path.join(modelRoot, "models", "mrt2_small", "mrt2_small.mlxfn"));
    expect(
      bridge.getMrt2Availability({
        platform: "darwin",
        arch: "arm64",
        appIsPackaged: true,
        resourcesPath,
        homeDirectory,
        fileExists: (path: string) => existing.has(path),
        isRegularFile: () => true,
        assertExecutable: () => undefined,
      }),
    ).toMatchObject({ nativeRealtime: false, status: "unavailable" });
  });

  it("rejects a symlink or directory in place of the fixed native executable", () => {
    const availability = bridge.getMrt2Availability({
      platform: "darwin",
      arch: "arm64",
      appIsPackaged: true,
      resourcesPath: "/Applications/KYX.app/Contents/Resources",
      homeDirectory: "/Users/producer",
      fileExists: () => true,
      isRegularFile: () => false,
      assertExecutable: () => undefined,
    });
    expect(availability).toMatchObject({ nativeInstalled: false, nativeRealtime: false, status: "unavailable" });
  });

  it("accepts only credential-free loopback websocket endpoints", () => {
    expect(bridge.validateMrt2Endpoint("ws://127.0.0.1:8765/path")).toMatchObject({
      host: "127.0.0.1",
      port: 8765,
    });
    expect(() => bridge.validateMrt2Endpoint("https://127.0.0.1:8765")).toThrow(/ws/u);
    expect(() => bridge.validateMrt2Endpoint("ws://evil.example:8765")).toThrow(/localhost/u);
    expect(() => bridge.validateMrt2Endpoint("ws://user:pass@localhost:8765")).toThrow(/credentials/u);
  });

  it("registers only the bounded MRT2 availability, lifecycle and transport handlers", () => {
    const channels: string[] = [];
    bridge.registerMrt2IpcHandlers(
      {
        handle(channel) {
          channels.push(channel);
        },
      },
      { nativeHostManager: { isReady: () => false }, isTrustedSender: () => true },
    );
    expect(channels).toEqual([
      "kyx:mrt2:get-availability",
      "kyx:mrt2:validate-endpoint",
      "kyx:mrt2:start-native-host",
      "kyx:mrt2:stop-native-host",
      "kyx:mrt2:open-transport",
      "kyx:mrt2:send-control",
      "kyx:mrt2:send-binary",
      "kyx:mrt2:close-transport",
    ]);
  });

  it("allows only trusted renderer frames to start and stop the packaged helper", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const nativeHostManager = {
      isReady: () => false,
      start: vi.fn(async () => ({ ready: true as const })),
      stop: vi.fn(async () => undefined),
      openTransport: vi.fn(() => "transport-1"),
      sendControl: vi.fn(),
      sendBinary: vi.fn(),
      closeTransport: vi.fn(),
      on: vi.fn(),
    };
    bridge.registerMrt2IpcHandlers(
      { handle: (channel, handler) => handlers.set(channel, handler) },
      { nativeHostManager, isTrustedSender: (event: { trusted: boolean }) => event.trusted },
    );

    const start = handlers.get("kyx:mrt2:start-native-host");
    const stop = handlers.get("kyx:mrt2:stop-native-host");
    expect(start).toBeDefined();
    expect(stop).toBeDefined();
    await expect(start?.({ trusted: false })).rejects.toThrow(/not allowed/u);
    expect(nativeHostManager.start).not.toHaveBeenCalled();
    await expect(start?.({ trusted: true })).resolves.toEqual({ ready: true });
    await expect(stop?.({ trusted: true })).resolves.toBeUndefined();
    expect(nativeHostManager.stop).toHaveBeenCalledTimes(1);
  });

  it("binds every transport to its trusted renderer and forwards native events only to its owner", () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const nativeHostManager = {
      isReady: () => true,
      openTransport: vi.fn(() => "transport-1"),
      sendControl: vi.fn(),
      sendBinary: vi.fn(),
      closeTransport: vi.fn(),
      on: vi.fn((name: string, listener: (event: Record<string, unknown>) => void) => listeners.set(name, listener)),
    };
    bridge.registerMrt2IpcHandlers(
      { handle: (channel, handler) => handlers.set(channel, handler) },
      { nativeHostManager, isTrustedSender: (event: { trusted: boolean }) => event.trusted },
    );
    const sender = new EventEmitter() as EventEmitter & {
      id: number;
      send: ReturnType<typeof vi.fn>;
      isDestroyed: () => boolean;
    };
    sender.id = 42;
    sender.send = vi.fn();
    sender.isDestroyed = () => false;
    const event = { trusted: true, sender };
    expect(handlers.get("kyx:mrt2:open-transport")?.(event)).toBe("transport-1");
    expect(() => handlers.get("kyx:mrt2:send-control")?.({ ...event, trusted: false }, "transport-1", {})).toThrow(
      /not allowed/u,
    );
    handlers.get("kyx:mrt2:send-control")?.(event, "transport-1", { version: 1, type: "hello" });
    expect(nativeHostManager.sendControl).toHaveBeenCalledWith("transport-1", { version: 1, type: "hello" });
    listeners.get("transport-event")?.({ transportId: "transport-1", kind: "control", message: { type: "hello.ok" } });
    expect(sender.send).toHaveBeenCalledWith("kyx:mrt2:transport-event", {
      transportId: "transport-1",
      kind: "control",
      message: { type: "hello.ok" },
    });
    expect(() => handlers.get("kyx:mrt2:send-binary")?.(event, "other-transport", new ArrayBuffer(0))).toThrow(
      /not owned/u,
    );
    handlers.get("kyx:mrt2:close-transport")?.(event, "transport-1");
    expect(nativeHostManager.closeTransport).toHaveBeenCalledWith("transport-1");
  });
});

import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  WindowsAudioEndpointManager,
  registerWindowsAudioEndpointHandlers,
  defaultEndpointProbePath,
  validateEndpointPayload,
  MAX_STDOUT_BYTES,
} = require("../desktop/windows-audio-devices.cjs") as {
  WindowsAudioEndpointManager: new (options?: Record<string, unknown>) => {
    list: () => Promise<Record<string, unknown>>;
  };
  registerWindowsAudioEndpointHandlers: (ipcMain: unknown, options?: Record<string, unknown>) => unknown;
  defaultEndpointProbePath: (resourcesPath?: string) => string;
  validateEndpointPayload: (value: unknown) => unknown;
  MAX_STDOUT_BYTES: number;
};

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  killed = false;

  kill() {
    this.killed = true;
    queueMicrotask(() => this.emit("close", null, "SIGTERM"));
    return true;
  }
}

const payload = {
  schemaVersion: 2,
  endpoints: [
    {
      id: "opaque-capture-device-id",
      name: "Volt Capture",
      flow: "capture",
      state: "active",
      isDefaultConsole: true,
      mixFormat: {
        channels: 2,
        sampleRateHz: 48000,
        bitsPerSample: 32,
        validBitsPerSample: 32,
        floatingPoint: true,
        channelMask: 3,
        sharedPeriods: { defaultFrames: 480, fundamentalFrames: 480, minFrames: 480, maxFrames: 1440 },
      },
    },
    {
      id: "opaque-render-device-id",
      name: "Volt Monitor",
      flow: "render",
      state: "unplugged",
      isDefaultConsole: false,
      mixFormat: null,
    },
  ],
};

function managerWithChild(child: FakeChild, options: Record<string, unknown> = {}) {
  const spawn = vi.fn(() => child);
  return { manager: new WindowsAudioEndpointManager({ platform: "win32", spawn, ...options }), spawn };
}

describe("Windows endpoint discovery boundary", () => {
  it("resolves the app resource path and validates exact opaque IDs and device state", () => {
    expect(defaultEndpointProbePath("C:/KYX/resources")).toBe(
      path.join("C:/KYX/resources", "windows-audio-probe", "kyx-windows-audio-probe.exe"),
    );
    expect(defaultEndpointProbePath()).toContain(
      path.join("build", "windows-audio-probe", "Release", "kyx-windows-audio-probe.exe"),
    );
    expect(validateEndpointPayload(payload)).toEqual(payload);
  });

  it("spawns only the allowlisted metadata command and returns sanitized endpoints", async () => {
    const child = new FakeChild();
    const { manager, spawn } = managerWithChild(child);
    const resultPromise = manager.list();
    child.stdout.emit("data", Buffer.from(JSON.stringify(payload), "utf8"));
    child.emit("close", 0, null);

    expect(await resultPromise).toEqual({ status: "ok", ...payload });
    expect(spawn).toHaveBeenCalledWith(expect.stringContaining("kyx-windows-audio-probe.exe"), ["--list-json"], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  });

  it("rejects duplicate IDs, unknown state, oversized records and wrong schema", () => {
    expect(validateEndpointPayload({ schemaVersion: 1, endpoints: [] })).toBeNull();
    expect(
      validateEndpointPayload({ schemaVersion: 2, endpoints: [{ ...payload.endpoints[0], state: "default" }] }),
    ).toBeNull();
    expect(
      validateEndpointPayload({
        schemaVersion: 2,
        endpoints: [payload.endpoints[0], { ...payload.endpoints[0], name: "duplicate" }],
      }),
    ).toBeNull();
    expect(
      validateEndpointPayload({
        schemaVersion: 2,
        endpoints: [{ ...payload.endpoints[0], id: "x".repeat(2049) }],
      }),
    ).toBeNull();
    expect(
      validateEndpointPayload({
        schemaVersion: 2,
        endpoints: [{ ...payload.endpoints[0], mixFormat: { ...payload.endpoints[0].mixFormat, channels: 0 } }],
      }),
    ).toBeNull();
    expect(
      validateEndpointPayload({
        schemaVersion: 2,
        endpoints: [
          {
            ...payload.endpoints[0],
            mixFormat: {
              ...payload.endpoints[0].mixFormat,
              sharedPeriods: { defaultFrames: 1441, fundamentalFrames: 128, minFrames: 480, maxFrames: 1440 },
            },
          },
        ],
      }),
    ).toBeNull();
  });

  it("reports a missing probe without falling back to browser default devices", async () => {
    const { manager } = managerWithChild(new FakeChild(), {
      spawn: () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
    });
    await expect(manager.list()).resolves.toMatchObject({ status: "no-probe", endpoints: [] });
  });

  it("rejects malformed JSON, invalid UTF-8 and oversized process output", async () => {
    const malformedChild = new FakeChild();
    const malformed = managerWithChild(malformedChild).manager.list();
    malformedChild.stdout.emit("data", Buffer.from("not-json"));
    malformedChild.emit("close", 0, null);
    await expect(malformed).resolves.toMatchObject({ status: "invalid-output" });

    const utf8Child = new FakeChild();
    const invalidUtf8 = managerWithChild(utf8Child).manager.list();
    utf8Child.stdout.emit("data", Buffer.from([0xff, 0xfe]));
    utf8Child.emit("close", 0, null);
    await expect(invalidUtf8).resolves.toMatchObject({ status: "invalid-output" });

    const largeChild = new FakeChild();
    const large = managerWithChild(largeChild).manager.list();
    largeChild.stdout.emit("data", Buffer.alloc(MAX_STDOUT_BYTES + 1));
    await expect(large).resolves.toMatchObject({ status: "invalid-output" });
    expect(largeChild.killed).toBe(true);
  });

  it("bounds discovery time and never runs the Windows probe on another platform", async () => {
    vi.useFakeTimers();
    try {
      const timeoutChild = new FakeChild();
      const timeout = managerWithChild(timeoutChild, { timeoutMs: 25 }).manager.list();
      await vi.advanceTimersByTimeAsync(25);
      await expect(timeout).resolves.toMatchObject({ status: "timeout", endpoints: [] });
      expect(timeoutChild.killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }

    const spawn = vi.fn();
    const manager = new WindowsAudioEndpointManager({ platform: "darwin", spawn });
    await expect(manager.list()).resolves.toMatchObject({ status: "unsupported", endpoints: [] });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("registers one narrow preload-only IPC handler", async () => {
    const handlers = new Map<string, () => Promise<unknown>>();
    const ipc = { handle: (channel: string, handler: () => Promise<unknown>) => handlers.set(channel, handler) };
    const manager = { list: vi.fn().mockResolvedValue({ status: "ok", schemaVersion: 2, endpoints: [] }) };
    registerWindowsAudioEndpointHandlers(ipc, { manager });

    expect([...handlers.keys()]).toEqual(["kyx:audio:windows-endpoints"]);
    await expect(handlers.get("kyx:audio:windows-endpoints")!()).resolves.toMatchObject({ status: "ok" });
    expect(manager.list).toHaveBeenCalledOnce();
  });
});

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const bridge = require("../desktop/mrt2-bridge.cjs") as {
  getMrt2Availability: (options?: Record<string, unknown>) => Record<string, unknown>;
  validateMrt2Endpoint: (value: string) => { url: string; host: string; port: number };
  registerMrt2IpcHandlers: (ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => void;
  }) => void;
};

describe("Electron MRT2 boundary", () => {
  it("reports Windows as explicit unavailable while retaining a local companion option", () => {
    expect(bridge.getMrt2Availability({ platform: "win32", arch: "x64" })).toMatchObject({
      nativeRealtime: false,
      localCompanion: true,
      status: "unavailable",
    });
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

  it("registers narrow IPC handlers without exposing process execution", () => {
    const channels: string[] = [];
    bridge.registerMrt2IpcHandlers({
      handle(channel) {
        channels.push(channel);
      },
    });
    expect(channels).toEqual(["kyx:mrt2:get-availability", "kyx:mrt2:validate-endpoint"]);
  });
});

import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

// The desktop managers are CommonJS by design (Electron main process) —
// same access pattern as tests/asio-host.test.ts.
const require = createRequire(import.meta.url);
const { registerAsioIpcHandlers } = require("../desktop/asio-host-manager.cjs") as {
  registerAsioIpcHandlers: (ipcMain: unknown, options?: unknown) => unknown;
};
import {
  applyOutputDevice,
  listOutputDevices,
  loadOutputDeviceId,
  saveOutputDeviceId,
  setSinkIdSupported,
} from "../src/audio-engine/outputDevice";

/** Minimal ipcMain double capturing handle() registrations. */
function fakeIpcMain() {
  const handlers = new Map<string, (payload: unknown) => Promise<unknown>>();
  return {
    handle: (channel: string, fn: (payload: unknown) => Promise<unknown>) => handlers.set(channel, fn),
    invoke: (channel: string, payload?: unknown) => handlers.get(channel)?.(payload),
    handlers,
  };
}

describe("ASIO IPC bridge (Studio I/O wave)", () => {
  it("registers kyx:asio:list returning BOTH tiers with honest statuses", async () => {
    const ipc = fakeIpcMain();
    const manager = {
      listRegisteredDrivers: vi.fn().mockResolvedValue({ status: "ok", names: ["ASIO4ALL v2", "FlexASIO"] }),
      probeDrivers: vi.fn().mockResolvedValue({ status: "no-probe", drivers: [], message: "native build absent" }),
    };
    registerAsioIpcHandlers(ipc as never, { manager: manager as never });
    expect(ipc.handlers.has("kyx:asio:list")).toBe(true);

    const result = (await ipc.invoke("kyx:asio:list")) as {
      registry: { status: string; names: string[] };
      details: { status: string };
    };
    // Registry names always flow; an absent probe is a STATUS, not a throw.
    expect(result.registry.names).toEqual(["ASIO4ALL v2", "FlexASIO"]);
    expect(result.details.status).toBe("no-probe");
  });

  it("requires a real ipcMain (boundary pin)", () => {
    expect(() => registerAsioIpcHandlers(undefined as never)).toThrow("ipcMain is required");
  });
});

describe("output device helper", () => {
  const storage = () => {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    } as Pick<Storage, "getItem" | "setItem" | "removeItem">;
  };

  it("persists and clears the selection round-trip", () => {
    const store = storage();
    saveOutputDeviceId("device-abc", store);
    expect(loadOutputDeviceId(store)).toBe("device-abc");
    saveOutputDeviceId("", store);
    expect(loadOutputDeviceId(store)).toBe("");
  });

  it("setSinkId support is feature-detected on the context", () => {
    expect(setSinkIdSupported({ setSinkId: () => Promise.resolve() } as unknown as BaseAudioContext)).toBe(true);
    expect(setSinkIdSupported({} as BaseAudioContext)).toBe(false);
    expect(setSinkIdSupported(null)).toBe(false);
  });

  it("applyOutputDevice reports unsupported/error honestly, ok on success", async () => {
    const ok = await applyOutputDevice({ setSinkId: () => Promise.resolve() } as unknown as BaseAudioContext, "d1");
    expect(ok.status).toBe("ok");

    const unsupported = await applyOutputDevice({} as BaseAudioContext, "d1");
    expect(unsupported.status).toBe("unsupported");
    expect(unsupported.message).toBeTruthy();

    const closed = await applyOutputDevice({ state: "closed" } as BaseAudioContext, "d1");
    expect(closed.status).toBe("error");

    const failing = await applyOutputDevice(
      {
        setSinkId: () => Promise.reject(new Error("Device not found")),
      } as unknown as BaseAudioContext,
      "dX",
    );
    expect(failing.status).toBe("error");
    expect(failing.message).toBe("Device not found");
  });

  it("listOutputDevices keeps System default first and dedupes", async () => {
    const media = {
      enumerateDevices: async () => [
        { kind: "audiooutput", deviceId: "default", label: "Default" },
        { kind: "audiooutput", deviceId: "d1", label: "Volt 276" },
        { kind: "audiooutput", deviceId: "d1", label: "Volt 276" },
        { kind: "audioinput", deviceId: "m1", label: "Mic" },
        { kind: "audiooutput", deviceId: "d2", label: "" },
      ],
    };
    const devices = await listOutputDevices(media as unknown as MediaDevices);
    expect(devices[0]).toEqual({ deviceId: "default", label: "System default output" });
    expect(devices.map((d) => d.deviceId)).toEqual(["default", "d1", "d2"]);
    // Anonymous-but-present: the empty label still lists (it is the 2nd
    // real output the browser reported — the counter counts those).
    expect(devices[2].label).toBe("Audio output 2");
  });
});

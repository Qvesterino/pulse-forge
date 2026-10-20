import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { registerWindowsAudioIoHandlers, ringCapacityFramesForPeriod, validateRequest } =
  require("../desktop/windows-audio-io.cjs") as {
    registerWindowsAudioIoHandlers: (
      ipcMain: unknown,
      options: Record<string, unknown>,
    ) => {
      stopAll: () => Promise<unknown>;
      activeSessions: () => string[];
    };
    validateRequest: (request: unknown) => Record<string, unknown>;
    ringCapacityFramesForPeriod: (periodFrames: number) => number;
  };

const request = {
  backend: "wasapi-shared",
  inputEndpointId: "exact-capture-id",
  outputEndpointId: "exact-render-id",
  sampleRateHz: 48_000,
  periodFrames: 480,
  inputChannelMap: [1, 0],
  outputChannelMap: [2, 3],
  exclusiveAcknowledged: false,
};

class FakeHost extends EventEmitter {
  messages: Array<{ message: unknown; ports: unknown[] }> = [];
  killed = false;
  exitOnStop = true;
  exitOnKill = true;

  postMessage(message: unknown, ports: unknown[] = []) {
    this.messages.push({ message, ports });
    if ((message as { type?: string }).type === "stop" && this.exitOnStop) queueMicrotask(() => this.emit("exit", 0));
  }

  kill() {
    this.killed = true;
    if (this.exitOnKill) queueMicrotask(() => this.emit("exit", 1));
  }
}

class FakeWebContents extends EventEmitter {
  id = 10;
  messages: Array<{ channel: string; metadata: unknown; ports: unknown[] }> = [];

  postMessage(channel: string, metadata: unknown, ports: unknown[]) {
    this.messages.push({ channel, metadata, ports });
  }
}

function managerHarness(trusted = true) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)),
  };
  const hosts: FakeHost[] = [];
  const utilityProcess = {
    fork: vi.fn(() => {
      const host = new FakeHost();
      hosts.push(host);
      return host;
    }),
  };
  const ports = Array.from({ length: 4 }, () => ({ close: vi.fn() }));
  const MessageChannelMain = vi.fn(function (this: { port1: unknown; port2: unknown }) {
    this.port1 = ports.shift();
    this.port2 = ports.shift();
  });
  const webContents = new FakeWebContents();
  const manager = registerWindowsAudioIoHandlers(ipcMain, {
    utilityProcess,
    MessageChannelMain,
    isTrustedSender: () => trusted,
  });
  return { handlers, hosts, utilityProcess, webContents, manager };
}

describe("Windows audio session manager", () => {
  it("rounds the bounded four-period PCM rings up to a power-of-two capacity", () => {
    expect(ringCapacityFramesForPeriod(128)).toBe(512);
    expect(ringCapacityFramesForPeriod(480)).toBe(2_048);
    expect(ringCapacityFramesForPeriod(8_192)).toBe(32_768);
    expect(() => ringCapacityFramesForPeriod(8_193)).toThrow(/between 128 and 8192/);
  });

  it("preserves exact endpoint identity, period and user channel order", () => {
    expect(validateRequest(request)).toMatchObject({
      inputEndpointId: "exact-capture-id",
      outputEndpointId: "exact-render-id",
      periodFrames: 480,
      inputChannelMap: [1, 0],
      outputChannelMap: [2, 3],
    });
  });

  it("rejects substitution-prone, malformed or unsupported requests before spawning", async () => {
    expect(() => validateRequest({ ...request, inputEndpointId: " " })).toThrow(/exact endpoint ID/);
    expect(() => validateRequest({ ...request, outputChannelMap: [0, 0] })).toThrow(/unique/);
    expect(() => validateRequest({ ...request, periodFrames: 8193 })).toThrow(/periodFrames/);
    expect(() => validateRequest({ ...request, backend: "asio" })).toThrow(/shared-mode/);

    const harness = managerHarness(false);
    const start = harness.handlers.get("kyx:audio:windows-start");
    await expect(start?.({ sender: harness.webContents }, request)).rejects.toThrow(/trusted KYX window/);
    expect(harness.utilityProcess.fork).not.toHaveBeenCalled();
  });

  it("transfers PCM ports to the utility and exact trusted window, then stops its owned host", async () => {
    const harness = managerHarness();
    const start = harness.handlers.get("kyx:audio:windows-start");
    const stop = harness.handlers.get("kyx:audio:windows-stop");
    if (!start || !stop) throw new Error("audio IPC handlers were not registered");

    const result = (await start({ sender: harness.webContents }, request)) as { status: string; sessionId: string };
    expect(result.status).toBe("starting");
    expect(harness.manager.activeSessions()).toEqual([result.sessionId]);
    expect(harness.hosts[0]?.messages[0]?.message).toMatchObject({
      type: "start",
      sessionId: result.sessionId,
      request,
    });
    expect(harness.hosts[0]?.messages[0]?.ports).toHaveLength(1);
    expect(harness.webContents.messages[0]).toMatchObject({
      channel: "kyx:audio:windows-session-port",
      metadata: { sessionId: result.sessionId },
    });
    expect(harness.webContents.messages[0]?.ports).toHaveLength(1);

    const host = harness.hosts[0];
    if (!host) throw new Error("audio utility host was not started");
    host.emit("message", {
      type: "windows-audio-session-stage",
      sessionId: result.sessionId,
      stage: "native-start:capture/initialize-shared-stream",
    });
    host.emit("message", {
      type: "windows-audio-session-stage",
      sessionId: "another-session",
      stage: "native-start:render/starting-render-client",
    });
    host.emit("message", {
      type: "windows-audio-session-stage",
      sessionId: result.sessionId,
      stage: "x".repeat(257),
    });
    expect(
      harness.webContents.messages.filter((message) => message.channel === "kyx:audio:windows-session-stage"),
    ).toEqual([
      {
        channel: "kyx:audio:windows-session-stage",
        metadata: { sessionId: result.sessionId, stage: "native-start:capture/initialize-shared-stream" },
        ports: undefined,
      },
    ]);

    await expect(stop({ sender: harness.webContents }, { sessionId: result.sessionId })).resolves.toEqual({
      status: "stopped",
    });
    expect(harness.hosts[0]?.messages.at(-1)?.message).toEqual({ type: "stop", sessionId: result.sessionId });
    expect(harness.hosts[0]?.killed).toBe(false);
    expect(harness.manager.activeSessions()).toEqual([]);
  });

  it("kills an owned utility host when it ignores the bounded stop request", async () => {
    vi.useFakeTimers();
    try {
      const harness = managerHarness();
      const start = harness.handlers.get("kyx:audio:windows-start");
      const stop = harness.handlers.get("kyx:audio:windows-stop");
      if (!start || !stop) throw new Error("audio IPC handlers were not registered");

      const result = (await start({ sender: harness.webContents }, request)) as { sessionId: string };
      const host = harness.hosts[0];
      if (!host) throw new Error("audio utility host was not started");
      host.exitOnStop = false;

      const stopping = stop({ sender: harness.webContents }, { sessionId: result.sessionId });
      await vi.advanceTimersByTimeAsync(1_500);
      await expect(stopping).resolves.toEqual({ status: "stopped" });
      expect(host.killed).toBe(true);
      expect(harness.manager.activeSessions()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for forced utility exit before starting a replacement session", async () => {
    vi.useFakeTimers();
    try {
      const harness = managerHarness();
      const start = harness.handlers.get("kyx:audio:windows-start");
      if (!start) throw new Error("audio start handler was not registered");

      const first = (await start({ sender: harness.webContents }, request)) as { sessionId: string };
      const host = harness.hosts[0];
      if (!host) throw new Error("audio utility host was not started");
      host.exitOnStop = false;
      host.exitOnKill = false;

      const replacement = (start({ sender: harness.webContents }, request) as Promise<unknown>).then(
        () => ({ resolved: true as const }),
        (error: unknown) => ({ resolved: false as const, error }),
      );
      await vi.advanceTimersByTimeAsync(1_500);
      expect(host.killed).toBe(true);
      expect(harness.utilityProcess.fork).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(1_500);
      const outcome = await replacement;
      expect(outcome.resolved).toBe(false);
      if (outcome.resolved) throw new Error("replacement started before the old utility exited");
      if (!(outcome.error instanceof Error)) throw new Error("replacement shutdown failed without an Error reason");
      expect(outcome.error.message).toMatch(/did not exit after termination was requested/);
      expect(harness.manager.activeSessions()).toEqual([first.sessionId]);
      expect(harness.utilityProcess.fork).toHaveBeenCalledOnce();

      host.emit("exit", 1);
      const retry = (await start({ sender: harness.webContents }, request)) as { sessionId: string };
      expect(retry.sessionId).not.toBe(first.sessionId);
      expect(harness.utilityProcess.fork).toHaveBeenCalledTimes(2);
      await harness.manager.stopAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs a shutdown failure after window close without dropping the live utility session", async () => {
    vi.useFakeTimers();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const harness = managerHarness();
      const start = harness.handlers.get("kyx:audio:windows-start");
      if (!start) throw new Error("audio start handler was not registered");

      const result = (await start({ sender: harness.webContents }, request)) as { sessionId: string };
      const host = harness.hosts[0];
      if (!host) throw new Error("audio utility host was not started");
      host.exitOnStop = false;
      host.exitOnKill = false;

      harness.webContents.emit("destroyed");
      await vi.advanceTimersByTimeAsync(3_000);

      expect(host.killed).toBe(true);
      expect(harness.manager.activeSessions()).toEqual([result.sessionId]);
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining("Could not confirm utility shutdown after the window closed"),
        expect.any(Error),
      );

      host.emit("exit", 1);
      expect(harness.manager.activeSessions()).toEqual([]);
    } finally {
      errorLog.mockRestore();
      vi.useRealTimers();
    }
  });

  it("replaces an earlier session for the same window before opening the next host", async () => {
    const harness = managerHarness();
    const start = harness.handlers.get("kyx:audio:windows-start");
    if (!start) throw new Error("audio start handler was not registered");
    const first = (await start({ sender: harness.webContents }, request)) as { sessionId: string };
    const second = (await start({ sender: harness.webContents }, request)) as { sessionId: string };
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(harness.hosts).toHaveLength(2);
    expect(harness.hosts[0]?.messages.at(-1)?.message).toEqual({ type: "stop", sessionId: first.sessionId });
    expect(harness.manager.activeSessions()).toEqual([second.sessionId]);
    await harness.manager.stopAll();
    expect(harness.manager.activeSessions()).toEqual([]);
  });

  it("allows a fresh exact-endpoint session after an unexpected utility exit", async () => {
    const harness = managerHarness();
    const start = harness.handlers.get("kyx:audio:windows-start");
    if (!start) throw new Error("audio start handler was not registered");

    const first = (await start({ sender: harness.webContents }, request)) as { sessionId: string };
    const failedHost = harness.hosts[0];
    if (!failedHost) throw new Error("the first audio utility host was not started");
    failedHost.emit("exit", 1);
    expect(harness.manager.activeSessions()).toEqual([]);

    const retry = (await start({ sender: harness.webContents }, request)) as { sessionId: string };
    expect(retry.sessionId).not.toBe(first.sessionId);
    expect(harness.hosts).toHaveLength(2);
    expect(harness.hosts[1]?.messages[0]?.message).toMatchObject({
      type: "start",
      sessionId: retry.sessionId,
      request,
    });
    expect(harness.manager.activeSessions()).toEqual([retry.sessionId]);
    await harness.manager.stopAll();
    expect(harness.manager.activeSessions()).toEqual([]);
  });
});

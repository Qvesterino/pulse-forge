import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { isNativeStartupPending, scheduleNativeStartupWatchdog } =
  require("../desktop/windows-audio-startup-watchdog.cjs") as {
    isNativeStartupPending: (current: Record<string, unknown> | null, active: unknown) => boolean;
    scheduleNativeStartupWatchdog: (options: {
      timeoutMs: number;
      sessionId: string;
      isActive?: () => boolean;
      readSnapshot: () => { startupEndpoint: string; startupStage: string };
      reportStage: (stage: string) => void;
      postError: (message: { type: string; sessionId: string; message: string }) => void;
      terminate: (code: number) => void;
    }) => () => void;
  };

afterEach(() => vi.useRealTimers());

type HostMessage = { data?: unknown; ports?: FakeHostPort[] };

class FakeHostPort {
  private listeners = new Map<string, (event: HostMessage) => void>();
  messages: unknown[] = [];
  closed = false;

  on(event: string, listener: (event: HostMessage) => void): void {
    this.listeners.set(event, listener);
  }

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  start(): void {}

  close(): void {
    this.closed = true;
  }

  send(data: unknown, ports: FakeHostPort[] = []): void {
    this.listeners.get("message")?.({ data, ports });
  }
}

function createSessionHost(startNative: () => Promise<void>) {
  const parentPort = new FakeHostPort();
  const pcmPort = new FakeHostPort();
  const nativeSnapshot: Record<string, unknown> = {
    state: "starting",
    startupEndpoint: "capture",
    startupStage: "starting-capture-client",
    inputEndpointId: "capture-endpoint",
    outputEndpointId: "render-endpoint",
    sampleRateHz: 48_000,
    periodFrames: 480,
    inputChannelMap: [0, 1],
    outputChannelMap: [0, 1],
    inputEndpointChannels: 2,
    outputEndpointChannels: 2,
    inputBufferFrames: 960,
    outputBufferFrames: 960,
    sharedPeriods: { minFrames: 480, maxFrames: 960, fundamentalFrames: 480 },
  };
  const nativeSession = {
    start: vi.fn(startNative),
    stop: vi.fn(() => {
      nativeSnapshot.state = "stopped";
    }),
    snapshot: vi.fn(() => nativeSnapshot),
    readCaptureInto: vi.fn(() => 0),
    writeRender: vi.fn(() => true),
  };
  const addon = { createSession: vi.fn(() => nativeSession) };
  const processStub = { parentPort, resourcesPath: undefined, exit: vi.fn() };
  const startupWatchdog = require("../desktop/windows-audio-startup-watchdog.cjs") as Record<string, unknown>;
  const hostRequire = (id: string) => {
    if (id === "node:fs") return { existsSync: () => true };
    if (id === "node:path") return { join: (...parts: string[]) => parts.join("/") };
    if (id === "./windows-audio-io.cjs") return { ringCapacityFramesForPeriod: () => 2_048 };
    if (id === "./windows-audio-startup-watchdog.cjs") return startupWatchdog;
    if (id.endsWith("kyx_windows_audio_host.node")) return addon;
    throw new Error(`Unexpected native session host dependency: ${id}`);
  };
  const source = readFileSync(resolve(process.cwd(), "desktop/windows-audio-session-host.cjs"), "utf8");
  runInNewContext(source, {
    require: hostRequire,
    __dirname: "/desktop",
    process: processStub,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });
  parentPort.send(
    {
      type: "start",
      sessionId: "host-session-1",
      request: {
        backend: "wasapi-shared",
        inputEndpointId: "capture-endpoint",
        outputEndpointId: "render-endpoint",
        sampleRateHz: 48_000,
        periodFrames: 480,
        inputChannelMap: [0, 1],
        outputChannelMap: [0, 1],
        exclusiveAcknowledged: false,
      },
    },
    [pcmPort],
  );
  return { parentPort, pcmPort, nativeSession, nativeSnapshot, processStub };
}

async function flushHostMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

describe("Windows audio native-start watchdog", () => {
  it("reports the last WASAPI phase and exits only the utility after the grace period", () => {
    vi.useFakeTimers();
    const reportStage = vi.fn();
    const postError = vi.fn();
    const terminate = vi.fn();
    const cancel = scheduleNativeStartupWatchdog({
      timeoutMs: 700,
      sessionId: "session-1",
      isActive: () => true,
      readSnapshot: () => ({ startupEndpoint: "capture", startupStage: "query-capture-latency" }),
      reportStage,
      postError,
      terminate,
    });

    vi.advanceTimersByTime(700);
    expect(reportStage).toHaveBeenCalledWith("native-start-timeout:capture/query-capture-latency");
    expect(postError).toHaveBeenCalledWith({
      type: "error",
      sessionId: "session-1",
      message: "WASAPI startup exceeded 700 ms at capture/query-capture-latency; retry to start a fresh audio host",
    });
    expect(terminate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(terminate).toHaveBeenCalledWith(1);
    cancel();
  });

  it("cancels clean startup and leaves unrelated utility work running", () => {
    vi.useFakeTimers();
    const reportStage = vi.fn();
    const postError = vi.fn();
    const terminate = vi.fn();
    const cancel = scheduleNativeStartupWatchdog({
      timeoutMs: 700,
      sessionId: "session-2",
      readSnapshot: () => ({ startupEndpoint: "", startupStage: "running" }),
      reportStage,
      postError,
      terminate,
    });

    cancel();
    vi.advanceTimersByTime(2_000);
    expect(reportStage).not.toHaveBeenCalled();
    expect(postError).not.toHaveBeenCalled();
    expect(terminate).not.toHaveBeenCalled();
  });

  it("keeps the timeout armed when stop is requested while native startup is still pending", () => {
    vi.useFakeTimers();
    const session = { starting: true, stopping: false, stopRequested: true };
    const reportStage = vi.fn();
    const postError = vi.fn();
    const terminate = vi.fn();
    const cancel = scheduleNativeStartupWatchdog({
      timeoutMs: 700,
      sessionId: "session-stopping-during-startup",
      isActive: () => isNativeStartupPending(session, session),
      readSnapshot: () => ({ startupEndpoint: "capture", startupStage: "starting-capture-client" }),
      reportStage,
      postError,
      terminate,
    });

    vi.advanceTimersByTime(700);
    expect(reportStage).toHaveBeenCalledWith("native-start-timeout:capture/starting-capture-client");
    vi.advanceTimersByTime(100);
    expect(terminate).toHaveBeenCalledWith(1);
    cancel();
  });

  it("only treats the active, non-stopping start as pending", () => {
    const session = { starting: true, stopping: false, stopRequested: true };
    expect(isNativeStartupPending(session, session)).toBe(true);
    expect(isNativeStartupPending(session, {})).toBe(false);
    expect(isNativeStartupPending({ ...session, starting: false }, session)).toBe(false);
    expect(isNativeStartupPending({ ...session, stopping: true }, session)).toBe(false);
    expect(isNativeStartupPending(null, null)).toBe(false);
  });
});

describe("Windows audio utility session host lifecycle", () => {
  it("cancels before native Start when Stop wins before the worklet attaches", async () => {
    vi.useFakeTimers();
    const harness = createSessionHost(vi.fn(async () => undefined));

    harness.parentPort.send({ type: "stop", sessionId: "host-session-1" });

    expect(harness.nativeSession.start).not.toHaveBeenCalled();
    expect(harness.nativeSession.stop).toHaveBeenCalledOnce();
    expect(harness.pcmPort.closed).toBe(true);
    expect(harness.parentPort.messages).toContainEqual({ type: "stopped", sessionId: "host-session-1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.processStub.exit).toHaveBeenCalledWith(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops a running native session and clears every owned timer", async () => {
    vi.useFakeTimers();
    const harness = createSessionHost(vi.fn(async () => undefined));
    harness.nativeSnapshot.state = "running";
    harness.nativeSnapshot.startupStage = "running";
    harness.nativeSnapshot.startupEndpoint = "";

    harness.pcmPort.send({ type: "bridge-ready", sessionId: "host-session-1" });
    await flushHostMicrotasks();
    expect(harness.nativeSession.start).toHaveBeenCalledOnce();
    expect(harness.pcmPort.messages).toContainEqual(expect.objectContaining({ type: "ready" }));

    harness.parentPort.send({ type: "stop", sessionId: "host-session-1" });
    expect(harness.nativeSession.stop).toHaveBeenCalledOnce();
    expect(harness.pcmPort.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.processStub.exit).toHaveBeenCalledWith(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the watchdog armed after Stop while native Start is unresolved", async () => {
    vi.useFakeTimers();
    const neverSettles = new Promise<void>(() => {});
    const harness = createSessionHost(vi.fn(() => neverSettles));

    harness.pcmPort.send({ type: "bridge-ready", sessionId: "host-session-1" });
    await flushHostMicrotasks();
    expect(harness.nativeSession.start).toHaveBeenCalledOnce();

    harness.parentPort.send({ type: "stop", sessionId: "host-session-1" });
    expect(harness.nativeSession.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(7_100);

    expect(harness.pcmPort.messages).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("WASAPI startup exceeded 7000 ms at capture/starting-capture-client"),
      }),
    );
    expect(harness.processStub.exit).toHaveBeenCalledWith(1);
    expect(harness.nativeSession.stop).not.toHaveBeenCalled();
  });

  it("reports and contains a render-endpoint Start hang after Stop", async () => {
    vi.useFakeTimers();
    const neverSettles = new Promise<void>(() => {});
    const harness = createSessionHost(vi.fn(() => neverSettles));
    harness.nativeSnapshot.startupEndpoint = "render";
    harness.nativeSnapshot.startupStage = "starting-render-client";

    harness.pcmPort.send({ type: "bridge-ready", sessionId: "host-session-1" });
    await flushHostMicrotasks();
    expect(harness.nativeSession.start).toHaveBeenCalledOnce();

    harness.parentPort.send({ type: "stop", sessionId: "host-session-1" });
    expect(harness.nativeSession.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(7_100);

    expect(harness.pcmPort.messages).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("WASAPI startup exceeded 7000 ms at render/starting-render-client"),
      }),
    );
    expect(harness.parentPort.messages).toContainEqual(
      expect.objectContaining({ stage: "native-start-timeout:render/starting-render-client" }),
    );
    expect(harness.processStub.exit).toHaveBeenCalledWith(1);
    expect(harness.nativeSession.stop).not.toHaveBeenCalled();
  });

  it("reports native Start rejection, tears down the session, and exits cleanly", async () => {
    vi.useFakeTimers();
    const harness = createSessionHost(vi.fn(async () => Promise.reject(new Error("injected Start failure"))));

    harness.pcmPort.send({ type: "bridge-ready", sessionId: "host-session-1" });
    await flushHostMicrotasks();

    expect(harness.pcmPort.messages).toContainEqual(
      expect.objectContaining({ type: "error", message: expect.stringContaining("injected Start failure") }),
    );
    expect(harness.nativeSession.stop).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    expect(harness.processStub.exit).toHaveBeenCalledWith(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

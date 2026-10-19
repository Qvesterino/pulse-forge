import { createRequire } from "node:module";
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

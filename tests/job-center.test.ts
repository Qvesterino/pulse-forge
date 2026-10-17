import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelAllJobs,
  cancelJob,
  dismissJobNotice,
  jobSnapshot,
  resetJobCenterForTests,
  runningJobCount,
  startJob,
  subscribeJobs,
} from "../src/services/jobCenter";

/**
 * JOB CENTER (Wave 1/B) — the registry contract: one settlement per job, no
 * duplicate work under the same key, cancellation that owners can observe,
 * and a timeout that prevents a lost owner from leaving a job "running"
 * forever (the stuck-flag class the recovery audit hunted).
 */

beforeEach(() => {
  vi.useFakeTimers();
  resetJobCenterForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("job center", () => {
  it("tracks progress and settles once", () => {
    const handle = startJob({ kind: "test", label: "render" })!;
    expect(runningJobCount()).toBe(1);
    handle.update(0.5, "halfway");
    expect(jobSnapshot().jobs[0]).toMatchObject({ status: "running", progress: 0.5, note: "halfway" });
    handle.done();
    expect(jobSnapshot().jobs[0]).toMatchObject({ status: "done", progress: 1 });
    // Late reports after settlement are ignored — no double reporting.
    handle.fail(new Error("too late"));
    expect(jobSnapshot().jobs[0]!.status).toBe("done");
  });

  it("dedupes concurrent jobs under the same key", () => {
    const first = startJob({ kind: "agent", label: "a", key: "agent:web-relay:kyx_export" });
    const second = startJob({ kind: "agent", label: "b", key: "agent:web-relay:kyx_export" });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(runningJobCount()).toBe(1);
    first!.done();
    // Once settled, the key is free again.
    expect(startJob({ kind: "agent", label: "c", key: "agent:web-relay:kyx_export" })).not.toBeNull();
  });

  it("aborts the owner's signal and settles as cancelled", () => {
    const handle = startJob({ kind: "test", label: "long" })!;
    expect(handle.signal.aborted).toBe(false);
    expect(cancelJob(handle.id)).toBe(true);
    expect(handle.signal.aborted).toBe(true);
    expect(jobSnapshot().jobs[0]!.status).toBe("cancelled");
    // A cancelled job cannot be cancelled twice or revived by a late done().
    expect(cancelJob(handle.id)).toBe(false);
    handle.done();
    expect(jobSnapshot().jobs[0]!.status).toBe("cancelled");
  });

  it("fails a job whose owner never settles it (watchdog)", () => {
    startJob({ kind: "agent", label: "stuck", timeoutMs: 5_000 });
    vi.advanceTimersByTime(4_000);
    expect(jobSnapshot().jobs[0]!.status).toBe("running");
    vi.advanceTimersByTime(1_001);
    expect(jobSnapshot().jobs[0]).toMatchObject({ status: "failed" });
    expect(jobSnapshot().jobs[0]!.error).toMatch(/timed out/);
    expect(runningJobCount()).toBe(0);
  });

  it("cancels every running job on teardown", () => {
    startJob({ kind: "test", label: "a" });
    startJob({ kind: "test", label: "b" });
    expect(cancelAllJobs()).toBe(2);
    expect(runningJobCount()).toBe(0);
    expect(jobSnapshot().jobs.every((job) => job.status === "cancelled")).toBe(true);
  });

  it("records bounded completion notices and dismisses them", () => {
    const handle = startJob({ kind: "agent", label: "kyx_export" })!;
    handle.done();
    expect(jobSnapshot().notices).toHaveLength(1);
    const notice = jobSnapshot().notices[0]!;
    expect(notice.text).toContain("kyx_export");
    dismissJobNotice(notice.id);
    expect(jobSnapshot().notices).toHaveLength(0);
    dismissJobNotice(999); // unknown id is a no-op
  });

  it("keeps running jobs and only the last 20 settled ones", () => {
    for (let index = 0; index < 25; index += 1) {
      const handle = startJob({ kind: "test", label: `job ${index}` })!;
      handle.done();
    }
    const running = startJob({ kind: "test", label: "still running" })!;
    const jobs = jobSnapshot().jobs;
    expect(jobs.filter((job) => job.status !== "running")).toHaveLength(20);
    expect(jobs.some((job) => job.id === running.id)).toBe(true);
    expect(runningJobCount()).toBe(1);
  });

  it("notifies subscribers on every transition", () => {
    let notifications = 0;
    const unsubscribe = subscribeJobs(() => {
      notifications += 1;
    });
    const handle = startJob({ kind: "test", label: "x" })!;
    handle.update(0.25);
    handle.fail(new Error("boom"));
    expect(notifications).toBe(3);
    expect(jobSnapshot().jobs[0]!.error).toBe("boom");
    unsubscribe();
  });
});

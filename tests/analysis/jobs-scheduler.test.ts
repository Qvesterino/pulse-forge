import { describe, expect, it } from "vitest";
import { createAnalysisScheduler, type AnalysisJobSpec } from "../../src/analysis/jobs";

/**
 * E-4, layer 1 — the TIER SCHEDULER simulation (fully deterministic: jobs
 * are manually-resolved promises, no clock, no audio device). This is the
 * overload contract the perception audit asked to be ENFORCED, not just
 * documented:
 *
 *   near-rt  — single-flight PER SCOPE; a fresher request supersedes the
 *              queued one; the RUNNING job is never aborted mid-flight.
 *   offline  — bounded FIFO; overflow drops THE ANALYSIS with a reason.
 *   staleness— a stale queued job is dropped BEFORE it starts (E-3).
 *   overload — analysis is dropped/deferred; the scheduler never blocks
 *              and never touches the audio thread (it cannot: pure logic).
 */

function deferred<P>(): { promise: Promise<P>; resolve: (value: P) => void; reject: (error: Error) => void } {
  let resolve!: (value: P) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<P>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function job<P>(scopeId: string, run: (signal: AbortSignal) => Promise<P>, stale?: () => boolean): AnalysisJobSpec<P> {
  return { scopeId, tier: "near-rt", run, ...(stale ? { stale } : {}) };
}

describe("E-4: the analysis job scheduler under load", () => {
  it("near-rt is single-flight: one running, one queued, a third SUBSIDES the queued one", async () => {
    const scheduler = createAnalysisScheduler({ maxConcurrentNearRt: 1 });
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    let ran = 0;

    const first = scheduler.submit(job("track-1", async () => (ran++, gates[0]!.promise)));
    const second = scheduler.submit(job("track-1", async () => (ran++, gates[1]!.promise)));
    // Let the pump start job 1.
    await Promise.resolve();
    const third = scheduler.submit(job("track-1", async () => (ran++, gates[2]!.promise)));
    await Promise.resolve();
    await Promise.resolve();

    // Job 2 (queued) was superseded by job 3's fresher request.
    await expect(second).resolves.toMatchObject({ dropped: true, reason: "superseded" });
    expect(ran).toBe(1); // only job 1 started so far — single-flight held
    expect(scheduler.queued().nearRt).toBe(1);

    gates[0]!.resolve("one");
    expect(await first).toMatchObject({ dropped: false, value: "one" });
    // Job 3 starts after job 1 finishes; job 2 stays superseded FOREVER —
    // a superseded request is a dropped analysis, never a delayed one.
    gates[2]!.resolve("three");
    expect(await third).toMatchObject({ dropped: false, value: "three" });
    expect(await second).toMatchObject({ dropped: true, reason: "superseded" });
    expect(ran).toBe(2); // jobs 1 and 3; job 2 never ran
    expect(scheduler.telemetry().ran).toBe(2);
    expect(scheduler.telemetry().droppedSuperseded).toBe(1);
  });

  it("a STALE queued job is dropped before it starts (E-3 integration)", async () => {
    const scheduler = createAnalysisScheduler({ maxConcurrentNearRt: 1 });
    const gate = deferred<string>();
    let staleJobRan = false;

    const running = scheduler.submit(job("clip-1", async () => gate.promise));
    const stale = scheduler.submit(
      job(
        "clip-1",
        async () => {
          staleJobRan = true;
          return "computed-anyway";
        },
        () => true,
      ), // stale predicate fires
    );

    gate.resolve("done");
    await running;
    await expect(stale).resolves.toMatchObject({ dropped: true, reason: "stale" });
    expect(staleJobRan, "a stale job must never be computed").toBe(false);
    expect(scheduler.telemetry().droppedStale).toBe(1);
  });

  it("offline is a bounded FIFO: order kept, overflow drops THE ANALYSIS", async () => {
    const scheduler = createAnalysisScheduler({ maxConcurrentOffline: 1, maxQueuedOffline: 2 });
    const gates = [deferred<string>(), deferred<string>(), deferred<string>(), deferred<string>()];
    const order: string[] = [];

    const jobs = [
      scheduler.submit({ scopeId: "o1", tier: "offline", run: async () => (order.push("o1"), gates[0]!.promise) }),
      scheduler.submit({ scopeId: "o2", tier: "offline", run: async () => (order.push("o2"), gates[1]!.promise) }),
      scheduler.submit({ scopeId: "o3", tier: "offline", run: async () => (order.push("o3"), gates[2]!.promise) }),
      scheduler.submit({ scopeId: "o4", tier: "offline", run: async () => (order.push("o4"), gates[3]!.promise) }),
      scheduler.submit({ scopeId: "o5", tier: "offline", run: async () => (order.push("o5"), gates[3]!.promise) }),
    ];
    await Promise.resolve();
    await Promise.resolve();

    // o1 runs, o2+o3 queue, o4 overflows the queue cap of 2 → dropped.
    await expect(jobs[3]!).resolves.toMatchObject({ dropped: true, reason: "queue-full" });
    expect(scheduler.queued().offline).toBe(2);

    gates[0]!.resolve("1");
    gates[1]!.resolve("2");
    gates[2]!.resolve("3");
    expect((await jobs[0]!).value).toBe("1");
    expect((await jobs[1]!).value).toBe("2");
    expect((await jobs[2]!).value).toBe("3");
    expect(order).toEqual(["o1", "o2", "o3"]); // FIFO, no silent fifth job
  });

  it("tiers run CONCURRENTLY: a near-rt job is not blocked by an offline one (audio-side lag immunity)", async () => {
    const scheduler = createAnalysisScheduler({});
    const offlineGate = deferred<string>();
    const nearGate = deferred<string>();
    let nearStarted = false;

    const offline = scheduler.submit({ scopeId: "deep", tier: "offline", run: async () => offlineGate.promise });
    const near = scheduler.submit(
      job("live", async () => {
        nearStarted = true;
        return nearGate.promise;
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(nearStarted, "near-rt must start even while a deep offline analysis runs").toBe(true);

    nearGate.resolve("fresh");
    offlineGate.resolve("deep-done");
    expect((await near).value).toBe("fresh");
    expect((await offline).value).toBe("deep-done");
  });

  it("dispose drops everything queued; running jobs still land", async () => {
    const scheduler = createAnalysisScheduler({ maxConcurrentNearRt: 1, maxConcurrentOffline: 1 });
    const gate = deferred<string>();
    const running = scheduler.submit(job("x", async () => gate.promise));
    await Promise.resolve();
    const queued = scheduler.submit(job("y", async () => "never"));

    scheduler.dispose();

    await expect(queued).resolves.toMatchObject({ dropped: true, reason: "disposed" });
    gate.resolve("landed");
    expect(await running).toMatchObject({ dropped: false, value: "landed" });
    const after = scheduler.submit(job("z", async () => "post"));
    await expect(after).resolves.toMatchObject({ dropped: true, reason: "disposed" });
  });

  it("a job that REJECTS is contained — the scheduler never propagates the throw", async () => {
    const scheduler = createAnalysisScheduler({ maxConcurrentNearRt: 1 });
    const outcome = await scheduler.submit(
      job("boom", async () => {
        throw new Error("analyzer exploded");
      }),
    );
    expect(outcome.dropped).toBe(false);
    expect(outcome.value).toBeNull();
    expect(scheduler.telemetry().ran).toBe(1);
  });
});

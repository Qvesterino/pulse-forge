/**
 * ANALYSIS JOB SCHEDULER (E-4, perception audit §8/§14/G-6) — the tiered
 * scheduling policy the audit asked to be written down and enforced:
 *
 *   near-rt  — single-flight PER SCOPE: a fresh analysis of the same scope
 *              supersedes the queued one (the newest data wins); the RUNNING
 *              job is never aborted mid-flight, but superseded results are
 *              discardable (the completion callback reports it).
 *   offline  — bounded FIFO; overflow DROPS THE ANALYSIS with a reason.
 *
 * THE OVERLOAD INVARIANT: under load, ANALYSIS is dropped/deferred — audio
 * is never touched. Nothing in this scheduler runs on, blocks, or
 * allocates for the audio thread; it is main/worker logic only.
 *
 * Staleness (E-3) is enforced BEFORE a queued job starts: a job whose
 * `stale()` predicate fires (e.g. isAnalysisStale(entry, current)) is
 * dropped with reason "stale" — a stale result is never even computed.
 *
 * No timers, no clock dependency: concurrency is promise-driven, so tests
 * drive determinism with manually-resolved jobs.
 */

export type AnalysisTier = "near-rt" | "offline";

export type DropReason = "superseded" | "stale" | "queue-full" | "disposed";

export interface AnalysisJobSpec<P> {
  /** Identity: near-rt supersession is PER SCOPE (e.g. a trackId). */
  scopeId: string;
  tier: AnalysisTier;
  /** Freshness predicate, checked right before the job starts (E-3). */
  stale?: () => boolean;
  run: (signal: AbortSignal) => Promise<P>;
}

export interface AnalysisJobOutcome<P> {
  /** The job's result, or null when the job was dropped (reason says why). */
  value: P | null;
  dropped: boolean;
  reason?: DropReason;
}

export interface SchedulerTelemetry {
  ran: number;
  droppedSuperseded: number;
  droppedStale: number;
  droppedQueueFull: number;
  droppedDisposed: number;
}

export interface AnalysisScheduler {
  submit<P>(job: AnalysisJobSpec<P>): Promise<AnalysisJobOutcome<P>>;
  /** Queued (not yet running) job counts, for telemetry/UI. */
  queued(): { nearRt: number; offline: number };
  telemetry(): SchedulerTelemetry;
  /** Abort everything queued; running jobs finish (their results still land). */
  dispose(): void;
}

interface QueueNode {
  scopeId: string;
  tier: AnalysisTier;
  stale?: () => boolean;
  start: (signal: AbortSignal) => Promise<unknown>;
  settle: (value: AnalysisJobOutcome<unknown>) => void;
  dispose: () => void;
}

export interface SchedulerOptions {
  maxConcurrentNearRt?: number;
  maxConcurrentOffline?: number;
  maxQueuedOffline?: number;
}

export function createAnalysisScheduler(options: SchedulerOptions = {}): AnalysisScheduler {
  const maxNearRt = options.maxConcurrentNearRt ?? 1;
  const maxOffline = options.maxConcurrentOffline ?? 2;
  const maxQueuedOffline = options.maxQueuedOffline ?? 64;

  const nearRtQueue: QueueNode[] = [];
  const offlineQueue: QueueNode[] = [];
  let runningNearRt = 0;
  let runningOffline = 0;
  let disposed = false;
  const telemetry: SchedulerTelemetry = {
    ran: 0,
    droppedSuperseded: 0,
    droppedStale: 0,
    droppedQueueFull: 0,
    droppedDisposed: 0,
  };

  function pump(): void {
    if (disposed) return;
    while (runningNearRt < maxNearRt && nearRtQueue.length > 0) {
      const node = nearRtQueue.shift()!;
      if (node.stale?.()) {
        telemetry.droppedStale += 1;
        node.settle({ value: null, dropped: true, reason: "stale" });
        continue;
      }
      runningNearRt += 1;
      node
        .start(new AbortController().signal)
        .then((value) => {
          telemetry.ran += 1;
          node.settle({ value, dropped: false });
        })
        .catch(() => {
          // A job that REJECTS still ran — the caller's run() owns its error
          // tier; the scheduler reports it as ran with a null value.
          telemetry.ran += 1;
          node.settle({ value: null, dropped: false });
        })
        .finally(() => {
          runningNearRt -= 1;
          pump();
        });
    }
    while (runningOffline < maxOffline && offlineQueue.length > 0) {
      const node = offlineQueue.shift()!;
      if (node.stale?.()) {
        telemetry.droppedStale += 1;
        node.settle({ value: null, dropped: true, reason: "stale" });
        continue;
      }
      runningOffline += 1;
      node
        .start(new AbortController().signal)
        .then((value) => {
          telemetry.ran += 1;
          node.settle({ value, dropped: false });
        })
        .catch(() => {
          telemetry.ran += 1;
          node.settle({ value: null, dropped: false });
        })
        .finally(() => {
          runningOffline -= 1;
          pump();
        });
    }
  }

  return {
    submit<P>(job: AnalysisJobSpec<P>): Promise<AnalysisJobOutcome<P>> {
      if (disposed) {
        telemetry.droppedDisposed += 1;
        return Promise.resolve({ value: null, dropped: true, reason: "disposed" });
      }

      return new Promise<AnalysisJobOutcome<P>>((resolve) => {
        const node: QueueNode = {
          scopeId: job.scopeId,
          tier: job.tier,
          stale: job.stale,
          start: (signal) => job.run(signal) as Promise<unknown>,
          settle: (value) => resolve(value as AnalysisJobOutcome<P>),
          dispose: () => undefined,
        };

        if (job.tier === "near-rt") {
          // Single-flight per scope: a queued job for the SAME scope is
          // superseded by the fresher request (drop-old, queue-new).
          const existingIndex = nearRtQueue.findIndex((n) => n.scopeId === job.scopeId);
          if (existingIndex >= 0) {
            const [superseded] = nearRtQueue.splice(existingIndex, 1);
            telemetry.droppedSuperseded += 1;
            superseded!.settle({ value: null, dropped: true, reason: "superseded" });
          }
          nearRtQueue.push(node);
        } else {
          if (offlineQueue.length >= maxQueuedOffline) {
            telemetry.droppedQueueFull += 1;
            resolve({ value: null, dropped: true, reason: "queue-full" });
            return;
          }
          offlineQueue.push(node);
        }
        pump();
      });
    },

    queued() {
      return { nearRt: nearRtQueue.length, offline: offlineQueue.length };
    },

    telemetry() {
      return { ...telemetry };
    },

    dispose() {
      disposed = true;
      for (const node of nearRtQueue.splice(0)) {
        telemetry.droppedDisposed += 1;
        node.settle({ value: null, dropped: true, reason: "disposed" });
      }
      for (const node of offlineQueue.splice(0)) {
        telemetry.droppedDisposed += 1;
        node.settle({ value: null, dropped: true, reason: "disposed" });
      }
    },
  };
}

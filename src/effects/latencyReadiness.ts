/** Tracks whether a processor has delivered its first authoritative latency report. */
export interface LatencyReportReadiness {
  isReported(): boolean;
  wait(timeoutMs: number): Promise<boolean>;
  markReported(): void;
  dispose(): void;
}

export function createLatencyReportReadiness(): LatencyReportReadiness {
  let reported = false;
  let disposed = false;
  const waiters = new Set<(ready: boolean) => void>();

  const settle = (ready: boolean): void => {
    for (const waiter of [...waiters]) waiter(ready);
  };

  return {
    isReported: () => reported,
    wait(timeoutMs) {
      if (reported) return Promise.resolve(true);
      if (disposed) return Promise.resolve(false);
      const safeTimeoutMs = Number.isFinite(timeoutMs) ? Math.max(1, timeoutMs) : 1;

      return new Promise<boolean>((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        const finish = (ready: boolean): void => {
          clearTimeout(timer);
          waiters.delete(finish);
          resolve(ready);
        };
        waiters.add(finish);
        timer = setTimeout(() => finish(false), safeTimeoutMs);
      });
    },
    markReported() {
      if (reported || disposed) return;
      reported = true;
      settle(true);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      settle(false);
    },
  };
}

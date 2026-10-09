/**
 * Synchronous, tab-local lock for memory-heavy MASTER work. UI busy state
 * remains responsible for status and disabled controls; this gate closes the
 * event-loop window before React has committed those updates.
 */
interface WaitingWork {
  resolve: (release: (() => void) | null) => void;
  signal?: AbortSignal;
  abort?: () => void;
}

let activeWork: symbol | null = null;
const waitingWork: WaitingWork[] = [];

function createRelease(token: symbol): () => void {
  let released = false;
  return () => {
    if (released || activeWork !== token) return;
    released = true;
    activeWork = null;
    while (waitingWork.length > 0) {
      const next = waitingWork.shift();
      if (!next) return;
      if (next.signal && next.abort) next.signal.removeEventListener("abort", next.abort);
      if (next.signal?.aborted) {
        next.resolve(null);
        continue;
      }
      const nextToken = Symbol("mastering-work");
      activeWork = nextToken;
      next.resolve(createRelease(nextToken));
      return;
    }
  };
}

export function tryAcquireMasteringWork(): (() => void) | null {
  if (activeWork !== null || waitingWork.length > 0) return null;

  const token = Symbol("mastering-work");
  activeWork = token;
  return createRelease(token);
}

/** Waits in order for a workspace lease; used by automatic local restore work. */
export function acquireMasteringWork(signal?: AbortSignal, onWaiting?: () => void): Promise<(() => void) | null> {
  const release = tryAcquireMasteringWork();
  if (release) return Promise.resolve(release);
  if (signal?.aborted) return Promise.resolve(null);
  onWaiting?.();

  return new Promise((resolve) => {
    const waiting: WaitingWork = { resolve, ...(signal ? { signal } : {}) };
    if (signal) {
      waiting.abort = () => {
        const index = waitingWork.indexOf(waiting);
        if (index >= 0) waitingWork.splice(index, 1);
        resolve(null);
      };
      signal.addEventListener("abort", waiting.abort, { once: true });
    }
    waitingWork.push(waiting);
  });
}

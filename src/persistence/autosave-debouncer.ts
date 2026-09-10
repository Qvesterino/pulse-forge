/**
 * Autosave debouncer with a max-defer ceiling.
 *
 * `services.ts` arms a debounced save on every `onDocChanged` (e.g. on a
 * fader drag at 60 Hz the timer is cleared and re-set 60 times per
 * second, never firing). The user's last edit sits in the 800 ms
 * debounce window until the user STOPS moving; if the tab is closed
 * mid-gesture the save is lost. iOS Safari's `beforeunload` is not
 * a reliable last line of defence (the engine's `save-lifecycle`
 * helper still fires a synchronous `pagehide` flush, but a tab
 * terminated by the OS mid-write can still drop the in-flight edit).
 *
 * The fix is a bounded-defer safety net:
 * - if more than `maxDeferMs` of wall-clock time has passed since the
 *   FIRST arm in the current burst, the next arm force-flushes
 *   immediately instead of re-arming the debounce;
 * - the same goes for `maxArms` re-arms in a single burst.
 *
 * Both ceilings are independent and stack — either one trips the
 * force-flush. The burst is reset on flush completion.
 *
 * The helper is pure: `now` and timers are injected so unit tests can
 * drive it with `vi.useFakeTimers` without any DOM dependency.
 */

export interface AutosaveDebouncerOptions {
  /** Called when the debouncer decides it's time to flush. */
  flush: () => Promise<void> | void;
  /** Normal debounce window in ms (existing Pulse Forge contract: 800). */
  debounceMs: number;
  /**
   * Hard ceiling: if the FIRST arm in the current burst was at least
   * this many ms ago, the NEXT arm force-flushes immediately.
   */
  maxDeferMs: number;
  /**
   * Hard ceiling: if this many re-arms have happened in the current
   * burst, the NEXT arm force-flushes immediately.
   */
  maxArms: number;
  /** Inject for tests; defaults to wall-clock ms. */
  now?: () => number;
  /** Inject for tests; defaults to globalThis.setTimeout / clearTimeout. */
  setTimeout?: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export interface AutosaveDebouncer {
  /** Re-arm the debounce. Force-flushes if the defer cap has been hit. */
  arm(): void;
  /** Clear the pending timer and reset the burst counters. No flush. */
  cancel(): void;
  /** Force a flush now: clear the timer, await any in-flight save, then write. */
  flush(): Promise<void>;
  /** Read-only state for tests + diagnostics. */
  readonly state: {
    readonly armCount: number;
    readonly firstArmTime: number | null;
    readonly pending: boolean;
  };
}

export function createAutosaveDebouncer(opts: AutosaveDebouncerOptions): AutosaveDebouncer {
  const now = opts.now ?? (() => Date.now());
  const setT = opts.setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
  const clearT = opts.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let timer: unknown = null;
  let armCount = 0;
  let firstArmTime: number | null = null;
  // Coalesce a force-flush and the debounce-driven flush when they
  // race: one in-flight Promise per burst, not two.
  let pendingFlush: Promise<void> | null = null;

  const resetCounters = (): void => {
    armCount = 0;
    firstArmTime = null;
  };

  const doFlush = async (): Promise<void> => {
    timer = null;
    resetCounters();
    try {
      await opts.flush();
    } catch {
      // Caller is responsible for surfacing save errors via
      // store.setSaveStatus("error"); we just need to release the
      // pending promise so the next arm can fire.
    }
  };

  const startFlush = (): void => {
    if (pendingFlush) return;
    pendingFlush = doFlush().finally(() => {
      pendingFlush = null;
    });
  };

  return {
    arm(): void {
      if (firstArmTime === null) firstArmTime = now();
      armCount += 1;
      const elapsed = now() - firstArmTime;
      // Defect D.1 (performance / memory recon): the previous
      // implementation only ever re-armed the 800 ms timer. A
      // continuous gesture (fader drag, CC sweep) would push every
      // edit into a debounce window that never expired. Force a
      // flush once the burst has either aged past maxDeferMs or
      // accumulated maxArms re-arms — whichever hits first.
      if (elapsed > opts.maxDeferMs || armCount > opts.maxArms) {
        if (timer != null) {
          clearT(timer);
          timer = null;
        }
        // Reset the burst SYNCHRONOUSLY so a follow-up arm starts
        // a fresh burst (armCount = 0) even before the in-flight
        // async flush resolves. doFlush() also calls resetCounters,
        // but that runs inside an async function — callers reading
        // `state.armCount` immediately after the arm that tripped
        // the cap would otherwise see the pre-trip value.
        resetCounters();
        startFlush();
        return;
      }
      if (timer != null) clearT(timer);
      timer = setT(() => {
        startFlush();
      }, opts.debounceMs);
    },

    cancel(): void {
      if (timer != null) {
        clearT(timer);
        timer = null;
      }
      resetCounters();
    },

    async flush(): Promise<void> {
      if (timer != null) {
        clearT(timer);
        timer = null;
      }
      if (pendingFlush) {
        await pendingFlush;
        return;
      }
      // The flush may itself re-arm (the caller fires a doc change
      // through `store.setSaveStatus("saved")` callbacks). We start
      // a new in-flight promise and clear the burst counters.
      const run = (async (): Promise<void> => {
        try {
          await opts.flush();
        } catch {
          /* see doFlush */
        }
      })();
      pendingFlush = run.finally(() => {
        pendingFlush = null;
      });
      await run;
    },

    get state() {
      return { armCount, firstArmTime, pending: pendingFlush != null };
    },
  };
}

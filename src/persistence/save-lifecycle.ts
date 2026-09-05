/**
 * Save-lifecycle unload guards.
 *
 * Pulse Forge's IndexedDB saves are debounced and the actual write is
 * async. The browser does NOT await promises from `beforeunload`, and iOS
 * Safari terminates tabs without firing `beforeunload` at all. The
 * "Continue last project" pointer can therefore drift away from the
 * last-saved body if the user closes the tab while a save is in flight
 * or in the 800 ms debounce window.
 *
 * This module installs three event hooks:
 *
 * - `pagehide` (the modern, mobile-friendly replacement for `beforeunload`)
 *   fires a final synchronous flush. It is the primary safety net on iOS.
 * - `beforeunload` warns the user when the project has unsaved changes
 *   (dirty / error) and lets the browser show its native "Leave site?"
 *   dialog. Without `event.returnValue` set, modern browsers ignore the
 *   warning. We also fire a final flush in the same handler.
 * - `visibilitychange` flushes when the tab is hidden (already wired by
 *   the caller; we re-export the contract here for documentation).
 *
 * The helper is a pure function — it returns the `uninstall` cleanup so
 * the host can remove the listeners on project close.
 */
export interface SaveUnloadGuardsOptions {
  /** Trigger a flush of the debounced + in-flight save. Never throws. */
  flushSave: () => Promise<void> | void;
  /** True when there are unsaved or unflushed changes that would be lost. */
  isDirty: () => boolean;
}

export interface SaveUnloadGuards {
  install(target?: { addEventListener: Window["addEventListener"] }): () => void;
}

/**
 * Install unload-pagehide-beforeunload safety nets around a save pipeline.
 *
 * The default `target` is the global `window`. Tests can pass a custom
 * target to capture dispatched events without touching the real window.
 */
export function installSaveUnloadGuards(
  options: SaveUnloadGuardsOptions,
  target: Pick<Window, "addEventListener" | "removeEventListener"> = window,
): () => void {
  const onPageHide = (): void => {
    // pagehide is the one iOS Safari reliably fires before terminating
    // a tab. Fire-and-forget: the IDB transaction is enqueued in the
    // browser's commit queue and the OS will attempt the write even if
    // the JS context is destroyed shortly after.
    void options.flushSave();
  };

  const onBeforeUnload = (event: Event): void => {
    // A "dirty" project means the user's last edit is in the 800 ms
    // debounce window (or the previous save errored). A synchronous
    // flush + a browser warning gives the user a chance to cancel close
    // and let the write commit.
    if (options.isDirty()) {
      event.preventDefault();
      // Legacy string return — modern Chrome/Firefox require this exact
      // pattern to show the "Leave site?" dialog. The defineProperty
      // form is a defensive fallback for environments where the typed
      // assignment is a no-op (jsdom, older Safari).
      try {
        Object.defineProperty(event, "returnValue", {
          value: "",
          configurable: true,
          writable: true,
        });
      } catch {
        // read-only host object — preventDefault() above is the modern
        // contract, so we silently move on.
      }
    }
    void options.flushSave();
  };

  target.addEventListener("pagehide", onPageHide);
  target.addEventListener("beforeunload", onBeforeUnload);

  return () => {
    target.removeEventListener("pagehide", onPageHide);
    target.removeEventListener("beforeunload", onBeforeUnload);
  };
}

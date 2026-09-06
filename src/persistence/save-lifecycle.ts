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
 *   starts a final best-effort asynchronous flush. It is the primary safety
 *   net on iOS, although browsers cannot guarantee an IndexedDB promise after
 *   the document is terminated.
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
 * Track the most recent uninstall handler per target. A repeat call to
 * `installSaveUnloadGuards(same target)` must not pile up listeners —
 * services.ts has a flow where a fresh `openProject` is issued without a
 * preceding `closeProject` (e.g. Project Browser → open new project,
 * URL deep-link into a different project). Without the swap, each
 * `install` adds another pagehide + beforeunload pair; the browser ends
 * up racing dozens of flushSave() handlers on tab close, which delays
 * the IndexedDB commit and risks the browser killing the tab before
 * the user's last edit lands. We use a regular Map (not WeakMap) so
 * tests can probe the registry with a fake target that lives in the
 * test scope; in production, `closeProject` always calls the
 * uninstall handler and the entry is removed before the Services
 * object goes out of scope.
 */
const installedByTarget = new Map<object, () => void>();

/**
 * Install unload-pagehide-beforeunload safety nets around a save pipeline.
 *
 * The default `target` is the global `window`. Tests can pass a custom
 * target to capture dispatched events without touching the real window.
 *
 * Defect A08.D1: this function is **idempotent on the same target**.
 * A second call uninstalls the previous pair first so the target
 * never accumulates listeners. The returned uninstall handler is the
 * one that cleans up the most recent pair; `closeProject` only needs
 * to call it once.
 */
export function installSaveUnloadGuards(
  options: SaveUnloadGuardsOptions,
  target: Pick<Window, "addEventListener" | "removeEventListener"> = window,
): () => void {
  // Idempotent: if a previous install on the same target is still
  // live, tear it down before wiring new listeners. This is the
  // user-data-loss safety net — without it, every Project Browser
  // swap doubles the number of flushSave() handlers racing the
  // browser's tab-termination deadline.
  const previous = installedByTarget.get(target as object);
  if (previous) previous();

  const onPageHide = (): void => {
    // pagehide is the one iOS Safari reliably fires before terminating
    // a tab. Fire-and-forget: IndexedDB may commit an already-open
    // transaction, but no browser guarantees completion after termination.
    void options.flushSave();
  };

  const onBeforeUnload = (event: Event): void => {
    // A "dirty" project means the user's last edit is in the 800 ms
    // debounce window (or the previous save errored). Start a best-effort
    // flush and show a browser warning so the user can cancel close and let
    // the write commit.
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

  const uninstall = (): void => {
    target.removeEventListener("pagehide", onPageHide);
    target.removeEventListener("beforeunload", onBeforeUnload);
    // Only clear the registry if we are still the registered uninstall
    // (a subsequent install() will have already replaced us).
    if (installedByTarget.get(target as object) === uninstall) {
      installedByTarget.delete(target as object);
    }
  };
  installedByTarget.set(target as object, uninstall);
  return uninstall;
}

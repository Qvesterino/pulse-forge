import { useEffect, useRef, type RefObject } from "react";

/**
 * Restore keyboard focus to whatever had it before an overlay opened.
 *
 * Four overlays (GenerateDialog, HelpOverlay, PaletteOverlay,
 * LatencyCalibrationWizard) focused an input on open and never gave focus
 * back on close, so a keyboard user was dropped on `document.body` and had to
 * Tab back from the top of the page. The pattern already existed and worked in
 * two places — `ContextMenu.tsx` and the TopBar overflow menu — and this
 * factors that out rather than inventing a new idea.
 *
 * ## Why the listener is permanent, and why a ref is returned
 *
 * Two orderings defeat the obvious implementations, and both were measured
 * here before being fixed:
 *
 * 1. `previous.current = document.activeElement` inside the open effect reads
 *    focus AFTER the commit, and the dialog's own input is `autoFocus` — which
 *    applies during the commit. The effect therefore records the overlay's own
 *    input as "what had focus before", and restoring it is a no-op because it
 *    is already unmounted. Result: `document.activeElement === BODY` after
 *    every close.
 * 2. Installing a `focusin` listener only while `active` is true misses the
 *    trigger for the same reason — the listener attaches after the commit, by
 *    which time focus is already inside the overlay.
 *
 * So focus is tracked **continuously**, from a listener mounted for the
 * component's whole lifetime. The trigger is captured the moment it is focused
 * (before the overlay exists), which is the only moment it is observable.
 * Elements inside the overlay are ignored, which keeps it correct for
 * `autoFocus`, for a focus trap, and for a dialog that moves focus later.
 *
 * The restore guard is the other subtle half: focus is only taken back when it
 * is **orphaned** (fell to `document.body` because the focused element
 * unmounted with the overlay). If the user tabbed or clicked into another
 * control, that control now holds focus and must be left alone — yanking it
 * back would throw them out of whatever they are using. `ContextMenu` carries
 * the same guard under the comment "Only steal focus back when the menu itself
 * still holds it".
 *
 * @param active whether the overlay is currently open
 * @returns a ref to attach to the overlay's root element; pass the element
 *   type so it satisfies the `ref` prop (`useFocusRestore<HTMLDivElement>`).
 */
export function useFocusRestore<T extends HTMLElement = HTMLElement>(active: boolean): RefObject<T> {
  const overlayRef = useRef<T>(null);
  const lastFocusedOutside = useRef<HTMLElement | null>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  // Lifetime-scoped, so the trigger is captured before the overlay opens.
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const el = event.target as HTMLElement | null;
      if (!el || el === document.body) return;
      if (overlayRef.current?.contains(el) === true) return; // inside the overlay
      lastFocusedOutside.current = el;
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);

  useEffect(() => {
    if (!active) return;
    restoreTo.current = lastFocusedOutside.current;
    return () => {
      const target = restoreTo.current;
      restoreTo.current = null;
      if (!target?.isConnected) return;
      const now = document.activeElement;
      if (now && now !== document.body) return; // the user moved it — leave it
      target.focus?.();
    };
  }, [active]);

  return overlayRef;
}

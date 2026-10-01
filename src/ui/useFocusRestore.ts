import { useEffect, useRef, type RefObject } from "react";

/**
 * Restore keyboard focus to whatever held it outside the overlay, when the
 * overlay closes.
 *
 * Four overlays (GenerateDialog, HelpOverlay, PaletteOverlay,
 * LatencyCalibrationWizard) took focus on open and never gave it back, so a
 * keyboard user was dropped on `document.body` and had to Tab back from the top
 * of the page. The pattern already worked in two places — `ContextMenu.tsx` and
 * the TopBar overflow menu — and this factors that out rather than inventing a
 * new idea. It is a plain hook, so the lazy PaletteOverlay gets it too.
 *
 * ## Why focus is tracked from a listener that lives for the whole component
 *
 * The obvious implementations both lose the trigger, and both losses were
 * measured here rather than assumed:
 *
 * 1. `previous.current = document.activeElement` inside the open effect reads
 *    focus *after* the commit — and the overlay has already taken focus by
 *    then. The effect records the overlay's own input as "what had focus
 *    before", which is unmounted by the time we would restore it. Result:
 *    `document.activeElement === BODY` after every close.
 * 2. Attaching a `focusin` listener only while `active` is true misses the
 *    same trigger, for the same reason: the listener attaches after the commit.
 *
 * So the trigger is captured continuously, by a listener mounted once for the
 * component's lifetime. That requires the component to stay mounted while the
 * overlay is closed, which is why all four call sites render unconditionally
 * and pass `open` as a prop.
 *
 * ## Why the ref cannot answer "is this focus inside the overlay?" at open time
 *
 * The overlay's `autoFocus` fires during the commit, and a `ref` prop is
 * attached *after* it. Measured in this repo's jsdom harness:
 *
 *   focusin:BUTTON            connected=true  rootInDom:false   <- the trigger
 *   focusin:INPUT             connected=true  rootInDom:true    <- autoFocus
 *   layout-effect (ref set)                                     <- ref only now
 *
 * So at the moment that matters, `overlayRef.current` is still `null` and
 * `contains()` cannot classify the event. The `open` flag is therefore read
 * from a ref written during render, which happens before any commit and is the
 * only moment at which the state is knowable in time. A ref with no root means
 * "the overlay is closed, or we are inside the commit that mounted it" — the
 * `open` ref is what tells those two apart, and the second case is ignored
 * rather than mistaken for a focus outside the overlay.
 *
 * ## The rule
 *
 * One rule covers both the ordinary case and the interesting one: on close,
 * focus goes back to the **last element focused outside the overlay**, provided
 * it is still connected and focus is currently orphaned (fell to
 * `document.body` because the focused element unmounted with the overlay).
 *
 * - Nothing outside was focused while the overlay was open, so that element is
 *   the trigger that opened it. This is the common case.
 * - The user deliberately moved focus to a control outside the overlay while it
 *   was open, so that control is where they were, and that is where focus goes.
 * - The orphan check means focus is never taken from a control that still holds
 *   it. Yanking it back would throw a keyboard user out of whatever they moved
 *   to; `ContextMenu` carries the same guard.
 *
 * ## Known boundary
 *
 * The restore hangs off the `active` transition (and on unmount while active).
 * An overlay whose DOM disappeared while `active` stayed true would not restore
 * — and that state is unreachable at every call site, since all four render
 * `if (!open) return null`, so the flag and the DOM cannot disagree. Re-check
 * this if a call site ever switches to hiding the overlay with CSS instead.
 *
 * @param active whether the overlay is currently open
 * @returns a ref to attach to the overlay's root element; pass the element
 *   type so it satisfies the `ref` prop (`useFocusRestore<HTMLDivElement>`).
 */
export function useFocusRestore<T extends HTMLElement = HTMLElement>(active: boolean): RefObject<T> {
  const overlayRef = useRef<T>(null);
  const lastOutside = useRef<HTMLElement | null>(null);
  const openRef = useRef(active);
  // Written during render on purpose: the `autoFocus` this has to classify
  // happens before any effect runs. See the ordering note above.
  openRef.current = active;

  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const el = event.target as HTMLElement | null;
      if (!el || el === document.body) return;
      const root = overlayRef.current;
      if (!root) {
        // Closed, or inside the commit that mounts the overlay. Only the
        // former is a focus outside the overlay.
        if (!openRef.current) lastOutside.current = el;
        return;
      }
      if (root.contains(el)) return; // focus is inside the overlay
      lastOutside.current = el; // overlay is open and focus moved out of it
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);

  useEffect(() => {
    if (!active) return;
    return () => {
      const target = lastOutside.current;
      if (!target?.isConnected) return;
      const now = document.activeElement;
      if (now && now !== document.body) return; // focus is not orphaned — leave it
      target.focus?.();
    };
  }, [active]);

  return overlayRef;
}

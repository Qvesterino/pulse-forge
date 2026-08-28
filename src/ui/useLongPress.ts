import { useCallback, useRef } from "react";

export interface LongPressBind {
  /** Compose with the cell's own pointer handlers. */
  onPointerDown(event: React.PointerEvent): void;
  onPointerMove(): void;
  onPointerUp(): void;
  onPointerLeave(): void;
  onPointerCancel(): void;
  /**
   * Wrap the existing onContextMenu so the synthetic menu mobile browsers
   * fire right after our long-press is swallowed (and so a browser-fired
   * menu cancels our pending timer instead of double-triggering).
   */
  wrapContextMenu(original: (event: React.MouseEvent) => void): (event: React.MouseEvent) => void;
}

/**
 * Long-press gesture for touch/pen pointers — the touch equivalent of
 * right-click. Mice are ignored (they have a real context menu). The press
 * must stay still: any move/up/leave cancels, so scrolling and drag-edits
 * never false-trigger. Fires a light haptic tick when available.
 */
export function useLongPress(fire: () => void, ms = 450): LongPressBind {
  const timer = useRef<number | null>(null);
  const fired = useRef(false);
  const fireRef = useRef(fire);
  fireRef.current = fire;

  const clear = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (event.pointerType === "mouse") return;
      clear();
      fired.current = false;
      timer.current = window.setTimeout(() => {
        timer.current = null;
        fired.current = true;
        navigator.vibrate?.(12);
        fireRef.current();
      }, ms);
    },
    [clear, ms],
  );

  const wrapContextMenu = useCallback(
    (original: (event: React.MouseEvent) => void) => (event: React.MouseEvent) => {
      if (fired.current) {
        // Our long-press already ran — swallow the synthetic follow-up menu.
        event.preventDefault();
        fired.current = false;
        return;
      }
      // The browser's own long-press menu won the race — cancel our timer
      // and let the original handler run once.
      clear();
      original(event);
    },
    [clear],
  );

  return {
    onPointerDown,
    onPointerMove: clear,
    onPointerUp: clear,
    onPointerLeave: clear,
    onPointerCancel: clear,
    wrapContextMenu,
  };
}

import { useCallback, useEffect, useRef } from "react";

/**
 * Window-level fallback that ENDS a pointer drag even when the element that
 * captured the gesture disappears mid-drag — undo/collab delete, a panel
 * switch, virtualization removing the cell. With the element gone, its own
 * pointerup/pointercancel never fire: the drag ref survives and the render
 * ghost (the half-moved clip, the velocity bar) stays stuck until the next
 * unrelated interaction overwrites it.
 *
 * While armed, `pointerup`/`pointercancel` on the window route to the CURRENT
 * end/cancel handlers through `handlers` — the owner re-assigns that ref on
 * every render, so the fallback commits with the latest drag state instead of
 * the closures captured at pointerdown (a fast drag moves the preview between
 * the two).
 *
 * Handlers must be idempotent: in the normal path the element's own pointerup
 * commits first and clears the drag ref, and the window handler fires second
 * as a no-op. Only the unmount path (and capture loss without a pointerup)
 * actually needs this.
 */
export interface DragGuardHandlers {
  /** Gesture ended (pointerup) — commit path, same as the element handler. */
  onEnd: () => void;
  /** Gesture interrupted (pointercancel / owner unmounted) — abort path. */
  onCancel: () => void;
}

export function usePointerDragGuard(): {
  /** Latest end/cancel handlers. Re-assign on every render while mounted. */
  handlers: { current: DragGuardHandlers };
  /** Attach the window listeners at gesture start. */
  arm: () => void;
  /** Detach after the gesture's own handlers ran. */
  disarm: () => void;
} {
  const handlersRef = useRef<DragGuardHandlers>({ onEnd: () => {}, onCancel: () => {} });
  const detachRef = useRef<(() => void) | null>(null);

  const detach = useCallback(() => {
    const fn = detachRef.current;
    if (fn) {
      detachRef.current = null;
      fn();
    }
  }, []);

  const arm = useCallback(() => {
    if (detachRef.current) return;
    const onUp = () => {
      detach();
      handlersRef.current.onEnd();
    };
    const onCancelEvent = () => {
      detach();
      handlersRef.current.onCancel();
    };
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancelEvent);
    detachRef.current = () => {
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancelEvent);
    };
  }, []);

  // Unmount mid-gesture: deterministic CANCEL (never commit) — the same
  // semantics as pointercancel, so no half-applied edit outlives its editor.
  useEffect(
    () => () => {
      if (detachRef.current) {
        detach();
        handlersRef.current.onCancel();
      }
    },
    [detach],
  );

  return { handlers: handlersRef, arm, disarm: detach };
}

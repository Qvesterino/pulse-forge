import { useEffect, useState } from "react";

/**
 * First-time gesture hints (discoverability pass).
 *
 * The grid's power gestures (shift+drag multi-select, vertical velocity drag,
 * right-click p-lock editor) live only in tooltips — 1000+ of them across the
 * app, which nobody reads. These one-shot toasts fire the FIRST time a user
 * actually performs each gesture, teaching the next one at the moment it
 * becomes relevant. Seen keys persist per browser profile.
 */

const SEEN_KEY = "pulse-forge.gesture-hints.v1";

const HINT_TEXT = {
  "multi-select": "Range selected — press DELETE to clear it, or drag vertically to scale its velocity.",
  "velocity-drag": "Hold ALT while dragging for microtiming, CTRL for probability.",
  "step-editor": "This editor sets p-locks — per-hit overrides on top of the pattern.",
} as const;

export type GestureHintKey = keyof typeof HINT_TEXT;

export const GESTURE_HINT_EVENT = "kyx:gesture-hint";

function seenMap(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}

/** Fire-and-forget: the toast shows the hint once, then never again. */
export function fireGestureHint(key: GestureHintKey): void {
  window.dispatchEvent(new CustomEvent(GESTURE_HINT_EVENT, { detail: { key } }));
}

/** Returns the hint text the first time a key fires, null afterwards. */
function consumeGestureHint(key: string): string | null {
  if (!(key in HINT_TEXT)) return null;
  const seen = seenMap();
  if (seen[key]) return null;
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify({ ...seen, [key]: true }));
  } catch {
    /* private mode — hint just won't persist */
  }
  return HINT_TEXT[key as GestureHintKey];
}

/** Mount once (next to CommandToast). Listens for gesture events, toasts first-time hints. */
export function GestureHintToast() {
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onHint = (event: Event) => {
      const key = (event as CustomEvent<{ key: string }>).detail?.key;
      if (!key) return;
      const text = consumeGestureHint(key);
      if (!text) return;
      setToast(text);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setToast(null), 4500);
    };
    window.addEventListener(GESTURE_HINT_EVENT, onHint);
    return () => {
      window.removeEventListener(GESTURE_HINT_EVENT, onHint);
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!toast) return null;
  return (
    <div className="onboarding" role="status">
      <span className="onboarding-text">{toast}</span>
      <button type="button" className="onboarding-skip" aria-label="Dismiss hint" onClick={() => setToast(null)}>
        ×
      </button>
    </div>
  );
}

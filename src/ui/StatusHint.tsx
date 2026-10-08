import { useEffect, useState } from "react";
import type { ReactNode } from "react";

/**
 * Statusbar live hint (ROADMAP-UI-2027, Vlna 3) — the FL hint-bar lesson:
 * the system teaches while you hover. Any element carrying `data-hint`
 * (Slider and DragNumber do) publishes its name to the statusbar; the value
 * rides along in `data-hint-value`. When nothing explainable is hovered, the
 * children render as before (the static shortcut hints stay the fallback).
 *
 * `pointerover` and `focusin` bubble, so document-level listeners serve every
 * control for both pointer and keyboard users. State writes are guarded so a
 * sweep across the page costs nothing.
 */
export function StatusHint({ fallback }: { fallback: ReactNode }) {
  const [hint, setHint] = useState<{ label: string; value: string | null } | null>(null);

  useEffect(() => {
    const updateFromTarget = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      const host = target?.closest<HTMLElement>("[data-hint]") ?? null;
      const next = host ? { label: host.dataset.hint ?? "", value: host.dataset.hintValue ?? null } : null;
      setHint((prev) => (prev?.label === next?.label && prev?.value === next?.value ? prev : next));
    };
    document.addEventListener("pointerover", updateFromTarget);
    document.addEventListener("focusin", updateFromTarget);
    return () => {
      document.removeEventListener("pointerover", updateFromTarget);
      document.removeEventListener("focusin", updateFromTarget);
    };
  }, []);

  if (!hint) return <>{fallback}</>;
  return (
    <span className="statusbar-hint" role="status" aria-live="polite" aria-atomic="true">
      <span className="statusbar-hint-label">{hint.label}</span>
      {hint.value !== null && <span className="statusbar-hint-value">{hint.value}</span>}
    </span>
  );
}

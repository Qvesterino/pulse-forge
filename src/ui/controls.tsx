import { useRef, useState } from "react";

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  format?: (value: number) => string;
  onCommit: (value: number) => void;
  /**
   * Fire-and-forget live preview while dragging (open plugin panels push the
   * value straight to the audio runtime so the knob is audible DURING the
   * drag). The document write still happens once, on commit — the preview
   * must never mutate state.
   */
  onPreview?: (value: number) => void;
  /** Restore the audio preview when an in-progress pointer gesture is cancelled. */
  onCancel?: () => void;
  /**
   * Context menu request — fired by right-click AND by a touch long-press, so
   * touch devices get the same reset/type-value menu as the mouse.
   */
  onMenu?: (x: number, y: number) => void;
  disabled?: boolean;
  compact?: boolean;
}

export function Slider({
  label,
  value,
  min,
  max,
  defaultValue,
  format,
  onCommit,
  onPreview,
  onCancel,
  onMenu,
  disabled,
  compact,
}: SliderProps) {
  const [dragValue, setDragValue] = useState<number | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  // Preview coalescing: pointermove can fire faster than frames — schedule at
  // most one preview per frame, always carrying the LATEST value.
  const previewRaf = useRef<number | null>(null);
  const menuTimer = useRef<number | null>(null);
  const menuAnchor = useRef<{ x: number; y: number } | null>(null);
  const holdFired = useRef(false);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const shown = dragValue ?? value;

  const firePreview = (v: number) => {
    if (!onPreview) return;
    if (previewRaf.current !== null) cancelAnimationFrame(previewRaf.current);
    previewRaf.current = requestAnimationFrame(() => {
      previewRaf.current = null;
      onPreview(v);
    });
  };
  const cancelPreview = () => {
    if (previewRaf.current !== null) {
      cancelAnimationFrame(previewRaf.current);
      previewRaf.current = null;
    }
  };

  const positionToValue = (clientX: number): number => {
    const track = trackRef.current;
    if (!track) return value;
    const rect = track.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return min + ratio * (max - min);
  };

  const handlePointerDown = (event: React.PointerEvent) => {
    if (disabled || event.button !== 0) return;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // no active pointer (synthetic dispatch) — drag continues without capture
    }
    const v = positionToValue(event.clientX);
    setDragValue(v);
    firePreview(v);
    // Touch/pen long-press opens the same menu as right-click (the browser
    // never produces a contextmenu from a slider drag on touch). The hold
    // aborts the drag — a release afterwards must not commit the touched
    // position as a level change.
    holdFired.current = false;
    if (onMenu && event.pointerType !== "mouse") {
      dragStart.current = { x: event.clientX, y: event.clientY };
      menuAnchor.current = { x: event.clientX, y: event.clientY };
      menuTimer.current = window.setTimeout(() => {
        menuTimer.current = null;
        holdFired.current = true;
        cancelPreview();
        setDragValue(null);
        onCancel?.();
        const anchor = menuAnchor.current;
        if (anchor) onMenu(anchor.x, anchor.y);
      }, 450);
    }
  };

  const clearMenuTimer = () => {
    if (menuTimer.current !== null) {
      window.clearTimeout(menuTimer.current);
      menuTimer.current = null;
    }
    dragStart.current = null;
    menuAnchor.current = null;
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    if (holdFired.current) return;
    if (dragValue === null) return;
    // Movement past the slop cancels the pending hold: this is a drag, not a
    // long-press.
    const start = dragStart.current;
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) clearMenuTimer();
    const v = positionToValue(event.clientX);
    setDragValue(v);
    firePreview(v);
  };

  const handlePointerUp = () => {
    if (holdFired.current) {
      holdFired.current = false;
      clearMenuTimer();
      return;
    }
    clearMenuTimer();
    if (dragValue === null) return;
    // Kill a pending preview so a stale frame can't land after the commit.
    cancelPreview();
    onCommit(dragValue);
    setDragValue(null);
  };

  // Interrupted drag (touch gesture takeover, autoscroll, …) — abort, never
  // commit; without this the slider would keep tracking hover moves and the
  // next click would commit a stale value.
  const handlePointerCancel = () => {
    clearMenuTimer();
    holdFired.current = false;
    cancelPreview();
    setDragValue(null);
    onCancel?.();
  };

  const percent = ((shown - min) / (max - min)) * 100;

  return (
    <div className={`slider${compact ? " slider-compact" : ""}${disabled ? " slider-disabled" : ""}`}>
      <div className="slider-header">
        <span className="slider-label">{label}</span>
        <span className="slider-value">{format ? format(shown) : shown.toFixed(2)}</span>
      </div>
      <div
        ref={trackRef}
        className="slider-track"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        // Arrow keys after a click need real focus — opt out of the app-wide
        // click-does-not-focus policy.
        data-allow-focus=""
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={shown}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onContextMenu={
          onMenu
            ? (event) => {
                event.preventDefault();
                onMenu(event.clientX, event.clientY);
              }
            : undefined
        }
        onDoubleClick={() => onCommit(defaultValue)}
        onKeyDown={(event) => {
          if (disabled) return;
          const step = (max - min) / 100;
          if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
            event.preventDefault();
            onCommit(Math.max(min, shown - step));
          }
          if (event.key === "ArrowRight" || event.key === "ArrowUp") {
            event.preventDefault();
            onCommit(Math.min(max, shown + step));
          }
        }}
      >
        <div className="slider-fill" style={{ width: `${percent}%` }} />
        <div className="slider-thumb" style={{ left: `${percent}%` }} />
      </div>
    </div>
  );
}

interface DragNumberProps {
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  sensitivity?: number;
  format?: (value: number) => string;
  label: string;
  /** Plain-language explanation shown in the tooltip before the gesture help. */
  hint?: string;
  onCommit: (value: number) => void;
}

export function DragNumber({
  value,
  min,
  max,
  defaultValue,
  sensitivity = 0.4,
  format,
  label,
  hint,
  onCommit,
}: DragNumberProps) {
  const [edit, setEdit] = useState<number | null>(null);
  const [typeDraft, setTypeDraft] = useState<string | null>(null);
  const startY = useRef(0);
  const startValue = useRef(0);

  const shown = edit ?? value;

  const handlePointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // no active pointer (synthetic dispatch) — drag continues without capture
    }
    startY.current = event.clientY;
    startValue.current = shown;
    setEdit(shown);
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    if (edit === null) return;
    const delta = (startY.current - event.clientY) * sensitivity;
    const raw = Math.min(max, Math.max(min, startValue.current + delta));
    setEdit(Math.round(raw * 10) / 10);
  };

  const cleanCommit = (raw: number) => onCommit(Math.min(max, Math.max(min, Math.round(raw * 10) / 10)));

  const handlePointerUp = () => {
    if (edit === null) return;
    cleanCommit(edit);
    setEdit(null);
  };

  // Interrupted drag — abort without committing (see Slider).
  const handlePointerCancel = () => setEdit(null);

  const commitTypeDraft = () => {
    if (typeDraft === null) return;
    const parsed = Number(typeDraft.replace(",", "."));
    setTypeDraft(null);
    if (Number.isFinite(parsed)) cleanCommit(parsed);
  };

  return (
    <div
      className="drag-number"
      role="spinbutton"
      tabIndex={0}
      // Arrow keys / Enter-to-type after a click need real focus — opt out of
      // the app-wide click-does-not-focus policy.
      data-allow-focus=""
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={shown}
      title={`${label}${hint ? ` — ${hint}` : ""} — drag to change, Enter to type a value, double-click to reset`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onDoubleClick={() => onCommit(defaultValue)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && typeDraft === null) {
          event.preventDefault();
          setTypeDraft(String(Math.round(shown * 100) / 100));
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          cleanCommit(shown + 1);
        }
        if (event.key === "ArrowDown") {
          event.preventDefault();
          cleanCommit(shown - 1);
        }
      }}
    >
      <span className="drag-number-label">{label}</span>
      {typeDraft !== null ? (
        <input
          className="drag-number-input"
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          value={typeDraft}
          aria-label={`${label} value`}
          onPointerDown={(event) => event.stopPropagation()}
          onPointerMove={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
          onPointerCancel={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onChange={(event) => setTypeDraft(event.target.value)}
          onBlur={commitTypeDraft}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") {
              event.preventDefault();
              commitTypeDraft();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setTypeDraft(null);
            }
          }}
        />
      ) : (
        <span className="drag-number-value">{format ? format(shown) : shown.toFixed(1)}</span>
      )}
    </div>
  );
}

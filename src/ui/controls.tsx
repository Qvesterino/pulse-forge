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
  disabled,
  compact,
}: SliderProps) {
  const [dragValue, setDragValue] = useState<number | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  // Preview coalescing: pointermove can fire faster than frames — schedule at
  // most one preview per frame, always carrying the LATEST value.
  const previewRaf = useRef<number | null>(null);
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
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    if (dragValue === null) return;
    const v = positionToValue(event.clientX);
    setDragValue(v);
    firePreview(v);
  };

  const handlePointerUp = () => {
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
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={shown}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
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

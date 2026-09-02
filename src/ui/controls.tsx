import { useRef, useState } from "react";

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  format?: (value: number) => string;
  onCommit: (value: number) => void;
  disabled?: boolean;
  compact?: boolean;
}

export function Slider({ label, value, min, max, defaultValue, format, onCommit, disabled, compact }: SliderProps) {
  const [dragValue, setDragValue] = useState<number | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const shown = dragValue ?? value;

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
    setDragValue(positionToValue(event.clientX));
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    if (dragValue === null) return;
    setDragValue(positionToValue(event.clientX));
  };

  const handlePointerUp = () => {
    if (dragValue === null) return;
    onCommit(dragValue);
    setDragValue(null);
  };

  // Interrupted drag (touch gesture takeover, autoscroll, …) — abort, never
  // commit; without this the slider would keep tracking hover moves and the
  // next click would commit a stale value.
  const handlePointerCancel = () => setDragValue(null);

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
  onCommit,
}: DragNumberProps) {
  const [edit, setEdit] = useState<number | null>(null);
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

  return (
    <div
      className="drag-number"
      role="spinbutton"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={shown}
      title={`${label} — drag to change, double-click to reset`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onDoubleClick={() => onCommit(defaultValue)}
      onKeyDown={(event) => {
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
      <span className="drag-number-value">{format ? format(shown) : shown.toFixed(1)}</span>
    </div>
  );
}

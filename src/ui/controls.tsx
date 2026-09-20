import { useEffect, useRef, useState } from "react";

/**
 * Built-in value menu shared by Slider and DragNumber: right-click (mouse) or
 * long-press (touch) opens it. "Reset to default" matches the double-click
 * behaviour; "Type value…" gives precision entry on both input kinds. A host
 * that needs a richer menu (e.g. the mixer's macro linking) can still pass
 * `onMenu` and owns the presentation itself.
 */
function ValueMenu({
  x,
  y,
  defaultValue,
  format,
  onReset,
  onType,
  onClose,
}: {
  x: number;
  y: number;
  defaultValue: number;
  format?: (value: number) => string;
  onReset: () => void;
  onType: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="context-menu value-menu"
      role="menu"
      aria-label="Value options"
      style={{
        left: Math.min(x, window.innerWidth - 200),
        top: Math.min(y, window.innerHeight - 120),
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onReset();
          onClose();
        }}
      >
        Reset to default ({format ? format(defaultValue) : defaultValue})
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onType();
          onClose();
        }}
      >
        Type value…
      </button>
    </div>
  );
}

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  format?: (value: number) => string;
  onCommit: (value: number) => void;  /**
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
  /**
   * Drag taper: "log" maps the pointer position logarithmically (Hz-domain
   * knobs). Value domain is untouched — type-in, automation and presets
   * still speak plain values; only the gesture + fill geometry change.
   */
  taper?: "linear" | "log";
}

/**
 * Slider taper math (pure — unit-tested). Linear is identity; log maps the
 * 0..1 drag ratio onto min..max geometrically (midpoint = geometric mean),
 * so a 20 Hz–20 kHz knob puts 632 Hz in the middle instead of 10 kHz.
 * Log requires min > 0 and max > min, otherwise it falls back to linear.
 */
export type SliderTaper = "linear" | "log";

export function taperToRatio(min: number, max: number, value: number, taper: SliderTaper = "linear"): number {
  if (taper !== "log" || !(min > 0) || !(max > min)) {
    return (value - min) / (max - min);
  }
  return Math.log(value / min) / Math.log(max / min);
}

export function ratioToTaper(min: number, max: number, ratio: number, taper: SliderTaper = "linear"): number {
  const r = Math.min(1, Math.max(0, ratio));
  if (taper !== "log" || !(min > 0) || !(max > min)) {
    return min + r * (max - min);
  }
  return min * Math.pow(max / min, r);
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
  taper = "linear",
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
  // Built-in fallback menu (reset + type) when the host does not provide one.
  const [builtinMenu, setBuiltinMenu] = useState<{ x: number; y: number } | null>(null);
  const [typeDraft, setTypeDraft] = useState<string | null>(null);
  const shown = dragValue ?? value;

  const openMenu = (x: number, y: number) => {
    if (onMenu) onMenu(x, y);
    else setBuiltinMenu({ x, y });
  };

  const commitTypeDraft = () => {
    if (typeDraft === null) return;
    const parsed = Number(typeDraft.replace(",", "."));
    setTypeDraft(null);
    if (Number.isFinite(parsed)) onCommit(Math.min(max, Math.max(min, parsed)));
  };

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
    return ratioToTaper(min, max, ratio, taper);
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
    // Touch/pen long-press opens the same menu as right-click. The host menu
    // wins when provided; otherwise the built-in reset/type menu opens.
    if (event.pointerType !== "mouse") {
      dragStart.current = { x: event.clientX, y: event.clientY };
      menuAnchor.current = { x: event.clientX, y: event.clientY };
      menuTimer.current = window.setTimeout(() => {
        menuTimer.current = null;
        holdFired.current = true;
        cancelPreview();
        setDragValue(null);
        onCancel?.();
        const anchor = menuAnchor.current;
        if (anchor) openMenu(anchor.x, anchor.y);
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

  const percent = Math.min(100, Math.max(0, taperToRatio(min, max, shown, taper) * 100));

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
        onContextMenu={(event) => {
          event.preventDefault();
          openMenu(event.clientX, event.clientY);
        }}
        onDoubleClick={() => onCommit(defaultValue)}
        onKeyDown={(event) => {
          if (disabled) return;
          // Keyboard steps move in ratio domain so log knobs step musically
          // (×/÷ constant factor) instead of jumping hundreds of Hz.
          const ratioStep = 0.01;
          const ratio = taperToRatio(min, max, shown, taper);
          if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
            event.preventDefault();
            onCommit(ratioToTaper(min, max, ratio - ratioStep, taper));
          }
          if (event.key === "ArrowRight" || event.key === "ArrowUp") {
            event.preventDefault();
            onCommit(ratioToTaper(min, max, ratio + ratioStep, taper));
          }
        }}
      >
        <div className="slider-fill" style={{ width: `${percent}%` }} />
        <div className="slider-thumb" style={{ left: `${percent}%` }} />
      </div>
      {builtinMenu && (
        <ValueMenu
          x={builtinMenu.x}
          y={builtinMenu.y}
          defaultValue={defaultValue}
          format={format}
          onReset={() => onCommit(defaultValue)}
          onType={() => setTypeDraft(String(Math.round(shown * 100) / 100))}
          onClose={() => setBuiltinMenu(null)}
        />
      )}
      {typeDraft !== null && (
        <div className="value-type-popover">
          <input
            className="drag-number-input"
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            value={typeDraft}
            aria-label={`${label} value`}
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
        </div>
      )}
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
  // Touch parity with the double-click reset: a long-press (no movement)
  // opens the same value menu the Slider gets.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuTimer = useRef<number | null>(null);
  const menuAnchor = useRef<{ x: number; y: number } | null>(null);
  const holdFired = useRef(false);
  const startY = useRef(0);
  const startValue = useRef(0);

  const shown = edit ?? value;

  const clearMenuTimer = () => {
    if (menuTimer.current !== null) {
      window.clearTimeout(menuTimer.current);
      menuTimer.current = null;
    }
    menuAnchor.current = null;
  };

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
    holdFired.current = false;
    if (event.pointerType !== "mouse") {
      menuAnchor.current = { x: event.clientX, y: event.clientY };
      menuTimer.current = window.setTimeout(() => {
        menuTimer.current = null;
        holdFired.current = true;
        setEdit(null);
        const anchor = menuAnchor.current;
        if (anchor) setMenu(anchor);
      }, 450);
    }
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    if (holdFired.current) return;
    if (edit === null) return;
    const anchor = menuAnchor.current;
    if (anchor && Math.abs(event.clientY - startY.current) > 6) clearMenuTimer();
    const delta = (startY.current - event.clientY) * sensitivity;
    const raw = Math.min(max, Math.max(min, startValue.current + delta));
    setEdit(Math.round(raw * 10) / 10);
  };

  const cleanCommit = (raw: number) => onCommit(Math.min(max, Math.max(min, Math.round(raw * 10) / 10)));

  const handlePointerUp = () => {
    clearMenuTimer();
    if (holdFired.current) {
      holdFired.current = false;
      return;
    }
    if (edit === null) return;
    cleanCommit(edit);
    setEdit(null);
  };

  // Interrupted drag — abort without committing (see Slider).
  const handlePointerCancel = () => {
    clearMenuTimer();
    holdFired.current = false;
    setEdit(null);
  };

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
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
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
      {menu && (
        <ValueMenu
          x={menu.x}
          y={menu.y}
          defaultValue={defaultValue}
          format={format}
          onReset={() => onCommit(defaultValue)}
          onType={() => setTypeDraft(String(Math.round(shown * 100) / 100))}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

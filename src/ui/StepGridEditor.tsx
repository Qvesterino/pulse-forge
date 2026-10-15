import { useRef, useState } from "react";
import { clamp } from "../shared/ids";

/**
 * Draggable step-sequence grid shared by the Step Modulator (ModPanel,
 * bipolar −1..1) and the Step Gate effect (EffectRack, 0..1 open amounts).
 * Drag paints values; a single onCommit fires on pointer-up so a stroke is
 * one undo step.
 */
export function StepGridEditor({
  steps,
  min = -1,
  max = 1,
  onCommit,
  ariaLabel = "Step sequence",
  height = 64,
}: {
  steps: readonly number[];
  min?: number;
  max?: number;
  onCommit: (steps: number[]) => void;
  ariaLabel?: string;
  /** Grid height in px (the dense scene-strip rows run shorter than MOD). */
  height?: number;
}) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState<number[] | null>(null);
  // Ref-authority during the stroke: pointerdown/move are CONTINUOUS events,
  // so their setState may not be flushed before a fast pointerup commits —
  // the same batching hazard the Slider documents (audit 16). The ref is
  // where the pointer is right now; state stays the render source.
  const liveRef = useRef<number[] | null>(null);
  const dragRef = useRef<{ column: number } | null>(null);
  const current = live ?? steps;
  const bipolar = min < 0;
  const range = max - min;

  const paint = (event: React.PointerEvent): void => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = clamp(event.clientX - rect.left, 0, rect.width - 0.01);
    const y = clamp(event.clientY - rect.top, 0, rect.height);
    const column = Math.min(current.length - 1, Math.floor((x / rect.width) * current.length));
    const value = Math.round((max - (y / rect.height) * range) * 100) / 100;
    dragRef.current = { column };
    // Compute eagerly: a setLive updater runs at FLUSH time, so a fast
    // pointerup in the same batch would read a null ref and drop the stroke.
    const next = [...(liveRef.current ?? steps)];
    next[column] = value;
    liveRef.current = next;
    setLive(next);
  };

  const commit = (): void => {
    const finalSteps = (liveRef.current ?? steps).slice();
    dragRef.current = null;
    liveRef.current = null;
    setLive(null);
    onCommit(finalSteps);
  };

  /** Map a value to the SVG y-coordinate inside a [0..range] viewBox (top = max, bottom = min). */
  const valueY = (value: number): number => max - value;

  return (
    <div className="mod-step-grid-wrap">
      <div
        ref={canvasRef}
        className="mod-step-grid"
        style={{ height }}
        role="slider"
        title={`${ariaLabel} — drag to paint values across the steps, click a step to set it. Values commit on release.`}
        aria-label={`${ariaLabel}, ${current.length} steps`}
        aria-valuenow={Math.round(((current.reduce((s, v) => s + v, 0) / current.length - min) / range) * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          paint(e);
        }}
        onPointerMove={(e) => {
          if (e.buttons & 1) paint(e);
        }}
        onPointerUp={commit}
        onPointerCancel={commit}
      >
        <svg viewBox={`0 0 ${current.length} ${range}`} preserveAspectRatio="none" role="img">
          {/* zero line for bipolar grids */}
          {bipolar && <line x1="0" y1={valueY(0)} x2={current.length} y2={valueY(0)} className="mod-step-grid-zero" />}
          {current.map((value, index) => {
            const yTop = valueY(Math.max(min, Math.min(max, value)));
            const zeroY = valueY(0);
            const barTop = bipolar ? Math.min(yTop, zeroY) : valueY(max);
            const barHeight = Math.max(range * 0.04, Math.abs(yTop - zeroY));
            return (
              <rect
                key={index}
                x={index + 0.12}
                y={bipolar ? barTop : yTop}
                width={0.76}
                height={bipolar ? barHeight : Math.max(range * 0.04, max - value)}
                className={dragRef.current?.column === index ? "mod-step-grid-bar active" : "mod-step-grid-bar"}
              />
            );
          })}
        </svg>
      </div>
      <div className="mod-step-grid-tools">
        {[8, 16, 32].map((length) => (
          <button
            key={length}
            type="button"
            className={`btn btn-small${current.length === length ? " active" : ""}`}
            onClick={() => {
              const resized = Array.from({ length }, (_, i) => steps[i % Math.max(1, steps.length)] ?? 0);
              onCommit(resized);
            }}
          >
            {length}
          </button>
        ))}
      </div>
    </div>
  );
}

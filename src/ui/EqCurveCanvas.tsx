import { useCallback, useEffect, useRef, useState } from "react";
import {
  EQ_CURVE_MAX_DB,
  EQ_CURVE_MIN_DB,
  eqBands,
  eqCurve,
  eqHzToX,
  eqPointToDb,
  eqXToHz,
  hitEqBand,
  type EqBand,
} from "../effects/eqCurve";

type EqCurveCanvasProps = {
  params: Record<string, number>;
  /** Commit one band's gain to the document — the same path the knobs use. */
  onCommit: (paramId: string, gainDb: number) => void;
  width?: number;
  height?: number;
};

type DragState = {
  paramId: string;
  freqHz: number;
  /** The value the pointer most recently reached. */
  gainDb: number;
  /** Where the gesture started, so the curve can jump to the pointer. */
  startDb: number;
  pointerId: number;
};

/**
 * The core EQ response, painted and draggable.
 *
 * THE DSP IS NOT REIMPLEMENTED HERE — `eqCurve` is a transcription of the
 * worklet's own arithmetic (see that file). `BiquadFilterNode` is deliberately
 * unused: this EQ uses parallel shelves and a bilinear Q correction, so a
 * BiquadFilter response would draw a curve that is close to, but not, the one
 * the track is processing.
 *
 * GESTURE CONTRACT, shared with the four knobs underneath:
 *  - Each draggable point is exactly one `primaryParamIds` gain, so a point and
 *    its knob are the same control; dragging either moves the other.
 *  - The document is written ONCE, on pointerup, never per frame. A drag that
 *    committed every move would push hundreds of undo steps for one gesture —
 *    `Slider` already settles the same way, and the engine glides the parameter
 *    between them.
 *  - While dragging, the canvas paints from a LOCAL value. The live knob below
 *    stays on the stored gain until release, which is the same preview/commit
 *    split `Slider` uses: it is a preview of a pending value, not a second
 *    source of truth.
 */
export function EqCurveCanvas({ params, onCommit, width = 236, height = 46 }: EqCurveCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Refs, not state: pointer events are the authority for WHERE the pointer is.
  // React 18 flushes `pointermove` from a Scheduler macrotask, so a fast flick
  // can run pointerup before the last move is rendered — exactly the race
  // `Slider` documents for its own dragValueRef.
  const dragRef = useRef<DragState | null>(null);
  /** Whether the current gesture actually changed the value — a plain click
   * must not write, or it pushes a no-op undo step. */
  const movedRef = useRef(false);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);

  /** The params the canvas paints: the live ones, plus the drag override. */
  const painted = useCallback(
    (active: DragState | null): Record<string, number> =>
      active ? { ...params, [active.paramId]: active.gainDb } : params,
    [params],
  );

  // ── drawing ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth || width;
      const h = canvas.clientHeight || height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const styles = getComputedStyle(canvas);
      const accent = styles.getPropertyValue("--accent").trim() || "#f0a24a";
      const gridColor = styles.getPropertyValue("--border-soft").trim() || "rgba(255,255,255,.12)";

      // 0 dB baseline plus ±12 dB guides, so the curve is read against a
      // reference and not against the frame.
      ctx.strokeStyle = gridColor;
      ctx.lineWidth = 1;
      for (const db of [0, 12, -12]) {
        const y = eqPointToDb(0, h, db);
        ctx.beginPath();
        ctx.moveTo(0, Math.round(y) + 0.5);
        ctx.lineTo(w, Math.round(y) + 0.5);
        ctx.stroke();
      }

      const points = eqCurve(painted(drag), 96);
      const yOf = (db: number) => {
        const clamped = Math.max(EQ_CURVE_MIN_DB, Math.min(EQ_CURVE_MAX_DB, db));
        return eqPointToDb(0, h, clamped);
      };
      const xOf = (hz: number) => eqHzToX(hz, w);

      ctx.beginPath();
      ctx.moveTo(0, eqPointToDb(0, h, 0));
      for (const pt of points) ctx.lineTo(xOf(pt.hz), yOf(pt.db));
      ctx.lineTo(w, eqPointToDb(0, h, 0));
      ctx.closePath();
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.16;
      ctx.fill();
      ctx.globalAlpha = 1;

      ctx.beginPath();
      points.forEach((pt, i) => {
        const x = xOf(pt.hz);
        const y = yOf(pt.db);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.6;
      ctx.lineJoin = "round";
      ctx.stroke();

      // The four grab points. A band at 0 dB has no bump to find, so its dot
      // is the only handle — it stays visible for exactly that reason.
      const activeParam = drag?.paramId ?? null;
      const hoverParam = hovered;
      for (const band of eqBands(painted(drag))) {
        const x = xOf(band.freqHz);
        const y = yOf(band.gainDb);
        const isActive = band.paramId === activeParam;
        const isHover = band.paramId === hoverParam;
        ctx.beginPath();
        ctx.arc(x, y, isActive ? 3.6 : isHover ? 3.1 : 2.4, 0, Math.PI * 2);
        ctx.fillStyle = accent;
        ctx.globalAlpha = isActive || isHover ? 1 : 0.55;
        ctx.fill();
        ctx.globalAlpha = 1;
        if (isActive) {
          ctx.strokeStyle = accent;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(x, y, 5.4, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [params, drag, hovered, width, height, painted]);

  // ── gesture ──────────────────────────────────────────────────────────────
  const toLocal = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const scaleX = (canvas.clientWidth || width) / rect.width;
    const scaleY = (canvas.clientHeight || height) / rect.height;
    return {
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top) * scaleY,
      w: (canvas.clientWidth || width) * scaleX,
      h: (canvas.clientHeight || height) * scaleY,
    };
  };

  const bandAt = (x: number, y: number, w: number, h: number, p = params): EqBand | null =>
    hitEqBand(p, eqXToHz(x, w), eqPointToDb(y, h));

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const local = toLocal(event);
    if (!local) return;
    const band = bandAt(local.x, local.y, local.w, local.h);
    if (!band) return;
    // Capture so a drag that leaves the canvas keeps tracking, and keep the
    // OTHER sliders out of it: the canvas owns the pointer until pointerup.
    event.currentTarget.setPointerCapture(event.pointerId);
    const next: DragState = {
      paramId: band.paramId,
      freqHz: band.freqHz,
      startDb: band.gainDb,
      gainDb: band.gainDb,
      pointerId: event.pointerId,
    };
    dragRef.current = next;
    setDrag(next);
    // A drag that never moves would otherwise write the value it already had,
    // pushing a no-op undo step for a plain click.
    movedRef.current = false;
    const point = eqPointToDb(local.y, local.h);
    if (Math.abs(point - band.gainDb) > 0.5) {
      movedRef.current = true;
      dragRef.current = { ...next, gainDb: point };
      setDrag(dragRef.current);
    }
    event.preventDefault();
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const local = toLocal(event);
    if (!local) return;
    const active = dragRef.current;
    if (!active || active.pointerId !== event.pointerId) {
      const band = bandAt(local.x, local.y, local.w, local.h);
      setHovered(band?.paramId ?? null);
      return;
    }
    const gainDb = Math.max(EQ_CURVE_MIN_DB, Math.min(EQ_CURVE_MAX_DB, eqPointToDb(local.y, local.h)));
    if (Math.abs(gainDb - active.gainDb) > 0.01) movedRef.current = true;
    const next = { ...active, gainDb };
    dragRef.current = next;
    setDrag(next);
    event.preventDefault();
  };

  const finishDrag = (event: React.PointerEvent<HTMLCanvasElement>, commit: boolean) => {
    const active = dragRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDrag(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    // Commit from the REF, not the render closure: the last pointermove may
    // not have flushed, so the committed value is the one the pointer reached.
    if (commit && movedRef.current) onCommit(active.paramId, active.gainDb);
    movedRef.current = false;
  };

  return (
    <canvas
      ref={canvasRef}
      className={`kit-eq-curve${drag ? " is-dragging" : ""}${hovered && !drag ? " is-hovering" : ""}`}
      style={{ width: "100%", height: `${height}px` }}
      role="application"
      aria-label="EQ response curve — drag a band to change its gain"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => finishDrag(event, true)}
      onPointerCancel={(event) => finishDrag(event, false)}
      onPointerLeave={() => setHovered(null)}
    />
  );
}
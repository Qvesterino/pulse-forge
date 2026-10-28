import { useEffect, useRef, useState } from "react";
import type { OrbitMapping } from "../project-model/types";
import type { OrbitPreset, OrbitTarget } from "../tsar/orbit";

/**
 * TSAR ORBIT — the 2-D performance surface (ADR 0074).
 *
 * This module is an INERT RENDERER: it owns no state of the project, it
 * draws what it is given and reports what the producer did. The panel is
 * the shell that owns the mapping and the position; the project model owns
 * the truth.
 *
 * The input conventions are the house ones (the Ozvena blend pad, the KOPA
 * editor), NOT a third dialect:
 *
 *  - pointer capture in a try/catch (synthetic pointers have no id);
 *  - the whole drag is bracketed by `onGestureStart`/`onGestureEnd`, so the
 *    host can collapse it into ONE undo entry;
 *  - a 2-D pad on a 1-D slider role: X is the primary aria value and
 *    `aria-valuetext` carries BOTH axes, because a screen reader cannot
 *    describe a square with one number;
 *  - arrows move X/Y, Shift is fine, PageUp/PageDown is coarse;
 *  - typed numeric fields as the fallback for a drag-only surface
 *    (exact placement, and touch precision).
 */

export interface TsarOrbitProps {
  /** The mapping — which parameter each axis drives, over which range. */
  mapping: OrbitMapping;
  /** The surface position, 0..1 per axis. */
  position: { x: number; y: number };
  /** Why an axis is silent right now (null = audible). */
  silent: { x: string | null; y: string | null };
  /** The assignable targets. */
  targets: OrbitTarget[];
  /** The mapping presets. */
  presets: OrbitPreset[];
  /** The preset the current mapping came from, when it is one of them. */
  activePresetId: string | null;
  /** Is the surface recording into the project automation? */
  recording: boolean;
  /** Is there a recording to clear? */
  hasRecording: boolean;
  /** Can the original mapping be restored (is the mapping off-default)? */
  canRestore: boolean;
  /** The surface moved. */
  onMove: (x: number, y: number) => void;
  /** A gesture began (host opens the undo frame). */
  onGestureStart: () => void;
  /** A gesture ended (host closes the undo frame, flushes the recording). */
  onGestureEnd: () => void;
  /** The X or Y axis was re-assigned to another parameter. */
  onTargetChange: (axis: "x" | "y", paramId: string) => void;
  /** A mapping preset was picked. */
  onPreset: (presetId: string) => void;
  /** Restore the original mapping. */
  onRestore: () => void;
  /** Arm / disarm the recording. */
  onRecordToggle: () => void;
  /** Remove the recorded lanes. */
  onClearRecording: () => void;
}

const SIZE = 260;

export function TsarOrbit({
  mapping,
  position,
  silent,
  targets,
  presets,
  activePresetId,
  recording,
  hasRecording,
  canRestore,
  onMove,
  onGestureStart,
  onGestureEnd,
  onTargetChange,
  onPreset,
  onRestore,
  onRecordToggle,
  onClearRecording,
}: TsarOrbitProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const draggingRef = useRef(false);
  // Typed field draft: committing on every keystroke put one history entry
  // per character, so a single Ctrl+Z snapped the field back a character.
  const [draft, setDraft] = useState<{ axis: "x" | "y"; text: string } | null>(null);

  const x = Math.min(1, Math.max(0, position.x));
  const y = Math.min(1, Math.max(0, position.y));

  // ── pad drawing ─────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const px = (vx: number) => vx * w;
    const py = (vy: number) => (1 - vy) * h;

    // The field.
    ctx.fillStyle = "rgba(255,255,255,0.03)";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "#3f3f46";
    ctx.lineWidth = dpr;
    ctx.strokeRect(0, 0, w, h);

    // The grid: the middle lines, so the handle's position is readable.
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.beginPath();
    ctx.moveTo(px(0.5), 0);
    ctx.lineTo(px(0.5), h);
    ctx.moveTo(0, py(0.5));
    ctx.lineTo(w, py(0.5));
    ctx.stroke();

    // The crosshair to the edges.
    ctx.strokeStyle = "rgba(244,244,245,0.22)";
    ctx.beginPath();
    ctx.moveTo(px(x), 0);
    ctx.lineTo(px(x), h);
    ctx.moveTo(0, py(y));
    ctx.lineTo(w, py(y));
    ctx.stroke();

    // The handle.
    ctx.beginPath();
    ctx.arc(px(x), py(y), 9 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = recording ? "#f59e0b" : "#f4f4f5";
    ctx.fill();
    ctx.strokeStyle = "#0e0f12";
    ctx.lineWidth = 2 * dpr;
    ctx.stroke();

    // The axis letters.
    ctx.font = `700 ${10 * dpr}px system-ui, sans-serif`;
    ctx.fillStyle = "#a1a1aa";
    ctx.fillText("Y", 6 * dpr, 14 * dpr);
    ctx.fillText("X", w - 14 * dpr, h - 6 * dpr);
  }, [x, y, recording]);

  // ── interaction ─────────────────────────────────────────────────────────
  const onPointer = (clientX: number, clientY: number, target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const nx = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const ny = Math.min(1, Math.max(0, 1 - (clientY - rect.top) / rect.height));
    onMove(+nx.toFixed(4), +ny.toFixed(4));
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
    let dx = 0;
    let dy = 0;
    let step = 0.05;
    if (event.key === "ArrowLeft") dx = -1;
    else if (event.key === "ArrowRight") dx = 1;
    else if (event.key === "ArrowUp") dy = 1;
    else if (event.key === "ArrowDown") dy = -1;
    else if (event.key === "PageUp") {
      dy = 1;
      step = 0.25;
    } else if (event.key === "PageDown") {
      dy = -1;
      step = 0.25;
    } else return;
    event.preventDefault();
    if (event.shiftKey && step === 0.05) step = 0.01;
    const nx = Math.min(1, Math.max(0, x + dx * step));
    const ny = Math.min(1, Math.max(0, y + dy * step));
    if (nx === x && ny === y) return;
    // One key press is one user action: bracket it so a single Ctrl+Z takes
    // back the whole step instead of one coordinate.
    onGestureStart();
    onMove(+nx.toFixed(4), +ny.toFixed(4));
    onGestureEnd();
  };

  const commitField = (axis: "x" | "y", text: string) => {
    setDraft(null);
    if (text.trim() === "") return; // a cleared field is a cancel, not 0%
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) return;
    const ratio = Math.min(1, Math.max(0, parsed / 100));
    onGestureStart();
    onMove(axis === "x" ? +ratio.toFixed(4) : x, axis === "y" ? +ratio.toFixed(4) : y);
    onGestureEnd();
  };

  const fieldProps = (axis: "x" | "y", current: number) => {
    const value = draft?.axis === axis ? draft.text : null;
    return {
      type: "number" as const,
      className: "tsar-orbit-input",
      "aria-label": `ORBIT ${axis.toUpperCase()} position percent`,
      value: value ?? String(Math.round(current * 100)),
      min: 0,
      max: 100,
      step: 1,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft({ axis, text: event.target.value }),
      onBlur: () => {
        if (value !== null) commitField(axis, value);
      },
      onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter") commitField(axis, value ?? String(Math.round(current * 100)));
        if (event.key === "Escape") setDraft(null);
      },
    };
  };

  const axisLabel = (axis: "x" | "y") => {
    const axisDef = mapping[axis];
    const target = targets.find((candidate) => candidate.id === axisDef.paramId);
    return target ? target.label : axisDef.paramId;
  };

  const valueText = `X ${axisLabel("x")} ${Math.round(x * 100)}% · Y ${axisLabel("y")} ${Math.round(y * 100)}%`;

  return (
    <div className="tsar-orbit">
      <div className="tsar-orbit-head">
        <span className="tsar-orbit-title">ORBIT</span>
        <span className="tsar-orbit-mapping">{valueText}</span>
      </div>

      <canvas
        ref={canvasRef}
        className="tsar-orbit-pad"
        width={SIZE}
        height={SIZE}
        role="slider"
        aria-label="ORBIT performance surface"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(x * 100)}
        aria-valuetext={valueText}
        tabIndex={0}
        style={{ touchAction: "none" }}
        onKeyDown={onKeyDown}
        onPointerDown={(event) => {
          draggingRef.current = true;
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            // synthetic pointers have no active id — the drag still tracks
          }
          onGestureStart();
          onPointer(event.clientX, event.clientY, event.currentTarget);
        }}
        onPointerMove={(event) => {
          if (draggingRef.current) onPointer(event.clientX, event.clientY, event.currentTarget);
        }}
        onPointerUp={() => {
          draggingRef.current = false;
          onGestureEnd();
        }}
        onPointerCancel={() => {
          draggingRef.current = false;
          onGestureEnd();
        }}
      />

      <div className="tsar-orbit-fields">
        <label className="tsar-orbit-field">
          <span className="slider-label">X</span>
          <input {...fieldProps("x", x)} />
        </label>
        <label className="tsar-orbit-field">
          <span className="slider-label">Y</span>
          <input {...fieldProps("y", y)} />
        </label>
      </div>

      <div className="tsar-orbit-targets">
        <label className="tsar-orbit-target">
          <span className="slider-label">X</span>
          <select
            className="tsar-orbit-select"
            aria-label="ORBIT X target parameter"
            value={mapping.x.paramId}
            onChange={(event) => onTargetChange("x", event.target.value)}
          >
            {targets.map((target) => (
              <option key={target.id} value={target.id}>
                {target.label}
              </option>
            ))}
          </select>
        </label>
        <label className="tsar-orbit-target">
          <span className="slider-label">Y</span>
          <select
            className="tsar-orbit-select"
            aria-label="ORBIT Y target parameter"
            value={mapping.y.paramId}
            onChange={(event) => onTargetChange("y", event.target.value)}
          >
            {targets.map((target) => (
              <option key={target.id} value={target.id}>
                {target.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {(silent.x || silent.y) && (
        <p className="tsar-orbit-note">
          {silent.x ? `X silent — ${silent.x}. ` : ""}
          {silent.y ? `Y silent — ${silent.y}.` : ""}
        </p>
      )}

      <div className="tsar-orbit-presets" role="group" aria-label="ORBIT mapping presets">
        {presets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className={`tsar-chip${activePresetId === preset.id ? " on" : ""}`}
            title={preset.hint}
            aria-pressed={activePresetId === preset.id}
            onClick={() => onPreset(preset.id)}
          >
            {preset.name}
          </button>
        ))}
      </div>

      <div className="tsar-orbit-actions">
        <button
          type="button"
          className={`tsar-chip${recording ? " on" : ""}`}
          aria-pressed={recording}
          onClick={onRecordToggle}
        >
          {recording ? "RECORDING" : "RECORD"}
        </button>
        {hasRecording && (
          <button type="button" className="tsar-chip" onClick={onClearRecording}>
            CLEAR
          </button>
        )}
        <button type="button" className="tsar-chip" disabled={!canRestore} onClick={onRestore}>
          RESTORE ORIGINAL
        </button>
      </div>
    </div>
  );
}

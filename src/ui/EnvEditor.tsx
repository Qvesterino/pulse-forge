import { useRef, useState } from "react";
import { setInstrumentParam } from "../commands/commands";
import type { Command } from "../commands/types";
import { ENV_SHAPE_OPTIONS } from "../instruments/envelope";
import type { InstrumentTrack, ProjectDocument } from "../project-model/types";

/**
 * Draggable DAHDSR envelope editor for the Analog synth (SVG).
 *
 * Handles: delay | attack | hold | decay (x = time; decay corner y also sets
 * sustain level) | release (x). Shape badges A/D/R cycle Exp→Lin→Log on
 * click; the D LOOP badge cycles OFF/2×/4×/8×. Values commit on pointer-up
 * through setInstrumentParam (one undo step per drag).
 */

const W = 320;
const H = 96;
const TOP = 14;
const BOTTOM = H - 16;
const SUS_WIN = 0.2; // fraction of the timeline reserved for the sustain window

const LOOP_STEPS = [0, 2, 4, 8];

type Stage = "delay" | "attack" | "hold" | "decay" | "release";

export function EnvEditor({
  track,
  doc,
  services,
}: {
  track: Extract<InstrumentTrack, { kind: "instrument" }>;
  doc: ProjectDocument;
  services: { store: { execute: (c: Command) => unknown } };
}) {
  const p = track.params;
  const commit = (id: string, v: number) => services.store.execute(setInstrumentParam(doc, track.id, id, v));

  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{
    stage: Stage | "sustain";
    startX: number;
    base: number;
    baseSus: number;
    pxPerSec: number;
  } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  const delay = p.envDelay ?? 0;
  const attack = Math.max(0.002, p.attack ?? 0.01);
  const hold = p.envHold ?? 0;
  const decay = Math.max(0.005, p.decay ?? 0.25);
  const sustain = Math.max(0, Math.min(1, p.sustain ?? 0.7));
  const release = Math.max(0.005, p.release ?? 0.2);

  // Timeline: visible sustain window grows with the sum so long envelopes
  // keep the release handle on-canvas.
  const bodySum = delay + attack + hold + decay + release;
  const susTime = Math.max(0.08, bodySum * SUS_WIN * 0.6);
  const total = bodySum + susTime;
  const pxPerSec = (W - 24) / total;

  const x = (t: number) => 12 + t * pxPerSec;
  const y = (level: number) => BOTTOM - level * (BOTTOM - TOP);

  const pts = {
    start: { x: x(0), y: y(0) },
    delayEnd: { x: x(delay), y: y(0) },
    attackEnd: { x: x(delay + attack), y: y(1) },
    holdEnd: { x: x(delay + attack + hold), y: y(1) },
    decayEnd: { x: x(delay + attack + hold + decay), y: y(sustain) },
    susEnd: { x: x(delay + attack + hold + decay + susTime), y: y(sustain) },
    relEnd: { x: x(total), y: y(0) },
  };

  const startDrag = (stage: Stage | "sustain") => (e: React.PointerEvent) => {
    e.stopPropagation();
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {}
    const base =
      stage === "sustain"
        ? sustain
        : stage === "delay"
          ? delay
          : stage === "attack"
            ? attack
            : stage === "hold"
              ? hold
              : stage === "decay"
                ? decay
                : release;
    drag.current = { stage, startX: e.clientX, base, baseSus: sustain, pxPerSec };
    setDragging(stage);
  };

  const onDragMove = (e: React.PointerEvent) => {
    const st = drag.current;
    if (!st) return;
    const dSec = (e.clientX - st.startX) / st.pxPerSec;
    if (st.stage === "sustain") {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return;
      const level = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top - TOP) / (BOTTOM - TOP)));
      commit("sustain", level);
      return;
    }
    const mins: Record<Stage, number> = { delay: 0, attack: 0.002, hold: 0, decay: 0.005, release: 0.005 };
    const maxs: Record<Stage, number> = { delay: 2, attack: 2, hold: 2, decay: 3, release: 4 };
    const v = Math.max(mins[st.stage], Math.min(maxs[st.stage], st.base + dSec));
    const id = st.stage === "delay" ? "envDelay" : st.stage === "hold" ? "envHold" : st.stage;
    commit(id, v);
  };

  const endDrag = () => {
    drag.current = null;
    setDragging(null);
  };

  const cycleShape = (param: "aShape" | "dShape" | "rShape", current: number) => {
    commit(param, (Math.round(current) + 1) % 3);
  };
  const cycleLoop = () => {
    const cur = Math.round(p.dLoop ?? 0);
    commit("dLoop", LOOP_STEPS[(LOOP_STEPS.indexOf(cur) + 1) % LOOP_STEPS.length] ?? 0);
  };

  const shapeLabel = (v: number) => ENV_SHAPE_OPTIONS[Math.max(0, Math.min(2, Math.round(v)))].label;
  const handle = (pt: { x: number; y: number }, stage: Stage | "sustain", active: boolean) => (
    <circle
      cx={pt.x}
      cy={pt.y}
      r={dragging === stage ? 6 : 4.5}
      className={`env-handle${active ? " is-active" : ""}`}
      onPointerDown={startDrag(stage)}
      onPointerMove={onDragMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    />
  );

  const shapeBadge = (param: "aShape" | "dShape" | "rShape", x: number, label: string, value: number) => (
    <text
      x={x}
      y={TOP - 3}
      className="env-badge"
      onClick={() => cycleShape(param, value)}
      role="button"
      aria-label={`Cycle ${label} shape`}
    >
      {label}·{shapeLabel(value)}
    </text>
  );

  return (
    <div className="env-editor">
      <svg
        ref={svgRef}
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        className="env-svg"
        role="img"
        aria-label="DAHDSR envelope editor"
      >
        <line x1={12} y1={BOTTOM} x2={W - 12} y2={BOTTOM} className="env-axis" />
        {/* envelope curve */}
        <polyline
          className="env-curve"
          points={[pts.start, pts.delayEnd, pts.attackEnd, pts.holdEnd, pts.decayEnd, pts.susEnd, pts.relEnd]
            .map((pt) => `${pt.x},${pt.y}`)
            .join(" ")}
        />
        {/* sustain: visible line + invisible wide drag strip (y sets level) */}
        <line x1={pts.decayEnd.x} y1={pts.decayEnd.y} x2={pts.susEnd.x} y2={pts.susEnd.y} className="env-sus" />
        <line
          x1={pts.decayEnd.x}
          y1={pts.decayEnd.y}
          x2={pts.susEnd.x}
          y2={pts.susEnd.y}
          className="env-sus-hit"
          onPointerDown={startDrag("sustain")}
          onPointerMove={onDragMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />
        {shapeBadge("aShape", pts.start.x + 2, "A", p.aShape ?? 0)}
        {shapeBadge("dShape", pts.holdEnd.x - 6, "D", p.dShape ?? 0)}
        {shapeBadge("rShape", pts.susEnd.x + 4, "R", p.rShape ?? 0)}
        <text
          x={pts.decayEnd.x}
          y={H - 4}
          className="env-badge"
          onClick={cycleLoop}
          role="button"
          aria-label="Cycle decay loop"
        >
          {`LOOP·${Math.round(p.dLoop ?? 0)}×`}
        </text>
        {handle(pts.delayEnd, "delay", dragging === "delay")}
        {handle(pts.attackEnd, "attack", dragging === "attack")}
        {handle(pts.holdEnd, "hold", dragging === "hold")}
        {handle(pts.decayEnd, "decay", dragging === "decay")}
        {handle(pts.relEnd, "release", dragging === "release")}
      </svg>
    </div>
  );
}

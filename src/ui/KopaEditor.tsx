import { useCallback, useEffect, useRef, useState } from "react";
import { setInstrumentParams } from "../commands/instrument";
import type { Command } from "../commands/types";
import { defaultInstrumentParams } from "../instruments/definitions";
import type { InstrumentTrack, ProjectDocument } from "../project-model/types";
import {
  KOPA_TIME_MAX_MS,
  KOPA_TIME_MIN_MS,
  kopaLanes,
  kopaLayerEnvelope,
  kopaPitchEnvelope,
  kopaTimeMs,
  kopaTimeNorm,
} from "../kopa/layerModel";

/**
 * KOPA EDITOR — the kick's shape as a graphic (roadmap wave 2).
 *
 * KOPA had 35 parameters and no picture of them: a user could set a tail
 * decay but never SEE how long the tail is next to the click, and never see
 * that the sub rides the body's envelope. This editor is the graphic that
 * was missing — one time axis, the layers separated, the pitch envelope
 * drawn over them.
 *
 * THE RULES IT KEEPS:
 *
 *  - It edits EXISTING parameters only. The graphic is a clearer control of
 *    the DSP that is already there, not a reason to invent knobs (roadmap
 *    wave 2, "vychádzať najprv z existujúcich parametrov").
 *  - The picture is the DSP's picture. The layer envelopes and the pitch
 *    envelope come from `src/kopa/layerModel.ts`, which mirrors the
 *    processor's own formulas — so what the graphic shows is what the kick
 *    does, not an artist's impression of it.
 *  - A drag is ONE undo step. The drag paints locally and writes the
 *    document ONCE, on pointer-up (the EnvEditor commits per pointer-move,
 *    which is why it is not the precedent here).
 *  - The preview never touches the project: it plays a temporary runtime
 *    built from the draft values, through the same factory and the same
 *    normalization the live chain uses.
 *  - Every handle is a real slider: focusable, arrow-key driven, and
 *    announced with its value — the editor stays usable in a narrow panel
 *    and without a mouse.
 */

const W = 560;
const LEFT = 48;
const RIGHT = 10;
const PITCH_H = 48;
const LANE_H = 24;
const AXIS_H = 20;

const LANE_IDS = ["click", "body", "sub", "tail", "harm"] as const;
const H = PITCH_H + LANE_IDS.length * LANE_H + AXIS_H;
const PLOT_W = W - LEFT - RIGHT;

/** The audition note — C2, the same note the old PREVIEW C2 button used. */
const PREVIEW_PITCH = 36;

/** How often a drag may re-trigger the audition (a machine-gun is not a preview). */
const AUDITION_THROTTLE_MS = 160;

type HandleKind = "length" | "level";
type HandleUnit = "ms" | "s" | "ratio" | "st";

interface HandleSpec {
  /** The parameter this handle writes. */
  id: string;
  kind: HandleKind;
  /** The lane the handle lives in ("pitch" or a layer id). */
  lane: string;
  label: string;
  min: number;
  max: number;
  unit: HandleUnit;
}

/**
 * The draggable handles — one per parameter the graphic owns.
 *
 * The BODY has no level handle (the DSP fixes the body's mix gain) and the
 * SUB has no length handle (it rides the body/tail envelope), so the graphic
 * does not pretend otherwise.
 */
const HANDLES: HandleSpec[] = [
  { id: "pitchAmount", kind: "level", lane: "pitch", label: "PITCH AMOUNT", min: 0, max: 48, unit: "st" },
  { id: "pitchTime", kind: "length", lane: "pitch", label: "PITCH TIME", min: 5, max: 200, unit: "ms" },
  { id: "clickDecay", kind: "length", lane: "click", label: "CLICK DECAY", min: 0.2, max: 20, unit: "ms" },
  { id: "clickLevel", kind: "level", lane: "click", label: "CLICK LEVEL", min: 0, max: 1, unit: "ratio" },
  { id: "bodyDecay", kind: "length", lane: "body", label: "BODY DECAY", min: 0.03, max: 2, unit: "s" },
  { id: "subLevel", kind: "level", lane: "sub", label: "SUB LEVEL", min: 0, max: 1, unit: "ratio" },
  { id: "tailDecay", kind: "length", lane: "tail", label: "TAIL DECAY", min: 0.05, max: 3, unit: "s" },
  { id: "tailLevel", kind: "level", lane: "tail", label: "TAIL LEVEL", min: 0, max: 1, unit: "ratio" },
  { id: "harmonicDecay", kind: "length", lane: "harm", label: "HARM DECAY", min: 0.03, max: 2, unit: "s" },
  { id: "harmonicLevel", kind: "level", lane: "harm", label: "HARM LEVEL", min: 0, max: 1, unit: "ratio" },
];

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** The x of a time in ms on the log axis. */
function xAt(ms: number): number {
  return LEFT + kopaTimeNorm(ms) * PLOT_W;
}

/** The time in ms under an x on the log axis. */
function msAt(x: number): number {
  return kopaTimeMs((x - LEFT) / PLOT_W);
}

/** The vertical band of a lane: its top and the height the envelope uses. */
function laneBand(lane: string): { top: number; height: number } {
  if (lane === "pitch") return { top: 2, height: PITCH_H - 12 };
  const index = LANE_IDS.indexOf(lane as (typeof LANE_IDS)[number]);
  const top = PITCH_H + Math.max(0, index) * LANE_H;
  return { top, height: LANE_H - 8 };
}

/** The drawn envelope of a layer — the DSP's own decay curve. */
function layerPath(decaySec: number, level: number, top: number, height: number): string {
  const baseline = top + height;
  const steps = 26;
  let d = `M ${xAt(KOPA_TIME_MIN_MS)} ${baseline}`;
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * decaySec;
    const y = baseline - level * kopaLayerEnvelope(t, decaySec) * height;
    d += ` L ${xAt(Math.max(KOPA_TIME_MIN_MS, t * 1000))} ${y}`;
  }
  d += ` L ${xAt(decaySec * 1000)} ${baseline} Z`;
  return d;
}

function formatValue(spec: HandleSpec, value: number): string {
  if (spec.unit === "st") return `${value.toFixed(0)} st`;
  if (spec.unit === "ratio") return `${Math.round(value * 100)} %`;
  if (spec.unit === "ms") return `${value < 10 ? value.toFixed(1) : value.toFixed(0)} ms`;
  return `${value < 1 ? value.toFixed(2) : value.toFixed(2)} s`;
}

export function KopaEditor({
  track,
  doc,
  services,
}: {
  track: Extract<InstrumentTrack, { kind: "instrument" }>;
  doc: ProjectDocument;
  services: {
    store: { execute: (c: Command) => unknown };
    engine?: {
      previewInstrumentWithParams?: (trackId: string, pitch: number, overrides: Record<string, number>) => void;
    };
  };
}) {
  const [draft, setDraft] = useState<Record<string, number> | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragId = useRef<string | null>(null);
  const draftRef = useRef<Record<string, number> | null>(null);
  const lastAudition = useRef(0);

  const saved = track.params;
  const params = draft ?? saved;
  const defaults = defaultInstrumentParams(track.instrument);

  // A different track means a different kick: the draft belongs to the old
  // one and must not leak into the new one.
  useEffect(() => {
    setDraft(null);
    draftRef.current = null;
    dragId.current = null;
  }, [track.id]);

  const valueOf = useCallback((id: string): number => params[id] ?? defaults[id] ?? 0, [params, defaults]);

  const commit = useCallback(
    (changes: Record<string, number>) => {
      const diff: Record<string, number> = {};
      for (const [key, value] of Object.entries(changes)) {
        const before = saved[key] ?? defaults[key] ?? value;
        if (Math.abs(value - before) > 1e-9) diff[key] = value;
      }
      if (Object.keys(diff).length === 0) return;
      services.store.execute(setInstrumentParams(doc, track.id, diff, "KOPA shape"));
    },
    [saved, defaults, services, doc, track.id],
  );

  const audition = useCallback(
    (overrides: Record<string, number>) => {
      services.engine?.previewInstrumentWithParams?.(track.id, PREVIEW_PITCH, overrides);
    },
    [services, track.id],
  );

  const auditionThrottled = useCallback(() => {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (now - lastAudition.current < AUDITION_THROTTLE_MS) return;
    lastAudition.current = now;
    audition(draftRef.current ?? {});
  }, [audition]);

  // --- pointer drag ------------------------------------------------------
  const handlePointerDown = (spec: HandleSpec) => (event: React.PointerEvent<SVGGElement>) => {
    event.stopPropagation();
    try {
      (event.currentTarget as Element).setPointerCapture(event.pointerId);
    } catch {
      /* capture is a nicety, the document-level handlers still work */
    }
    dragId.current = spec.id;
    const base = { ...saved };
    draftRef.current = base;
    setDraft(base);
  };

  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const spec = HANDLES.find((candidate) => candidate.id === dragId.current);
    const rect = svgRef.current?.getBoundingClientRect();
    if (!spec || !rect) return;
    // The pointer speaks CSS pixels; the graphic speaks VIEWBOX units. The
    // SVG scales to the panel's width, so the two differ by the scale — and
    // without this the handle would land somewhere else than the pointer.
    const scaleX = rect.width > 0 ? rect.width / W : 1;
    const scaleY = rect.height > 0 ? rect.height / H : 1;
    const px = (event.clientX - rect.left) / scaleX;
    const py = (event.clientY - rect.top) / scaleY;
    let next: number;
    if (spec.kind === "length") {
      const ms = msAt(px);
      next = spec.unit === "ms" ? ms : ms / 1000;
    } else {
      const band = laneBand(spec.lane);
      const ratio = clamp((band.top + band.height - py) / band.height, 0, 1);
      next = spec.unit === "st" ? ratio * spec.max : ratio;
    }
    next = clamp(next, spec.min, spec.max);
    const current = draftRef.current ?? { ...saved };
    const nextDraft = { ...current, [spec.id]: next };
    draftRef.current = nextDraft;
    setDraft(nextDraft);
    auditionThrottled();
  };

  const handlePointerUp = () => {
    const spec = HANDLES.find((candidate) => candidate.id === dragId.current);
    dragId.current = null;
    const current = draftRef.current;
    draftRef.current = null;
    setDraft(null);
    if (!spec || !current) return;
    commit(current);
  };

  // --- keyboard ----------------------------------------------------------
  const handleKeyDown = (spec: HandleSpec) => (event: React.KeyboardEvent<SVGGElement>) => {
    const base = valueOf(spec.id);
    let next: number | null = null;
    if (spec.kind === "length") {
      if (event.key === "ArrowRight") next = base * 1.12;
      else if (event.key === "ArrowLeft") next = base / 1.12;
    } else {
      const step = (spec.unit === "st" ? 1 : 0.05) * (event.shiftKey ? 5 : 1);
      if (event.key === "ArrowUp") next = base + step;
      else if (event.key === "ArrowDown") next = base - step;
    }
    if (next === null) return;
    event.preventDefault();
    const clamped = clamp(next, spec.min, spec.max);
    commit({ [spec.id]: clamped });
    // Audition the value the user just asked for, not the stored one: the
    // document update lands on the next render.
    audition({ ...saved, [spec.id]: clamped });
  };

  // --- drawing ------------------------------------------------------------
  const lanes = kopaLanes(params);
  const pitchPoints = kopaPitchEnvelope(params);
  const pitchBand = laneBand("pitch");

  const handlePosition = (spec: HandleSpec): { x: number; y: number } => {
    const band = laneBand(spec.lane);
    if (spec.kind === "length") {
      const lengthMs =
        spec.id === "pitchTime"
          ? valueOf("pitchTime")
          : spec.id === "clickDecay"
            ? valueOf("clickDecay")
            : valueOf(spec.id) * 1000;
      return { x: xAt(lengthMs), y: band.top + band.height / 2 };
    }
    const value = valueOf(spec.id);
    if (spec.unit === "st") {
      return { x: LEFT + 7, y: band.top + band.height - (value / spec.max) * band.height };
    }
    return { x: LEFT + 7, y: band.top + band.height - value * band.height };
  };

  const axisTicks = [1, 10, 100, 1000, KOPA_TIME_MAX_MS];

  return (
    <section className="kopa-editor" aria-label="KOPA kick shape">
      <svg
        ref={svgRef}
        className="kopa-editor-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="group"
        aria-label="KOPA layers and pitch envelope"
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {/* the time axis */}
        {axisTicks.map((ms) => (
          <g key={`tick-${ms}`}>
            <line
              x1={xAt(ms)}
              x2={xAt(ms)}
              y1={PITCH_H}
              y2={PITCH_H + LANE_IDS.length * LANE_H}
              className="kopa-grid"
            />
            <text x={xAt(ms)} y={H - 6} className="kopa-axis-label">
              {ms < 1000 ? `${ms}ms` : `${ms / 1000}s`}
            </text>
          </g>
        ))}

        {/* the pitch lane */}
        <text x={4} y={pitchBand.top + 9} className="kopa-lane-label">
          PITCH
        </text>
        <line
          x1={LEFT}
          x2={W - RIGHT}
          y1={pitchBand.top + pitchBand.height}
          y2={pitchBand.top + pitchBand.height}
          className="kopa-baseline"
        />
        <path
          d={
            pitchPoints
              .map((point, index) => {
                const y = pitchBand.top + pitchBand.height - (point.semitones / 48) * pitchBand.height;
                return `${index === 0 ? "M" : "L"} ${xAt(Math.max(KOPA_TIME_MIN_MS, point.timeSec * 1000))} ${y}`;
              })
              .join(" ") +
            ` L ${xAt(Math.max(KOPA_TIME_MIN_MS, valueOf("pitchTime")))} ${pitchBand.top + pitchBand.height}`
          }
          className="kopa-pitch-curve"
        />

        {/* the layer lanes */}
        {lanes.map((lane) => {
          const band = laneBand(lane.id);
          return (
            <g key={lane.id}>
              <text x={4} y={band.top + band.height - 1} className="kopa-lane-label">
                {lane.label}
              </text>
              <line
                x1={LEFT}
                x2={W - RIGHT}
                y1={band.top + band.height}
                y2={band.top + band.height}
                className="kopa-baseline"
              />
              <path
                d={layerPath(lane.decaySec, lane.level, band.top, band.height)}
                className={`kopa-layer kopa-${lane.id}`}
              />
              {lane.followsLength && (
                <text x={W - RIGHT - 4} y={band.top + 9} className="kopa-lane-note">
                  rides {lane.followsLength}
                </text>
              )}
            </g>
          );
        })}

        {/* the handles */}
        {HANDLES.map((spec) => {
          const position = handlePosition(spec);
          return (
            <g
              key={spec.id}
              data-handle={spec.id}
              className="kopa-handle"
              tabIndex={0}
              role="slider"
              aria-label={spec.label}
              aria-valuemin={spec.min}
              aria-valuemax={spec.max}
              aria-valuenow={Number(valueOf(spec.id).toFixed(4))}
              aria-valuetext={formatValue(spec, valueOf(spec.id))}
              onPointerDown={handlePointerDown(spec)}
              onKeyDown={handleKeyDown(spec)}
            >
              <rect x={position.x - 5} y={position.y - 5} width={10} height={10} rx={2} />
              <title>{`${spec.label}: ${formatValue(spec, valueOf(spec.id))}`}</title>
            </g>
          );
        })}
      </svg>

      <div className="kopa-editor-row">
        <div className="kopa-ab" role="group" aria-label="Audition the kick">
          <button
            type="button"
            className="btn btn-small"
            onClick={() => audition({})}
            title="Audition the saved kick at C2 — the document is not touched."
          >
            A · SAVED
          </button>
          <button
            type="button"
            className="btn btn-small"
            disabled={!draft}
            onClick={() => audition(draft ?? {})}
            title="Audition the edited shape at C2 — the document is not touched."
          >
            B · EDIT
          </button>
        </div>
        <span className="kopa-editor-state">{draft ? "EDITED — drag to shape, release to apply" : "SAVED"}</span>
      </div>

      <details className="kopa-notes">
        <summary>How the picture maps to the sound</summary>
        <ul>
          <li>
            The axis is <b>logarithmic</b>: a 3 ms click and a 400 ms tail share one timeline.
          </li>
          <li>
            A lane&apos;s width is its <b>decay</b> — the time the layer takes to reach ~5 %. The sub has no width of
            its own: it rides the longer of the body and the tail.
          </li>
          <li>
            The body has no height handle: the DSP fixes its mix gain. The drawn heights are the stored levels, and the
            fixed gains (click 1.0, body 0.9, sub 0.5, tail 0.9, harmonics 0.55) live in the DSP.
          </li>
          <li>
            The pitch curve is the DSP&apos;s own envelope — the amount sets the start pitch, the time sets how fast it
            falls, and the curve shape stays the parameter it is.
          </li>
          <li>
            A drag writes the document <b>once</b>, as one undo step. The audition never touches the document.
          </li>
        </ul>
      </details>
    </section>
  );
}

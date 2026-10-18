import type { AutomationLane, AutomationPoint } from "./types";

export function valueAt(points: AutomationPoint[], tick: number, fallback = 0): number {
  if (points.length === 0) return fallback;
  if (tick <= points[0].tick) return points[0].value;
  const last = points[points.length - 1];
  if (tick >= last.tick) return last.value;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (tick <= b.tick) {
      const span = b.tick - a.tick;
      if (span <= 0) return b.value;
      const t = (tick - a.tick) / span;
      return a.value + (b.value - a.value) * t;
    }
  }
  return last.value;
}

export function insertPointSorted(points: AutomationPoint[], point: AutomationPoint): AutomationPoint[] {
  const next = [...points, point];
  next.sort((a, b) => a.tick - b.tick);
  return next;
}

/** Grid stride for ramp interpolation: a 16th note (PPQ = 480). */
export const AUTOMATION_RAMP_GRID_TICKS = 120;
/** Hard cap of emitted events per lane scheduling pass (port queues stay bounded). */
export const AUTOMATION_RAMP_MAX_EVENTS = 256;

/**
 * Expand sparse lane points into a 16th-note-grid ramp so a lane renders as
 * the straight lines its editor draws (the writers apply point events; a
 * sparse two-point lane would otherwise hold its start value and step at the
 * end). Constant lanes short-circuit — identical events carry no information.
 * The stride doubles adaptively when the grid would overflow the event cap,
 * so arbitrarily long lanes degrade to coarser-but-still-ramped curves.
 * Discrete parameters (toggles/enums) must NOT be routed through this —
 * call sites decide.
 *
 * WHAT THE CAP BOUNDS (audit 16 D2). The cap exists to keep AudioParam port
 * queues bounded by the GENERATED ramp grid — two points across 2000 bars must
 * not emit 8000 events. It is not a licence to discard the author's own
 * points. Decimating the merged list did exactly that: a 300-point lane was
 * decimated to 151 events, so 149 user points never reached the DSP and the
 * curve diverged from the lane editor by up to 50 % of the parameter range.
 * The budget therefore applies to generated samples only; authored points are
 * signal and always survive. A lane whose authored points alone exceed the cap
 * emits exactly those points and no ramp — degraded resolution is an honest
 * answer, silently-dropped automation is not.
 */
export function interpolateAutomationPoints(
  points: AutomationPoint[],
  gridTicks = AUTOMATION_RAMP_GRID_TICKS,
  maxEvents = AUTOMATION_RAMP_MAX_EVENTS,
): AutomationPoint[] {
  if (points.length < 2) return points;
  const first = points[0].value;
  const allConstant = points.every((p) => p.value === first);
  if (allConstant) return points;

  const span = Math.max(1, points[points.length - 1].tick - points[0].tick);
  let stride = Math.max(1, Math.round(gridTicks));
  // Spend the cap on generated samples; the author's points are already paid for.
  const interiorBudget = Math.max(0, maxEvents - points.length);
  while (span / stride > interiorBudget && stride < span) stride *= 2;

  const out: AutomationPoint[] = [{ tick: points[0].tick, value: points[0].value }];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const segTicks = b.tick - a.tick;
    if (segTicks > stride) {
      const steps = Math.floor(segTicks / stride);
      for (let s = 1; s <= steps; s++) {
        const tick = a.tick + s * stride;
        if (tick >= b.tick) break;
        out.push({ tick, value: valueAt(points, tick) });
      }
    }
    out.push({ tick: b.tick, value: b.value });
  }
  return out;
}

export function laneLabel(lane: AutomationLane, trackName: string, fxName?: string): string {
  switch (lane.target.kind) {
    case "trackGain":
      return `${trackName} · Volume`;
    case "trackPan":
      return `${trackName} · Pan`;
    case "fxParam":
      return `${trackName} · ${fxName ?? "FX"} · ${lane.target.paramId}`;
    case "instParam":
      return `${trackName} · ${lane.target.paramId}`;
  }
}

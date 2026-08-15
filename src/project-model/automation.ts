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

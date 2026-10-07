import { BAR_TICKS } from "../project-model/types";

/**
 * TIMELINE SNAP (arrangement surface).
 *
 * Snap is VIEW-layer policy, not project state: nothing about the grid is
 * stored in the document (a shared/collab peer with a different grid sees the
 * same clips), it persists per-browser like the mixer's meter-point toggle.
 *
 * Scope: audio-clip drag/resize/trim/stretch (the free-position lane), the
 * take-lane comp range, ruler/lane time ranges and marker placement. Scene
 * clips are NOT snapped — the arrangement-clip system is whole-bar by
 * contract (no-overlap, integer bars), which already IS a snap of 1 bar.
 *
 * Precision contract: every grid is a whole number of ticks
 * (1/16 bar = 120 ticks), and the audio-clip commands quantize stored bar
 * geometry to ticks, so a snapped position survives the round-trip EXACTLY.
 * (The old 0.01-bar storage round collapsed 1/8 and 1/16 positions —
 * 0.125 → 0.13, 0.0625 → 0.06 — which is why snap needs tick quantize.)
 *
 * Modifier contract: holding Shift SUSPENDS the grid during a drag (the
 * common DAW convention). Sites where Shift is already the feature key
 * (ruler Shift+click = add marker) do not treat it as suspend — the snap
 * applies there regardless.
 */

export interface SnapGrid {
  id: string;
  /** Toolbar label (musical, relative to 4/4). */
  label: string;
  /** Grid size in bars — exact binary fraction, tick-clean. */
  bars: number;
}

export const SNAP_GRIDS: readonly SnapGrid[] = [
  { id: "1", label: "1", bars: 1 },
  { id: "1/2", label: "1/2", bars: 0.5 },
  { id: "1/4", label: "1/4", bars: 0.25 },
  { id: "1/8", label: "1/8", bars: 0.125 },
  { id: "1/16", label: "1/16", bars: 0.0625 },
] as const;

export type SnapGridId = "off" | "1" | "1/2" | "1/4" | "1/8" | "1/16";

const VALID_IDS: ReadonlySet<string> = new Set(["off", ...SNAP_GRIDS.map((g) => g.id)]);

/** Bars for a grid id — `null` = snap off / unknown id (free positioning). */
export function snapBarsFor(id: SnapGridId): number | null {
  return SNAP_GRIDS.find((g) => g.id === id)?.bars ?? null;
}

/**
 * Snap an absolute bar position to the nearest grid line (half rounds up,
 * the intuitive direction for "pull to the next beat"). No clamp here —
 * callers own their own ≥ 0 floors.
 */
export function snapBar(bar: number, bars: number | null): number {
  if (bars === null || !(bars > 0) || !Number.isFinite(bar)) return bar;
  return Math.round(bar / bars) * bars;
}

/**
 * Snap a drag DELTA (block moves): every clip shifts by a grid multiple, so
 * the block's internal spacing survives — independent absolute snapping would
 * collapse offsets that sit between grid lines.
 */
export function snapDelta(delta: number, bars: number | null): number {
  return snapBar(delta, bars);
}

/** Snap a tick value (ranges, markers) — grid in whole ticks. */
export function snapTick(tick: number, bars: number | null): number {
  if (bars === null || !(bars > 0) || !Number.isFinite(tick)) return tick;
  const gridTicks = bars * BAR_TICKS;
  return Math.round(tick / gridTicks) * gridTicks;
}

/* ---------------- persistence (view preference) ---------------- */

export const SNAP_STORAGE_KEY = "pf:arr-snap";

export function loadSnapGrid(): SnapGridId {
  try {
    const raw = localStorage.getItem(SNAP_STORAGE_KEY);
    return typeof raw === "string" && VALID_IDS.has(raw) ? (raw as SnapGridId) : "off";
  } catch {
    return "off";
  }
}

export function storeSnapGrid(id: SnapGridId): void {
  try {
    localStorage.setItem(SNAP_STORAGE_KEY, id);
  } catch {
    /* storage unavailable — snap still works for the session */
  }
}

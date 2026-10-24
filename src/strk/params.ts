import type { ParamDef } from "../effects/types";

const pct = (v: number) => `${Math.round(v * 100)}%`;
const sec = (v: number) => `${v.toFixed(2)} s`;
const hz = (v: number) => `${(v / 1000).toFixed(1)} kHz`;

/**
 * ŠTRK parameters (ADR 0060) — the snare designer's four layers: SNAP
 * (click), BODY (pitched thump), WIRES (bandpassed noise), SNAPPY (wire
 * coupling to the body envelope). GATE switches one-shot/gate trigger.
 */
export const strkParams: ParamDef[] = [
  {
    id: "gate",
    label: "MODE",
    min: 0,
    max: 1,
    default: 0,
    kind: "toggle",
    format: (v) => (v >= 0.5 ? "GATE" : "ONE-SHOT"),
  },
  {
    id: "tune",
    label: "TUNE",
    min: -12,
    max: 12,
    default: 0,
    unit: "st",
    format: (v) => `${v > 0 ? "+" : ""}${v.toFixed(0)} st`,
  },
  { id: "snapLevel", label: "SNAP LVL", min: 0, max: 1, default: 0.5, format: pct },
  {
    id: "snapDecay",
    label: "SNAP DEC",
    min: 0.001,
    max: 0.05,
    default: 0.006,
    unit: "s",
    format: (v) => `${(v * 1000).toFixed(1)} ms`,
    taper: "log",
  },
  { id: "bodyLevel", label: "BODY LVL", min: 0, max: 1, default: 0.5, format: pct },
  { id: "bodyDecay", label: "BODY DEC", min: 0.02, max: 1.2, default: 0.12, unit: "s", format: sec, taper: "log" },
  { id: "bodyTone", label: "BODY TONE", min: 0, max: 1, default: 0.2, format: (v) => (v >= 0.5 ? "SINE" : "SQUARE") },
  { id: "wireLevel", label: "WIRE LVL", min: 0, max: 1, default: 0.6, format: pct },
  { id: "wireTone", label: "WIRE TONE", min: 1500, max: 8000, default: 3500, unit: "Hz", format: hz, taper: "log" },
  { id: "wireDecay", label: "WIRE DEC", min: 0.02, max: 1, default: 0.18, unit: "s", format: sec, taper: "log" },
  { id: "snappy", label: "SNAPPY", min: 0, max: 1, default: 0.6, format: pct },
  { id: "drive", label: "DRIVE", min: 0, max: 1, default: 0.2, format: pct },
  { id: "level", label: "LEVEL", min: 0, max: 1.5, default: 0.8, format: pct },
];

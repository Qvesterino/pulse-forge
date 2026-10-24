import type { ParamDef } from "../effects/types";

const pct = (v: number) => `${Math.round(v * 100)}%`;
const sec = (v: number) => `${v.toFixed(2)} s`;
const hz = (v: number) => `${(v / 1000).toFixed(1)} kHz`;

/**
 * CINK parameters (ADR 0060) — the hi-hat designer: six square metal
 * partials, CHIRP (stick attack pitch env), DECAY closed→open, highpass
 * TONE, METAL SPREAD (partial detune), PULSE (square↔sine character).
 */
export const cinkParams: ParamDef[] = [
  {
    id: "tune",
    label: "TUNE",
    min: -12,
    max: 12,
    default: 0,
    unit: "st",
    format: (v) => `${v > 0 ? "+" : ""}${v.toFixed(0)} st`,
  },
  { id: "decay", label: "DECAY", min: 0.05, max: 1.2, default: 0.4, unit: "s", format: sec, taper: "log" },
  { id: "chirp", label: "CHIRP", min: 0, max: 1, default: 0.3, format: pct },
  {
    id: "chirpTime",
    label: "CHIRP T",
    min: 0.005,
    max: 0.15,
    default: 0.03,
    unit: "s",
    format: (v) => `${(v * 1000).toFixed(0)} ms`,
  },
  { id: "hpTone", label: "HP TONE", min: 3000, max: 12000, default: 7000, unit: "Hz", format: hz, taper: "log" },
  { id: "metalSpread", label: "SPREAD", min: 0, max: 1, default: 0.15, format: pct },
  { id: "pulseMix", label: "PULSE", min: 0, max: 1, default: 0.5, format: pct },
  { id: "drive", label: "DRIVE", min: 0, max: 1, default: 0.25, format: pct },
  { id: "level", label: "LEVEL", min: 0, max: 1.5, default: 0.8, format: pct },
];

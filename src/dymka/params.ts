import type { ParamDef } from "../effects/types";

const pct = (v: number) => `${Math.round(v * 100)}%`;
const sec = (v: number) => `${v.toFixed(2)} s`;
const ct = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(0)} ct`;

/**
 * DYMKA parameters (ADR 0062) — the breath-driven wind instrument.
 * BREATH sets the driver level (velocity scales it per note); the
 * brightness, reed noise and pitch lift all derive from the live breath
 * value. FORMANTs are the bore resonances; VIB the jaw vibrato.
 */
export const dymkaParams: ParamDef[] = [
  {
    id: "wave",
    label: "WAVE",
    min: 0,
    max: 1,
    default: 0,
    kind: "discrete",
    options: [
      { value: 0, label: "SAW" },
      { value: 1, label: "SQUARE" },
    ],
  },
  { id: "breath", label: "BREATH", min: 0, max: 1, default: 0.7, format: pct },
  { id: "brightBase", label: "BRIGHT", min: 0.1, max: 1, default: 0.45, format: pct },
  { id: "reedLevel", label: "REED", min: 0, max: 1, default: 0.35, format: pct },
  { id: "reedTone", label: "R TONE", min: 1000, max: 6000, default: 2800, unit: "Hz", taper: "log", format: (v) => `${(v / 1000).toFixed(1)} kHz` },
  { id: "pitchLift", label: "P LIFT", min: 0, max: 50, default: 12, unit: "ct", format: ct },
  { id: "formant1", label: "F1", min: 300, max: 1500, default: 700, unit: "Hz", format: (v) => `${v.toFixed(0)} Hz` },
  { id: "formant2", label: "F2", min: 1000, max: 3500, default: 1800, unit: "Hz", format: (v) => `${v.toFixed(0)} Hz` },
  { id: "bodyTone", label: "BODY TONE", min: 0.5, max: 2, default: 1, format: (v) => `${v.toFixed(2)}×` },
  { id: "vibRate", label: "VIB RATE", min: 0.5, max: 8, default: 5, unit: "Hz", format: (v) => `${v.toFixed(1)} Hz` },
  { id: "vibDepth", label: "VIB DEPTH", min: 0, max: 50, default: 12, unit: "ct", format: (v) => `${v.toFixed(0)} ct` },
  { id: "attack", label: "ATTACK", min: 0.005, max: 1.5, default: 0.04, unit: "s", format: sec, taper: "log" },
  { id: "release", label: "RELEASE", min: 0.03, max: 3, default: 0.2, unit: "s", format: sec, taper: "log" },
  { id: "legato", label: "LEGATO", min: 0, max: 1, default: 0, kind: "toggle", format: (v) => (v >= 0.5 ? "ON" : "OFF") },
  { id: "level", label: "LEVEL", min: 0, max: 1.5, default: 0.8, format: pct },
];

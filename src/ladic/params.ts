import type { ParamDef } from "../effects/types";

const pct = (v: number) => `${Math.round(v * 100)}%`;
const sec = (v: number) => `${v.toFixed(2)} s`;

/**
 * LADIČ parameters (ADR 0055) — six sine operators (RATIO/DETUNE/LEVEL +
 * ADSR each), eight curated algorithms, global feedback, glide, tone and
 * level. Sine-only is the authentic DX scope; waveforms and key scaling
 * are follow-up waves.
 */
function opParams(prefix: string, label: string, defaultRatio: number, defaultLevel: number): ParamDef[] {
  return [
    {
      id: `${prefix}Ratio`,
      label: `${label} RATIO`,
      min: 0.25,
      max: 16,
      default: defaultRatio,
      format: (v) => `${v.toFixed(2)}×`,
      taper: "log",
    },
    {
      id: `${prefix}Detune`,
      label: `${label} DET`,
      min: -50,
      max: 50,
      default: 0,
      unit: "ct",
      format: (v) => `${v > 0 ? "+" : ""}${v.toFixed(0)} ct`,
    },
    { id: `${prefix}Level`, label: `${label} LEVEL`, min: 0, max: 1, default: defaultLevel, format: pct },
    {
      id: `${prefix}Atk`,
      label: `${label} ATK`,
      min: 0.001,
      max: 4,
      default: 0.005,
      unit: "s",
      format: sec,
      taper: "log",
    },
    {
      id: `${prefix}Dec`,
      label: `${label} DEC`,
      min: 0.02,
      max: 6,
      default: 0.4,
      unit: "s",
      format: sec,
      taper: "log",
    },
    { id: `${prefix}Sus`, label: `${label} SUS`, min: 0, max: 1, default: 0.6, format: pct },
    {
      id: `${prefix}Rel`,
      label: `${label} REL`,
      min: 0.02,
      max: 8,
      default: 0.3,
      unit: "s",
      format: sec,
      taper: "log",
    },
  ];
}

export const LADIC_ALGORITHM_OPTIONS = [
  { value: 0, label: "6 ADD" },
  { value: 1, label: "3×2 PAIRS" },
  { value: 2, label: "1←2+3 · 4←5 · 6" },
  { value: 3, label: "2×3 CHAIN" },
  { value: 4, label: "6 CHAIN" },
  { value: 5, label: "1←ALL" },
  { value: 6, label: "TRIO+FB" },
  { value: 7, label: "3 CARRIERS" },
] as const;

export const ladicParams: ParamDef[] = [
  {
    id: "algorithm",
    label: "ALGORITHM",
    min: 0,
    max: 7,
    default: 1,
    step: 1,
    kind: "discrete",
    options: [...LADIC_ALGORITHM_OPTIONS],
  },
  { id: "feedback", label: "FEEDBACK", min: 0, max: 1, default: 0.1, format: pct },
  ...opParams("op1", "O1", 1, 1),
  ...opParams("op2", "O2", 2, 0.4),
  ...opParams("op3", "O3", 1, 0),
  ...opParams("op4", "O4", 3, 0),
  ...opParams("op5", "O5", 1, 0),
  ...opParams("op6", "O6", 1, 0),
  { id: "glide", label: "GLIDE", min: 0, max: 2, default: 0, unit: "s", format: sec, taper: "log" },
  {
    id: "cutoff",
    label: "TONE",
    min: 500,
    max: 16000,
    default: 16000,
    unit: "Hz",
    format: (v) => (v >= 15900 ? "OPEN" : `${(v / 1000).toFixed(1)} kHz`),
    taper: "log",
  },
  { id: "level", label: "LEVEL", min: 0, max: 1.5, default: 0.8, format: pct },
];

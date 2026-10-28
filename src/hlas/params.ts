import type { ParamDef } from "../effects/types";

const pct = (v: number) => `${Math.round(v * 100)}%`;
const sec = (v: number) => `${v.toFixed(2)} s`;

/**
 * HĽAS parameters (ADR 0059) — a formant lead: glottal source + breath
 * through three vowel formant bandpasses. MPE timbre drives the vowel
 * morph, MPE pressure drives the breath (both per note).
 */
export const hlasParams: ParamDef[] = [
  {
    id: "vowelA",
    label: "VOWEL A",
    min: 0,
    max: 4,
    default: 0,
    step: 1,
    kind: "discrete",
    options: [
      { value: 0, label: "A" },
      { value: 1, label: "E" },
      { value: 2, label: "I" },
      { value: 3, label: "O" },
      { value: 4, label: "U" },
    ],
  },
  {
    id: "vowelB",
    label: "VOWEL B",
    min: 0,
    max: 4,
    default: 2,
    step: 1,
    kind: "discrete",
    options: [
      { value: 0, label: "A" },
      { value: 1, label: "E" },
      { value: 2, label: "I" },
      { value: 3, label: "O" },
      { value: 4, label: "U" },
    ],
  },
  { id: "morph", label: "MORPH", min: 0, max: 1, default: 0, format: pct },
  { id: "formantScale", label: "F SCALE", min: 0.5, max: 2, default: 1, format: (v) => `${v.toFixed(2)}×` },
  { id: "breath", label: "BREATH", min: 0, max: 1, default: 0.2, format: pct },
  { id: "pulse", label: "PULSE", min: 0, max: 1, default: 0.3, format: pct },
  {
    id: "vibratoRate",
    label: "VIB RATE",
    min: 0.5,
    max: 9,
    default: 5.5,
    unit: "Hz",
    format: (v) => `${v.toFixed(1)} Hz`,
    taper: "log",
  },
  {
    id: "vibratoDepth",
    label: "VIB DEPTH",
    min: 0,
    max: 60,
    default: 14,
    unit: "ct",
    format: (v) => `${v.toFixed(0)} ct`,
  },
  // The glide starts at 0 s, and a log taper divides by log(min) - so it would
  // be undefined exactly at the default's lower end. Linear it is.
  { id: "glide", label: "GLIDE", min: 0, max: 1.5, default: 0.06, unit: "s", format: sec },
  { id: "attack", label: "ATTACK", min: 0.002, max: 1.5, default: 0.02, unit: "s", format: sec, taper: "log" },
  { id: "release", label: "RELEASE", min: 0.02, max: 3, default: 0.25, unit: "s", format: sec, taper: "log" },
  { id: "level", label: "LEVEL", min: 0, max: 1.5, default: 0.8, format: pct },
];

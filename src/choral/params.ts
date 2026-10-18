import type { ParamDef } from "../effects/types";

const pct = (v: number) => `${Math.round(v * 100)}%`;

/**
 * CHORÁL parameters (ADR 0054). Deliberately lean: the instrument's identity
 * is "your source, sustained, in harmony with the song" — not a knob wall.
 * Formant/timbre shaping is the follow-up wave (ADR 0054 §3 scope line).
 */
export const choralParams: ParamDef[] = [
  { id: "srcRoot", label: "SRC ROOT", min: 24, max: 84, default: 60, format: (v) => `MIDI ${Math.round(v)}` },
  {
    id: "stackMode",
    label: "STACK",
    min: 0,
    max: 3,
    default: 3,
    step: 1,
    kind: "discrete",
    options: [
      { value: 0, label: "OFF" },
      { value: 1, label: "OCTAVES" },
      { value: 2, label: "FIFTHS" },
      { value: 3, label: "TRIAD" },
    ],
  },
  { id: "stackLevel", label: "STACK LVL", min: 0, max: 1, default: 0.6, format: pct },
  { id: "stackDetune", label: "STACK DET", min: 0, max: 30, default: 8, unit: "ct", format: (v) => `${v.toFixed(0)} ct` },
  { id: "grainSize", label: "G SIZE", min: 20, max: 200, default: 80, unit: "ms", taper: "log", format: (v) => `${v.toFixed(0)} ms` },
  { id: "grainDensity", label: "G DENS", min: 8, max: 48, default: 24, unit: "Hz", taper: "log", format: (v) => `${v.toFixed(0)}/s` },
  { id: "grainJitter", label: "G JIT", min: 0, max: 1, default: 0.15, format: pct },
  { id: "attack", label: "ATTACK", min: 0.001, max: 2, default: 0.08, unit: "s", taper: "log" },
  { id: "release", label: "RELEASE", min: 0.02, max: 4, default: 0.6, unit: "s", taper: "log" },
  { id: "level", label: "LEVEL", min: 0, max: 1.5, default: 0.8, format: pct },
];

import type { ParamDef } from "../effects/types";

const pct = (v: number) => `${Math.round(v * 100)}%`;
const sec = (v: number) => `${v.toFixed(2)} s`;

/**
 * STRUNA parameters (ADR 0061) — extended Karplus-Strong. PICK POS is the
 * pluck position along the string (comb null), PICK SHARP the excitation
 * pre-emphasis, DAMP the loop loss (darker = faster death), DECAY the
 * −60 dB time at any pitch, BRIGHT the initial one-pole, BODY the cavity
 * resonances.
 */
export const strunaParams: ParamDef[] = [
  { id: "pickPos", label: "PICK POS", min: 0.02, max: 1, default: 0.25, format: pct },
  { id: "pickSharp", label: "PICK SHARP", min: 0, max: 1, default: 0.4, format: pct },
  { id: "damp", label: "DAMP", min: 0, max: 1, default: 0.35, format: pct },
  { id: "decay", label: "DECAY", min: 0.3, max: 8, default: 2.2, unit: "s", format: sec, taper: "log" },
  { id: "mute", label: "MUTE", min: 0.02, max: 1, default: 0.25, unit: "s", format: sec, taper: "log" },
  { id: "bodyLevel", label: "BODY", min: 0, max: 1, default: 0.3, format: pct },
  { id: "bodyTone", label: "BODY TONE", min: 0.5, max: 2, default: 1, format: (v) => `${v.toFixed(2)}×` },
  { id: "drive", label: "DRIVE", min: 0, max: 1, default: 0.1, format: pct },
  { id: "level", label: "LEVEL", min: 0, max: 1.5, default: 0.85, format: pct },
];

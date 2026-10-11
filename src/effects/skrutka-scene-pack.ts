/**
 * TWIST SCENE PACK (v2.5) — curated A/B curve pairs for the scene-intensity
 * arc: curve A is the intro-safe voicing, curve B the drop voicing. Applying
 * a pair (commands/twistScene.ts) stores both snapshots, sets the MORPH base
 * to the neutral midpoint and binds MORPH to the project's scene intensity,
 * so playing an intro scene leans A and the drop lands B — with no lanes to
 * draw and nothing per-genre to configure.
 *
 * Values are full TWIST curve parameter maps (only the morphable ids) and are
 * pinned inside EFFECT_META ranges by tests/twist-scene-pack.test.ts.
 */

import { TWIST_CURVE_PARAM_IDS, type TwistCurveSlot, type TwistCurvesState } from "./skrutka-curves";

export interface TwistScenePair {
  id: string;
  genre: string;
  label: string;
  description: string;
  /** Intro-safe voicing. */
  a: Record<string, number>;
  /** Drop voicing. */
  b: Record<string, number>;
}

export const TWIST_SCENE_PACK: readonly TwistScenePair[] = [
  {
    id: "trap-center-shimmer",
    genre: "Trap",
    label: "Center → Shimmer",
    description: "Intro keeps the 808 centered and gulped; the drop fans the sides into a 3 kHz shimmer.",
    a: { field: -0.5, dispersion: 0.5, focusHz: 90, dyn: 0.35, mix: 1 },
    b: { field: 0.8, spread: 0.5, dispersion: 0.55, focusHz: 3200, mix: 0.7 },
  },
  {
    id: "drill-clean-gulp",
    genre: "Drill",
    label: "Clean → Gulp",
    description: "Verse stays light; the drop drowns the tail while the attack keeps its edge.",
    a: { dispersion: 0.3, focusHz: 90, mix: 0.6 },
    b: { dispersion: 0.7, focusHz: 90, dyn: -0.5, punch: -0.4, mix: 1 },
  },
  {
    id: "house-tight-liquid",
    genre: "House",
    label: "Tight → Liquid",
    description: "Groove stays dry and punchy; the drop adds a tempo-synced focus sweep.",
    a: { dispersion: 0.3, punch: 0.3, focusHz: 250, mix: 0.7 },
    b: { dispersion: 0.6, punch: 0.15, focusHz: 900, lfoRate: 0.5, lfoSync: 2, lfoDepth: 0.4, mix: 1 },
  },
  {
    id: "techno-flat-chirp",
    genre: "Techno",
    label: "Flat → Chirp",
    description: "Rolling intro; the drop opens the CHIRP distribution and widens the field.",
    a: { dispersion: 0.35, shape: 0, focusHz: 400, mix: 0.8 },
    b: { dispersion: 0.65, shape: 1, focusHz: 1200, spread: 0.3, mix: 1 },
  },
  {
    id: "dnb-static-reso",
    genre: "DnB",
    label: "Static → Reso",
    description: "Halftime breath vs. the drop's resonant double-hump with accent punch.",
    a: { dispersion: 0.4, focusHz: 150, dyn: -0.4, mix: 1 },
    b: { dispersion: 0.5, shape: 3, focusHz: 700, spread: 0.4, dynPunch: 0.5, mix: 0.8 },
  },
  {
    id: "amapiano-soft-breath",
    genre: "Amapiano",
    label: "Soft → Breath",
    description: "Log-drum intro stays soft; the drop lets the tail breathe and spreads the sides.",
    a: { dispersion: 0.3, focusHz: 200, mix: 0.5 },
    b: { dispersion: 0.55, focusHz: 180, dyn: -0.6, spread: 0.3, mix: 0.8 },
  },
  {
    id: "jersey-tick-wide",
    genre: "Jersey",
    label: "Tick → Wide",
    description: "Club ticks stay narrow; the drop goes full side-field around 3 kHz.",
    a: { dispersion: 0.35, focusHz: 2500, mix: 0.5 },
    b: { field: 0.8, dispersion: 0.5, focusHz: 3200, spread: 0.6, mix: 0.75 },
  },
  {
    id: "hyperpop-dry-glitch",
    genre: "Hyperpop",
    label: "Dry → Glitch",
    description: "Sticker-clean intro; the drop adds a seeded random focus sweep and chirped texture.",
    a: { dispersion: 0.25, focusHz: 1200, mix: 0.4 },
    b: {
      dispersion: 0.7,
      shape: 1,
      focusHz: 3000,
      spread: 0.4,
      lfoRate: 2,
      lfoSync: 4,
      lfoShape: 2,
      lfoDepth: 0.5,
      mix: 0.85,
    },
  },
  {
    id: "ambient-static-double",
    genre: "Ambient",
    label: "Static → Double",
    description: "Still intro; the drop turns the pad into a double-hump drift that follows the envelope.",
    a: { dispersion: 0.3, focusHz: 600, mix: 0.6 },
    b: { dispersion: 0.6, shape: 2, focusHz: 500, spread: 0.5, dyn: -0.3, mix: 0.9 },
  },
];

const EPS = 1e-6;

function sameParams(x: Record<string, number>, y: Record<string, number>): boolean {
  for (const id of TWIST_CURVE_PARAM_IDS) {
    const xv = x[id];
    const yv = y[id];
    if (xv === undefined && yv === undefined) continue;
    if (xv === undefined || yv === undefined || Math.abs(xv - yv) > EPS) return false;
  }
  return true;
}

/** The pack pair whose A/B match the stored slots exactly (else null = CUSTOM). */
export function findTwistScenePair(slots: TwistCurvesState["slots"] | undefined): TwistScenePair | null {
  if (!slots?.A || !slots.B) return null;
  for (const pair of TWIST_SCENE_PACK) {
    if (sameParams(pair.a, slots.A) && sameParams(pair.b, slots.B)) return pair;
  }
  return null;
}

/** Slot maps for a pair (deep copies — deviceState payloads must not alias). */
export function twistSceneSlots(pair: TwistScenePair): Record<TwistCurveSlot, Record<string, number>> {
  return { A: { ...pair.a }, B: { ...pair.b } };
}

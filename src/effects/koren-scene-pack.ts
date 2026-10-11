/**
 * GROW SCENE PACK — curated A/B parameter pairs for the scene-intensity arc:
 * side A is the intro (phone-ready) voicing, side B the drop voicing. Applying
 * a pair (commands/korenScene.ts) stores both maps on the effect's
 * deviceState, writes the per-param MIDPOINT as the live base and binds every
 * differing param to the project's scene intensity, so an intro scene lands A
 * and the drop lands B with no lanes to draw.
 *
 * Values are full GROW rack parameter maps (not the engine-only `hintHz`);
 * tests/koren-scene-pack.test.ts pins them inside EFFECT_META ranges, the A/B
 * key PARITY (the apply command needs both sides for every id) and the
 * contrast (≥ 2 differing params per pair). Stepped ids (CHARACTER, RANGE,
 * RETRIG) switch at their rounding boundary mid-swing — the DSP rounds, so a
 * 0→1 intensity sweep plays CLEAN → SAT → FOLD rather than a smear.
 */

import type { KorenSceneState } from "./koren-scene";

export interface KorenScenePair {
  id: string;
  genre: string;
  label: string;
  description: string;
  /** Intro (phone-ready) voicing. */
  a: Record<string, number>;
  /** Drop voicing. */
  b: Record<string, number>;
}

export const KOREN_SCENE_PACK: readonly KorenScenePair[] = [
  {
    id: "drill-phone-growl",
    genre: "Drill",
    label: "Phone → Growl",
    description: "Intro is a clean phone-ready anchor; the drop folds the generated layer into the drill growl.",
    a: {
      focusHz: 90,
      drive: 0.35,
      harmonics: 0.55,
      subAnchor: 0.75,
      presence: 0.65,
      character: 0,
      sustain: 0,
      range: 2,
      phase: 0,
      tilt: 0,
      width: 0,
      release: 0.12,
      mix: 0.6,
    },
    b: {
      focusHz: 80,
      drive: 0.75,
      harmonics: 0.65,
      subAnchor: 0.6,
      presence: 1,
      character: 2,
      sustain: 0.35,
      range: 3,
      phase: 0.3,
      tilt: 0.4,
      width: 0.3,
      release: 0.25,
      mix: 0.85,
    },
  },
  {
    id: "trap-808-weight",
    genre: "Trap",
    label: "808 → Weight",
    description: "Intro carries the 808 on a phone stack; the drop trades phone-forward range for body and width.",
    a: {
      focusHz: 55,
      drive: 0.45,
      harmonics: 0.6,
      subAnchor: 0.8,
      presence: 1,
      range: 4,
      sustain: 0,
      release: 0.12,
      width: 0,
      mix: 0.7,
    },
    b: {
      focusHz: 55,
      drive: 0.55,
      harmonics: 0.75,
      subAnchor: 0.9,
      presence: 0.7,
      range: 3,
      sustain: 0.25,
      release: 0.35,
      width: 0.5,
      mix: 0.85,
    },
  },
  {
    id: "house-pluck-liquid",
    genre: "House",
    label: "Pluck → Liquid",
    description: "Dry plucked intro bass; the drop saturates the layer and lets the tail ring out wide.",
    a: {
      focusHz: 120,
      drive: 0.3,
      harmonics: 0.45,
      subAnchor: 0.7,
      presence: 0.4,
      character: 0,
      sustain: 0,
      release: 0.12,
      width: 0,
      mix: 0.5,
    },
    b: {
      focusHz: 100,
      drive: 0.45,
      harmonics: 0.6,
      subAnchor: 0.75,
      presence: 0.7,
      character: 1,
      sustain: 0.5,
      release: 0.3,
      width: 0.3,
      mix: 0.75,
    },
  },
  {
    id: "techno-rolling-drone",
    genre: "Techno",
    label: "Rolling → Drone",
    description: "Staccato rolling intro keeps the retrig glue; the drop releases it into a tilted drone.",
    a: {
      focusHz: 90,
      drive: 0.4,
      harmonics: 0.5,
      subAnchor: 0.75,
      retrig: 1,
      sustain: 0,
      release: 0.1,
      width: 0,
      tilt: 0,
      mix: 0.55,
    },
    b: {
      focusHz: 90,
      drive: 0.5,
      harmonics: 0.65,
      subAnchor: 0.8,
      retrig: 0,
      sustain: 0.6,
      release: 0.5,
      width: 0.2,
      tilt: 0.2,
      mix: 0.8,
    },
  },
  {
    id: "dnb-sub-reese",
    genre: "DnB",
    label: "Sub → Reese",
    description: "Intro stays a mono sub anchor; the drop spreads a phased harmonic reese around it.",
    a: {
      focusHz: 70,
      drive: 0.35,
      harmonics: 0.35,
      subAnchor: 0.85,
      presence: 0.3,
      character: 0,
      phase: 0,
      width: 0,
      tilt: 0,
      mix: 0.5,
    },
    b: {
      focusHz: 70,
      drive: 0.5,
      harmonics: 0.8,
      subAnchor: 0.65,
      presence: 0.6,
      character: 1,
      phase: 0.5,
      width: 0.5,
      tilt: -0.2,
      mix: 0.8,
    },
  },
  {
    id: "amapiano-log-breath",
    genre: "Amapiano",
    label: "Log → Breath",
    description: "Soft log-drum intro; the drop lets the stack breathe with sustain and a wide slow release.",
    a: {
      focusHz: 65,
      drive: 0.3,
      harmonics: 0.4,
      subAnchor: 0.8,
      presence: 0.4,
      sustain: 0,
      release: 0.15,
      width: 0,
      phase: 0,
      mix: 0.45,
    },
    b: {
      focusHz: 65,
      drive: 0.4,
      harmonics: 0.6,
      subAnchor: 0.7,
      presence: 0.8,
      sustain: 0.4,
      release: 0.6,
      width: 0.35,
      phase: 0.4,
      mix: 0.7,
    },
  },
  {
    id: "jersey-tick-club",
    genre: "Jersey",
    label: "Tick → Club",
    description: "Narrow tick bass intro; the drop opens the ladder and rotates the partials into club width.",
    a: {
      focusHz: 80,
      drive: 0.35,
      harmonics: 0.5,
      subAnchor: 0.75,
      retrig: 1,
      range: 2,
      width: 0,
      phase: 0,
      attack: 0.008,
      mix: 0.5,
    },
    b: {
      focusHz: 80,
      drive: 0.5,
      harmonics: 0.7,
      subAnchor: 0.7,
      retrig: 1,
      range: 3,
      width: 0.7,
      phase: 0.3,
      attack: 0.02,
      mix: 0.8,
    },
  },
  {
    id: "hyperpop-clean-fold",
    genre: "Hyperpop",
    label: "Clean → Fold",
    description: "Phone-clean intro; the drop folds the layer and widens the presence band.",
    a: {
      focusHz: 110,
      drive: 0.3,
      harmonics: 0.45,
      subAnchor: 0.7,
      presence: 0.7,
      character: 0,
      tilt: 0,
      sustain: 0,
      attack: 0.008,
      width: 0,
      mix: 0.5,
    },
    b: {
      focusHz: 110,
      drive: 0.6,
      harmonics: 0.6,
      subAnchor: 0.6,
      presence: 0.9,
      character: 2,
      tilt: 0.5,
      sustain: 0.2,
      attack: 0.03,
      width: 0.4,
      mix: 0.85,
    },
  },
  {
    id: "ambient-still-bloom",
    genre: "Ambient",
    label: "Still → Bloom",
    description: "Still low pad intro; the drop blooms the stack into a tilted, phase-diffused sustain.",
    a: {
      focusHz: 60,
      drive: 0.3,
      harmonics: 0.4,
      subAnchor: 0.8,
      attack: 0.05,
      release: 0.5,
      sustain: 0.2,
      width: 0,
      tilt: 0,
      phase: 0,
      mix: 0.4,
    },
    b: {
      focusHz: 60,
      drive: 0.4,
      harmonics: 0.55,
      subAnchor: 0.75,
      attack: 0.05,
      release: 0.8,
      sustain: 0.7,
      width: 0.4,
      tilt: -0.3,
      phase: 0.6,
      mix: 0.7,
    },
  },
];

const EPS = 1e-6;

function sameParams(x: Record<string, number>, y: Record<string, number>): boolean {
  const ids = new Set([...Object.keys(x), ...Object.keys(y)]);
  for (const id of ids) {
    const xv = x[id];
    const yv = y[id];
    if (xv === undefined || yv === undefined || Math.abs(xv - yv) > EPS) return false;
  }
  return true;
}

/** The pack pair whose A/B match the stored slots exactly (else null = CUSTOM). */
export function findKorenScenePair(slots: KorenSceneState["slots"] | undefined): KorenScenePair | null {
  if (!slots?.A || !slots.B) return null;
  for (const pair of KOREN_SCENE_PACK) {
    if (sameParams(pair.a, slots.A) && sameParams(pair.b, slots.B)) return pair;
  }
  return null;
}

/** Slot maps for a pair (deep copies — deviceState payloads must not alias). */
export function korenSceneSlots(pair: KorenScenePair): { A: Record<string, number>; B: Record<string, number> } {
  return { A: { ...pair.a }, B: { ...pair.b } };
}

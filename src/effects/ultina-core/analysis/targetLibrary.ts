/* eslint-disable */
/**
 * VENDORED from VocalForge_DAW/plugins/ultina. Do not edit by hand — this is
 * a byte-faithful copy of the upstream DSP oracle so Pulse Forge and
 * VocalForge validate against the SAME golden vectors
 * (tests/ultina-vectors.test.ts). Fix DSP issues upstream, then re-vendor
 * via scripts/vendor-ultina.mjs.
 *
 * Applied transforms (mechanical, semantics-preserving):
 *  - type-only specifiers marked with "type" for verbatimModuleSyntax
 *    (Pulse Forge tsconfig is stricter than upstream).
 */
// ═══════════════════════════════════════════════════════════
// Ultina — Target Library (v1)
//
// Reference spectral curves for Tonal Balance Control and
// Track Enhance. Each curve specifies a 10 octave-band target
// (31 Hz – 16 kHz) in dB relative to the average level.
//
// These curves are derived from analysis of professionally mixed
// reference tracks. They are starting points, not absolutes —
// the user can adjust or capture their own curves.
// ═══════════════════════════════════════════════════════════

import type { TargetCurve } from "./assistant.js";

// Octave band center frequencies: 31, 63, 125, 250, 500, 1k, 2k, 4k, 8k, 16k Hz

export const TARGET_LIBRARY: TargetCurve[] = [
  // ── Vocal targets ──
  {
    id: "vocal-male-balanced",
    name: "Vocal (Male) — Balanced",
    category: "vocal",
    curve: [-6, -4, -1, 1, 2, 2, 1, 0, -1, -3],
    description: "Reference curve for a well-balanced male lead vocal.",
  },
  {
    id: "vocal-female-balanced",
    name: "Vocal (Female) — Balanced",
    category: "vocal",
    curve: [-8, -6, -3, 0, 1, 2, 2, 1, 0, -2],
    description: "Reference curve for a well-balanced female lead vocal.",
  },
  {
    id: "vocal-bright",
    name: "Vocal — Bright / Air",
    category: "vocal",
    curve: [-8, -6, -3, -1, 0, 1, 2, 3, 4, 5],
    description: "Forward vocal with extended air and presence.",
  },
  {
    id: "vocal-warm",
    name: "Vocal — Warm / Intimate",
    category: "vocal",
    curve: [-4, -2, 1, 2, 2, 1, 0, -1, -2, -4],
    description: "Warm, intimate vocal with gentle high-frequency roll-off.",
  },

  // ── Instrument targets ──
  {
    id: "bass-balanced",
    name: "Bass — Balanced",
    category: "instrument",
    curve: [6, 5, 3, 0, -3, -5, -8, -10, -12, -14],
    description: "Reference curve for a punchy, controlled bass guitar.",
  },
  {
    id: "guitar-balanced",
    name: "Guitar — Balanced",
    category: "instrument",
    curve: [-4, -2, 0, 1, 1, 1, 1, 0, -2, -4],
    description: "Reference curve for a well-balanced electric guitar.",
  },
  {
    id: "acoustic-guitar",
    name: "Acoustic Guitar",
    category: "instrument",
    curve: [-5, -3, -1, 1, 2, 2, 1, 1, 0, -2],
    description: "Natural acoustic guitar with sparkle.",
  },
  {
    id: "keys-balanced",
    name: "Keys / Piano — Balanced",
    category: "instrument",
    curve: [-3, -2, -1, 0, 1, 1, 1, 0, -1, -3],
    description: "Broadband balanced keys or piano.",
  },
  {
    id: "drums-balanced",
    name: "Drums — Balanced",
    category: "instrument",
    curve: [3, 2, 1, 0, -1, 0, 1, 1, 0, -1],
    description: "Reference curve for a full drum bus.",
  },
  {
    id: "kick-punchy",
    name: "Kick — Punchy",
    category: "instrument",
    curve: [6, 5, 2, -2, -4, -6, -8, -10, -12, -14],
    description: "Punchy kick drum with sub-bass weight.",
  },
  {
    id: "snare-crack",
    name: "Snare — Crack",
    category: "instrument",
    curve: [-4, -3, 0, 3, 4, 3, 2, 0, -2, -4],
    description: "Snappy snare with body and crack.",
  },

  // ── Bus targets ──
  {
    id: "drum-bus",
    name: "Drum Bus — Glued",
    category: "bus",
    curve: [2, 2, 1, 0, -1, 0, 1, 1, 0, -1],
    description: "Glued drum bus with controlled lows and airy highs.",
  },
  {
    id: "vocal-bus",
    name: "Vocal Bus — Smooth",
    category: "bus",
    curve: [-4, -3, -1, 0, 1, 1, 1, 0, 0, -2],
    description: "Smooth vocal bus with gentle roll-off.",
  },
  {
    id: "music-bus",
    name: "Music Bus — Balanced",
    category: "bus",
    curve: [-2, -1, 0, 0, 0, 0, 0, 0, -1, -2],
    description: "Balanced music/instrument bus.",
  },

  // ── Master targets ──
  {
    id: "master-loud",
    name: "Master — Loud / Modern",
    category: "master",
    curve: [-2, -1, 0, 0, 0, 0, 0, 0, -1, -2],
    description: "Flat, loud modern master curve.",
  },
  {
    id: "master-warm",
    name: "Master — Warm / Vintage",
    category: "master",
    curve: [1, 1, 1, 0, 0, -1, -2, -2, -3, -4],
    description: "Warm, vintage-style master with gentle top roll-off.",
  },
  {
    id: "master-open",
    name: "Master — Open / Air",
    category: "master",
    curve: [-2, -1, -1, 0, 0, 1, 1, 2, 3, 3],
    description: "Open, airy master with extended top end.",
  },
];

// ── Lookup helpers ───────────────────────────────────────────

export function getTargetById(id: string): TargetCurve | null {
  return TARGET_LIBRARY.find((t) => t.id === id) ?? null;
}

export function getTargetsByCategory(category: TargetCurve["category"]): TargetCurve[] {
  return TARGET_LIBRARY.filter((t) => t.category === category);
}

/** Get the recommended target for an instrument type. */
export function getRecommendedTarget(instrument: string): TargetCurve | null {
  const mapping: Record<string, string> = {
    vocalMale: "vocal-male-balanced",
    vocalFemale: "vocal-female-balanced",
    bass: "bass-balanced",
    guitar: "guitar-balanced",
    keys: "keys-balanced",
    drums: "drums-balanced",
    bus: "music-bus",
    master: "master-loud",
  };
  const id = mapping[instrument];
  return id ? getTargetById(id) : null;
}

/** Capture a custom target curve from a spectral profile. */
export function createCustomTarget(
  name: string,
  octaveBandsDb: number[],
  description = "User-captured target curve",
): TargetCurve {
  return {
    id: `custom-${Date.now()}`,
    name,
    category: "custom",
    curve: octaveBandsDb,
    description,
  };
}

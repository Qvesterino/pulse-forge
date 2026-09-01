/* eslint-disable */
// @ts-nocheck
/**
 * VENDORED from VocalForge_DAW/plugins/ozvena. Do not edit by hand — this is
 * a byte-faithful copy of the upstream DSP oracle so Pulse Forge and
 * VocalForge validate against the SAME golden fixtures
 * (tests/ozvena-golden.test.ts). Fix DSP issues upstream, then re-vendor
 * via scripts/vendor-ozvena.mjs.
 *
 * Applied transforms (mechanical, semantics-preserving):
 *  - type-only specifiers marked with "type" for verbatimModuleSyntax
 *    (Pulse Forge tsconfig is stricter than upstream).
 */
// ═══════════════════════════════════════════════════════════
// Ozvena — Reverb Assistant (4-step wizard)
//
// Implements Neoverb's "Reverb Assistant" workflow as a heuristic
// parameter-set computer:
//
//   Step 1: Style (0..1)
//     0 = close / intimate / room-like
//     1 = epic / hall-like
//   Step 2: Size (0..1)
//     Fine-tunes the initial size set by Style.
//   Step 3: Dry/Wet (0..1)
//     Suggests the global wet/dry ratio.
//   Step 4: Tone (clean / dark / bright / airy)
//     Maps onto Pre EQ/Reverb EQ tonal bias.
//
// The wizard collects the 4 user inputs, then calls `recommend()`
// which produces a recommended OzvenaStateV1 patch the user can
// accept (or dismiss). All recommendations are derived from
// deterministic mappings; no FFT analysis is performed in the wizard
// itself. AutoCut / Unmask analyzers are separate flows triggered by
// the user explicitly.
//
// This is intentionally simple: the wizard should be predictable and
// fast. Heuristics are tuned to match the "VocalForge" character
// (slightly brighter than average, slightly longer than average).
// ═══════════════════════════════════════════════════════════

import type {
  AssistantState,
  AssistantTone,
  BlendPadState,
  OzvenaStateV1,
} from "../v2/types.js";
import { defaultOzvenaStateV1 } from "../v2/types.js";
import { clamp } from "../dsp/math.js";

export interface AssistantRecommendation {
  blendPad: BlendPadState;
  engines: OzvenaStateV1["engines"];
  preEq: OzvenaStateV1["preEq"];
  reverbEq: OzvenaStateV1["reverbEq"];
  preDelay: OzvenaStateV1["preDelay"];
  global: Pick<OzvenaStateV1["global"], "dryWet" | "levelDb">;
  /** Human-readable summary for the UI banner. */
  summary: string;
}

/**
 * Map Style 0..1 → Blend Pad (x, y) and dominant engine. Lower style
 * favours Reflections + Plate (small rooms), higher favours Hall.
 */
function styleToBlend(style: number, size: number): BlendPadState {
  const s = clamp(style, 0, 1);
  const z = clamp(size, 0, 1);

  // Y position: low style → 0.1 (down, near E1); high style → 0.9 (up, E3).
  const yBase = 0.1 + s * 0.8;
  // Size adds ±0.1 around the style baseline.
  const y = clamp(yBase + (z - 0.5) * 0.2, 0, 1);

  // X position: drifts rightward as style rises (more E2/E3, less E1).
  const xBase = 0.4 + s * 0.2;
  const x = clamp(xBase + (z - 0.5) * 0.1, 0, 1);

  return { x, y, engine2Algo: s < 0.4 ? "room" : s < 0.75 ? "mediumChamber" : "plate", injectER: 0 };
}

function styleToEngineTimes(style: number, size: number): {
  e1Time: number;
  e2Time: number;
  e3Time: number;
} {
  const s = clamp(style, 0, 1);
  const z = clamp(size, 0, 1);
  // Default ranges for "music mix" preset.
  const e1Base = 60 + s * 80;            // 60..140 ms
  const e2Base = 1200 + s * 4500;        // 1.2..5.7 s
  const e3Base = 3500 + s * 8000;        // 3.5..11.5 s
  const adjust = (z - 0.5) * 0.4 + 1;    // 0.8..1.2
  return {
    e1Time: clamp(e1Base * adjust, 36.73, 250),
    e2Time: clamp(e2Base * adjust, 1400, 14000),
    e3Time: clamp(e3Base * adjust, 4170, 24000),
  };
}

function styleToDryWet(style: number, userDryWet: number): number {
  // Wizard's dryWet suggestion = blend of style default + user override.
  // The user's Dry/Wet slider (step 3) is the dominant signal — when
  // the user pushes it to 1, the recommendation goes to 100% wet.
  const s = clamp(style, 0, 1);
  const styleDw = 0.55 + s * 0.35;       // 0.55..0.90
  // The bias shifts further toward user input at the extremes so the
  // wizard respects the explicit user choice.
  const bias = userDryWet > 0.85 || userDryWet < 0.15 ? 1.0 : 0.80;
  return clamp((styleDw * (1 - bias) + userDryWet * bias) * 100, 0, 100);
}

function toneToEqBias(tone: AssistantTone): {
  preEqBandGains: [number, number, number];
  reverbEqBandGains: [number, number, number];
} {
  switch (tone) {
    case "clean":
      return { preEqBandGains: [0, 0, 0], reverbEqBandGains: [0, 0, 0] };
    case "dark":
      // Pre EQ: high cut to soften highs. Reverb EQ: low shelf cut + gentle top rolloff.
      return {
        preEqBandGains: [0, 0, -3],
        reverbEqBandGains: [-1.5, 0, -2],
      };
    case "bright":
      // Pre EQ: small low shelf cut + a gentle high-shelf boost. Reverb EQ: thin low end, lift highs.
      return {
        preEqBandGains: [-2, 0, 1.5],
        reverbEqBandGains: [-2, 0, 2],
      };
    case "airy":
      // Open top, no mud. Reverb EQ: airy boost on top, slight cut on low mids.
      return {
        preEqBandGains: [-1, 0, 3],
        reverbEqBandGains: [-1, -0.5, 2.5],
      };
  }
}

/**
 * Run the assistant on its current state and produce a deterministic
 * recommendation. The caller may apply the recommendation directly to
 * `state` (via `applyRecommendation`) or display it for user acceptance.
 */
export function recommend(s: AssistantState): AssistantRecommendation {
  const blend = styleToBlend(s.style, s.size);
  const times = styleToEngineTimes(s.style, s.size);
  const dw = styleToDryWet(s.style, s.dryWet);
  const eqBias = toneToEqBias(s.tone);

  const engines: OzvenaStateV1["engines"] = {
    e1: { ...defaultOzvenaStateV1().engines.e1, time: times.e1Time, space: 0.4 + s.style * 0.4, size: 0.4 + s.size * 0.4 },
    e2: { ...defaultOzvenaStateV1().engines.e2, time: times.e2Time, space: 0.4 + s.style * 0.4, size: 0.4 + s.size * 0.4 },
    e3: { ...defaultOzvenaStateV1().engines.e3, time: times.e3Time, space: 0.4 + s.style * 0.4, size: 0.4 + s.size * 0.4 },
  };

  const preEq: OzvenaStateV1["preEq"] = {
    ...defaultOzvenaStateV1().preEq,
    enabled: true,
    band1: { ...defaultOzvenaStateV1().preEq.band1, enabled: true, gainDb: eqBias.preEqBandGains[0], shape: "lowShelf" },
    band2: { ...defaultOzvenaStateV1().preEq.band2, enabled: true, freqHz: 800, gainDb: eqBias.preEqBandGains[1], shape: "bell" },
    band3: { ...defaultOzvenaStateV1().preEq.band3, enabled: true, gainDb: eqBias.preEqBandGains[2], shape: "highShelf" },
  };

  const reverbEq: OzvenaStateV1["reverbEq"] = {
    ...defaultOzvenaStateV1().reverbEq,
    enabled: true,
    band1: { ...defaultOzvenaStateV1().reverbEq.band1, enabled: true, gainDb: eqBias.reverbEqBandGains[0], shape: "lowShelf" },
    band2: { ...defaultOzvenaStateV1().reverbEq.band2, enabled: true, gainDb: eqBias.reverbEqBandGains[1], shape: "bell" },
    band3: { ...defaultOzvenaStateV1().reverbEq.band3, enabled: true, gainDb: eqBias.reverbEqBandGains[2], shape: "highShelf" },
  };

  const preDelay: OzvenaStateV1["preDelay"] = {
    ...defaultOzvenaStateV1().preDelay,
    enabled: true,
    ms: clamp(10 + s.size * 60, 0, 500),
  };

  const summary = [
    `Style: ${s.style.toFixed(2)}`,
    `Size: ${s.size.toFixed(2)}`,
    `Dry/Wet: ${dw.toFixed(0)}%`,
    `Tone: ${s.tone}`,
    `E1=${times.e1Time.toFixed(0)}ms, E2=${(times.e2Time / 1000).toFixed(2)}s, E3=${(times.e3Time / 1000).toFixed(2)}s`,
  ].join("  •  ");

  return {
    blendPad: blend,
    engines,
    preEq,
    reverbEq,
    preDelay,
    global: { dryWet: dw, levelDb: 0 },
    summary,
  };
}

/**
 * Apply a recommendation onto an OzvenaStateV1, returning a NEW state.
 * Does not touch global.inputGainDb / outputGainDb / quality.
 */
export function applyRecommendation(
  state: OzvenaStateV1,
  rec: AssistantRecommendation,
): OzvenaStateV1 {
  return {
    ...state,
    blendPad: { ...rec.blendPad },
    engines: {
      e1: { ...state.engines.e1, ...rec.engines.e1 },
      e2: { ...state.engines.e2, ...rec.engines.e2 },
      e3: { ...state.engines.e3, ...rec.engines.e3 },
    },
    preEq: {
      ...state.preEq,
      enabled: rec.preEq.enabled,
      band1: { ...state.preEq.band1, ...rec.preEq.band1 },
      band2: { ...state.preEq.band2, ...rec.preEq.band2 },
      band3: { ...state.preEq.band3, ...rec.preEq.band3 },
    },
    reverbEq: {
      ...state.reverbEq,
      enabled: rec.reverbEq.enabled,
      band1: { ...state.reverbEq.band1, ...rec.reverbEq.band1 },
      band2: { ...state.reverbEq.band2, ...rec.reverbEq.band2 },
      band3: { ...state.reverbEq.band3, ...rec.reverbEq.band3 },
    },
    preDelay: { ...state.preDelay, ...rec.preDelay },
    global: {
      ...state.global,
      dryWet: rec.global.dryWet,
      levelDb: rec.global.levelDb,
    },
    assistant: { ...state.assistant, status: "accepted", accepted: true },
  };
}

export function defaultAssistantState(): AssistantState {
  return defaultOzvenaStateV1().assistant;
}

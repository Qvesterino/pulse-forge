/* eslint-disable */
// @ts-nocheck
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
// Ultina — Track Enhance (v1)
//
// One-click enhancement with intensity macro knob. A simplified
// wrapper around the full Mix Assistant pipeline:
//   1. Extract features from audio
//   2. Classify instrument (auto-detect)
//   3. Generate proposals with the given character + intensity
//   4. Return ready-to-apply parameter changes
//
// Unlike the full Mix Assistant, Track Enhance:
//   - Auto-selects character based on detected instrument
//   - Uses a single "Enhance Amount" knob (0-100%)
//   - Is designed for quick results, not surgical control
//
// The user still reviews the proposed changes before applying —
// nothing is applied silently.
// ═══════════════════════════════════════════════════════════

import {
  INSTRUMENT_LABELS,
  type AnalysisResult,
  type UltinaProposal,
  type AssistantIntensity,
  type AssistantCharacter,
  type InstrumentType,
  type ParameterProposal,
  type ModuleToggleProposal,
} from "./assistant.js";
import { extractFeatures } from "./featureExtractor.js";
import { classifyInstrument } from "./instrumentClassifier.js";
import { generateProposal, ANALYSIS_VERSION } from "./proposalEngine.js";

// ── Track Enhance request ────────────────────────────────────

export interface TrackEnhanceRequest {
  /** Audio data (per channel) */
  channels: Float32Array[];
  /** Sample rate */
  sampleRate: number;
  /** Enhance amount (0–100, maps to intensity) */
  amount: number;
  /** Explicit instrument override */
  instrumentOverride?: InstrumentType;
  /** Explicit character override */
  characterOverride?: AssistantCharacter;
}

export interface TrackEnhanceResult {
  proposal: UltinaProposal;
  summary: string;
}

// ── Amount → intensity mapping ───────────────────────────────

function amountToIntensity(amount: number): AssistantIntensity {
  if (amount < 33) return "subtle";
  if (amount < 67) return "balanced";
  return "strong";
}

// ── Auto character selection per instrument ──────────────────

function autoCharacter(instrument: InstrumentType): AssistantCharacter {
  switch (instrument) {
    case "vocalMale":
    case "vocalFemale":
      return "forward";
    case "bass":
      return "punchy";
    case "guitar":
      return "warm";
    case "keys":
      return "clean";
    case "drums":
      return "punchy";
    case "bus":
      return "clean";
    case "master":
      return "clean";
    default:
      return "clean";
  }
}

// ── Main Track Enhance ───────────────────────────────────────

/**
 * Run a one-click enhancement analysis.
 *
 * Returns a proposal ready for the user to review and apply.
 * Never applies changes silently.
 */
export function trackEnhance(request: TrackEnhanceRequest): TrackEnhanceResult {
  const { channels, sampleRate, amount, instrumentOverride, characterOverride } = request;

  // 1. Extract features
  const features = extractFeatures(channels, sampleRate);

  if (!features.valid) {
    throw new Error(
      features.invalidReason ?? "Insufficient audio for analysis",
    );
  }

  // 2. Classify or use override
  let classification;
  if (instrumentOverride) {
    classification = {
      instrument: instrumentOverride,
      confidence: 1.0,
      scores: { [instrumentOverride]: 1.0 },
      explanation: `Manual override: ${instrumentOverride}`,
    };
  } else {
    classification = classifyInstrument(features);
  }

  // 3. Determine character and intensity
  const character = characterOverride ?? autoCharacter(classification.instrument);
  const intensity = amountToIntensity(amount);

  // 4. Generate proposals
  const { toggles, changes } = generateProposal(
    features,
    classification,
    character,
    intensity,
  );

  // 5. Build proposal
  const proposal: UltinaProposal = {
    analysisVersion: ANALYSIS_VERSION,
    instrument: classification.instrument,
    character,
    intensity,
    analyzedAt: Date.now(),
    analyzedDuration: features.analyzedDuration,
    features,
    classification,
    moduleToggles: toggles,
    changes,
    applied: false,
  };

  // 6. Build summary
  const enabledModules = toggles.filter((t) => t.enabled).map((t) => t.moduleType);
  const summary = buildSummary(
    classification.instrument,
    character,
    intensity,
    enabledModules,
    changes.length,
  );

  return { proposal, summary };
}

function buildSummary(
  instrument: InstrumentType,
  character: AssistantCharacter,
  intensity: AssistantIntensity,
  enabledModules: string[],
  paramCount: number,
): string {
  const parts = [
    `Detected: ${INSTRUMENT_LABELS[instrument]}`,
    `Character: ${character}`,
    `Intensity: ${intensity}`,
  ];

  if (enabledModules.length > 0) {
    parts.push(`Modules: ${enabledModules.join(", ")}`);
  }

  parts.push(`${paramCount} parameter adjustments`);

  return parts.join(" · ");
}

// ── Convenience: apply proposal to parameter map ─────────────

/**
 * Convert a proposal's parameter changes to a partial parameter map.
 * Does not include module toggle states — those are handled separately
 * via the module graph.
 */
export function proposalToParamMap(
  proposal: UltinaProposal,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const change of proposal.changes) {
    result[change.parameterId] = change.value;
  }
  return result;
}

/**
 * Get the list of module types that should be enabled.
 */
export function proposalToEnabledModules(
  proposal: UltinaProposal,
): string[] {
  return proposal.moduleToggles
    .filter((t) => t.enabled)
    .map((t) => t.moduleType);
}

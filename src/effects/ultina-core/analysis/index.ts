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
// Ultina — Intelligence Layer (Barrel Export)
//
// Public API for the Mix Assistant intelligence layer:
//   - Assistant contracts & types
//   - Feature extraction
//   - Instrument classification
//   - Proposal generation
//   - Track Enhance (one-click)
//   - Mix Assistant (full pipeline)
//   - Tonal Balance Control
//   - Target Library
//   - Explanation localizer
// ═══════════════════════════════════════════════════════════

// Contracts
export * from "./assistant.js";

// Feature extraction
export { extractFeatures } from "./featureExtractor.js";

// Instrument classification
export { classifyInstrument } from "./instrumentClassifier.js";

// Proposal engine
export {
  generateProposal,
  hashFeatures,
  ANALYSIS_VERSION,
} from "./proposalEngine.js";

// Track Enhance
export {
  trackEnhance,
  proposalToParamMap,
  proposalToEnabledModules,
} from "./trackEnhance.js";
export type { TrackEnhanceRequest, TrackEnhanceResult } from "./trackEnhance.js";

// Mix Assistant
export { analyzeTrack, analyzeWithTarget } from "./mixAssistant.js";

// Tonal Balance Control
export {
  TonalBalanceMeter,
  computeTonalBalance,
  balanceSuggestionsToEqParams,
} from "./tonalBalance.js";

// Target Library
export {
  TARGET_LIBRARY,
  getTargetById,
  getTargetsByCategory,
  getRecommendedTarget,
  createCustomTarget,
} from "./targetLibrary.js";

// Explanation
export {
  getExplanation,
  getExplanationForLocale,
  getLocaleMap,
  AVAILABLE_LOCALES,
} from "./explanation.js";
export type { ExplanationLocale } from "./explanation.js";

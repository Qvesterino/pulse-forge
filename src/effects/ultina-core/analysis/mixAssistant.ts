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
// Ultina — Mix Assistant Orchestrator (v1)
//
// Full analysis pipeline:
//   Audio → FeatureExtractor → InstrumentClassifier
//        → ProposalGenerator → UltinaProposal
//
// The Mix Assistant is the "analyze and propose" engine. It
// never mutates live parameters — the caller is responsible for
// applying the returned proposal.
//
// For a simplified one-click interface, use trackEnhance() instead.
// ═══════════════════════════════════════════════════════════

import type {
  AnalysisRequest,
  AnalysisResult,
  UltinaProposal,
  AssistantCharacter,
  AssistantIntensity,
} from "./assistant.js";
import { extractFeatures } from "./featureExtractor.js";
import { classifyInstrument } from "./instrumentClassifier.js";
import { generateProposal, ANALYSIS_VERSION } from "./proposalEngine.js";
import { clampParam } from "../contracts/parameterSchema.js";

/**
 * Run the full Mix Assistant analysis pipeline.
 *
 * @returns AnalysisResult — success with proposal, insufficient
 *          material, or error.
 */
export function analyzeTrack(request: AnalysisRequest): AnalysisResult {
  const {
    channels,
    sampleRate,
    instrumentOverride,
    character = "clean",
    intensity = "balanced",
    minimumDuration = 2,
  } = request;

  // ── Step 1: Feature extraction ──
  let features;
  try {
    features = extractFeatures(channels, sampleRate);
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : "Feature extraction failed",
    };
  }

  // ── Step 2: Validity check ──
  if (!features.valid) {
    return {
      kind: "insufficient",
      reason: features.invalidReason ?? "Insufficient audio material",
      features,
    };
  }

  if (features.analyzedDuration < minimumDuration) {
    return {
      kind: "insufficient",
      reason: `Analyzed ${features.analyzedDuration.toFixed(1)}s, need at least ${minimumDuration}s`,
      features,
    };
  }

  // ── Step 3: Instrument classification ──
  const classification = instrumentOverride
    ? {
        instrument: instrumentOverride,
        confidence: 1.0,
        scores: { [instrumentOverride]: 1.0 },
        explanation: `Manual override: ${instrumentOverride}`,
      }
    : classifyInstrument(features);

  // ── Step 4: Generate proposals ──
  const { toggles, changes } = generateProposal(
    features,
    classification,
    character as AssistantCharacter,
    intensity as AssistantIntensity,
  );

  // ── Step 5: Build proposal ──
  const proposal: UltinaProposal = {
    analysisVersion: ANALYSIS_VERSION,
    instrument: classification.instrument,
    character: character as AssistantCharacter,
    intensity: intensity as AssistantIntensity,
    analyzedAt: Date.now(),
    analyzedDuration: features.analyzedDuration,
    features,
    classification,
    moduleToggles: toggles,
    changes,
    applied: false,
  };

  return { kind: "success", proposal };
}

/**
 * Run analysis with a specific target curve for tonal balance matching.
 * Incorporates the target curve into the proposal as EQ suggestions.
 */
export function analyzeWithTarget(
  request: AnalysisRequest,
  targetCurve: number[],
): AnalysisResult {
  const result = analyzeTrack(request);

  if (result.kind !== "success") {
    return result;
  }

  // Merge tonal balance suggestions into the existing EQ proposals
  const proposal = result.proposal;
  const features = proposal.features;

  // Convert features.spectralProfile (ratios) to dB per octave band
  const currentDb = features.spectralProfile.length === 10
    ? features.spectralProfile.map((b) => {
        const dbVal = b.ratio > 0 ? 10 * Math.log10(b.ratio * 10 + 1e-20) : -60;
        return dbVal;
      })
    : new Array(10).fill(0);

  // Deviation = current - target. A non-finite target entry (caller-supplied
  // or custom-captured curve) would make every downstream Math.min/max
  // comparison NaN — which then flows into proposal values and, unclamped,
  // into live DSP parameters. Sanitize to 0 (= flat target, no adjustment).
  const deviation = currentDb.map((c, i) => {
    const target = targetCurve[i];
    return c - (typeof target === "number" && Number.isFinite(target) ? target : 0);
  });

  // Suggest EQ adjustments (inverse of deviation, ±6 dB max)
  const octaveFreqs = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const eqDefaultFreqs = [80, 200, 350, 800, 1500, 3000, 5000, 7000, 10000, 12000, 15000, 18000];

  for (let i = 0; i < octaveFreqs.length; i++) {
    if (Math.abs(deviation[i]) < 1.5) continue;

    // Find closest EQ band
    let bestBand = 0;
    let bestDist = Infinity;
    for (let b = 0; b < eqDefaultFreqs.length; b++) {
      const dist = Math.abs(Math.log2(eqDefaultFreqs[b] / octaveFreqs[i]));
      if (dist < bestDist) {
        bestDist = dist;
        bestBand = b;
      }
    }

    const adjustment = Math.max(-6, Math.min(6, -deviation[i] * 0.5));

    // Check if this band is already in the changes
    const bandId = `eq.band${bestBand}.gainDb`;
    const existing = proposal.changes.find((c) => c.parameterId === bandId);
    if (existing) {
      // Clamp the accumulation to the parameter's schema range — unlike
      // addParam in proposalEngine, this path writes values directly and an
      // accumulated sum can exceed the band gain's legal range.
      existing.value = clampParam(bandId, existing.value + adjustment);
      existing.reasonCode = "INSTRUMENT_PROFILE_MISMATCH";
      existing.explanation = `Adjusted toward target curve: ${adjustment > 0 ? "+" : ""}${adjustment.toFixed(1)} dB`;
    } else {
      proposal.changes.push({
        parameterId: bandId,
        value: clampParam(bandId, adjustment),
        confidence: 0.6,
        reasonCode: "INSTRUMENT_PROFILE_MISMATCH",
        explanation: `Tonal balance target adjustment: ${adjustment > 0 ? "+" : ""}${adjustment.toFixed(1)} dB`,
      });
    }
  }

  return { kind: "success", proposal };
}

import type { RoutedIntent } from "./route";

/**
 * SFT DATASET NORMALIZER — the canonical (instruction → action) pairing for
 * training a small local model as a KYX sound engineer.
 *
 * The deterministic intent layer IS the teacher: every parser maps free text
 * to a typed RoutedIntent, and `compactIntentResponse` reduces that to a
 * stable, JSON-serializable action descriptor. A fine-tuned model (LFM-2.5
 * 1.2B class) learns to emit THIS JSON; the deterministic layer remains the
 * runtime fallback and the verifier — the model never touches audio state
 * directly.
 *
 * Compaction rules (all deterministic):
 *  - pattern → excluded upstream (generation is a proposal, not a command)
 *  - preset → {id, name} only (params are factory data, not model output)
 *  - exact plans → ops only (the label is derived text)
 *  - arrange → ops only (unrecognized is parse noise, not an action)
 *  - mix profile → overrides + detected (the profile itself is derived)
 */

export interface CompactIntentResponse {
  kind: string;
  [key: string]: unknown;
}

export function compactIntentResponse(route: RoutedIntent): CompactIntentResponse {
  switch (route.kind) {
    case "preset":
      return {
        kind: "preset",
        preset: { id: route.intent.preset.id, name: route.intent.preset.name },
        target: route.intent.target,
        matchedBy: route.intent.matchedBy,
      };
    case "presetUnknown":
      return { kind: "presetUnknown", name: route.name, suggestions: route.suggestions };
    case "exact":
      return { kind: "exact", ops: route.plan.ops };
    case "arrange":
      return { kind: "arrange", ops: route.ops };
    case "clips":
      return { kind: "clips", ops: route.ops };
    case "fader":
      return { kind: "fader", intent: route.intent };
    case "compound":
      return { kind: "compound", parts: route.parts };
    case "transport":
      return { kind: "transport", action: route.action };
    case "save":
      return { kind: "save" };
    case "export":
      return { kind: "export", format: route.format };
    case "record":
      return { kind: "record", arm: route.arm };
    case "select":
      return { kind: "select", target: route.target };
    case "sendIntent":
      return { kind: "sendIntent", intent: route.intent };
    case "bypassIntent":
      return { kind: "bypassIntent", intent: route.intent };
    case "effectIntent":
      return { kind: "effectIntent", intent: route.intent };
    case "loudness":
      return { kind: "loudness", parse: route.parse };
    case "tempo":
      return { kind: "tempo", intent: route.intent };
    case "production":
      return { kind: "production", intent: route.intent };
    case "mix":
      return { kind: "mix", overrides: route.overrides, detected: route.detected };
    case "revise":
      return {
        kind: "revise",
        attribute: route.attribute,
        direction: route.direction,
        targetRole: route.targetRole,
      };
    case "clarify":
      return { kind: "clarify", reason: route.reason, suggestions: route.suggestions };
    case "pattern":
      // Not a command — excluded from the SFT command set by the caller.
      return { kind: "pattern" };
    default:
      return { kind: (route as { kind: string }).kind };
  }
}

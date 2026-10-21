import type { DrumPad, Pattern, TimeSignature } from "../project-model/types";
import { aiMeterFor } from "../ai/meter";
import { makeFill, expandWithBuild, replaceRows, varyPattern, styleNames, type RowsPatch } from "./patternOps";
import type { AssistInput, AssistRequest, AssistTarget } from "./types";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

function targetOf(value: unknown): AssistTarget {
  return value === "kicks" || value === "snares" || value === "hats" ? value : "hats";
}

/**
 * The meter's own signature, if the request carries a usable one.
 *
 * A broken signature is DROPPED rather than repaired: the assist layer then
 * runs in 4/4 (the identity), which is the honest answer for "no meter" — it
 * never invents a bar length.
 */
function signatureOf(value: unknown): TimeSignature | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { numerator, denominator } = value as Partial<TimeSignature>;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return undefined;
  const num = Math.round(numerator as number);
  const den = Math.round(denominator as number);
  if (num < 1 || den < 1) return undefined;
  return { numerator: num, denominator: den };
}

/** Normalize UI/provider input so every Assist execution has one contract. */
export function normalizeAssistRequest(input: AssistInput): AssistRequest {
  const target = targetOf(input.target);
  const availableStyles = styleNames(target);
  const requestedStyle = typeof input.style === "string" ? input.style : "";
  const timeSignature = signatureOf(input.timeSignature);
  return {
    operation: input.operation,
    seed: typeof input.seed === "string" ? input.seed.slice(0, 128) : "",
    amount: clamp(input.amount ?? 0.6, 0, 1),
    bars: Math.max(1, Math.min(16, Math.round(clamp(input.bars ?? 4, 1, 16)))),
    target,
    style: availableStyles.includes(requestedStyle) ? requestedStyle : availableStyles[0],
    ...(timeSignature ? { timeSignature } : {}),
  };
}

/** Build the exact pure patch used by both Assist preview and Apply. */
export function buildAssistPatch(pattern: Pattern, pads: DrumPad[], input: AssistInput): RowsPatch {
  const request = normalizeAssistRequest(input);
  // The request's metre decides the metrical facts of every op. No metre in
  // the request means 4/4 — the identity the whole assist layer keeps.
  const meter = aiMeterFor(request.timeSignature);
  switch (request.operation) {
    case "vary":
      return varyPattern(pattern, pads, request.seed, request.amount, meter);
    case "build":
      return expandWithBuild(pattern, pads, request.bars, request.seed, meter);
    case "replace":
      return replaceRows(pattern, pads, request.target, request.style, request.seed, meter);
    case "fill":
      return makeFill(pattern, pads, request.seed, meter);
  }
}

import type { DrumPad, Pattern } from "../project-model/types";
import { makeFill, expandWithBuild, replaceRows, varyPattern, styleNames, type RowsPatch } from "./patternOps";
import type { AssistInput, AssistRequest, AssistTarget } from "./types";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

function targetOf(value: unknown): AssistTarget {
  return value === "kicks" || value === "snares" || value === "hats" ? value : "hats";
}

/** Normalize UI/provider input so every Assist execution has one contract. */
export function normalizeAssistRequest(input: AssistInput): AssistRequest {
  const target = targetOf(input.target);
  const availableStyles = styleNames(target);
  const requestedStyle = typeof input.style === "string" ? input.style : "";
  return {
    operation: input.operation,
    seed: typeof input.seed === "string" ? input.seed.slice(0, 128) : "",
    amount: clamp(input.amount ?? 0.6, 0, 1),
    bars: Math.max(1, Math.min(16, Math.round(clamp(input.bars ?? 4, 1, 16)))),
    target,
    style: availableStyles.includes(requestedStyle) ? requestedStyle : availableStyles[0],
  };
}

/** Build the exact pure patch used by both Assist preview and Apply. */
export function buildAssistPatch(
  pattern: Pattern,
  pads: DrumPad[],
  input: AssistInput,
): RowsPatch {
  const request = normalizeAssistRequest(input);
  switch (request.operation) {
    case "vary": return varyPattern(pattern, pads, request.seed, request.amount);
    case "build": return expandWithBuild(pattern, pads, request.bars, request.seed);
    case "replace": return replaceRows(pattern, pads, request.target, request.style, request.seed);
    case "fill": return makeFill(pattern, pads, request.seed);
  }
}

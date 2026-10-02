import type { DrumTrack, Pattern } from "../project-model/types";
import {
  applyAssistPatchToStepSelection,
  classifyPads,
  thinStepSelection,
  type ReplaceTarget,
  type StepSelectionScope,
} from "./patternOps";
import { buildAssistPatch } from "./pipeline";
import { parseSelectedStepIntent, type SelectedStepIntent } from "./selected-step-intent";

export interface SelectedStepChange {
  padId: string;
  padName: string;
  step: number;
  before: number;
  after: number;
}

export interface SelectedStepInstructionPlan {
  intent: SelectedStepIntent | null;
  scope: StepSelectionScope | null;
  previewPattern: Pattern | null;
  changes: SelectedStepChange[];
  beforeHits: number;
  afterHits: number;
  error: string | null;
}

export interface SelectedStepPlanInput {
  text: string;
  pattern: Pattern | null;
  drumTrack: DrumTrack | null;
  selection: StepSelectionScope | null;
  seed: string;
  amount: number;
  bars: number;
  target: ReplaceTarget;
  style: string;
}

const emptyPlan = (error: string | null): SelectedStepInstructionPlan => ({
  intent: null,
  scope: null,
  previewPattern: null,
  changes: [],
  beforeHits: 0,
  afterHits: 0,
  error,
});

/** Build the exact scoped preview shared by Assist and the main intent bar. */
export function planSelectedStepInstruction(input: SelectedStepPlanInput): SelectedStepInstructionPlan {
  if (!input.text.trim()) return emptyPlan(null);
  const intent = parseSelectedStepIntent(input.text);
  if (!intent) {
    return { ...emptyPlan("Try “make selected hats sparser” or “humanize these steps”"), intent: null };
  }
  const { pattern, drumTrack, selection } = input;
  if (!pattern || !drumTrack || !selection || selection.padIds.length === 0) {
    return {
      ...emptyPlan("Reselect valid drum cells before describing a scoped edit."),
      intent,
    };
  }

  const from = Math.min(selection.from, selection.to);
  const to = Math.max(selection.from, selection.to);
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to >= pattern.stepCount ||
    selection.padIds.some(
      (padId) => !drumTrack.pads.some((pad) => pad.id === padId) || pattern.rows[padId] === undefined,
    )
  ) {
    return { ...emptyPlan("Reselect valid drum cells before describing a scoped edit."), intent };
  }

  const selectedPadIds = new Set(selection.padIds);
  const targetPads = intent.target ? classifyPads(drumTrack.pads)[intent.target] : drumTrack.pads;
  const padIds = targetPads.filter((pad) => selectedPadIds.has(pad.id)).map((pad) => pad.id);
  if (padIds.length === 0) {
    return {
      ...emptyPlan(`The current step selection contains no ${intent.target ?? "usable"} drum rows.`),
      intent,
    };
  }

  const scope: StepSelectionScope = { ...selection, padIds };
  const previewPattern =
    intent.operation === "thin"
      ? thinStepSelection(pattern, scope)
      : applyAssistPatchToStepSelection(
          pattern,
          buildAssistPatch(pattern, drumTrack.pads, {
            operation: "vary",
            seed: input.seed,
            amount: input.amount,
            bars: input.bars,
            target: input.target,
            style: input.style,
          }),
          scope,
        );
  if (previewPattern === pattern) {
    return {
      ...emptyPlan(
        intent.operation === "thin"
          ? "The selected rows have no off-beat hits to thin."
          : "This instruction would not change the selected cells; try a new seed or a wider selection.",
      ),
      intent,
      scope,
      previewPattern,
    };
  }

  const changes: SelectedStepChange[] = [];
  let beforeHits = 0;
  let afterHits = 0;
  for (const padId of scope.padIds) {
    const padName = drumTrack.pads.find((pad) => pad.id === padId)?.name ?? "selected row";
    const before = pattern.rows[padId] ?? [];
    const after = previewPattern.rows[padId] ?? [];
    for (let step = from; step <= to; step++) {
      const beforeVelocity = before[step] ?? 0;
      const afterVelocity = after[step] ?? 0;
      if (beforeVelocity > 0) beforeHits++;
      if (afterVelocity > 0) afterHits++;
      if (beforeVelocity !== afterVelocity)
        changes.push({ padId, padName, step, before: beforeVelocity, after: afterVelocity });
    }
  }
  if (changes.length === 0) {
    return {
      intent,
      scope,
      previewPattern,
      changes,
      beforeHits,
      afterHits,
      error: "This instruction would not change the selected cells; try a new seed or a wider selection.",
    };
  }
  return { intent, scope, previewPattern, changes, beforeHits, afterHits, error: null };
}

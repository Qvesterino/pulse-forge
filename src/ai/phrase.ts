import type { PadRole } from "./pad-roles";
import { accentGroupSteps, DEFAULT_AI_METER, isAnchorForRole, type AiMeter } from "./meter";

export type PhraseSection = "main" | "variation" | "drop" | "fill" | "outro";

export interface PhraseBar {
  bar: number;
  startStep: number;
  endStep: number;
  section: PhraseSection;
}

/**
 * Build a deterministic phrase plan instead of silently tiling one bar.
 *
 * The plan's bars are the DOCUMENT's metrical bars (ADR 0057 Stage 2b): in a
 * 3/4 project one bar is twelve steps, so the phrase cuts at 0/12/24 — not at
 * the legacy 0/16/32, which put the fill a third of a bar past the bar line.
 * In 4/4 the bar is sixteen steps and this is the legacy plan, unchanged.
 */
export function buildPhrasePlan(stepCount: number, meter: AiMeter = DEFAULT_AI_METER): PhraseBar[] {
  const safeStepCount = Number.isFinite(stepCount) ? Math.max(0, Math.floor(stepCount)) : 0;
  const stepsPerBar = meter.stepsPerBar;
  const bars = Math.max(0, Math.ceil(safeStepCount / stepsPerBar));
  return Array.from({ length: bars }, (_, bar) => {
    const isFinalBar = bar === bars - 1;
    const isPenultimateBar = bar === bars - 2;
    let section: PhraseSection;
    if (bars < 4) {
      section = bar === 0 ? "main" : bar % 2 === 1 ? "variation" : "main";
    } else if (bars === 4) {
      section = (["main", "variation", "drop", "outro"] as const)[bar];
    } else if (isFinalBar) {
      section = "outro";
    } else if (isPenultimateBar) {
      section = "fill";
    } else if (bar === 2) {
      section = "drop";
    } else if (bar === 0) {
      section = "main";
    } else {
      section = bar % 2 === 1 ? "variation" : "main";
    }
    return {
      bar,
      startStep: bar * stepsPerBar,
      endStep: Math.min(safeStepCount, (bar + 1) * stepsPerBar),
      section,
    };
  });
}

function isHardAnchor(role: PadRole, step: number, meter: AiMeter): boolean {
  if (role === "kick") return isAnchorForRole(meter, "kick", step);
  if (role === "snare" || role === "clap") return isAnchorForRole(meter, "snare", step);
  return false;
}

/**
 * Apply deterministic phrase contrast while preserving hard anchors.
 *
 * The fill zone is the bar's last PULSE — a quarter note in 4/4 (the legacy
 * four steps) and a dotted quarter in 6/8.
 */
export function applyPhraseDynamics(
  row: number[],
  role: PadRole,
  plan: readonly PhraseBar[],
  rand: () => number,
  meter: AiMeter = DEFAULT_AI_METER,
): void {
  for (const phrase of plan) {
    for (let step = phrase.startStep; step < phrase.endStep && step < row.length; step++) {
      if (row[step] <= 0) continue;
      if (phrase.section === "variation") {
        const scale = role === "closedHat" || role === "perc" ? 0.88 + rand() * 0.16 : 0.94 + rand() * 0.1;
        row[step] = Math.max(0.1, Math.min(1, row[step] * scale));
      } else if (phrase.section === "drop" && !isHardAnchor(role, step, meter)) {
        if (role === "closedHat" || role === "openHat" || role === "perc" || role === "fx") {
          row[step] = 0;
        } else {
          row[step] = Math.max(0.1, row[step] * (0.42 + rand() * 0.16));
        }
      } else if (phrase.section === "fill" && step >= phrase.endStep - accentGroupSteps(meter)) {
        const boost = role === "kick" ? 0.04 : 0.08 + rand() * 0.08;
        row[step] = Math.min(1, row[step] + boost);
      } else if (phrase.section === "outro") {
        const relativeStep = step - phrase.startStep;
        const length = Math.max(1, phrase.endStep - phrase.startStep);
        const taper = 0.3 + 0.7 * (1 - relativeStep / length);
        if (
          (role === "closedHat" || role === "openHat" || role === "perc" || role === "fx") &&
          relativeStep >= Math.ceil(length / 2)
        ) {
          row[step] = 0;
        } else {
          row[step] = Math.max(0.1, row[step] * taper);
        }
      }
    }
  }
}

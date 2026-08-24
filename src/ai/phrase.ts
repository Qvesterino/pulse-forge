import type { PadRole } from './pad-roles';

export type PhraseSection = 'main' | 'variation' | 'fill' | 'outro';

export interface PhraseBar {
  bar: number;
  startStep: number;
  endStep: number;
  section: PhraseSection;
}

/** Build a deterministic phrase plan instead of silently tiling one bar. */
export function buildPhrasePlan(stepCount: number): PhraseBar[] {
  const bars = Math.max(0, Math.ceil(stepCount / 16));
  return Array.from({ length: bars }, (_, bar) => {
    const isFinalBar = bar === bars - 1;
    const section: PhraseSection = bars >= 4 && isFinalBar
      ? 'fill'
      : bar === 0
        ? 'main'
        : bar % 2 === 1
          ? 'variation'
          : 'main';
    return {
      bar,
      startStep: bar * 16,
      endStep: Math.min(stepCount, (bar + 1) * 16),
      section,
    };
  });
}

/** Apply a small deterministic phrase contour while preserving hard anchors. */
export function applyPhraseDynamics(
  row: number[],
  role: PadRole,
  plan: readonly PhraseBar[],
  rand: () => number,
): void {
  for (const phrase of plan) {
    if (phrase.section === 'main' || phrase.section === 'outro') continue;
    for (let step = phrase.startStep; step < phrase.endStep && step < row.length; step++) {
      if (row[step] <= 0) continue;
      if (phrase.section === 'variation') {
        const scale = role === 'closedHat' || role === 'perc'
          ? 0.88 + rand() * 0.16
          : 0.94 + rand() * 0.1;
        row[step] = Math.max(0.1, Math.min(1, row[step] * scale));
      } else if (phrase.section === 'fill' && step >= phrase.endStep - 4) {
        const boost = role === 'kick' ? 0.04 : 0.08 + rand() * 0.08;
        row[step] = Math.min(1, row[step] + boost);
      }
    }
  }
}

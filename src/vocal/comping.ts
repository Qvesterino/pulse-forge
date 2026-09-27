import type { VocalProfile } from "./types";

/**
 * VOCAL COMPING (vocal lane pilot) — the producer assembles the best take
 * from many. PURE functions over the measured profiles (no audio here: the
 * caller holds the PCM and applies the chosen segment plan). Deterministic,
 * honest about deafness — takes that failed analysis are skipped, and a
 * plan needs at least two MEASURED takes to exist (comping one take is a
 * no-op the singer didn't ask for).
 *
 * Harmony generation is deliberately absent: it needs per-note pitch
 * extraction, which the analyzer does not provide yet. Guessing harmonies
 * from key alone would violate the module's honesty contract.
 */

export interface CompSegment {
  /** First bar (inclusive) on the shared grid. */
  startBar: number;
  /** Last bar (inclusive). */
  endBar: number;
  /** Index into the takes array that wins this span. */
  takeIndex: number;
  /** The winning bar score for the span (0..~2). */
  score: number;
}

export interface CompPlan {
  /** Consecutive same-take spans covering bars 0..bars-1 (gaps possible when no take sings a bar). */
  segments: CompSegment[];
  /** Bars where at least one take actually sings (inside a phrase). */
  sungBars: number;
  /** Per-take contribution in bars (index-aligned with the takes array). */
  perTakeBars: number[];
  /** Take contributing the most bars (index into takes). */
  winner: number;
  /** How many takes entered the comparison (measured only). */
  takesMeasured: number;
  /** Bar count of the shared grid (min across takes). */
  bars: number;
}

/** Bar score for one take: phrase energy wins, sung-but-quiet middles, silence loses. */
function barScore(take: VocalProfile, bar: number): { score: number; sung: boolean } {
  const energy = take.energyCurve[bar] ?? 0;
  const inPhrase = take.phrases.some((p) => bar >= p.startBar && bar <= p.endBar);
  if (!inPhrase || energy <= 0.02) return { score: 0, sung: false };
  // phrase peak (stability within a phrase) + bar energy + take SNR bonus
  const phrase = take.phrases.find((p) => bar >= p.startBar && bar <= p.endBar)!;
  const snrBonus = Math.max(0, Math.min(0.3, take.snrDb / 80));
  return { score: phrase.peakEnergy * 0.6 + energy * 0.4 + snrBonus, sung: true };
}

/**
 * Plan the composite: for every bar on the shared grid, the take with the
 * best bar score wins. Consecutive same-winner bars merge into segments.
 * Returns null when fewer than two measured takes exist (nothing to comp).
 */
export function planVocalComp(takes: readonly VocalProfile[]): CompPlan | null {
  const measured = takes.map((take, index) => ({ take, index })).filter((entry) => entry.take.measured);
  if (measured.length < 2) return null;
  const bars = Math.min(...measured.map((entry) => entry.take.bars));
  if (bars <= 0) return null;

  const perTakeBars = takes.map(() => 0);
  const segments: CompSegment[] = [];
  let sungBars = 0;
  let current: CompSegment | null = null;

  for (let bar = 0; bar < bars; bar++) {
    let best = -1;
    let bestScore = 0;
    let bestSung = false;
    for (const { take, index } of measured) {
      const { score, sung } = barScore(take, bar);
      if (sung && score > bestScore) {
        best = index;
        bestScore = score;
        bestSung = true;
      }
    }
    if (bestSung && best >= 0) {
      sungBars += 1;
      perTakeBars[best] += 1;
      if (current && current.takeIndex === best && current.endBar === bar - 1) {
        current.endBar = bar;
        current.score = Math.max(current.score, bestScore);
      } else {
        current = { startBar: bar, endBar: bar, takeIndex: best, score: bestScore };
        segments.push(current);
      }
    } else {
      current = null; // nobody sings this bar — the comp keeps the gap honest
    }
  }

  let winner = 0;
  for (let index = 1; index < perTakeBars.length; index++) {
    if (perTakeBars[index] > perTakeBars[winner]) winner = index;
  }
  return { segments, sungBars, perTakeBars, winner, takesMeasured: measured.length, bars };
}

// ── Arrangement suggestions (the aranž-dialóg) ──────────────────────────────

export type ArrangementSuggestionType = "early-hook" | "late-hook" | "silence-pocket" | "energy-climax";

export interface ArrangementSuggestion {
  type: ArrangementSuggestionType;
  /** Bars the suggestion concerns (0-based, inclusive span start). */
  startBar: number;
  endBar: number;
  /** Human line (SK + EN) — same dialogue vocabulary as producer notes. */
  message: { sk: string; en: string };
}

/**
 * Arrangement dialogue: what the take asks the arrangement to do. Pure and
 * deterministic — every suggestion traces to a measured phrase/energy fact:
 *  - the loudest phrase decides WHERE the hook energy belongs;
 *  - if that climax sits past the mid-point, the chorus should come earlier
 *    (pop rule: hook before ~45 s / the mid-point);
 *  - a long sung-gap between phrases is a natural break/pocket;
 *  - the single loudest bar is the drop-down moment.
 */
export function suggestArrangementFromVocal(profile: VocalProfile): ArrangementSuggestion[] {
  if (!profile.measured || profile.phrases.length === 0) return [];
  const suggestions: ArrangementSuggestion[] = [];

  const climax = profile.phrases.reduce((best, p) => (p.peakEnergy > best.peakEnergy ? p : best));
  const midPoint = profile.bars / 2;
  if (climax.startBar >= midPoint && profile.bars >= 8) {
    suggestions.push({
      type: "late-hook",
      startBar: climax.startBar,
      endBar: climax.endBar,
      message: {
        sk: `Tvoja najsilnejšia fráza je až v takte ${climax.startBar + 1} — skrátila by som intro, aby hook prišiel skôr.`,
        en: `Your strongest phrase only lands at bar ${climax.startBar + 1} — I'd shorten the intro so the hook comes earlier.`,
      },
    });
  } else if (climax.startBar > 0 && climax.startBar <= 4) {
    suggestions.push({
      type: "early-hook",
      startBar: climax.startBar,
      endBar: climax.endBar,
      message: {
        sk: `Hookovú energiu máš hneď v takte ${climax.startBar + 1} — nechám intro minimálne.`,
        en: `Your hook energy lands at bar ${climax.startBar + 1} — keeping the intro minimal.`,
      },
    });
  }

  // longest phrase gap between consecutive phrases
  let gap: { start: number; end: number; length: number } | null = null;
  for (let i = 1; i < profile.phrases.length; i++) {
    const prev = profile.phrases[i - 1]!;
    const next = profile.phrases[i]!;
    const length = next.startBar - prev.endBar - 1;
    if (length >= 2 && (!gap || length > gap.length)) gap = { start: prev.endBar + 1, end: next.startBar - 1, length };
  }
  if (gap) {
    suggestions.push({
      type: "silence-pocket",
      startBar: gap.start,
      endBar: gap.end,
      message: {
        sk: `V taktoch ${gap.start + 1}–${gap.end + 1} máš dlhé ticho — prirodzený break alebo drop pocket.`,
        en: `Bars ${gap.start + 1}–${gap.end + 1} are a long silence — a natural break or drop pocket.`,
      },
    });
  }

  // single loudest bar — the drop-down moment
  let peakBar = -1;
  let peakValue = 0;
  for (let bar = 0; bar < profile.energyCurve.length; bar++) {
    if (profile.energyCurve[bar]! > peakValue) {
      peakValue = profile.energyCurve[bar]!;
      peakBar = bar;
    }
  }
  if (peakBar >= 0 && peakValue > 0.8) {
    suggestions.push({
      type: "energy-climax",
      startBar: peakBar,
      endBar: peakBar,
      message: {
        sk: `Absolútne maximum v takte ${peakBar + 1} — tam postavím impact alebo plný drop.`,
        en: `Absolute peak at bar ${peakBar + 1} — that's where the impact or full drop goes.`,
      },
    });
  }

  return suggestions;
}

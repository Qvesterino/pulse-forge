/**
 * ADR 0057 Stage 2i — the CONTENT for IRREGULAR metres (7/8, 5/8).
 *
 * Stage 2b made the AI layer speak the document's metre and Stage 2c made the
 * groove MATERIAL speak it. An irregular bar was left with a regime of its
 * own: the whole bar was ONE pulse, only the downbeat was anchored, and the
 * grouping was declared "content, not arithmetic".
 *
 * That regime was RIGHT about the arithmetic and WRONG about the consequence.
 * With no grouping, the pulse of a 7/8 bar is the whole bar — so every hit off
 * the downbeat weighed as syncopation, and the syncopation budget stripped the
 * groove away. MEASURED before this stage (house, seed "measure", two bars):
 * a 7/8 document produced kick [0, 14] and NOTHING else — a bare click on the
 * downbeat of each bar. A 5/8 document produced kick [0, 10] and one stray hat.
 *
 * Stage 2i gives an irregular bar its GROUPS — declared, not guessed: 7/8 is
 * 2+2+3, 5/8 is 3+2 — and the groups are where the accents are. The kick rides
 * the group downbeats, the backbeat sits on the accent group, and the eighths
 * inside the groups stay on the grid instead of counting as syncopation.
 *
 * The properties this file locks down:
 *
 *   1. The METRICAL FACTS: the declared grouping, the accent, the grid.
 *   2. The ANCHORS: the kick on the group downbeats, the backbeat on the accent.
 *   3. The CONTENT: a 7/8 document really produces a 7/8 groove.
 *   4. The FALLBACK: an irregular metre whose grouping is NOT declared (11/8)
 *      keeps the behaviour it had — the product does not guess a grouping.
 *   5. 4/4 and every regular metre are byte-identical — and the control is
 *      INDEPENDENT: the spec re-implements the legacy formula and compares it
 *      against the production one, so it cannot be satisfied by the code
 *      agreeing with itself.
 */
import { describe, expect, it } from "vitest";
import { createDefaultProject } from "../src/project-model/schema";
import { getDrumTrack } from "../src/project-model/types";
import { generatePattern } from "../src/ai/generator";
import { DEFAULT_GENERATE_OPTIONS } from "../src/ai/types";
import {
  accentAnchor,
  aiMeterFor,
  groupStarts,
  isAnchorForRole,
  isBackbeatAnchor,
  isHalfGroupStart,
  isKickAnchor,
  isPulse,
  stepInBar,
} from "../src/ai/meter";
import { anchorPositions, projectRowToMeter } from "../src/ai/groove-view";
import { enforceSyncopationBudget, syncopationWeight } from "../src/ai/style-quality";
import type { TimeSignature } from "../src/project-model/types";

const FOUR_FOUR: TimeSignature = { numerator: 4, denominator: 4 };
const THREE_FOUR: TimeSignature = { numerator: 3, denominator: 4 };
const SIX_EIGHT: TimeSignature = { numerator: 6, denominator: 8 };
const FIVE_FOUR: TimeSignature = { numerator: 5, denominator: 4 };
const SEVEN_EIGHT: TimeSignature = { numerator: 7, denominator: 8 };
const FIVE_EIGHT: TimeSignature = { numerator: 5, denominator: 8 };
const ELEVEN_EIGHT: TimeSignature = { numerator: 11, denominator: 8 };

/** Every metre the LEGACY layer spoke, with its legacy facts. */
const REGULAR: Array<[string, TimeSignature]> = [
  ["4/4", FOUR_FOUR],
  ["3/4", THREE_FOUR],
  ["6/8", SIX_EIGHT],
  ["5/4", FIVE_FOUR],
];

/** A row of `length` steps with hits at the given positions. */
function row(length: number, hits: readonly number[], value = 0.8): number[] {
  const out = new Array<number>(length).fill(0);
  for (const hit of hits) out[hit] = value;
  return out;
}

function hitsOf(source: readonly number[]): number[] {
  const out: number[] = [];
  source.forEach((value, step) => {
    if (value > 0) out.push(step);
  });
  return out;
}

/**
 * Generate a drum pattern and report each PAD's hit positions, by pad name.
 *
 * The house kit carries three active lanes (two kicks and a clap), and the
 * metrical view re-voices EACH of them — so the content is read per pad, not
 * as one merged "kick" role.
 */
function generatedHits(sig: TimeSignature, genre: string, seed: string, stepCount: number): Map<string, number[]> {
  const doc = createDefaultProject();
  const pattern = generatePattern(doc, {
    ...DEFAULT_GENERATE_OPTIONS,
    genre: genre as "house",
    seed,
    stepCount,
    timeSignature: sig,
    constraints: { preserveAnchors: true, allowGhosts: true, allowSwing: true },
  });
  const byPad = new Map<string, number[]>();
  const track = getDrumTrack(doc);
  track.pads.forEach((pad) => {
    const generated = pattern.rows[pad.id];
    if (!generated) return;
    const hits = hitsOf(generated);
    if (hits.length === 0) return;
    byPad.set(pad.name, hits);
  });
  return byPad;
}

describe("ADR 0057 Stage 2i — the metrical facts of an irregular bar", () => {
  it("declares the grouping of 7/8 (2+2+3) and 5/8 (3+2)", () => {
    const sevenEight = aiMeterFor(SEVEN_EIGHT);
    expect(sevenEight.stepsPerBar).toBe(14);
    expect(sevenEight.groups).toEqual([4, 4, 6]);
    expect(sevenEight.irregular).toBe(true);
    expect(groupStarts(sevenEight)).toEqual([0, 4, 8]);

    const fiveEight = aiMeterFor(FIVE_EIGHT);
    expect(fiveEight.stepsPerBar).toBe(10);
    expect(fiveEight.groups).toEqual([6, 4]);
    expect(fiveEight.irregular).toBe(true);
    expect(groupStarts(fiveEight)).toEqual([0, 6]);
  });

  it("keeps the legacy pulse value — the pulse does not repeat in an irregular bar", () => {
    // The pulse of a 7/8 bar is still the whole bar: that fact says the pulse
    // does not repeat, and the GROUPS say where the accents are. Replacing the
    // legacy value here would hide the difference between the two.
    expect(aiMeterFor(SEVEN_EIGHT).pulseSteps).toBe(14);
    expect(aiMeterFor(FIVE_EIGHT).pulseSteps).toBe(10);
  });

  it("puts the accent on the last group — the 2+2+3's '5' and the 3+2's '4'", () => {
    expect(accentAnchor(aiMeterFor(SEVEN_EIGHT))).toBe(8);
    expect(accentAnchor(aiMeterFor(FIVE_EIGHT))).toBe(6);
    // A bar with ONE group has no accent of its own — its downbeat is already
    // the only accent.
    expect(accentAnchor(aiMeterFor(ELEVEN_EIGHT))).toBeNull();
  });

  it("counts the eighths inside EACH group — the grid follows the group", () => {
    const sevenEight = aiMeterFor(SEVEN_EIGHT);
    const grid: number[] = [];
    for (let step = 0; step < sevenEight.stepsPerBar; step++) {
      if (isHalfGroupStart(sevenEight, step)) grid.push(step);
    }
    // 2+2+3 -> the eighths of the two shorts and of the long one.
    expect(grid).toEqual([0, 2, 4, 6, 8, 10, 12]);

    const fiveEight = aiMeterFor(FIVE_EIGHT);
    const fiveGrid: number[] = [];
    for (let step = 0; step < fiveEight.stepsPerBar; step++) {
      if (isHalfGroupStart(fiveEight, step)) fiveGrid.push(step);
    }
    expect(fiveGrid).toEqual([0, 2, 4, 6, 8]);
  });
});

describe("ADR 0057 Stage 2i — the anchors of an irregular bar", () => {
  it("rides the kick on the group downbeats and the backbeat on the accent", () => {
    const sevenEight = aiMeterFor(SEVEN_EIGHT);
    expect(hitsOf(row(14, [0, 4, 8]).map((v, i) => (isKickAnchor(sevenEight, i) ? v : 0)))).toEqual([0, 4, 8]);
    expect(anchorPositions(sevenEight, "kick")).toEqual([0, 4, 8]);
    expect(anchorPositions(sevenEight, "snare")).toEqual([8]);

    const fiveEight = aiMeterFor(FIVE_EIGHT);
    expect(anchorPositions(fiveEight, "kick")).toEqual([0, 6]);
    expect(anchorPositions(fiveEight, "snare")).toEqual([6]);
  });

  it("keeps the pulse and the backbeat where the metre says", () => {
    const sevenEight = aiMeterFor(SEVEN_EIGHT);
    const pulses: number[] = [];
    const backbeats: number[] = [];
    for (let step = 0; step < sevenEight.stepsPerBar; step++) {
      if (isPulse(sevenEight, step)) pulses.push(step);
      if (isBackbeatAnchor(sevenEight, step)) backbeats.push(step);
    }
    expect(pulses).toEqual([0, 4, 8]);
    expect(backbeats).toEqual([8]);
  });
});

describe("ADR 0057 Stage 2i — the content follows the grouping", () => {
  it("projects the 4/4 kick onto the 7/8 group downbeats, not onto the 4/4 fold", () => {
    const sevenEight = aiMeterFor(SEVEN_EIGHT);
    const source = row(16, [0, 4, 8, 12]);
    // The legacy fold kept 4/4's four beats (0, 4, 8, 12) in a 7/8 bar; the
    // grouping re-voices them onto the 2+2+3's downbeats (0, 4, 8).
    expect(hitsOf(projectRowToMeter(source, "kick", sevenEight))).toEqual([0, 4, 8]);
  });

  it("puts the snare on the accent group and keeps the eighths on the eighths", () => {
    const sevenEight = aiMeterFor(SEVEN_EIGHT);
    expect(hitsOf(projectRowToMeter(row(16, [4, 12]), "snare", sevenEight))).toEqual([8]);
    // A hat row is not a skeleton: the fold keeps it on the eighths.
    expect(hitsOf(projectRowToMeter(row(16, [0, 2, 4, 6, 8, 10, 12, 14]), "closedHat", sevenEight))).toEqual([
      0, 2, 4, 6, 8, 10, 12,
    ]);
  });

  it("does not let the syncopation budget strip the irregular groove", () => {
    const sevenEight = aiMeterFor(SEVEN_EIGHT);
    // The kick on the group downbeats: every hit is on the grid, so the budget
    // has nothing to remove. Before this stage the pulse was the whole bar,
    // the group downbeats weighed 1 and two of the three hits were stripped.
    const kick = row(14, [0, 4, 8]);
    enforceSyncopationBudget(kick, [row(14, [0, 4, 8])], "kick", sevenEight);
    expect(hitsOf(kick)).toEqual([0, 4, 8]);

    // The eighth grid is the eighth grid: those hits weigh 0.35, not 1.
    const hats = row(14, [0, 2, 4, 6, 8, 10, 12]);
    enforceSyncopationBudget(hats, [row(14, [0, 2, 4, 6, 8, 10, 12])], "closedHat", sevenEight);
    expect(hitsOf(hats)).toEqual([0, 2, 4, 6, 8, 10, 12]);
  });

  it("still strips what is genuinely off the grid", () => {
    const sevenEight = aiMeterFor(SEVEN_EIGHT);
    // The budget is not switched off for irregular metres: a hit that is
    // neither a group downbeat nor on the eighths is still syncopation.
    expect(syncopationWeight(0, sevenEight)).toBe(0);
    expect(syncopationWeight(2, sevenEight)).toBe(0.35);
    expect(syncopationWeight(1, sevenEight)).toBe(1);
  });
});

describe("ADR 0057 Stage 2i — the generated CONTENT", () => {
  it("makes a real 7/8 groove — the kick on the groups, the backbeat on the accent", () => {
    const sevenEight = aiMeterFor(SEVEN_EIGHT);
    const hits = generatedHits(SEVEN_EIGHT, "house", "measure", sevenEight.stepsPerBar * 2);

    // Both kick lanes ride every group downbeat of every bar: the 2+2+3's
    // "1", "3" and "5".
    const expectedKick = [0, 1].flatMap((bar) => [0, 4, 8].map((step) => bar * 14 + step));
    expect(hits.get("Kick Deep")).toEqual(expectedKick);
    expect(hits.get("Kick Punch")).toEqual(expectedKick);
    // The clap rides the accent group of every bar — the "5".
    expect(hits.get("Clap")).toEqual([8, 22]);
  });

  it("makes a real 5/8 groove — the kick on the groups, the backbeat on the accent", () => {
    const fiveEight = aiMeterFor(FIVE_EIGHT);
    const hits = generatedHits(FIVE_EIGHT, "house", "measure", fiveEight.stepsPerBar * 2);

    // The 3+2's "1" and "4".
    const expectedKick = [0, 1].flatMap((bar) => [0, 6].map((step) => bar * 10 + step));
    expect(hits.get("Kick Deep")).toEqual(expectedKick);
    expect(hits.get("Kick Punch")).toEqual(expectedKick);
    // The clap rides the accent — the "4".
    expect(hits.get("Clap")).toEqual([6, 16]);
  });

  it("keeps the 4/4 CONTENT — the same lanes at the same places", () => {
    const hits = generatedHits(FOUR_FOUR, "house", "measure", 32);
    expect(hits.get("Kick Deep")).toEqual([0, 4, 8, 12, 16, 20, 24, 28]);
    expect(hits.get("Kick Punch")).toEqual([4, 12, 20, 28]);
    expect(hits.get("Clap")).toEqual([4, 12, 20, 28]);
  });
});

describe("ADR 0057 Stage 2i — the fallback: a grouping the product does not know", () => {
  it("imposes NOTHING on an undeclared irregular metre", () => {
    const eleven = aiMeterFor(ELEVEN_EIGHT);
    expect(eleven.groups).toEqual([22]);
    expect(eleven.irregular).toBe(false);
    // The whole bar is the only group: the kick has one anchor and the snare
    // has none at all — exactly what an irregular metre had before this stage.
    expect(anchorPositions(eleven, "kick")).toEqual([0]);
    expect(anchorPositions(eleven, "snare")).toEqual([]);
  });

  it("keeps the projection's refusal for a bar with one group", () => {
    const eleven = aiMeterFor(ELEVEN_EIGHT);
    // The kick keeps the groove's own hits — the product does not invent a
    // grouping it does not know.
    expect(hitsOf(projectRowToMeter(row(16, [0, 4, 8, 12]), "kick", eleven))).toEqual([0, 4, 8, 12, 16, 20]);
  });

  it("leaves the undeclared irregular content exactly as it was", () => {
    // MEASURED before this stage (house, seed "measure", two bars): the kick
    // lanes carried the downbeat of every bar and NOTHING else — no clap, no
    // hats. The fallback must not move a step and must not gain a lane.
    const eleven = aiMeterFor(ELEVEN_EIGHT);
    const hits = generatedHits(ELEVEN_EIGHT, "house", "measure", eleven.stepsPerBar * 2);
    expect(hits.get("Kick Deep")).toEqual([0, 22]);
    expect(hits.get("Kick Punch")).toEqual([0, 22]);
    expect(hits.get("Clap")).toBeUndefined();
  });
});

describe("ADR 0057 Stage 2i — 4/4 and every regular metre stay byte-identical", () => {
  it("keeps the legacy pulse, backbeat and half-grid for every regular metre", () => {
    for (const [label, sig] of REGULAR) {
      const meter = aiMeterFor(sig);
      const legacyHalf = Math.max(1, Math.floor(meter.pulseSteps / 2));
      for (let step = 0; step < meter.stepsPerBar; step++) {
        const inBar = stepInBar(meter, step);
        // The control re-implements the LEGACY formula; the production code
        // must agree with it step by step.
        expect(isPulse(meter, step), `${label} pulse @${step}`).toBe(inBar % meter.pulseSteps === 0);
        expect(isHalfGroupStart(meter, step), `${label} half-grid @${step}`).toBe(inBar % legacyHalf === 0);
      }
    }
  });

  it("keeps the legacy anchors for every regular metre", () => {
    expect(anchorPositions(aiMeterFor(FOUR_FOUR), "kick")).toEqual([0, 4, 8, 12]);
    expect(anchorPositions(aiMeterFor(FOUR_FOUR), "snare")).toEqual([4, 12]);
    expect(anchorPositions(aiMeterFor(THREE_FOUR), "kick")).toEqual([0, 4, 8]);
    expect(anchorPositions(aiMeterFor(THREE_FOUR), "snare")).toEqual([4]);
    expect(anchorPositions(aiMeterFor(SIX_EIGHT), "kick")).toEqual([0, 6]);
    expect(anchorPositions(aiMeterFor(SIX_EIGHT), "snare")).toEqual([2, 8]);
    expect(anchorPositions(aiMeterFor(FIVE_FOUR), "kick")).toEqual([0, 4, 8, 12, 16]);
    expect(anchorPositions(aiMeterFor(FIVE_FOUR), "snare")).toEqual([4, 12]);
  });

  it("keeps the 4/4 CONTENT — the same rows the metre produced before this stage", () => {
    // The canonical 4/4 content hash is pinned in tests/adr0057-ai-meter.ts.
    // Here the check is the metrical one: the 4/4 row is the groove's own.
    const fourFour = aiMeterFor(FOUR_FOUR);
    const source = row(16, [0, 4, 8, 12]);
    expect(projectRowToMeter(source, "kick", fourFour)).toEqual(source);
    expect(isAnchorForRole(fourFour, "snare", 4)).toBe(true);
    expect(isAnchorForRole(fourFour, "snare", 12)).toBe(true);
    expect(isAnchorForRole(fourFour, "snare", 0)).toBe(false);
  });
});

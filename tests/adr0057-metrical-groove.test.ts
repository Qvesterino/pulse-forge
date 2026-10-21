/**
 * ADR 0057 Stage 2c — THE GROOVE MATERIAL speaks the document's METRE.
 *
 * Stage 2b made the AI layer speak the document's metre: the bar count, the
 * phrase cut, the fill, the kick, the snare. But the CONTENT it drew from was
 * still a 4/4 groove read at the metrical bar — so in a 6/8 document a UKG
 * clap that lives on the "and" of 3 and the "and" of 4 was simply gone, and a
 * rock backbeat on the "ands" of 1 and 3 landed on the wrong units.
 *
 * Stage 2c adds the METRICAL VIEW of the groove material: a derived
 * projection (`src/ai/groove-view.ts`), not a second library. The library
 * stays 4/4 and stays the source of truth.
 *
 * The properties this file locks down:
 *
 *   1. 4/4 is byte-identical — the same four canonical content hashes, and the
 *      metrical view is the IDENTITY for every groove in the library.
 *   2. The projection does what it says — the base folds, the anchors are
 *      re-voiced, the material is collected from the whole source row, and the
 *      things it refuses to do (invent material, impose a skeleton on an
 *      irregular bar) stay refused.
 *   3. The content follows the metre — 3/4 gets three beats, 6/8 gets the
 *      shuffle's "2 & 5", and the off-skeleton contamination drops to a
 *      measured few per cent.
 */
import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { normalizeProject } from "../src/project-model/schema";
import { normalizeIntent } from "../src/intent/normalize";
import { generateLocalResult } from "../src/intent/pipeline";
import { canonicalizePattern, contentHash } from "../src/ai/evaluation";
import { aiMeterFor, isAnchorForRole } from "../src/ai/meter";
import { inferPadRole } from "../src/ai/pad-roles";
import { enforceDrumAnchors } from "../src/ai/quality";
import { GROOVE_LIBRARY } from "../src/ai/grooves/index";
import {
  anchorPositions,
  metricalGroovePadRows,
  metricalGroovePatterns,
  projectRowToMeter,
} from "../src/ai/groove-view";
import type { ProjectDocument, TimeSignature } from "../src/project-model/types";

const FOUR_FOUR: TimeSignature = { numerator: 4, denominator: 4 };
const THREE_FOUR: TimeSignature = { numerator: 3, denominator: 4 };
const SIX_EIGHT: TimeSignature = { numerator: 6, denominator: 8 };
const SEVEN_EIGHT: TimeSignature = { numerator: 7, denominator: 8 };
const FIVE_FOUR: TimeSignature = { numerator: 5, denominator: 4 };

function docWithMeter(sig: TimeSignature): ProjectDocument {
  return normalizeProject({
    ...createProjectFromTemplate("house"),
    timeSignature: sig,
    bpm: 120,
    arrangement: { clips: [] },
  });
}

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

describe("ADR 0057 Stage 2c — the projection", () => {
  const threeFour = aiMeterFor(THREE_FOUR);
  const sixEight = aiMeterFor(SIX_EIGHT);

  it("is the IDENTITY in 4/4 — same positions, same values, same length", () => {
    const fourFour = aiMeterFor(FOUR_FOUR);
    const source = row(16, [0, 4, 8, 12]);
    expect(projectRowToMeter(source, "kick", fourFour)).toEqual(source);
    // A row that is NOT a whole bar keeps its own length in 4/4 — the
    // projection must not "fix" a fifteen-step row in the metre that never
    // asked for one.
    const fifteen = row(15, [0, 8]);
    expect(projectRowToMeter(fifteen, "kick", fourFour)).toEqual(fifteen);
    expect(projectRowToMeter(fifteen, "kick", fourFour)).toHaveLength(15);
  });

  it("folds the material into the target bar — truncated, never stretched", () => {
    const source = row(16, [0, 4, 8, 12]);
    const folded = projectRowToMeter(source, "closedHat", threeFour);
    expect(folded).toHaveLength(12);
    expect(hitsOf(folded)).toEqual([0, 4, 8]);
  });

  it("tiles the material when the target bar is LONGER than the source", () => {
    const source = row(16, [0, 8]);
    const fiveFour = aiMeterFor(FIVE_FOUR);
    const folded = projectRowToMeter(source, "closedHat", fiveFour);
    expect(folded).toHaveLength(20);
    expect(hitsOf(folded)).toEqual([0, 8, 16]);
  });

  it("re-voices the kick onto the metre's pulse", () => {
    // A 4/4 kick on 0, 4, 8, 12 in 6/8: the kick rides the dotted quarter.
    const source = row(16, [0, 4, 8, 12]);
    expect(hitsOf(projectRowToMeter(source, "kick", sixEight))).toEqual([0, 6]);
    // In 3/4 the kick rides the three beats.
    expect(hitsOf(projectRowToMeter(source, "kick", threeFour))).toEqual([0, 4, 8]);
  });

  it("re-voices the snare and the clap onto the backbeat", () => {
    // A 4/4 snare on 4 and 12 in 6/8 becomes the shuffle's "2 & 5".
    const source = row(16, [4, 12]);
    expect(hitsOf(projectRowToMeter(source, "snare", sixEight))).toEqual([2, 8]);
    expect(hitsOf(projectRowToMeter(source, "clap", sixEight))).toEqual([2, 8]);
    // In 3/4 a 3/4 bar has no beat 4 — the backbeat is beat 2 only.
    expect(hitsOf(projectRowToMeter(source, "snare", threeFour))).toEqual([4]);
  });

  it("collects the material from the WHOLE source row", () => {
    // A UKG clap on the "and" of 3 and the "and" of 4 lives PAST a 3/4 bar's
    // end. It is exactly the material the shorter metre needs.
    const source = row(16, [12, 14]);
    const projected = projectRowToMeter(source, "clap", threeFour);
    expect(hitsOf(projected)).toEqual([4]);
    expect(projected[4]).toBeCloseTo(source[12], 10);
  });

  it("repeats the material when the metre wants more anchors than the groove has", () => {
    // One clap in the groove, two backbeats in the shuffle.
    const source = row(16, [4]);
    const projected = projectRowToMeter(source, "clap", sixEight);
    expect(hitsOf(projected)).toEqual([2, 8]);
    expect(projected[2]).toBeCloseTo(projected[8], 10);
  });

  it("keeps a hat's folded positions — the groove's own swing survives", () => {
    const source = row(16, [1, 3, 5, 7, 9, 11, 13, 15]);
    expect(hitsOf(projectRowToMeter(source, "closedHat", threeFour))).toEqual([1, 3, 5, 7, 9, 11]);
  });

  it("invents nothing: a role with no material stays empty", () => {
    const source = row(16, []);
    expect(projectRowToMeter(source, "clap", sixEight)).toEqual(new Array(12).fill(0));
  });

  it("refuses to impose a skeleton on an irregular bar — the grouping is content", () => {
    const sevenEight = aiMeterFor(SEVEN_EIGHT);
    // 7/8 is ONE pulse: the kick keeps the groove's own hits, and the snare
    // has no backbeat to be re-voiced onto.
    const kick = row(16, [0, 4, 8, 12]);
    expect(hitsOf(projectRowToMeter(kick, "kick", sevenEight))).toEqual([0, 4, 8, 12]);
    const snare = row(16, [4, 12]);
    expect(hitsOf(projectRowToMeter(snare, "snare", sevenEight))).toEqual([4, 12]);
    expect(anchorPositions(sevenEight, "snare")).toEqual([]);
  });

  it("is level-agnostic — the same projection maps velocities and levels", () => {
    const levels = [0, 3, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const projected = projectRowToMeter(levels, "kick", sixEight);
    expect(hitsOf(projected)).toEqual([0, 6]);
    expect(projected[0]).toBe(3);
    expect(projected[6]).toBe(2);
  });

  it("an irregular bar still gets the metre's DOWNBEAT when the groove's kick misses it", () => {
    // The projection refuses to impose a skeleton on a 7/8 bar — the grouping
    // is content — so the metre's last word there is the WRITE path. This is
    // a real state, not a theory: 115 of the library's 802 kick rows have no
    // hit at step 0 (house.footwork kicks on 1/5/9/13).
    const sevenEight = aiMeterFor(SEVEN_EIGHT);
    const references = [row(14, [1, 5, 9, 13])];
    const target = new Array<number>(14).fill(0);
    enforceDrumAnchors(target, references, "kick", sevenEight);
    expect(hitsOf(target)).toContain(0);
  });

  it("a metre with more than one pulse needs no WRITE path — the view carries the anchors", () => {
    // The reference IS the metrical view, so every anchor already has a hit
    // and the repair path covers it. If the write path were still doing the
    // work here, the metrical view's velocities would not show up.
    const references = [projectRowToMeter(row(16, [12, 14]), "clap", threeFour)];
    const target = new Array<number>(12).fill(0);
    enforceDrumAnchors(target, references, "clap", threeFour);
    expect(hitsOf(target)).toEqual([4]);
    expect(target[4]).toBeCloseTo(0.85 * 0.8, 6);
  });
});

describe("ADR 0057 Stage 2c — the metrical view of a groove", () => {
  const sixEight = aiMeterFor(SIX_EIGHT);

  it("projects every pad's row, and 4/4 is the library itself", () => {
    const groove = GROOVE_LIBRARY[0];
    expect(metricalGroovePatterns(groove, ["kick"], aiMeterFor(FOUR_FOUR))).toBe(groove.patterns);

    const projected = metricalGroovePatterns(groove, ["kick"], sixEight);
    expect(projected).not.toBe(groove.patterns);
    for (const pattern of projected) {
      for (const padIndex of Object.keys(pattern)) {
        expect(pattern[Number(padIndex)]).toHaveLength(sixEight.stepsPerBar);
      }
    }
  });

  it("projects one pad's rows", () => {
    const groove = GROOVE_LIBRARY[0];
    const rows = metricalGroovePadRows(groove, 0, "kick", sixEight);
    expect(rows).toHaveLength(groove.patterns.length);
    for (const projected of rows) {
      expect(projected).toHaveLength(sixEight.stepsPerBar);
    }
  });
});

describe("ADR 0057 Stage 2c — the library-wide guards", () => {
  const METRES: TimeSignature[] = [FOUR_FOUR, THREE_FOUR, SIX_EIGHT, FIVE_FOUR, SEVEN_EIGHT];

  it("the metrical view is the IDENTITY for every groove in the library in 4/4", () => {
    const fourFour = aiMeterFor(FOUR_FOUR);
    for (const groove of GROOVE_LIBRARY) {
      for (const pattern of groove.patterns) {
        for (const key of Object.keys(pattern)) {
          const padIndex = Number(key);
          const source = pattern[padIndex];
          const role = inferPadRole(undefined, padIndex);
          const projected = projectRowToMeter(source, role, fourFour);
          expect(projected).toEqual(source);
          expect(projected).toHaveLength(source.length);
        }
      }
    }
  });

  it("the projection invents NO material — every hit comes from the source", () => {
    for (const sig of METRES) {
      const meter = aiMeterFor(sig);
      for (const groove of GROOVE_LIBRARY) {
        for (const pattern of groove.patterns) {
          for (const key of Object.keys(pattern)) {
            const padIndex = Number(key);
            const source = pattern[padIndex];
            const role = inferPadRole(undefined, padIndex);
            const projected = projectRowToMeter(source, role, meter);
            const available = new Set(source.filter((value) => value > 0));
            for (const value of projected) {
              if (value <= 0) continue;
              expect(available.has(value)).toBe(true);
            }
          }
        }
      }
    }
  });

  it("in a metre with more than one pulse, the kick sits EXACTLY on the pulse", () => {
    for (const sig of [THREE_FOUR, SIX_EIGHT, FIVE_FOUR]) {
      const meter = aiMeterFor(sig);
      const anchors = anchorPositions(meter, "kick");
      expect(anchors.length).toBeGreaterThan(1);
      for (const groove of GROOVE_LIBRARY) {
        for (const pattern of groove.patterns) {
          const source = pattern[0] ?? [];
          if (!source.some((value) => value > 0)) continue;
          const projected = projectRowToMeter(source, "kick", meter);
          expect(hitsOf(projected)).toEqual(anchors);
        }
      }
    }
  });

  it("the snare's backbeats are the metre's backbeats — the shuffle's 2 & 5", () => {
    const sixEight = aiMeterFor(SIX_EIGHT);
    expect(anchorPositions(sixEight, "snare")).toEqual([2, 8]);
    expect(anchorPositions(sixEight, "clap")).toEqual([2, 8]);
    const threeFour = aiMeterFor(THREE_FOUR);
    expect(anchorPositions(threeFour, "snare")).toEqual([4]);
  });
});

describe("ADR 0057 Stage 2c — 4/4 is byte-identical", () => {
  // The same four baselines the Stage 2b gate pins, re-measured against this
  // stage: the metrical view must not move a single cell of a 4/4 beat.
  const BASELINE: { genre: string; seed: string; hash: string }[] = [
    { genre: "house", seed: "baseline-house-1", hash: "17e1439d" },
    { genre: "trap", seed: "baseline-trap-1", hash: "688279c1" },
    { genre: "dnb", seed: "baseline-dnb-1", hash: "47f20c59" },
    { genre: "house", seed: "baseline-house-2", hash: "b4f0ae78" },
  ];

  function generateRows(sig: TimeSignature, genre: string, seed: string): { rows: string[]; hash: string } {
    const doc = docWithMeter(sig);
    const intent = normalizeIntent({ genre, seed }, doc);
    const result = generateLocalResult(doc, intent, "preview");
    const pattern = result.proposal?.pattern;
    if (!pattern) throw new Error(`no proposal for ${genre}/${seed}`);
    const rows = Object.values(pattern.rows ?? {}).map((row) =>
      row
        .map((value, step) => (value > 0 ? step : -1))
        .filter((step) => step >= 0)
        .join(","),
    );
    return { rows, hash: contentHash(canonicalizePattern(doc, pattern)) };
  }

  for (const entry of BASELINE) {
    it(`4/4 ${entry.genre}/${entry.seed} hashes to the pre-stage content`, () => {
      expect(generateRows(FOUR_FOUR, entry.genre, entry.seed).hash).toBe(entry.hash);
    });
  }
});

describe("ADR 0057 Stage 2c — the content follows the metre", () => {
  function generateRows(sig: TimeSignature, genre: string, seed: string): string[] {
    const doc = docWithMeter(sig);
    const intent = normalizeIntent({ genre, seed }, doc);
    const result = generateLocalResult(doc, intent, "preview");
    const pattern = result.proposal?.pattern;
    if (!pattern) throw new Error(`no proposal for ${genre}/${seed}`);
    return Object.values(pattern.rows ?? {}).map((row) =>
      row
        .map((value, step) => (value > 0 ? step : -1))
        .filter((step) => step >= 0)
        .join(","),
    );
  }

  it("3/4 puts the kick on the three beats and the snare on beat 2", () => {
    const rows = generateRows(THREE_FOUR, "house", "baseline-house-1");
    expect(rows[0]).toBe("0,4,8");
    expect(rows[1]).toBe("4");
  });

  it("6/8 puts the kick on the dotted quarters and the snare on the shuffle's 2 & 5", () => {
    const rows = generateRows(SIX_EIGHT, "house", "baseline-house-1");
    expect(rows[0]).toBe("0,6");
    expect(rows[1]).toBe("2,8");
  });

  it("the anchors of every metre sit where the metre puts them", () => {
    const cases: { sig: TimeSignature; kick: number[]; snare: number[] }[] = [
      { sig: THREE_FOUR, kick: [0, 4, 8], snare: [4] },
      { sig: SIX_EIGHT, kick: [0, 6], snare: [2, 8] },
      { sig: FIVE_FOUR, kick: [0, 4, 8, 12, 16], snare: [4, 12] },
    ];
    for (const entry of cases) {
      const meter = aiMeterFor(entry.sig);
      expect(anchorPositions(meter, "kick")).toEqual(entry.kick);
      expect(anchorPositions(meter, "snare")).toEqual(entry.snare);
      for (let step = 0; step < meter.stepsPerBar; step++) {
        if (entry.kick.includes(step)) expect(isAnchorForRole(meter, "kick", step)).toBe(true);
        if (entry.snare.includes(step)) expect(isAnchorForRole(meter, "snare", step)).toBe(true);
      }
    }
  });

  it("7/8 keeps the groove's own grouping — the projection does not invent one", () => {
    const sevenEight = aiMeterFor(SEVEN_EIGHT);
    expect(sevenEight.pulseSteps).toBe(sevenEight.stepsPerBar);
    expect(anchorPositions(sevenEight, "kick")).toEqual([0]);
    expect(anchorPositions(sevenEight, "snare")).toEqual([]);
  });
});

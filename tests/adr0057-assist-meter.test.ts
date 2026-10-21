import { describe, expect, it } from "vitest";
import {
  assistSourceAlignment,
  expandWithBuild,
  makeFill,
  replaceRows,
  thinStepSelection,
  varyPattern,
} from "../src/assist/patternOps";
import { buildAssistPatch, normalizeAssistRequest } from "../src/assist/pipeline";
import { aiMeterFor } from "../src/ai/meter";
import { assistBuild, assistVary } from "../src/commands/commands";
import { assistVarySelectionCommand } from "../src/commands/assistSelectionCommands";
import { createDefaultProject } from "../src/project-model/schema";
import { getActivePattern, getDrumTrack } from "../src/project-model/types";
import { isWholeBarPatternFor } from "../src/project-model/grid";
import type { Pattern, TimeSignature } from "../src/project-model/types";

/**
 * ADR 0057 Stage 2g — THE ASSIST LAYER COUNTS BARS IN THE DOCUMENT'S METRE.
 *
 * The assist ops used to believe that one bar is sixteen sixteenth steps: the
 * build expanded to `bars * 16`, the fill's zone was the last sixteen steps,
 * the style grooves were tiled every sixteen steps, and "the beat" was
 * `step % 4`. In a 6/8 document a four-bar build was 1.33 bars long.
 *
 * The contract this file pins:
 *
 * 1. 4/4 IS THE IDENTITY — the same op with an explicit 4/4 meter produces the
 *    same bytes as the op with no meter at all.
 * 2. THE METRE DECIDES THE BAR — the build's length is the document's bar
 *    length, and the length is a whole number of metrical bars.
 * 3. THE METRE DECIDES THE ANCHORS — the pulse and the backbeat are the
 *    positions the metre protects, not "every fourth step".
 * 4. THE METRE DECIDES THE STYLE — the 4/4 style grooves are re-voiced, not
 *    truncated at the bar line.
 */

const FOUR_FOUR: TimeSignature = { numerator: 4, denominator: 4 };
const SIX_EIGHT: TimeSignature = { numerator: 6, denominator: 8 };
const FIVE_FOUR: TimeSignature = { numerator: 5, denominator: 4 };

const hitsOf = (row: readonly number[] | undefined): number[] =>
  (row ?? []).map((value, step) => (value > 0 ? step : -1)).filter((step) => step >= 0);

interface Fixture {
  doc: ReturnType<typeof createDefaultProject>;
  pattern: Pattern;
  track: ReturnType<typeof getDrumTrack>;
  kick: { id: string };
  snare: { id: string };
  hat: { id: string };
}

function fixture(signature: TimeSignature | undefined, stepCount = 24): Fixture {
  const doc = createDefaultProject();
  const track = getDrumTrack(doc);
  const base = getActivePattern(doc);
  const kick = track.pads.find((pad) => /kick/i.test(pad.name))!;
  const snare = track.pads.find((pad) => /snare/i.test(pad.name))!;
  const hat = track.pads.find((pad) => /hat/i.test(pad.name))!;
  const rows = Object.fromEntries(
    Object.entries(base.rows).map(([padId, row]) => [
      padId,
      Array.from({ length: stepCount }, (_, step) => row[step] ?? 0),
    ]),
  );
  rows[kick.id] = Array.from({ length: stepCount }, (_, step) => (step % 4 === 0 ? 0.9 : 0));
  rows[snare.id] = Array.from({ length: stepCount }, (_, step) => (step % 8 === 4 ? 0.8 : 0));
  rows[hat.id] = Array.from({ length: stepCount }, (_, step) => (step % 2 === 0 ? 0.4 : 0));
  const pattern: Pattern = { ...base, stepCount, rows };
  return {
    doc: {
      ...doc,
      ...(signature ? { timeSignature: signature } : {}),
      patterns: doc.patterns.map((candidate) => (candidate.id === pattern.id ? pattern : candidate)),
    },
    pattern,
    track,
    kick,
    snare,
    hat,
  };
}

describe("ADR 0057 Stage 2g — the assist layer speaks the document's metre", () => {
  it("keeps 4/4 byte-identical: the explicit 4/4 meter equals no meter at all", () => {
    const { pattern, track } = fixture(FOUR_FOUR, 32);
    const fourFour = aiMeterFor(FOUR_FOUR);
    const scope = { padIds: [Object.keys(pattern.rows)[0]!], from: 0, to: 15 };

    expect(varyPattern(pattern, track.pads, "seed", 0.6, fourFour)).toEqual(
      varyPattern(pattern, track.pads, "seed", 0.6),
    );
    expect(expandWithBuild(pattern, track.pads, 4, "seed", fourFour)).toEqual(
      expandWithBuild(pattern, track.pads, 4, "seed"),
    );
    expect(replaceRows(pattern, track.pads, "hats", "house", "seed", fourFour)).toEqual(
      replaceRows(pattern, track.pads, "hats", "house", "seed"),
    );
    expect(makeFill(pattern, track.pads, "seed", fourFour)).toEqual(makeFill(pattern, track.pads, "seed"));
    expect(thinStepSelection(pattern, scope, 0.4, fourFour)).toEqual(thinStepSelection(pattern, scope, 0.4));
  });

  it("counts the document's bars: a four-bar build is four bars of the metre", () => {
    const sixEight = aiMeterFor(SIX_EIGHT);
    const fiveFour = aiMeterFor(FIVE_FOUR);

    const six = fixture(SIX_EIGHT, 24);
    const sixBuilt = expandWithBuild(six.pattern, six.track.pads, 4, "build", sixEight);
    expect(sixBuilt.stepCount).toBe(48); // four 6/8 bars of twelve steps
    expect(sixBuilt.stepCount).not.toBe(64); // the legacy sixteen-per-bar
    expect(isWholeBarPatternFor(SIX_EIGHT, sixBuilt.stepCount!)).toBe(true);
    expect(sixBuilt.phrasePlan?.map((bar) => bar.startStep)).toEqual([0, 12, 24, 36]);

    const five = fixture(FIVE_FOUR, 40);
    const fiveBuilt = expandWithBuild(five.pattern, five.track.pads, 4, "build", fiveFour);
    expect(fiveBuilt.stepCount).toBe(80); // four 5/4 bars of twenty steps
    expect(isWholeBarPatternFor(FIVE_FOUR, fiveBuilt.stepCount!)).toBe(true);
  });

  it("tiles the source bar in the metrical bar, not in sixteen steps", () => {
    const { pattern, track, kick } = fixture(SIX_EIGHT, 12);
    const built = expandWithBuild(pattern, track.pads, 4, "build", aiMeterFor(SIX_EIGHT));
    const row = built.rows[kick.id]!;
    const shape = (from: number) => row.slice(from, from + 12).map((value) => value > 0);
    // The source is ONE 6/8 bar, so it repeats every twelve steps.
    expect(shape(0)).toEqual(shape(12));
    expect(shape(12)).toEqual(shape(24));
    expect(shape(24)).toEqual(shape(36));
    expect(hitsOf(row)).toEqual([0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44]);
  });

  it("carries the document's metre through the command path", () => {
    const { doc, pattern } = fixture(SIX_EIGHT, 24);
    const next = assistBuild(doc, pattern.id, 4, "build-seed").execute(doc);
    expect(next.patterns.find((candidate) => candidate.id === pattern.id)?.stepCount).toBe(48);
  });

  it("re-voices the 4/4 style grooves into the document's metre", () => {
    const { pattern, track, kick, snare, hat } = fixture(SIX_EIGHT, 24);
    const sixEight = aiMeterFor(SIX_EIGHT);

    // "four-on-floor" is four quarter notes; in 6/8 the kick rides the dotted
    // quarter (0, 6) of every bar.
    const kickPatch = replaceRows(pattern, track.pads, "kicks", "four-on-floor", "style", sixEight);
    expect(hitsOf(kickPatch.rows[kick.id])).toEqual([0, 6, 12, 18]);

    // "backbeat" is on beats 2 and 4; in 6/8 that is the shuffle's "2 & 5".
    const snarePatch = replaceRows(pattern, track.pads, "snares", "backbeat", "style", sixEight);
    expect(hitsOf(snarePatch.rows[snare.id])).toEqual([2, 8, 14, 20]);

    // The hats are not the metre's skeleton: they keep their folded positions.
    const hatPatch = replaceRows(pattern, track.pads, "hats", "house", "style", sixEight);
    expect(hitsOf(hatPatch.rows[hat.id])).toEqual([2, 6, 10, 14, 18, 22]);
  });

  it("fills the LAST METRICAL BAR and ends the crescendo on the pattern's last step", () => {
    const { pattern, track, snare } = fixture(SIX_EIGHT, 24);
    const filled = makeFill(pattern, track.pads, "fill", aiMeterFor(SIX_EIGHT));
    const row = filled.rows[snare.id]!;
    // Before the zone the user's own backbeat is untouched.
    expect(row.slice(0, 12)).toEqual(pattern.rows[snare.id]!.slice(0, 12));
    // The zone is the second 6/8 bar, and the loudest hit is the last step.
    // (Step 4 is the user's own backbeat, before the zone — it stays.)
    const hits = hitsOf(row);
    expect(hits).toEqual([4, 12, 16, 18, 20, 21, 22, 23]);
    expect(row[23]).toBeGreaterThan(row[12]);
  });

  it("protects the metre's backbeat where the legacy rule would have thinned it", () => {
    const { pattern, hat } = fixture(SIX_EIGHT, 12);
    // The softest hit sits ON the 6/8 backbeat (step 2) — the legacy "every
    // fourth step" rule would have removed it first.
    const row = Array.from({ length: 12 }, (_, step) => (step === 2 ? 0.2 : step % 4 === 0 ? 0.9 : 0.4));
    const source: Pattern = { ...pattern, rows: { ...pattern.rows, [hat.id]: row } };
    const scope = { padIds: [hat.id], from: 0, to: 11 };

    const thinned = thinStepSelection(source, scope, 1, aiMeterFor(SIX_EIGHT));
    expect(thinned.rows[hat.id]?.[2]).toBe(0.2); // the backbeat survived
    expect(thinStepSelection(source, scope, 1).rows[hat.id]?.[2]).toBe(0); // the legacy removed it
  });

  it("protects the metre's backbeat in VARY where the legacy rule would have thinned it", () => {
    const { pattern, track, snare } = fixture(SIX_EIGHT, 12);
    const row = Array.from({ length: 12 }, (_, step) => (step === 2 || step === 8 ? 0.3 : step % 4 === 0 ? 0.9 : 0.5));
    const source: Pattern = { ...pattern, rows: { ...pattern.rows, [snare.id]: row } };

    // Find the seed where the legacy metre really does thin the backbeat away.
    let seed = "";
    for (let index = 0; index < 200 && !seed; index++) {
      const candidate = `vary-seed-${index}`;
      if (varyPattern(source, track.pads, candidate, 1).rows[snare.id]?.[2] === 0) seed = candidate;
    }
    expect(seed).not.toBe(""); // the defect was real

    const metrical = varyPattern(source, track.pads, seed, 1, aiMeterFor(SIX_EIGHT)).rows[snare.id];
    expect(metrical[2]).toBeGreaterThan(0);
    expect(metrical[8]).toBeGreaterThan(0);
  });

  it("scoped commands speak the document's metre too", () => {
    const { doc, pattern, track, snare } = fixture(SIX_EIGHT, 12);
    const row = Array.from({ length: 12 }, (_, step) => (step === 2 || step === 8 ? 0.3 : step % 4 === 0 ? 0.9 : 0.5));
    const source: Pattern = { ...pattern, rows: { ...pattern.rows, [snare.id]: row } };
    const doc2 = {
      ...doc,
      patterns: doc.patterns.map((candidate) => (candidate.id === pattern.id ? source : candidate)),
    };
    const command = assistVarySelectionCommand(
      doc2,
      source.id,
      track.id,
      { padIds: [snare.id], from: 0, to: 11 },
      "vary-seed-0",
      1,
    );
    const next = command.execute(doc2);
    const nextRow = next.patterns.find((candidate) => candidate.id === source.id)?.rows[snare.id];
    expect(nextRow?.[2]).toBeGreaterThan(0);
  });

  it("the request's metre reaches the ops, and a broken one is dropped", () => {
    const { pattern, track } = fixture(SIX_EIGHT, 24);
    const metrical = buildAssistPatch(pattern, track.pads, {
      operation: "build",
      bars: 4,
      timeSignature: SIX_EIGHT,
    });
    expect(metrical.stepCount).toBe(48);

    const broken = buildAssistPatch(pattern, track.pads, {
      operation: "build",
      bars: 4,
      timeSignature: { numerator: 0, denominator: 0 } as TimeSignature,
    });
    expect(broken.stepCount).toBe(64); // no usable metre → the 4/4 identity
  });

  it("normalizes the request's metre and keeps 4/4 out of the contract", () => {
    expect(normalizeAssistRequest({ operation: "vary" }).timeSignature).toBeUndefined();
    expect(
      normalizeAssistRequest({ operation: "vary", timeSignature: { numerator: 6, denominator: 8 } }).timeSignature,
    ).toEqual(SIX_EIGHT);
    expect(
      normalizeAssistRequest({
        operation: "vary",
        timeSignature: { numerator: 6.4, denominator: 8.6 } as TimeSignature,
      }).timeSignature,
    ).toEqual({ numerator: 6, denominator: 9 });
    expect(
      normalizeAssistRequest({
        operation: "vary",
        timeSignature: { numerator: -3, denominator: 8 } as TimeSignature,
      }).timeSignature,
    ).toBeUndefined();
  });

  it("the plain assist command in a 4/4 document is untouched by the metre plumbing", () => {
    const { doc, pattern } = fixture(FOUR_FOUR, 32);
    const next = assistVary(doc, pattern.id, "vary", 0.6).execute(doc);
    expect(next.patterns.find((candidate) => candidate.id === pattern.id)?.stepCount).toBe(32);
  });

  it("counts what a bar-by-bar copy leaves out, and says it", () => {
    const sixEight = aiMeterFor(SIX_EIGHT);
    // A source that fills whole metrical bars is copied exactly.
    const aligned = fixture(SIX_EIGHT, 24);
    expect(assistSourceAlignment(aligned.pattern, sixEight)).toEqual({ bars: 2, cutSteps: 0 });
    expect(assistSourceAlignment(aligned.pattern, sixEight).cutSteps).toBe(0);

    // A source that does NOT (sixteen steps in a 6/8 project is 1.33 bars)
    // loses its tail — and the build says how much.
    const unaligned = fixture(SIX_EIGHT, 16);
    expect(assistSourceAlignment(unaligned.pattern, sixEight)).toEqual({ bars: 1, cutSteps: 4 });
    const built = expandWithBuild(unaligned.pattern, unaligned.track.pads, 4, "build", sixEight);
    expect(built.sourceAlignment).toEqual({ bars: 1, cutSteps: 4 });
    const command = assistBuild(unaligned.doc, unaligned.pattern.id, 4, "build");
    expect(command.label).toBe("Build " + unaligned.pattern.name + " to 4 bars");
    expect(command.detail).toContain("4 steps cut at the bar line");
  });

  it("the fill's zone is the last metrical bar, not the last sixteen steps", () => {
    const { pattern, track } = fixture(SIX_EIGHT, 32);
    const filled = makeFill(pattern, track.pads, "fill", aiMeterFor(SIX_EIGHT));
    // Thirty-two steps in 6/8 is 2.67 bars; the zone is the last WHOLE bar
    // that fits — steps 20..31.
    expect(filled.clearStepMeta?.from).toBe(20);
    const legacyZone = makeFill(pattern, track.pads, "fill").clearStepMeta?.from;
    expect(legacyZone).toBe(16); // the legacy zone was the last sixteen steps
  });
});

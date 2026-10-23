/**
 * ADR 0057 Stage 2j — THE IRREGULAR GROOVE LIBRARY.
 *
 * Stage 2i made an irregular BAR speak: the grouping was declared (7/8 is
 * 2+2+3, 5/8 is 3+2), the kick rode the group downbeats and the backbeat sat
 * on the accent. But the MATERIAL it drew from was still a 4/4 groove: the
 * ghost notes, the hat rhythm and the percussion were a four-four groove's,
 * and no groove in the library was WRITTEN in an odd metre.
 *
 * Stage 2j gives the library an irregular half. A groove DECLARES its metre
 * (`GrooveData.timeSignature`), its rows are that metrical bar long, and it
 * only ever plays in its own metre — so a 4/4 document still hashes over
 * exactly the candidate set it always did.
 *
 * The properties this file locks down:
 *
 *   1. The MATERIAL exists: irregular grooves, in both odd metres, each one
 *      DECLARING its metre.
 *   2. The rows are the groove's OWN metrical bar — fourteen sixteenths for
 *      7/8, ten for 5/8.
 *   3. A groove written in the metre is ALREADY in the metre: the metrical
 *      view's projection is the IDENTITY for every row, so the view has
 *      nothing to re-voice.
 *   4. The STRUCTURE holds: the kick lanes carry exactly the group downbeats
 *      and the backbeat exactly the accent.
 *   5. A groove only plays its own metre — and the 4/4 candidate set is
 *      exactly the grooves that declare no metre, so 4/4 is untouched.
 *   6. The PRODUCT plays it: a 7/8 document really generates 7/8 material.
 *
 * The controls are INDEPENDENT where it matters: the grouping this spec uses
 * is re-declared here (GROUPINGS below), not imported from the production
 * module, so the spec cannot be satisfied by the code agreeing with itself.
 */
import { describe, expect, it } from "vitest";
import { createDefaultProject } from "../src/project-model/schema";
import { getDrumTrack } from "../src/project-model/types";
import { generatePattern, resolveGrooveSeeded } from "../src/ai/generator";
import { DEFAULT_GENERATE_OPTIONS } from "../src/ai/types";
import { GROOVE_LIBRARY, getGroovesForGenre, grooveBarSteps, preferGroovesForMeter } from "../src/ai/grooves/index";
import { IRREGULAR_GROOVES } from "../src/ai/grooves/irregular";
import { aiMeterFor, groupStarts } from "../src/ai/meter";
import { projectRowToMeter } from "../src/ai/groove-view";
import { inferPadRole } from "../src/ai/pad-roles";
import type { TimeSignature } from "../src/project-model/types";

const FOUR_FOUR: TimeSignature = { numerator: 4, denominator: 4 };
const SEVEN_EIGHT: TimeSignature = { numerator: 7, denominator: 8 };
const FIVE_EIGHT: TimeSignature = { numerator: 5, denominator: 8 };
const ELEVEN_EIGHT: TimeSignature = { numerator: 11, denominator: 8 };

/**
 * The declared grouping of the odd metres — RE-DECLARED here, independently of
 * the production module (ADR 0057 Stage 2i). The spec compares its own
 * grouping against the product's, so it cannot pass by the two agreeing on the
 * same wrong number.
 */
const GROUPINGS: Record<string, number[]> = {
  "7/8": [2, 2, 3],
  "5/8": [3, 2],
};

/** The group downbeats of a declared grouping, in steps. */
function declaredGroupStarts(sig: TimeSignature): number[] {
  const units = GROUPINGS[`${sig.numerator}/${sig.denominator}`];
  if (!units) throw new Error(`no declared grouping for ${sig.numerator}/${sig.denominator}`);
  const stepsPerUnit = 16 / sig.denominator;
  const starts: number[] = [];
  let at = 0;
  for (const unit of units) {
    starts.push(at);
    at += unit * stepsPerUnit;
  }
  return starts;
}

/** The accent group: the LAST group's downbeat (7/8's "5", 5/8's "4"). */
function declaredAccent(sig: TimeSignature): number {
  const starts = declaredGroupStarts(sig);
  return starts[starts.length - 1];
}

/** The standard kit's pad names — the roles the product reads. */
const KIT = [
  "Kick Deep",
  "Kick Punch",
  "Kick Techno",
  "Rim",
  "Snare",
  "Snare Tight",
  "Clap",
  "Shaker",
  "Hat Closed",
  "Hat Soft",
  "Hat Open",
  "Ride",
  "Tom Low",
  "Tom High",
  "Tick",
  "Blip",
];

function hitsOf(row: readonly number[]): number[] {
  const out: number[] = [];
  row.forEach((value, step) => {
    if (value > 0) out.push(step);
  });
  return out;
}

/** Every row of every groove, with its pattern index and its pad. */
function everyRow(groove: (typeof IRREGULAR_GROOVES)[number]): { pattern: number; pad: number; row: number[] }[] {
  const out: { pattern: number; pad: number; row: number[] }[] = [];
  groove.patterns.forEach((pattern, patternIndex) => {
    for (const [pad, row] of Object.entries(pattern)) {
      out.push({ pattern: patternIndex, pad: Number(pad), row });
    }
  });
  return out;
}

describe("ADR 0057 Stage 2j — the library HAS irregular material", () => {
  it("holds grooves in both odd metres", () => {
    expect(IRREGULAR_GROOVES.length).toBeGreaterThanOrEqual(2);
    const metres = new Set(
      IRREGULAR_GROOVES.map((g) => `${g.timeSignature?.numerator}/${g.timeSignature?.denominator}`),
    );
    expect(metres.has("7/8")).toBe(true);
    expect(metres.has("5/8")).toBe(true);
  });

  it("every irregular groove DECLARES a declared, odd metre", () => {
    for (const groove of IRREGULAR_GROOVES) {
      const sig = groove.timeSignature;
      expect(sig, `${groove.id} declares its metre`).toBeDefined();
      expect(GROUPINGS[`${sig!.numerator}/${sig!.denominator}`], `${groove.id} metre is declared`).toBeDefined();
      expect(groove.timeSignature?.numerator % 3, `${groove.id} is an irregular metre`).not.toBe(0);
    }
  });

  it("every irregular groove is REGISTERED in the library", () => {
    for (const groove of IRREGULAR_GROOVES) {
      expect(
        GROOVE_LIBRARY.some((g) => g.id === groove.id),
        `${groove.id} is in the library`,
      ).toBe(true);
    }
  });
});

describe("ADR 0057 Stage 2j — the rows are the groove's OWN metrical bar", () => {
  it("every row is exactly the declared bar long", () => {
    for (const groove of IRREGULAR_GROOVES) {
      const expected = (groove.timeSignature!.numerator * 16) / groove.timeSignature!.denominator;
      expect(grooveBarSteps(groove), `${groove.id} bar length`).toBe(expected);
      for (const { pad, row } of everyRow(groove)) {
        expect(row.length, `${groove.id} pad ${pad}`).toBe(expected);
      }
    }
  });

  it("the 4/4 library keeps its own sixteen steps — with the ONE legacy exception pinned", () => {
    // MEASURED on the live library: every 4/4 row is sixteen steps except ONE
    // — hybrid.ambienttechno's THIRD pattern, pad 9, which has always carried
    // fifteen. The metrical view deliberately does not "fix" it in the metre
    // that never asked (src/ai/groove-view.ts), so it is pinned here rather
    // than left to drift: a NEW short row fails this test.
    const LEGACY_SHORT_ROWS = [{ groove: "hybrid.ambienttechno", pattern: 2, pad: 9, length: 15 }];
    for (const groove of GROOVE_LIBRARY) {
      if (groove.timeSignature) continue;
      for (const { pattern, pad, row } of everyRow(groove as (typeof IRREGULAR_GROOVES)[number])) {
        const exception = LEGACY_SHORT_ROWS.find(
          (entry) => entry.groove === groove.id && entry.pattern === pattern && entry.pad === pad,
        );
        expect(row.length, `${groove.id} p${pattern} pad ${pad}`).toBe(exception?.length ?? 16);
      }
    }
  });
});

describe("ADR 0057 Stage 2j — a groove written in the metre needs NO re-voicing", () => {
  it("the metrical projection is the IDENTITY for every row", () => {
    for (const groove of IRREGULAR_GROOVES) {
      const meter = aiMeterFor(groove.timeSignature ?? null);
      for (const { pad, row } of everyRow(groove)) {
        const role = inferPadRole(KIT[pad], pad);
        const projected = projectRowToMeter(row, role, meter, meter);
        expect(projected, `${groove.id} pad ${pad} (${role})`).toEqual(row);
      }
    }
  });

  it("the production grouping agrees with the spec's own declaration", () => {
    for (const groove of IRREGULAR_GROOVES) {
      const sig = groove.timeSignature!;
      expect(groupStarts(aiMeterFor(sig)), `${groove.id} groups`).toEqual(declaredGroupStarts(sig));
    }
  });
});

describe("ADR 0057 Stage 2j — the structure of an irregular groove", () => {
  it("the kick lanes carry EXACTLY the group downbeats", () => {
    for (const groove of IRREGULAR_GROOVES) {
      const groups = declaredGroupStarts(groove.timeSignature!);
      for (const { pad, row } of everyRow(groove)) {
        const role = inferPadRole(KIT[pad], pad);
        if (role !== "kick") continue;
        expect(hitsOf(row), `${groove.id} pad ${pad} rides the groups`).toEqual(groups);
      }
    }
  });

  it("the backbeat sits EXACTLY on the accent — one hit", () => {
    for (const groove of IRREGULAR_GROOVES) {
      const accent = declaredAccent(groove.timeSignature!);
      for (const { pad, row } of everyRow(groove)) {
        const role = inferPadRole(KIT[pad], pad);
        if (role !== "clap" && role !== "snare") continue;
        expect(hitsOf(row), `${groove.id} pad ${pad} sits on the accent`).toEqual([accent]);
      }
    }
  });
});

describe("ADR 0057 Stage 2j — a groove only plays its own metre", () => {
  it("the 4/4 candidate set is EXACTLY the grooves that declare no metre", () => {
    for (const genre of ["house", "techno", "eurodance", "rock", "trap", "ambient"] as const) {
      const all = getGroovesForGenre(genre);
      const fourFour = preferGroovesForMeter(all, aiMeterFor(FOUR_FOUR));
      const expected = all.filter((g) => g.timeSignature === undefined);
      expect(
        fourFour.map((g) => g.id),
        `${genre} 4/4 set`,
      ).toEqual(expected.map((g) => g.id));
      // And it is not smaller than the library minus the irregular half.
      expect(fourFour.length).toBe(all.length - all.filter((g) => g.timeSignature !== undefined).length);
    }
  });

  it("a 7/8 document gets the 7/8 grooves and a 5/8 document the 5/8 ones", () => {
    const seven = preferGroovesForMeter(getGroovesForGenre("house"), aiMeterFor(SEVEN_EIGHT));
    expect(seven.map((g) => g.id)).toEqual(["house.seven8"]);
    const five = preferGroovesForMeter(getGroovesForGenre("house"), aiMeterFor(FIVE_EIGHT));
    expect(five.map((g) => g.id)).toEqual(["house.five8"]);
  });

  it("a metre the library does NOT have falls back to the 4/4 material", () => {
    const eleven = preferGroovesForMeter(getGroovesForGenre("house"), aiMeterFor(ELEVEN_EIGHT));
    const fourFour = preferGroovesForMeter(getGroovesForGenre("house"), aiMeterFor(FOUR_FOUR));
    expect(eleven.map((g) => g.id)).toEqual(fourFour.map((g) => g.id));
  });

  it("the resolver picks the groove that lives in the document's metre", () => {
    expect(resolveGrooveSeeded("house", undefined, "measure", null, null, aiMeterFor(SEVEN_EIGHT)).id).toBe(
      "house.seven8",
    );
    expect(resolveGrooveSeeded("house", undefined, "measure", null, null, aiMeterFor(FIVE_EIGHT)).id).toBe(
      "house.five8",
    );
    expect(resolveGrooveSeeded("house", undefined, "measure", null, null, aiMeterFor(FOUR_FOUR)).timeSignature).toBe(
      undefined,
    );
  });
});

describe("ADR 0057 Stage 2j — the PRODUCT plays it", () => {
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

  it("a 7/8 document generates 7/8 MATERIAL — the kick on the groups", () => {
    const groups = declaredGroupStarts(SEVEN_EIGHT);
    const bar = 14;
    for (const seed of ["measure", "kyx", "seven", "oddtime"]) {
      const hits = generatedHits(SEVEN_EIGHT, "house", seed, bar * 2);
      const expected = [0, 1].flatMap((index) => groups.map((step) => index * bar + step));
      expect(hits.get("Kick Deep"), `seed ${seed}`).toEqual(expected);
    }
  });

  it("a 5/8 document generates 5/8 MATERIAL — the kick on the groups", () => {
    const groups = declaredGroupStarts(FIVE_EIGHT);
    const bar = 10;
    for (const seed of ["measure", "kyx", "five", "oddtime"]) {
      const hits = generatedHits(FIVE_EIGHT, "house", seed, bar * 2);
      const expected = [0, 1].flatMap((index) => groups.map((step) => index * bar + step));
      expect(hits.get("Kick Deep"), `seed ${seed}`).toEqual(expected);
    }
  });

  it("a 4/4 document NEVER plays an irregular groove", () => {
    for (const genre of ["house", "techno", "eurodance", "rock"] as const) {
      for (let index = 0; index < 40; index++) {
        const groove = resolveGrooveSeeded(genre, undefined, `seed-${index}`, null, null, aiMeterFor(FOUR_FOUR));
        expect(groove.timeSignature, `${genre} seed-${index}`).toBeUndefined();
      }
    }
  });
});
